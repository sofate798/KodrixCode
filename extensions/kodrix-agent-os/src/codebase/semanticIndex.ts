/*---------------------------------------------------------------------------------------------
 *  Codebase Semantic Index — 代码语义检索（对标 Cursor 语法块 embedding 的本地化实现）
 *
 *  检索策略（两级）：
 *    1. Embedding 优先：注册 EmbeddingProvider（外部向量模型/API）后，用向量余弦
 *       检索符号/文件（异步 API：searchSymbolsAsync / searchFilesAsync）
 *    2. BM25 默认（零外部依赖）：token 级 BM25 打分（k1=1.5, b=0.75），
 *       相比词袋 TF-IDF 显著提升检索质量 —— 无外部 embedding 时的最佳本地路径
 *
 *  粒度：
 *    1. 符号级 — name + kind + 父符号 + 签名 + 文档注释
 *    2. 文件级 — 相对路径 + 符号名聚合
 *  特性：
 *    - 内存构建、不落盘（随 ProjectIndex 对象生命周期缓存，索引重建自动失效）
 *    - 毫秒级响应：数千符号 × BM25 ≈ 10-50ms
 *    - 多语言透明：TS / Python / Go / Rust 符号统一进入语义空间
 *--------------------------------------------------------------------------------------------*/

import type { ProjectIndex, CodeSymbol } from './types';
import { encodeText, cosineSimilarity, tokenize } from '../utils/textVector';
import { logger } from '../logger';

/** 代码语义向量维度（比记忆索引更高，区分度更好） */
const SEMANTIC_DIM = 256;

/** BM25 参数（信息检索标准配置） */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ── BM25 存储 ───────────────────────────────────────────────────

interface Bm25Store {
	/** docId → token → 词频 */
	docs: Map<string, Map<string, number>>;
	/** docId → 文档长度（token 数） */
	len: Map<string, number>;
	/** 平均文档长度 */
	avgLen: number;
	/** token → 文档频率 */
	df: Map<string, number>;
	/** 文档总数 */
	n: number;
}

function buildBm25(entries: Iterable<[string, string]>): Bm25Store {
	const docs = new Map<string, Map<string, number>>();
	const len = new Map<string, number>();
	const df = new Map<string, number>();
	let totalLen = 0;
	let count = 0;
	for (const [id, text] of entries) {
		const tokens = tokenize(text);
		if (!tokens.length) continue;
		const tf = new Map<string, number>();
		for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
		docs.set(id, tf);
		len.set(id, tokens.length);
		totalLen += tokens.length;
		count++;
		for (const tok of new Set(tokens)) df.set(tok, (df.get(tok) || 0) + 1);
	}
	return { docs, len, avgLen: count ? totalLen / count : 0, df, n: count };
}

/** BM25 打分（标准公式） */
function bm25Score(store: Bm25Store, queryTokens: string[], docId: string): number {
	const tf = store.docs.get(docId);
	if (!tf || !store.n) return 0;
	const docLen = store.len.get(docId) ?? 0;
	const denom = store.avgLen > 0 ? 1 - BM25_B + BM25_B * (docLen / store.avgLen) : 1;
	let score = 0;
	for (const tok of queryTokens) {
		const f = tf.get(tok) || 0;
		if (!f) continue;
		const d = store.df.get(tok) ?? 0;
		const idf = Math.log(1 + (store.n - d + 0.5) / (d + 0.5));
		score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * denom));
	}
	return score;
}

// ── 缓存 ────────────────────────────────────────────────────────

interface SemanticCache {
	symbolVectors: Map<string, number[]>;
	fileVectors: Map<string, number[]>;
	symbolBm25: Bm25Store;
	fileBm25: Bm25Store;
}

let _cache: SemanticCache | null = null;
let _cacheIndex: ProjectIndex | null = null;

/** 构建语义缓存（绑定到 index 对象；索引重建后自动失效重建） */
export function ensureSemanticIndex(index: ProjectIndex): SemanticCache {
	if (_cache && _cacheIndex === index) return _cache;
	if (!index || !index.symbols) {
		return { symbolVectors: new Map(), fileVectors: new Map(), symbolBm25: buildBm25([]), fileBm25: buildBm25([]) };
	}

	const start = Date.now();
	const symbolVectors = new Map<string, number[]>();
	const fileSymbols = new Map<string, CodeSymbol[]>();
	const symbolDocs = new Map<string, string>();

	for (const sym of Object.values(index.symbols)) {
		const doc = buildSymbolDoc(sym);
		symbolVectors.set(sym.id, encodeText(doc, SEMANTIC_DIM));
		symbolDocs.set(sym.id, doc);
		const list = fileSymbols.get(sym.filePath);
		if (list) {
			list.push(sym);
		} else {
			fileSymbols.set(sym.filePath, [sym]);
		}
	}

	const fileVectors = new Map<string, number[]>();
	const fileDocs = new Map<string, string>();
	for (const [filePath, syms] of fileSymbols) {
		const doc = buildFileDoc(index, filePath, syms);
		fileVectors.set(filePath, encodeText(doc, SEMANTIC_DIM));
		fileDocs.set(filePath, doc);
	}

	const symbolBm25 = buildBm25(symbolDocs);
	const fileBm25 = buildBm25(fileDocs);

	_cache = { symbolVectors, fileVectors, symbolBm25, fileBm25 };
	_cacheIndex = index;
	// Embedding 已注册但索引后到（register 早于首次 ensure）→ 补预热
	if (_embedding && !_embedding.ready && !_embedding.building) {
		void warmupEmbedding();
	}
	logger.debug(`[SemanticIndex] built ${symbolVectors.size} symbols + ${fileVectors.size} files (BM25) in ${Date.now() - start}ms`);
	return _cache;
}

/** 主动失效（供调试/测试） */
export function invalidateSemanticIndex(): void {
	_cache = null;
	_cacheIndex = null;
	_embedding = null;
}

// ── Embedding Provider（可插拔真向量检索） ──────────────────────

export interface EmbeddingProvider {
	name: string;
	/** 将文本编码为向量；失败返回 undefined（该文档回退 BM25） */
	embed(text: string): Promise<number[] | undefined>;
	/** 批量编码（可选；提供时 warmup 走批量，减少 API 调用） */
	embedBatch?(texts: string[]): Promise<Array<number[] | undefined>>;
}

interface EmbeddingState {
	provider: EmbeddingProvider;
	symbolVecs: Map<string, number[]>;
	fileVecs: Map<string, number[]>;
	ready: boolean;
	building?: Promise<void>;
}

let _embedding: EmbeddingState | null = null;

/** 注册外部 Embedding 模型/API（真向量检索；注册后异步预热文档向量） */
export function registerEmbeddingProvider(provider: EmbeddingProvider): void {
	_embedding = { provider, symbolVecs: new Map(), fileVecs: new Map(), ready: false };
	void warmupEmbedding();
	logger.info(`[SemanticIndex] Embedding provider registered: ${provider.name}（预热中）`);
}

/** 清除 embedding provider（配置关闭时回退 BM25） */
export function clearEmbeddingProvider(): void {
	_embedding = null;
}

/** 当前 embedding 提供方 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
	return _embedding?.provider ?? null;
}

/** 预热文档向量（异步；完成后 ready=true，检索走向量路径） */
async function warmupEmbedding(): Promise<void> {
	if (!_embedding) return;
	const idx = _cacheIndex;
	if (!idx || !idx.symbols) {
		// 索引尚未建立：保持未 ready，待 ensureSemanticIndex 建立后补预热
		_embedding.building = undefined;
		return;
	}
	const state = _embedding;
	state.building = (async () => {
		try {
			if (state.provider.embedBatch) {
				const syms = Object.values(idx.symbols);
				const vecs = await state.provider.embedBatch(syms.map(sym => buildSymbolDoc(sym)));
				syms.forEach((sym, i) => {
					const vec = vecs[i];
					if (vec) state.symbolVecs.set(sym.id, vec);
				});
			} else {
				for (const sym of Object.values(idx.symbols)) {
					const vec = await state.provider.embed(buildSymbolDoc(sym));
					if (vec) state.symbolVecs.set(sym.id, vec);
				}
			}
			const byFile = new Map<string, CodeSymbol[]>();
			for (const sym of Object.values(idx.symbols)) {
				const list = byFile.get(sym.filePath) || [];
				list.push(sym);
				byFile.set(sym.filePath, list);
			}
			if (state.provider.embedBatch) {
				const entries = [...byFile.entries()];
				const vecs = await state.provider.embedBatch(entries.map(([fp, syms]) => buildFileDoc(idx, fp, syms)));
				entries.forEach(([fp], i) => {
					const vec = vecs[i];
					if (vec) state.fileVecs.set(fp, vec);
				});
			} else {
				for (const [filePath, syms] of byFile) {
					const vec = await state.provider.embed(buildFileDoc(idx, filePath, syms));
					if (vec) state.fileVecs.set(filePath, vec);
				}
			}
			state.ready = true;
			logger.info(`[SemanticIndex] Embedding warmup done: ${state.symbolVecs.size} symbols + ${state.fileVecs.size} files`);
		} catch (err) {
			logger.warn(`[SemanticIndex] Embedding warmup failed（回退 BM25）: ${err instanceof Error ? err.message : String(err)}`);
			state.ready = true; // 空向量 → 检索回退 BM25
		}
	})();
	await state.building;
}

// ── 文档构建 ────────────────────────────────────────────────────

/** 符号语义文档：名称 + 类型 + 父符号 + 签名 + 文档注释 */
export function buildSymbolDoc(sym: CodeSymbol): string {
	const parts = [sym.name, sym.kind];
	if (sym.parentId) {
		const parentName = sym.parentId.split('#')[1];
		if (parentName) parts.push(parentName);
	}
	if (sym.signature) parts.push(sym.signature);
	if (sym.docComment) parts.push(sym.docComment);
	return parts.join(' ');
}

/** 文件语义文档：相对路径 + 文件内符号名聚合（限制数量防噪声） */
export function buildFileDoc(index: ProjectIndex, filePath: string, symbols: CodeSymbol[]): string {
	const rel = index.files[filePath]?.relativePath ?? filePath.replace(/\\/g, '/');
	const parts = [rel];
	for (const s of symbols.slice(0, 100)) {
		parts.push(s.name);
		// 文档注释进入文件语义文档，提升中文/自然语言查询的文件级召回
		if (s.docComment) parts.push(s.docComment.slice(0, 80));
	}
	return parts.join(' ');
}

// ── 检索 API ────────────────────────────────────────────────────

export interface ScoredSymbol {
	symbol: CodeSymbol;
	score: number;
}

/** 语义搜索符号（同步）：BM25 打分（embedding 未就绪/无 provider 时的默认路径） */
export function searchSymbols(index: ProjectIndex, query: string, topK = 10): ScoredSymbol[] {
	if (!query.trim()) return [];
	const cache = ensureSemanticIndex(index);
	if (cache.symbolBm25.n === 0) return [];
	const tokens = tokenize(query);
	if (!tokens.length) return [];

	const results: ScoredSymbol[] = [];
	for (const id of cache.symbolVectors.keys()) {
		const score = bm25Score(cache.symbolBm25, tokens, id);
		if (score > 0) {
			const sym = index.symbols[id];
			if (sym) results.push({ symbol: sym, score });
		}
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, topK);
}

export interface ScoredFile {
	filePath: string;
	score: number;
}

/** 语义搜索文件（同步）：BM25 打分 */
export function searchFiles(index: ProjectIndex, query: string, topK = 8): ScoredFile[] {
	if (!query.trim()) return [];
	const cache = ensureSemanticIndex(index);
	if (cache.fileBm25.n === 0) return [];
	const tokens = tokenize(query);
	if (!tokens.length) return [];

	const results: ScoredFile[] = [];
	for (const filePath of cache.fileVectors.keys()) {
		const score = bm25Score(cache.fileBm25, tokens, filePath);
		if (score > 0) results.push({ filePath, score });
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, topK);
}

/** 语义搜索符号（异步）：Embedding 就绪 → 向量余弦；否则回退 BM25 */
export async function searchSymbolsAsync(index: ProjectIndex, query: string, topK = 10): Promise<ScoredSymbol[]> {
	if (!query.trim()) return [];
	const cache = ensureSemanticIndex(index);

	// Embedding 路径（就绪且有向量）
	if (_embedding?.ready && _embedding.symbolVecs.size) {
		try {
			const q = await _embedding.provider.embed(query);
			if (q && q.length) {
				const results: ScoredSymbol[] = [];
				for (const [id, vec] of _embedding.symbolVecs) {
					const sim = cosineSimilarity(q, vec);
					if (sim > 0) {
						const sym = index.symbols[id];
						if (sym) results.push({ symbol: sym, score: sim });
					}
				}
				results.sort((a, b) => b.score - a.score);
				return results.slice(0, topK);
			}
		} catch { /* 回退 BM25 */ }
	}

	// BM25 回退
	if (cache.symbolBm25.n === 0) return [];
	const tokens = tokenize(query);
	if (!tokens.length) return [];
	const results: ScoredSymbol[] = [];
	for (const id of cache.symbolVectors.keys()) {
		const score = bm25Score(cache.symbolBm25, tokens, id);
		if (score > 0) {
			const sym = index.symbols[id];
			if (sym) results.push({ symbol: sym, score });
		}
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, topK);
}

/** 语义搜索文件（异步）：Embedding 就绪 → 向量余弦；否则回退 BM25 */
export async function searchFilesAsync(index: ProjectIndex, query: string, topK = 8): Promise<ScoredFile[]> {
	if (!query.trim()) return [];
	const cache = ensureSemanticIndex(index);

	if (_embedding?.ready && _embedding.fileVecs.size) {
		try {
			const q = await _embedding.provider.embed(query);
			if (q && q.length) {
				const results: ScoredFile[] = [];
				for (const [filePath, vec] of _embedding.fileVecs) {
					const sim = cosineSimilarity(q, vec);
					if (sim > 0) results.push({ filePath, score: sim });
				}
				results.sort((a, b) => b.score - a.score);
				return results.slice(0, topK);
			}
		} catch { /* 回退 BM25 */ }
	}

	if (cache.fileBm25.n === 0) return [];
	const tokens = tokenize(query);
	if (!tokens.length) return [];
	const results: ScoredFile[] = [];
	for (const filePath of cache.fileVectors.keys()) {
		const score = bm25Score(cache.fileBm25, tokens, filePath);
		if (score > 0) results.push({ filePath, score });
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, topK);
}

/** 语义索引统计 */
export function getSemanticStats(index: ProjectIndex): { symbols: number; files: number; dim: number; strategy: 'bm25' | 'embedding' | 'mixed' } {
	const cache = ensureSemanticIndex(index);
	const embeddingReady = _embedding?.ready === true && (_embedding.symbolVecs.size > 0 || _embedding.fileVecs.size > 0);
	return {
		symbols: cache.symbolVectors.size,
		files: cache.fileVectors.size,
		dim: SEMANTIC_DIM,
		strategy: embeddingReady ? 'embedding' : 'bm25',
	};
}
