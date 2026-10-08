/*---------------------------------------------------------------------------------------------
 *  Kodrix Hub v2 — 统一 Agent 指挥中心（大厂思维重写）
 *  新增：实时意图预览 · 功能开关交互 · 会话学习统计 · 主动上下文建议
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { HUB_PREVIEW_MAX_CHARS, getAssembledContext } from '../context/contextIntelligence';
import { onContextChanged } from '../context/contextEvents';
import { getLearningStats, getRecentLearning } from '../learning/learningEngine';
import { getSessionLearningStats } from '../learning/sessionIndex';
import { classifyIntent, routeAndExecute, RouteTarget } from '../router/agentRouter';
import { listSpecSlugs } from '../spec/specHelpers';
import { getKanbanPath } from '../paths';
import { loadWebviewHtml, createNonce, webviewCsp } from '../shared/webviewHtml';
import { createTrackedPanel } from '../utils/panelTracker';
import { logger } from '../logger';

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
	if (!p || !fs.existsSync(p)) {return 0;}
	try {
		const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { tasks?: unknown[] };
		return data.tasks?.length ?? 0;
	} catch { return 0; }
}

function hasWiki(): boolean {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {return false;}
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
			{ key: 'ideaFlow', label: l10n.t('Idea Flow: idea to product'), on: !!cfg.get('ideaFlow') },
			{ key: 'wiki', label: 'Repo Wiki', on: !!cfg.get('wiki') },
			{ key: 'memory', label: 'Memory', on: !!cfg.get('memory') },
			{ key: 'learning', label: 'Learning', on: !!cfg.get('learning') },
			{ key: 'sessionLearning', label: 'Session Learning', on: !!cfg.get('sessionLearning') },
			{ key: 'agentRouter', label: l10n.t('Smart Routing'), on: !!cfg.get('agentRouter') },
			{ key: 'kanban', label: l10n.t('Agent Kanban'), on: !!cfg.get('kanban') },
			{ key: 'arena', label: l10n.t('Arena Compare'), on: !!cfg.get('arena') },
			{ key: 'spec', label: l10n.t('Spec Workflow'), on: !!cfg.get('spec') },
			{ key: 'contextInjection', label: l10n.t('Context Injection'), on: !!cfg.get('contextInjection') },
		],
		contextPreview: getAssembledContext(HUB_PREVIEW_MAX_CHARS) || l10n.t('(Wiki + Memory context will be generated automatically when a workspace is opened — run "Kodrix: Refresh Agent Context" to trigger it manually)'),
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
			logger.warn('[Kodrix Hub] pushDashboard failed', err);
		}
	}

	function getHtml(webview: vscode.Webview, extensionPath: string): string {
		try {
			return loadWebviewHtml(webview, extensionPath, 'kodrix-hub.html');
		} catch (err) {
			logger.warn('[Kodrix Hub] 加载 HTML 资源失败', err);
			// 兜底页同样使用 nonce 策略（脚本维度不再放行 'unsafe-inline'）
			const nonce = createNonce();
			return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${webviewCsp(webview, nonce)}">
<title>Kodrix Hub</title>
<style>body{font-family:var(--vscode-font-family,sans-serif);background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);padding:24px}</style>
</head><body>
<h2>Kodrix Hub</h2>
<p>${l10n.t('Failed to load the resource file. Make sure the extension resources/kodrix-hub.html exists, then try again.')}</p>
<script nonce="${nonce}">acquireVsCodeApi().postMessage({command:'ready'});</script>
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
			logger.warn(`[Kodrix Hub] Unknown scenario: ${id}`);
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
			vscode.window.showInformationMessage(l10n.t('Repo Wiki regenerated'));
		}
	}
}

/** Hub 面板允许切换的功能开关白名单（此前任意 key 都能从 webview 写进用户全局设置） */
const TOGGLEABLE_FEATURES = new Set([
	'wiki', 'spec', 'memory', 'kanban', 'agentRouter', 'arena', 'hooks', 'acp',
	'propertyTests', 'learning', 'contextInjection', 'sessionLearning',
	'codebaseIntelligence', 'codebaseQuery', 'predictiveCompletion', 'agentCrew',
	'vibeCoding', 'ideaFlow', 'terminalAI', 'semanticMemory', 'proactiveContext',
	'contextIntelligence',
]);

async function handleToggleFeature(featureKey: string): Promise<void> {
	if (!TOGGLEABLE_FEATURES.has(featureKey)) {
		logger.warn(`[Kodrix Hub] 拒绝切换未在白名单内的功能开关：${featureKey}`);
		vscode.window.showWarningMessage(l10n.t('Unknown feature flag: {0}', featureKey));
		return;
	}
	const config = vscode.workspace.getConfiguration('kodrix.features');
	const current = config.get<boolean>(featureKey);
	const newValue = !current;
	try {
		await config.update(featureKey, newValue, vscode.ConfigurationTarget.Global);
	} catch (err) {
		// 不能"写失败还报成功"：用户会以为开关生效了
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`[Kodrix Hub] 写入设置失败：kodrix.features.${featureKey}`, err);
		vscode.window.showErrorMessage(l10n.t('Failed to switch {0}: {1}', featureKey, message));
		return;
	}

	if (activePanel) {pushDashboard(activePanel);}
	vscode.window.showInformationMessage(
		l10n.t('{0}: {1}', newValue ? l10n.t('Enabled') : l10n.t('Disabled'), featureKey)
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
					spec: l10n.t('Spec-Driven Development'),
					plan: l10n.t('Plan first'),
					agent: l10n.t('Multi-file Agent editing'),
					ask: l10n.t('Explore Q&A'),
					terminal: l10n.t('Terminal AI'),
					wiki: 'Repo Wiki',
					checkpoint: l10n.t('Checkpoint management'),
					models: l10n.t('Model providers'),
					settings: l10n.t('Kodrix Settings'),
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
			if (msg.id) {await handleScenario(msg.id);}
			break;

		case 'action':
			if (msg.id) {
				await handleAction(msg.id);
				pushDashboard(panel);
			}
			break;

		case 'toggleFeature':
			if (msg.feature) {await handleToggleFeature(msg.feature);}
			break;
		default:
			logger.warn(`[Kodrix Hub] Unknown message command: ${msg.command}`);
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
		handleMessage(msg, panel).catch(err => {
			logger.warn('[KodrixHub] 处理面板消息失败', err);
			void vscode.window.showErrorMessage(l10n.t('Kodrix Hub error: {0}', err instanceof Error ? err.message : String(err)));
		});
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
	if (activePanel) {pushDashboard(activePanel);}
}
