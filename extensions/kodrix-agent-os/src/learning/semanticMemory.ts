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
import type { LearningCategory, LearningEntry } from './learningEngine';
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

/** 注入 EmbeddingProvider（由 extension.ts 的 syncEmbeddingProvider 调用） */
export function setEmbeddingProvider(provider: EmbeddingProvider | undefined): void {
	_embeddingProvider = provider;
	if (provider) {
		logger.info(`[SemanticMemory] EmbeddingProvider 已注入: ${provider.name}，将使用真实向量`);
	} else {
		logger.info('[SemanticMemory] EmbeddingProvider 已清除，回退到 TF-IDF 哈希向量');
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
	return { version: INDEX_VERSION, dim, entries: {}, updatedAt: new Date().toISOString() };
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
				return { ...raw, version: INDEX_VERSION };
			}
			return raw;
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
	// Prune old entries not in learning log
	const logPath = getLearningLogPath();
	if (fs.existsSync(logPath)) {
		const validIds = new Set<string>();
		const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.id) validIds.add(entry.id);
			} catch { /* skip */ }
		}
		for (const id of Object.keys(idx.entries)) {
			if (!validIds.has(id)) delete idx.entries[id];
		}
	}
	atomicWriteFileSync(p, JSON.stringify(idx, null, 2));
}

// ── 向量编码 ──────────────────────────────────────────────────────

/** 使用真实 EmbeddingProvider 编码文本为浮点向量 */
async function encodeTextReal(text: string): Promise<number[] | undefined> {
	if (!_embeddingProvider) return undefined;
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
export async function indexLearningEntry(entry: LearningEntry): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('semanticMemory', true);
	if (!enabled) return;

	const idx = loadIndex();

	if (_embeddingProvider) {
		// 真实 embedding
		const vec = await encodeTextReal(entry.content);
		if (vec) {
			// 首次 embed 时确定维度
			if (idx.dim !== vec.length) {
				idx.dim = vec.length;
			}
			idx.entries[entry.id] = vec;
			saveIndex(idx);
		} else {
			// fallback 到 TF-IDF
			idx.entries[entry.id] = encodeVector(entry.content, idx.dim || DEFAULT_TFIDF_DIM);
			saveIndex(idx);
		}
	} else {
		// TF-IDF fallback
		const vec = encodeVector(entry.content, idx.dim || DEFAULT_TFIDF_DIM);
		idx.entries[entry.id] = vec;
		saveIndex(idx);
	}

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
	if (!query.trim()) return [];

	const idx = loadIndex();
	if (Object.keys(idx.entries).length === 0) return [];

	let queryVec: number[];

	if (_embeddingProvider) {
		const realVec = await encodeTextReal(query);
		if (realVec) {
			// 维度不匹配时回退 TF-IDF
			if (realVec.length !== idx.dim) {
				queryVec = encodeVector(query, idx.dim || DEFAULT_TFIDF_DIM);
			} else {
				queryVec = realVec;
			}
		} else {
			queryVec = encodeVector(query, idx.dim || DEFAULT_TFIDF_DIM);
		}
	} else {
		queryVec = encodeVector(query, idx.dim || DEFAULT_TFIDF_DIM);
	}

	// 使用缓存读取 learning entries，避免重复读盘
	const entries = getCachedEntries();

	// 相似度 + 时间衰减
	const now = Date.now();
	const halfLife = 30 * 24 * 60 * 60 * 1000; // 30 天半衰期
	const scored: ScoredMemory[] = [];

	for (const entry of entries) {
		const vec = idx.entries[entry.id];
		if (!vec || vec.length !== queryVec.length) continue;

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
	if (!results.length) return '';

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
export async function rebuildIndex(): Promise<{ total: number; indexed: number }> {
	invalidateEntryCache();
	const logPath = getLearningLogPath();
	if (!fs.existsSync(logPath)) return { total: 0, indexed: 0 };

	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	const idx = emptyIndex(_embeddingProvider ? DEFAULT_TFIDF_DIM : DEFAULT_TFIDF_DIM);
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
				// TF-IDF fallback
				idx.entries[parsed.id] = encodeVector(parsed.content, DEFAULT_TFIDF_DIM);
				indexed++;
			}
		} catch { /* skip */ }
	}

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

/**
 * 智能学习建议：基于搜索发现记忆空白
 */
export async function suggestLearningGaps(context: string): Promise<string[]> {
	const results = await searchSimilar(context, 10);
	// 如果没有任何高度相关的记忆 → 提示用户补充
	if (!results.length || results[0].score < 0.1) {
		return ['未找到相关项目记忆 — 使用 Ctrl+Shift+Alt+M 沉淀当前知识'];
	}

	const gaps: string[] = [];
	const categories = new Set<LearningCategory>(results.map(r => r.entry.category));
	const allCats: LearningCategory[] = ['architecture', 'convention', 'pattern', 'pitfall', 'preference'];
	for (const cat of allCats) {
		if (!categories.has(cat)) {
			gaps.push(`缺少「${cat}」类别的记忆，建议补充`);
		}
	}
	return gaps;
}
