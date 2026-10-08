"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
exports.ensureSemanticIndex = ensureSemanticIndex;
exports.invalidateSemanticIndex = invalidateSemanticIndex;
exports.registerEmbeddingProvider = registerEmbeddingProvider;
exports.clearEmbeddingProvider = clearEmbeddingProvider;
exports.getEmbeddingProvider = getEmbeddingProvider;
exports.buildSymbolDoc = buildSymbolDoc;
exports.buildFileDoc = buildFileDoc;
exports.clearSemanticFileCache = clearSemanticFileCache;
exports.buildBlockDoc = buildBlockDoc;
exports.searchSymbols = searchSymbols;
exports.searchFiles = searchFiles;
exports.searchSymbolsAsync = searchSymbolsAsync;
exports.searchFilesAsync = searchFilesAsync;
exports.searchBlocksAsync = searchBlocksAsync;
exports.getSemanticStats = getSemanticStats;
const fs = __importStar(require("fs"));
const textVector_1 = require("../utils/textVector");
const logger_1 = require("../logger");
/** 代码语义向量维度（比记忆索引更高，区分度更好） */
const SEMANTIC_DIM = 256;
/** BM25 参数（信息检索标准配置） */
const BM25_K1 = 1.5;
const BM25_B = 0.75;
function buildBm25(entries) {
    const docs = new Map();
    const len = new Map();
    const df = new Map();
    let totalLen = 0;
    let count = 0;
    for (const [id, text] of entries) {
        const tokens = (0, textVector_1.tokenize)(text);
        if (!tokens.length) {
            continue;
        }
        const tf = new Map();
        for (const tok of tokens) {
            tf.set(tok, (tf.get(tok) || 0) + 1);
        }
        docs.set(id, tf);
        len.set(id, tokens.length);
        totalLen += tokens.length;
        count++;
        for (const tok of new Set(tokens)) {
            df.set(tok, (df.get(tok) || 0) + 1);
        }
    }
    return { docs, len, avgLen: count ? totalLen / count : 0, df, n: count };
}
/** BM25 打分（标准公式） */
function bm25Score(store, queryTokens, docId) {
    const tf = store.docs.get(docId);
    if (!tf || !store.n) {
        return 0;
    }
    const docLen = store.len.get(docId) ?? 0;
    const denom = store.avgLen > 0 ? 1 - BM25_B + BM25_B * (docLen / store.avgLen) : 1;
    let score = 0;
    for (const tok of queryTokens) {
        const f = tf.get(tok) || 0;
        if (!f) {
            continue;
        }
        const d = store.df.get(tok) ?? 0;
        const idf = Math.log(1 + (store.n - d + 0.5) / (d + 0.5));
        score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * denom));
    }
    return score;
}
let _cache = null;
let _cacheIndex = null;
/** 构建语义缓存（绑定到 index 对象；索引重建后自动失效重建） */
function ensureSemanticIndex(index) {
    if (_cache && _cacheIndex === index) {
        return _cache;
    }
    if (!index || !index.symbols) {
        return {
            symbolVectors: new Map(), fileVectors: new Map(), blockVectors: new Map(),
            symbolBm25: buildBm25([]), fileBm25: buildBm25([]), blockBm25: buildBm25([]),
        };
    }
    const start = Date.now();
    const symbolVectors = new Map();
    const fileSymbols = new Map();
    const symbolDocs = new Map();
    for (const sym of Object.values(index.symbols)) {
        const doc = buildSymbolDoc(sym);
        symbolVectors.set(sym.id, (0, textVector_1.encodeText)(doc, SEMANTIC_DIM));
        symbolDocs.set(sym.id, doc);
        const list = fileSymbols.get(sym.filePath);
        if (list) {
            list.push(sym);
        }
        else {
            fileSymbols.set(sym.filePath, [sym]);
        }
    }
    const fileVectors = new Map();
    const fileDocs = new Map();
    for (const [filePath, syms] of fileSymbols) {
        const doc = buildFileDoc(index, filePath, syms);
        fileVectors.set(filePath, (0, textVector_1.encodeText)(doc, SEMANTIC_DIM));
        fileDocs.set(filePath, doc);
    }
    const symbolBm25 = buildBm25(symbolDocs);
    const fileBm25 = buildBm25(fileDocs);
    // ── 块级索引（语法块 = 符号完整代码文本） ──
    const blockDocs = new Map();
    const blockVectors = new Map();
    for (const sym of Object.values(index.symbols)) {
        const block = buildBlockDoc(sym);
        if (block) {
            const blockId = `block:${sym.id}`;
            blockDocs.set(blockId, block);
            blockVectors.set(blockId, (0, textVector_1.encodeText)(block, SEMANTIC_DIM));
        }
    }
    const blockBm25 = buildBm25(blockDocs);
    _cache = { symbolVectors, fileVectors, blockVectors, symbolBm25, fileBm25, blockBm25 };
    _cacheIndex = index;
    // Embedding 已注册但索引后到（register 早于首次 ensure）→ 补预热
    if (_embedding && !_embedding.ready && !_embedding.building) {
        void warmupEmbedding();
    }
    logger_1.logger.debug(`[SemanticIndex] built ${symbolVectors.size} symbols + ${fileVectors.size} files + ${blockVectors.size} blocks (BM25) in ${Date.now() - start}ms`);
    return _cache;
}
/** 主动失效（供调试/测试） */
function invalidateSemanticIndex() {
    _cache = null;
    _cacheIndex = null;
    _embedding = null;
}
let _embedding = null;
/** 注册外部 Embedding 模型/API（真向量检索；注册后异步预热文档向量） */
function registerEmbeddingProvider(provider) {
    _embedding = { provider, symbolVecs: new Map(), fileVecs: new Map(), blockVecs: new Map(), ready: false };
    void warmupEmbedding();
    logger_1.logger.info(`[SemanticIndex] Embedding provider registered: ${provider.name}（预热中）`);
}
/** 清除 embedding provider（配置关闭时回退 BM25） */
function clearEmbeddingProvider() {
    _embedding = null;
}
/** 当前 embedding 提供方 */
function getEmbeddingProvider() {
    return _embedding?.provider ?? null;
}
/** 预热文档向量（异步；完成后 ready=true，检索走向量路径） */
async function warmupEmbedding() {
    if (!_embedding) {
        return;
    }
    const idx = _cacheIndex;
    if (!idx || !idx.symbols) {
        // 索引尚未建立：保持未 ready，待 ensureSemanticIndex 建立后补预热
        _embedding.building = undefined;
        return;
    }
    const state = _embedding;
    state.building = (async () => {
        try {
            /**
             * 分块嵌入：此前把**全仓**符号/文件/块塞进单个 embedBatch 请求，
             * 大仓必然触发服务端体积/条数限制 → 整场预热失败 → 整会话静默回退 BM25。
             * 现在按批切分，单批失败只影响该批（其余向量照常可用）。
             */
            const EMBED_BATCH_SIZE = 64;
            const embedChunked = async (items, toText, onVec, label) => {
                for (let i = 0; i < items.length; i += EMBED_BATCH_SIZE) {
                    const chunk = items.slice(i, i + EMBED_BATCH_SIZE);
                    try {
                        if (state.provider.embedBatch) {
                            const vecs = await state.provider.embedBatch(chunk.map(toText));
                            chunk.forEach((item, k) => {
                                const vec = vecs[k];
                                if (vec) {
                                    onVec(item, vec);
                                }
                            });
                        }
                        else {
                            for (const item of chunk) {
                                const vec = await state.provider.embed(toText(item));
                                if (vec) {
                                    onVec(item, vec);
                                }
                            }
                        }
                    }
                    catch (err) {
                        logger_1.logger.warn(`[SemanticIndex] ${label} 第 ${i}–${i + chunk.length} 条嵌入失败（该批回退 BM25）：${err instanceof Error ? err.message : String(err)}`);
                    }
                    // 让出事件循环：分块调用依旧可能连续触发大量网络/CPU 工作
                    await new Promise(resolve => setImmediate(resolve));
                }
            };
            const allSymbols = Object.values(idx.symbols);
            await embedChunked(allSymbols, sym => buildSymbolDoc(sym), (sym, vec) => { state.symbolVecs.set(sym.id, vec); }, '符号向量');
            const byFile = new Map();
            for (const sym of allSymbols) {
                const list = byFile.get(sym.filePath) || [];
                list.push(sym);
                byFile.set(sym.filePath, list);
            }
            const fileEntries = [...byFile.entries()];
            await embedChunked(fileEntries, ([fp, syms]) => buildFileDoc(idx, fp, syms), ([fp], vec) => { state.fileVecs.set(fp, vec); }, '文件向量');
            // ── 块级向量预热 ──
            const blockTexts = [];
            for (const sym of allSymbols) {
                const text = buildBlockDoc(sym);
                if (text) {
                    blockTexts.push({ blockId: `block:${sym.id}`, text });
                }
            }
            await embedChunked(blockTexts, b => b.text, (b, vec) => { state.blockVecs.set(b.blockId, vec); }, '块向量');
            state.ready = true;
            logger_1.logger.info(`[SemanticIndex] Embedding warmup done: ${state.symbolVecs.size}/${allSymbols.length} symbols + ${state.fileVecs.size}/${fileEntries.length} files + ${state.blockVecs.size}/${blockTexts.length} blocks`);
        }
        catch (err) {
            logger_1.logger.warn(`[SemanticIndex] Embedding warmup failed（回退 BM25）: ${err instanceof Error ? err.message : String(err)}`);
            state.ready = true; // 空向量 → 检索回退 BM25
        }
    })();
    await state.building;
}
// ── 文档构建 ────────────────────────────────────────────────────
/** 符号语义文档：名称 + 类型 + 父符号 + 签名 + 文档注释 */
function buildSymbolDoc(sym) {
    const parts = [sym.name, sym.kind];
    if (sym.parentId) {
        const parentName = sym.parentId.split('#')[1];
        if (parentName) {
            parts.push(parentName);
        }
    }
    if (sym.signature) {
        parts.push(sym.signature);
    }
    if (sym.docComment) {
        parts.push(sym.docComment);
    }
    return parts.join(' ');
}
/** 文件语义文档：相对路径 + 文件内符号名聚合（限制数量防噪声） */
function buildFileDoc(index, filePath, symbols) {
    const rel = index.files[filePath]?.relativePath ?? filePath.replace(/\\/g, '/');
    const parts = [rel];
    for (const s of symbols.slice(0, 100)) {
        parts.push(s.name);
        // 文档注释进入文件语义文档，提升中文/自然语言查询的文件级召回
        if (s.docComment) {
            parts.push(s.docComment.slice(0, 80));
        }
    }
    return parts.join(' ');
}
/**
 * 文件行缓存（按 mtime 失效）。
 * `buildBlockDoc` 对**同一文件的每个符号**都会被调用（块向量预热 + 每次检索命中），
 * 此前每次都整文件读盘：预热阶段等于把整个仓库重复读 N 遍。这里按 mtime 复用。
 */
const FILE_LINE_CACHE_MAX = 200;
const _fileLineCache = new Map();
function getCachedFileLines(filePath) {
    try {
        const stat = fs.statSync(filePath);
        const cached = _fileLineCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.lines;
        }
        const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
        if (_fileLineCache.size >= FILE_LINE_CACHE_MAX) {
            _fileLineCache.clear();
        }
        _fileLineCache.set(filePath, { mtimeMs: stat.mtimeMs, lines });
        return lines;
    }
    catch {
        return null;
    }
}
/** 清空文件行缓存（索引重建 / 需要强一致时调用） */
function clearSemanticFileCache() {
    _fileLineCache.clear();
}
/**
 * 块级语义文档：提取符号对应的完整源代码文本。
 * 用于语法块级 embedding 检索（对标 Cursor syntax-block embedding）。
 *
 * 策略：
 * - 有 endLine 时直接截取（TS AST 精确位置）
 * - 无 endLine 时启发式扫描（空白行 / 缩进回退 / 最大行数）
 * - 截断至 200 行，避免过大块影响 embedding 质量
 */
function buildBlockDoc(sym) {
    try {
        const lines = getCachedFileLines(sym.filePath);
        if (!lines) {
            return null;
        }
        const startIdx = Math.max(0, sym.line - 1);
        let endIdx;
        if (sym.endLine && sym.endLine > sym.line) {
            // 精确结束位置（TS AST 提供）
            endIdx = Math.min(sym.endLine, lines.length);
        }
        else {
            // 启发式：向前扫描，遇空白行 / 缩进回退 / 最大行数停止
            const MAX_BLOCK_LINES = 200;
            const startIndent = (lines[startIdx].match(/^(\s*)/) || [''])[1].length;
            endIdx = startIdx + 1;
            while (endIdx < lines.length && endIdx - startIdx < MAX_BLOCK_LINES) {
                const line = lines[endIdx];
                if (line.trim() === '') {
                    endIdx++;
                    break;
                }
                const indent = (line.match(/^(\s*)/) || [''])[1].length;
                if (indent <= startIndent && endIdx > startIdx + 1) {
                    break;
                }
                endIdx++;
            }
        }
        const blockText = lines.slice(startIdx, endIdx).join('\n').trim();
        return blockText || null;
    }
    catch {
        return null;
    }
}
/** 语义搜索符号（同步）：BM25 打分（embedding 未就绪/无 provider 时的默认路径） */
function searchSymbols(index, query, topK = 10) {
    if (!query.trim()) {
        return [];
    }
    const cache = ensureSemanticIndex(index);
    if (cache.symbolBm25.n === 0) {
        return [];
    }
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length) {
        return [];
    }
    const results = [];
    for (const id of cache.symbolVectors.keys()) {
        const score = bm25Score(cache.symbolBm25, tokens, id);
        if (score > 0) {
            const sym = index.symbols[id];
            if (sym) {
                results.push({ symbol: sym, score });
            }
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/** 语义搜索文件（同步）：BM25 打分 */
function searchFiles(index, query, topK = 8) {
    if (!query.trim()) {
        return [];
    }
    const cache = ensureSemanticIndex(index);
    if (cache.fileBm25.n === 0) {
        return [];
    }
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length) {
        return [];
    }
    const results = [];
    for (const filePath of cache.fileVectors.keys()) {
        const score = bm25Score(cache.fileBm25, tokens, filePath);
        if (score > 0) {
            results.push({ filePath, score });
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/** 语义搜索符号（异步）：Embedding 就绪 → 向量余弦；否则回退 BM25 */
async function searchSymbolsAsync(index, query, topK = 10) {
    if (!query.trim()) {
        return [];
    }
    const cache = ensureSemanticIndex(index);
    // Embedding 路径（就绪且有向量）
    if (_embedding?.ready && _embedding.symbolVecs.size) {
        try {
            const q = await _embedding.provider.embed(query);
            if (q && q.length) {
                const results = [];
                for (const [id, vec] of _embedding.symbolVecs) {
                    const sim = (0, textVector_1.cosineSimilarity)(q, vec);
                    if (sim > 0) {
                        const sym = index.symbols[id];
                        if (sym) {
                            results.push({ symbol: sym, score: sim });
                        }
                    }
                }
                results.sort((a, b) => b.score - a.score);
                return results.slice(0, topK);
            }
        }
        catch { /* 回退 BM25 */ }
    }
    // BM25 回退
    if (cache.symbolBm25.n === 0) {
        return [];
    }
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length) {
        return [];
    }
    const results = [];
    for (const id of cache.symbolVectors.keys()) {
        const score = bm25Score(cache.symbolBm25, tokens, id);
        if (score > 0) {
            const sym = index.symbols[id];
            if (sym) {
                results.push({ symbol: sym, score });
            }
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/** 语义搜索文件（异步）：Embedding 就绪 → 向量余弦；否则回退 BM25 */
async function searchFilesAsync(index, query, topK = 8) {
    if (!query.trim()) {
        return [];
    }
    const cache = ensureSemanticIndex(index);
    if (_embedding?.ready && _embedding.fileVecs.size) {
        try {
            const q = await _embedding.provider.embed(query);
            if (q && q.length) {
                const results = [];
                for (const [filePath, vec] of _embedding.fileVecs) {
                    const sim = (0, textVector_1.cosineSimilarity)(q, vec);
                    if (sim > 0) {
                        results.push({ filePath, score: sim });
                    }
                }
                results.sort((a, b) => b.score - a.score);
                return results.slice(0, topK);
            }
        }
        catch { /* 回退 BM25 */ }
    }
    if (cache.fileBm25.n === 0) {
        return [];
    }
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length) {
        return [];
    }
    const results = [];
    for (const filePath of cache.fileVectors.keys()) {
        const score = bm25Score(cache.fileBm25, tokens, filePath);
        if (score > 0) {
            results.push({ filePath, score });
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/** 语义搜索语法块（异步）：Embedding 就绪 → 向量余弦；否则回退 BM25 */
async function searchBlocksAsync(index, query, topK = 10) {
    if (!query.trim()) {
        return [];
    }
    const cache = ensureSemanticIndex(index);
    // Embedding 路径
    if (_embedding?.ready && _embedding.blockVecs.size) {
        try {
            const q = await _embedding.provider.embed(query);
            if (q && q.length) {
                const results = [];
                for (const [blockId, vec] of _embedding.blockVecs) {
                    const sim = (0, textVector_1.cosineSimilarity)(q, vec);
                    if (sim > 0) {
                        const symId = blockId.replace(/^block:/, '');
                        const sym = index.symbols[symId];
                        if (sym) {
                            const text = buildBlockDoc(sym);
                            if (text) {
                                results.push({
                                    block: {
                                        id: blockId,
                                        filePath: sym.filePath,
                                        startLine: sym.line,
                                        endLine: sym.endLine ?? sym.line,
                                        text,
                                        symbolId: sym.id,
                                        symbolName: sym.name,
                                        symbolKind: sym.kind,
                                    },
                                    score: sim,
                                });
                            }
                        }
                    }
                }
                results.sort((a, b) => b.score - a.score);
                return results.slice(0, topK);
            }
        }
        catch { /* 回退 BM25 */ }
    }
    // BM25 回退
    if (cache.blockBm25.n === 0) {
        return [];
    }
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length) {
        return [];
    }
    const results = [];
    for (const blockId of cache.blockVectors.keys()) {
        const score = bm25Score(cache.blockBm25, tokens, blockId);
        if (score > 0) {
            const symId = blockId.replace(/^block:/, '');
            const sym = index.symbols[symId];
            if (sym) {
                const text = buildBlockDoc(sym);
                if (text) {
                    results.push({
                        block: {
                            id: blockId,
                            filePath: sym.filePath,
                            startLine: sym.line,
                            endLine: sym.endLine ?? sym.line,
                            text,
                            symbolId: sym.id,
                            symbolName: sym.name,
                            symbolKind: sym.kind,
                        },
                        score,
                    });
                }
            }
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/** 语义索引统计 */
function getSemanticStats(index) {
    const cache = ensureSemanticIndex(index);
    const embeddingReady = _embedding?.ready === true && (_embedding.symbolVecs.size > 0 || _embedding.fileVecs.size > 0);
    return {
        symbols: cache.symbolVectors.size,
        files: cache.fileVectors.size,
        blocks: cache.blockVectors.size,
        dim: SEMANTIC_DIM,
        strategy: embeddingReady ? 'embedding' : 'bm25',
    };
}
