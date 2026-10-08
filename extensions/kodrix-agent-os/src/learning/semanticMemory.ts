/*---------------------------------------------------------------------------------------------
 *  Semantic Memory v3 — 向量化记忆存储 + 语义检索（越用越聪明核心引擎）
 *
 *  v3 升级：支持真实 Embedding（通过 EmbeddingProvider 接口），任意维度浮点向量
 *  向后兼容：加载 v2 索引时自动迁移（TF-IDF 重新编码或清空重建）
 *  降级策略：无 EmbeddingProvider 时回退到 TF-IDF 哈希向量
 *  大厂对标：Windsurf Memories + Cursor Context + Qoder Knowledge
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getMemoryDir, getLearningLogPath } from '../paths';
import type { LearningEntry } from './learningEngine';
import { isRecord, isString, isNumber } from '../utils/jsonValidator';
import { atomicWriteFileSync } from '../utils/fsSafe';
import { logger } from '../logger';
import { encodeText as encodeVector, cosineSimilarity as cosineSim } from '../utils/textVector';
import type { EmbeddingProvider } from '../codebase/semanticIndex';

function isValidLearningEntry(v: unknown): v is LearningEntry {
	return isRecord(v) && isString(v.id) && isString(v.timestamp)
		&& isString(v.source) && isString(v.category) && isString(v.content);
}

// ── Embedding Provider 注入 ──────────────────────────────────────

let _embeddingProvider: EmbeddingProvider | undefined;

/** TF-IDF 回退路径的标签（索引里记录标签，避免"索引是 1536 维真实向量、查询却按 128 维 TF-IDF"的静默失配） */
const TFIDF_TAG = 'tfidf';

/** 当前应当使用的向量来源标签 */
function currentProviderTag(): string {
	return _embeddingProvider ? `provider:${_embeddingProvider.name}` : TFIDF_TAG;
}

/** 注入 EmbeddingProvider（由 extension.ts 的 syncEmbeddingProvider 调用） */
export function setEmbeddingProvider(provider: EmbeddingProvider | undefined): void {
	const before = currentProviderTag();
	_embeddingProvider = provider;
	const after = currentProviderTag();
	if (provider) {
		logger.info(`[SemanticMemory] EmbeddingProvider 已注入: ${provider.name}，将使用真实向量`);
	} else {
		logger.info('[SemanticMemory] EmbeddingProvider 已清除，回退到 TF-IDF 哈希向量');
	}
	// 向量来源变了 → 旧向量与查询向量不同空间，必须重建，否则语义记忆会永久查不到结果（静默失效）
	if (before !== after) {
		void rebuildIndex().catch(err =>
			logger.warn(`[SemanticMemory] 向量来源切换后重建索引失败：${err instanceof Error ? err.message : String(err)}`),
		);
	}
}

/** 获取当前 EmbeddingProvider（测试 / 诊断用） */
export function getEmbeddingProvider(): EmbeddingProvider | undefined {
	return _embeddingProvider;
}

// ── 向量索引文件 ──────────────────────────────────────────────

const INDEX_FILE_NAME = 'learning.vectors.json';
const DEFAULT_TFIDF_DIM = 128; // TF-IDF 固定向量维度
const INDEX_VERSION = 3;

interface VectorIndex {
	version: number;
	dim: number; // 动态维度：首次 embed 时确定
	/** 生成本索引的向量来源（`tfidf` / `provider:<name>`）；缺失视为旧索引，按需重建 */
	providerTag?: string;
	entries: Record<string, number[]>; // entryId → float vector
	updatedAt: string;
}

function getIndexPath(): string {
	return path.join(getMemoryDir(), INDEX_FILE_NAME);
}

function isValidVectorIndex(v: unknown): v is VectorIndex {
	return isRecord(v) && isNumber(v.version) && isNumber(v.dim)
		&& isRecord(v.entries) && isString(v.updatedAt);
}

function emptyIndex(dim: number): VectorIndex {
	return { version: INDEX_VERSION, dim, providerTag: currentProviderTag(), entries: {}, updatedAt: new Date().toISOString() };
}

function loadIndex(): VectorIndex {
	const p = getIndexPath();
	if (!fs.existsSync(p)) {
		return emptyIndex(DEFAULT_TFIDF_DIM);
	}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
		if (isValidVectorIndex(raw)) {
			// v2 → v3 迁移：如果维度与当前 TF-IDF 默认一致且无 provider，保留；否则清空重建
			if (raw.version < INDEX_VERSION) {
				logger.info(`[SemanticMemory] 索引版本 v${raw.version} → v${INDEX_VERSION}，自动迁移`);
				if (_embeddingProvider) {
					// 有 provider 时清空旧 TF-IDF 向量，等待异步重建
					return emptyIndex(DEFAULT_TFIDF_DIM);
				}
				// 无 provider 时保留旧 TF-IDF 向量，升级版本号
				return { ...raw, version: INDEX_VERSION, providerTag: TFIDF_TAG };
			}
			// 向量来源不一致（例如用户关掉了 Embedding）：旧向量与查询向量不在同一空间，
			// 继续用会"每条都因维度不等被跳过"→ 语义记忆静默永远返回空。这里判定失效并触发重建。
			const tag = raw.providerTag ?? (raw.dim === DEFAULT_TFIDF_DIM ? TFIDF_TAG : 'unknown');
			if (tag !== currentProviderTag()) {
				logger.warn(`[SemanticMemory] 向量来源已变化（索引 ${tag} → 当前 ${currentProviderTag()}），重建语义索引`);
				void rebuildIndex().catch(err =>
					logger.warn(`[SemanticMemory] 重建失败：${err instanceof Error ? err.message : String(err)}`),
				);
				return emptyIndex(DEFAULT_TFIDF_DIM);
			}
			return { ...raw, providerTag: tag };
		}
		logger.warn('[SemanticMemory] loadIndex: invalid shape — resetting');
		return emptyIndex(DEFAULT_TFIDF_DIM);
	} catch {
		return emptyIndex(DEFAULT_TFIDF_DIM);
	}
}

function saveIndex(idx: VectorIndex): void {
	const p = getIndexPath();
	idx.updatedAt = new Date().toISOString();
	// Prune old entries not in learning log。
	// 只有整份日志都能解析时才敢判定"条目已被删除"：否则读取/解析失败会被误判为删除，
	// 把仍然有效的向量静默清掉（用户看到语义记忆莫名其妙变少）。
	const logPath = getLearningLogPath();
	if (fs.existsSync(logPath)) {
		const validIds = new Set<string>();
		let corrupt = 0;
		const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry && typeof entry === 'object' && (entry as { id?: unknown }).id) {
					validIds.add(String((entry as { id: unknown }).id));
				} else {
					corrupt++;
				}
			} catch {
				corrupt++;
			}
		}
		if (corrupt === 0) {
			for (const id of Object.keys(idx.entries)) {
				if (!validIds.has(id)) {delete idx.entries[id];}
			}
		} else {
			logger.warn(`[SemanticMemory] learning.jsonl 有 ${corrupt} 行异常，本次跳过向量修剪以免误删有效向量`);
		}
	}
	atomicWriteFileSync(p, JSON.stringify(idx, null, 2));
}

// ── 向量编码 ──────────────────────────────────────────────────────

/** 使用真实 EmbeddingProvider 编码文本为浮点向量 */
async function encodeTextReal(text: string): Promise<number[] | undefined> {
	if (!_embeddingProvider) {return undefined;}
	try {
		const vec = await _embeddingProvider.embed(text);
		return vec ?? undefined;
	} catch (err) {
		logger.warn('[SemanticMemory] encodeTextReal: embedding 失败，回退 TF-IDF', err);
		return undefined;
	}
}

// ── 内存缓存（避免热路径重复读盘） ──────────────────────────────

interface EntryCache {
	entries: LearningEntry[];
	logMtime: number; // 上次读取时 learning.jsonl 的 mtime（毫秒）
}

let _entryCache: EntryCache | undefined;

/** 读取 learning entries，优先使用缓存；文件变更时自动失效 */
function getCachedEntries(): LearningEntry[] {
	const logPath = getLearningLogPath();
	if (!fs.existsSync(logPath)) {
		_entryCache = undefined;
		return [];
	}
	try {
		const mtime = fs.statSync(logPath).mtimeMs;
		if (_entryCache && _entryCache.logMtime === mtime) {
			return _entryCache.entries;
		}
		const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
		const entries: LearningEntry[] = [];
		for (const line of lines) {
			try {
				const parsed: unknown = JSON.parse(line);
				if (isValidLearningEntry(parsed)) {
					entries.push(parsed);
				}
			} catch { /* skip corrupt line */ }
		}
		_entryCache = { entries, logMtime: mtime };
		return entries;
	} catch {
		return _entryCache?.entries ?? [];
	}
}

/** 主动使缓存失效（写入新条目后调用） */
export function invalidateEntryCache(): void {
	_entryCache = undefined;
}

// ── 公开 API ───────────────────────────────────────────────────

/**
 * 索引一条学习记录。
 * - 有 EmbeddingProvider 时：使用真实向量（异步）
 * - 无 EmbeddingProvider 时：使用 TF-IDF 哈希向量（同步）
 */
/**
 * 向量索引落盘防抖。
 * 单条记忆入库此前是"整读索引 + 整写索引"（索引可达数十 MB）：连续沉淀几条记忆就会
 * 反复读写几十 MB。这里把写合并到 1.5s 窗口内，并在检索前兜底落盘，保证读取方看到最新数据。
 */
const INDEX_SAVE_DEBOUNCE_MS = 1500;
let _pendingIndexSave: { timer: ReturnType<typeof setTimeout>; index: VectorIndex } | undefined;

function scheduleIndexSave(idx: VectorIndex): void {
	if (_pendingIndexSave) {clearTimeout(_pendingIndexSave.timer);}
	const timer = setTimeout(() => {
		_pendingIndexSave = undefined;
		saveIndex(idx);
	}, INDEX_SAVE_DEBOUNCE_MS);
	// 定时器不应阻止进程退出
	const maybeUnref = (timer as unknown as { unref?: unknown }).unref;
	if (typeof maybeUnref === 'function') {
		(maybeUnref as () => void).call(timer);
	}
	_pendingIndexSave = { timer, index: idx };
}

/** 立刻落盘待写的向量索引（检索前 / 需要强一致时调用） */
export function flushIndexSave(): void {
	if (!_pendingIndexSave) {return;}
	clearTimeout(_pendingIndexSave.timer);
	const { index } = _pendingIndexSave;
	_pendingIndexSave = undefined;
	saveIndex(index);
}

export async function indexLearningEntry(entry: LearningEntry): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('semanticMemory', true);
	if (!enabled) {return;}

	const idx = loadIndex();
	const tag = idx.providerTag ?? TFIDF_TAG;

	// 索引是真实向量空间：单条也必须是同样维度，否则会造成"混合维度索引"（后续查询每条都被跳过）
	if (tag !== TFIDF_TAG) {
		if (!_embeddingProvider) {
			void rebuildIndex().catch(err => logger.warn(`[SemanticMemory] 重建失败：${err instanceof Error ? err.message : String(err)}`));
			return;
		}
		const vec = await encodeTextReal(entry.content);
		if (!vec || vec.length !== idx.dim) {
			logger.warn('[SemanticMemory] 本次 embedding 不可用或维度不符，跳过单条索引（等下次整体重建）');
			return;
		}
		idx.entries[entry.id] = vec;
		scheduleIndexSave(idx);
		invalidateEntryCache();
		return;
	}

	// TF-IDF 空间：维度必须与 TF-IDF 默认一致（索引若仍是 provider 维度则先重建）
	if (idx.dim !== DEFAULT_TFIDF_DIM) {
		void rebuildIndex().catch(err => logger.warn(`[SemanticMemory] 重建失败：${err instanceof Error ? err.message : String(err)}`));
		return;
	}
	idx.entries[entry.id] = encodeVector(entry.content, DEFAULT_TFIDF_DIM);
	saveIndex(idx);
	invalidateEntryCache();
}

export interface ScoredMemory {
	entry: LearningEntry;
	score: number;
}

/**
 * 语义搜索：给定查询文本，返回最相似的前 K 条记忆
 * - 有 EmbeddingProvider 时：查询也走真实 embedding（异步）
 * - 无 EmbeddingProvider 时：TF-IDF 哈希向量（同步路径）
 * 加入时间衰减：越新的记忆权重越高
 */
export async function searchSimilar(query: string, topK = 5): Promise<ScoredMemory[]> {
	if (!query.trim()) {return [];}
	// 兜底落盘：批量沉淀时写是防抖的，检索前确保磁盘与内存一致（进程重启后不丢）
	flushIndexSave();

	const idx = loadIndex();
	if (Object.keys(idx.entries).length === 0) {return [];}

	const tag = idx.providerTag ?? (idx.dim === DEFAULT_TFIDF_DIM ? TFIDF_TAG : 'unknown');
	let queryVec: number[] | undefined;

	// 索引是真实向量时，查询也必须用真实向量（同一向量空间）
	if (tag !== TFIDF_TAG && _embeddingProvider) {
		const realVec = await encodeTextReal(query);
		if (realVec && realVec.length === idx.dim) {
			queryVec = realVec;
		}
	}
	if (!queryVec) {
		queryVec = encodeVector(query, idx.dim || DEFAULT_TFIDF_DIM);
	}
	if (queryVec.length !== idx.dim) {
		// 维度仍然不一致：继续算下去只会"每条都被跳过"→ 静默返回空。
		// 这里显式告警并触发重建，让下一次查询能拿到结果，而不是永久静默失效。
		logger.warn(`[SemanticMemory] 查询向量维度 ${queryVec.length} ≠ 索引维度 ${idx.dim}（来源 ${tag}），已触发索引重建`);
		void rebuildIndex().catch(err =>
			logger.warn(`[SemanticMemory] 重建失败：${err instanceof Error ? err.message : String(err)}`),
		);
		return [];
	}

	// 使用缓存读取 learning entries，避免重复读盘
	const entries = getCachedEntries();

	// 相似度 + 时间衰减
	const now = Date.now();
	const halfLife = 30 * 24 * 60 * 60 * 1000; // 30 天半衰期
	const scored: ScoredMemory[] = [];

	for (const entry of entries) {
		const vec = idx.entries[entry.id];
		if (!vec || vec.length !== queryVec.length) {continue;}

		const sim = cosineSim(queryVec, vec);

		// 时间衰减因子
		const age = now - new Date(entry.timestamp).getTime();
		const decay = Math.pow(0.5, age / halfLife);

		const score = sim * (0.7 + 0.3 * decay); // 70% 相似度 + 30% 新鲜度
		if (score > 0.05) {
			scored.push({ entry, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topK);
}

/**
 * 为 Agent 上下文生成智能记忆摘要
 */
export async function getSemanticContext(query: string, maxChars = 1200): Promise<string> {
	const results = await searchSimilar(query, 5);
	if (!results.length) {return '';}

	const lines = ['[Semantic Memory — 项目相关记忆]'];
	for (const r of results) {
		const prefix = r.score > 0.3 ? '高' : r.score > 0.15 ? '中' : '低';
		lines.push(`- [${prefix}] [${r.entry.category}] ${r.entry.content}`);
	}
	const text = lines.join('\n');
	return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

/**
 * 获取与当前上下文最相关的记忆（无查询时使用学习条目摘要）
 */
export async function getTopicalMemories(contextHint: string, maxEntries = 3): Promise<ScoredMemory[]> {
	const query = contextHint.slice(0, 500); // 截断过长上下文
	return searchSimilar(query, maxEntries);
}

/**
 * 重建全部索引（批量处理所有学习条目）
 * - 有 EmbeddingProvider 时：所有条目走真实 embedding
 * - 无 EmbeddingProvider 时：TF-IDF 哈希向量
 */
/** 重建单飞：多处调用（bootstrap / learningEngine / 设置页 / 来源切换）并发会互相覆盖索引 */
let _rebuildInFlight: Promise<{ total: number; indexed: number }> | undefined;

export async function rebuildIndex(): Promise<{ total: number; indexed: number }> {
	if (_rebuildInFlight) {return _rebuildInFlight;}
	_rebuildInFlight = doRebuildIndex().finally(() => { _rebuildInFlight = undefined; });
	return _rebuildInFlight;
}

async function doRebuildIndex(): Promise<{ total: number; indexed: number }> {
	invalidateEntryCache();
	const logPath = getLearningLogPath();
	if (!fs.existsSync(logPath)) {return { total: 0, indexed: 0 };}

	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	const idx = emptyIndex(DEFAULT_TFIDF_DIM);
	// 先标记为待确定维度，首次 embed 时设置
	let dimSet = false;

	let indexed = 0;
	for (const line of lines) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (isValidLearningEntry(parsed) && parsed.id && parsed.content) {
				if (_embeddingProvider) {
					const vec = await encodeTextReal(parsed.content);
					if (vec) {
						if (!dimSet) {
							idx.dim = vec.length;
							dimSet = true;
						}
						idx.entries[parsed.id] = vec;
						indexed++;
						continue;
					}
				}
				// TF-IDF fallback：维度固定为 DEFAULT_TFIDF_DIM（若前面已有真实向量则不会走到这里）
				if (!dimSet) {
					idx.dim = DEFAULT_TFIDF_DIM;
					dimSet = true;
				}
				idx.entries[parsed.id] = encodeVector(parsed.content, DEFAULT_TFIDF_DIM);
				indexed++;
			}
		} catch { /* skip */ }
	}

	// 记录本次索引的向量来源：下次 loadIndex 若发现来源变化即可判定失效并重建
	idx.providerTag = currentProviderTag();
	saveIndex(idx);
	return { total: lines.length, indexed };
}

/**
 * 获取语义记忆统计
 */
export function getSemanticStats(): { totalVectors: number; indexSize: string; dim: number; hasEmbedding: boolean } {
	const idx = loadIndex();
	const p = getIndexPath();
	const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
	return {
		totalVectors: Object.keys(idx.entries).length,
		indexSize: size > 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)}MB` : `${(size / 1024).toFixed(0)}KB`,
		dim: idx.dim,
		hasEmbedding: !!_embeddingProvider,
	};
}
