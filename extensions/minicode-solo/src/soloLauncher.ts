/*---------------------------------------------------------------------------------------------
 *  SOLO 活动栏入口
 *
 *  第一次点开活动栏图标时打开新窗口；之后仍可从侧栏按钮再次打开。
 *  已经是 SOLO 窗口时，只把工作台拉到前台，避免连环开窗。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { consumeSoloWindowLaunch, isSoloWindow, openSoloInNewWindow } from './soloWindow';

const VIEW_ID = 'minicode.solo.launcher';

export function registerSoloLauncher(context: vscode.ExtensionContext): void {
	void consumeSoloWindowLaunch(context);

	const provider = new SoloLauncherViewProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('minicode.solo.openWindow', () => openSoloInNewWindow(context)),
	);
}

class SoloLauncherViewProvider implements vscode.WebviewViewProvider {
	private openedThisSession = false;
	private opening = false;

	constructor(private readonly context: vscode.ExtensionContext) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.html(isSoloWindow());
		webviewView.webview.onDidReceiveMessage(msg => {
			if (msg?.type === 'open') {
				if (isSoloWindow()) {
					void vscode.commands.executeCommand('minicode.solo.openWorkbench');
				} else {
					void openSoloInNewWindow(this.context);
				}
			}
		});

		webviewView.onDidChangeVisibility(() => {
			if (!webviewView.visible || isSoloWindow() || this.openedThisSession || this.opening) {
				return;
			}
			this.opening = true;
			this.openedThisSession = true;
			void openSoloInNewWindow(this.context).finally(() => {
				this.opening = false;
			});
		});

		if (webviewView.visible && !isSoloWindow() && !this.openedThisSession) {
			this.openedThisSession = true;
			void openSoloInNewWindow(this.context);
		}
	}

	private html(alreadySolo: boolean): string {
		const title = alreadySolo ? '此窗口是 SOLO' : 'SOLO Builder';
		const body = alreadySolo
			? '四栏工作台已在这个窗口里。需要时可以重新打开。'
			: 'SOLO 在独立窗口里规划、生成并预览项目，不占用当前编辑器。';
		const label = alreadySolo ? '打开 SOLO 工作台' : '在新窗口打开 SOLO';
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; margin: 0; }
	h2 { font-size: 14px; margin: 0 0 8px; }
	p { font-size: 12px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
	button {
		margin-top: 12px; width: 100%;
		background: var(--vscode-button-background); color: var(--vscode-button-foreground);
		border: none; padding: 8px 10px; border-radius: 4px; cursor: pointer;
	}
</style>
</head>
<body>
	<h2>${title}</h2>
	<p>${body}</p>
	<button id="open">${label}</button>
	<script>
		const vscode = acquireVsCodeApi();
		document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
	</script>
</body>
</html>`;
	}
}
