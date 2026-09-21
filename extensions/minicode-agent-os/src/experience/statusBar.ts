/*---------------------------------------------------------------------------------------------
 *  Agent OS 状态栏 — 品牌指示器 + 上下文就绪 + 主动感知 + 路由历史
 *  （Windsurf / Cursor 大厂思维 · Minicode 品牌升级版）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getContextStatus } from '../context/contextIntelligence';
import { onContextChanged } from '../context/contextEvents';
import { onMinicodeEvent } from '../context/minicodeEventBus';
import { getLastFileContextHint } from '../context/proactiveContext';
import { getLastRoute } from '../router/agentRouter';

let brandStatusItem: vscode.StatusBarItem | undefined;
let contextStatusItem: vscode.StatusBarItem | undefined;
let routeStatusItem: vscode.StatusBarItem | undefined;

const TARGET_LABEL: Record<string, string> = {
	solo: 'SOLO',
	spec: 'Spec',
	plan: 'Plan',
	agent: 'Agent',
	ask: 'Ask',
};

/**
 * Brand colour palette — mirrors the CSS `--minicode-brand-*` tokens defined
 * in `roundedCorners.css` and `2026-dark.json` so the status bar is consistent
 * with the workbench visual language.
 */
const BRAND = {
	primary: '#3994BC',
	secondary: '#58B3D9',
	accent: '#3DA8D4',
	success: '#73C991',
	warning: '#E5BA7D',
	error: '#F48771',
	info: '#58B3D9',
	muted: '#555555',
	text: '#BFBFBF',
	textSecondary: '#8C8C8C',
} as const;

interface BrandState {
	level: 'ready' | 'partial' | 'empty' | 'error';
	dotColor: string;
	labelColor: string | undefined;
	icon: string;
	label: string;
}

function computeBrandState(status: ReturnType<typeof getContextStatus>): BrandState {
	if (!status.wikiOk && !status.memoryCount && !status.learningCount) {
		return {
			level: 'empty',
			dotColor: BRAND.muted,
			labelColor: undefined,
			icon: 'circle-outline',
			label: 'Minicode',
		};
	}

	if (status.wikiOk && status.learningCount > 0) {
		return {
			level: 'ready',
			dotColor: BRAND.success,
			labelColor: undefined,
			icon: 'pass-filled',
			label: 'Minicode',
		};
	}

	if (status.wikiOk || status.memoryCount > 0) {
		return {
			level: 'partial',
			dotColor: BRAND.primary,
			labelColor: undefined,
			icon: 'sync',
			label: 'Minicode',
		};
	}

	// Fallback — context exists but not yet fully ready.
	return {
		level: 'partial',
		dotColor: BRAND.warning,
		labelColor: undefined,
		icon: 'circle-outline',
		label: 'Minicode',
	};
}

export function updateStatusBar(): void {
	if (!brandStatusItem || !contextStatusItem) {
		return;
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		brandStatusItem.hide();
		contextStatusItem.hide();
		routeStatusItem?.hide();
		return;
	}

	const status = getContextStatus();
	const fileHint = getLastFileContextHint();
	const lastRoute = getLastRoute();
	const brandState = computeBrandState(status);

	// ── Brand indicator (leftmost, highest priority) ──
	const dotGlyph = '●'; // U+25CF filled circle — consistent across platforms

	brandStatusItem.text = `$(${brandState.icon}) ${dotGlyph} Minicode`;
	brandStatusItem.color = brandState.dotColor;

	const statusParts: string[] = [];
	if (status.wikiOk) statusParts.push('Wiki ✓');
	if (status.memoryCount > 0) statusParts.push(`Memory ${status.memoryCount}条`);
	if (status.learningCount > 0) statusParts.push(`Learning ${status.learningCount}条`);
	if (status.semanticVectors > 0) statusParts.push(`语义索引 ${status.semanticVectors}向量`);

	brandStatusItem.tooltip = new vscode.MarkdownString(
		`### $(hubot) Minicode Agent OS 指挥中心\n\n`
		+ (statusParts.length
			? statusParts.map(p => `- ${p}`).join('\n') + '\n\n'
			: '*(未初始化)* 运行 **Minicode: 生成 Repo Wiki** 以开始。\n\n')
		+ `[打开 Hub](command:minicode.hub.open) · \`Ctrl+Shift+H\``
		+ `  \n[刷新上下文](command:minicode.context.refresh)`,
	);
	brandStatusItem.backgroundColor = brandState.level === 'ready'
		? new vscode.ThemeColor('statusBarItem.prominentBackground')
		: undefined;
	brandStatusItem.show();

	// ── Context + proactive hint ──
	const level = brandState.level;
	const levelLabel = level === 'ready' ? '上下文就绪'
		: level === 'partial' ? '上下文部分'
		: level === 'error' ? '上下文错误'
		: '待预热';
	const levelIcon = level === 'ready' ? '$(pass-filled)'
		: level === 'partial' ? '$(circle-outline)'
		: level === 'error' ? '$(error)'
		: '$(warning)';

	let contextText = `${levelIcon} ${levelLabel}`;
	if (fileHint?.relevantCount) {
		contextText += ` $(lightbulb) ${fileHint.relevantCount}`;
	}
	contextStatusItem.text = contextText;

	const tooltipLines = [
		'**Agent 上下文 Intelligence**',
		'',
		`${levelLabel} — Wiki + Memory + Learning + Semantic`,
	];
	if (fileHint?.relevantCount) {
		tooltipLines.push('', `**当前文件相关记忆** (${fileHint.fileName})`);
		tooltipLines.push(`- ${fileHint.relevantCount} 条匹配`);
		if (fileHint.topMatch) {
			tooltipLines.push(`- ${fileHint.topMatch}…`);
		}
	}
	tooltipLines.push('', '刷新: `Minicode: 刷新 Agent 上下文`');
	contextStatusItem.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
	contextStatusItem.show();

	// ── Last route ──
	if (routeStatusItem) {
		if (lastRoute) {
			const label = TARGET_LABEL[lastRoute.target] ?? lastRoute.target;
			routeStatusItem.text = `$(arrow-swap) ${label}`;
			routeStatusItem.tooltip = new vscode.MarkdownString(
				`**上次智能路由**\n\n`
				+ `- 模式: **${label}**\n`
				+ `- 原因: ${lastRoute.reason}\n`
				+ `- 输入: ${lastRoute.prompt.slice(0, 80)}…\n\n`
				+ `点击重复上次路由 · \`Minicode: 重复上次路由\``,
			);
			routeStatusItem.show();
		} else {
			routeStatusItem.hide();
		}
	}
}

/**
 * Periodically refreshes the status bar to keep the brand indicator in sync
 * with real-time context changes (e.g. wiki generation in background).
 * Runs every 30 seconds; the interval is cleared on extension deactivation.
 */
let brandRefreshInterval: ReturnType<typeof setInterval> | undefined;

export function registerStatusBar(context: vscode.ExtensionContext): void {
	// Brand indicator — leftmost, anchors the Minicode identity.
	brandStatusItem = vscode.window.createStatusBarItem('minicode.brand', vscode.StatusBarAlignment.Left, 50);
	brandStatusItem.name = 'Minicode';
	brandStatusItem.command = 'minicode.hub.open';
	brandStatusItem.accessibilityInformation = {
		label: 'Minicode — 打开 Agent 指挥中心',
	};

	// Context readiness — second from left.
	contextStatusItem = vscode.window.createStatusBarItem('minicode.context', vscode.StatusBarAlignment.Left, 49);
	contextStatusItem.name = 'Minicode Agent Context';
	contextStatusItem.command = 'minicode.context.status';
	contextStatusItem.accessibilityInformation = {
		label: 'Agent 上下文状态',
	};

	// Last route — third from left.
	routeStatusItem = vscode.window.createStatusBarItem('minicode.route', vscode.StatusBarAlignment.Left, 48);
	routeStatusItem.name = 'Minicode Last Route';
	routeStatusItem.command = 'minicode.router.repeatLast';
	routeStatusItem.accessibilityInformation = {
		label: '上次智能路由',
	};

	context.subscriptions.push(
		brandStatusItem,
		contextStatusItem,
		routeStatusItem,
		onContextChanged(() => updateStatusBar()),
		onMinicodeEvent(e => {
			if (e.type === 'router.executed'
				|| e.type === 'file.focused'
				|| e.type === 'learning.recorded'
				|| e.type === 'context.changed'
				|| e.type === 'agent.stateChanged') {
				updateStatusBar();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatusBar()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('minicode.features')) {
				updateStatusBar();
			}
		}),
	);

	// Initial update after a short delay (wait for context warmup).
	const initTimer = setTimeout(() => updateStatusBar(), 1500);
	context.subscriptions.push({ dispose: () => clearTimeout(initTimer) });

	// Periodic refresh for live brand dot state.
	brandRefreshInterval = setInterval(() => updateStatusBar(), 30000);
	context.subscriptions.push({
		dispose: () => {
			if (brandRefreshInterval) {
				clearInterval(brandRefreshInterval);
				brandRefreshInterval = undefined;
			}
		},
	});
}
