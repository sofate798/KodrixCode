/*---------------------------------------------------------------------------------------------
 *  Tab Completion — 专用 Tab 补全模型通道（对标 Cursor 的 Tab 快速补全）
 *
 *  设计：
 *    1. 默认关闭（kodrix.tabCompletion.enabled = false），避免与上游 Copilot 内联补全冲突；
 *       用户开启后由 Kodrix 提供 InlineCompletion。
 *    2. 双通道：mode=fim → 专用 FIM 端点（端点由 kodrix.tabCompletion.fimEndpoint 配置，
 *       默认 DeepSeek FIM；kodrix.tabCompletion.fimEnabled=false 可整体禁用专线）；
 *       mode=fast → 通用模型通道（走模型路由 fast 档）。FIM 失败自动降级 fast，
 *       但失败/降级不再静默：logger 记录状态码与原因，统计（tabCompletion.stats）按
 *       实际产出通道区分并附 FIM 专线诊断。
 *    3. 端点返回 4xx（非 429）视为接口不存在，本会话内熔断该端点不再重试（日志+统计可见）。
 *    4. buildCompletionPrompt / buildFimPrompt / extractCompletion 为纯函数，便于单元测试。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { routeModel } from '../model/modelRouter';
import {
	recordTabSuggestion,
	recordTabAccept,
	showTabCompletionStats,
	recordTabFimFailure,
	recordTabFimSkip,
	flushTabCompletionStats,
} from './tabCompletionStats';
import { logger } from '../logger';
import {
	TAB_COMPLETION_CONFIG,
	TAB_COMPLETION_CONFIG_KEYS,
	TAB_COMPLETION_TIMEOUT_MS,
	TAB_COMPLETION_CONTEXT_LINES,
	TAB_COMPLETION_MAX_RESULT_CHARS,
	TAB_COMPLETION_DEBOUNCE_MS,
	TAB_COMPLETION_PREFIX_LINES,
	TAB_COMPLETION_SUFFIX_LINES,
	TAB_COMPLETION_MAX_PREFIX_CHARS,
	TAB_COMPLETION_MAX_SUFFIX_CHARS,
	TAB_COMPLETION_MODE_FIM,
	TAB_COMPLETION_FIM_ENABLED_DEFAULT,
	FIM_DEFAULT_ENDPOINT,
	FIM_DEFAULT_MODEL,
	FIM_SEPARATOR,
	FIM_MAX_TOKENS,
	FIM_TEMPERATURE,
} from '../shared/constants';
import { getFimApiKey } from '../secretStorage';
import { isSafeApiEndpoint } from '../utils/endpointSafety';

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
	/** 编辑器取消（继续击键 / 光标移动）时中止请求 */
	token?: vscode.CancellationToken;
}

/** 补全实际产出通道（区别于配置的 mode：降级时配置为 fim、实际产出为 fast） */
export type TabCompletionChannel = 'fim' | 'fast';

/** 带通道信息的补全结果 */
export interface TabCompletionOutcome {
	text: string;
	channel: TabCompletionChannel;
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

/** 本次会话内被熔断的 FIM 端点（4xx「接口不存在」类错误后不再重复请求） */
let _fimBlockedEndpoint: string | undefined;

/** 当前被熔断的 FIM 端点（供统计面板展示） */
export function getFimBlockedEndpoint(): string | undefined {
	return _fimBlockedEndpoint;
}

/** 重置 FIM 端点熔断状态（测试用；用户侧改端点配置或重启扩展宿主亦可恢复） */
export function resetFimEndpointBlocklist(): void {
	_fimBlockedEndpoint = undefined;
}

/** 判断是否 4xx「接口不存在」类永久错误（429 限流为瞬时错误，不熔断） */
function isPermanentFimStatus(status: number): boolean {
	return status >= 400 && status < 500 && status !== 429;
}

async function safeReadBody(res: { text?: () => Promise<string> }): Promise<string> {
	try {
		return (await res.text?.())?.slice(0, 200) ?? '';
	} catch {
		return '';
	}
}

/**
 * FIM 通道：请求 FIM 端点（端点来自 kodrix.tabCompletion.fimEndpoint 设置，默认 DeepSeek）。
 * 无 Key / 请求失败 / 无文本返回 undefined（调用方降级 fast），但失败一律：
 *   - logger 记录状态码 + 端点 + 响应片段；
 *   - 统计模块记录 fim.failures / fim.lastFailure；
 *   - 4xx（非 429）触发本会话端点熔断，后续请求直接跳过并计入 fim.skips。
 */
export async function provideFimCompletion(ctx: CompletionContext, opts: FimOptions): Promise<string | undefined> {
	if (!opts.apiKey.trim() || !opts.endpoint.trim()) {
		return undefined;
	}
	if (!isSafeApiEndpoint(opts.endpoint)) {
		logger.warn(`[TabCompletion] FIM 端点不是 https（或回环 http），已拒绝发送 API Key：${opts.endpoint}`);
		recordTabFimSkip(opts.endpoint);
		return undefined;
	}
	if (_fimBlockedEndpoint === opts.endpoint) {
		logger.warn(`[TabCompletion] FIM 端点 ${opts.endpoint} 此前返回 4xx，本会话已跳过（不再重试）`);
		recordTabFimSkip(opts.endpoint);
		return undefined;
	}
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? TAB_COMPLETION_TIMEOUT_MS);
	const cancelSub = opts.token?.onCancellationRequested(() => ac.abort());
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
			const bodySnippet = await safeReadBody(res as { text?: () => Promise<string> });
			const reason = `HTTP ${res.status}${bodySnippet ? ` ${bodySnippet}` : ''}`;
			logger.warn(`[TabCompletion] FIM 请求失败 status=${res.status} endpoint=${opts.endpoint} body=${bodySnippet || '(empty)'}`);
			recordTabFimFailure(opts.endpoint, res.status, reason.slice(0, 300));
			if (isPermanentFimStatus(res.status)) {
				_fimBlockedEndpoint = opts.endpoint;
				logger.warn(`[TabCompletion] FIM 端点 ${opts.endpoint} 因 ${res.status} 被本会话熔断，后续补全直接走 fast 通道`);
			}
			return undefined;
		}
		const data = await res.json() as { choices?: Array<{ text?: unknown }> };
		const text = data.choices?.[0]?.text;
		if (typeof text !== 'string' || !text.trim()) {
			logger.warn(`[TabCompletion] FIM 返回 ${res.status} 但 choices[0].text 无内容，endpoint=${opts.endpoint}`);
			recordTabFimFailure(opts.endpoint, res.status, '响应 choices[0].text 无文本');
			return undefined;
		}
		return extractCompletion(text.slice(0, TAB_COMPLETION_MAX_RESULT_CHARS));
	} catch (err) {
		if (opts.token?.isCancellationRequested) {
			return undefined;
		}
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn(`[TabCompletion] FIM 请求异常 endpoint=${opts.endpoint}: ${msg}`, err);
		recordTabFimFailure(opts.endpoint, 'network', msg.slice(0, 300));
		return undefined;
	} finally {
		clearTimeout(timer);
		cancelSub?.dispose();
	}
}

/** fast 通道：走模型路由 fast 档（原 Tab 补全逻辑） */
async function provideFastCompletion(ctx: CompletionContext, token?: vscode.CancellationToken): Promise<string | undefined> {
	const routed = await routeModel({ tier: 'fast' });
	if (!routed || token?.isCancellationRequested) {
		return undefined;
	}
	const cts = new vscode.CancellationTokenSource();
	const timer = setTimeout(() => cts.cancel(), TAB_COMPLETION_TIMEOUT_MS);
	const cancelSub = token?.onCancellationRequested(() => cts.cancel());
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
		cancelSub?.dispose();
		cts.dispose();
	}
}

/** 模块级 ExtensionContext 引用（由 registerTabCompletion 注入） */
let _extCtx: vscode.ExtensionContext | undefined;

/** 最近一次建议的实际产出通道（接受事件按此归因，避免按配置 mode 误计） */
let _lastSuggestedChannel: TabCompletionChannel | undefined;

/**
 * 解析 FIM 端点：始终读取 kodrix.tabCompletion.fimEndpoint 设置，
 * 未配置/为空时回退 FIM_DEFAULT_ENDPOINT（保持历史默认地址，向后兼容）。
 */
function resolveFimEndpoint(cfg: vscode.WorkspaceConfiguration): string {
	const configured = cfg.get<string>(TAB_COMPLETION_CONFIG_KEYS.fimEndpoint, FIM_DEFAULT_ENDPOINT);
	return (configured ?? '').trim() || FIM_DEFAULT_ENDPOINT;
}

/**
 * 生成 Tab 补全并报告实际通道：mode=fim 且 fimEnabled 且配 Key → FIM 通道
 * （失败/熔断自动降级 fast，且降级事件已记入日志与统计）；否则 fast 通道。
 * 未启用 / 无模型 / 失败时返回 undefined（调用方静默降级）。
 */
export async function provideTabCompletionOutcome(ctx: CompletionContext, token?: vscode.CancellationToken): Promise<TabCompletionOutcome | undefined> {
	const cfg = vscode.workspace.getConfiguration(TAB_COMPLETION_CONFIG);
	const enabled = cfg.get<boolean>(TAB_COMPLETION_CONFIG_KEYS.enabled, false);
	if (!enabled) {
		return undefined;
	}
	const mode = cfg.get<string>(TAB_COMPLETION_CONFIG_KEYS.mode, TAB_COMPLETION_MODE_FIM);
	if (mode === TAB_COMPLETION_MODE_FIM) {
		const fimEnabled = cfg.get<boolean>(TAB_COMPLETION_CONFIG_KEYS.fimEnabled, TAB_COMPLETION_FIM_ENABLED_DEFAULT);
		if (!fimEnabled) {
			logger.debug('[TabCompletion] kodrix.tabCompletion.fimEnabled=false，FIM 专线已禁用，直连 fast 通道');
		} else {
			const apiKey = _extCtx ? await getFimApiKey(_extCtx) : undefined;
			if (apiKey) {
				const endpoint = resolveFimEndpoint(cfg);
				const model = cfg.get<string>(TAB_COMPLETION_CONFIG_KEYS.fimModel, FIM_DEFAULT_MODEL);
				const fim = await provideFimCompletion(ctx, { endpoint, apiKey, model, token });
				if (fim) {
					return { text: fim, channel: 'fim' };
				}
				if (token?.isCancellationRequested) {
					return undefined;
				}
				logger.warn('[TabCompletion] 本次补全 FIM 通道失败或已熔断，降级 fast 通道产出（详见 Kodrix: Tab 补全统计 → FIM 专线诊断）');
			}
		}
	}
	const fast = await provideFastCompletion(ctx, token);
	return fast ? { text: fast, channel: 'fast' } : undefined;
}

/** 生成 Tab 补全（兼容旧签名，仅返回文本；通道归因请用 provideTabCompletionOutcome） */
export async function provideTabCompletion(ctx: CompletionContext): Promise<string | undefined> {
	const outcome = await provideTabCompletionOutcome(ctx);
	return outcome?.text;
}

/** 注册 Tab 补全（InlineCompletion 提供者，默认关闭） */
export function registerTabCompletion(context: vscode.ExtensionContext): void {
	_extCtx = context;
	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			{ scheme: 'file' },
			{
				async provideInlineCompletionItems(document, position, _ctx, token) {
					const enabled = vscode.workspace.getConfiguration(TAB_COMPLETION_CONFIG)
						.get<boolean>(TAB_COMPLETION_CONFIG_KEYS.enabled, false);
					if (!enabled) {
						return [];
					}
					await new Promise(resolve => setTimeout(resolve, TAB_COMPLETION_DEBOUNCE_MS));
					if (token.isCancellationRequested) {
						return [];
					}
					const firstLine = Math.max(0, position.line - TAB_COMPLETION_PREFIX_LINES);
					const lastLine = Math.min(document.lineCount - 1, position.line + TAB_COMPLETION_SUFFIX_LINES);
					const prefix = document.getText(new vscode.Range(new vscode.Position(firstLine, 0), position))
						.slice(-TAB_COMPLETION_MAX_PREFIX_CHARS);
					const suffix = document.getText(new vscode.Range(position, document.lineAt(Math.max(0, lastLine)).range.end))
						.slice(0, TAB_COMPLETION_MAX_SUFFIX_CHARS);
					const outcome = await provideTabCompletionOutcome({
						prefix,
						suffix,
						language: document.languageId,
					}, token);
					if (!outcome || token.isCancellationRequested) {
						return [];
					}
					_lastSuggestedChannel = outcome.channel;
					// 统计按实际产出通道记录：FIM 失败降级的结果计入 fast，不混入 FIM 命中率
					recordTabSuggestion(outcome.channel);
					return [{
						insertText: outcome.text,
						range: new vscode.Range(position, position),
						command: { command: 'kodrix.tabCompletion.accepted', title: l10n.t('Completion acceptance') },
					}];
				},
			},
		),
		vscode.commands.registerCommand('kodrix.tabCompletion.accepted', () => {
			recordTabAccept(_lastSuggestedChannel
				?? vscode.workspace.getConfiguration(TAB_COMPLETION_CONFIG)
					.get<string>(TAB_COMPLETION_CONFIG_KEYS.mode, TAB_COMPLETION_MODE_FIM));
		}),
		vscode.commands.registerCommand('kodrix.tabCompletion.stats', () => showTabCompletionStats(getFimBlockedEndpoint())),
		{ dispose: flushTabCompletionStats },
	);
}
