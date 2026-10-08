/*---------------------------------------------------------------------------------------------
 *  Agent OS 状态栏 — 品牌指示器 + 上下文就绪 + 主动感知 + 路由历史
 *  （Windsurf / Cursor 大厂思维 · Kodrix 品牌升级版）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { getContextStatus } from '../context/contextIntelligence';
import { onContextChanged } from '../context/contextEvents';
import { onKodrixEvent } from '../context/kodrixEventBus';
import { getLastFileContextHint } from '../context/proactiveContext';
import { getLastRoute } from '../router/agentRouter';

let brandStatusItem: vscode.StatusBarItem | undefined;
let contextStatusItem: vscode.StatusBarItem | undefined;
let routeStatusItem: vscode.StatusBarItem | undefined;

const TARGET_LABEL: Record<string, string> = {
	spec: 'Spec',
	plan: 'Plan',
	agent: 'Agent',
	ask: 'Ask',
};

/**
 * Brand colour palette — mirrors the CSS `--kodrix-brand-*` tokens defined
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
			label: 'Kodrix',
		};
	}

	if (status.wikiOk && status.learningCount > 0) {
		return {
			level: 'ready',
			dotColor: BRAND.success,
			labelColor: undefined,
			icon: 'pass-filled',
			label: 'Kodrix',
		};
	}

	if (status.wikiOk || status.memoryCount > 0) {
		return {
			level: 'partial',
			dotColor: BRAND.primary,
			labelColor: undefined,
			icon: 'sync',
			label: 'Kodrix',
		};
	}

	// Fallback — context exists but not yet fully ready.
	return {
		level: 'partial',
		dotColor: BRAND.warning,
		labelColor: undefined,
		icon: 'circle-outline',
		label: 'Kodrix',
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

	brandStatusItem.text = `$(${brandState.icon}) ${dotGlyph} Kodrix`;
	brandStatusItem.color = brandState.dotColor;

	const statusParts: string[] = [];
	if (status.wikiOk) {statusParts.push(l10n.t('Wiki ready'));}
	if (status.memoryCount > 0) {statusParts.push(l10n.t('Memory: {0} entries', status.memoryCount));}
	if (status.learningCount > 0) {statusParts.push(l10n.t('Learning: {0} entries', status.learningCount));}
	if (status.semanticVectors > 0) {statusParts.push(l10n.t('Semantic index {0} vectors', status.semanticVectors));}

	brandStatusItem.tooltip = new vscode.MarkdownString(
		l10n.t('### $(hubot) Kodrix Agent OS Command Center') + '\n\n'
		+ (statusParts.length
			? statusParts.map(p => `- ${p}`).join('\n') + '\n\n'
			: l10n.t('*(Not initialized)* Run **Kodrix: Generate Repo Wiki** to get started.') + '\n\n')
		+ l10n.t('[Open Hub](command:kodrix.hub.open) · `Ctrl+Shift+H`')
		+ l10n.t('  \n[Refresh Context](command:kodrix.context.refresh)'),
	);
	brandStatusItem.backgroundColor = brandState.level === 'ready'
		? new vscode.ThemeColor('statusBarItem.prominentBackground')
		: undefined;
	brandStatusItem.show();

	// ── Context + proactive hint ──
	const level = brandState.level;
	const levelLabel = level === 'ready' ? l10n.t('Context ready')
		: level === 'partial' ? l10n.t('Context section')
		: level === 'error' ? l10n.t('Context error')
		: l10n.t('Pending warm-up');
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
		l10n.t('**Agent Context Intelligence**'),
		'',
		l10n.t('{0} — Wiki + Memory + Learning + Semantic', levelLabel),
	];
	if (fileHint?.relevantCount) {
		tooltipLines.push('', l10n.t('**Memories related to the current file** ({0})', fileHint.fileName));
		tooltipLines.push(l10n.t('- {0} matches', fileHint.relevantCount));
		if (fileHint.topMatch) {
			tooltipLines.push(`- ${fileHint.topMatch}…`);
		}
	}
	tooltipLines.push('', l10n.t('Refresh: `Kodrix: Refresh Agent Context`'));
	contextStatusItem.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
	contextStatusItem.show();

	// ── Last route ──
	if (routeStatusItem) {
		if (lastRoute) {
			const label = TARGET_LABEL[lastRoute.target] ?? lastRoute.target;
			routeStatusItem.text = `$(arrow-swap) ${label}`;
			routeStatusItem.tooltip = new vscode.MarkdownString(
				l10n.t('**Last Smart Routing**') + '\n\n'
				+ l10n.t('- Mode: **{0}**', label) + '\n'
				+ l10n.t('- Reason: {0}', lastRoute.reason) + '\n'
				+ l10n.t('- Input: {0}…', lastRoute.prompt.slice(0, 80)) + '\n\n'
				+ l10n.t('Click to repeat the last routing · `Kodrix: Repeat Last Routing`'),
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
	// Brand indicator — leftmost, anchors the Kodrix identity.
	brandStatusItem = vscode.window.createStatusBarItem('kodrix.brand', vscode.StatusBarAlignment.Left, 50);
	brandStatusItem.name = 'Kodrix';
	brandStatusItem.command = 'kodrix.hub.open';
	brandStatusItem.accessibilityInformation = {
		label: l10n.t('Kodrix — Open Agent Command Center'),
	};

	// Context readiness — second from left.
	contextStatusItem = vscode.window.createStatusBarItem('kodrix.context', vscode.StatusBarAlignment.Left, 49);
	contextStatusItem.name = 'Kodrix Agent Context';
	contextStatusItem.command = 'kodrix.context.status';
	contextStatusItem.accessibilityInformation = {
		label: l10n.t('Agent Context Status'),
	};

	// Last route — third from left.
	routeStatusItem = vscode.window.createStatusBarItem('kodrix.route', vscode.StatusBarAlignment.Left, 48);
	routeStatusItem.name = 'Kodrix Last Route';
	routeStatusItem.command = 'kodrix.router.repeatLast';
	routeStatusItem.accessibilityInformation = {
		label: l10n.t('Last smart route'),
	};

	context.subscriptions.push(
		brandStatusItem,
		contextStatusItem,
		routeStatusItem,
		onContextChanged(() => updateStatusBar()),
		onKodrixEvent(e => {
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
			if (e.affectsConfiguration('kodrix.features')) {
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
