"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureSemanticIndex = ensureSemanticIndex;
exports.invalidateSemanticIndex = invalidateSemanticIndex;
exports.registerEmbeddingProvider = registerEmbeddingProvider;
exports.clearEmbeddingProvider = clearEmbeddingProvider;
exports.getEmbeddingProvider = getEmbeddingProvider;
exports.buildSymbolDoc = buildSymbolDoc;
exports.buildFileDoc = buildFileDoc;
exports.searchSymbols = searchSymbols;
exports.searchFiles = searchFiles;
exports.searchSymbolsAsync = searchSymbolsAsync;
exports.searchFilesAsync = searchFilesAsync;
exports.getSemanticStats = getSemanticStats;
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
        if (!tokens.length)
            continue;
        const tf = new Map();
        for (const tok of tokens)
            tf.set(tok, (tf.get(tok) || 0) + 1);
        docs.set(id, tf);
        len.set(id, tokens.length);
        totalLen += tokens.length;
        count++;
        for (const tok of new Set(tokens))
            df.set(tok, (df.get(tok) || 0) + 1);
    }
    return { docs, len, avgLen: count ? totalLen / count : 0, df, n: count };
}
/** BM25 打分（标准公式） */
function bm25Score(store, queryTokens, docId) {
    const tf = store.docs.get(docId);
    if (!tf || !store.n)
        return 0;
    const docLen = store.len.get(docId) ?? 0;
    const denom = store.avgLen > 0 ? 1 - BM25_B + BM25_B * (docLen / store.avgLen) : 1;
    let score = 0;
    for (const tok of queryTokens) {
        const f = tf.get(tok) || 0;
        if (!f)
            continue;
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
    if (_cache && _cacheIndex === index)
        return _cache;
    if (!index || !index.symbols) {
        return { symbolVectors: new Map(), fileVectors: new Map(), symbolBm25: buildBm25([]), fileBm25: buildBm25([]) };
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
    _cache = { symbolVectors, fileVectors, symbolBm25, fileBm25 };
    _cacheIndex = index;
    // Embedding 已注册但索引后到（register 早于首次 ensure）→ 补预热
    if (_embedding && !_embedding.ready && !_embedding.building) {
        void warmupEmbedding();
    }
    logger_1.logger.debug(`[SemanticIndex] built ${symbolVectors.size} symbols + ${fileVectors.size} files (BM25) in ${Date.now() - start}ms`);
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
    _embedding = { provider, symbolVecs: new Map(), fileVecs: new Map(), ready: false };
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
    if (!_embedding)
        return;
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
                    if (vec)
                        state.symbolVecs.set(sym.id, vec);
                });
            }
            else {
                for (const sym of Object.values(idx.symbols)) {
                    const vec = await state.provider.embed(buildSymbolDoc(sym));
                    if (vec)
                        state.symbolVecs.set(sym.id, vec);
                }
            }
            const byFile = new Map();
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
                    if (vec)
                        state.fileVecs.set(fp, vec);
                });
            }
            else {
                for (const [filePath, syms] of byFile) {
                    const vec = await state.provider.embed(buildFileDoc(idx, filePath, syms));
                    if (vec)
                        state.fileVecs.set(filePath, vec);
                }
            }
            state.ready = true;
            logger_1.logger.info(`[SemanticIndex] Embedding warmup done: ${state.symbolVecs.size} symbols + ${state.fileVecs.size} files`);
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
        if (parentName)
            parts.push(parentName);
    }
    if (sym.signature)
        parts.push(sym.signature);
    if (sym.docComment)
        parts.push(sym.docComment);
    return parts.join(' ');
}
/** 文件语义文档：相对路径 + 文件内符号名聚合（限制数量防噪声） */
function buildFileDoc(index, filePath, symbols) {
    const rel = index.files[filePath]?.relativePath ?? filePath.replace(/\\/g, '/');
    const parts = [rel];
    for (const s of symbols.slice(0, 100)) {
        parts.push(s.name);
        // 文档注释进入文件语义文档，提升中文/自然语言查询的文件级召回
        if (s.docComment)
            parts.push(s.docComment.slice(0, 80));
    }
    return parts.join(' ');
}
/** 语义搜索符号（同步）：BM25 打分（embedding 未就绪/无 provider 时的默认路径） */
function searchSymbols(index, query, topK = 10) {
    if (!query.trim())
        return [];
    const cache = ensureSemanticIndex(index);
    if (cache.symbolBm25.n === 0)
        return [];
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length)
        return [];
    const results = [];
    for (const id of cache.symbolVectors.keys()) {
        const score = bm25Score(cache.symbolBm25, tokens, id);
        if (score > 0) {
            const sym = index.symbols[id];
            if (sym)
                results.push({ symbol: sym, score });
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/** 语义搜索文件（同步）：BM25 打分 */
function searchFiles(index, query, topK = 8) {
    if (!query.trim())
        return [];
    const cache = ensureSemanticIndex(index);
    if (cache.fileBm25.n === 0)
        return [];
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length)
        return [];
    const results = [];
    for (const filePath of cache.fileVectors.keys()) {
        const score = bm25Score(cache.fileBm25, tokens, filePath);
        if (score > 0)
            results.push({ filePath, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/** 语义搜索符号（异步）：Embedding 就绪 → 向量余弦；否则回退 BM25 */
async function searchSymbolsAsync(index, query, topK = 10) {
    if (!query.trim())
        return [];
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
                        if (sym)
                            results.push({ symbol: sym, score: sim });
                    }
                }
                results.sort((a, b) => b.score - a.score);
                return results.slice(0, topK);
            }
        }
        catch { /* 回退 BM25 */ }
    }
    // BM25 回退
    if (cache.symbolBm25.n === 0)
        return [];
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length)
        return [];
    const results = [];
    for (const id of cache.symbolVectors.keys()) {
        const score = bm25Score(cache.symbolBm25, tokens, id);
        if (score > 0) {
            const sym = index.symbols[id];
            if (sym)
                results.push({ symbol: sym, score });
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/** 语义搜索文件（异步）：Embedding 就绪 → 向量余弦；否则回退 BM25 */
async function searchFilesAsync(index, query, topK = 8) {
    if (!query.trim())
        return [];
    const cache = ensureSemanticIndex(index);
    if (_embedding?.ready && _embedding.fileVecs.size) {
        try {
            const q = await _embedding.provider.embed(query);
            if (q && q.length) {
                const results = [];
                for (const [filePath, vec] of _embedding.fileVecs) {
                    const sim = (0, textVector_1.cosineSimilarity)(q, vec);
                    if (sim > 0)
                        results.push({ filePath, score: sim });
                }
                results.sort((a, b) => b.score - a.score);
                return results.slice(0, topK);
            }
        }
        catch { /* 回退 BM25 */ }
    }
    if (cache.fileBm25.n === 0)
        return [];
    const tokens = (0, textVector_1.tokenize)(query);
    if (!tokens.length)
        return [];
    const results = [];
    for (const filePath of cache.fileVectors.keys()) {
        const score = bm25Score(cache.fileBm25, tokens, filePath);
        if (score > 0)
            results.push({ filePath, score });
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
        dim: SEMANTIC_DIM,
        strategy: embeddingReady ? 'embedding' : 'bm25',
    };
}
