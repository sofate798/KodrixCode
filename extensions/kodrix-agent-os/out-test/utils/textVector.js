"use strict";
/*---------------------------------------------------------------------------------------------
 *  Text Vector — 轻量 TF-IDF 词向量工具（零外部依赖）
 *
 *  供 Semantic Memory 与 Codebase Semantic Index 共享：
 *  1. tokenize：英文（含驼峰拆解 + 停用词过滤）+ 中文 bigram 切分
 *  2. encodeText：哈希 → 固定维度稀疏向量（TF 计数 + IDF 近似 + L2 归一化）
 *  3. cosineSimilarity：余弦相似度
 *
 *  大厂对标：Windsurf Memories 向量化 + Cursor 代码语义检索的本地化实现
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
exports.EN_STOPWORDS = void 0;
exports.tokenize = tokenize;
exports.tokenToIndices = tokenToIndices;
exports.encodeText = encodeText;
exports.cosineSimilarity = cosineSimilarity;
const crypto = __importStar(require("crypto"));
// ── 停用词与分词 ────────────────────────────────────────────────
// 英文停用词集合（模块级常量，避免每次调用重新分配）
exports.EN_STOPWORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are',
    'was', 'not', 'but', 'you', 'all', 'can', 'has', 'had', 'her', 'his',
    'its', 'our', 'out', 'use', 'will', 'been', 'some', 'than', 'then',
    'when', 'what', 'who', 'how',
]);
/** 中文 + 英文分词：提取有效 token（英文停用词过滤、中文 bigram 切分） */
function tokenize(text) {
    const tokens = [];
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
            if (w.length === 1)
                tokens.push(w);
        }
        else {
            // 英文 stopwords 过滤（使用模块级常量集合）
            if (!exports.EN_STOPWORDS.has(w) && w.length >= 2) {
                tokens.push(w);
            }
        }
    }
    return tokens;
}
// ── 向量编码 ────────────────────────────────────────────────────
/** 哈希 → 固定维度向量索引（每个 token 映射到 4 个维度位置） */
function tokenToIndices(token, dim) {
    const hash = crypto.createHash('sha256').update(token).digest();
    const indices = [];
    for (let i = 0; i < 4; i++) {
        const val = hash.readUInt16BE(i * 2);
        indices.push(val % dim);
    }
    return indices;
}
/** 将文本编码为稀疏向量（归一化为单位向量） */
function encodeText(text, dim) {
    const tokens = tokenize(text);
    const vec = new Array(dim).fill(0);
    if (tokens.length === 0)
        return vec;
    // TF 计数
    const tf = {};
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
        for (let i = 0; i < dim; i++)
            vec[i] /= norm;
    }
    return vec;
}
/** 余弦相似度（两个等长向量） */
function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
