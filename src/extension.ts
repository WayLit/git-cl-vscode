import * as vscode from 'vscode';
import * as path from 'path';
import { getGitRoot, getGitStatus } from './gitUtils';
import { ChangelistSCMProvider } from './scmProvider';
import { validateChangelistName } from './changelistStore';

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

	// Initialize SCM provider (changelists tree in Source Control sidebar)
	const scmProvider = new ChangelistSCMProvider(gitRoot);
	context.subscriptions.push(scmProvider);

	const statusCmd = vscode.commands.registerCommand('git-cl.showStatus', () => {
		outputChannel.appendLine('git-cl extension is active.');
		outputChannel.show();
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

	const deleteChangelistCmd = vscode.commands.registerCommand(
		'git-cl.deleteChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(scmProvider, args);

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

	context.subscriptions.push(statusCmd, addToChangelistCmd, removeFromChangelistCmd, deleteChangelistCmd, deleteAllChangelistsCmd);
	outputChannel.appendLine('git-cl extension activated.');
}

/**
 * Resolve file paths from command arguments (context menu) or prompt the user
 * to select files from git status (command palette).
 */
async function resolveFilePaths(
	gitRoot: string,
	args: unknown[]
): Promise<string[] | undefined> {
	// Context menu with multi-select: second arg is the array of selected resources
	if (args.length >= 2 && Array.isArray(args[1])) {
		const resources = args[1] as vscode.SourceControlResourceState[];
		return resources.map(r =>
			path.relative(gitRoot, r.resourceUri.fsPath).split(path.sep).join('/')
		);
	}

	// Context menu single-select: first arg is the clicked resource
	if (
		args.length >= 1 &&
		args[0] &&
		typeof args[0] === 'object' &&
		'resourceUri' in (args[0] as Record<string, unknown>)
	) {
		const resource = args[0] as vscode.SourceControlResourceState;
		return [
			path.relative(gitRoot, resource.resourceUri.fsPath)
				.split(path.sep)
				.join('/'),
		];
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
	scmProvider: ChangelistSCMProvider,
	args: unknown[]
): Promise<string[] | undefined> {
	// Context menu with multi-select: second arg is the array of selected resources
	if (args.length >= 2 && Array.isArray(args[1])) {
		const resources = args[1] as vscode.SourceControlResourceState[];
		return resources.map(r =>
			path.relative(gitRoot, r.resourceUri.fsPath).split(path.sep).join('/')
		);
	}

	// Context menu single-select: first arg is the clicked resource
	if (
		args.length >= 1 &&
		args[0] &&
		typeof args[0] === 'object' &&
		'resourceUri' in (args[0] as Record<string, unknown>)
	) {
		const resource = args[0] as vscode.SourceControlResourceState;
		return [
			path.relative(gitRoot, resource.resourceUri.fsPath)
				.split(path.sep)
				.join('/'),
		];
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
	scmProvider: ChangelistSCMProvider
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
 * Resolve changelist name from context menu args (group header click).
 * Returns the name or undefined if not invoked from a group header.
 */
function resolveChangelistName(
	_scmProvider: ChangelistSCMProvider,
	args: unknown[]
): string | undefined {
	if (args.length < 1 || !args[0]) {
		return undefined;
	}

	const group = args[0] as vscode.SourceControlResourceGroup;
	if (typeof group.id !== 'string' || !group.id.startsWith('cl:')) {
		return undefined;
	}

	return group.id.slice(3); // strip "cl:" prefix
}

/**
 * Show QuickPick to select a changelist for deletion (command palette flow).
 */
async function pickChangelistForDeletion(
	scmProvider: ChangelistSCMProvider
): Promise<string | undefined> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const names = store.getNames();

	if (names.length === 0) {
		vscode.window.showInformationMessage('git-cl: No changelists to delete.');
		return undefined;
	}

	const items: vscode.QuickPickItem[] = names.map(name => ({
		label: name,
		description: `${store.getFiles(name).length} file(s)`,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a changelist to delete',
	});

	return picked?.label;
}

/**
 * Delete a changelist after confirming with the user.
 */
async function deleteChangelistWithConfirmation(
	scmProvider: ChangelistSCMProvider,
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

export function deactivate(): void {
	// cleanup
}
