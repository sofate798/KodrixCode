/*---------------------------------------------------------------------------------------------
 *  Semantic Memory v2 — 向量化记忆存储 + 语义检索（越用越聪明核心引擎）
 *
 *  方法：本地 TF-IDF 词向量 + 余弦相似度，零外部依赖
 *  优势：项目专属术语精准匹配、无需 GPU/API、毫秒级响应
 *  大厂对标：Windsurf Memories + Cursor Context + Qoder Knowledge
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getMemoryDir, getLearningLogPath } from '../paths';
import type { LearningCategory, LearningEntry } from './learningEngine';
import { isRecord, isString, isNumber } from '../utils/jsonValidator';
import { atomicWriteFileSync } from '../utils/fsSafe';
import { logger } from '../logger';

function isValidLearningEntry(v: unknown): v is LearningEntry {
	return isRecord(v) && isString(v.id) && isString(v.timestamp)
		&& isString(v.source) && isString(v.category) && isString(v.content);
}

// ── 向量索引文件 ──────────────────────────────────────────────

const INDEX_FILE_NAME = 'learning.vectors.json';
const EMBEDDING_DIM = 128; // 固定向量维度（基于术语哈希）

interface VectorIndex {
	version: number;
	dim: number;
	entries: Record<string, number[]>; // entryId → float32 vector
	updatedAt: string;
}

function getIndexPath(): string {
	return path.join(getMemoryDir(), INDEX_FILE_NAME);
}

function isValidVectorIndex(v: unknown): v is VectorIndex {
	return isRecord(v) && isNumber(v.version) && isNumber(v.dim)
		&& isRecord(v.entries) && isString(v.updatedAt);
}

function loadIndex(): VectorIndex {
	const p = getIndexPath();
	if (!fs.existsSync(p)) {
		return { version: 2, dim: EMBEDDING_DIM, entries: {}, updatedAt: new Date().toISOString() };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
		if (isValidVectorIndex(raw)) {
			return raw;
		}
		logger.warn('[SemanticMemory] loadIndex: invalid shape — resetting');
		return { version: 2, dim: EMBEDDING_DIM, entries: {}, updatedAt: new Date().toISOString() };
	} catch {
		return { version: 2, dim: EMBEDDING_DIM, entries: {}, updatedAt: new Date().toISOString() };
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

// ── 词向量编码（轻量 TF-IDF 风格） ──────────────────────────────

// 英文停用词集合（模块级常量，避免每次调用重新分配）
const EN_STOPWORDS = new Set([
	'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are',
	'was', 'not', 'but', 'you', 'all', 'can', 'has', 'had', 'her', 'his',
	'its', 'our', 'out', 'use', 'will', 'been', 'some', 'than', 'then',
	'when', 'what', 'who', 'how',
]);

// 中文 + 英文分词：提取有效 token
function tokenize(text: string): string[] {
	const tokens: string[] = [];

	// 英文单词 + 驼峰命名拆解
	const words = text.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff_]/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.split(/\s+/)
		.filter(w => w.length >= 2);

	for (const w of words) {
		// 中文：bigram 切分
		if (/[\u4e00-\u9fff]/.test(w)) {
			for (let i = 0; i < w.length - 1; i++) {
				tokens.push(w.slice(i, i + 2));
			}
			if (w.length === 1) tokens.push(w);
		} else {
			// 英文 stopwords 过滤（使用模块级常量集合）
			if (!EN_STOPWORDS.has(w) && w.length >= 2) {
				tokens.push(w);
			}
		}
	}
	return tokens;
}

// 哈希 → 固定维度向量索引
function tokenToIndices(token: string, dim: number): number[] {
	const hash = crypto.createHash('sha256').update(token).digest();
	const indices: number[] = [];
	// 每个 token 映射到 4 个维度位置
	for (let i = 0; i < 4; i++) {
		const val = hash.readUInt16BE(i * 2);
		indices.push(val % dim);
	}
	return indices;
}

// 将文本编码为稀疏向量（归一化为单位向量）
function encodeText(text: string, dim: number): number[] {
	const tokens = tokenize(text);
	const vec = new Array(dim).fill(0);
	if (tokens.length === 0) return vec;

	// TF 计数
	const tf: Record<string, number> = {};
	for (const tok of tokens) {
		tf[tok] = (tf[tok] || 0) + 1;
	}

	// IDF 近似：短 token 权重高（更具体）
	const totalTokens = tokens.length;
	for (const [tok, freq] of Object.entries(tf)) {
		const idfApprox = Math.log(1 + totalTokens / (freq + 1)) + 1;
		const indices = tokenToIndices(tok, dim);
		for (const idx of indices) {
			vec[idx] += (freq / totalTokens) * idfApprox;
		}
	}

	// L2 归一化
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
	if (norm > 0) {
		for (let i = 0; i < dim; i++) vec[i] /= norm;
	}
	return vec;
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
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

export function indexLearningEntry(entry: LearningEntry): void {
	const enabled = vscode.workspace.getConfiguration('minicode.features').get<boolean>('semanticMemory', true);
	if (!enabled) return;

	const idx = loadIndex();
	const vec = encodeText(entry.content, idx.dim);
	idx.entries[entry.id] = vec;
	saveIndex(idx);
	invalidateEntryCache();
}

export interface ScoredMemory {
	entry: LearningEntry;
	score: number;
}

/**
 * 语义搜索：给定查询文本，返回最相似的前 K 条记忆
 * 加入时间衰减：越新的记忆权重越高
 */
export function searchSimilar(query: string, topK = 5): ScoredMemory[] {
	if (!query.trim()) return [];

	const idx = loadIndex();
	if (Object.keys(idx.entries).length === 0) return [];

	const queryVec = encodeText(query, idx.dim);

	// 使用缓存读取 learning entries，避免重复读盘
	const entries = getCachedEntries();

	// 相似度 + 时间衰减
	const now = Date.now();
	const halfLife = 30 * 24 * 60 * 60 * 1000; // 30 天半衰期
	const scored: ScoredMemory[] = [];

	for (const entry of entries) {
		const vec = idx.entries[entry.id];
		if (!vec) continue;

		const sim = cosineSimilarity(queryVec, vec);

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
export function getSemanticContext(query: string, maxChars = 1200): string {
	const results = searchSimilar(query, 5);
	if (!results.length) return '';

	const lines = ['[Semantic Memory — 项目相关记忆]'];
	for (const r of results) {
		const prefix = r.score > 0.3 ? '★★★' : r.score > 0.15 ? '★★' : '★';
		lines.push(`- ${prefix} [${r.entry.category}] ${r.entry.content}`);
	}
	const text = lines.join('\n');
	return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

/**
 * 获取与当前上下文最相关的记忆（无查询时使用学习条目摘要）
 */
export function getTopicalMemories(contextHint: string, maxEntries = 3): ScoredMemory[] {
	const query = contextHint.slice(0, 500); // 截断过长上下文
	return searchSimilar(query, maxEntries);
}

/**
 * 重建全部索引（批量处理所有学习条目）
 */
export function rebuildIndex(): { total: number; indexed: number } {
	invalidateEntryCache();
	const logPath = getLearningLogPath();
	if (!fs.existsSync(logPath)) return { total: 0, indexed: 0 };

	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	const idx: VectorIndex = { version: 2, dim: EMBEDDING_DIM, entries: {}, updatedAt: new Date().toISOString() };

	let indexed = 0;
	for (const line of lines) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (isValidLearningEntry(parsed) && parsed.id && parsed.content) {
				idx.entries[parsed.id] = encodeText(parsed.content, EMBEDDING_DIM);
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
export function getSemanticStats(): { totalVectors: number; indexSize: string; dim: number } {
	const idx = loadIndex();
	const p = getIndexPath();
	const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
	return {
		totalVectors: Object.keys(idx.entries).length,
		indexSize: size > 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)}MB` : `${(size / 1024).toFixed(0)}KB`,
		dim: idx.dim,
	};
}

/**
 * 智能学习建议：基于搜索发现记忆空白
 */
export function suggestLearningGaps(context: string): string[] {
	const results = searchSimilar(context, 10);
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
