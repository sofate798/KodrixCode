/*---------------------------------------------------------------------------------------------
 *  Kodrix — OpenAI 兼容端点模型发现与连通性测试
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';
import { logWarn } from './logger';
import { openaiChatCompletionsUrl } from './endpointUrls';

export interface ConnectionTestResult {
	ok: boolean;
	models: string[];
	/** 本次实际用于验证的模型名，供界面显示"已验证哪个模型" */
	testedModel?: string;
	error?: string;
	latencyMs?: number;
}

function normalizeBaseUrl(url: string): string {
	return (url || '').replace(/\/+$/, '');
}

function modelsDiscoveryUrls(baseUrl: string): string[] {
	const normalized = normalizeBaseUrl(baseUrl);
	const urls = new Set<string>();
	if (normalized.includes('/v1')) {
		urls.add(`${normalized}/models`);
	} else {
		urls.add(`${normalized}/v1/models`);
		urls.add(`${normalized}/models`);
	}
	return [...urls];
}

function httpStatusHint(status: number): string {
	switch (status) {
		case 401: return l10n.t('The API Key is invalid or was rejected by the provider');
		case 403: return l10n.t('The account has no access to this model');
		case 404: return l10n.t('Endpoint or model name not found');
		case 429: return l10n.t('Request rate or account usage limit reached');
		default: return status >= 500 ? l10n.t('Provider temporarily unavailable') : l10n.t('Check the provider configuration');
	}
}

function parseModelIds(data: unknown): string[] {
	if (!data || typeof data !== 'object') {
		return [];
	}
	const payload = data as { data?: unknown; models?: unknown };
	const list = payload.data ?? payload.models;
	if (!Array.isArray(list)) {
		return [];
	}
	const ids: string[] = [];
	for (const item of list) {
		if (typeof item === 'string') {
			ids.push(item);
			continue;
		}
		if (item && typeof item === 'object') {
			const record = item as { id?: string; name?: string };
			const id = record.id || record.name;
			if (id) {
				ids.push(id);
			}
		}
	}
	return [...new Set(ids)];
}

export async function discoverOpenAIModels(baseUrl: string, apiKey?: string): Promise<string[]> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey?.trim()) {
		headers.Authorization = `Bearer ${apiKey.trim()}`;
	}

	for (const url of modelsDiscoveryUrls(baseUrl)) {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				continue;
			}
			const data = await response.json();
			const models = parseModelIds(data);
			if (models.length > 0) {
				return models;
			}
		} catch (err) {
			logWarn(`模型发现失败 (${url})，尝试下一个端点`, err);
		}
	}
	return [];
}

export async function testOpenAICompatibleConnection(
	baseUrl: string,
	apiKey?: string,
	model?: string,
	timeoutMs = 15_000,
): Promise<ConnectionTestResult> {
	const started = Date.now();
	const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
	if (apiKey?.trim()) {
		headers.Authorization = `Bearer ${apiKey.trim()}`;
	}

	const configuredModel = model?.trim();
	const models = configuredModel ? [configuredModel] : await discoverOpenAIModels(baseUrl, apiKey);
	const selectedModel = configuredModel || models[0];
	if (!selectedModel) {
		return {
			ok: false,
			models,
			error: l10n.t('No model name available to verify. Fill in a model name in the provider settings.'),
			latencyMs: Date.now() - started,
		};
	}

	try {
		// Verify the configured model itself. /models is optional on many
		// compatible services and cannot establish that chat requests work.
		const response = await fetch(openaiChatCompletionsUrl(baseUrl, 'openai'), {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: selectedModel,
				messages: [{ role: 'user', content: 'ping' }],
				max_tokens: 1,
				stream: false,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		return {
			ok: response.ok,
			models,
			testedModel: selectedModel,
			latencyMs: Date.now() - started,
			error: response.ok ? undefined : l10n.t('Model "{0}" request failed: HTTP {1}, {2}', selectedModel, String(response.status), httpStatusHint(response.status)),
		};
	} catch (err) {
		return {
			ok: false,
			models,
			testedModel: selectedModel,
			error: err instanceof Error ? err.message : String(err),
			latencyMs: Date.now() - started,
		};
	}
}

export async function testOllamaConnection(baseUrl: string, model?: string): Promise<ConnectionTestResult> {
	const started = Date.now();
	const normalized = normalizeBaseUrl(baseUrl).replace(/\/v1$/i, '');
	try {
		const response = await fetch(`${normalized}/api/tags`, {
			method: 'GET',
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			return {
				ok: false,
				models: [],
				error: l10n.t('Ollama model list request failed: HTTP {0}, {1}', String(response.status), httpStatusHint(response.status)),
				latencyMs: Date.now() - started,
			};
		}
		const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
		const models = (data.models || [])
			.map(m => m.name || m.model)
			.filter((id): id is string => !!id);
		const selectedModel = model?.trim() || models[0];
		if (!selectedModel) {
			return {
				ok: false,
				models,
				error: l10n.t('Ollama is connected but has no model to test. Pull a model first, or fill in a model ID in the provider settings.'),
				latencyMs: Date.now() - started,
			};
		}

		// Verify the same OpenAI-compatible chat route used by the Kodrix model
		// provider. Loading a local model for the first time can take much longer
		// than a cloud health check, so allow up to one minute.
		// 上面已剥掉结尾的 /v1，这里再判一次只是兜住用户填成 .../v1/v1 的情况，避免拼出双 /v1。
		const chatBaseUrl = /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
		const chatResult = await testOpenAICompatibleConnection(
			chatBaseUrl,
			undefined,
			selectedModel,
			60_000,
		);
		return {
			...chatResult,
			models,
			latencyMs: Date.now() - started,
			error: chatResult.error ? l10n.t('Ollama model "{0}" test failed: {1}', selectedModel, chatResult.error) : undefined,
		};
	} catch (err) {
		return {
			ok: false,
			models: [],
			error: err instanceof Error ? err.message : String(err),
			latencyMs: Date.now() - started,
		};
	}
}
