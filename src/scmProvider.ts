import * as vscode from 'vscode';
import * as path from 'path';
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

		// Create SCM provider
		this.scm = vscode.scm.createSourceControl('git-cl', 'Changelists', vscode.Uri.file(gitRoot));
		this.scm.inputBox.placeholder = 'Commit message';
		this.disposables.push(this.scm);

		this.setupWatchers();
		this.refresh();
	}

	private setupWatchers(): void {
		const gitDir = path.join(this.gitRoot, '.git');

		// Watch cl.json, cl-stashes.json, and git index
		const patterns = ['cl.json', 'cl-stashes.json', 'index'];
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
		for (const [name, files] of Object.entries(changelists)) {
			const group = this.changelistGroups.get(name);
			if (group) {
				group.resourceStates = files.map(filePath => {
					assignedFiles.add(filePath);
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
					unassigned.push(this.createResourceState(filePath, gitStatus));
				}
			}
			this.unassignedGroup.resourceStates = unassigned;
		}

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

		// Untracked files have no HEAD version — just open the file
		const command: vscode.Command = isUntracked
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

		return {
			resourceUri: uri,
			command,
			decorations: {
				strikeThrough: isDeleted,
				tooltip: `${filePath} [${status.trim() || 'clean'}]`
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
