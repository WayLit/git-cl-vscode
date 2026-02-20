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
 * changelist tree. Decorations update whenever the tree view refreshes.
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

function formatStashLabel(name: string, meta: StashMetadata): string {
	const date = new Date(meta.timestamp).toLocaleDateString();
	return `${name} (stashed from ${meta.source_branch}, ${date})`;
}

export type TreeNode =
	| { type: 'changelist'; name: string }
	| { type: 'changelistFile'; filePath: string; changelistName: string }
	| { type: 'unassignedSection' }
	| { type: 'unassignedFile'; filePath: string }
	| { type: 'stashedChangelist'; name: string; metadata: StashMetadata }
	| { type: 'stashedFile'; filePath: string; stashName: string };

/**
 * TreeDataProvider that surfaces changelists in a TreeView within the
 * Source Control sidebar.
 *
 * Tree structure: [active changelists] → Unassigned → [stashed changelists].
 */
export class ChangelistTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly changelistStore: ChangelistStore;
	private readonly stashStore: StashStore;
	private readonly decorationProvider: ChangelistDecorationProvider;
	private readonly disposables: vscode.Disposable[] = [];

	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	private lastWarnedMissingFiles = new Set<string>();

	// Cached data from last refresh
	private cachedChangelists: Record<string, string[]> = {};
	private cachedStashData: Record<string, StashMetadata> = {};
	private cachedGitStatus: GitStatusMap = new Map();
	private cachedUnassigned: string[] = [];

	constructor(private readonly gitRoot: string, private readonly outputChannel?: vscode.OutputChannel) {
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

		this.setupWatchers();
		this.refresh().catch(err => {
			const msg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Initial refresh error: ${msg}`);
		});
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
		this.refreshTimeout = setTimeout(() => {
			this.refresh().catch(err => {
				const msg = err instanceof Error ? err.message : String(err);
				this.outputChannel?.appendLine(`git-cl: Refresh error: ${msg}`);
			});
		}, 300);
	}

	async refresh(): Promise<void> {
		this.changelistStore.load();
		this.stashStore.load();

		let gitStatus: GitStatusMap;
		try {
			gitStatus = await getGitStatus(this.gitRoot);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Failed to read git status: ${errMsg}`);
			gitStatus = new Map();
		}

		this.cachedChangelists = this.changelistStore.getAll();
		this.cachedStashData = this.stashStore.getAll();
		this.cachedGitStatus = gitStatus;

		// Compute unassigned files
		const assignedFiles = new Set<string>();
		const allDisplayedFiles = new Set<string>();
		for (const files of Object.values(this.cachedChangelists)) {
			for (const f of files) {
				assignedFiles.add(f);
				allDisplayedFiles.add(f);
			}
		}

		const stashedFiles = this.stashStore.getStashedFiles();
		this.cachedUnassigned = [];
		for (const [filePath] of gitStatus) {
			if (!assignedFiles.has(filePath) && !stashedFiles.has(filePath)) {
				this.cachedUnassigned.push(filePath);
				allDisplayedFiles.add(filePath);
			}
		}

		// Update decoration provider with current status for all displayed files
		this.decorationProvider.update(gitStatus, allDisplayedFiles);

		// Check for files in changelists that no longer exist on disk
		const currentMissingFiles = new Set<string>();
		for (const files of Object.values(this.cachedChangelists)) {
			for (const filePath of files) {
				const status = gitStatus.get(filePath);
				const isGitDeleted = status !== undefined &&
					(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));
				if (!isGitDeleted && !fs.existsSync(path.join(this.gitRoot, filePath))) {
					currentMissingFiles.add(filePath);
				}
			}
		}

		// Warn about newly missing files (avoid repeating for already-warned files)
		const newlyMissing = [...currentMissingFiles].filter(f => !this.lastWarnedMissingFiles.has(f));
		if (newlyMissing.length > 0) {
			const fileList = newlyMissing.slice(0, 3).join(', ');
			const suffix = newlyMissing.length > 3 ? ` and ${newlyMissing.length - 3} more` : '';
			vscode.window.showWarningMessage(
				`git-cl: ${newlyMissing.length} file(s) in changelists no longer exist on disk: ${fileList}${suffix}`
			);
		}
		this.lastWarnedMissingFiles = currentMissingFiles;

		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		switch (element.type) {
			case 'changelist': {
				const files = this.cachedChangelists[element.name] ?? [];
				const item = new vscode.TreeItem(
					element.name,
					vscode.TreeItemCollapsibleState.Expanded
				);
				item.id = `cl:${element.name}`;
				item.contextValue = 'changelist';
				item.iconPath = new vscode.ThemeIcon('list-unordered');
				item.description = `${files.length} file(s)`;
				return item;
			}

			case 'changelistFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `cl:${element.changelistName}:${element.filePath}`;
				item.contextValue = 'changelistFile';
				item.command = this.createFileCommand(element.filePath, uri);
				item.resourceUri = uri;
				this.applyFileDecorations(item, element.filePath, uri);
				return item;
			}

			case 'unassignedSection': {
				const item = new vscode.TreeItem(
					'Unassigned',
					vscode.TreeItemCollapsibleState.Collapsed
				);
				item.id = 'unassigned';
				item.contextValue = 'unassignedSection';
				item.description = `${this.cachedUnassigned.length} file(s)`;
				return item;
			}

			case 'unassignedFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `unassigned:${element.filePath}`;
				item.contextValue = 'unassignedFile';
				item.command = this.createFileCommand(element.filePath, uri);
				item.resourceUri = uri;
				this.applyFileDecorations(item, element.filePath, uri);
				return item;
			}

			case 'stashedChangelist': {
				const item = new vscode.TreeItem(
					formatStashLabel(element.name, element.metadata),
					vscode.TreeItemCollapsibleState.Collapsed
				);
				item.id = `stash:${element.name}`;
				item.contextValue = 'stashedChangelist';
				item.iconPath = new vscode.ThemeIcon('archive');
				return item;
			}

			case 'stashedFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `stash:${element.stashName}:${element.filePath}`;
				item.contextValue = 'stashedFile';
				item.description = '(stashed)';
				item.resourceUri = uri;
				return item;
			}
		}
	}

	getChildren(element?: TreeNode): TreeNode[] {
		if (!element) {
			// Root level
			const nodes: TreeNode[] = [];

			// Active changelists
			for (const name of Object.keys(this.cachedChangelists)) {
				nodes.push({ type: 'changelist', name });
			}

			// Unassigned section (only if there are unassigned files)
			if (this.cachedUnassigned.length > 0) {
				nodes.push({ type: 'unassignedSection' });
			}

			// Stashed changelists
			for (const [name, metadata] of Object.entries(this.cachedStashData)) {
				nodes.push({ type: 'stashedChangelist', name, metadata });
			}

			return nodes;
		}

		switch (element.type) {
			case 'changelist': {
				const files = this.cachedChangelists[element.name] ?? [];
				return files.map(filePath => ({
					type: 'changelistFile' as const,
					filePath,
					changelistName: element.name,
				}));
			}

			case 'unassignedSection': {
				return this.cachedUnassigned.map(filePath => ({
					type: 'unassignedFile' as const,
					filePath,
				}));
			}

			case 'stashedChangelist': {
				return element.metadata.files.map(filePath => ({
					type: 'stashedFile' as const,
					filePath,
					stashName: element.name,
				}));
			}

			default:
				return [];
		}
	}

	private createFileCommand(filePath: string, uri: vscode.Uri): vscode.Command {
		const status = this.cachedGitStatus.get(filePath) ?? '  ';
		const isDeleted = status[1] === 'D' || (status[0] === 'D' && status[1] === ' ');
		const isUntracked = status === '??';
		const isMissing = !isDeleted && !fs.existsSync(uri.fsPath);

		if (isUntracked || isMissing) {
			return { title: 'Open File', command: 'vscode.open', arguments: [uri] };
		}

		return {
			title: 'Open Diff',
			command: 'vscode.diff',
			arguments: [
				vscode.Uri.from({ scheme: HEAD_SCHEME, path: `/${filePath}` }),
				uri,
				`${path.basename(filePath)} (Working Tree)`,
			],
		};
	}

	private applyFileDecorations(item: vscode.TreeItem, filePath: string, uri: vscode.Uri): void {
		const status = this.cachedGitStatus.get(filePath) ?? '  ';
		const isDeleted = status[1] === 'D' || (status[0] === 'D' && status[1] === ' ');
		const isMissing = !isDeleted && !fs.existsSync(uri.fsPath);

		if (isMissing) {
			item.tooltip = `${filePath} [missing from disk]`;
			item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
		} else {
			item.tooltip = `${filePath} [${status.trim() || 'clean'}]`;
		}
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

	dispose(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
