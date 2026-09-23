/*---------------------------------------------------------------------------------------------
 *  Kodrix — 注册 Cursor 风格快捷键（Ctrl+K 行内编辑等）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function registerCursorKeybindings(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.addSelectionToChat', async () => {
			await vscode.commands.executeCommand('workbench.action.chat.open');
			await vscode.commands.executeCommand('workbench.action.chat.attachSelection');
		}),

		vscode.commands.registerCommand('kodrix.openInlineEdit', async () => {
			await vscode.commands.executeCommand('inlineChat.start');
		}),

		vscode.commands.registerCommand('kodrix.openPlanMode', async () => {
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: '/plan ',
				isPartialQuery: true,
			});
		}),
	);
}
