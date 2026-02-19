import * as vscode from 'vscode';
import { getGitRoot } from './gitUtils';
import { ChangelistSCMProvider } from './scmProvider';

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

	context.subscriptions.push(statusCmd);
	outputChannel.appendLine('git-cl extension activated.');
}

export function deactivate(): void {
	// cleanup
}
