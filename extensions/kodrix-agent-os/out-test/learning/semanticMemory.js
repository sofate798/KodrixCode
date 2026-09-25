"use strict";
/*---------------------------------------------------------------------------------------------
 *  Semantic Memory v2 — 向量化记忆存储 + 语义检索（越用越聪明核心引擎）
 *
 *  方法：本地 TF-IDF 词向量 + 余弦相似度，零外部依赖
 *  优势：项目专属术语精准匹配、无需 GPU/API、毫秒级响应
 *  大厂对标：Windsurf Memories + Cursor Context + Qoder Knowledge
 *--------------------------------------------------------------------------------------------*/
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateEntryCache = invalidateEntryCache;
exports.indexLearningEntry = indexLearningEntry;
exports.searchSimilar = searchSimilar;
exports.getSemanticContext = getSemanticContext;
exports.getTopicalMemories = getTopicalMemories;
exports.rebuildIndex = rebuildIndex;
exports.getSemanticStats = getSemanticStats;
exports.suggestLearningGaps = suggestLearningGaps;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const paths_1 = require("../paths");
const jsonValidator_1 = require("../utils/jsonValidator");
const fsSafe_1 = require("../utils/fsSafe");
const logger_1 = require("../logger");
const textVector_1 = require("../utils/textVector");
function isValidLearningEntry(v) {
    return (0, jsonValidator_1.isRecord)(v) && (0, jsonValidator_1.isString)(v.id) && (0, jsonValidator_1.isString)(v.timestamp)
        && (0, jsonValidator_1.isString)(v.source) && (0, jsonValidator_1.isString)(v.category) && (0, jsonValidator_1.isString)(v.content);
}
// ── 向量索引文件 ──────────────────────────────────────────────
const INDEX_FILE_NAME = 'learning.vectors.json';
const EMBEDDING_DIM = 128; // 固定向量维度（基于术语哈希）
function getIndexPath() {
    return path.join((0, paths_1.getMemoryDir)(), INDEX_FILE_NAME);
}
function isValidVectorIndex(v) {
    return (0, jsonValidator_1.isRecord)(v) && (0, jsonValidator_1.isNumber)(v.version) && (0, jsonValidator_1.isNumber)(v.dim)
        && (0, jsonValidator_1.isRecord)(v.entries) && (0, jsonValidator_1.isString)(v.updatedAt);
}
function loadIndex() {
    const p = getIndexPath();
    if (!fs.existsSync(p)) {
        return { version: 2, dim: EMBEDDING_DIM, entries: {}, updatedAt: new Date().toISOString() };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (isValidVectorIndex(raw)) {
            return raw;
        }
        logger_1.logger.warn('[SemanticMemory] loadIndex: invalid shape — resetting');
        return { version: 2, dim: EMBEDDING_DIM, entries: {}, updatedAt: new Date().toISOString() };
    }
    catch {
        return { version: 2, dim: EMBEDDING_DIM, entries: {}, updatedAt: new Date().toISOString() };
    }
}
function saveIndex(idx) {
    const p = getIndexPath();
    idx.updatedAt = new Date().toISOString();
    // Prune old entries not in learning log
    const logPath = (0, paths_1.getLearningLogPath)();
    if (fs.existsSync(logPath)) {
        const validIds = new Set();
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.id)
                    validIds.add(entry.id);
            }
            catch { /* skip */ }
        }
        for (const id of Object.keys(idx.entries)) {
            if (!validIds.has(id))
                delete idx.entries[id];
        }
    }
    (0, fsSafe_1.atomicWriteFileSync)(p, JSON.stringify(idx, null, 2));
}
let _entryCache;
/** 读取 learning entries，优先使用缓存；文件变更时自动失效 */
function getCachedEntries() {
    const logPath = (0, paths_1.getLearningLogPath)();
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
        const entries = [];
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (isValidLearningEntry(parsed)) {
                    entries.push(parsed);
                }
            }
            catch { /* skip corrupt line */ }
        }
        _entryCache = { entries, logMtime: mtime };
        return entries;
    }
    catch {
        return _entryCache?.entries ?? [];
    }
}
/** 主动使缓存失效（写入新条目后调用） */
function invalidateEntryCache() {
    _entryCache = undefined;
}
// ── 公开 API ───────────────────────────────────────────────────
function indexLearningEntry(entry) {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('semanticMemory', true);
    if (!enabled)
        return;
    const idx = loadIndex();
    const vec = (0, textVector_1.encodeText)(entry.content, idx.dim);
    idx.entries[entry.id] = vec;
    saveIndex(idx);
    invalidateEntryCache();
}
/**
 * 语义搜索：给定查询文本，返回最相似的前 K 条记忆
 * 加入时间衰减：越新的记忆权重越高
 */
function searchSimilar(query, topK = 5) {
    if (!query.trim())
        return [];
    const idx = loadIndex();
    if (Object.keys(idx.entries).length === 0)
        return [];
    const queryVec = (0, textVector_1.encodeText)(query, idx.dim);
    // 使用缓存读取 learning entries，避免重复读盘
    const entries = getCachedEntries();
    // 相似度 + 时间衰减
    const now = Date.now();
    const halfLife = 30 * 24 * 60 * 60 * 1000; // 30 天半衰期
    const scored = [];
    for (const entry of entries) {
        const vec = idx.entries[entry.id];
        if (!vec)
            continue;
        const sim = (0, textVector_1.cosineSimilarity)(queryVec, vec);
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
function getSemanticContext(query, maxChars = 1200) {
    const results = searchSimilar(query, 5);
    if (!results.length)
        return '';
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
function getTopicalMemories(contextHint, maxEntries = 3) {
    const query = contextHint.slice(0, 500); // 截断过长上下文
    return searchSimilar(query, maxEntries);
}
/**
 * 重建全部索引（批量处理所有学习条目）
 */
function rebuildIndex() {
    invalidateEntryCache();
    const logPath = (0, paths_1.getLearningLogPath)();
    if (!fs.existsSync(logPath))
        return { total: 0, indexed: 0 };
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const idx = { version: 2, dim: EMBEDDING_DIM, entries: {}, updatedAt: new Date().toISOString() };
    let indexed = 0;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (isValidLearningEntry(parsed) && parsed.id && parsed.content) {
                idx.entries[parsed.id] = (0, textVector_1.encodeText)(parsed.content, EMBEDDING_DIM);
                indexed++;
            }
        }
        catch { /* skip */ }
    }
    saveIndex(idx);
    return { total: lines.length, indexed };
}
/**
 * 获取语义记忆统计
 */
function getSemanticStats() {
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
function suggestLearningGaps(context) {
    const results = searchSimilar(context, 10);
    // 如果没有任何高度相关的记忆 → 提示用户补充
    if (!results.length || results[0].score < 0.1) {
        return ['未找到相关项目记忆 — 使用 Ctrl+Shift+Alt+M 沉淀当前知识'];
    }
    const gaps = [];
    const categories = new Set(results.map(r => r.entry.category));
    const allCats = ['architecture', 'convention', 'pattern', 'pitfall', 'preference'];
    for (const cat of allCats) {
        if (!categories.has(cat)) {
            gaps.push(`缺少「${cat}」类别的记忆，建议补充`);
        }
    }
    return gaps;
}
