/*---------------------------------------------------------------------------------------------
 *  SOLO 四栏工作台 — Trae SOLO 风格（规划 · 对话 · 终端 · 预览）
 *
 *  大厂工程化标准：
 *   1. 所有命令 ID / 配置键 / 魔法数字使用集中常量
 *   2. 抽取 resolvePreviewUrl() 消除 openPreview / loadPreview 重复逻辑
 *   3. Dev Server 检测使用单词边界正则，避免误判
 *   4. handleMessage switch 包含 default 分支记录未知消息
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readSoloPlan, openSoloPlanDocument } from './soloPlan';
import {
	beginBuildTracking,
	getBuildStatus,
	markBuildDevRunning,
	markBuildDone,
	onBuildStatusChange,
} from './soloBuildTracker';
import { loadTemplates, detectTemplate } from './soloTemplates';
import { logger } from './logger';
import {
	COMMANDS,
	VIEW_IDS,
	CONFIG_SOLO,
	SOLO_CONFIG,
	SOLO_PREVIEW_DELAY_MS,
	DEV_SERVE_CHECK_RE,
	defaultPreviewUrl,
} from './constants';

let activePanel: vscode.WebviewPanel | undefined;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let buildStatusDisposable: vscode.Disposable | undefined;
let previewTimeout: ReturnType<typeof setTimeout> | undefined;

function getHtml(webview: vscode.Webview, extensionPath: string): string {
	const htmlPath = path.join(extensionPath, 'resources', 'solo-workbench.html');
	try {
		let html = fs.readFileSync(htmlPath, 'utf-8');
		return html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
	} catch {
		return `<!DOCTYPE html><html><body><p style="padding:20px;color:var(--vscode-errorForeground);">错误：无法加载 SOLO 工作台页面。</p></body></html>`;
	}
}

function pushPlanToPanel(panel: vscode.WebviewPanel): void {
	const plan = readSoloPlan();
	panel.webview.postMessage({ type: 'plan', content: plan.content || '' });
}

function pushTemplateToPanel(panel: vscode.WebviewPanel, extensionPath: string): void {
	const planStr = readSoloPlan().content;
	const templates = loadTemplates(extensionPath);
	const template = detectTemplate(planStr, templates) || templates.find(t => t.id === 'react-vite');
	panel.webview.postMessage({
		type: 'template',
		initCommand: template?.init_commands?.[0] || 'npm install',
		runCommand: template?.run_command || 'npm run dev',
		previewUrl: template?.run_port ? defaultPreviewUrl(template.run_port) : defaultPreviewUrl(),
	});
}

function pushBuildStatusToPanel(panel: vscode.WebviewPanel): void {
	const status = getBuildStatus();
	panel.webview.postMessage({ type: 'buildStatus', ...status });
}

/**
 * 解析当前计划的预览 URL — 消除 openPreview 和 loadPreview 中重复的
 * readSoloPlan + detectTemplate 逻辑。
 */
function resolvePreviewUrl(extensionPath: string): string {
	const planStr = readSoloPlan().content;
	const template = detectTemplate(planStr, loadTemplates(extensionPath));
	return template?.run_port ? defaultPreviewUrl(template.run_port) : defaultPreviewUrl();
}

async function runInTerminal(command: string, extensionPath: string): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const terminal = vscode.window.createTerminal({
		name: 'SOLO',
		cwd: folder?.uri.fsPath,
	});
	terminal.show();
	terminal.sendText(command);
	if (DEV_SERVE_CHECK_RE.test(command)) {
		markBuildDevRunning();
		if (activePanel) {
			pushBuildStatusToPanel(activePanel);
		}
		const templates = loadTemplates(extensionPath);
		const planStr = readSoloPlan().content;
		const template = detectTemplate(planStr, templates);
		if (template?.run_port && activePanel) {
			// 清除旧计时器，防止 webview 已关闭后仍尝试发消息
			if (previewTimeout) {
				clearTimeout(previewTimeout);
			}
			previewTimeout = setTimeout(() => {
				previewTimeout = undefined;
				activePanel?.webview.postMessage({
					type: 'preview',
					url: defaultPreviewUrl(template.run_port!),
				});
			}, SOLO_PREVIEW_DELAY_MS);
		}
	}
}

async function openPreviewExternal(url: string): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (commands.includes(COMMANDS.simpleBrowserShow)) {
		await vscode.commands.executeCommand(COMMANDS.simpleBrowserShow, url);
		return;
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function handleMessage(
	msg: { command: string; cmd?: string },
	panel: vscode.WebviewPanel,
	extensionPath: string,
	context: vscode.ExtensionContext,
): Promise<void> {
	switch (msg.command) {
		case 'ready':
		case 'refreshPlan':
			pushPlanToPanel(panel);
			pushTemplateToPanel(panel, extensionPath);
			break;
		case 'openPlan':
			await openSoloPlanDocument();
			break;
		case 'startPlan':
			await vscode.commands.executeCommand(COMMANDS.chatOpen, {
				query: '@solo ',
				isPartialQuery: true,
			});
			panel.webview.postMessage({ type: 'status', text: '已在 Chat 打开 @solo — 输入需求后规划将同步到此面板' });
			break;
		case 'confirmBuild':
			beginBuildTracking(context);
			pushBuildStatusToPanel(panel);
			await vscode.commands.executeCommand(COMMANDS.chatOpen, {
				query: '@solo /build 确认构建',
				isPartialQuery: false,
			});
			panel.webview.postMessage({ type: 'status', text: 'Agent 构建中 — 进度见 Terminal 栏' });
			break;
		case 'openAgent':
			await vscode.commands.executeCommand(COMMANDS.chatOpen, { mode: 'agent' });
			break;
		case 'runCommand':
			if (msg.cmd) {
				await runInTerminal(msg.cmd, extensionPath);
				pushBuildStatusToPanel(panel);
			}
			break;
		case 'markBuildDone':
			markBuildDone();
			pushBuildStatusToPanel(panel);
			break;
		case 'focusTerminal':
			await vscode.commands.executeCommand(COMMANDS.terminalFocus);
			break;
		case 'openPreview': {
			const url = resolvePreviewUrl(extensionPath);
			await openPreviewExternal(url);
			break;
		}
		case 'loadPreview': {
			const url2 = resolvePreviewUrl(extensionPath);
			panel.webview.postMessage({ type: 'preview', url: url2 });
			break;
		}
		default:
			logger.warn(`SOLO workbench: 未知消息类型 "${msg.command}"`);
	}
}

function setupPlanWatcher(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
	fileWatcher?.dispose();
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const pattern = new vscode.RelativePattern(folder, '.minicode/solo/last-plan.md');
	fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
	const refresh = () => pushPlanToPanel(panel);
	fileWatcher.onDidChange(refresh);
	fileWatcher.onDidCreate(refresh);
	context.subscriptions.push(fileWatcher);
}

export function notifySoloPlanUpdated(): void {
	if (activePanel) {
		pushPlanToPanel(activePanel);
	}
}

export async function openSoloWorkbench(context: vscode.ExtensionContext): Promise<void> {
	const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

	if (activePanel) {
		activePanel.reveal(column);
		pushPlanToPanel(activePanel);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		VIEW_IDS.soloWorkbench,
		'SOLO Builder',
		column,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
		},
	);

	activePanel = panel;
	panel.webview.html = getHtml(panel.webview, context.extensionPath);

	panel.webview.onDidReceiveMessage(msg => {
		void handleMessage(msg, panel, context.extensionPath, context);
	});

	buildStatusDisposable = onBuildStatusChange(() => {
		if (activePanel) {
			pushBuildStatusToPanel(activePanel);
		}
	});

	panel.onDidDispose(() => {
		activePanel = undefined;
		fileWatcher?.dispose();
		fileWatcher = undefined;
		buildStatusDisposable?.dispose();
		buildStatusDisposable = undefined;
		if (previewTimeout) {
			clearTimeout(previewTimeout);
			previewTimeout = undefined;
		}
	});

	setupPlanWatcher(panel, context);
	pushPlanToPanel(panel);
	pushTemplateToPanel(panel, context.extensionPath);
	pushBuildStatusToPanel(panel);

	// 并排打开 Chat（Trae SOLO + IDE 协同）
	const openChatSideBySide = vscode.workspace.getConfiguration(CONFIG_SOLO)
		.get<boolean>(SOLO_CONFIG.workbenchOpenChat, true);
	if (openChatSideBySide) {
		await vscode.commands.executeCommand(COMMANDS.chatOpen, {
			query: '@solo ',
			isPartialQuery: true,
		});
	}
}
