/*---------------------------------------------------------------------------------------------
 *  Onboarding Welcome — 3-step progressive wizard backend
 *  大厂参考：Apple Setup Assistant · Linear Onboarding · Vercel Getting Started
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { logWarn } from './logger';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectEnvironment, EnvInfo } from './envDetect';
import { detectCursorImportables, importFromCursor } from './cursorImport';

let activePanel: vscode.WebviewPanel | undefined;
let envCache: EnvInfo | undefined;
let importScanCache: { items: string[] } | undefined;

async function scanEnv(): Promise<EnvInfo> {
	if (!envCache) {
		envCache = await detectEnvironment();
	}
	return envCache;
}

/** 面板可能已被关闭，postMessage 需要兜底，避免在已销毁的 webview 上抛异常 */
function safePost(panel: vscode.WebviewPanel, msg: unknown): void {
	try {
		void panel.webview.postMessage(msg);
	} catch (err) {
		logWarn('onboarding: 面板已关闭，消息发送失败', err);
	}
}

/**
 * 只读扫描：仅检测有哪些可导入项，**不执行任何写入**。
 * 实际导入由用户在向导中点击「导入」（doImport）显式触发。
 */
async function scanImport(): Promise<{ items: string[] }> {
	if (!importScanCache) {
		try {
			importScanCache = { items: detectCursorImportables().items };
		} catch (err) {
			logWarn('扫描 Cursor 配置失败', err);
			importScanCache = { items: [] };
		}
	}
	return importScanCache;
}

function getHtml(webview: vscode.Webview, extensionPath: string): string {
	const htmlPath = path.join(extensionPath, 'resources', 'onboarding-welcome.html');
	try {
		const html = fs.readFileSync(htmlPath, 'utf-8');
		return html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
	} catch (err) {
		logWarn('加载 onboarding HTML 资源失败', err);
		return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>`
			+ `<body style="font-family:sans-serif;padding:24px">`
			+ `<h2>Welcome to Kodrix</h2>`
			+ `<p>欢迎向导资源加载失败。你仍可通过命令面板使用全部功能。</p></body></html>`;
	}
}

async function handleMessage(
	msg: { command: string; action?: string },
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
): Promise<void> {
	switch (msg.command) {
		case 'ready': {
			// 兜底：无论扫描成功与否，最多 12s 后必定回包，避免界面永远停留在“正在扫描”。
			const envBackstop = setTimeout(() => {
				safePost(panel, { type: 'envResult', data: null, error: true });
			}, 12000);
			scanEnv()
				.then(env => {
					clearTimeout(envBackstop);
					safePost(panel, { type: 'envResult', data: env });
				})
				.catch(err => {
					clearTimeout(envBackstop);
					logWarn('环境扫描失败', err);
					safePost(panel, { type: 'envResult', data: null, error: true });
				});
			scanImport()
				.then(summary => {
					safePost(panel, { type: 'importSummary', data: summary });
				})
				.catch(err => logWarn('扫描 Cursor 配置失败', err));
			break;
		}

		case 'doImport': {
			try {
				const result = await importFromCursor();
				panel.webview.postMessage({
					type: 'imported',
					count: result.itemsApplied.length,
					items: result.itemsApplied,
				});
				await context.globalState.update('kodrix.cursorImported', true);
			} catch (err) {
				logWarn('从 Cursor 导入失败', err);
				panel.webview.postMessage({ type: 'imported', count: 0, items: [], error: true });
			}
			break;
		}

		case 'quickStart':
			switch (msg.action) {
				case 'agent':
					await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
					break;
				case 'models':
					await vscode.commands.executeCommand('kodrix.openProviderWorkbench');
					break;
				case 'import':
					await vscode.commands.executeCommand('kodrix.importCursor');
					break;
			}
			break;

		case 'finish':
			await context.globalState.update('kodrix.welcomed', true);
			panel.dispose();
			break;

		default:
			logWarn(`onboarding: 未知消息类型 "${(msg as { command: string }).command}"`, msg);
	}
}

export async function openOnboardingWizard(context: vscode.ExtensionContext): Promise<void> {
	if (activePanel) {
		activePanel.reveal(vscode.ViewColumn.One);
		return;
	}

		const panel = vscode.window.createWebviewPanel(
			'kodrix.onboarding',
			'Welcome to Kodrix',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
			},
		);

	activePanel = panel;
	panel.webview.html = getHtml(panel.webview, context.extensionPath);

	context.subscriptions.push(
		panel,
		panel.webview.onDidReceiveMessage(msg => {
			handleMessage(msg, panel, context).catch(err => logWarn('onboarding 消息处理失败', err));
		}),
		panel.onDidDispose(() => {
			activePanel = undefined;
			envCache = undefined;
			importScanCache = undefined;
			context.globalState.update('kodrix.welcomed', true).then(
				undefined,
				err => logWarn('onboarding: 标记已欢迎失败', err),
			);
		}),
	);
}

export function registerOnboarding(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.onboarding.open', () => openOnboardingWizard(context)),
	);
}
