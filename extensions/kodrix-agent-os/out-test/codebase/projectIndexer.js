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
exports.onIndexStateChange = void 0;
exports.getLastBuildDiagnostics = getLastBuildDiagnostics;
exports.updateProjectIndexIncrementally = updateProjectIndexIncrementally;
exports.getIndexState = getIndexState;
exports.pauseIndexBuild = pauseIndexBuild;
exports.resumeIndexBuild = resumeIndexBuild;
exports.deleteProjectIndex = deleteProjectIndex;
exports.getIndexFiles = getIndexFiles;
exports.ensureGrepIndex = ensureGrepIndex;
exports.getGrepIndexFiles = getGrepIndexFiles;
exports.clearGrepIndex = clearGrepIndex;
exports.getProjectIndex = getProjectIndex;
exports.ensureProjectIndex = ensureProjectIndex;
exports.startIndexWatcher = startIndexWatcher;
exports.disposeIndexWatcher = disposeIndexWatcher;
exports.disposeIndexStateEmitter = disposeIndexStateEmitter;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const ts = __importStar(require("typescript"));
const paths_1 = require("../paths");
const logger_1 = require("../logger");
const jsonValidator_1 = require("../utils/jsonValidator");
const fsSafe_1 = require("../utils/fsSafe");
const textFile_1 = require("../utils/textFile");
const constants_1 = require("../shared/constants");
const types_1 = require("./types");
// ── 默认配置 ───────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    includeExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.go', '.rs'],
    excludeDirs: ['node_modules', '.git', 'dist', 'out', 'build', '.kodrix', '__pycache__', '.venv', 'target', 'coverage', '.next', '.nuxt'],
    excludeGlobs: ['**/*.d.ts', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/generated/**', '**/*.min.js'],
    maxFileSize: 500_000, // 500KB
    watch: true,
};
/** 索引结构版本：v2 = 多语言支持（Python/Go/Rust） */
const INDEX_VERSION = 2;
// ── 文件发现 ───────────────────────────────────────────────────
/**
 * Pre-compile glob patterns into regex for efficient repeated matching.
 *
 * Without pre-compilation, each file (1000+) would recompile every glob
 * pattern into a new RegExp, creating significant GC pressure.
 */
function compileGlobs(excludeGlobs) {
    const compiled = [];
    for (const glob of excludeGlobs) {
        try {
            const escaped = glob
                .replace(/\./g, '\\.')
                .replace(/\*\*/g, '<<DOUBLESTAR>>')
                .replace(/\*/g, '[^/]*')
                .replace(/<<DOUBLESTAR>>/g, '.*');
            // 拒绝会匹配任意路径的规则（如单独的 "**"），否则索引会变成 0 文件
            if (escaped === '.*') {
                logger_1.logger.warn(`[ProjectIndexer] Ignoring overly broad exclude glob: ${glob}`);
                continue;
            }
            compiled.push(new RegExp('^' + escaped + '$'));
        }
        catch {
            // Skip invalid globs silently — the regex might be malformed
        }
    }
    return compiled;
}
function shouldExclude(filePath, config, rootPath, compiledGlobs) {
    // 扩展名过滤
    const ext = path.extname(filePath).toLowerCase();
    if (!config.includeExtensions.includes(ext)) {
        return true;
    }
    // 大小过滤
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > config.maxFileSize) {
            return true;
        }
    }
    catch {
        return true;
    }
    // 目录过滤
    const normalized = filePath.replace(/\\/g, '/');
    for (const dir of config.excludeDirs) {
        if (normalized.includes(`/${dir}/`) || normalized.endsWith(`/${dir}`)) {
            return true;
        }
    }
    // Glob 过滤：使用完整相对路径而非 basename，确保 **/ 等跨目录模式正确匹配
    const relativePath = rootPath
        ? path.relative(rootPath, filePath).replace(/\\/g, '/')
        : path.basename(filePath);
    // 使用预编译的正则（由 discoverFiles 传入）避免每个文件重复编译
    const globs = compiledGlobs || compileGlobs(config.excludeGlobs);
    for (const regex of globs) {
        if (regex.test(relativePath)) {
            return true;
        }
    }
    return false;
}
let _cursorignoreCache = null;
function invalidateCursorignoreCache() {
    _cursorignoreCache = null;
}
/**
 * 读取忽略规则：`.gitignore` **始终生效**（UI 文案承诺"除 .gitignore 外…"），
 * `.cursorignore` 由 `kodrix.codebase.ignoreCursorignore` 控制（默认为真）。
 * 两者合并后按 gitignore 语义求值（后出现的规则覆盖先出现的，支持 `!` 取反）。
 */
function getCursorignoreRules(rootPath) {
    const cursorignoreEnabled = vscode.workspace.getConfiguration('kodrix.codebase').get('ignoreCursorignore', true);
    if (_cursorignoreCache && _cursorignoreCache.root === rootPath && _cursorignoreCache.cursorEnabled === cursorignoreEnabled) {
        return _cursorignoreCache.rules;
    }
    const parseIgnoreFile = (fileName) => {
        const file = path.join(rootPath, fileName);
        if (!fs.existsSync(file)) {
            return [];
        }
        try {
            return fs.readFileSync(file, 'utf-8')
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(l => l.length > 0 && !l.startsWith('#'))
                .map(line => {
                const negated = line.startsWith('!');
                const glob = negated ? line.slice(1).trim() : line;
                const regex = compileIgnoreGlob(glob);
                return regex ? { regex, negated } : undefined;
            })
                .filter((rule) => !!rule);
        }
        catch {
            return [];
        }
    };
    // .gitignore 先、.cursorignore 后：后者可以取反前者（更贴近用户"额外排除"的直觉）
    const rules = [
        ...parseIgnoreFile('.gitignore'),
        ...(cursorignoreEnabled ? parseIgnoreFile('.cursorignore') : []),
    ];
    _cursorignoreCache = { root: rootPath, rules, cursorEnabled: cursorignoreEnabled };
    return rules;
}
/** gitignore 语义：按顺序求值，最后一条命中的规则决定去留（支持 `!` 取反重新纳入） */
function isCursorignoreExcluded(relativePath, rules) {
    let excluded = false;
    for (const rule of rules) {
        if (rule.regex.test(relativePath)) {
            excluded = !rule.negated;
        }
    }
    return excluded;
}
/**
 * 编译一条 gitignore 规则（与 `compileGlobs` 的区别在于严格遵循 gitignore 语义）：
 * - 无斜杠的模式匹配**任意层级**（`*.log` 命中 `a/b/x.log`）
 * - 以 `/` 开头表示锚定到仓库根
 * - 以 `/` 结尾表示目录（命中目录本身与其下全部内容）
 * 此前直接用 `compileGlobs` 得到 `^generated/$`，既匹配不到目录内容、也匹配不到子层级的 `*.gen.ts`。
 */
function compileIgnoreGlob(pattern) {
    let p = pattern.replace(/\\/g, '/').trim();
    if (!p) {
        return undefined;
    }
    const anchored = p.startsWith('/');
    if (anchored) {
        p = p.slice(1);
    }
    const dirOnly = p.endsWith('/');
    if (dirOnly) {
        p = p.replace(/\/+$/, '');
    }
    if (!p) {
        return undefined;
    }
    const hasSlash = p.includes('/');
    const DS_SLASH = '\u0001DS\u0001';
    const DS = '\u0002DS\u0002';
    const escaped = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, DS_SLASH)
        .replace(/\*\*/g, DS)
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(new RegExp(DS_SLASH, 'g'), '(?:.*/)?')
        .replace(new RegExp(DS, 'g'), '.*');
    // 过度宽泛的规则会把索引清空（gitignore 里 `*`/`**` 就是"全部忽略"）
    if (escaped === '.*' || escaped === '[^/]*') {
        logger_1.logger.warn(`[ProjectIndexer] 忽略过度宽泛的忽略规则：${pattern}`);
        return undefined;
    }
    const prefix = (anchored || hasSlash) ? '' : '(?:.*/)?';
    const suffix = dirOnly ? '(?:/.*)?' : '';
    return new RegExp('^' + prefix + escaped + suffix + '$');
}
async function discoverFiles(rootPath, config) {
    const files = [];
    const stack = [rootPath];
    let visitedDirs = 0;
    let visitedEntries = 0;
    /** 已访问目录的真实路径：符号链接可能指回上层目录，靠它做环检测（否则会无限递归） */
    const visitedRealDirs = new Set();
    try {
        visitedRealDirs.add(fs.realpathSync(rootPath));
    }
    catch { /* 忽略 */ }
    /** 目录是否可进入（排除隐藏目录/依赖目录，并对符号链接做环检测） */
    const canEnterDir = (full, name, viaLink) => {
        if (name.startsWith('.') || config.excludeDirs.includes(name)) {
            return false;
        }
        if (!viaLink) {
            return true;
        }
        try {
            const real = fs.realpathSync(full);
            if (visitedRealDirs.has(real)) {
                return false;
            }
            visitedRealDirs.add(real);
            return true;
        }
        catch {
            return false;
        }
    };
    // Pre-compile globs once per discovery pass — avoids recompiling per file
    const compiledGlobs = compileGlobs(config.excludeGlobs);
    const cursorignoreRules = getCursorignoreRules(rootPath);
    while (stack.length) {
        const dir = stack.pop();
        visitedDirs++;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            visitedEntries++;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (canEnterDir(full, entry.name, false)) {
                    stack.push(full);
                }
            }
            else if (entry.isFile()) {
                if (!shouldExclude(full, config, rootPath, compiledGlobs)) {
                    // .gitignore / .cursorignore 过滤：使用相对路径匹配，规则里可直接写目录或 glob
                    const relativePath = path.relative(rootPath, full).replace(/\\/g, '/');
                    if (!isCursorignoreExcluded(relativePath, cursorignoreRules)) {
                        files.push(full);
                    }
                }
            }
            else if (entry.isSymbolicLink()) {
                // 符号链接（monorepo 里 pnpm workspace / 本地包 link 很常见）：
                // 需要 stat 才知道指向文件还是目录；目录链接做 realpath 环检测，避免无限递归。
                try {
                    const st = fs.statSync(full);
                    if (st.isDirectory()) {
                        if (canEnterDir(full, entry.name, true)) {
                            stack.push(full);
                        }
                    }
                    else if (st.isFile()) {
                        if (!shouldExclude(full, config, rootPath, compiledGlobs)) {
                            const relativePath = path.relative(rootPath, full).replace(/\\/g, '/');
                            if (!isCursorignoreExcluded(relativePath, cursorignoreRules)) {
                                files.push(full);
                            }
                        }
                    }
                }
                catch {
                    /* 悬空链接：跳过 */
                }
            }
        }
        // 让出事件循环：既按目录数，也按**条目数**（每个目录里可能有很多文件，
        // 逐文件做 glob 判定本身就要几十毫秒；只按目录让出实测仍会一次阻塞 250–400ms）
        if (visitedDirs % DIR_TRAVERSAL_YIELD_INTERVAL === 0
            || visitedEntries >= DISCOVER_YIELD_ENTRIES) {
            visitedEntries = 0;
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    return files;
}
// ── TypeScript AST 解析 ────────────────────────────────────────
function getSymbolKind(tsKind) {
    switch (tsKind) {
        case ts.SyntaxKind.ClassDeclaration: return types_1.SymbolKind.Class;
        case ts.SyntaxKind.InterfaceDeclaration: return types_1.SymbolKind.Interface;
        case ts.SyntaxKind.FunctionDeclaration: return types_1.SymbolKind.Function;
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.MethodSignature: return types_1.SymbolKind.Method;
        case ts.SyntaxKind.VariableDeclaration:
        case ts.SyntaxKind.VariableStatement: return types_1.SymbolKind.Variable;
        case ts.SyntaxKind.TypeAliasDeclaration: return types_1.SymbolKind.TypeAlias;
        case ts.SyntaxKind.EnumDeclaration: return types_1.SymbolKind.Enum;
        case ts.SyntaxKind.ModuleDeclaration: return types_1.SymbolKind.Namespace;
        default: return types_1.SymbolKind.Unknown;
    }
}
function getExportKind(node) {
    if (!ts.isExportAssignment(node) && !ts.isExportDeclaration(node)) {
        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        if (modifiers) {
            for (const m of modifiers) {
                if (m.kind === ts.SyntaxKind.ExportKeyword) {
                    return 'named';
                }
                if (m.kind === ts.SyntaxKind.DefaultKeyword) {
                    return 'default';
                }
            }
        }
    }
    return undefined;
}
function getVisibility(modifiers) {
    if (!modifiers) {
        return types_1.SymbolVisibility.Public;
    }
    for (const m of modifiers) {
        if (m.kind === ts.SyntaxKind.PublicKeyword) {
            return types_1.SymbolVisibility.Public;
        }
        if (m.kind === ts.SyntaxKind.ProtectedKeyword) {
            return types_1.SymbolVisibility.Protected;
        }
        if (m.kind === ts.SyntaxKind.PrivateKeyword) {
            return types_1.SymbolVisibility.Private;
        }
        if (m.kind === ts.SyntaxKind.ExportKeyword) {
            return types_1.SymbolVisibility.Exported;
        }
    }
    return types_1.SymbolVisibility.Public;
}
function getDocComment(node, sourceFile) {
    const fullText = sourceFile.getFullText();
    const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
    if (!ranges) {
        return undefined;
    }
    const docs = [];
    for (const range of ranges) {
        const comment = fullText.slice(range.pos, range.end);
        if (comment.startsWith('/**')) {
            docs.push(comment
                .replace(/\/\*\*|\*\/|\n\s*\*\s?/g, '\n')
                .replace(/^\n+/, '')
                .trim());
        }
    }
    return docs.join('\n') || undefined;
}
function getSignature(node, sourceFile) {
    const text = node.getText(sourceFile);
    // 找到函数体的开头 { 或接口结尾的 ; 作为签名截断点
    // 需要跳过泛型参数 <...> 内、字符串/模板字符串内的 { 和 ;
    let depth = 0;
    let sigEnd = -1;
    MAIN: for (let i = 0; i < text.length; i++) {
        switch (text[i]) {
            case '<':
                depth++;
                break;
            case '>':
                depth--;
                break;
            case '{':
                if (depth <= 0) {
                    sigEnd = i;
                    break MAIN;
                }
                break;
            case ';':
                if (depth <= 0) {
                    sigEnd = i;
                    break MAIN;
                }
                break;
        }
    }
    return sigEnd > 0 ? text.slice(0, sigEnd).trim() : text.slice(0, 120);
}
function makeSymbolId(filePath, name) {
    return `${filePath}#${name}`;
}
function collectSymbols(sourceFile, filePath) {
    const collector = { symbols: [], imports: [], calls: [] };
    const parentStack = [];
    function getParentId() {
        return parentStack.length ? parentStack[parentStack.length - 1].id : undefined;
    }
    function visit(node) {
        const sf = sourceFile;
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());
        // ── 类 / 接口 / 枚举 / 命名空间 ──
        if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
            ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
            const name = node.name?.getText(sf);
            if (name) {
                const sym = {
                    id: makeSymbolId(filePath, name),
                    name,
                    kind: getSymbolKind(node.kind),
                    filePath,
                    line: pos.line + 1,
                    column: pos.character + 1,
                    endLine: endPos.line + 1,
                    endColumn: endPos.character + 1,
                    parentId: getParentId(),
                    visibility: getExportKind(node) === 'named' ? types_1.SymbolVisibility.Exported : getVisibility(ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined),
                    docComment: getDocComment(node, sf),
                    signature: getSignature(node, sf),
                    exportKind: getExportKind(node),
                };
                collector.symbols.push(sym);
                parentStack.push(sym);
                ts.forEachChild(node, visit);
                parentStack.pop();
                return;
            }
        }
        // ── 函数声明 ──
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.getText(sf);
            const sym = {
                id: makeSymbolId(filePath, name),
                name,
                kind: types_1.SymbolKind.Function,
                filePath,
                line: pos.line + 1,
                column: pos.character + 1,
                endLine: endPos.line + 1,
                endColumn: endPos.character + 1,
                parentId: getParentId(),
                visibility: getExportKind(node) ? types_1.SymbolVisibility.Exported : types_1.SymbolVisibility.Public,
                docComment: getDocComment(node, sf),
                signature: getSignature(node, sf),
                exportKind: getExportKind(node),
            };
            collector.symbols.push(sym);
            // 收集函数体内的调用
            parentStack.push(sym);
            ts.forEachChild(node, visit);
            parentStack.pop();
            return;
        }
        // ── 方法声明 ──
        if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name) {
            const name = ts.isIdentifier(node.name) ? node.name.text :
                ts.isStringLiteral(node.name) ? node.name.text : undefined;
            if (name) {
                const sym = {
                    id: makeSymbolId(filePath, getParentId() ? `${getParentId()?.split('#')[1]}.${name}` : name),
                    name,
                    kind: types_1.SymbolKind.Method,
                    filePath,
                    line: pos.line + 1,
                    column: pos.character + 1,
                    endLine: endPos.line + 1,
                    endColumn: endPos.character + 1,
                    parentId: getParentId(),
                    visibility: getVisibility(ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined),
                    docComment: getDocComment(node, sf),
                    signature: getSignature(node, sf),
                };
                collector.symbols.push(sym);
            }
        }
        // ── 导出变量声明 ──
        if (ts.isVariableStatement(node)) {
            const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
            const isExported = modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    const sym = {
                        id: makeSymbolId(filePath, decl.name.text),
                        name: decl.name.text,
                        kind: types_1.SymbolKind.Variable,
                        filePath,
                        line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
                        column: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).character + 1,
                        endLine: sf.getLineAndCharacterOfPosition(decl.getEnd()).line + 1,
                        endColumn: sf.getLineAndCharacterOfPosition(decl.getEnd()).character + 1,
                        parentId: getParentId(),
                        visibility: isExported ? types_1.SymbolVisibility.Exported : types_1.SymbolVisibility.Private,
                        exportKind: isExported ? 'named' : undefined,
                    };
                    collector.symbols.push(sym);
                }
            }
        }
        // ── 类型别名 ──
        if (ts.isTypeAliasDeclaration(node)) {
            const sym = {
                id: makeSymbolId(filePath, node.name.text),
                name: node.name.text,
                kind: types_1.SymbolKind.TypeAlias,
                filePath,
                line: pos.line + 1,
                column: pos.character + 1,
                endLine: endPos.line + 1,
                endColumn: endPos.character + 1,
                parentId: getParentId(),
                visibility: types_1.SymbolVisibility.Exported,
                exportKind: getExportKind(node),
            };
            collector.symbols.push(sym);
        }
        // ── 调用表达式 → 调用图 ──
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const calleeName = node.expression.text;
            const caller = parentStack.length ? parentStack[parentStack.length - 1] : undefined;
            if (caller) {
                collector.calls.push({
                    callerId: caller.id,
                    calleeId: makeSymbolId(filePath, calleeName), // 先记录，后续解析跨文件
                    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                });
            }
        }
        // ── 导入声明 ──
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const moduleSpecifier = node.moduleSpecifier.text;
            const importClause = node.importClause;
            const symbols = [];
            let isDefault = false;
            // `import type {...}` / `import type X` — 类型标记位于 importClause 上，而非 modifiers
            const isTypeOnly = importClause?.isTypeOnly ?? false;
            if (importClause?.name) {
                symbols.push(importClause.name.text);
                isDefault = true;
            }
            if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
                for (const elem of importClause.namedBindings.elements) {
                    symbols.push(elem.name.text);
                }
            }
            if (importClause?.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
                symbols.push(importClause.namedBindings.name.text);
            }
            // 解析模块路径
            let importeePath = '';
            if (moduleSpecifier.startsWith('.')) {
                const dir = path.dirname(filePath);
                const resolved = path.resolve(dir, moduleSpecifier);
                for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
                    const candidate = resolved + ext;
                    if (fs.existsSync(candidate)) {
                        importeePath = candidate;
                        break;
                    }
                }
            }
            // 仅当 importeePath 可解析或为外部模块时才记录
            if (importeePath || moduleSpecifier) {
                collector.imports.push({
                    importerPath: filePath,
                    importeePath: importeePath || moduleSpecifier,
                    symbols,
                    isDefault,
                    isTypeOnly,
                    moduleSpecifier,
                });
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return collector;
}
/** 提取紧邻上方连续注释行（# // /// 风格），作为简化 docComment */
function getLeadingComment(lines, idx) {
    const docs = [];
    for (let i = idx - 1; i >= 0; i--) {
        const m = lines[i].trim().match(/^(?:#|\/\/|\/\/\/)\s?(.*)$/);
        if (!m) {
            break;
        }
        docs.unshift(m[1]);
    }
    return docs.length ? docs.join('\n').slice(0, 300) : undefined;
}
function makeSimpleSymbol(filePath, name, kind, line, column, signature, visibility, parentId, docComment) {
    return {
        id: makeSymbolId(filePath, parentId ? `${parentId.split('#')[1]}.${name}` : name),
        name,
        kind,
        filePath,
        line,
        column,
        parentId,
        visibility,
        docComment,
        signature,
    };
}
/** 提取 Python docstring（def/class 行之后紧邻的 '''...''' 或 """...""" 字面量） */
function getPythonDocstring(lines, defLineIdx) {
    if (defLineIdx + 1 >= lines.length) {
        return undefined;
    }
    const t = lines[defLineIdx + 1].trim();
    const m = t.match(/^('''|""")([\s\S]*)$/);
    if (!m) {
        return undefined;
    }
    const quote = m[1];
    const body = m[2];
    if (body.includes(quote)) {
        // 单行闭合："""内容"""
        return body.split(quote)[0].trim().slice(0, 300) || undefined;
    }
    // 多行 docstring：收集到闭合引号
    const parts = [body];
    for (let j = defLineIdx + 2; j < lines.length; j++) {
        const lt = lines[j].trim();
        const end = lt.indexOf(quote);
        if (end >= 0) {
            parts.push(lt.slice(0, end));
            return parts.join('\n').trim().slice(0, 300) || undefined;
        }
        parts.push(lt);
    }
    return parts.join('\n').trim().slice(0, 300) || undefined;
}
function parsePython(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');
    let currentClassId;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        // ── class X(Base): → Class ──
        let m = trimmed.match(/^class\s+(\w+)\s*(\([^)]*\))?\s*:/);
        if (m) {
            currentClassId = undefined;
            const sym = makeSimpleSymbol(filePath, m[1], types_1.SymbolKind.Class, i + 1, raw.indexOf(m[1]) + 1, trimmed.replace(/:\s*$/, ''), types_1.SymbolVisibility.Public, undefined, getLeadingComment(lines, i) ?? getPythonDocstring(lines, i));
            symbols.push(sym);
            currentClassId = sym.id;
            continue;
        }
        // ── def name(...) -> T: → Function / Method（类内缩进为方法） ──
        m = trimmed.match(/^def\s+(\w+)\s*\(([^)]*)\)\s*(->\s*[^:]+)?\s*:/);
        if (m) {
            const isMethod = /^\s/.test(raw) && currentClassId !== undefined;
            const name = m[1];
            const sig = `def ${name}(${m[2]}${m[3] ? ') ' + m[3] : ')'}`;
            const sym = makeSimpleSymbol(filePath, name, isMethod ? types_1.SymbolKind.Method : types_1.SymbolKind.Function, i + 1, raw.indexOf(name) + 1, sig, name.startsWith('_') ? types_1.SymbolVisibility.Private : types_1.SymbolVisibility.Public, isMethod ? currentClassId : undefined, getLeadingComment(lines, i) ?? getPythonDocstring(lines, i));
            symbols.push(sym);
            continue;
        }
        // ── from x.y import a, b → Import ──
        m = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
        if (m) {
            const imported = m[2]
                .replace(/\(|\)/g, ' ')
                .split(',')
                .map(s => s.trim())
                .filter(s => s && /^[A-Za-z_]\w*$/.test(s));
            imports.push({
                importerPath: filePath,
                importeePath: m[1],
                symbols: imported,
                isDefault: false,
                isTypeOnly: false,
                moduleSpecifier: m[1],
            });
            continue;
        }
        // ── import x.y / import x.y as z → Import ──
        m = trimmed.match(/^import\s+([\w.]+)(?:\s+as\s+\w+)?$/);
        if (m) {
            imports.push({
                importerPath: filePath,
                importeePath: m[1],
                symbols: [],
                isDefault: false,
                isTypeOnly: false,
                moduleSpecifier: m[1],
            });
        }
    }
    return { symbols, imports };
}
function parseGo(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');
    // 第一遍：收集 type 声明（方法需要按类型归属）
    const typeIds = new Map();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed) {
            continue;
        }
        const m = trimmed.match(/^type\s+(\w+)\s+(struct|interface)\b/);
        if (m) {
            const id = makeSymbolId(filePath, m[1]);
            typeIds.set(m[1], id);
        }
    }
    // 第二遍：函数 / 变量 / 导入
    let inImportBlock = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//')) {
            continue;
        }
        // import 块处理
        if (/^import\s*\(/.test(trimmed)) {
            inImportBlock = true;
            continue;
        }
        if (inImportBlock && trimmed === ')') {
            inImportBlock = false;
            continue;
        }
        if (inImportBlock) {
            const mm = trimmed.match(/^"([^"]+)"$/);
            if (mm) {
                imports.push({
                    importerPath: filePath, importeePath: mm[1], symbols: [],
                    isDefault: false, isTypeOnly: false, moduleSpecifier: mm[1],
                });
            }
            continue;
        }
        // ── package pkg → Namespace ──
        let m = trimmed.match(/^package\s+(\w+)/);
        if (m) {
            symbols.push(makeSimpleSymbol(filePath, m[1], types_1.SymbolKind.Namespace, i + 1, raw.indexOf(m[1]) + 1, `package ${m[1]}`, types_1.SymbolVisibility.Public));
            continue;
        }
        // ── type X struct/interface → Class / Interface ──
        m = trimmed.match(/^type\s+(\w+)\s+(struct|interface)\b/);
        if (m) {
            symbols.push(makeSimpleSymbol(filePath, m[1], m[2] === 'struct' ? types_1.SymbolKind.Class : types_1.SymbolKind.Interface, i + 1, raw.indexOf(m[1]) + 1, trimmed, types_1.SymbolVisibility.Public, undefined, getLeadingComment(lines, i)));
            continue;
        }
        // ── type X = ... / type X T → TypeAlias ──
        m = trimmed.match(/^type\s+(\w+)\s*=\s*(.+)$/);
        if (m) {
            symbols.push(makeSimpleSymbol(filePath, m[1], types_1.SymbolKind.TypeAlias, i + 1, raw.indexOf(m[1]) + 1, trimmed, types_1.SymbolVisibility.Public, undefined, getLeadingComment(lines, i)));
            continue;
        }
        // ── func (r *T) Name( → Method ──
        m = trimmed.match(/^func\s+\(([^)]*)\)\s*(\w+)\s*\(/);
        if (m) {
            const recv = m[1].trim();
            // 支持 (u *User) 与 (*User) 两种接收者写法
            const typeName = recv.replace(/\*/g, '').trim().split(/\s+/).pop() || '';
            const parentId = typeIds.get(typeName);
            const name = m[2];
            const isExported = /^[A-Z]/.test(name);
            symbols.push(makeSimpleSymbol(filePath, name, types_1.SymbolKind.Method, i + 1, raw.indexOf(name) + 1, trimmed.replace(/\{\s*$/, ''), isExported ? types_1.SymbolVisibility.Exported : types_1.SymbolVisibility.Private, parentId, getLeadingComment(lines, i)));
            continue;
        }
        // ── func Name( → Function ──
        m = trimmed.match(/^func\s+(\w+)\s*\(/);
        if (m) {
            const name = m[1];
            const isExported = /^[A-Z]/.test(name);
            symbols.push(makeSimpleSymbol(filePath, name, types_1.SymbolKind.Function, i + 1, raw.indexOf(name) + 1, trimmed.replace(/\{\s*$/, ''), isExported ? types_1.SymbolVisibility.Exported : types_1.SymbolVisibility.Private, undefined, getLeadingComment(lines, i)));
            continue;
        }
        // ── const X / var X → Variable ──
        m = trimmed.match(/^(?:const|var)\s+(\w+)/);
        if (m) {
            const name = m[1];
            const isExported = /^[A-Z]/.test(name);
            symbols.push(makeSimpleSymbol(filePath, name, types_1.SymbolKind.Variable, i + 1, raw.indexOf(name) + 1, trimmed, isExported ? types_1.SymbolVisibility.Exported : types_1.SymbolVisibility.Private, undefined, getLeadingComment(lines, i)));
            continue;
        }
        // ── import "x" → Import ──
        m = trimmed.match(/^import\s+"([^"]+)"/);
        if (m) {
            imports.push({
                importerPath: filePath, importeePath: m[1], symbols: [],
                isDefault: false, isTypeOnly: false, moduleSpecifier: m[1],
            });
        }
    }
    return { symbols, imports };
}
function parseRust(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//')) {
            continue;
        }
        // 缩进的 fn（impl 块内方法）跳过，避免误判为顶层函数
        if (/^\s/.test(raw) && /(^|\s)fn\s/.test(trimmed)) {
            continue;
        }
        // ── pub struct / pub enum / pub trait → Class / Enum / Interface ──
        let m = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+(\w+)/);
        if (m) {
            const kind = m[1] === 'struct' ? types_1.SymbolKind.Class : m[1] === 'enum' ? types_1.SymbolKind.Enum : types_1.SymbolKind.Interface;
            const name = m[2];
            const isPub = /^pub/.test(trimmed);
            symbols.push(makeSimpleSymbol(filePath, name, kind, i + 1, raw.indexOf(name) + 1, trimmed.replace(/\{\s*$/, ''), isPub ? types_1.SymbolVisibility.Exported : types_1.SymbolVisibility.Private, undefined, getLeadingComment(lines, i)));
            continue;
        }
        // ── pub fn / fn → Function（顶层，无缩进） ──
        m = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?fn\s+(\w+)/);
        if (m) {
            const name = m[1];
            const isPub = /^pub/.test(trimmed);
            symbols.push(makeSimpleSymbol(filePath, name, types_1.SymbolKind.Function, i + 1, raw.indexOf(name) + 1, trimmed.replace(/\{\s*$/, ''), isPub ? types_1.SymbolVisibility.Exported : types_1.SymbolVisibility.Private, undefined, getLeadingComment(lines, i)));
            continue;
        }
        // ── pub const / pub static → Variable ──
        m = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)/);
        if (m) {
            const name = m[1];
            const isPub = /^pub/.test(trimmed);
            symbols.push(makeSimpleSymbol(filePath, name, types_1.SymbolKind.Variable, i + 1, raw.indexOf(name) + 1, trimmed.replace(/;\s*$/, ''), isPub ? types_1.SymbolVisibility.Exported : types_1.SymbolVisibility.Private, undefined, getLeadingComment(lines, i)));
            continue;
        }
        // ── use crate::x::y / use foo::Bar → Import ──
        m = trimmed.match(/^use\s+([\w:]+)/);
        if (m) {
            imports.push({
                importerPath: filePath, importeePath: m[1], symbols: [],
                isDefault: false, isTypeOnly: false, moduleSpecifier: m[1],
            });
            continue;
        }
        // ── mod foo → Import（模块声明） ──
        m = trimmed.match(/^mod\s+(\w+)/);
        if (m) {
            imports.push({
                importerPath: filePath, importeePath: m[1], symbols: [],
                isDefault: false, isTypeOnly: false, moduleSpecifier: m[1],
            });
        }
    }
    return { symbols, imports };
}
// ── 文件解析 ──────────────────────────────────────────────────
/** 非法 UTF-8 解码计数（供统计与告警：GBK 等编码此前会静默变成乱码符号名） */
let _nonUtf8FileCount = 0;
/**
 * 读取文本文件并处理编码：
 * 先按 UTF-8 解，若出现替换字符（U+FFFD，说明字节序列不是合法 UTF-8）则尝试 GBK 回退，
 * 避免中文源码在索引里变成乱码符号名（此前直接 readFile utf-8，静默损坏）。
 */
async function readTextFileSmart(filePath) {
    const buf = await fs.promises.readFile(filePath);
    const utf8 = buf.toString('utf-8');
    // 快速路径：合法 UTF-8（绝大多数文件）只解一次码。
    // 注意：这里必须避免"再调一次 decodeTextBuffer"——那会让每个源文件被解码两遍，
    // 实测 2 万文件时索引构建从 ~6.5s 劣化到 ~11.5s。
    if (!utf8.includes('\uFFFD')) {
        return (0, textFile_1.stripBom)(utf8);
    }
    // 异常编码（GBK / UTF-16 等）才走完整判定
    const decoded = (0, textFile_1.decodeTextBuffer)(buf, filePath);
    if (decoded !== utf8) {
        _nonUtf8FileCount++;
    }
    return decoded;
}
async function parseFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    try {
        // 异步读：批量索引时不再让单个文件的同步 IO 卡住扩展宿主
        const content = await readTextFileSmart(filePath);
        // TS/JS 系：完整 AST 解析（含调用图）
        if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs' || ext === '.mts' || ext === '.cts') {
            const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, 
            /* setParentNodes */ true, ts.ScriptKind.TSX);
            const collector = collectSymbols(sourceFile, filePath);
            return {
                symbols: collector.symbols,
                imports: collector.imports,
                calls: collector.calls,
            };
        }
        // 多语言：轻量行级解析（无调用图）
        const parsed = ext === '.py' ? parsePython(content, filePath) :
            ext === '.go' ? parseGo(content, filePath) :
                ext === '.rs' ? parseRust(content, filePath) :
                    { symbols: [], imports: [] };
        return { symbols: parsed.symbols, imports: parsed.imports, calls: [] };
    }
    catch (err) {
        logger_1.logger.warn(`[ProjectIndexer] parseFile failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
// ── 索引持久化 ────────────────────────────────────────────────
function getIndexPath() {
    const base = (0, paths_1.getWorkspaceKodrixDir)();
    return base ? path.join(base, 'codebase', 'project-index.json') : undefined;
}
function loadExistingIndex() {
    const indexPath = getIndexPath();
    if (!indexPath || !fs.existsSync(indexPath)) {
        return null;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        if ((0, jsonValidator_1.isRecord)(raw) && (0, jsonValidator_1.isNumber)(raw.version) && (0, jsonValidator_1.isRecord)(raw.symbols) && (0, jsonValidator_1.isString)(raw.rootPath)) {
            return raw;
        }
    }
    catch { /* corrupt */ }
    return null;
}
/** 尾部组装阶段长循环的让出节奏（迭代次数） */
const TAIL_LOOP_YIELD_INTERVAL = 2000;
/** 长循环里周期性让出事件循环（尾部组装阶段避免长时间独占扩展宿主） */
async function yieldLoop(iteration) {
    if (iteration % TAIL_LOOP_YIELD_INTERVAL === 0) {
        await new Promise(resolve => setImmediate(resolve));
    }
}
/**
 * 流式写索引 JSON：产出与 `JSON.stringify(index)` 等价的紧凑 JSON，但分段写入、段间让出。
 * 20k 文件的索引约 50MB，一次性 stringify 实测单次阻塞约 175ms（`npm run measure:index-perf`）。
 * 注意：必须先在内存里攒够 `FLUSH_THRESHOLD` 个字符再落 stream，
 * 否则会退化成数百万次小 write（实测总耗时从 10s 涨到 23s）。
 */
const INDEX_JSON_FLUSH_CHARS = 512 * 1024;
async function writeIndexJson(stream, index) {
    let buffer = '';
    const flush = async () => {
        if (!buffer) {
            return;
        }
        const chunk = buffer;
        buffer = '';
        if (!stream.write(chunk)) {
            await new Promise(resolve => stream.once('drain', () => resolve()));
        }
        // 每个 flush 之间让出，避免连续编码/写盘长时间占用宿主
        await new Promise(resolve => setImmediate(resolve));
    };
    const write = async (chunk) => {
        buffer += chunk;
        if (buffer.length >= INDEX_JSON_FLUSH_CHARS) {
            await flush();
        }
    };
    const writeValue = async (value) => {
        if (Array.isArray(value)) {
            await write('[');
            for (let i = 0; i < value.length; i++) {
                if (i > 0) {
                    await write(',');
                }
                await writeValue(value[i]);
            }
            await write(']');
            return;
        }
        if (value !== null && typeof value === 'object') {
            await write('{');
            let first = true;
            for (const [key, entry] of Object.entries(value)) {
                if (!first) {
                    await write(',');
                }
                first = false;
                await write(`${JSON.stringify(key)}:`);
                await writeValue(entry);
            }
            await write('}');
            return;
        }
        await write(JSON.stringify(value) ?? 'null');
    };
    await writeValue(index);
    await flush();
}
// 只改字段、不重新绑定（保持引用稳定，便于面板与诊断读取）
const _lastBuildDiagnostics = { saveFailed: false, parseFailures: 0, nonUtf8Files: 0 };
/** 读取最近一次构建的诊断信息（供面板/命令展示） */
function getLastBuildDiagnostics() {
    return { ..._lastBuildDiagnostics, nonUtf8Files: _nonUtf8FileCount };
}
async function saveIndex(index, session) {
    const indexPath = getIndexPath();
    if (!indexPath) {
        return { ok: false, error: 'no-workspace' };
    }
    // 写入可能耗时数秒：期间若「删除索引」被触发，必须放弃 rename，
    // 否则原子 rename 会把刚被删掉的索引文件又写回来（用户看到"删了又回来了"）。
    const deleteGeneration = _deleteGeneration;
    try {
        (0, paths_1.ensureDir)(path.dirname(indexPath));
        // 流式写：避免一次性构造 ~50MB 字符串（实测单次 stringify 阻塞约 175ms）
        await (0, fsSafe_1.atomicWriteStreamAsync)(indexPath, stream => writeIndexJson(stream, index), { shouldCommit: () => deleteGeneration === _deleteGeneration && (session === undefined || isBuildCurrent(session)) });
        _lastBuildDiagnostics.saveFailed = false;
        _lastBuildDiagnostics.saveError = undefined;
        return { ok: true };
    }
    catch (err) {
        // 不受信任工作区会被写入闸门拒绝：索引仍可在内存中使用，只是不落盘
        const message = err instanceof Error ? err.message : String(err);
        logger_1.logger.warn(`[ProjectIndexer] 索引写入失败（不受信任工作区/磁盘错误/构建已过期）：${message}`);
        _lastBuildDiagnostics.saveFailed = true;
        _lastBuildDiagnostics.saveError = message;
        return { ok: false, error: message };
    }
}
/**
 * 增量刷新索引：按文件指纹（mtime + size）检测变更，只重解析变更/新增文件，
 * 移除已删除文件的符号与关系（对标 Cursor Merkle 树增量索引）。
 * @param session 可选构建会话号；传入时尊重 pause/delete/force 中止
 */
async function updateProjectIndexIncrementally(index, session) {
    const rootPath = index.rootPath;
    const start = Date.now();
    const config = DEFAULT_CONFIG;
    invalidateCursorignoreCache();
    const checkCurrent = () => {
        if (session === undefined) {
            return;
        }
        if (!isBuildCurrent(session)) {
            throw new Error('Index build cancelled');
        }
    };
    // 1) 扫描当前文件集合
    const files = await discoverFiles(rootPath, config);
    checkCurrent();
    const current = new Set(files);
    const changedFiles = [];
    const removedFiles = [];
    for (const f of files) {
        const prev = index.files[f];
        if (!prev) {
            continue;
        }
        try {
            const stat = fs.statSync(f);
            if (stat.mtimeMs !== prev.lastModified || stat.size !== prev.sizeBytes) {
                changedFiles.push(f);
            }
        }
        catch {
            removedFiles.push(f);
        }
    }
    for (const f of Object.keys(index.files)) {
        if (!current.has(f)) {
            removedFiles.push(f);
        }
    }
    const addedFiles = files.filter(f => !index.files[f]);
    const unchanged = files.length - addedFiles.length - changedFiles.length;
    if (!addedFiles.length && !changedFiles.length && !removedFiles.length) {
        logger_1.logger.info(`[ProjectIndexer] Incremental: no changes (${files.length} files)`);
        index.updatedAt = new Date().toISOString();
        return index;
    }
    // 2) 移除变更/删除文件的旧符号
    const symbols = index.symbols;
    const symbolNameIndex = index.symbolNameIndex;
    const fileSummaries = index.files;
    const affected = new Set([...changedFiles, ...removedFiles]);
    for (const f of affected) {
        for (const id of Object.keys(symbols)) {
            if (id.startsWith(f + '#')) {
                delete symbols[id];
            }
        }
    }
    // 3) 重建符号名索引
    for (const k of Object.keys(symbolNameIndex)) {
        delete symbolNameIndex[k];
    }
    for (const id of Object.keys(symbols)) {
        const name = symbols[id].name;
        if (!symbolNameIndex[name]) {
            symbolNameIndex[name] = [];
        }
        symbolNameIndex[name].push(id);
    }
    // 4) 清理受影响文件的 imports/calls
    index.imports = index.imports.filter(r => !affected.has(r.importerPath) && !affected.has(r.importeePath));
    index.calls = index.calls.filter(r => {
        for (const f of affected) {
            if (r.callerId.startsWith(f + '#') || r.calleeId.startsWith(f + '#')) {
                return false;
            }
        }
        return true;
    });
    // 5) 解析变更 + 新增文件
    const toParse = [...addedFiles, ...changedFiles];
    for (let i = 0; i < toParse.length; i++) {
        if (i > 0 && i % 50 === 0) {
            checkCurrent();
        }
        const filePath = toParse[i];
        const result = await parseFile(filePath);
        if (result) {
            for (const sym of result.symbols) {
                symbols[sym.id] = sym;
                if (!symbolNameIndex[sym.name]) {
                    symbolNameIndex[sym.name] = [];
                }
                symbolNameIndex[sym.name].push(sym.id);
            }
            index.imports.push(...result.imports);
            // 与全量构建同一规则：仅当同名候选唯一时才把 calleeId 解析为符号 id
            // （此前全量会把它改写成"最后一个同名符号"、增量完全不改 → 两次构建调用图不一致）
            for (const call of result.calls) {
                const shortName = call.calleeId.split('#')[1];
                const candidates = symbolNameIndex[shortName];
                if (candidates && candidates.length === 1) {
                    call.calleeId = candidates[0];
                }
            }
            index.calls.push(...result.calls);
            const stat = fs.statSync(filePath);
            const ext = path.extname(filePath);
            fileSummaries[filePath] = {
                filePath,
                relativePath: path.relative(rootPath, filePath).replace(/\\/g, '/'),
                symbolCount: result.symbols.length,
                exportCount: result.symbols.filter(s => s.visibility === types_1.SymbolVisibility.Exported || s.exportKind).length,
                importCount: result.imports.length,
                sizeBytes: stat.size,
                lastModified: stat.mtimeMs,
                language: ext.replace('.', ''),
            };
        }
        else {
            // 解析失败：从索引移除该文件
            for (const id of Object.keys(symbols)) {
                if (id.startsWith(filePath + '#')) {
                    delete symbols[id];
                }
            }
            delete fileSummaries[filePath];
        }
    }
    checkCurrent();
    // 6) 删除文件清理
    for (const f of removedFiles) {
        delete fileSummaries[f];
    }
    // 7) 重建依赖图
    const depGraph = Object.create(null);
    const revDepGraph = Object.create(null);
    const indexedPaths = new Set(Object.keys(fileSummaries));
    for (const imp of index.imports) {
        if (!imp.importeePath || imp.importeePath === imp.importerPath) {
            continue;
        }
        if (imp.moduleSpecifier.startsWith('.') && !indexedPaths.has(imp.importeePath)) {
            continue;
        }
        if (!depGraph[imp.importerPath]) {
            depGraph[imp.importerPath] = [];
        }
        if (!depGraph[imp.importerPath].includes(imp.importeePath)) {
            depGraph[imp.importerPath].push(imp.importeePath);
        }
        if (!revDepGraph[imp.importeePath]) {
            revDepGraph[imp.importeePath] = [];
        }
        if (!revDepGraph[imp.importeePath].includes(imp.importerPath)) {
            revDepGraph[imp.importeePath].push(imp.importerPath);
        }
    }
    index.dependencyGraph = depGraph;
    index.reverseDependencyGraph = revDepGraph;
    // 8) 重算热门符号
    const refCount = {};
    for (const id of Object.keys(symbols)) {
        refCount[id] = 0;
    }
    const nameToIds = new Map();
    for (const [name, ids] of Object.entries(symbolNameIndex)) {
        nameToIds.set(name, ids);
    }
    for (const call of index.calls) {
        const shortName = call.calleeId.split('#')[1];
        const candidates = nameToIds.get(shortName);
        if (candidates) {
            for (const candidateId of candidates) {
                refCount[candidateId] = (refCount[candidateId] || 0) + 1;
            }
        }
    }
    index.hotSymbols = Object.entries(refCount)
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([id]) => id);
    // 9) 重算统计
    const newLangDist = {};
    for (const f of Object.keys(fileSummaries)) {
        // 与全量构建/full 路径保持同一口径：去掉点号并小写（此前增量保留 ".ts"，
        // 面板按 "ts" 取数时两种构建方式下图表会不一致）
        const ext = path.extname(f).toLowerCase().replace(/^\./, '') || 'other';
        newLangDist[ext] = (newLangDist[ext] || 0) + 1;
    }
    index.stats.languageDistribution = newLangDist;
    index.stats.totalFiles = Object.keys(fileSummaries).length;
    index.stats.totalSymbols = Object.keys(symbols).length;
    index.stats.totalImports = index.imports.length;
    index.stats.totalCalls = index.calls.length;
    index.stats.indexDurationMs = Date.now() - start;
    index.updatedAt = new Date().toISOString();
    checkCurrent();
    await saveIndex(index, session);
    logger_1.logger.info(`[ProjectIndexer] Incremental: +${addedFiles.length} added, ~${changedFiles.length} changed, -${removedFiles.length} removed (unchanged ${unchanged})`);
    return index;
}
// ── 公开 API ──────────────────────────────────────────────────
let _index = null;
let _indexPromise = null;
let _watcher = null;
let _debounceTimer;
/** 构建世代：force / delete 时递增，使过期的 in-flight 构建放弃写回 _index */
let _buildSession = 0;
/** 删除世代：deleteProjectIndex 时递增，使"写入期间被删除"的落盘操作放弃 rename */
let _deleteGeneration = 0;
let _buildStatus = 'idle';
let _buildProgress = { parsed: 0, total: 0 };
let _buildAbort = false;
const _onIndexStateChange = new vscode.EventEmitter();
/** 索引状态变更事件（构建进度 / 暂停 / 完成 / 删除） */
exports.onIndexStateChange = _onIndexStateChange.event;
/** 获取当前索引状态快照（供面板渲染） */
function getIndexState() {
    const idx = _index;
    return {
        status: _buildStatus,
        progress: { ..._buildProgress },
        stats: idx?.stats ?? null,
        files: getIndexFiles(30),
    };
}
function fireIndexState() {
    _onIndexStateChange.fire(getIndexState());
}
/** 使当前 in-flight 构建失效（不再写回内存索引） */
function invalidateInFlightBuild() {
    _buildSession++;
    _buildAbort = true;
}
function isBuildCurrent(session) {
    return session === _buildSession && !_buildAbort;
}
/**
 * 暂停构建（面板 Pause Indexing）。
 * 实现为「中止当前构建」而非挂起：挂起会留下一个永不 resolve 的 _indexPromise，
 * 使后续所有 ensureProjectIndex() 卡死；中止 + Resume 重建代价相同（索引为增量友好），
 * 且无卡死风险。
 * ponytail: 中止语义，进度不冻结续传；若需真暂停续传再引入可取消任务队列。
 */
function pauseIndexBuild() {
    if (_buildStatus !== 'building') {
        return;
    }
    _buildAbort = true;
    _buildStatus = 'paused';
    logger_1.logger.info('[ProjectIndexer] Index build paused (aborted) by user');
    fireIndexState();
}
/** 恢复构建（面板 Resume）：重新触发全量索引 */
/** 恢复构建（面板 Resume）：优先复用磁盘索引做增量刷新，避免暂停后从零重建 */
function resumeIndexBuild() {
    if (_buildStatus !== 'paused') {
        return;
    }
    _buildStatus = 'building';
    logger_1.logger.info('[ProjectIndexer] Index build resumed');
    fireIndexState();
    // 注意用非 force：force 会让 buildProjectIndex 跳过 loadExistingIndex()，
    // 等于把「恢复」变成「全量重来」（大仓库上代价极高）。
    void ensureProjectIndex(false).catch(err => logger_1.logger.warn(`[ProjectIndexer] Resumed build failed: ${err instanceof Error ? err.message : String(err)}`));
}
/** 删除项目索引（面板 删除索引）：中止构建、清空内存与磁盘索引 */
async function deleteProjectIndex() {
    invalidateInFlightBuild();
    // 让"正在写入"的 saveIndex 在 rename 前放弃，避免删除后索引文件复活
    _deleteGeneration++;
    disposeIndexWatcher();
    _index = null;
    // 不把 _indexPromise 置 null：让 in-flight 的 finally 自行按 session 清理；
    // 过期构建在写回前会因 session 不匹配而放弃。
    const indexPath = getIndexPath();
    try {
        if (indexPath && fs.existsSync(indexPath)) {
            fs.unlinkSync(indexPath);
        }
    }
    catch (err) {
        logger_1.logger.warn(`[ProjectIndexer] Failed to delete index file: ${err instanceof Error ? err.message : String(err)}`);
    }
    _buildStatus = 'idle';
    _buildProgress = { parsed: 0, total: 0 };
    // 保持 _buildAbort=true，直到下一次合法构建 beginBuild 时清零
    logger_1.logger.info('[ProjectIndexer] Project index deleted by user');
    fireIndexState();
}
/** 已索引文件列表（按最近修改排序；limit 省略时返回全部） */
function getIndexFiles(limit) {
    const idx = _index;
    if (!idx) {
        return [];
    }
    const list = Object.values(idx.files).sort((a, b) => b.lastModified - a.lastModified);
    return limit ? list.slice(0, limit) : list;
}
// ── 即时 Grep 索引（BETA，对标 Cursor「为即时 Grep 索引仓库」） ──
function getGrepIndexPath() {
    const base = (0, paths_1.getWorkspaceKodrixDir)();
    return base ? path.join(base, 'codebase', 'grep-index.json') : undefined;
}
/** 全量扫描仓库文本文件清单（不限扩展名，排除构建/依赖目录），用于加速即时 Grep */
async function ensureGrepIndex() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return [];
    }
    // 开关是权威来源：关闭时不构建、也不落盘（此前只影响设置面板上的即时构建，语义不完整）
    if (!vscode.workspace.getConfiguration('kodrix.codebase').get('grepIndex', true)) {
        return [];
    }
    const rootPath = folder.uri.fsPath;
    const files = await collectAllTextFiles(rootPath);
    const indexPath = getGrepIndexPath();
    if (indexPath) {
        try {
            (0, paths_1.ensureDir)(path.dirname(indexPath));
            (0, fsSafe_1.atomicWriteFileSync)(indexPath, JSON.stringify(files, null, 2));
        }
        catch (err) {
            logger_1.logger.warn(`[ProjectIndexer] Failed to write grep index: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return files;
}
/** 遍历期间每隔多少个目录让出一次事件循环（避免同步遍历长时间阻塞扩展宿主） */
const DIR_TRAVERSAL_YIELD_INTERVAL = 200;
/** 遍历期间累计多少个目录条目就让出一次（逐文件 glob 判定本身耗时，仅按目录让出不够） */
const DISCOVER_YIELD_ENTRIES = 1000;
async function collectAllTextFiles(rootPath) {
    const result = [];
    const stack = [rootPath];
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.kodrix', 'target', 'coverage', '.next', '.nuxt', '.venv', '__pycache__']);
    let visitedDirs = 0;
    while (stack.length) {
        const dir = stack.pop();
        visitedDirs++;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            entries = [];
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && !skipDirs.has(entry.name)) {
                    stack.push(full);
                }
            }
            else if (entry.isFile()) {
                result.push(path.relative(rootPath, full).replace(/\\/g, '/'));
            }
        }
        // 每 N 个目录让出一次事件循环；遍历结果与排序不变
        if (visitedDirs % DIR_TRAVERSAL_YIELD_INTERVAL === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    result.sort();
    return result;
}
/** 读取已缓存的 Grep 索引文件清单（未构建时返回空数组） */
function getGrepIndexFiles() {
    const indexPath = getGrepIndexPath();
    if (!indexPath || !fs.existsSync(indexPath)) {
        return [];
    }
    try {
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        return Array.isArray(data) ? data : [];
    }
    catch {
        return [];
    }
}
/** 清除 Grep 索引缓存（开关关闭时调用） */
function clearGrepIndex() {
    const indexPath = getGrepIndexPath();
    try {
        if (indexPath && fs.existsSync(indexPath)) {
            fs.unlinkSync(indexPath);
        }
    }
    catch (err) {
        logger_1.logger.warn(`[ProjectIndexer] Failed to clear grep index: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** 获取当前项目索引（懒加载） */
function getProjectIndex() {
    return _index;
}
/** Build or return the cached project index, with guard against concurrent rebuilds. */
async function ensureProjectIndex(force = false, options) {
    if (_index && !force) {
        return _index;
    }
    // force：作废 in-flight，避免旧构建晚到写回把新索引覆盖成「0 文件」或脏数据
    if (force) {
        invalidateInFlightBuild();
        _index = null;
    }
    // 非 force 时并入进行中的构建；force 时抛开旧 promise，另起新会话
    if (_indexPromise && !force) {
        return _indexPromise;
    }
    const running = buildProjectIndex(force, options);
    _indexPromise = running;
    try {
        // _index 由 buildProjectIndex 在确认 session 有效后写入；此处不再次赋值，
        // 以免 delete 清空后被过期 resolve 重新灌回。
        return await running;
    }
    finally {
        // 只清理自己的 promise，避免误清后来的 force 重建
        if (_indexPromise === running) {
            _indexPromise = null;
        }
    }
}
/** 全量构建项目索引 */
async function buildProjectIndex(force = false, options) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        throw new Error('No workspace folder open');
    }
    // 新会话：清 abort，并使此前 invalidate 的世代成为「当前」
    _buildAbort = false;
    const session = ++_buildSession;
    const rootPath = folder.uri.fsPath;
    const config = DEFAULT_CONFIG;
    const startTime = Date.now();
    invalidateCursorignoreCache();
    logger_1.logger.info(`[ProjectIndexer] Starting full project index of: ${rootPath} (session=${session})`);
    // 尝试增量复用
    const existing = !force ? loadExistingIndex() : null;
    if (existing && existing.rootPath === rootPath && existing.version === INDEX_VERSION) {
        logger_1.logger.info(`[ProjectIndexer] Reusing existing index, running incremental refresh`);
        _buildStatus = 'building';
        _buildProgress = { parsed: 0, total: Object.keys(existing.files).length };
        // 先挂上已有索引，避免面板在增量期间读到 null →「0 文件」
        _index = existing;
        fireIndexState();
        try {
            const updated = await updateProjectIndexIncrementally(existing, session);
            if (!isBuildCurrent(session)) {
                throw new Error('Index build cancelled');
            }
            _index = updated;
            _buildStatus = 'done';
            _buildProgress = { parsed: updated.stats.totalFiles, total: updated.stats.totalFiles };
            fireIndexState();
            return updated;
        }
        catch (err) {
            // 增量原地改写；仅当我们仍持有该引用时从磁盘回滚（避免覆盖 force/新会话结果）
            if (!isBuildCurrent(session) && _index === existing) {
                const reloaded = loadExistingIndex();
                _index = reloaded && reloaded.rootPath === rootPath ? reloaded : null;
            }
            throw err;
        }
    }
    // 发现文件
    const files = await discoverFiles(rootPath, config);
    logger_1.logger.info(`[ProjectIndexer] Discovered ${files.length} source files`);
    // 文件数上限：设置说明写了「自动索引少于 50,000 个文件的文件夹」，代码必须真的拦住。
    // 自动（启动）路径超限即放弃并交给调用方给出可操作提示；手动「重建索引」视为用户明确要求，继续执行。
    const maxAutoFiles = (0, constants_1.clampMaxAutoIndexFiles)(vscode.workspace.getConfiguration('kodrix.codebase').get('maxAutoIndexFiles', constants_1.MAX_AUTO_INDEX_FILES));
    if (!options?.manual && files.length > maxAutoFiles) {
        throw new Error(`${constants_1.INDEX_TOO_MANY_FILES_PREFIX}:${files.length}:${maxAutoFiles}`);
    }
    // 重置构建状态并广播（供「索引与文档」面板展示进度）
    _buildStatus = 'building';
    _buildProgress = { parsed: 0, total: files.length };
    fireIndexState();
    // 解析所有文件
    const allSymbols = [];
    const allImports = [];
    const allCalls = [];
    const fileSummaries = {};
    const langDist = {};
    let parsed = 0;
    /** 解析失败文件数：写入构建诊断，避免"索引里少了一批文件"完全无迹可循 */
    let parseFailures = 0;
    // 每批文件数：解析本身是同步 CPU 工作，批越大单次阻塞越久。
    // 实测 2 万文件时 50/批 → 单次约 80ms；25/批 → 约 40ms（总耗时基本不变）。
    const BATCH_SIZE = 25;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        // 中止 / 被 force·delete 作废：不改写 status（pause/delete 已设置）
        if (!isBuildCurrent(session)) {
            throw new Error('Index build cancelled');
        }
        const batch = files.slice(i, i + BATCH_SIZE);
        for (const filePath of batch) {
            const result = await parseFile(filePath);
            if (result) {
                allSymbols.push(...result.symbols);
                allImports.push(...result.imports);
                allCalls.push(...result.calls);
                // 语言分布 key 统一为小写、无点（增量路径同口径，否则面板图表按 "ts" 取数会缺项）
                const ext = path.extname(filePath).toLowerCase().replace(/^\./, '') || 'other';
                langDist[ext] = (langDist[ext] || 0) + 1;
                const stat = fs.statSync(filePath);
                const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
                fileSummaries[filePath] = {
                    filePath,
                    relativePath,
                    symbolCount: result.symbols.length,
                    exportCount: result.symbols.filter(s => s.visibility === types_1.SymbolVisibility.Exported || s.exportKind).length,
                    importCount: result.imports.length,
                    sizeBytes: stat.size,
                    lastModified: stat.mtimeMs,
                    language: ext.replace('.', ''),
                };
            }
            else {
                // 解析失败（文件被占用/语法异常/读盘错误）：此前静默跳过，用户只看到"少了一批文件"
                parseFailures++;
            }
            parsed++;
        }
        // 每批次报告进度（驱动面板进度条）— 仅当前会话推送
        if (isBuildCurrent(session)) {
            _buildProgress = { parsed, total: files.length };
            fireIndexState();
        }
        if (parsed % 200 === 0) {
            logger_1.logger.info(`[ProjectIndexer] Parsed ${parsed}/${files.length} files (${allSymbols.length} symbols found)`);
        }
        // 每批让出一次事件循环：解析本身是同步的，若不 yield 会长时间占满
        // 扩展宿主线程（阻塞其他扩展命令 / UI 消息）。批量产出与中止检查不变。
        await new Promise(resolve => setImmediate(resolve));
    }
    if (!isBuildCurrent(session)) {
        throw new Error('Index build cancelled');
    }
    // ── 构建索引结构 ──
    // 符号表（Object.create(null) 防止 __proto__/constructor 等符号名触发原型污染或非数组命中）
    const symbols = Object.create(null);
    const symbolNameIndex = Object.create(null);
    let symbolLoop = 0;
    for (const sym of allSymbols) {
        symbols[sym.id] = sym;
        if (!symbolNameIndex[sym.name]) {
            symbolNameIndex[sym.name] = [];
        }
        symbolNameIndex[sym.name].push(sym.id);
        await yieldLoop(++symbolLoop);
    }
    // 依赖图：仅记录实际被索引的文件之间的关系
    const depGraph = Object.create(null);
    const revDepGraph = Object.create(null);
    const indexedPaths = new Set(Object.keys(fileSummaries));
    let importLoop = 0;
    for (const imp of allImports) {
        // 跳过自引用和无法解析的相对路径
        if (!imp.importeePath || imp.importeePath === imp.importerPath) {
            continue;
        }
        if (imp.moduleSpecifier.startsWith('.') && !indexedPaths.has(imp.importeePath)) {
            continue;
        }
        if (!depGraph[imp.importerPath]) {
            depGraph[imp.importerPath] = [];
        }
        if (!depGraph[imp.importerPath].includes(imp.importeePath)) {
            depGraph[imp.importerPath].push(imp.importeePath);
        }
        if (!revDepGraph[imp.importeePath]) {
            revDepGraph[imp.importeePath] = [];
        }
        if (!revDepGraph[imp.importeePath].includes(imp.importerPath)) {
            revDepGraph[imp.importeePath].push(imp.importerPath);
        }
        await yieldLoop(++importLoop);
    }
    // 热门符号（被引用次数）
    // 先建立符号名→id 反向索引，避免 O(n^2) 遍历
    const refCount = {};
    let refLoop = 0;
    for (const sym of allSymbols) {
        refCount[sym.id] = 0;
        await yieldLoop(++refLoop);
    }
    const nameToIds = new Map();
    for (const [name, ids] of Object.entries(symbolNameIndex)) {
        nameToIds.set(name, ids);
    }
    let callLoop = 0;
    for (const call of allCalls) {
        const shortName = call.calleeId.split('#')[1];
        const candidates = nameToIds.get(shortName);
        if (candidates && candidates.length === 1) {
            // 唯一候选才把 calleeId 解析成符号 id：此前在循环里无条件赋值，结果是
            // "最后一个同名符号"（随机），同一份代码全量构建与增量构建的调用图不一致。
            refCount[candidates[0]] = (refCount[candidates[0]] || 0) + 1;
            call.calleeId = candidates[0];
        }
        else if (candidates) {
            // 同名多个候选：无法确定指向谁 → 不改写 calleeId，仅计入热度
            for (const candidateId of candidates) {
                refCount[candidateId] = (refCount[candidateId] || 0) + 1;
            }
        }
        await yieldLoop(++callLoop);
    }
    const hotSymbols = Object.entries(refCount)
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([id]) => id);
    // 统计：与增量路径同一口径 —— 符号数按**去重后的 id 数**报
    // （此前全量报 allSymbols.length、增量报 Object.keys(symbols).length，同一仓库两种构建数字不同）
    const uniqueSymbolIds = new Set(allSymbols.map(s => s.id));
    const stats = {
        totalFiles: Object.keys(fileSummaries).length,
        totalSymbols: uniqueSymbolIds.size,
        totalImports: allImports.length,
        totalCalls: allCalls.length,
        languageDistribution: langDist,
        indexDurationMs: Date.now() - startTime,
    };
    // 记录本次构建诊断（解析失败数），供 UI/日志展示
    _lastBuildDiagnostics.parseFailures = parseFailures;
    const index = {
        version: INDEX_VERSION,
        rootPath,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        symbols,
        symbolNameIndex,
        files: fileSummaries,
        imports: allImports,
        dependencyGraph: depGraph,
        reverseDependencyGraph: revDepGraph,
        calls: allCalls,
        hotSymbols,
        stats,
    };
    if (!isBuildCurrent(session)) {
        throw new Error('Index build cancelled');
    }
    await saveIndex(index, session);
    logger_1.logger.info(`[ProjectIndexer] Index complete: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.totalImports} imports, ${stats.indexDurationMs}ms`);
    // 落盘失败/解析失败不能只写日志：UI 会报"索引完成"，重启后却发现索引不见了
    const diagnostics = getLastBuildDiagnostics();
    if (diagnostics.saveFailed || diagnostics.parseFailures > 0) {
        logger_1.logger.warn(`[ProjectIndexer] 构建诊断：落盘${diagnostics.saveFailed ? '失败' : '成功'}、解析失败 ${diagnostics.parseFailures} 个文件、非 UTF-8 ${diagnostics.nonUtf8Files} 个文件`);
        if (diagnostics.saveFailed) {
            vscode.window.showWarningMessage(vscode_1.l10n.t('The index was built but could not be written to disk ({0}). It is usable in this session, but must be rebuilt after restart.', diagnostics.saveError ?? vscode_1.l10n.t('unknown reason')));
        }
    }
    // 必须先写入 _index 再广播 done，否则设置页会收到「完成 + 0 文件」并卡住
    _index = index;
    _buildStatus = 'done';
    _buildProgress = { parsed: stats.totalFiles, total: stats.totalFiles };
    fireIndexState();
    return index;
}
/**
 * 文件变更后的增量刷新（供 watcher 使用）。
 * 无内存索引时走 ensureProjectIndex（可复用磁盘索引）；已有索引时只做增量，避免 force 全量清空。
 */
async function refreshProjectIndexIncrementally() {
    // 构建进行中：并入同一 promise，避免并发写坏索引
    if (_indexPromise) {
        return _indexPromise;
    }
    if (_buildStatus === 'paused') {
        return _index ?? ensureProjectIndex(false);
    }
    if (!_index) {
        return ensureProjectIndex(false);
    }
    _buildAbort = false;
    const session = ++_buildSession;
    const snapshot = _index;
    const running = (async () => {
        _buildStatus = 'building';
        _buildProgress = { parsed: 0, total: Object.keys(snapshot.files).length };
        fireIndexState();
        try {
            const updated = await updateProjectIndexIncrementally(snapshot, session);
            if (!isBuildCurrent(session)) {
                throw new Error('Index build cancelled');
            }
            _index = updated;
            _buildStatus = 'done';
            _buildProgress = { parsed: updated.stats.totalFiles, total: updated.stats.totalFiles };
            fireIndexState();
            return updated;
        }
        catch (err) {
            if (!isBuildCurrent(session)) {
                // 仅当我们仍持有被改写的同一引用时回滚，避免覆盖 force/新会话结果
                if (_index === snapshot) {
                    const reloaded = loadExistingIndex();
                    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    _index = reloaded && folderPath && reloaded.rootPath === folderPath ? reloaded : null;
                }
            }
            else {
                // 本会话失败：保留内存索引，状态回 done
                _buildStatus = _index ? 'done' : 'idle';
                fireIndexState();
            }
            throw err;
        }
    })();
    _indexPromise = running;
    try {
        return await running;
    }
    finally {
        if (_indexPromise === running) {
            _indexPromise = null;
        }
    }
}
/** 安装文件监听器，实现增量更新 */
function startIndexWatcher(context) {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('codebaseIntelligence', true);
    if (!enabled) {
        logger_1.logger.info('[ProjectIndexer] Disabled by configuration');
        return;
    }
    // 「索引新文件夹」开关：关闭时不做自动索引与文件监听（仍可手动重建）
    const autoIndex = vscode.workspace.getConfiguration('kodrix.codebase').get('autoIndexNewFolders', true);
    if (!autoIndex) {
        logger_1.logger.info('[ProjectIndexer] Auto index disabled by configuration (索引新文件夹 关闭)');
        return;
    }
    if (_watcher) {
        return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return;
    }
    const config = DEFAULT_CONFIG;
    const pattern = `**/*.{${config.includeExtensions.map(e => e.replace('.', '')).join(',')}}`;
    _watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
    const scheduleRebuild = () => {
        if (_debounceTimer) {
            clearTimeout(_debounceTimer);
        }
        _debounceTimer = setTimeout(() => {
            logger_1.logger.info('[ProjectIndexer] File changed, scheduling incremental rebuild');
            // 增量刷新：勿 force 全量重建（会清空 _index 并在完成瞬间向面板推送 0 文件）
            void refreshProjectIndexIncrementally().catch(err => logger_1.logger.warn(`[ProjectIndexer] Incremental rebuild failed: ${err instanceof Error ? err.message : String(err)}`));
        }, 500);
    };
    _watcher.onDidCreate(scheduleRebuild);
    _watcher.onDidChange(scheduleRebuild);
    _watcher.onDidDelete(scheduleRebuild);
    context.subscriptions.push(_watcher);
    // 忽略规则文件（.gitignore / .cursorignore）的变更必须：
    //   1) 先清规则缓存 —— 否则重建仍会沿用旧规则（比"不重建"更隐蔽）
    //   2) 触发**全量**重建 —— 一条规则可能一次性纳入/排除成百上千个文件，增量无意义
    const ignoreWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '{.gitignore,.cursorignore}'));
    const onIgnoreRulesChanged = () => {
        invalidateCursorignoreCache();
        if (_debounceTimer) {
            clearTimeout(_debounceTimer);
        }
        _debounceTimer = setTimeout(() => {
            logger_1.logger.info('[ProjectIndexer] 忽略规则变更，触发全量重建');
            void ensureProjectIndex(true, { manual: true }).catch(err => logger_1.logger.warn(`[ProjectIndexer] 忽略规则变更后的重建失败：${err instanceof Error ? err.message : String(err)}`));
        }, 500);
    };
    ignoreWatcher.onDidChange(onIgnoreRulesChanged);
    ignoreWatcher.onDidCreate(onIgnoreRulesChanged);
    ignoreWatcher.onDidDelete(onIgnoreRulesChanged);
    context.subscriptions.push(ignoreWatcher);
}
function disposeIndexWatcher() {
    _watcher?.dispose();
    _watcher = null;
    if (_debounceTimer) {
        clearTimeout(_debounceTimer);
    }
}
/** 释放模块级索引状态事件（在 deactivate 时调用） */
function disposeIndexStateEmitter() {
    _onIndexStateChange.dispose();
}
