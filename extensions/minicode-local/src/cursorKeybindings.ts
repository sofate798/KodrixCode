/*---------------------------------------------------------------------------------------------
 *  Minicode — 注册 Cursor 风格快捷键（Ctrl+K 行内编辑等）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function registerCursorKeybindings(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('minicode.addSelectionToChat', async () => {
			await vscode.commands.executeCommand('workbench.action.chat.open');
			await vscode.commands.executeCommand('workbench.action.chat.attachSelection');
		}),

		vscode.commands.registerCommand('minicode.openInlineEdit', async () => {
			await vscode.commands.executeCommand('inlineChat.start');
		}),

		vscode.commands.registerCommand('minicode.openPlanMode', async () => {
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: '/plan ',
				isPartialQuery: true,
			});
		}),
	);
}
