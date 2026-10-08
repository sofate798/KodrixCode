/*---------------------------------------------------------------------------------------------
 *  Kodrix 活动栏入口视图（Launcher）
 *
 *  为什么需要一个"空"提供者：VS Code 的 `viewsWelcome` 只在**树为空**时展示，而
 *  `registerTreeDataProvider` 的注册动作本身也是"该视图 id 真实存在于代码中"的证据
 *  （贡献点检查器会拦下"只在 package.json 里声明、源码里从不出现"的视图 —— 那种情况
 *  在真实构建里会静默失效）。这里刻意不提供任何节点：面板内容全部由 package.json 的
 *  `viewsWelcome.kodrix.launcher.contents` 维护，改文案不需要动代码。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** 活动栏容器 `kodrix` 下的视图 id（与 package.json 的 contributes.views 保持一致） */
export const LAUNCHER_VIEW_ID = 'kodrix.launcher';

export function registerLauncherView(context: vscode.ExtensionContext): void {
	const provider: vscode.TreeDataProvider<never> = {
		getChildren: () => [],
		getTreeItem: (element: never) => element,
	};
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider(LAUNCHER_VIEW_ID, provider),
	);
}
