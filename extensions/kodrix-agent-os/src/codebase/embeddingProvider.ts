/*---------------------------------------------------------------------------------------------
 *  Embedding Provider — 真向量语义检索（默认智谱 embedding-3，OpenAI 兼容 embeddings API）
 *
 *  使用：设置 kodrix.semanticEmbedding.enabled=true + apiKey（智谱 Key）保存即启用；
 *        也可自定义 endpoint / model。失败时单条 embed 返回 undefined → 检索自动回退 BM25。
 *--------------------------------------------------------------------------------------------*/

import { logger } from '../logger';
import type { EmbeddingProvider } from './semanticIndex';

export const ZHIPU_DEFAULT_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/embeddings';
export const ZHIPU_DEFAULT_MODEL = 'embedding-3';
const EMBEDDING_TIMEOUT_MS = 15_000;
/** 单次输入最大字符数（控制 token 成本） */
const EMBEDDING_MAX_CHARS = 8000;

export interface ZhipuEmbeddingConfig {
	apiKey: string;
	endpoint?: string;
	model?: string;
	timeoutMs?: number;
}

/** 创建智谱 embedding Provider（失败返回 undefined → 检索回退 BM25） */
export function createZhipuEmbeddingProvider(config: ZhipuEmbeddingConfig): EmbeddingProvider {
	const endpoint = config.endpoint?.trim() || ZHIPU_DEFAULT_ENDPOINT;
	const model = config.model?.trim() || ZHIPU_DEFAULT_MODEL;
	const apiKey = config.apiKey.trim();

	async function request(input: string[]): Promise<Array<number[] | undefined>> {
		const results: Array<number[] | undefined> = new Array(input.length).fill(undefined);
		if (!apiKey || !input.length) {
			return results;
		}
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs ?? EMBEDDING_TIMEOUT_MS);
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ model, input: input.map(x => x.slice(0, EMBEDDING_MAX_CHARS)) }),
				signal: ac.signal,
			});
			if (!res.ok) {
				logger.warn(`[Embedding] 端点 ${res.status}`);
				return results;
			}
			const data = await res.json() as { data?: Array<{ embedding?: unknown; index?: unknown }> };
			if (!Array.isArray(data.data)) {
				logger.warn('[Embedding] 响应缺少 data');
				return results;
			}
			let slot = 0;
			for (const item of data.data) {
				let idx = typeof item.index === 'number' ? item.index : -1;
				if (idx < 0 || idx >= results.length) {
					while (slot < results.length && results[slot] !== undefined) { slot++; }
					idx = slot++;
				}
				const vec = item.embedding;
				if (idx >= 0 && idx < results.length && Array.isArray(vec) && vec.every(x => typeof x === 'number')) {
					results[idx] = vec as number[];
				}
			}
			return results;
		} catch (err) {
			logger.warn('[Embedding] 请求失败', err);
			return results;
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		name: `zhipu:${model}`,
		async embed(text) {
			return (await request([text]))[0];
		},
		async embedBatch(texts) {
			return request(texts);
		},
	};
}
