/*---------------------------------------------------------------------------------------------
 *  Kodrix 语言模型 — 直接请求已配置的 OpenAI / Anthropic 兼容接口
 *
 *  不经过 GitHub Copilot 登录。Chat 模型选择器里厂商名为 Kodrix。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { anthropicMessagesUrl, openaiChatCompletionsUrl } from './endpointUrls';
import { readProviderApiKey } from './providerSecrets';
import { loadStoredProviders, StoredProvider } from './providerStore';

const VENDOR = 'kodrix';

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
				throw new Error(`供应商「${model.providerId}」已不存在，请在 AI 供应商管理中重新添加。`);
			}
			const apiKey = await readProviderApiKey(context, stored.id);
			if (stored.needs_api_key && !apiKey) {
				throw new Error(`「${stored.name}」还没有 API Key。请在 AI 供应商管理中填写。`);
			}
			if (stored.api_type === 'anthropic') {
				await streamAnthropic(stored, model.modelId, apiKey, messages, options, progress, token);
				return;
			}
			if (stored.api_type === 'gemini') {
				throw new Error('Gemini 请改用 OpenAI 兼容或 Anthropic 兼容的 base_url 接入。');
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

	const response = await fetch(openaiChatCompletionsUrl(provider.base_url, provider.api_type), {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: abortSignal(token),
	});
	if (!response.ok) {
		throw new Error(await httpError(provider.name, response));
	}
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
	const response = await fetch(anthropicMessagesUrl(provider.base_url), {
		method: 'POST',
		headers,
		body: JSON.stringify(toAnthropicBody(modelId, messages, options)),
		signal: abortSignal(token),
	});
	if (!response.ok) {
		throw new Error(await httpError(provider.name, response));
	}
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

async function httpError(name: string, response: Response): Promise<string> {
	let detail = '';
	try {
		detail = (await response.text()).slice(0, 400);
	} catch {
		detail = '';
	}
	return `「${name}」请求失败（HTTP ${response.status}）${detail ? `: ${detail}` : ''}`;
}

async function readSse(
	response: Response,
	token: vscode.CancellationToken,
	onData: (payload: string) => void,
): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('接口没有返回流式响应');
	}
	const decoder = new TextDecoder();
	let buffer = '';
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
}
