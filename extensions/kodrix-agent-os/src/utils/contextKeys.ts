/*---------------------------------------------------------------------------------------------
 *  Context Keys — setContext 上下文键同步
 *
 *  package.json 的 views/keybindings when 子句会消费扩展自定义上下文键。
 *  「kodrix.checkpoints」视图以 `when: "kodrix.hasWorkspace"` 门控：若扩展激活后
 *  从不 setContext，该键恒为 false，视图永远不显示。本模块负责把它与工作区实际
 *  状态同步（激活时 + 工作区文件夹变化时）。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HAS_WORKSPACE_CONTEXT_KEY } from '../shared/constants';

/** 将 kodrix.hasWorkspace 同步为「当前是否打开了工作区文件夹」 */
export async function syncHasWorkspaceContext(): Promise<void> {
	const hasWorkspace = !!vscode.workspace.workspaceFolders?.length;
	await vscode.commands.executeCommand('setContext', HAS_WORKSPACE_CONTEXT_KEY, hasWorkspace);
}

/** 激活期注册：立即同步一次，并跟随工作区文件夹增删持续同步 */
export function registerHasWorkspaceContext(context: vscode.ExtensionContext): void {
	void syncHasWorkspaceContext();
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void syncHasWorkspaceContext();
		}),
	);
}
