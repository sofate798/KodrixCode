/*---------------------------------------------------------------------------------------------
 *  Onboarding Welcome — 3-step progressive wizard backend
 *  大厂参考：Apple Setup Assistant · Linear Onboarding · Vercel Getting Started
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { logger } from './logger';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { detectEnvironment, EnvInfo } from './envDetect';
import { detectCursorImportables, importFromCursor } from './cursorImport';
import { resolveConfigDir } from './migrateConfig';

let activePanel: vscode.WebviewPanel | undefined;
let envCache: EnvInfo | undefined;
let importScanCache: { items: string[]; notes: string[] } | undefined;

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
		logger.warn('onboarding: 面板已关闭，消息发送失败', err);
	}
}

/**
 * 只读扫描：Cursor 可导入项 + Cursormini/Kodrix 状态说明。
 * 按钮「导入」只跑 Cursor；Cursormini 已在扩展 activate 时静默迁移。
 */
async function scanImport(context: vscode.ExtensionContext): Promise<{ items: string[]; notes: string[] }> {
	if (!importScanCache) {
		try {
			const cursor = detectCursorImportables();
			const notes: string[] = [];
			const dir = resolveConfigDir();
			const hasLegacy =
				fs.existsSync(path.join(dir, 'config.json'))
				|| fs.existsSync(path.join(dir, 'providers.json'))
				|| fs.existsSync(path.join(dir, 'plugins'));
			const already = context.globalState.get<boolean>('kodrix.configMigrated', false);
			if (already) {
				notes.push(l10n.t('Cursormini / Kodrix 配置已在首次启动时自动迁移'));
			} else if (hasLegacy) {
				notes.push(l10n.t('检测到 {0} — 将在后台自动迁移（或运行「Kodrix: 迁移配置」）', dir));
			}
			importScanCache = { items: cursor.items, notes };
		} catch (err) {
			logger.warn('扫描导入配置失败', err);
			importScanCache = { items: [], notes: [] };
		}
	}
	return importScanCache;
}

function getHtml(webview: vscode.Webview, extensionPath: string): string {
	const resourcesDir = path.join(extensionPath, 'resources');
	const htmlPath = path.join(resourcesDir, 'onboarding-welcome.html');
	try {
		const html = fs.readFileSync(htmlPath, 'utf-8');
		const codiconsCssUri = webview.asWebviewUri(
			vscode.Uri.file(path.join(resourcesDir, 'codicons', 'codicon.css')),
		);
		const logoUri = webview.asWebviewUri(
			vscode.Uri.file(path.join(resourcesDir, 'kodrix-logo.png')),
		);
		return html
			.replace(/\{\{cspSource\}\}/g, webview.cspSource)
			.replace(/\{\{codiconsCssUri\}\}/g, codiconsCssUri.toString())
			.replace(/\{\{logoUri\}\}/g, logoUri.toString());
	} catch (err) {
		logger.warn('加载 onboarding HTML 资源失败', err);
		return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>`
			+ `<body style="font-family:sans-serif;padding:24px">`
			+ `<h2>Welcome to Kodrix</h2>`
			+ `<p>${l10n.t('欢迎向导资源加载失败。你仍可通过命令面板使用全部功能。')}</p></body></html>`;
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
					logger.warn('环境扫描失败', err);
					safePost(panel, { type: 'envResult', data: null, error: true });
				});
			scanImport(context)
				.then(summary => {
					safePost(panel, { type: 'importSummary', data: summary });
				})
				.catch(err => logger.warn('扫描导入配置失败', err));
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
				logger.warn('从 Cursor 导入失败', err);
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
			logger.warn(`onboarding: 未知消息类型 "${(msg as { command: string }).command}"`, msg);
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
			handleMessage(msg, panel, context).catch(err => logger.warn('onboarding 消息处理失败', err));
		}),
		panel.onDidDispose(() => {
			activePanel = undefined;
			envCache = undefined;
			importScanCache = undefined;
			context.globalState.update('kodrix.welcomed', true).then(
				undefined,
				err => logger.warn('onboarding: 标记已欢迎失败', err),
			);
		}),
	);
}

export function registerOnboarding(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.onboarding.open', () => openOnboardingWizard(context)),
	);
}
