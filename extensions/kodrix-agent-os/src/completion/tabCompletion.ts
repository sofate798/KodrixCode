/*---------------------------------------------------------------------------------------------
 *  Tab Completion — 专用 Tab 补全模型通道（对标 Cursor 的 Tab 快速补全）
 *
 *  设计：
 *    1. 默认关闭（kodrix.tabCompletion.enabled = false），避免与上游 Copilot 内联补全冲突；
 *       用户开启后由 Kodrix 提供 InlineCompletion。
 *    2. 双通道：mode=fim → 专用 FIM 端点（默认 DeepSeek FIM，填 Key 即用；可选自定义端点）；
 *       mode=fast → 通用模型通道（走模型路由 fast 档）。FIM 失败自动降级 fast。
 *    3. buildCompletionPrompt / buildFimPrompt / extractCompletion 为纯函数，便于单元测试。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { routeModel } from '../model/modelRouter';
import { recordTabSuggestion, recordTabAccept, showTabCompletionStats } from './tabCompletionStats';
import { logger } from '../logger';
import {
	TAB_COMPLETION_CONFIG,
	TAB_COMPLETION_CONFIG_KEYS,
	TAB_COMPLETION_TIMEOUT_MS,
	TAB_COMPLETION_CONTEXT_LINES,
	TAB_COMPLETION_MAX_RESULT_CHARS,
	TAB_COMPLETION_MODE_FIM,
	FIM_PROVIDER_DEEPSEEK,
	FIM_PROVIDER_CUSTOM,
	FIM_DEFAULT_ENDPOINT,
	FIM_DEFAULT_MODEL,
	FIM_SEPARATOR,
	FIM_MAX_TOKENS,
	FIM_TEMPERATURE,
} from '../shared/constants';

/** 补全上下文 */
export interface CompletionContext {
	/** 光标前文本 */
	prefix: string;
	/** 光标后文本 */
	suffix: string;
	/** 文档语言 id */
	language: string;
}

/** FIM 通道参数 */
export interface FimOptions {
	endpoint: string;
	apiKey: string;
	model: string;
	timeoutMs?: number;
}

/** 组装补全请求 prompt（纯函数，fast 通道） */
export function buildCompletionPrompt(ctx: CompletionContext, contextLines = TAB_COMPLETION_CONTEXT_LINES): string {
	const prefixTail = ctx.prefix.split('\n').slice(-contextLines).join('\n');
	const suffixHead = ctx.suffix.split('\n').slice(0, 2).join('\n');
	return [
		'你是 Kodrix Tab 补全引擎（快速模型通道，对标 Cursor Tab）。',
		'根据下方代码上下文，补全光标 <CURSOR> 处的代码。',
		'要求：只输出新增内容，不要重复已存在的代码；不要输出解释；保持语言与风格一致。',
		'```' + ctx.language,
		prefixTail,
		'<CURSOR>',
		suffixHead,
		'```',
		'补全内容：',
	].join('\n');
}

/** 组装 FIM 请求 prompt（纯函数）：prefix + 分隔标记，suffix 走独立参数 */
export function buildFimPrompt(prefix: string): string {
	return prefix.trimEnd() + FIM_SEPARATOR;
}

/** 从模型输出提取补全文本（纯函数） */
export function extractCompletion(raw: string): string {
	// 提取首个代码块内容；无代码块则用全文
	const fence = raw.match(/```[^\n]*\n([\s\S]*?)(```|$)/);
	const body = fence ? fence[1] : raw;
	// 去除行尾空格 + 首尾空白 + 若以换行开头去掉（避免吞行）
	return body
		.replace(/[ \t]+$/gm, '')
		.replace(/^\n+/, '')
		.trimEnd();
}

/**
 * FIM 通道：请求外部 FIM 端点（默认 DeepSeek，或自定义 OpenAI 兼容 completions）。
 * 无 Key / 请求失败 / 无文本返回 undefined（调用方降级）。
 */
export async function provideFimCompletion(ctx: CompletionContext, opts: FimOptions): Promise<string | undefined> {
	if (!opts.apiKey.trim() || !opts.endpoint.trim()) {
		return undefined;
	}
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? TAB_COMPLETION_TIMEOUT_MS);
	try {
		const res = await fetch(opts.endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.apiKey.trim()}`,
			},
			body: JSON.stringify({
				model: opts.model,
				prompt: buildFimPrompt(ctx.prefix),
				suffix: ctx.suffix,
				max_tokens: FIM_MAX_TOKENS,
				temperature: FIM_TEMPERATURE,
				stream: false,
				echo: false,
			}),
			signal: ac.signal,
		});
		if (!res.ok) {
			logger.warn(`[TabCompletion] FIM 端点 ${res.status}`);
			return undefined;
		}
		const data = await res.json() as { choices?: Array<{ text?: unknown }> };
		const text = data.choices?.[0]?.text;
		return typeof text === 'string' ? extractCompletion(text.slice(0, TAB_COMPLETION_MAX_RESULT_CHARS)) : undefined;
	} catch (err) {
		logger.warn('[TabCompletion] FIM 请求失败', err);
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** fast 通道：走模型路由 fast 档（原 Tab 补全逻辑） */
async function provideFastCompletion(ctx: CompletionContext): Promise<string | undefined> {
	const routed = await routeModel({ tier: 'fast' });
	if (!routed) {
		return undefined;
	}
	const cts = new vscode.CancellationTokenSource();
	const timer = setTimeout(() => cts.cancel(), TAB_COMPLETION_TIMEOUT_MS);
	try {
		const response = await routed.model.sendRequest(
			[vscode.LanguageModelChatMessage.User(buildCompletionPrompt(ctx))],
			{},
			cts.token,
		);
		let text = '';
		for await (const chunk of response.stream) {
			if (chunk instanceof vscode.LanguageModelTextPart) {
				text += chunk.value;
				if (text.length > TAB_COMPLETION_MAX_RESULT_CHARS) {
					break;
				}
			}
		}
		return extractCompletion(text.slice(0, TAB_COMPLETION_MAX_RESULT_CHARS));
	} catch (err) {
		logger.warn('[TabCompletion] 补全生成失败', err);
		return undefined;
	} finally {
		clearTimeout(timer);
		cts.dispose();
	}
}

/**
 * 生成 Tab 补全：mode=fim 且配 Key → FIM 通道（失败降级 fast）；否则 fast 通道。
 * 未启用 / 无模型 / 失败时返回 undefined（调用方静默降级）。
 */
export async function provideTabCompletion(ctx: CompletionContext): Promise<string | undefined> {
	const cfg = vscode.workspace.getConfiguration(TAB_COMPLETION_CONFIG);
	const enabled = cfg.get<boolean>(TAB_COMPLETION_CONFIG_KEYS.enabled, false);
	if (!enabled) {
		return undefined;
	}
	const mode = cfg.get<string>(TAB_COMPLETION_CONFIG_KEYS.mode, TAB_COMPLETION_MODE_FIM);
	if (mode === TAB_COMPLETION_MODE_FIM) {
		const apiKey = cfg.get<string>(TAB_COMPLETION_CONFIG_KEYS.fimApiKey, '');
		if (apiKey.trim()) {
			const provider = cfg.get<string>(TAB_COMPLETION_CONFIG_KEYS.fimProvider, FIM_PROVIDER_DEEPSEEK);
			const endpoint = provider === FIM_PROVIDER_CUSTOM
				? cfg.get<string>(TAB_COMPLETION_CONFIG_KEYS.fimEndpoint, FIM_DEFAULT_ENDPOINT)
				: FIM_DEFAULT_ENDPOINT;
			const model = cfg.get<string>(TAB_COMPLETION_CONFIG_KEYS.fimModel, FIM_DEFAULT_MODEL);
			const fim = await provideFimCompletion(ctx, { endpoint, apiKey, model });
			if (fim) {
				return fim;
			}
			logger.warn('[TabCompletion] FIM 失败或未配置，降级 fast 通道');
		}
	}
	return provideFastCompletion(ctx);
}

/** 注册 Tab 补全（InlineCompletion 提供者，默认关闭） */
export function registerTabCompletion(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			{ scheme: 'file' },
			{
				async provideInlineCompletionItems(document, position, _ctx, _token) {
					const enabled = vscode.workspace.getConfiguration(TAB_COMPLETION_CONFIG)
						.get<boolean>(TAB_COMPLETION_CONFIG_KEYS.enabled, false);
					if (!enabled) {
						return [];
					}
					const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
					const lastLine = document.lineAt(Math.max(0, document.lineCount - 1)).range.end;
					const suffix = document.getText(new vscode.Range(position, lastLine));
					const text = await provideTabCompletion({
						prefix,
						suffix,
						language: document.languageId,
					});
					if (!text) {
						return [];
					}
					const mode = vscode.workspace.getConfiguration(TAB_COMPLETION_CONFIG)
						.get<string>(TAB_COMPLETION_CONFIG_KEYS.mode, TAB_COMPLETION_MODE_FIM);
					recordTabSuggestion(mode);
					return [{
						insertText: text,
						range: new vscode.Range(position, position),
						command: { command: 'kodrix.tabCompletion.accepted', title: '补全接受' },
					}];
				},
			},
		),
		vscode.commands.registerCommand('kodrix.tabCompletion.accepted', () => {
			const mode = vscode.workspace.getConfiguration(TAB_COMPLETION_CONFIG)
				.get<string>(TAB_COMPLETION_CONFIG_KEYS.mode, TAB_COMPLETION_MODE_FIM);
			recordTabAccept(mode);
		}),
		vscode.commands.registerCommand('kodrix.tabCompletion.stats', () => showTabCompletionStats()),
	);
}
