/*---------------------------------------------------------------------------------------------
 *  统一 Agent OS 路由 — 自动选 Spec / Plan / Agent / Ask（大厂智能分发）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { emitKodrixEvent } from '../context/kodrixEventBus';
import { listSpecSlugs } from '../spec/specHelpers';
import { logger } from '../logger';

export type RouteTarget = 'spec' | 'plan' | 'agent' | 'ask' | 'terminal' | 'wiki' | 'checkpoint' | 'models' | 'settings';

export type RouteConfidence = 'high' | 'medium' | 'low';

export interface RouteResult {
	target: RouteTarget;
	reason: string;
	confidence: RouteConfidence;
}

export interface LastRouteRecord {
	target: RouteTarget;
	prompt: string;
	reason: string;
	confidence: RouteConfidence;
	timestamp: string;
}

const LAST_ROUTE_KEY = 'kodrix.router.lastRoute';

const SPEC_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /@spec|spec\s*驱动|三件套|requirements\.md/i, weight: 3 },
	{ pattern: /需求.*设计.*任务|按.*spec|实施.*spec/i, weight: 2 },
	{ pattern: /用户故事|EARS|验收标准/, weight: 1 },
];

const PLAN_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /\/plan\b/i, weight: 3 },
	{ pattern: /重构|迁移|架构|设计方案|技术方案/, weight: 2 },
	{ pattern: /复杂|大型|多模块|跨.*文件/, weight: 1 },
	{ pattern: /先.*规划|审阅.*方案/, weight: 1 },
];

const AGENT_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /审查|review|code.?review|PR|pull request|代码审查/i, weight: 3 },
	{ pattern: /测试|test|单元测试|集成测试|e2e|coverage/i, weight: 2 },
	{ pattern: /修复|fix|bug|debug|调试|报错|异常/i, weight: 2 },
	{ pattern: /部署|deploy|发布|release|ci\/cd|docker/i, weight: 2 },
	{ pattern: /实现|implement|添加|add|编写|写.*功能/i, weight: 1 },
];

const ASK_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /^(什么是|为什么|怎么|如何|解释|说明|哪里|哪个)/, weight: 2 },
	{ pattern: /\?$|？$/, weight: 1 },
	{ pattern: /什么意思|是什么|有什么区别/, weight: 1 },
	{ pattern: /文档|doc|注释|README|readme/i, weight: 2 },
];

const TERMINAL_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /终端|命令|运行|执行|terminal|command|run/i, weight: 2 },
];

const WIKI_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /wiki|文档|项目结构|架构|documentation|architecture/i, weight: 2 },
];

const CHECKPOINT_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /检查点|回滚|快照|checkpoint|rollback|snapshot/i, weight: 2 },
];

const MODELS_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /模型|供应商|model|provider|byok/i, weight: 2 },
];

const SETTINGS_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
	{ pattern: /设置|配置|偏好|settings|config|preference/i, weight: 2 },
];

function scorePatterns(text: string, patterns: Array<{ pattern: RegExp; weight: number }>): number {
	return patterns.reduce((sum, { pattern, weight }) => sum + (pattern.test(text) ? weight : 0), 0);
}

function confidenceFromScore(score: number): RouteConfidence {
	if (score >= 3) {
		return 'high';
	}
	if (score >= 2) {
		return 'medium';
	}
	return 'low';
}

export function classifyIntent(prompt: string): RouteResult {
	const text = prompt.trim();
	if (!text) {
		return { target: 'agent', reason: l10n.t('empty input defaults to Agent mode'), confidence: 'low' };
	}

	const scores: Array<{ target: RouteTarget; score: number; reason: string }> = [
		{ target: 'spec', score: scorePatterns(text, SPEC_PATTERNS), reason: l10n.t('Spec-driven / Kiro trio') },
		{ target: 'plan', score: scorePatterns(text, PLAN_PATTERNS), reason: l10n.t('complex feature / needs planning first') },
		{ target: 'agent', score: scorePatterns(text, AGENT_PATTERNS), reason: l10n.t('implement / review / test / fix') },
		{ target: 'ask', score: scorePatterns(text, ASK_PATTERNS), reason: l10n.t('Q&A / exploration / docs') },
		{ target: 'terminal', score: scorePatterns(text, TERMINAL_PATTERNS), reason: l10n.t('terminal / command / run') },
		{ target: 'wiki', score: scorePatterns(text, WIKI_PATTERNS), reason: l10n.t('wiki / docs / architecture') },
		{ target: 'checkpoint', score: scorePatterns(text, CHECKPOINT_PATTERNS), reason: l10n.t('checkpoint / rollback / snapshot') },
		{ target: 'models', score: scorePatterns(text, MODELS_PATTERNS), reason: l10n.t('models / providers') },
		{ target: 'settings', score: scorePatterns(text, SETTINGS_PATTERNS), reason: l10n.t('settings / configuration / preferences') },
	];

	scores.sort((a, b) => b.score - a.score);
	const best = scores[0];
	const second = scores[1];

	// agent vs ask：文档类短问句优先 ask
	if (best.target === 'agent' && second?.target === 'ask' && second.score >= 2 && text.length < 120) {
		if (/文档|doc|README|解释|说明|什么|如何|为什么/.test(text)) {
			return {
				target: 'ask',
				reason: l10n.t('short documentation / exploration question'),
				confidence: confidenceFromScore(second.score),
			};
		}
	}

	if (best.score >= 2) {
		return {
			target: best.target,
			reason: l10n.t('Detected: {0}', best.reason),
			confidence: confidenceFromScore(best.score),
		};
	}

	if (ASK_PATTERNS.some(p => p.pattern.test(text)) && text.length < 200) {
		return { target: 'ask', reason: l10n.t('short Q&A request'), confidence: 'medium' };
	}

	return { target: 'agent', reason: l10n.t('default multi-file Agent implementation'), confidence: 'medium' };
}

let extensionContext: vscode.ExtensionContext | undefined;

export function getLastRoute(): LastRouteRecord | undefined {
	return extensionContext?.workspaceState.get<LastRouteRecord>(LAST_ROUTE_KEY);
}

async function persistLastRoute(route: RouteResult, prompt: string): Promise<void> {
	if (!extensionContext) {
		return;
	}
	const record: LastRouteRecord = {
		target: route.target,
		prompt: prompt.slice(0, 200),
		reason: route.reason,
		confidence: route.confidence,
		timestamp: new Date().toISOString(),
	};
	await extensionContext.workspaceState.update(LAST_ROUTE_KEY, record);
	emitKodrixEvent({
		type: 'router.executed',
		target: route.target,
		prompt: record.prompt,
		confidence: route.confidence,
	});
}

export async function routeAgentPrompt(prompt?: string, options?: { silent?: boolean }): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('agentRouter', true);
	if (!enabled) {
		vscode.window.showWarningMessage(l10n.t('Smart Routing is off. Enable kodrix.features.agentRouter in settings'));
		return;
	}

	const input = prompt || await vscode.window.showInputBox({
		prompt: l10n.t('Describe your requirement (it will be routed to the best mode automatically)'),
		placeHolder: l10n.t('Build a todo app with React / Review a PR / Write unit tests / Refactor the auth module'),
	});
	if (!input?.trim()) {
		return;
	}

	const route = classifyIntent(input);
	const autoExecute = vscode.workspace.getConfiguration('kodrix.router').get<boolean>('autoExecute', true);
	const shouldAutoRun = autoExecute && route.confidence === 'high' && !options?.silent;

	if (shouldAutoRun) {
		await persistLastRoute(route, input);
		await executeRoute(route.target, input);
		vscode.window.setStatusBarMessage(
			`$(hubot) Agent OS → ${route.target.toUpperCase()}（${route.reason}）`,
			4000,
		);
		return;
	}

	// 按钮文案与比较值同源（避免日后接入 l10n 后译文导致 `===` 永不成立、按钮点了没反应）
	const executeLabel = l10n.t('Run');
	const switchLabel = l10n.t('Switch Mode');
	const cancelLabel = l10n.t('Cancel');
	const choice = await vscode.window.showInformationMessage(
		l10n.t('Agent OS route → {0} ({1} · {2})', route.target.toUpperCase(), route.reason, String(route.confidence)),
		executeLabel, switchLabel, cancelLabel,
	);
	if (choice === cancelLabel || !choice) {
		return;
	}
	if (choice === switchLabel) {
		const picked = await vscode.window.showQuickPick(
			(['spec', 'plan', 'agent', 'ask', 'terminal', 'wiki', 'checkpoint', 'models', 'settings'] as RouteTarget[]).map(t => ({ label: t.toUpperCase(), target: t })),
			{ placeHolder: l10n.t('Manually select mode') },
		);
		if (picked) {
			await persistLastRoute({ ...route, target: picked.target }, input);
			await executeRoute(picked.target, input);
		}
		return;
	}
	await persistLastRoute(route, input);
	await executeRoute(route.target, input);
}

export async function executeRoute(target: RouteTarget, prompt: string): Promise<void> {
	try {
		switch (target) {
			case 'spec': {
				if (listSpecSlugs().length > 0) {
					await vscode.commands.executeCommand('kodrix.spec.openWorkbench');
					await vscode.commands.executeCommand('workbench.action.chat.open', {
						mode: 'agent',
						query: `按 Spec 实施：${prompt}`,
						isPartialQuery: false,
					});
				} else {
					await vscode.commands.executeCommand('kodrix.spec.create');
				}
				break;
			}
			case 'plan':
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query: `/plan ${prompt}`,
					isPartialQuery: false,
				});
				break;
			case 'ask':
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					mode: 'ask',
					query: prompt,
					isPartialQuery: false,
				});
				break;
			case 'terminal':
				await vscode.commands.executeCommand('kodrix.terminal.aiPrompt');
				break;
			case 'wiki':
				await vscode.commands.executeCommand('kodrix.wiki.generate');
				break;
			case 'checkpoint':
				await vscode.commands.executeCommand('kodrix.checkpoint.list');
				break;
			case 'models':
				await vscode.commands.executeCommand('kodrix.modelRouter.status');
				break;
			case 'settings':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'kodrix.');
				break;
			case 'agent':
			default:
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					mode: 'agent',
					query: prompt,
					isPartialQuery: false,
				});
				break;
		}
	} catch (err) {
		logger.error(`[AgentRouter] executeRoute(${target}) failed`, err);
		vscode.window.showWarningMessage(l10n.t('Route execution failed ({0}): {1}', target, err instanceof Error ? err.message : l10n.t('unknown error')));
	}
}

/**
 * Hub / 快捷入口：分类 + 记录路由历史 + 立即执行。
 *
 * 注意：此函数**有意**始终执行，不做置信度门控——它由 Hub 快速输入等用户显式触发的
 * 场景调用（用户已确认要执行）。需要「低置信度时二次确认」的交互式路径请用
 * `routeAgentPrompt`（受 `kodrix.router.autoExecute` + confidence 控制）。
 */
export async function routeAndExecute(prompt: string): Promise<RouteResult> {
	const route = classifyIntent(prompt);
	await persistLastRoute(route, prompt);
	await executeRoute(route.target, prompt);
	return route;
}

export function registerRouter(context: vscode.ExtensionContext): void {
	extensionContext = context;
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.router.route', () => routeAgentPrompt()),
		vscode.commands.registerCommand('kodrix.router.execute', (target: RouteTarget, prompt: string) => executeRoute(target, prompt)),
		vscode.commands.registerCommand('kodrix.router.repeatLast', async () => {
			const last = getLastRoute();
			if (!last) {
				vscode.window.showInformationMessage(l10n.t('No routing history — use `Kodrix: Smart Route` to get started'));
				return;
			}
			await executeRoute(last.target, last.prompt);
		}),
	);
}
