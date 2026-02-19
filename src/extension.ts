import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel('git-cl');

	const statusCmd = vscode.commands.registerCommand('git-cl.showStatus', () => {
		outputChannel.appendLine('git-cl extension is active.');
		outputChannel.show();
	});

	context.subscriptions.push(outputChannel, statusCmd);

	outputChannel.appendLine('git-cl extension activated.');
}

export function deactivate(): void {
	// cleanup
}
