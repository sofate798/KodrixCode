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
exports.queryCodebase = queryCodebase;
exports.quickSearchSymbols = quickSearchSymbols;
exports.getFileDependencies = getFileDependencies;
exports.getFileDependents = getFileDependents;
exports.registerCodebaseChatParticipant = registerCodebaseChatParticipant;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const projectIndexer_1 = require("./projectIndexer");
const semanticIndex_1 = require("./semanticIndex");
const logger_1 = require("../logger");
const queryCache_1 = require("../utils/queryCache");
const types_1 = require("./types");
// ── 查询缓存 ────────────────────────────────────────────────────
const _queryCache = new queryCache_1.QueryCache({ maxEntries: 100, ttlMs: 30_000 });
const _symbolCache = new queryCache_1.QueryCache({ maxEntries: 100, ttlMs: 30_000 });
const _depCache = new queryCache_1.QueryCache({ maxEntries: 100, ttlMs: 30_000 });
const _dependentsCache = new queryCache_1.QueryCache({ maxEntries: 100, ttlMs: 30_000 });
// 索引状态变化时清空缓存：
//  - 'done'：新索引就绪 → 旧结果失效（原有行为）
//  - 其它状态（尤其是删除索引后的 'idle'，此时 stats 为 null）也必须清空，
//    否则 CodeLens / @codebase / 预测补全仍会从缓存里拿到"幽灵索引"的结果，
//    出现"面板显示未索引、但功能照常工作"的自相矛盾。
(0, projectIndexer_1.onIndexStateChange)((state) => {
    if (state.status === 'done' && state.stats) {
        _queryCache.clear();
        _symbolCache.clear();
        _depCache.clear();
        _dependentsCache.clear();
        return;
    }
    if (!state.stats) {
        _queryCache.clear();
        _symbolCache.clear();
        _depCache.clear();
        _dependentsCache.clear();
    }
});
const INTENT_PATTERNS = [
    {
        intent: 'definition',
        patterns: [
            /在哪(?:里)?定义/i, /where.*defin/i, /define/i,
            /定义在[哪那]/i, /.*是什么/i, /what is/i,
            /找到.*定义/i, /find.*defini/i, /show.*defini/i,
            /查看.*定义/i, /定位.*定义/i,
        ],
    },
    {
        intent: 'usage',
        patterns: [
            /哪里用[到了过]/i, /who.*use/i, /where.*use/i,
            /引用[了过]?/i, /import.*from/i,
            /哪些文件.*用/i, /used.*where/i,
        ],
    },
    {
        intent: 'callers',
        patterns: [
            /谁调[用了]/i, /caller/i, /called by/i,
            /调用了[哪谁]/i, /调用.*关系/i,
        ],
    },
    {
        intent: 'structure',
        patterns: [
            /项目结构/i, /目录结构/i, /文件结构/i,
            /project structure/i, /folder structure/i,
            /模块列表/i, /有哪些模块/i,
        ],
    },
    {
        intent: 'dependency',
        patterns: [
            /依赖|depend/i,
            /导[入了]*哪些/i, /import.*什么/i,
        ],
    },
    {
        intent: 'architecture',
        patterns: [
            /架构/i, /设计.*模式/i, /整体.*结构/i,
            /architec/i, /design pattern/i,
        ],
    },
];
function detectIntent(query) {
    for (const { intent, patterns } of INTENT_PATTERNS) {
        for (const pattern of patterns) {
            if (pattern.test(query)) {
                return intent;
            }
        }
    }
    return 'natural';
}
/** 从查询中提取目标符号名 */
function extractSymbolName(query) {
    if (!query) {
        return null;
    }
    const cleaned = query
        .replace(/在哪(?:里)?定义|where.*defin|define|定义在[哪那]|是什么|what is|找到.*定义|find.*defini|查看.*定义|定位.*定义/gi, '')
        .replace(/哪里用[到了过]|who.*use|where.*use|引用[了过]?|哪些文件.*用|used.*where/gi, '')
        .replace(/谁调[用了]|caller|called by|调用了[哪谁]|调用.*关系/gi, '')
        .replace(/项目结构|目录结构|文件结构|project structure|模块列表|有哪些模块/gi, '')
        .replace(/依赖|depend|导[入了]*哪些|import.*什么/gi, '')
        .replace(/架构|architec|design pattern/gi, '')
        .replace(/[?？!！。，,]/g, ' ')
        .trim();
    if (!cleaned) {
        return null;
    }
    // 引号内文本优先
    const quoteMatch = cleaned.match(/["'`]([^"'`]+)["'`]/);
    if (quoteMatch) {
        return quoteMatch[1];
    }
    // 驼峰 / PascalCase
    const camelMatch = cleaned.match(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/);
    if (camelMatch) {
        return camelMatch[1];
    }
    // CONST_CASE
    const constMatch = cleaned.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/);
    if (constMatch) {
        return constMatch[1];
    }
    // snake_case
    const snakeMatch = cleaned.match(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/);
    if (snakeMatch) {
        return snakeMatch[1];
    }
    // 通用标识符：取最后一个看起来像符号的单词（>=2 字符）
    const words = cleaned.split(/\s+/).filter(w => w.length >= 2 && /^[a-zA-Z_$][\w.$]*$/.test(w));
    if (words.length > 0) {
        return words[words.length - 1];
    }
    return null;
}
// ── 索引搜索核心 ────────────────────────────────────────────────
function normalizePath(p) {
    return p.replace(/\\/g, '/');
}
/**
 * 小写符号名缓存：`findSymbolByName` 此前对每个查询词都把**全部**符号名重新 toLowerCase()
 * 并逐条 includes()（大仓每次查询都会在主线程上做一轮全表扫描）。这里按索引对象缓存一次小写键表。
 */
const _lowerNameKeysCache = new WeakMap();
function getLowerNameKeys(index) {
    const cached = _lowerNameKeysCache.get(index);
    if (cached) {
        return cached;
    }
    const entries = Object.entries(index.symbolNameIndex).map(([key, ids]) => ({ lower: key.toLowerCase(), ids }));
    _lowerNameKeysCache.set(index, entries);
    return entries;
}
function findSymbolByName(index, name) {
    const normalized = name.toLowerCase();
    const ids = index.symbolNameIndex[name] || [];
    // 模糊匹配走缓存的小写键表（不再每次查询重新 lower + Object.entries）
    const fuzzyIds = [];
    for (const entry of getLowerNameKeys(index)) {
        if (entry.lower.includes(normalized) || normalized.includes(entry.lower)) {
            fuzzyIds.push(...entry.ids);
        }
    }
    const allIds = [...new Set([...ids, ...fuzzyIds])];
    return allIds.map(id => index.symbols[id]).filter(Boolean);
}
function findDefinition(index, query) {
    const name = extractSymbolName(query);
    if (!name) {
        return [];
    }
    const symbols = findSymbolByName(index, name);
    if (symbols.length === 0) {
        return [];
    }
    return symbols.map(sym => ({
        symbol: sym,
        reason: vscode_1.l10n.t('{0} is defined in', sym.name),
        filePath: sym.filePath,
        score: sym.visibility === types_1.SymbolVisibility.Exported ? 0.95 : 0.8,
        lineRange: [sym.line, sym.line],
        snippet: sym.signature || sym.docComment?.slice(0, 200) || `line ${sym.line}`,
    }));
}
function findUsage(index, query) {
    const name = extractSymbolName(query);
    if (!name) {
        return [];
    }
    const symbols = findSymbolByName(index, name);
    const results = [];
    for (const sym of symbols) {
        const importers = index.reverseDependencyGraph[sym.filePath] || [];
        for (const importer of importers) {
            results.push({
                symbol: sym,
                reason: vscode_1.l10n.t('{0} is imported in', sym.name),
                filePath: importer,
                score: 0.7,
            });
        }
    }
    for (const sym of symbols) {
        const callers = index.calls.filter(c => c.calleeId === sym.id);
        for (const call of callers) {
            const callerPath = call.callerId.split('#')[0];
            results.push({
                symbol: sym,
                reason: vscode_1.l10n.t('{0} is called at L{1}', sym.name, call.line),
                filePath: callerPath,
                score: 0.85,
                lineRange: [call.line, call.line],
            });
        }
    }
    return results.slice(0, 20);
}
function showStructure(index) {
    const results = [];
    const root = index.rootPath;
    const topDirs = new Set();
    for (const filePath of Object.keys(index.files)) {
        const rel = path.relative(root, filePath);
        const parts = rel.split(path.sep);
        if (parts.length > 0) {
            topDirs.add(parts[0]);
        }
    }
    for (const dir of [...topDirs].sort()) {
        results.push({
            reason: vscode_1.l10n.t('Top-level project directory'),
            filePath: path.join(root, dir),
            score: 0.5,
            snippet: `${dir}/`,
        });
    }
    for (const symId of index.hotSymbols.slice(0, 10)) {
        const sym = index.symbols[symId];
        if (sym && sym.visibility === types_1.SymbolVisibility.Exported) {
            results.push({
                symbol: sym,
                reason: vscode_1.l10n.t('Core exported symbol'),
                filePath: sym.filePath,
                score: 0.7,
                snippet: sym.signature || sym.name,
                lineRange: [sym.line, sym.line],
            });
        }
    }
    const moduleDirs = ['src', 'lib', 'extensions', 'packages', 'app'];
    for (const md of moduleDirs) {
        const count = Object.values(index.files).filter(f => normalizePath(f.filePath).includes(`/${md}/`)).length;
        if (count > 0) {
            results.push({
                reason: vscode_1.l10n.t('Module directory'),
                filePath: path.join(root, md),
                score: 0.4,
                snippet: vscode_1.l10n.t('{0}/ — {1} files', md, count),
            });
        }
    }
    return results;
}
function showDependencies(index, query) {
    const name = extractSymbolName(query);
    const results = [];
    if (name) {
        const symbols = findSymbolByName(index, name);
        for (const sym of symbols) {
            const deps = index.dependencyGraph[sym.filePath] || [];
            for (const dep of deps) {
                results.push({
                    symbol: sym,
                    reason: vscode_1.l10n.t('The file containing {0} depends on', sym.name),
                    filePath: dep,
                    score: 0.6,
                });
            }
        }
    }
    return results;
}
/**
 * 通用自然语言搜索（v2）：语义检索（TF-IDF 余弦，符号级 + 文件级）+
 * 符号名精确/模糊匹配混合。语义检索覆盖多语言（TS/Python/Go/Rust），
 * 解决「正则查表」无法处理的问题：如查「用户登录的 token 校验」→
 * 命中 verifyToken / authenticate 等语义相近符号。
 */
async function naturalSearch(index, query) {
    // 查询缓存命中则直接返回
    const cacheKey = `ns:${query}`;
    const cached = _queryCache.get(cacheKey);
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch { /* corrupt cache, continue */ }
    }
    const results = [];
    // 1) 语义检索 — 符号级（核心增强）
    for (const hit of await (0, semanticIndex_1.searchSymbolsAsync)(index, query, 10)) {
        results.push({
            symbol: hit.symbol,
            reason: vscode_1.l10n.t('Semantic match for "{0}"', query),
            filePath: hit.symbol.filePath,
            score: Math.min(0.95, 0.4 + hit.score),
            snippet: hit.symbol.signature || hit.symbol.docComment?.slice(0, 150),
            lineRange: [hit.symbol.line, hit.symbol.line],
        });
    }
    // 2) 语义检索 — 语法块级（对标 Cursor syntax-block embedding）
    for (const hit of await (0, semanticIndex_1.searchBlocksAsync)(index, query, 8)) {
        if (results.some(r => r.filePath === hit.block.filePath && r.lineRange?.[0] === hit.block.startLine)) {
            continue;
        }
        results.push({
            reason: vscode_1.l10n.t('Code block semantic match for "{0}"', query),
            filePath: hit.block.filePath,
            score: Math.min(0.9, 0.35 + hit.score),
            snippet: hit.block.text.slice(0, 500),
            lineRange: [hit.block.startLine, hit.block.endLine],
        });
    }
    // 3) 语义检索 — 文件级（跳过已命中符号的文件，避免重复）
    for (const hit of await (0, semanticIndex_1.searchFilesAsync)(index, query, 5)) {
        if (results.some(r => r.filePath === hit.filePath)) {
            continue;
        }
        results.push({
            reason: vscode_1.l10n.t('File semantic match for "{0}"', query),
            filePath: hit.filePath,
            score: Math.min(0.7, 0.25 + hit.score),
        });
    }
    // 4) 符号名精确/模糊匹配（保留原能力，作为语义检索的补充）
    const words = query.match(/[a-zA-Z_$][\w.$]*/g) || [];
    const chineseWords = query.match(/[\u4e00-\u9fff]+/g) || [];
    // 限制搜索词数量，避免长句导致过多遍历
    const allTerms = [...words, ...chineseWords].slice(0, 10);
    for (const term of allTerms) {
        if (term.length < 2) {
            continue;
        }
        const symbols = findSymbolByName(index, term);
        for (const sym of symbols) {
            results.push({
                symbol: sym,
                reason: vscode_1.l10n.t('Symbol name match for "{0}"', term),
                filePath: sym.filePath,
                score: 0.6,
                snippet: sym.signature || sym.docComment?.slice(0, 150),
                lineRange: [sym.line, sym.line],
            });
        }
    }
    const seen = new Set();
    const finalResults = results.filter(r => {
        const key = `${r.filePath}:${r.symbol?.id || ''}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    }).slice(0, 20);
    // 缓存结果
    try {
        _queryCache.set(cacheKey, JSON.stringify(finalResults));
    }
    catch { /* non-critical */ }
    return finalResults;
}
// ── 结果格式化 ──────────────────────────────────────────────────
function formatResultsToMarkdown(results, query, index) {
    if (results.length === 0) {
        return `## ${vscode_1.l10n.t('"{0}" — no matching results found', query)}

> ${vscode_1.l10n.t('Suggestions:')}
> - ${vscode_1.l10n.t('Try a more specific symbol name')}
> - ${vscode_1.l10n.t('Run **Kodrix: Generate Repo Wiki** to rebuild the project index')}
> - ${vscode_1.l10n.t('Use \`#codebase\` to search the codebase')}

**${vscode_1.l10n.t('Index status:')}** ${vscode_1.l10n.t('{0} files · {1} symbols · {2} imports', index.stats.totalFiles, index.stats.totalSymbols, index.stats.totalImports)}`;
    }
    const lines = [
        `## ${vscode_1.l10n.t('"{0}" — {1} results found', query, results.length)}`,
        '',
        `> ${vscode_1.l10n.t('Index: {0} files · {1} symbols', index.stats.totalFiles, index.stats.totalSymbols)}`,
        '',
    ];
    const sorted = [...results].sort((a, b) => b.score - a.score);
    for (const r of sorted) {
        const sym = r.symbol;
        const relativePath = normalizePath(path.relative(index.rootPath, r.filePath));
        const kindTag = sym ? `[${sym.kind}] ` : '';
        lines.push(`### ${kindTag}${r.reason}`);
        if (sym) {
            lines.push('');
            lines.push(`| ${vscode_1.l10n.t('Property')} | ${vscode_1.l10n.t('Value')} |`);
            lines.push(`|------|-----|`);
            lines.push(`| ${vscode_1.l10n.t('**Symbol**')} | \`${sym.name}\` |`);
            lines.push(`| ${vscode_1.l10n.t('**Type**')} | ${sym.kind} |`);
            lines.push(`| ${vscode_1.l10n.t('**Visibility**')} | ${sym.visibility} |`);
            lines.push(`| ${vscode_1.l10n.t('**File**')} | [\`${relativePath}\`](${r.filePath}) |`);
            lines.push(`| ${vscode_1.l10n.t('**Line**')} | L${sym.line} |`);
            if (sym.signature) {
                lines.push(`| ${vscode_1.l10n.t('**Signature**')} | \`${sym.signature.slice(0, 120)}\` |`);
            }
            if (sym.docComment) {
                lines.push(`| ${vscode_1.l10n.t('**Docs**')} | ${sym.docComment.slice(0, 200).replace(/\n/g, ' ')} |`);
            }
            if (sym.parentId) {
                const parentName = sym.parentId.split('#')[1];
                lines.push(`| ${vscode_1.l10n.t('**Parent**')} | \`${parentName}\` |`);
            }
        }
        if (r.snippet && !sym) {
            const lang = index.files[r.filePath]?.language || path.extname(r.filePath).slice(1) || 'typescript';
            lines.push('');
            lines.push(`[\`${relativePath}\`](${r.filePath})`);
            if (r.lineRange) {
                lines.push(`*L${r.lineRange[0]}–L${r.lineRange[1]}*`);
            }
            lines.push('');
            lines.push(`\`\`\`${lang}`);
            lines.push(r.snippet.slice(0, 600));
            lines.push('```');
        }
        if (sym) {
            const deps = index.dependencyGraph[r.filePath]?.length || 0;
            const revDeps = index.reverseDependencyGraph[r.filePath]?.length || 0;
            if (deps > 0 || revDeps > 0) {
                lines.push(`| ${vscode_1.l10n.t('**Dependencies**')} | ${vscode_1.l10n.t('Imports {0} modules · imported by {1} modules', deps, revDeps)} |`);
            }
        }
        lines.push('');
    }
    lines.push('---');
    lines.push(`*Codebase Intelligence · ${new Date().toLocaleString('zh-CN')}*`);
    return lines.join('\n');
}
// ── 主查询入口 ──────────────────────────────────────────────────
async function queryCodebase(query) {
    const index = await (0, projectIndexer_1.ensureProjectIndex)();
    if (!index) {
        return vscode_1.l10n.t('No project index found. Open a workspace folder first and Kodrix will build the index automatically.');
    }
    const intent = detectIntent(query);
    logger_1.logger.info(`[CodebaseQuery] "${query}" → intent: ${intent}`);
    let results;
    switch (intent) {
        case 'definition':
            results = findDefinition(index, query);
            if (results.length === 0) {
                results = await naturalSearch(index, query);
            }
            break;
        case 'usage':
        case 'callers':
            results = findUsage(index, query);
            if (results.length === 0) {
                results = await naturalSearch(index, query);
            }
            break;
        case 'structure':
        case 'architecture':
            results = showStructure(index);
            break;
        case 'dependency':
            results = showDependencies(index, query);
            if (results.length === 0) {
                results = await naturalSearch(index, query);
            }
            break;
        case 'natural':
        default:
            results = await naturalSearch(index, query);
            break;
    }
    return formatResultsToMarkdown(results, query, index);
}
/** 快速搜索符号（供补全等模块使用） */
function quickSearchSymbols(name, limit = 10) {
    const cacheKey = `qs:${name}:${limit}`;
    const cached = _symbolCache.get(cacheKey);
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch { /* corrupt cache */ }
    }
    const index = (0, projectIndexer_1.getProjectIndex)();
    if (!index) {
        return [];
    }
    const symbols = findSymbolByName(index, name);
    const result = symbols.slice(0, limit).map(sym => ({
        symbol: sym,
        score: sym.visibility === types_1.SymbolVisibility.Exported ? 1.0 : 0.7,
    }));
    try {
        _symbolCache.set(cacheKey, JSON.stringify(result));
    }
    catch { /* non-critical */ }
    return result;
}
/** 获取文件的依赖列表 */
function getFileDependencies(filePath) {
    const cached = _depCache.get(filePath);
    if (cached) {
        return cached;
    }
    const index = (0, projectIndexer_1.getProjectIndex)();
    const result = index?.dependencyGraph[filePath] || [];
    _depCache.set(filePath, result);
    return result;
}
/** 获取文件的被依赖列表 */
function getFileDependents(filePath) {
    const cached = _dependentsCache.get(filePath);
    if (cached) {
        return cached;
    }
    const index = (0, projectIndexer_1.getProjectIndex)();
    const result = index?.reverseDependencyGraph[filePath] || [];
    _dependentsCache.set(filePath, result);
    return result;
}
// ── Chat Participant 注册 ──────────────────────────────────────
let _participant;
function registerCodebaseChatParticipant(context) {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('codebaseQuery', true);
    if (!enabled) {
        logger_1.logger.info('[CodebaseQuery] Disabled by configuration');
        return;
    }
    // 注册为 VS Code Chat Participant
    try {
        const api = vscode.chat;
        if (!api?.createChatParticipant) {
            logger_1.logger.info('[CodebaseQuery] Chat participant API not available (may need newer VS Code)');
            return;
        }
        _participant = api.createChatParticipant('kodrix.codebase', async (request, _context, stream, token) => {
            const prompt = request.prompt?.trim();
            if (!prompt) {
                stream.markdown(vscode_1.l10n.t('Type a question after `@codebase`, for example:\n- `@codebase where is getUserProfile defined?`\n- `@codebase what modules does this project have?`\n- `@codebase who calls createUser?`'));
                return;
            }
            if (token.isCancellationRequested) {
                return;
            }
            try {
                stream.markdown(vscode_1.l10n.t('*Indexing and searching the codebase...*'));
                const result = await queryCodebase(prompt);
                stream.markdown(result);
            }
            catch (err) {
                stream.markdown(vscode_1.l10n.t('Query failed: {0}', err instanceof Error ? err.message : String(err)));
            }
        });
        context.subscriptions.push(_participant);
        logger_1.logger.info('[CodebaseQuery] Chat participant registered as kodrix.codebase');
    }
    catch (err) {
        logger_1.logger.info(`[CodebaseQuery] Chat participant registration skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 注册命令作为备选入口
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.codebase.search', async () => {
        const query = await vscode.window.showInputBox({
            prompt: vscode_1.l10n.t('Enter a question (e.g. "Where is getUserProfile defined?")'),
            placeHolder: vscode_1.l10n.t('Ask questions about code in natural language...'),
        });
        if (!query) {
            return;
        }
        await vscode.window.withProgress({ location: { viewId: 'workbench.panel.chat' }, title: vscode_1.l10n.t('Search codebase...') }, async () => {
            const result = await queryCodebase(query);
            const doc = await vscode.workspace.openTextDocument({
                content: result,
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        });
    }));
}
