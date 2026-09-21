/*---------------------------------------------------------------------------------------------
 *  Panel Tracker — 统一管理所有 Webview Panel 的生命周期
 *
 *  在 deactivate() 中调用 disposeAllTrackedPanels() 可确保所有面板被正确清理，
 *  防止 VS Code 扩展停用后出现孤立 Webview 进程。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const _trackedPanels = new Set<vscode.WebviewPanel>();

/**
 * 注册一个 WebviewPanel 到全局追踪器。
 * 面板被 dispose 时自动从追踪列表中移除。
 */
export function trackPanel(panel: vscode.WebviewPanel): void {
	_trackedPanels.add(panel);
	panel.onDidDispose(() => {
		_trackedPanels.delete(panel);
	});
}

/**
 * 创建一个 WebviewPanel 并自动追踪其生命周期。
 * 面板会被加入 context.subscriptions 以及全局追踪器，
 * 确保扩展停用或工作区关闭时被正确清理。
 */
export function createTrackedPanel(
	context: vscode.ExtensionContext,
	viewType: string,
	title: string,
	showOptions: vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus?: boolean },
	options?: vscode.WebviewPanelOptions & vscode.WebviewOptions,
): vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel(viewType, title, showOptions, options);
	trackPanel(panel);
	context.subscriptions.push(panel);
	return panel;
}

/**
 * 返回当前所有存活的面板数量。
 */
export function getTrackedPanelCount(): number {
	return _trackedPanels.size;
}

/**
 * Dispose 所有被追踪的 Webview Panel。
 * 应在扩展 deactivate() 中调用。
 */
export function disposeAllTrackedPanels(): void {
	for (const panel of _trackedPanels) {
		try {
			panel.dispose();
		} catch {
			// Ignore errors during cleanup
		}
	}
	_trackedPanels.clear();
}
