/*---------------------------------------------------------------------------------------------
 *  统一 Agent OS 路由 — 自动选 Spec / Plan / Agent / Ask（大厂智能分发）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { emitKodrixEvent } from '../context/kodrixEventBus';
import { listSpecSlugs } from '../spec/specHelpers';
import { logger } from '../logger';

export type RouteTarget = 'spec' | 'plan' | 'agent' | 'ask';

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
		return { target: 'agent', reason: '空输入默认 Agent 模式', confidence: 'low' };
	}

	const scores: Array<{ target: RouteTarget; score: number; reason: string }> = [
		{ target: 'spec', score: scorePatterns(text, SPEC_PATTERNS), reason: 'Spec 驱动 / Kiro 三件套' },
		{ target: 'plan', score: scorePatterns(text, PLAN_PATTERNS), reason: '复杂功能 / 需先规划' },
		{ target: 'agent', score: scorePatterns(text, AGENT_PATTERNS), reason: '实施 / 审查 / 测试 / 修复' },
		{ target: 'ask', score: scorePatterns(text, ASK_PATTERNS), reason: '问答 / 探索 / 文档' },
	];

	scores.sort((a, b) => b.score - a.score);
	const best = scores[0];
	const second = scores[1];

	// agent vs ask：文档类短问句优先 ask
	if (best.target === 'agent' && second?.target === 'ask' && second.score >= 2 && text.length < 120) {
		if (/文档|doc|README|解释|说明|什么|如何|为什么/.test(text)) {
			return {
				target: 'ask',
				reason: '文档 / 探索类短问句',
				confidence: confidenceFromScore(second.score),
			};
		}
	}

	if (best.score >= 2) {
		return {
			target: best.target,
			reason: `检测到${best.reason}`,
			confidence: confidenceFromScore(best.score),
		};
	}

	if (ASK_PATTERNS.some(p => p.pattern.test(text)) && text.length < 200) {
		return { target: 'ask', reason: '短问答请求', confidence: 'medium' };
	}

	return { target: 'agent', reason: '默认多文件 Agent 实施', confidence: 'medium' };
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
		vscode.window.showWarningMessage('智能路由已关闭。可在设置中启用 kodrix.features.agentRouter');
		return;
	}

	const input = prompt || await vscode.window.showInputBox({
		prompt: '描述你的需求（将自动路由到最佳模式）',
		placeHolder: '用 React 做一个待办应用 / 审查 PR / 写单元测试 / 重构 auth 模块',
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

	const choice = await vscode.window.showInformationMessage(
		`Agent OS 路由 → ${route.target.toUpperCase()}（${route.reason} · ${route.confidence}）`,
		'执行', '切换模式', '取消',
	);
	if (choice === '取消' || !choice) {
		return;
	}
	if (choice === '切换模式') {
		const picked = await vscode.window.showQuickPick(
			(['spec', 'plan', 'agent', 'ask'] as RouteTarget[]).map(t => ({ label: t.toUpperCase(), target: t })),
			{ placeHolder: '手动选择模式' },
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
		vscode.window.showWarningMessage(`路由执行失败（${target}）：${err instanceof Error ? err.message : '未知错误'}`);
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
				vscode.window.showInformationMessage('尚无路由历史 — 使用 `Kodrix: 智能路由` 开始');
				return;
			}
			await executeRoute(last.target, last.prompt);
		}),
	);
}
