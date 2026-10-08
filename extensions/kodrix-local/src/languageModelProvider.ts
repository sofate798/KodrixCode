/*---------------------------------------------------------------------------------------------
 *  Kodrix 语言模型 — 直接请求已配置的 OpenAI / Anthropic 兼容接口
 *
 *  不经过 GitHub Copilot 登录。Chat 模型选择器里厂商名为 Kodrix。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { anthropicMessagesUrl, openaiChatCompletionsUrl } from './endpointUrls';
import { readProviderApiKey } from './providerSecrets';
import { loadStoredProviders, StoredProvider } from './providerStore';
import { describeHttpError, describeNetworkError, isCancellation } from './requestErrors';

const VENDOR = 'kodrix';

/**
 * Kodrix 语言模型供应商能直接服务的 api_type：
 *   - anthropic → Messages API
 *   - 其余（openai / ollama 等）→ OpenAI 兼容 /chat/completions
 * 原生 Gemini 不在其中（该路径由项目内 Copilot BYOK 的 Gemini 供应商提供）。必须在模型列表
 * 阶段就过滤掉，否则 Chat 模型选择器里会长期挂着一个点了必然报错的 Kodrix / gemini-* 模型。
 */
const UNSUPPORTED_API_TYPES = new Set(['gemini']);

/**
 * 该 api_type 能否由 Kodrix 自有供应商通道直接服务（即不依赖 GitHub Copilot）。
 * 注册路径（byokRegister）必须与本判断保持一致，否则会出现「BYOK 注册失败但 UI 报成功」
 * 的误判：只有当两条通道都不通时，注册失败才是真失败。
 */
export function supportsKodrixNativePath(apiType: string): boolean {
	return !UNSUPPORTED_API_TYPES.has(apiType);
}

interface KodrixModelInfo extends vscode.LanguageModelChatInformation {
	providerId: string;
	modelId: string;
	apiType: string;
	baseUrl: string;
}

const onDidChangeEmitter = new vscode.EventEmitter<void>();

export function notifyKodrixModelsChanged(): void {
	onDidChangeEmitter.fire();
}

export function registerKodrixLanguageModels(context: vscode.ExtensionContext): void {
	const provider: vscode.LanguageModelChatProvider<KodrixModelInfo> = {
		onDidChangeLanguageModelChatInformation: onDidChangeEmitter.event,
		async provideLanguageModelChatInformation() {
			return loadStoredProviders(context).flatMap(toModelInfos);
		},
		async provideLanguageModelChatResponse(model, messages, options, progress, token) {
			const stored = loadStoredProviders(context).find(p => p.id === model.providerId);
			if (!stored) {
				throw new Error(l10n.t('Provider "{0}" no longer exists. Re-add it in AI Provider Management.', model.providerId));
			}
			const apiKey = await readProviderApiKey(context, stored.id);
			if (stored.needs_api_key && !apiKey) {
				throw new Error(l10n.t('"{0}" has no API Key yet. Fill in this provider\'s API Key in AI Provider Management.', stored.name));
			}
			if (stored.api_type === 'anthropic') {
				await streamAnthropic(stored, model.modelId, apiKey, messages, options, progress, token);
				return;
			}
			if (stored.api_type === 'gemini') {
				// 安全网：模型列表已过滤掉 gemini，此处只兜住升级前已选中的旧模型 ID
				throw new Error(l10n.t('Kodrix providers do not support the native Gemini API: use an OpenAI-compatible endpoint instead, or register via BYOK in an environment where Copilot is installed and ready.'));
			}
			await streamOpenAI(stored, model.modelId, apiKey, messages, options, progress, token);
		},
		async provideTokenCount(_model, text) {
			const value = typeof text === 'string' ? text : JSON.stringify(text);
			return Math.max(1, Math.ceil(value.length / 4));
		},
	};

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
		onDidChangeEmitter,
	);
}

function toModelInfos(provider: StoredProvider): KodrixModelInfo[] {
	if (UNSUPPORTED_API_TYPES.has(provider.api_type)) {
		return [];
	}
	const names = provider.models.length ? provider.models : (provider.model ? [provider.model] : []);
	return names.map(modelId => ({
		id: `${provider.id}::${modelId}`,
		name: modelId,
		family: modelId,
		version: '1',
		detail: provider.name,
		tooltip: `${provider.name} · ${provider.api_type === 'anthropic' ? 'Anthropic' : 'OpenAI'} · ${provider.base_url}`,
		maxInputTokens: 128000,
		maxOutputTokens: 8192,
		capabilities: {
			toolCalling: true,
			imageInput: /vision/i.test(modelId),
		},
		providerId: provider.id,
		modelId,
		apiType: provider.api_type,
		baseUrl: provider.base_url,
	}));
}

interface WireMessage {
	role: string;
	content?: unknown;
	tool_calls?: unknown[];
	tool_call_id?: string;
}

function textOf(part: unknown): string | undefined {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value;
	}
	return undefined;
}

function toOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): WireMessage[] {
	const out: WireMessage[] = [];
	for (const message of messages) {
		const texts: string[] = [];
		const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
		const toolResults: Array<{ id: string; content: string }> = [];
		for (const part of message.content) {
			const text = textOf(part);
			if (text !== undefined) {
				texts.push(text);
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
				});
				continue;
			}
			if (part instanceof vscode.LanguageModelToolResultPart) {
				const content = part.content.map(p => textOf(p) ?? '').join('');
				toolResults.push({ id: part.callId, content });
			}
		}
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		if (role === 'assistant') {
			const entry: WireMessage = { role, content: texts.join('\n') };
			if (toolCalls.length) {
				entry.tool_calls = toolCalls;
			}
			out.push(entry);
		} else if (toolResults.length && !texts.length) {
			for (const result of toolResults) {
				out.push({ role: 'tool', tool_call_id: result.id, content: result.content });
			}
		} else {
			out.push({ role, content: texts.join('\n') });
			for (const result of toolResults) {
				out.push({ role: 'tool', tool_call_id: result.id, content: result.content });
			}
		}
	}
	return out;
}

async function streamOpenAI(
	provider: StoredProvider,
	modelId: string,
	apiKey: string | undefined,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const body: Record<string, unknown> = {
		model: modelId,
		messages: toOpenAIMessages(messages),
		stream: true,
	};
	if (options.tools?.length) {
		body.tools = options.tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? { type: 'object', properties: {} },
			},
		}));
		if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
			body.tool_choice = 'required';
		}
	}

	const response = await requestStream(provider, openaiChatCompletionsUrl(provider.base_url, provider.api_type), {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: abortSignal(token),
	});
	const pending = new Map<number, { id: string; name: string; args: string }>();
	await readSse(response, token, payload => {
		if (payload === '[DONE]') {
			return;
		}
		const data = JSON.parse(payload) as {
			choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
		};
		const delta = data.choices?.[0]?.delta;
		if (delta?.content) {
			progress.report(new vscode.LanguageModelTextPart(delta.content));
		}
		for (const call of delta?.tool_calls ?? []) {
			const index = call.index ?? 0;
			const current = pending.get(index) ?? { id: call.id || `call_${index}`, name: '', args: '' };
			if (call.id) {
				current.id = call.id;
			}
			if (call.function?.name) {
				current.name += call.function.name;
			}
			if (call.function?.arguments) {
				current.args += call.function.arguments;
			}
			pending.set(index, current);
		}
	});
	for (const call of pending.values()) {
		if (!call.name) {
			continue;
		}
		progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parseJsonObject(call.args)));
	}
}

function toAnthropicBody(
	modelId: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
): Record<string, unknown> {
	const wire: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
	for (const message of messages) {
		const blocks: unknown[] = [];
		for (const part of message.content) {
			const text = textOf(part);
			if (text !== undefined) {
				blocks.push({ type: 'text', text });
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				blocks.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input ?? {} });
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				blocks.push({
					type: 'tool_result',
					tool_use_id: part.callId,
					content: part.content.map(p => textOf(p) ?? '').join(''),
				});
			}
		}
		if (!blocks.length) {
			continue;
		}
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const last = wire[wire.length - 1];
		if (last?.role === role) {
			last.content.push(...blocks);
		} else {
			wire.push({ role, content: blocks });
		}
	}
	const body: Record<string, unknown> = {
		model: modelId,
		max_tokens: 8192,
		stream: true,
		messages: wire.length ? wire : [{ role: 'user', content: [{ type: 'text', text: '' }] }],
	};
	if (options.tools?.length) {
		body.tools = options.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
		}));
	}
	return body;
}

async function streamAnthropic(
	provider: StoredProvider,
	modelId: string,
	apiKey: string | undefined,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'anthropic-version': '2023-06-01',
	};
	if (apiKey) {
		headers['x-api-key'] = apiKey;
	}
	const response = await requestStream(provider, anthropicMessagesUrl(provider.base_url), {
		method: 'POST',
		headers,
		body: JSON.stringify(toAnthropicBody(modelId, messages, options)),
		signal: abortSignal(token),
	});
	let toolId = '';
	let toolName = '';
	let toolArgs = '';
	const flushTool = () => {
		if (!toolName) {
			return;
		}
		progress.report(new vscode.LanguageModelToolCallPart(toolId || toolName, toolName, parseJsonObject(toolArgs)));
		toolId = '';
		toolName = '';
		toolArgs = '';
	};
	await readSse(response, token, payload => {
		const data = JSON.parse(payload) as {
			type?: string;
			delta?: { type?: string; text?: string; partial_json?: string };
			content_block?: { type?: string; id?: string; name?: string };
		};
		if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
			flushTool();
			toolId = data.content_block.id || '';
			toolName = data.content_block.name || '';
			toolArgs = '';
		} else if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
			progress.report(new vscode.LanguageModelTextPart(data.delta.text));
		} else if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta' && data.delta.partial_json) {
			toolArgs += data.delta.partial_json;
		} else if (data.type === 'content_block_stop') {
			flushTool();
		}
	});
	flushTool();
}

function parseJsonObject(raw: string): object {
	if (!raw.trim()) {
		return {};
	}
	try {
		const value = JSON.parse(raw) as unknown;
		return value && typeof value === 'object' ? value as object : { value };
	} catch {
		return { raw };
	}
}

function abortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}

/**
 * 发起请求并把两类失败都转成可行动的中文提示：
 *   - 没拿到响应（DNS/连接/证书/超时）→ describeNetworkError，附带 base_url 便于自查
 *   - 拿到非 2xx → describeHttpError，按状态码给出下一步
 * 取消与超时中断按原语义传播，不当作故障提示。
 */
async function requestStream(provider: StoredProvider, url: string, init: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (err) {
		if (isCancellation(err)) {
			throw err;
		}
		throw new Error(describeNetworkError(provider.name, provider.base_url, err));
	}
	if (!response.ok) {
		let detail = '';
		try {
			detail = (await response.text()).slice(0, 400);
		} catch {
			detail = '';
		}
		throw new Error(describeHttpError(provider.name, response.status, detail));
	}
	return response;
}

async function readSse(
	response: Response,
	token: vscode.CancellationToken,
	onData: (payload: string) => void,
): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error(vscode.l10n.t('The endpoint did not return a streaming response'));
	}
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (!token.isCancellationRequested) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) {
					continue;
				}
				const payload = trimmed.slice(5).trim();
				if (!payload) {
					continue;
				}
				onData(payload);
			}
		}
	} finally {
		reader.cancel();
	}
}
