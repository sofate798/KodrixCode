/*---------------------------------------------------------------------------------------------
 *  Kodrix Hub v2 — 统一 Agent 指挥中心（大厂思维重写）
 *  新增：实时意图预览 · 功能开关交互 · 会话学习统计 · 主动上下文建议
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { getAssembledContext } from '../context/contextIntelligence';
import { onContextChanged } from '../context/contextEvents';
import { getLearningStats, getRecentLearning } from '../learning/learningEngine';
import { getSessionLearningStats } from '../learning/sessionIndex';
import { classifyIntent, routeAndExecute, RouteTarget } from '../router/agentRouter';
import { listSpecSlugs } from '../spec/specHelpers';
import { getKanbanPath } from '../paths';
import { loadWebviewHtml } from '../shared/webviewHtml';
import { createTrackedPanel } from '../utils/panelTracker';

let activePanel: vscode.WebviewPanel | undefined;

interface FeatureToggle {
	key: string;
	label: string;
	on: boolean;
}

interface HubDashboard {
	features: FeatureToggle[];
	contextPreview: string;
	recentLearning: Array<{ category: string; content: string; date: string }>;
	workspaceName?: string;
	learningTotal: number;
	specCount: number;
	kanbanCount: number;
	hasWiki: boolean;
	sessionLearningProcessed: number;
}

function loadKanbanCount(): number {
	const p = getKanbanPath();
	if (!p || !fs.existsSync(p)) return 0;
	try {
		const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { tasks?: unknown[] };
		return data.tasks?.length ?? 0;
	} catch { return 0; }
}

function hasWiki(): boolean {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return false;
	return fs.existsSync(path.join(folder.uri.fsPath, '.kodrix', 'wiki', 'INDEX.md'));
}

function buildDashboard(): HubDashboard {
	const cfg = vscode.workspace.getConfiguration('kodrix.features');
	const learning = getLearningStats();
	const folder = vscode.workspace.workspaceFolders?.[0];

	let ss = { processed: 0, totalInsights: 0 };
	try { ss = getSessionLearningStats(); } catch { /* not yet initialized */ }

	return {
		features: [
			{ key: 'ideaFlow', label: 'Idea Flow 想法→产品', on: !!cfg.get('ideaFlow') },
			{ key: 'wiki', label: 'Repo Wiki', on: !!cfg.get('wiki') },
			{ key: 'memory', label: 'Memory', on: !!cfg.get('memory') },
			{ key: 'learning', label: 'Learning', on: !!cfg.get('learning') },
			{ key: 'sessionLearning', label: 'Session Learning', on: !!cfg.get('sessionLearning') },
			{ key: 'agentRouter', label: '智能路由', on: !!cfg.get('agentRouter') },
			{ key: 'kanban', label: 'Agent 看板', on: !!cfg.get('kanban') },
			{ key: 'arena', label: 'Arena 对比', on: !!cfg.get('arena') },
			{ key: 'spec', label: 'Spec 工作流', on: !!cfg.get('spec') },
			{ key: 'contextInjection', label: '上下文注入', on: !!cfg.get('contextInjection') },
		],
		contextPreview: getAssembledContext(600) || '（打开工作区后将自动生成 Wiki + Memory 上下文——运行「Kodrix: 刷新 Agent 上下文」手动触发）',
		recentLearning: [] as Array<{ category: string; content: string; date: string }>,
		workspaceName: folder?.name,
		learningTotal: learning.total,
		specCount: listSpecSlugs().length,
		kanbanCount: loadKanbanCount(),
		hasWiki: hasWiki(),
		sessionLearningProcessed: ss.processed,
	};
}

	function pushDashboard(panel: vscode.WebviewPanel): void {
		try {
			const dashboard = buildDashboard();
			dashboard.recentLearning = getRecentLearning(6).map(e => ({
				category: e.category,
				content: e.content.length > 90 ? e.content.slice(0, 90) + '…' : e.content,
				date: e.timestamp.slice(0, 10),
			}));
			panel.webview.postMessage({ type: 'dashboard', data: dashboard });
		} catch (err) {
			console.warn('[Kodrix Hub] pushDashboard failed', err);
		}
	}

	function getHtml(webview: vscode.Webview, extensionPath: string): string {
		try {
			return loadWebviewHtml(webview, extensionPath, 'kodrix-hub.html');
		} catch (err) {
			console.warn('[Kodrix Hub] 加载 HTML 资源失败', err);
			return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
<title>Kodrix Hub</title>
<style>body{font-family:var(--vscode-font-family,sans-serif);background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);padding:24px}</style>
</head><body>
<h2>Kodrix Hub</h2>
<p>资源文件加载失败。请确认扩展 resources/kodrix-hub.html 存在后重试。</p>
<script>acquireVsCodeApi().postMessage({command:'ready'});</script>
</body></html>`;
		}
	}

async function handleScenario(id: string): Promise<void> {
	switch (id) {
		case 'idea':
			await vscode.commands.executeCommand('kodrix.idea.start');
			break;
		case 'spec':
			await vscode.commands.executeCommand('kodrix.spec.openWorkbench');
			break;
		case 'agent':
			await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
			break;
		case 'ask':
			await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'ask' });
			break;
		case 'router':
			await vscode.commands.executeCommand('kodrix.router.route');
			break;
		default:
			console.warn(`[Kodrix Hub] Unknown scenario: ${id}`);
	}
}

async function handleAction(id: string): Promise<void> {
	const map: Record<string, string> = {
		ideaCanvas: 'kodrix.idea.open',
		specWorkbench: 'kodrix.spec.openWorkbench',
		agentsWindow: 'kodrix.openAgentsWindow',
		chat: 'workbench.action.chat.open',
		agentMode: 'kodrix.openComposer',
		wiki: 'kodrix.wiki.open',
		kanban: 'kodrix.kanban.focus',
		learning: 'kodrix.learn.dashboard',
		arena: 'kodrix.arena.compare',
		providers: 'kodrix.openProviderWorkbench',
		refreshContext: 'kodrix.context.refresh',
		importCursor: 'kodrix.importCursor',
		rebuildWiki: 'kodrix.wiki.generate',
	};
	const cmd = map[id];
	if (cmd) {
		await vscode.commands.executeCommand(cmd);
		if (id === 'rebuildWiki') {
			vscode.window.showInformationMessage(l10n.t('Repo Wiki 已重新生成'));
		}
	}
}

async function handleToggleFeature(featureKey: string): Promise<void> {
	const config = vscode.workspace.getConfiguration('kodrix.features');
	const current = config.get<boolean>(featureKey);
	const newValue = !current;
	await config.update(featureKey, newValue, vscode.ConfigurationTarget.Global);

	if (activePanel) pushDashboard(activePanel);
	vscode.window.showInformationMessage(
		l10n.t('{0}：{1}', newValue ? '已启用' : '已关闭', featureKey)
	);
}

async function handleMessage(
	msg: { command: string; id?: string; prompt?: string; feature?: string },
	panel: vscode.WebviewPanel,
): Promise<void> {
	switch (msg.command) {
		case 'ready':
			pushDashboard(panel);
			break;

		case 'quickRoute':
			if (msg.prompt?.trim()) {
				await routeAndExecute(msg.prompt.trim());
				pushDashboard(panel);
			}
			break;

		case 'detectIntent':
			if (msg.prompt?.trim()) {
				const route = classifyIntent(msg.prompt.trim());
				const labels: Record<RouteTarget, string> = {
					spec: 'Spec 驱动开发',
					plan: 'Plan 先规划',
					agent: 'Agent 多文件编辑',
					ask: 'Ask 问答探索',
					terminal: '终端 AI',
					wiki: 'Repo Wiki',
					checkpoint: '检查点管理',
					models: '模型供应商',
					settings: 'Kodrix 设置',
				};
				panel.webview.postMessage({
					type: 'intentResult',
					label: labels[route.target],
					reason: route.reason,
					target: route.target,
				});
			}
			break;

		case 'scenario':
			if (msg.id) await handleScenario(msg.id);
			break;

		case 'action':
			if (msg.id) {
				await handleAction(msg.id);
				pushDashboard(panel);
			}
			break;

		case 'toggleFeature':
			if (msg.feature) await handleToggleFeature(msg.feature);
			break;
		default:
			console.warn(`[Kodrix Hub] Unknown message command: ${msg.command}`);
	}
}

export async function openKodrixHub(context: vscode.ExtensionContext): Promise<void> {
	const column = vscode.ViewColumn.One;

	if (activePanel) {
		activePanel.reveal(column);
		pushDashboard(activePanel);
		return;
	}

	const panel = createTrackedPanel(
		context,
		'kodrix.hub',
		'Kodrix Hub',
		column,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
		},
	);

	activePanel = panel;
	panel.iconPath = new vscode.ThemeIcon('hubot');
	panel.webview.html = getHtml(panel.webview, context.extensionPath);

	panel.webview.onDidReceiveMessage(msg => {
		void handleMessage(msg, panel);
	});

	panel.onDidDispose(() => {
		activePanel = undefined;
	});

	pushDashboard(panel);
}

export function registerKodrixHub(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.hub.open', () => openKodrixHub(context)),
		onContextChanged(() => refreshHubIfOpen()),
	);
}

export function refreshHubIfOpen(): void {
	if (activePanel) pushDashboard(activePanel);
}
