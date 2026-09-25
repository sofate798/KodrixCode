"use strict";
/*---------------------------------------------------------------------------------------------
 *  Predictive Completion — 上下文精准预测补全
 *
 *  大厂对标：GitHub Copilot Next Edit Suggestions + Cursor Tab + JetBrains Full Line
 *
 *  能力：
 *  1. 基于全工程上下文的"下一步编辑"预测
 *  2. 跨文件关联修改：修改签名时提示同步更新所有调用点
 *  3. 导入建议：使用项目内符号时自动建议 import 语句
 *  4. 模式匹配：检测到常见编码模式时提示下一步操作
 *  5. 注册为 VS Code InlineCompletionItemProvider，显示 ghost text
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
exports.ProjectAwareCompletionProvider = void 0;
exports.findAffectedCallSites = findAffectedCallSites;
exports.getAffectedFilesForSymbol = getAffectedFilesForSymbol;
exports.registerPredictiveCompletion = registerPredictiveCompletion;
const vscode = __importStar(require("vscode"));
const projectIndexer_1 = require("./projectIndexer");
const logger_1 = require("../logger");
const types_1 = require("./types");
const MAX_SYMBOL_SCAN_ENTRIES = 200;
const MAX_OBJ_SYMBOLS = 5;
const INDEX_CACHE_TTL_MS = 5000; // Re-read index at most every 5s
// Cache the index snapshot to avoid repeated getProjectIndex() calls
let _cachedIndex = null;
let _cachedIndexTime = 0;
function getCachedIndex() {
    const now = Date.now();
    if (_cachedIndex && (now - _cachedIndexTime) < INDEX_CACHE_TTL_MS) {
        return _cachedIndex;
    }
    try {
        _cachedIndex = (0, projectIndexer_1.getProjectIndex)();
        _cachedIndexTime = now;
    }
    catch {
        _cachedIndex = null;
    }
    return _cachedIndex;
}
/** 检测到函数调用时，匹配项目中的函数签名 */
function matchFunctionCall(prefix, index) {
    const callMatch = prefix.match(/(?:(\w+)\.(\w+)|(\w+))\s*\(\s*?$/);
    if (!callMatch)
        return null;
    const funcName = callMatch[2] || callMatch[3];
    if (!funcName || funcName.length < 2)
        return null;
    for (const [name, ids] of Object.entries(index.symbolNameIndex)) {
        if (name.toLowerCase() === funcName.toLowerCase()) {
            for (const id of ids) {
                const sym = index.symbols[id];
                if (sym && (sym.kind === types_1.SymbolKind.Function || sym.kind === types_1.SymbolKind.Method) && sym.signature) {
                    const sigMatch = sym.signature.match(/\(([^)]*)\)/);
                    if (sigMatch) {
                        const params = sigMatch[1].trim();
                        const afterParen = prefix.substring(prefix.lastIndexOf('(') + 1);
                        if (afterParen.trim())
                            return null;
                        return params;
                    }
                }
            }
        }
    }
    return null;
}
/** 检测到变量名引用时，匹配项目中的导出符号 */
function matchSymbolReference(prefix, index) {
    const wordMatch = prefix.match(/([a-zA-Z_$][\w.]*)$/);
    if (!wordMatch)
        return null;
    const partial = wordMatch[1];
    if (partial.length < 3)
        return null;
    const matches = [];
    let scanned = 0;
    for (const [name, ids] of Object.entries(index.symbolNameIndex)) {
        if (++scanned > MAX_SYMBOL_SCAN_ENTRIES)
            break;
        if (name.startsWith(partial) && name !== partial && name.length > partial.length) {
            for (const id of ids) {
                const sym = index.symbols[id];
                if (sym && (sym.visibility === types_1.SymbolVisibility.Exported || sym.exportKind)) {
                    matches.push({ name, score: name.length - partial.length <= 5 ? 0.9 : 0.5 });
                    break; // 每个 name 只取第一个匹配的导出符号
                }
            }
        }
    }
    if (matches.length === 0)
        return null;
    matches.sort((a, b) => b.score - a.score);
    return matches[0].name.substring(partial.length);
}
/** 检测到链式调用，匹配项目中的已知 API */
function matchChainedCall(prefix, index) {
    const chainMatch = prefix.match(/\.(\w*)$/);
    if (!chainMatch)
        return null;
    const partial = chainMatch[1];
    const beforeDot = prefix.slice(0, prefix.lastIndexOf('.'));
    const objNameMatch = beforeDot.match(/([a-zA-Z_$]\w*)\s*$/);
    const objName = objNameMatch?.[1];
    if (!objName) {
        const commonMethods = [
            'map', 'filter', 'reduce', 'forEach', 'find', 'then', 'catch',
            'toString', 'toUpperCase', 'toLowerCase', 'trim', 'split', 'join',
            'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'length',
        ];
        for (const method of commonMethods) {
            if (method.startsWith(partial) && partial.length >= 1) {
                return method.substring(partial.length);
            }
        }
        return null;
    }
    const objSymbols = [];
    for (const ids of Object.values(index.symbolNameIndex)) {
        for (const id of ids) {
            const sym = index.symbols[id];
            if (sym && sym.name === objName && (sym.kind === types_1.SymbolKind.Class || sym.kind === types_1.SymbolKind.Interface)) {
                objSymbols.push(sym);
                if (objSymbols.length >= MAX_OBJ_SYMBOLS)
                    break;
            }
        }
        if (objSymbols.length >= MAX_OBJ_SYMBOLS)
            break;
    }
    for (const objSym of objSymbols) {
        // 构建该类的子方法索引：只在找到的 class/interface 中搜索一次
        const methodNames = [];
        for (const [, ids] of Object.entries(index.symbolNameIndex)) {
            for (const id of ids) {
                const sym = index.symbols[id];
                if (sym && sym.parentId === objSym.id) {
                    methodNames.push(sym.name);
                }
            }
        }
        for (const name of methodNames) {
            if (name.startsWith(partial) && partial.length >= 1) {
                return name.substring(partial.length);
            }
        }
    }
    return null;
}
/** 检测代码块补全（花括号闭合等） */
function matchBlockCompletion(prefix, suffix) {
    const lines = prefix.split('\n');
    const lastLine = lines[lines.length - 1].trim();
    const openBraces = (prefix.match(/\{/g) || []).length;
    const closeBraces = (prefix.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
        const indent = lastLine.match(/^(\s*)/)?.[1] || '';
        const nextIndent = indent + '\t';
        if (lastLine.endsWith('{')) {
            if (!suffix.trim()) {
                return `\n${nextIndent}\n${indent}}`;
            }
        }
    }
    if (/(?:if|for|while|else)\s*\([^)]*\)\s*$/i.test(lastLine)) {
        return ' {\n\t\n}';
    }
    if (lastLine.trim() === 'try' || lastLine.trim().endsWith('try')) {
        return ' {\n\t\n} catch (error) {\n\t\n}';
    }
    return null;
}
// ── 补全提供者 ────────────────────────────────────────────────
class ProjectAwareCompletionProvider {
    _lastCallTime = 0;
    _minCallInterval = 200; // ms between calls
    async provideInlineCompletionItems(document, position, _context, token) {
        // 节流：避免每次击键都触发完整搜索
        const now = Date.now();
        if (now - this._lastCallTime < this._minCallInterval)
            return [];
        this._lastCallTime = now;
        const items = [];
        if (token.isCancellationRequested)
            return items;
        // 获取编辑器上下文
        let prefix, suffix;
        try {
            const prefixRange = new vscode.Range(new vscode.Position(0, 0), position);
            prefix = document.getText(prefixRange);
            const suffixRange = new vscode.Range(position, document.lineAt(document.lineCount - 1).range.end);
            suffix = document.getText(suffixRange);
        }
        catch {
            return items; // 文档已关闭或不可读，静默退出
        }
        // 获取索引（带 TTL 缓存，避免大文件下每次击键都读索引）
        const index = getCachedIndex();
        if (!index || index.stats.totalSymbols === 0)
            return items;
        const suggestions = [];
        try {
            const funcCall = matchFunctionCall(prefix, index);
            if (funcCall) {
                suggestions.push({ text: funcCall, reason: '项目函数签名匹配', confidence: 0.9 });
            }
        }
        catch { /* 单次匹配失败不影响其他补全 */ }
        try {
            const symbolRef = matchSymbolReference(prefix, index);
            if (symbolRef) {
                suggestions.push({ text: symbolRef, reason: '项目导出符号匹配', confidence: 0.85 });
            }
        }
        catch { /* 同上 */ }
        try {
            const chained = matchChainedCall(prefix, index);
            if (chained) {
                suggestions.push({ text: chained, reason: 'API 链式调用模式', confidence: 0.75 });
            }
        }
        catch { /* 同上 */ }
        const block = matchBlockCompletion(prefix, suffix);
        if (block) {
            suggestions.push({ text: block, reason: '代码块闭合', confidence: 0.65 });
        }
        for (const s of suggestions) {
            items.push(new vscode.InlineCompletionItem(s.text));
        }
        return items;
    }
}
exports.ProjectAwareCompletionProvider = ProjectAwareCompletionProvider;
// ── 跨文件修改检测 ─────────────────────────────────────────────
/** 检测签名变更时，查找所有调用点 */
function findAffectedCallSites(filePath, symbolName) {
    const index = (0, projectIndexer_1.getProjectIndex)();
    if (!index)
        return [];
    const symId = `${filePath}#${symbolName}`;
    const calls = index.calls.filter(c => c.calleeId === symId);
    return calls.map(c => ({
        filePath: c.callerId.split('#')[0],
        line: c.line,
    }));
}
/** 当符号被重命名/修改时，返回需要同步更新的文件列表 */
function getAffectedFilesForSymbol(filePath, symbolName) {
    const index = (0, projectIndexer_1.getProjectIndex)();
    if (!index)
        return [];
    const symId = `${filePath}#${symbolName}`;
    const importers = index.reverseDependencyGraph[filePath] || [];
    const callers = index.calls
        .filter(c => c.calleeId === symId)
        .map(c => c.callerId.split('#')[0]);
    return [...new Set([...importers, ...callers])];
}
// ── 注册 ──────────────────────────────────────────────────────
function registerPredictiveCompletion(context) {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('predictiveCompletion', true);
    if (!enabled) {
        logger_1.logger.info('[PredictiveCompletion] Disabled by configuration');
        return;
    }
    const selector = [
        { language: 'typescript' },
        { language: 'javascript' },
        { language: 'typescriptreact' },
        { language: 'javascriptreact' },
    ];
    const provider = new ProjectAwareCompletionProvider();
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(selector, provider));
    logger_1.logger.info('[PredictiveCompletion] Registered inline completion provider for TS/JS/TSX/JSX');
}
