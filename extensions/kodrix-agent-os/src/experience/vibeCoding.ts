/*---------------------------------------------------------------------------------------------
 *  Vibe Coding 3.0 — 想法驱动的开发入口（超越 Windsurf Cascade + Lovable + Bolt.new）
 *
 *  大厂参考：Windsurf Cascade · Lovable "vibe to app" · Bolt.new · v0 · Claude Code
 *  核心升级：复杂想法自动路由到 Idea Flow（全自动流水线），简单需求走快捷路径
 *
 *  让软件开发回归想法本身 — 用户只需描述「做什么」，AI 负责「怎么做」
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { classifyIntent } from '../router/agentRouter';
import {
	startIterationSession,
	recordIteration,
	rollbackToIteration,
	getIterationSummary,
	getIterationCount,
	endIterationSession,
} from './vibeIteration';

/**
 * Vibe Coding 3.0 入口：智能判断使用快捷路径还是完整 Idea Flow
 *
 * 路由逻辑：
 * - 复杂 / 模糊 / 多功能的描述 → Idea Flow（全自动分析→规划→构建→预览）
 * - 简单 / 明确的需求 → Spec / Agent 快捷路径
 */
export async function vibeCode(prompt?: string): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('vibeCoding', true);
	if (!enabled) {
		vscode.window.showWarningMessage(l10n.t('Vibe Coding 已关闭。可在设置中启用 kodrix.features.vibeCoding'));
		return;
	}

	const input = prompt || await vscode.window.showInputBox({
		prompt: l10n.t('描述你想要的应用，AI 全自动构建 — 复杂想法走 Idea Flow，简单需求走快捷路径'),
		placeHolder: l10n.t('一个带暗色模式的个人博客，支持 Markdown / 一个 AI 知识管理工具 / 一个 Trello 看板'),
		ignoreFocusOut: true,
	});

	if (!input?.trim()) return;

	// Check if Idea Flow should be used (complex/multi-feature descriptions)
	const shouldUseIdeaFlow = shouldUseFullPipeline(input);

	if (shouldUseIdeaFlow && vscode.workspace.getConfiguration('kodrix.features').get<boolean>('ideaFlow', true)) {
		// Route to full Idea Flow pipeline — pass prompt directly to avoid double-input
		await vscode.commands.executeCommand('kodrix.idea.start', input);
		vscode.window.showInformationMessage(l10n.t('Vibe Coding 检测到复杂项目需求，已切换到 Idea Flow 全自动流水线'));
		return;
	}

	const route = classifyIntent(input);

	// Build vibe context
	const vibeContext = `[Vibe Coding Mode — 让想法回归本质]
你正处于 Vibe Coding 模式 — 用户通过自然语言描述了想要的应用。
核心理念：软件开发回归想法本身。用户只需描述「做什么」，你来负责「怎么做」。

原则：
- 快速原型优先，先做出能跑的 MVP
- 保持技术栈简洁（React/Vite 或 Vue/Vite 作为默认前端）
- 使用现代 UI（Tailwind CSS 或 shadcn/ui 风格）
- 包含基础交互和美观的设计
- 生成完整的、可直接运行的项目

用户需求：${input}`;

	if (route.target === 'spec') {
		await vscode.commands.executeCommand('kodrix.spec.create');
		vscode.window.showInformationMessage(l10n.t('Vibe Coding → 请在 Spec 中定义需求，完成后实施'));
	} else {
		await runAgentWithIterationLoop(input, vibeContext);
	}
}

/**
 * 判断是否应该使用完整的 Idea Flow 流水线
 * 复杂/模糊/多功能描述走完整流水线，简单的走快捷路径
 */
function shouldUseFullPipeline(input: string): boolean {
	const lower = input.toLowerCase();

	// 复杂度指标：功能数量、描述长度、专用关键词
	const featureCount = countFeatures(lower);
	const isLongDescription = input.length > 60;
	const hasComplexKeywords = /系统|platform|管理|engine|full|complete|复杂|集成|enterprise|微服务|microservice|多用户|multi/i.test(lower);

	// 走完整流水线的条件
	if (featureCount >= 3 && isLongDescription) return true;
	if (hasComplexKeywords && isLongDescription) return true;
	if (featureCount >= 4) return true;
	if (input.length > 120) return true;

	return false;
}

/**
 * Agent 模式 + Checkpoint 迭代循环。
 *
 * 流程：
 *   1. 开启迭代会话 → 创建初始 Checkpoint → 发送 prompt 到 Agent
 *   2. Agent 完成后展示 QuickPick：继续迭代 / 回退 / 完成
 *   3. 循环直到用户选择「完成」或取消
 */
async function runAgentWithIterationLoop(originalInput: string, initialContext: string): Promise<void> {
	const sessionId = startIterationSession(originalInput);

	// 初始 Checkpoint（Agent 执行前快照）
	await recordIteration(sessionId, l10n.t('初始版本'));

	// 首次发送到 Agent
	await vscode.commands.executeCommand('workbench.action.chat.open', {
		mode: 'agent',
		query: initialContext,
		isPartialQuery: false,
	});
	vscode.window.showInformationMessage(l10n.t('Vibe Coding → Agent 模式已就绪'));

	// 迭代循环
	let iterating = true;
	while (iterating) {
		const action = await vscode.window.showQuickPick(
			[
				{ label: '$(edit) ' + l10n.t('继续迭代'), description: l10n.t('提供反馈继续修改'), value: 'continue' },
				{ label: '$(history) ' + l10n.t('回退到上一版本'), description: l10n.t('恢复到上一个 Checkpoint'), value: 'rollback' },
				{ label: '$(check) ' + l10n.t('完成'), description: l10n.t('对结果满意，结束迭代'), value: 'done' },
			],
			{ placeHolder: l10n.t('Vibe Coding 迭代'), ignoreFocusOut: true },
		);

		if (!action) {
			// 用户按 Esc 取消 → 视为完成
			iterating = false;
			break;
		}

		const value = (action as { value: string }).value;

		if (value === 'continue') {
			const feedback = await vscode.window.showInputBox({
				prompt: l10n.t('描述你希望修改的内容'),
				placeHolder: l10n.t('例如：把导航栏改成侧边栏 / 增加一个搜索框'),
				ignoreFocusOut: true,
			});
			if (!feedback?.trim()) {
				continue;
			}

			// 记录迭代（自动创建 Checkpoint）
			await recordIteration(sessionId, feedback, feedback);

			// 构建迭代上下文并发送到 Agent
			const iterContext = `[Vibe Coding 迭代 #${getIterationCount(sessionId)}]
原始需求：${originalInput}
本轮反馈：${feedback}

请根据反馈继续修改，保持已有功能不被破坏。`;

			await vscode.commands.executeCommand('workbench.action.chat.open', {
				mode: 'agent',
				query: iterContext,
				isPartialQuery: false,
			});

		} else if (value === 'rollback') {
			const count = getIterationCount(sessionId);
			if (count <= 1) {
				vscode.window.showInformationMessage(l10n.t('当前仅有初始版本，无法回退'));
				continue;
			}

			const summary = getIterationSummary(sessionId);
			const target = await vscode.window.showQuickPick(
				Array.from({ length: count }, (_, i) => {
					const num = count - i; // 从新到旧
					return {
						label: `#${num}`,
						description: num === 1 ? l10n.t('初始版本') : l10n.t('迭代 #{0}', num),
						value: num,
					};
				}),
				{
					placeHolder: l10n.t('选择要回退到的版本'),
					title: l10n.t('迭代历史\n{0}', summary ?? ''),
				},
			);

			if (!target) {
				continue;
			}

			const targetNum = (target as { value: number }).value;
			const ok = await rollbackToIteration(sessionId, targetNum);
			if (ok) {
				vscode.window.showInformationMessage(l10n.t('已回退到迭代 #{0}', targetNum));
			} else {
				vscode.window.showErrorMessage(l10n.t('回退失败，请检查检查点完整性'));
			}

		} else {
			// done
			iterating = false;
		}
	}

	const totalIterations = getIterationCount(sessionId);
	endIterationSession(sessionId);
	vscode.window.showInformationMessage(l10n.t('Vibe Coding 会话结束，共 {0} 次迭代', totalIterations));
}

function countFeatures(text: string): number {
	const indicators = [/支持|support|with|and/, /功能|feature|ability/, /可以|able to|allow/, /管理|manage|track/, /创建|create|generate/];
	let count = 0;
	for (const re of indicators) {
		const matches = text.match(re);
		if (matches) count += matches.length;
	}
	return Math.ceil(count / 2);
}

/**
 * 快捷 Vibe：直接在状态栏 / Hub 中一键启动
 */
export async function quickVibe(): Promise<void> {
	const lastPrompt = await vscode.window.showQuickPick(
		[
			{ label: '个人网站/博客', description: 'React + Vite + Tailwind', prompt: '一个带暗色模式的个人博客网站，支持 Markdown 文章' },
			{ label: '任务看板', description: 'React + DnD + 拖拽', prompt: '一个 Trello 风格的任务看板，支持拖拽和状态切换' },
			{ label: 'AI 聊天界面', description: 'React + 流式响应', prompt: '一个 ChatGPT 风格的 AI 聊天界面，支持流式输出和会话管理' },
			{ label: '电商产品页', description: 'React + 购物车', prompt: '一个精美的电商产品展示页，带购物车和搜索过滤' },
			{ label: '数据仪表盘', description: 'React + Recharts', prompt: '一个数据分析仪表盘，包含折线图、饼图和统计卡片' },
			{ label: '$(edit) 自定义...', description: '输入你自己的描述', prompt: '' },
		],
		{ placeHolder: l10n.t('选择一个 Vibe 模板，或自定义描述…') },
	);

	if (!lastPrompt) return;

	if (lastPrompt.prompt) {
		await vibeCode(lastPrompt.prompt);
	} else {
		await vibeCode();
	}
}

export function registerVibeCoding(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.vibe.start', () => vibeCode()),
		vscode.commands.registerCommand('kodrix.vibe.quick', () => quickVibe()),
	);
}
