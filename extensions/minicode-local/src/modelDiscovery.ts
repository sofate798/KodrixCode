/*---------------------------------------------------------------------------------------------
 *  Minicode — OpenAI 兼容端点模型发现与连通性测试
 *--------------------------------------------------------------------------------------------*/

import { logWarn } from './logger';

export interface ConnectionTestResult {
	ok: boolean;
	models: string[];
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
): Promise<ConnectionTestResult> {
	const started = Date.now();
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey?.trim()) {
		headers.Authorization = `Bearer ${apiKey.trim()}`;
	}

	let lastError = '无法连接';
	for (const url of modelsDiscoveryUrls(baseUrl)) {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				lastError = `HTTP ${response.status} (${url})`;
				continue;
			}
			const data = await response.json();
			const models = parseModelIds(data);
			return {
				ok: models.length > 0,
				models,
				latencyMs: Date.now() - started,
				error: models.length > 0 ? undefined : `端点可达但未发现模型 (${url})`,
			};
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}

	return {
		ok: false,
		models: [],
		error: lastError,
		latencyMs: Date.now() - started,
	};
}

export async function testOllamaConnection(baseUrl: string): Promise<ConnectionTestResult> {
	const started = Date.now();
	const normalized = normalizeBaseUrl(baseUrl);
	try {
		const response = await fetch(`${normalized}/api/tags`, {
			method: 'GET',
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			return { ok: false, models: [], error: `HTTP ${response.status}`, latencyMs: Date.now() - started };
		}
		const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
		const models = (data.models || [])
			.map(m => m.name || m.model)
			.filter((id): id is string => !!id);
		return { ok: true, models, latencyMs: Date.now() - started };
	} catch (err) {
		return {
			ok: false,
			models: [],
			error: err instanceof Error ? err.message : String(err),
			latencyMs: Date.now() - started,
		};
	}
}
