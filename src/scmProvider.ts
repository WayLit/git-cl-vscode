import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ChangelistStore } from './changelistStore';
import { StashStore, StashMetadata } from './stashStore';
import { getGitStatus, GitStatusMap } from './gitUtils';

const HEAD_SCHEME = 'git-cl-head';

/**
 * TextDocumentContentProvider that returns file content at HEAD.
 * Used for showing diff (HEAD vs working copy) when clicking files.
 */
class HeadContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly gitRoot: string) {}

	provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const relativePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
		return new Promise((resolve) => {
			execFile(
				'git',
				['show', `HEAD:${relativePath}`],
				{ cwd: this.gitRoot, maxBuffer: 10 * 1024 * 1024 },
				(error, stdout) => {
					if (error) {
						// File doesn't exist at HEAD (new/untracked file)
						resolve('');
						return;
					}
					resolve(stdout);
				}
			);
		});
	}
}

/**
 * Provides file decorations (status badge + color) for files shown in the
 * changelist SCM tree. Decorations update whenever the SCM view refreshes.
 */
class ChangelistDecorationProvider implements vscode.FileDecorationProvider {
	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	private gitStatus: GitStatusMap = new Map();
	private trackedUris = new Set<string>();
	private readonly gitRoot: string;

	constructor(gitRoot: string) {
		this.gitRoot = gitRoot;
	}

	update(gitStatus: GitStatusMap, filePaths: Set<string>): void {
		this.gitStatus = gitStatus;
		this.trackedUris.clear();
		for (const fp of filePaths) {
			this.trackedUris.add(vscode.Uri.file(path.join(this.gitRoot, fp)).toString());
		}
		this._onDidChangeFileDecorations.fire(undefined);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== 'file' || !this.trackedUris.has(uri.toString())) {
			return undefined;
		}

		const filePath = path.relative(this.gitRoot, uri.fsPath).split(path.sep).join('/');
		const status = this.gitStatus.get(filePath);
		const isGitDeleted = status !== undefined &&
			(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));

		// File is in a changelist but no longer on disk and not a git-tracked deletion
		if (!isGitDeleted && !fs.existsSync(uri.fsPath)) {
			return new vscode.FileDecoration(
				'!',
				'File no longer exists on disk',
				new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
			);
		}

		if (!status) {
			return undefined;
		}

		return statusToDecoration(status);
	}

	dispose(): void {
		this._onDidChangeFileDecorations.dispose();
	}
}

function statusToDecoration(status: string): vscode.FileDecoration | undefined {
	if (status === '??') {
		return new vscode.FileDecoration('U', 'Untracked', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
	}

	const index = status[0];
	const working = status[1];

	// Conflicts (UU, AA, DD, AU, UA, DU, UD)
	if (index === 'U' || working === 'U' ||
		(index === 'A' && working === 'A') ||
		(index === 'D' && working === 'D')) {
		return new vscode.FileDecoration('!', 'Conflict', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'));
	}

	// Deleted
	if (working === 'D' || index === 'D') {
		return new vscode.FileDecoration('D', 'Deleted', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
	}

	// Added
	if (index === 'A') {
		return new vscode.FileDecoration('A', 'Added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
	}

	// Renamed
	if (index === 'R') {
		return new vscode.FileDecoration('R', 'Renamed', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
	}

	// Copied
	if (index === 'C') {
		return new vscode.FileDecoration('C', 'Copied', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
	}

	// Modified
	if (working === 'M' || index === 'M') {
		return new vscode.FileDecoration('M', 'Modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
	}

	return undefined;
}

/**
 * SCM provider that surfaces changelists in the Source Control sidebar.
 *
 * Groups are ordered: [active changelists] → Unassigned → [stashed changelists].
 * The group set is rebuilt when changelists are added/removed; resource states
 * within groups are updated on every refresh.
 */
export class ChangelistSCMProvider implements vscode.Disposable {
	private readonly scm: vscode.SourceControl;
	private readonly changelistStore: ChangelistStore;
	private readonly stashStore: StashStore;
	private readonly decorationProvider: ChangelistDecorationProvider;
	private readonly disposables: vscode.Disposable[] = [];

	private changelistGroups = new Map<string, vscode.SourceControlResourceGroup>();
	private unassignedGroup: vscode.SourceControlResourceGroup | undefined;
	private stashedGroups = new Map<string, vscode.SourceControlResourceGroup>();

	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	private lastActiveKeys = '';
	private lastStashedKeys = '';

	constructor(private readonly gitRoot: string) {
		this.changelistStore = new ChangelistStore(gitRoot);
		this.stashStore = new StashStore(gitRoot);

		// Register HEAD content provider for diffs
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(
				HEAD_SCHEME,
				new HeadContentProvider(gitRoot)
			)
		);

		// Register file decoration provider for status badges and colors
		this.decorationProvider = new ChangelistDecorationProvider(gitRoot);
		this.disposables.push(
			vscode.window.registerFileDecorationProvider(this.decorationProvider),
			this.decorationProvider
		);

		// Create SCM provider
		this.scm = vscode.scm.createSourceControl('git-cl', 'Changelists', vscode.Uri.file(gitRoot));
		this.scm.inputBox.placeholder = 'Commit message';
		this.disposables.push(this.scm);

		this.setupWatchers();
		this.refresh();
	}

	private setupWatchers(): void {
		const gitDir = path.join(this.gitRoot, '.git');

		// Watch cl.json, cl-stashes.json, git index, and HEAD (for branch switches)
		const patterns = ['cl.json', 'cl-stashes.json', 'index', 'HEAD'];
		for (const file of patterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(gitDir), file)
			);
			watcher.onDidChange(() => this.debouncedRefresh());
			watcher.onDidCreate(() => this.debouncedRefresh());
			watcher.onDidDelete(() => this.debouncedRefresh());
			this.disposables.push(watcher);
		}

		// Refresh on file saves (git status may change)
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(() => this.debouncedRefresh())
		);
	}

	private debouncedRefresh(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => this.refresh(), 300);
	}

	async refresh(): Promise<void> {
		this.changelistStore.load();
		this.stashStore.load();

		let gitStatus: GitStatusMap;
		try {
			gitStatus = await getGitStatus(this.gitRoot);
		} catch {
			gitStatus = new Map();
		}

		const changelists = this.changelistStore.getAll();
		const stashData = this.stashStore.getAll();

		const activeNames = Object.keys(changelists);
		const stashedNames = Object.keys(stashData);
		const activeKey = activeNames.join('\0');
		const stashedKey = stashedNames.join('\0');

		// Rebuild all groups when the set of changelists changes (to preserve ordering)
		if (activeKey !== this.lastActiveKeys || stashedKey !== this.lastStashedKeys) {
			this.disposeAllGroups();

			// 1. Active changelist groups
			for (const name of activeNames) {
				const group = this.scm.createResourceGroup(`cl:${name}`, name);
				this.changelistGroups.set(name, group);
			}

			// 2. Unassigned group
			this.unassignedGroup = this.scm.createResourceGroup('unassigned', 'Unassigned');
			this.unassignedGroup.hideWhenEmpty = true;

			// 3. Stashed groups
			for (const name of stashedNames) {
				const meta = stashData[name];
				const group = this.scm.createResourceGroup(
					`stash:${name}`,
					formatStashLabel(name, meta)
				);
				this.stashedGroups.set(name, group);
			}

			this.lastActiveKeys = activeKey;
			this.lastStashedKeys = stashedKey;
		}

		// Update active changelist resource states
		const assignedFiles = new Set<string>();
		const allDisplayedFiles = new Set<string>();
		for (const [name, files] of Object.entries(changelists)) {
			const group = this.changelistGroups.get(name);
			if (group) {
				group.resourceStates = files.map(filePath => {
					assignedFiles.add(filePath);
					allDisplayedFiles.add(filePath);
					return this.createResourceState(filePath, gitStatus);
				});
			}
		}

		// Update unassigned group — git-tracked files not in any changelist
		if (this.unassignedGroup) {
			const stashedFiles = this.stashStore.getStashedFiles();
			const unassigned: vscode.SourceControlResourceState[] = [];
			for (const [filePath] of gitStatus) {
				if (!assignedFiles.has(filePath) && !stashedFiles.has(filePath)) {
					allDisplayedFiles.add(filePath);
					unassigned.push(this.createResourceState(filePath, gitStatus));
				}
			}
			this.unassignedGroup.resourceStates = unassigned;
		}

		// Update decoration provider with current status for all displayed files
		this.decorationProvider.update(gitStatus, allDisplayedFiles);

		// Update stashed group resource states and labels
		for (const [name, meta] of Object.entries(stashData)) {
			const group = this.stashedGroups.get(name);
			if (group) {
				group.label = formatStashLabel(name, meta);
				group.resourceStates = meta.files.map(filePath => ({
					resourceUri: vscode.Uri.file(path.join(this.gitRoot, filePath)),
					decorations: {
						tooltip: `${filePath} (stashed)`,
						faded: true
					}
				}));
			}
		}
	}

	private createResourceState(
		filePath: string,
		gitStatus: GitStatusMap
	): vscode.SourceControlResourceState {
		const uri = vscode.Uri.file(path.join(this.gitRoot, filePath));
		const status = gitStatus.get(filePath) ?? '  ';
		const isDeleted = status[1] === 'D' || (status[0] === 'D' && status[1] === ' ');
		const isUntracked = status === '??';
		const isMissing = !isDeleted && !fs.existsSync(uri.fsPath);

		// Untracked or missing files have no HEAD version — just open the file
		const command: vscode.Command = (isUntracked || isMissing)
			? { title: 'Open File', command: 'vscode.open', arguments: [uri] }
			: {
				title: 'Open Diff',
				command: 'vscode.diff',
				arguments: [
					vscode.Uri.from({ scheme: HEAD_SCHEME, path: `/${filePath}` }),
					uri,
					`${path.basename(filePath)} (Working Tree)`
				]
			};

		const tooltip = isMissing
			? `${filePath} [missing from disk]`
			: `${filePath} [${status.trim() || 'clean'}]`;

		return {
			resourceUri: uri,
			command,
			decorations: {
				strikeThrough: isDeleted || isMissing,
				tooltip,
				iconPath: isMissing
					? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
					: undefined
			}
		};
	}

	private disposeAllGroups(): void {
		for (const [, group] of this.changelistGroups) {
			group.dispose();
		}
		this.changelistGroups.clear();

		if (this.unassignedGroup) {
			this.unassignedGroup.dispose();
			this.unassignedGroup = undefined;
		}

		for (const [, group] of this.stashedGroups) {
			group.dispose();
		}
		this.stashedGroups.clear();
	}

	getChangelistStore(): ChangelistStore {
		return this.changelistStore;
	}

	getStashStore(): StashStore {
		return this.stashStore;
	}

	getGitRoot(): string {
		return this.gitRoot;
	}

	getSourceControl(): vscode.SourceControl {
		return this.scm;
	}

	dispose(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		this.disposeAllGroups();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

function formatStashLabel(name: string, meta: StashMetadata): string {
	const date = new Date(meta.timestamp).toLocaleDateString();
	return `${name} (stashed from ${meta.source_branch}, ${date})`;
}
