/*---------------------------------------------------------------------------------------------
 *  SOLO Builder Chat Participant — Trae 风格分步构建
 *
 *  大厂工程化标准：
 *   1. 所有常量来自 constants.ts，无本地重复定义
 *   2. request.model 可能为 undefined，需要防守性检查
 *   3. formatTemplatesList 基于文件 mtime 缓存，避免返回过期数据
 *   4. plan 结尾逻辑抽取为 finalizePlan，消除重复
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { persistSoloPlan, resolveSoloBuildContext } from './soloPlan';
import { scheduleSoloPreview } from './soloPreview';
import { beginBuildTracking } from './soloBuildTracker';
import { notifySoloPlanUpdated } from './soloWorkbench';
import { loadTemplates, SoloTemplate } from './soloTemplates';
import { logger } from './logger';
import {
	COMMANDS,
	CONFIG_SOLO,
	SOLO_CONFIG,
	BUILD_CONFIRM_RE,
	CHAT_PARTICIPANT_ID,
} from './constants';

// ── 缓存管理 ────────────────────────────────────────────────────────

let _cachedTemplatesFormat: string | undefined;
let _cachedTemplatesMtime: number = 0;

/**
 * 格式化模板列表为 Markdown，带文件 mtime 缓存自动失效。
 * 模板文件在扩展生命周期内一般不变，但用户可能手动更新模板目录。
 */
function formatTemplatesList(templates: SoloTemplate[], extensionPath: string): string {
	const templatesPath = path.join(extensionPath, 'resources', 'templates.json');
	try {
		const mtime = fs.existsSync(templatesPath) ? fs.statSync(templatesPath).mtimeMs : 0;
		if (mtime !== _cachedTemplatesMtime) {
			_cachedTemplatesFormat = templates.map(t =>
				`- **${t.id}**: ${t.name} — ${t.description}（${t.category}）`,
			).join('\n');
			_cachedTemplatesMtime = mtime;
		}
	} catch {
		// 无法读取 mtime 时退化：每次重新生成
		_cachedTemplatesFormat = templates.map(t =>
			`- **${t.id}**: ${t.name} — ${t.description}（${t.category}）`,
		).join('\n');
	}
	return _cachedTemplatesFormat!;
}

// ── 系统提示 ────────────────────────────────────────────────────────

function loadSystemPrompt(extensionPath: string): string {
	const p = path.join(extensionPath, 'resources', 'solo-system-prompt.md');
	try {
		return fs.readFileSync(p, 'utf-8');
	} catch {
		logger.warn('SOLO system prompt not found, using fallback');
		return `你是一个 SOLO Builder，擅长根据需求生成项目规划与技术选型。
请按以下步骤执行：
1. 分析需求，选择技术栈
2. 输出目录结构与文件清单
3. 等待用户确认后执行构建`;
	}
}

// ── LLM 流式响应 ────────────────────────────────────────────────────

async function streamModelResponse(
	request: vscode.ChatRequest,
	stream: vscode.ChatResponseStream,
	systemPrompt: string,
	userPrompt: string,
	token: vscode.CancellationToken,
): Promise<string> {
	if (!request.model) {
		stream.markdown('⚠️ 未选择语言模型，请在 Chat 面板中选择一个模型。');
		return '';
	}

	const messages = [
		vscode.LanguageModelChatMessage.User(`[System]\n${systemPrompt}`),
		vscode.LanguageModelChatMessage.User(userPrompt),
	];
	let full = '';
	try {
		const response = await request.model.sendRequest(messages, {}, token);
		for await (const chunk of response.stream) {
			if (token.isCancellationRequested) break;
			if (chunk instanceof vscode.LanguageModelTextPart) {
				full += chunk.value;
				stream.markdown(chunk.value);
			}
		}
	} catch (err) {
		logger.error('SOLO: streamModelResponse failed', err);
		stream.markdown(`\n\n⚠️ 流式响应出错：${err instanceof Error ? err.message : String(err)}`);
	}
	return full;
}

// ── Agent 构建委托 ──────────────────────────────────────────────────

async function delegateToAgentBuild(prompt: string, extensionPath: string, context: vscode.ExtensionContext): Promise<void> {
	beginBuildTracking(context);
	const previewNote = '\n\n构建完成后请运行 dev server（如 npm run dev），以便用户在 SOLO 工作台预览面板验证。';
	await vscode.commands.executeCommand(COMMANDS.chatOpen, {
		mode: 'agent',
		query: prompt + previewNote,
		isPartialQuery: false,
	});
	await scheduleSoloPreview(extensionPath, prompt);
}

// ── 规划收尾 ────────────────────────────────────────────────────────

/** 保存规划 + 通知工作台 + 写入提示文本（消除 plan 分支和 default 分支的重复） */
function finalizePlan(planText: string, userPrompt: string, stream: vscode.ChatResponseStream): void {
	persistSoloPlan(planText, userPrompt);
	notifySoloPlanUpdated();
	stream.markdown('\n\n---\n*规划已保存至 `.minicode/solo/last-plan.md`，SOLO 工作台已同步。请回复 **确认构建** 或 `@solo /build`。*');
}

// ── 注册 ────────────────────────────────────────────────────────────

export function registerSoloParticipant(
	context: vscode.ExtensionContext,
): void {
	const systemPrompt = loadSystemPrompt(context.extensionPath);
	const templates = loadTemplates(context.extensionPath);
	const templatesList = formatTemplatesList(templates, context.extensionPath);

	const participant = vscode.chat.createChatParticipant(
		CHAT_PARTICIPANT_ID,
		async (request, _chatContext, stream, token) => {
			const cmd = request.command;
			const autoApply = vscode.workspace.getConfiguration(CONFIG_SOLO)
				.get<boolean>(SOLO_CONFIG.autoApply, true);

			if (cmd === 'templates') {
				stream.markdown(`## 可用技术栈模板\n\n${templatesList}`);
				return;
			}

			if (cmd === 'plan') {
				const userPrompt = [
					'【规划模式】请根据以下需求输出技术选型、目录结构与文件清单。',
					'不要写入任何文件，不要执行命令。',
					`需求：\n${request.prompt}`,
					`\n可选模板：\n${templatesList}`,
				].join('\n\n');
				const planText = await streamModelResponse(request, stream, systemPrompt, userPrompt, token);
				finalizePlan(planText, request.prompt, stream);
				return;
			}

			if (cmd === 'build' || BUILD_CONFIRM_RE.test(request.prompt)) {
				const buildContext = resolveSoloBuildContext(request.prompt);
				const buildPrompt = [
					'【SOLO 构建模式】用户已确认方案。请在工作区中批量创建所有文件。',
					autoApply ? '直接应用所有文件编辑，无需逐项确认。' : '每个文件编辑后等待用户确认。',
					'完成后运行初始化命令（npm install / pip install 等）并给出启动说明。',
					`用户需求与方案：\n${buildContext}`,
				].join('\n\n');
				stream.markdown('**正在切换到 Agent 模式执行构建…**\n\n');
				await delegateToAgentBuild(buildPrompt, context.extensionPath, context);
				return;
			}

			// 默认模式：先规划
			const defaultPrompt = [
				'【SOLO 第一步：规划】',
				'请分析需求并输出技术选型 + 目录结构 + 文件清单。',
				'规划完成后提示用户回复「确认构建」或使用 /build 命令进入构建阶段。',
				`需求：\n${request.prompt}`,
				`\n内置模板参考：\n${templatesList}`,
			].join('\n\n');
			const planText = await streamModelResponse(request, stream, systemPrompt, defaultPrompt, token);
			finalizePlan(planText, request.prompt, stream);
		},
	);

	context.subscriptions.push(participant);
}
