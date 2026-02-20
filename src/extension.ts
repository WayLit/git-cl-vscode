import * as vscode from 'vscode';
import * as path from 'path';
import { getGitRoot, getGitStatus, gitAdd, gitReset, gitCommit, gitCheckout, gitStashPush, gitStashDrop, gitStashPop, gitStashList, getCurrentBranch, gitCheckoutBranch, gitBranchExists, gitCheckoutExistingBranch } from './gitUtils';
import { ChangelistTreeDataProvider, TreeNode } from './changelistTreeProvider';
import { validateChangelistName } from './changelistStore';
import { FileCategories, StashMetadata } from './stashStore';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const outputChannel = vscode.window.createOutputChannel('git-cl');
	context.subscriptions.push(outputChannel);

	// Find git root from first workspace folder
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		outputChannel.appendLine('git-cl: No workspace folder found.');
		return;
	}

	let gitRoot: string;
	try {
		gitRoot = await getGitRoot(workspaceFolder.uri.fsPath);
	} catch {
		outputChannel.appendLine('git-cl: Not a git repository.');
		return;
	}

	// Initialize TreeView provider (changelists section in Source Control sidebar)
	vscode.commands.executeCommand('setContext', 'git-cl:hasGitRoot', true);
	const scmProvider = new ChangelistTreeDataProvider(gitRoot, outputChannel);
	const treeView = vscode.window.createTreeView('git-cl.changelists', {
		treeDataProvider: scmProvider,
		showCollapseAll: true,
		canSelectMany: true,
	});
	context.subscriptions.push(scmProvider, treeView);

	const statusCmd = vscode.commands.registerCommand('git-cl.showStatus', async () => {
		await showFormattedStatus(outputChannel, scmProvider, gitRoot);
	});

	const addToChangelistCmd = vscode.commands.registerCommand(
		'git-cl.addToChangelist',
		async (...args: unknown[]) => {
			const filePaths = await resolveFilePaths(gitRoot, args);
			if (!filePaths || filePaths.length === 0) {
				return;
			}

			const changelistName = await pickChangelist(scmProvider);
			if (!changelistName) {
				return;
			}

			try {
				const store = scmProvider.getChangelistStore();
				store.addFiles(changelistName, filePaths, scmProvider.getStashStore());
				store.save();
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: ${msg}`);
				return;
			}

			await scmProvider.refresh();
		}
	);

	const removeFromChangelistCmd = vscode.commands.registerCommand(
		'git-cl.removeFromChangelist',
		async (...args: unknown[]) => {
			const filePaths = await resolveFilePathsFromChangelists(gitRoot, scmProvider, args);
			if (!filePaths || filePaths.length === 0) {
				return;
			}

			try {
				const store = scmProvider.getChangelistStore();
				for (const filePath of filePaths) {
					const clName = store.findChangelist(filePath);
					if (clName) {
						store.removeFiles(clName, [filePath]);
					}
				}
				store.save();
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: ${msg}`);
				return;
			}

			await scmProvider.refresh();
		}
	);

	const openFileDiffCmd = vscode.commands.registerCommand(
		'git-cl.openFileDiff',
		async (...args: unknown[]) => {
			const filePath = resolveFilePathFromArg(gitRoot, args[0]);
			if (!filePath) {
				return;
			}

			let gitStatusMap: Map<string, string>;
			try {
				gitStatusMap = await getGitStatus(gitRoot);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: Failed to read git status: ${msg}`);
				return;
			}

			const status = gitStatusMap.get(filePath);
			const fileUri = vscode.Uri.file(path.join(gitRoot, filePath));
			const isUntracked = status === '??';
			const isDeleted = status !== undefined &&
				(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));

			if (isUntracked) {
				await vscode.commands.executeCommand('vscode.open', fileUri);
			} else if (isDeleted) {
				const headUri = vscode.Uri.from({
					scheme: 'git-cl-head',
					path: `/${filePath}`,
				});
				await vscode.commands.executeCommand('vscode.open', headUri);
			} else {
				const headUri = vscode.Uri.from({
					scheme: 'git-cl-head',
					path: `/${filePath}`,
				});
				await vscode.commands.executeCommand('vscode.diff',
					headUri,
					fileUri,
					`${path.basename(filePath)} (Working Tree)`
				);
			}
		}
	);

	const deleteChangelistCmd = vscode.commands.registerCommand(
		'git-cl.deleteChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);

			if (changelistName) {
				// Invoked from context menu — we have the changelist name
				await deleteChangelistWithConfirmation(scmProvider, changelistName);
			} else {
				// Command palette — prompt user to pick a changelist
				const name = await pickChangelistForDeletion(scmProvider);
				if (name) {
					await deleteChangelistWithConfirmation(scmProvider, name);
				}
			}
		}
	);

	const deleteAllChangelistsCmd = vscode.commands.registerCommand(
		'git-cl.deleteAllChangelists',
		async () => {
			const store = scmProvider.getChangelistStore();
			store.load();
			const names = store.getNames();

			if (names.length === 0) {
				vscode.window.showInformationMessage('git-cl: No changelists to delete.');
				return;
			}

			const totalFiles = names.reduce(
				(sum, name) => sum + store.getFiles(name).length, 0
			);

			const message = totalFiles > 0
				? `Delete all ${names.length} changelist(s)? ${totalFiles} file(s) will be moved to Unassigned.`
				: `Delete all ${names.length} empty changelist(s)?`;

			const answer = await vscode.window.showWarningMessage(
				message,
				{ modal: true },
				'Delete All'
			);

			if (answer !== 'Delete All') {
				return;
			}

			try {
				store.deleteAll();
				store.save();
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: ${msg}`);
				return;
			}

			await scmProvider.refresh();
		}
	);

	const stageChangelistCmd = vscode.commands.registerCommand(
		'git-cl.stageChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);
			const name = changelistName ?? await pickChangelistForAction(scmProvider, 'stage');
			if (!name) {
				return;
			}

			const store = scmProvider.getChangelistStore();
			store.load();
			const files = store.getFiles(name);
			if (files.length === 0) {
				vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
				return;
			}

			// Filter to tracked files only (skip untracked "??" files)
			let gitStatusMap: Map<string, string>;
			try {
				gitStatusMap = await getGitStatus(gitRoot);
			} catch {
				vscode.window.showErrorMessage('git-cl: Failed to read git status.');
				return;
			}

			const trackedFiles = files.filter(f => {
				const status = gitStatusMap.get(f);
				return status !== undefined && status !== '??';
			});

			if (trackedFiles.length === 0) {
				vscode.window.showInformationMessage(
					`git-cl: No tracked files to stage in changelist "${name}".`
				);
				return;
			}

			try {
				await gitAdd(trackedFiles, gitRoot);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: Failed to stage files: ${msg}`);
				return;
			}

			await scmProvider.refresh();
		}
	);

	const unstageChangelistCmd = vscode.commands.registerCommand(
		'git-cl.unstageChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);
			const name = changelistName ?? await pickChangelistForAction(scmProvider, 'unstage');
			if (!name) {
				return;
			}

			const store = scmProvider.getChangelistStore();
			store.load();
			const files = store.getFiles(name);
			if (files.length === 0) {
				vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
				return;
			}

			// Filter to files with staged changes only
			// In git status --porcelain, first char is index status; non-space/non-? means staged
			let gitStatusMap: Map<string, string>;
			try {
				gitStatusMap = await getGitStatus(gitRoot);
			} catch {
				vscode.window.showErrorMessage('git-cl: Failed to read git status.');
				return;
			}

			const stagedFiles = files.filter(f => {
				const status = gitStatusMap.get(f);
				if (!status) {
					return false;
				}
				const indexStatus = status[0];
				return indexStatus !== ' ' && indexStatus !== '?';
			});

			if (stagedFiles.length === 0) {
				vscode.window.showInformationMessage(
					`git-cl: No staged files to unstage in changelist "${name}".`
				);
				return;
			}

			try {
				await gitReset(stagedFiles, gitRoot);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: Failed to unstage files: ${msg}`);
				return;
			}

			await scmProvider.refresh();
		}
	);

	const commitChangelistCmd = vscode.commands.registerCommand(
		'git-cl.commitChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);
			const name = changelistName ?? await pickChangelistForAction(scmProvider, 'commit');
			if (!name) {
				return;
			}

			const store = scmProvider.getChangelistStore();
			store.load();
			const files = store.getFiles(name);
			if (files.length === 0) {
				vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
				return;
			}

			// Filter to tracked files only (skip untracked "??" files)
			let gitStatusMap: Map<string, string>;
			try {
				gitStatusMap = await getGitStatus(gitRoot);
			} catch {
				vscode.window.showErrorMessage('git-cl: Failed to read git status.');
				return;
			}

			const trackedFiles = files.filter(f => {
				const status = gitStatusMap.get(f);
				return status !== undefined && status !== '??';
			});

			if (trackedFiles.length === 0) {
				vscode.window.showErrorMessage(
					`git-cl: No tracked files to commit in changelist "${name}".`
				);
				return;
			}

			// Get commit message via input box
			const input = await vscode.window.showInputBox({
				prompt: `Commit message for changelist "${name}"`,
				placeHolder: 'Enter commit message',
				validateInput: value => {
					if (!value || value.trim().length === 0) {
						return 'Commit message cannot be empty';
					}
					return null;
				},
			});
			if (!input) {
				return;
			}
			const message = input.trim();

			try {
				await gitCommit(trackedFiles, message, gitRoot);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: Commit failed: ${msg}`);
				return;
			}

			// Delete the changelist after commit (default behavior)
			try {
				store.deleteChangelist(name);
				store.save();
			} catch (e: unknown) {
				const saveMsg = e instanceof Error ? e.message : String(e);
				vscode.window.showWarningMessage(`git-cl: Commit succeeded but failed to update changelist data: ${saveMsg}`);
			}

			await scmProvider.refresh();
			vscode.window.showInformationMessage(
				`git-cl: Committed ${trackedFiles.length} file(s) from "${name}".`
			);
		}
	);

	const diffChangelistCmd = vscode.commands.registerCommand(
		'git-cl.diffChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);
			const name = changelistName ?? await pickChangelistForAction(scmProvider, 'diff');
			if (!name) {
				return;
			}

			const store = scmProvider.getChangelistStore();
			store.load();
			const files = store.getFiles(name);
			if (files.length === 0) {
				vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
				return;
			}

			// Get git status to determine how to diff each file
			let gitStatusMap: Map<string, string>;
			try {
				gitStatusMap = await getGitStatus(gitRoot);
			} catch {
				vscode.window.showErrorMessage('git-cl: Failed to read git status.');
				return;
			}

			// Open diff tabs for each file
			let opened = 0;
			for (const filePath of files) {
				const status = gitStatusMap.get(filePath);
				const fileUri = vscode.Uri.file(path.join(gitRoot, filePath));
				const isUntracked = status === '??';
				const isDeleted = status !== undefined &&
					(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));

				if (isUntracked) {
					// Untracked files have no HEAD version — just open the file
					await vscode.commands.executeCommand('vscode.open', fileUri, {
						preview: false,
					});
				} else if (isDeleted) {
					// Deleted files — show HEAD version (read-only)
					const headUri = vscode.Uri.from({
						scheme: 'git-cl-head',
						path: `/${filePath}`,
					});
					await vscode.commands.executeCommand('vscode.open', headUri, {
						preview: false,
					});
				} else if (status) {
					// Modified/staged files — show diff (HEAD vs working copy)
					const headUri = vscode.Uri.from({
						scheme: 'git-cl-head',
						path: `/${filePath}`,
					});
					await vscode.commands.executeCommand('vscode.diff',
						headUri,
						fileUri,
						`${path.basename(filePath)} (Working Tree)`,
						{ preview: false }
					);
				}
				// Skip files with no git status (clean files)

				opened++;
			}

			if (opened === 0) {
				vscode.window.showInformationMessage(
					`git-cl: No changed files to diff in changelist "${name}".`
				);
			}
		}
	);

	const checkoutChangelistCmd = vscode.commands.registerCommand(
		'git-cl.checkoutChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);
			const name = changelistName ?? await pickChangelistForAction(scmProvider, 'revert');
			if (!name) {
				return;
			}

			const store = scmProvider.getChangelistStore();
			store.load();
			const files = store.getFiles(name);
			if (files.length === 0) {
				vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
				return;
			}

			// Confirmation dialog — warns about data loss
			const answer = await vscode.window.showWarningMessage(
				`Revert ${files.length} file(s) in changelist "${name}" to HEAD? This will discard all uncommitted changes and cannot be undone.`,
				{ modal: true },
				'Revert',
				'Revert & Delete Changelist'
			);

			if (!answer) {
				return;
			}

			try {
				await gitCheckout([...files], gitRoot);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: Revert failed: ${msg}`);
				return;
			}

			// Delete the changelist if requested
			if (answer === 'Revert & Delete Changelist') {
				try {
					store.deleteChangelist(name);
					store.save();
				} catch (e: unknown) {
					const saveMsg = e instanceof Error ? e.message : String(e);
					vscode.window.showWarningMessage(`git-cl: Revert succeeded but failed to update changelist data: ${saveMsg}`);
				}
			}

			await scmProvider.refresh();
			vscode.window.showInformationMessage(
				`git-cl: Reverted ${files.length} file(s) in "${name}" to HEAD.`
			);
		}
	);

	const stashChangelistCmd = vscode.commands.registerCommand(
		'git-cl.stashChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);
			const name = changelistName ?? await pickChangelistForAction(scmProvider, 'stash');
			if (!name) {
				return;
			}

			const success = await stashSingleChangelist(scmProvider, name, gitRoot);
			if (success) {
				await scmProvider.refresh();
				vscode.window.showInformationMessage(
					`git-cl: Stashed changelist "${name}".`
				);
			}
		}
	);

	const stashAllChangelistsCmd = vscode.commands.registerCommand(
		'git-cl.stashAllChangelists',
		async () => {
			const store = scmProvider.getChangelistStore();
			store.load();
			const names = [...store.getNames()];

			if (names.length === 0) {
				vscode.window.showInformationMessage('git-cl: No changelists to stash.');
				return;
			}

			let stashedCount = 0;
			for (const name of names) {
				const success = await stashSingleChangelist(scmProvider, name, gitRoot);
				if (success) {
					stashedCount++;
				}
			}

			await scmProvider.refresh();
			if (stashedCount > 0) {
				vscode.window.showInformationMessage(
					`git-cl: Stashed ${stashedCount} changelist(s).`
				);
			}
		}
	);

	const unstashChangelistCmd = vscode.commands.registerCommand(
		'git-cl.unstashChangelist',
		async (...args: unknown[]) => {
			const stashName = resolveStashName(args);
			const name = stashName ?? await pickStashedChangelistForAction(scmProvider, 'unstash');
			if (!name) {
				return;
			}

			const success = await unstashSingleChangelist(scmProvider, name, gitRoot, false);
			if (success) {
				await scmProvider.refresh();
				vscode.window.showInformationMessage(
					`git-cl: Unstashed changelist "${name}".`
				);
			}
		}
	);

	const unstashForceChangelistCmd = vscode.commands.registerCommand(
		'git-cl.unstashChangelistForce',
		async (...args: unknown[]) => {
			const stashName = resolveStashName(args);
			const name = stashName ?? await pickStashedChangelistForAction(scmProvider, 'force unstash');
			if (!name) {
				return;
			}

			const success = await unstashSingleChangelist(scmProvider, name, gitRoot, true);
			if (success) {
				await scmProvider.refresh();
				vscode.window.showInformationMessage(
					`git-cl: Unstashed changelist "${name}".`
				);
			}
		}
	);

	const unstashAllChangelistsCmd = vscode.commands.registerCommand(
		'git-cl.unstashAllChangelists',
		async () => {
			const stashStore = scmProvider.getStashStore();
			stashStore.load();
			const names = [...stashStore.getNames()];

			if (names.length === 0) {
				vscode.window.showInformationMessage('git-cl: No stashed changelists to unstash.');
				return;
			}

			let unstashedCount = 0;
			for (const name of names) {
				const success = await unstashSingleChangelist(scmProvider, name, gitRoot, false);
				if (success) {
					unstashedCount++;
				}
			}

			await scmProvider.refresh();
			if (unstashedCount > 0) {
				vscode.window.showInformationMessage(
					`git-cl: Unstashed ${unstashedCount} changelist(s).`
				);
			}
		}
	);

	const branchFromChangelistCmd = vscode.commands.registerCommand(
		'git-cl.branchFromChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);
			const name = changelistName ?? await pickChangelistForAction(scmProvider, 'branch from');
			if (!name) {
				return;
			}

			const store = scmProvider.getChangelistStore();
			store.load();
			const files = store.getFiles(name);
			if (files.length === 0) {
				vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
				return;
			}

			// Prompt for branch name (defaults to changelist name)
			const branchName = await vscode.window.showInputBox({
				prompt: 'Enter branch name',
				value: name,
				placeHolder: 'feature/my-branch',
				validateInput: async (value) => {
					if (!value || value.trim().length === 0) {
						return 'Branch name cannot be empty';
					}
					// Basic branch name validation
					if (/[\s~^:?*\[\\]/.test(value)) {
						return 'Branch name contains invalid characters';
					}
					return null;
				},
			});
			if (!branchName) {
				return;
			}

			// Check if branch already exists
			const exists = await gitBranchExists(branchName, gitRoot);
			if (exists) {
				vscode.window.showErrorMessage(`git-cl: Branch "${branchName}" already exists.`);
				return;
			}

			// Get current branch for base branch prompt and rollback
			let currentBranch: string | null;
			try {
				currentBranch = await getCurrentBranch(gitRoot);
			} catch {
				vscode.window.showErrorMessage('git-cl: Failed to determine current branch.');
				return;
			}

			const currentBranchLabel = currentBranch ?? 'HEAD';

			// Optionally prompt for base branch (defaults to current branch)
			const baseBranch = await vscode.window.showInputBox({
				prompt: `Base branch (leave empty for current: ${currentBranchLabel})`,
				placeHolder: currentBranchLabel,
			});
			// undefined = cancelled, empty string = use default
			if (baseBranch === undefined) {
				return;
			}
			const resolvedBase = baseBranch.trim() || undefined;

			// Validate: no unassigned uncommitted changes
			let gitStatusMap: Map<string, string>;
			try {
				gitStatusMap = await getGitStatus(gitRoot);
			} catch {
				vscode.window.showErrorMessage('git-cl: Failed to read git status.');
				return;
			}

			const stashStore = scmProvider.getStashStore();
			stashStore.load();
			const stashedFiles = stashStore.getStashedFiles();

			// Collect all files assigned to active changelists
			const assignedFiles = new Set<string>();
			const allChangelists = store.getAll();
			for (const clFiles of Object.values(allChangelists)) {
				for (const f of clFiles) {
					assignedFiles.add(f);
				}
			}

			// Check for unassigned uncommitted changes
			const unassigned: string[] = [];
			for (const [filePath] of gitStatusMap) {
				if (!assignedFiles.has(filePath) && !stashedFiles.has(filePath)) {
					unassigned.push(filePath);
				}
			}

			if (unassigned.length > 0) {
				const answer = await vscode.window.showWarningMessage(
					`There are ${unassigned.length} unassigned uncommitted file(s) that would be lost during branch creation. Please assign them to a changelist first, or commit/stash them.\n\nFiles: ${unassigned.slice(0, 5).join(', ')}${unassigned.length > 5 ? '...' : ''}`,
					{ modal: true },
					'Cancel'
				);
				// Only option is cancel (or dismiss)
				return;
			}

			// Stash all active changelists
			const activeNames = [...store.getNames()];
			const stashedByUs: string[] = [];

			for (const clName of activeNames) {
				const clFiles = store.getFiles(clName);
				if (clFiles.length === 0) {
					continue;
				}
				const success = await stashSingleChangelist(scmProvider, clName, gitRoot);
				if (!success) {
					// Rollback: unstash everything we already stashed
					for (const stashedName of stashedByUs.reverse()) {
						await unstashSingleChangelist(scmProvider, stashedName, gitRoot, true);
					}
					vscode.window.showErrorMessage(`git-cl: Failed to stash changelist "${clName}". Branch creation aborted.`);
					await scmProvider.refresh();
					return;
				}
				stashedByUs.push(clName);
			}

			// Create and switch to the new branch
			try {
				await gitCheckoutBranch(branchName, gitRoot, resolvedBase);
			} catch (e: unknown) {
				// Rollback: unstash all changelists and stay on original branch
				for (const stashedName of stashedByUs.reverse()) {
					await unstashSingleChangelist(scmProvider, stashedName, gitRoot, true);
				}
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: Failed to create branch "${branchName}": ${msg}`);
				await scmProvider.refresh();
				return;
			}

			// Unstash the target changelist only
			const unstashSuccess = await unstashSingleChangelist(scmProvider, name, gitRoot, true);
			if (!unstashSuccess) {
				// Rollback: switch back to original branch, unstash everything
				try {
					if (currentBranch) {
						await gitCheckoutExistingBranch(currentBranch, gitRoot);
					}
				} catch { /* best effort */ }
				for (const stashedName of stashedByUs.reverse()) {
					await unstashSingleChangelist(scmProvider, stashedName, gitRoot, true);
				}
				vscode.window.showErrorMessage(`git-cl: Failed to unstash changelist "${name}" on new branch. Rolled back to original branch.`);
				await scmProvider.refresh();
				return;
			}

			await scmProvider.refresh();
			vscode.window.showInformationMessage(
				`git-cl: Created branch "${branchName}" with changelist "${name}".`
			);
		}
	);

	context.subscriptions.push(statusCmd, addToChangelistCmd, removeFromChangelistCmd, openFileDiffCmd, deleteChangelistCmd, deleteAllChangelistsCmd, stageChangelistCmd, unstageChangelistCmd, commitChangelistCmd, diffChangelistCmd, checkoutChangelistCmd, stashChangelistCmd, stashAllChangelistsCmd, unstashChangelistCmd, unstashForceChangelistCmd, unstashAllChangelistsCmd, branchFromChangelistCmd);
	outputChannel.appendLine('git-cl extension activated.');
}

/**
 * Resolve a single file path from a command argument.
 * Handles both TreeNode (from our tree view) and SourceControlResourceState
 * (from built-in Git context menu).
 */
function resolveFilePathFromArg(
	gitRoot: string,
	arg: unknown
): string | undefined {
	if (!arg || typeof arg !== 'object') {
		return undefined;
	}

	// TreeNode from our tree view
	if ('type' in (arg as Record<string, unknown>)) {
		const node = arg as TreeNode;
		if (node.type === 'changelistFile' || node.type === 'unassignedFile') {
			return node.filePath;
		}
		return undefined;
	}

	// SourceControlResourceState from built-in Git
	if ('resourceUri' in (arg as Record<string, unknown>)) {
		const resource = arg as vscode.SourceControlResourceState;
		return path.relative(gitRoot, resource.resourceUri.fsPath)
			.split(path.sep).join('/');
	}

	return undefined;
}

/**
 * Resolve file paths from command arguments (context menu) or prompt the user
 * to select files from git status (command palette).
 * Handles both TreeNode args (from our tree view) and SourceControlResourceState
 * args (from built-in Git's context menu).
 */
async function resolveFilePaths(
	gitRoot: string,
	args: unknown[]
): Promise<string[] | undefined> {
	// Context menu with multi-select: second arg is the array of selected items
	if (args.length >= 2 && Array.isArray(args[1])) {
		const items = args[1] as unknown[];
		const paths = items
			.map(item => resolveFilePathFromArg(gitRoot, item))
			.filter((p): p is string => p !== undefined);
		if (paths.length > 0) {
			return paths;
		}
	}

	// Context menu single-select: first arg is the clicked item
	if (args.length >= 1 && args[0]) {
		const filePath = resolveFilePathFromArg(gitRoot, args[0]);
		if (filePath) {
			return [filePath];
		}
	}

	// Command palette — show file picker from git status
	let gitStatus: Map<string, string>;
	try {
		gitStatus = await getGitStatus(gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return undefined;
	}

	if (gitStatus.size === 0) {
		vscode.window.showInformationMessage('git-cl: No changed files to add.');
		return undefined;
	}

	const items: vscode.QuickPickItem[] = [];
	for (const [filePath, status] of gitStatus) {
		items.push({
			label: filePath,
			description: status.trim(),
		});
	}

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: 'Select files to add to a changelist',
	});

	if (!picked || picked.length === 0) {
		return undefined;
	}

	return picked.map(item => item.label);
}

/**
 * Resolve file paths for removal: from context menu args or prompt the user
 * to pick files from existing changelists (command palette).
 */
async function resolveFilePathsFromChangelists(
	gitRoot: string,
	scmProvider: ChangelistTreeDataProvider,
	args: unknown[]
): Promise<string[] | undefined> {
	// Context menu with multi-select: second arg is the array of selected items
	if (args.length >= 2 && Array.isArray(args[1])) {
		const items = args[1] as unknown[];
		const paths = items
			.map(item => resolveFilePathFromArg(gitRoot, item))
			.filter((p): p is string => p !== undefined);
		if (paths.length > 0) {
			return paths;
		}
	}

	// Context menu single-select: first arg is the clicked item
	if (args.length >= 1 && args[0]) {
		const filePath = resolveFilePathFromArg(gitRoot, args[0]);
		if (filePath) {
			return [filePath];
		}
	}

	// Command palette — show file picker from all changelists
	const store = scmProvider.getChangelistStore();
	store.load();
	const changelists = store.getAll();

	const items: vscode.QuickPickItem[] = [];
	for (const [name, files] of Object.entries(changelists)) {
		for (const filePath of files) {
			items.push({
				label: filePath,
				description: name,
			});
		}
	}

	if (items.length === 0) {
		vscode.window.showInformationMessage('git-cl: No files in any changelist to remove.');
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: 'Select files to remove from their changelist',
	});

	if (!picked || picked.length === 0) {
		return undefined;
	}

	return picked.map(item => item.label);
}

/**
 * Show a QuickPick to select an existing changelist or create a new one.
 */
async function pickChangelist(
	scmProvider: ChangelistTreeDataProvider
): Promise<string | undefined> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const existingNames = store.getNames();

	const createNewLabel = '$(plus) Create New Changelist';
	const items: vscode.QuickPickItem[] = [
		{ label: createNewLabel, description: 'Enter a new changelist name' },
		...existingNames.map(name => ({
			label: name,
			description: `${store.getFiles(name).length} file(s)`,
		})),
	];

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select or create a changelist',
	});

	if (!picked) {
		return undefined;
	}

	if (picked.label === createNewLabel) {
		const name = await vscode.window.showInputBox({
			prompt: 'Enter changelist name',
			placeHolder: 'my-feature',
			validateInput: value => validateChangelistName(value),
		});
		return name ?? undefined;
	}

	return picked.label;
}

/**
 * Resolve changelist name from context menu args (tree node click).
 * Returns the name or undefined if not invoked from a changelist node.
 */
function resolveChangelistName(
	args: unknown[]
): string | undefined {
	if (args.length < 1 || !args[0]) {
		return undefined;
	}

	const node = args[0] as TreeNode;
	if (typeof node === 'object' && node !== null && 'type' in node && node.type === 'changelist') {
		return node.name;
	}

	return undefined;
}

/**
 * Show QuickPick to select a changelist for deletion (command palette flow).
 */
async function pickChangelistForDeletion(
	scmProvider: ChangelistTreeDataProvider
): Promise<string | undefined> {
	return pickChangelistForAction(scmProvider, 'delete');
}

/**
 * Show QuickPick to select a changelist for a given action (command palette flow).
 */
async function pickChangelistForAction(
	scmProvider: ChangelistTreeDataProvider,
	action: string
): Promise<string | undefined> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const names = store.getNames();

	if (names.length === 0) {
		vscode.window.showInformationMessage(`git-cl: No changelists to ${action}.`);
		return undefined;
	}

	const items: vscode.QuickPickItem[] = names.map(name => ({
		label: name,
		description: `${store.getFiles(name).length} file(s)`,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Select a changelist to ${action}`,
	});

	return picked?.label;
}

/**
 * Delete a changelist after confirming with the user.
 */
async function deleteChangelistWithConfirmation(
	scmProvider: ChangelistTreeDataProvider,
	name: string
): Promise<void> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const files = store.getFiles(name);

	const message = files.length > 0
		? `Delete changelist "${name}"? ${files.length} file(s) will be moved to Unassigned.`
		: `Delete empty changelist "${name}"?`;

	const answer = await vscode.window.showWarningMessage(
		message,
		{ modal: true },
		'Delete'
	);

	if (answer !== 'Delete') {
		return;
	}

	try {
		store.deleteChangelist(name);
		store.save();
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: ${msg}`);
		return;
	}

	await scmProvider.refresh();
}

/**
 * Stash a single changelist: categorize files, create git stash,
 * save metadata, and remove from cl.json. Rolls back on failure.
 * Returns true on success, false on failure (with error shown to user).
 */
async function stashSingleChangelist(
	scmProvider: ChangelistTreeDataProvider,
	name: string,
	gitRoot: string
): Promise<boolean> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const files = store.getFiles(name);

	if (files.length === 0) {
		vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
		return false;
	}

	// Get git status to categorize files
	let gitStatusMap: Map<string, string>;
	try {
		gitStatusMap = await getGitStatus(gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return false;
	}

	// Categorize files by status (matching Python git-cl behavior)
	const fileCategories: FileCategories = {
		unstaged_changes: [],
		staged_additions: [],
		untracked: [],
		deleted: [],
	};

	const stashableFiles: string[] = [];

	for (const filePath of files) {
		const status = gitStatusMap.get(filePath);
		if (!status) {
			continue; // clean file — nothing to stash
		}

		stashableFiles.push(filePath);

		if (status === '??') {
			fileCategories.untracked.push(filePath);
		} else if (status[1] === 'D' || (status[0] === 'D' && status[1] === ' ')) {
			fileCategories.deleted.push(filePath);
		} else if (status[0] === 'A') {
			fileCategories.staged_additions.push(filePath);
		} else {
			fileCategories.unstaged_changes.push(filePath);
		}
	}

	if (stashableFiles.length === 0) {
		vscode.window.showErrorMessage(
			`git-cl: No stashable files in changelist "${name}". All files are clean.`
		);
		return false;
	}

	// Create stash
	const timestamp = new Date().toISOString();
	const stashMessage = `git-cl-stash:${name}:${timestamp}`;
	const hasUntracked = fileCategories.untracked.length > 0;

	try {
		await gitStashPush(stashMessage, gitRoot, stashableFiles, {
			includeUntracked: hasUntracked,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to stash changelist "${name}": ${msg}`);
		return false;
	}

	// Stash ref is stash@{0} immediately after creation
	const stashRef = 'stash@{0}';

	// Get current branch for metadata
	let sourceBranch: string;
	try {
		sourceBranch = await getCurrentBranch(gitRoot) ?? 'HEAD';
	} catch {
		sourceBranch = 'HEAD';
	}

	// Save stash metadata to cl-stashes.json
	const stashStore = scmProvider.getStashStore();
	stashStore.load();

	const metadata: StashMetadata = {
		stash_ref: stashRef,
		stash_message: stashMessage,
		files: [...files],
		timestamp,
		source_branch: sourceBranch,
		file_categories: fileCategories,
	};

	try {
		stashStore.setStash(name, metadata);
		stashStore.save();
	} catch (e: unknown) {
		// Rollback: drop the stash we just created
		try { await gitStashDrop(stashRef, gitRoot); } catch { /* best effort */ }
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to save stash metadata: ${msg}`);
		return false;
	}

	// Remove changelist from cl.json
	try {
		store.deleteChangelist(name);
		store.save();
	} catch (e: unknown) {
		// Rollback: remove from stash store and pop stash
		try {
			stashStore.removeStash(name);
			stashStore.save();
			await gitStashPop(stashRef, gitRoot);
		} catch { /* best effort */ }
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to update changelist data: ${msg}`);
		return false;
	}

	return true;
}

/**
 * Resolve stash changelist name from context menu args (tree node click).
 * Returns the name or undefined if not invoked from a stashed changelist node.
 */
function resolveStashName(args: unknown[]): string | undefined {
	if (args.length < 1 || !args[0]) {
		return undefined;
	}

	const node = args[0] as TreeNode;
	if (typeof node === 'object' && node !== null && 'type' in node && node.type === 'stashedChangelist') {
		return node.name;
	}

	return undefined;
}

/**
 * Show QuickPick to select a stashed changelist for an action (command palette flow).
 */
async function pickStashedChangelistForAction(
	scmProvider: ChangelistTreeDataProvider,
	action: string
): Promise<string | undefined> {
	const stashStore = scmProvider.getStashStore();
	stashStore.load();
	const names = stashStore.getNames();

	if (names.length === 0) {
		vscode.window.showInformationMessage(`git-cl: No stashed changelists to ${action}.`);
		return undefined;
	}

	const items: vscode.QuickPickItem[] = names.map(name => {
		const meta = stashStore.getStash(name);
		const date = meta ? new Date(meta.timestamp).toLocaleString() : '';
		const branch = meta?.source_branch ?? '';
		return {
			label: name,
			description: `${meta?.files.length ?? 0} file(s) — from ${branch}, ${date}`,
		};
	});

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Select a stashed changelist to ${action}`,
	});

	return picked?.label;
}

/**
 * Find the actual stash reference by matching the stash message.
 * Stash indices shift when stashes are created/dropped, so we search
 * by the unique message stored in metadata.
 */
async function findStashRefByMessage(
	stashMessage: string,
	gitRoot: string
): Promise<string | undefined> {
	const entries = await gitStashList(gitRoot);
	for (const entry of entries) {
		if (entry.message.includes(stashMessage)) {
			return entry.ref;
		}
	}
	return undefined;
}

/**
 * Unstash a single changelist: validate branch/conflicts, find stash ref,
 * pop stash, and restore changelist to cl.json.
 * If force is true, skip branch and conflict checks.
 * Returns true on success, false on failure (with error shown to user).
 */
async function unstashSingleChangelist(
	scmProvider: ChangelistTreeDataProvider,
	name: string,
	gitRoot: string,
	force: boolean
): Promise<boolean> {
	const stashStore = scmProvider.getStashStore();
	stashStore.load();
	const metadata = stashStore.getStash(name);

	if (!metadata) {
		vscode.window.showErrorMessage(`git-cl: No stash found for changelist "${name}".`);
		return false;
	}

	if (!force) {
		// Branch validation: warn if current branch differs from source branch
		let currentBranch: string;
		try {
			currentBranch = await getCurrentBranch(gitRoot) ?? 'HEAD';
		} catch {
			currentBranch = 'HEAD';
		}

		if (metadata.source_branch !== 'HEAD' && currentBranch !== metadata.source_branch) {
			const answer = await vscode.window.showWarningMessage(
				`Changelist "${name}" was stashed from branch "${metadata.source_branch}", but you are on "${currentBranch}". Unstash anyway?`,
				{ modal: true },
				'Unstash Anyway',
				'Cancel'
			);
			if (answer !== 'Unstash Anyway') {
				return false;
			}
		}

		// Conflict detection: check if stashed files conflict with current working tree
		let gitStatusMap: Map<string, string>;
		try {
			gitStatusMap = await getGitStatus(gitRoot);
		} catch {
			vscode.window.showErrorMessage('git-cl: Failed to read git status.');
			return false;
		}

		const conflicts: string[] = [];
		for (const filePath of metadata.files) {
			const status = gitStatusMap.get(filePath);
			if (status) {
				conflicts.push(filePath);
			}
		}

		if (conflicts.length > 0) {
			const suggestions = [
				'Commit the conflicting files',
				'Stash the conflicting files',
				'Discard changes to the conflicting files',
			];
			const answer = await vscode.window.showWarningMessage(
				`${conflicts.length} file(s) in stashed changelist "${name}" conflict with your working tree:\n${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? '...' : ''}\n\nSuggestions: ${suggestions.join('; ')}.`,
				{ modal: true },
				'Unstash Anyway',
				'Cancel'
			);
			if (answer !== 'Unstash Anyway') {
				return false;
			}
		}
	}

	// Find the correct stash ref by matching the stash message
	const stashRef = await findStashRefByMessage(metadata.stash_message, gitRoot);
	if (!stashRef) {
		vscode.window.showErrorMessage(
			`git-cl: Could not find git stash for changelist "${name}". The stash may have been manually dropped.`
		);
		return false;
	}

	// Pop the stash
	try {
		await gitStashPop(stashRef, gitRoot);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to unstash changelist "${name}": ${msg}`);
		return false;
	}

	// Remove from stash store first (so addFiles won't reject stashed file conflicts)
	try {
		stashStore.removeStash(name);
		stashStore.save();
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to update stash metadata: ${msg}`);
		return false;
	}

	// Restore changelist to cl.json
	const store = scmProvider.getChangelistStore();
	store.load();

	try {
		store.addFiles(name, metadata.files, stashStore);
		store.save();
	} catch (e: unknown) {
		// Rollback: restore stash metadata
		try {
			stashStore.setStash(name, metadata);
			stashStore.save();
		} catch { /* best effort */ }
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to restore changelist data: ${msg}`);
		return false;
	}

	return true;
}

// ANSI color codes for output channel formatting
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

/**
 * Map a 2-char git porcelain status to an ANSI-colored status label.
 */
function colorizeStatus(status: string): string {
	if (status === '??') {
		return `${GREEN}??${RESET}`;
	}

	const index = status[0];
	const working = status[1];

	// Conflicts
	if (index === 'U' || working === 'U' ||
		(index === 'A' && working === 'A') ||
		(index === 'D' && working === 'D')) {
		return `${RED}${status}${RESET}`;
	}

	// Deleted
	if (working === 'D' || index === 'D') {
		return `${RED}${status}${RESET}`;
	}

	// Added
	if (index === 'A') {
		return `${GREEN}${status}${RESET}`;
	}

	// Modified
	if (working === 'M' || index === 'M') {
		return `${YELLOW}${status}${RESET}`;
	}

	// Renamed / Copied
	if (index === 'R' || index === 'C') {
		return `${YELLOW}${status}${RESET}`;
	}

	return status;
}

/**
 * Show formatted changelist status in the output channel.
 */
async function showFormattedStatus(
	outputChannel: vscode.OutputChannel,
	scmProvider: ChangelistTreeDataProvider,
	gitRoot: string
): Promise<void> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const stashStore = scmProvider.getStashStore();
	stashStore.load();

	let gitStatusMap: Map<string, string>;
	try {
		gitStatusMap = await getGitStatus(gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return;
	}

	const changelists = store.getAll();
	const stashData = stashStore.getAll();
	const activeNames = Object.keys(changelists);
	const stashedNames = Object.keys(stashData);

	outputChannel.clear();
	outputChannel.appendLine(`${BOLD}=== git-cl status ===${RESET}`);
	outputChannel.appendLine('');

	// Active changelists section
	const assignedFiles = new Set<string>();

	if (activeNames.length > 0) {
		outputChannel.appendLine(`${BOLD}Active Changelists:${RESET}`);
		outputChannel.appendLine('');

		for (const name of activeNames) {
			const files = changelists[name];
			outputChannel.appendLine(`  ${BOLD}${CYAN}${name}${RESET} ${DIM}(${files.length} file${files.length !== 1 ? 's' : ''})${RESET}`);
			for (const filePath of files) {
				assignedFiles.add(filePath);
				const status = gitStatusMap.get(filePath);
				if (status) {
					outputChannel.appendLine(`    ${colorizeStatus(status)} ${filePath}`);
				} else {
					outputChannel.appendLine(`    ${DIM}  ${RESET} ${filePath} ${DIM}(clean)${RESET}`);
				}
			}
			outputChannel.appendLine('');
		}
	} else {
		outputChannel.appendLine(`${DIM}No active changelists.${RESET}`);
		outputChannel.appendLine('');
	}

	// Stashed changelists section
	if (stashedNames.length > 0) {
		outputChannel.appendLine(`${BOLD}Stashed Changelists:${RESET}`);
		outputChannel.appendLine('');

		for (const name of stashedNames) {
			const meta = stashData[name];
			const date = new Date(meta.timestamp).toLocaleString();
			outputChannel.appendLine(`  ${BOLD}${CYAN}${name}${RESET} ${DIM}(stashed from ${meta.source_branch}, ${date})${RESET}`);
			for (const filePath of meta.files) {
				assignedFiles.add(filePath);
				outputChannel.appendLine(`    ${DIM}  ${filePath}${RESET}`);
			}
			outputChannel.appendLine('');
		}
	}

	// Unassigned files section
	const stashedFiles = stashStore.getStashedFiles();
	const unassigned: [string, string][] = [];
	for (const [filePath, status] of gitStatusMap) {
		if (!assignedFiles.has(filePath) && !stashedFiles.has(filePath)) {
			unassigned.push([filePath, status]);
		}
	}

	if (unassigned.length > 0) {
		outputChannel.appendLine(`${BOLD}Unassigned Files:${RESET}`);
		outputChannel.appendLine('');
		for (const [filePath, status] of unassigned) {
			outputChannel.appendLine(`    ${colorizeStatus(status)} ${filePath}`);
		}
		outputChannel.appendLine('');
	}

	// Summary
	const totalActive = activeNames.reduce(
		(sum, name) => sum + changelists[name].length, 0
	);
	outputChannel.appendLine(
		`${DIM}${activeNames.length} changelist(s), ${totalActive} assigned file(s), ` +
		`${unassigned.length} unassigned, ${stashedNames.length} stashed${RESET}`
	);

	outputChannel.show(true);
}

export function deactivate(): void {
	// cleanup
}
