/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as ts from 'typescript';
import { ensureDir, getWorkspaceKodrixDir } from '../paths';
import { logger } from '../logger';
import { isRecord, isString, isNumber } from '../utils/jsonValidator';
import { atomicWriteFileSync } from '../utils/fsSafe';
import {
	SymbolKind, SymbolVisibility,
	type CodeSymbol, type ImportRelation,
	type CallRelation, type IndexerConfig, type ProjectIndex, type IndexStats, type FileIndexSummary,
} from './types';

// ── 默认配置 ───────────────────────────────────────────────────

const DEFAULT_CONFIG: IndexerConfig = {
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
function compileGlobs(excludeGlobs: string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const glob of excludeGlobs) {
		try {
			const escaped = glob
				.replace(/\./g, '\\.')
				.replace(/\*\*/g, '<<DOUBLESTAR>>')
				.replace(/\*/g, '[^/]*')
				.replace(/<<DOUBLESTAR>>/g, '.*');
			// 拒绝会匹配任意路径的规则（如单独的 "**"），否则索引会变成 0 文件
			if (escaped === '.*') {
				logger.warn(`[ProjectIndexer] Ignoring overly broad exclude glob: ${glob}`);
				continue;
			}
			compiled.push(new RegExp('^' + escaped + '$'));
		} catch {
			// Skip invalid globs silently — the regex might be malformed
		}
	}
	return compiled;
}

function shouldExclude(filePath: string, config: IndexerConfig, rootPath?: string, compiledGlobs?: RegExp[]): boolean {
	// 扩展名过滤
	const ext = path.extname(filePath).toLowerCase();
	if (!config.includeExtensions.includes(ext)) {return true;}

	// 大小过滤
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > config.maxFileSize) {return true;}
	} catch { return true; }

	// 目录过滤
	const normalized = filePath.replace(/\\/g, '/');
	for (const dir of config.excludeDirs) {
		if (normalized.includes(`/${dir}/`) || normalized.endsWith(`/${dir}`)) {return true;}
	}

	// Glob 过滤：使用完整相对路径而非 basename，确保 **/ 等跨目录模式正确匹配
	const relativePath = rootPath
		? path.relative(rootPath, filePath).replace(/\\/g, '/')
		: path.basename(filePath);

	// 使用预编译的正则（由 discoverFiles 传入）避免每个文件重复编译
	const globs = compiledGlobs || compileGlobs(config.excludeGlobs);
	for (const regex of globs) {
		if (regex.test(relativePath)) {return true;}
	}

	return false;
}

// ── .cursorignore 支持（对标 Cursor：除 .gitignore 外额外排除） ──

let _cursorignoreCache: { root: string; globs: RegExp[] } | null = null;

function invalidateCursorignoreCache(): void {
	_cursorignoreCache = null;
}

/**
 * 读取项目根目录的 `.cursorignore`（每行一条 glob 规则，`#` 开头为注释，
 * `!` 开头的取反规则暂不支持，按忽略处理），预编译为正则列表。
 */
function getCursorignoreGlobs(rootPath: string): RegExp[] {
	const enabled = vscode.workspace.getConfiguration('kodrix.codebase').get<boolean>('ignoreCursorignore', true);
	if (!enabled) {return [];}
	if (_cursorignoreCache && _cursorignoreCache.root === rootPath) {return _cursorignoreCache.globs;}

	let globs: RegExp[] = [];
	try {
		const file = path.join(rootPath, '.cursorignore');
		if (fs.existsSync(file)) {
			const rules = fs.readFileSync(file, 'utf-8')
				.split(/\r?\n/)
				.map(l => l.trim())
				.filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'));
			globs = compileGlobs(rules);
		}
	} catch {
		/* 忽略读取失败，按无规则处理 */
	}

	_cursorignoreCache = { root: rootPath, globs };
	return globs;
}

function isCursorignoreExcluded(relativePath: string, cursorignoreGlobs: RegExp[]): boolean {
	for (const regex of cursorignoreGlobs) {
		if (regex.test(relativePath)) {return true;}
	}
	return false;
}

function discoverFiles(rootPath: string, config: IndexerConfig): string[] {
	const files: string[] = [];
	const stack = [rootPath];

	// Pre-compile globs once per discovery pass — avoids recompiling per file
	const compiledGlobs = compileGlobs(config.excludeGlobs);
	const cursorignoreGlobs = getCursorignoreGlobs(rootPath);

	while (stack.length) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }

		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && !config.excludeDirs.includes(entry.name)) {
					stack.push(full);
				}
			} else if (entry.isFile()) {
				if (!shouldExclude(full, config, rootPath, compiledGlobs)) {
					// .cursorignore 过滤：使用相对路径匹配，规则里可直接写目录或 glob
					const relativePath = path.relative(rootPath, full).replace(/\\/g, '/');
					if (!isCursorignoreExcluded(relativePath, cursorignoreGlobs)) {
						files.push(full);
					}
				}
			}
		}
	}

	return files;
}

// ── TypeScript AST 解析 ────────────────────────────────────────

function getSymbolKind(tsKind: ts.SyntaxKind): SymbolKind {
	switch (tsKind) {
		case ts.SyntaxKind.ClassDeclaration: return SymbolKind.Class;
		case ts.SyntaxKind.InterfaceDeclaration: return SymbolKind.Interface;
		case ts.SyntaxKind.FunctionDeclaration: return SymbolKind.Function;
		case ts.SyntaxKind.MethodDeclaration:
		case ts.SyntaxKind.MethodSignature: return SymbolKind.Method;
		case ts.SyntaxKind.VariableDeclaration:
		case ts.SyntaxKind.VariableStatement: return SymbolKind.Variable;
		case ts.SyntaxKind.TypeAliasDeclaration: return SymbolKind.TypeAlias;
		case ts.SyntaxKind.EnumDeclaration: return SymbolKind.Enum;
		case ts.SyntaxKind.ModuleDeclaration: return SymbolKind.Namespace;
		default: return SymbolKind.Unknown;
	}
}

function getExportKind(node: ts.Node): 'named' | 'default' | undefined {
	if (!ts.isExportAssignment(node) && !ts.isExportDeclaration(node)) {
		const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
		if (modifiers) {
			for (const m of modifiers) {
				if (m.kind === ts.SyntaxKind.ExportKeyword) {return 'named';}
				if (m.kind === ts.SyntaxKind.DefaultKeyword) {return 'default';}
			}
		}
	}
	return undefined;
}

function getVisibility(modifiers: readonly ts.Modifier[] | undefined): SymbolVisibility {
	if (!modifiers) {return SymbolVisibility.Public;}
	for (const m of modifiers) {
		if (m.kind === ts.SyntaxKind.PublicKeyword) {return SymbolVisibility.Public;}
		if (m.kind === ts.SyntaxKind.ProtectedKeyword) {return SymbolVisibility.Protected;}
		if (m.kind === ts.SyntaxKind.PrivateKeyword) {return SymbolVisibility.Private;}
		if (m.kind === ts.SyntaxKind.ExportKeyword) {return SymbolVisibility.Exported;}
	}
	return SymbolVisibility.Public;
}

function getDocComment(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
	const fullText = sourceFile.getFullText();
	const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
	if (!ranges) {return undefined;}

	const docs: string[] = [];
	for (const range of ranges) {
		const comment = fullText.slice(range.pos, range.end);
		if (comment.startsWith('/**')) {
			docs.push(comment
				.replace(/\/\*\*|\*\/|\n\s*\*\s?/g, '\n')
				.replace(/^\n+/, '')
				.trim(),
			);
		}
	}
	return docs.join('\n') || undefined;
}

function getSignature(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
	const text = node.getText(sourceFile);
	// 找到函数体的开头 { 或接口结尾的 ; 作为签名截断点
	// 需要跳过泛型参数 <...> 内、字符串/模板字符串内的 { 和 ;
	let depth = 0;
	let sigEnd = -1;
	MAIN: for (let i = 0; i < text.length; i++) {
		switch (text[i]) {
			case '<': depth++; break;
			case '>': depth--; break;
			case '{':
				if (depth <= 0) { sigEnd = i; break MAIN; }
				break;
			case ';':
				if (depth <= 0) { sigEnd = i; break MAIN; }
				break;
		}
	}
	return sigEnd > 0 ? text.slice(0, sigEnd).trim() : text.slice(0, 120);
}

function makeSymbolId(filePath: string, name: string): string {
	return `${filePath}#${name}`;
}

// ── 符号提取 ──────────────────────────────────────────────────

interface SymbolCollector {
	symbols: CodeSymbol[];
	imports: ImportRelation[];
	calls: CallRelation[];
}

function collectSymbols(sourceFile: ts.SourceFile, filePath: string): SymbolCollector {
	const collector: SymbolCollector = { symbols: [], imports: [], calls: [] };
	const parentStack: CodeSymbol[] = [];

	function getParentId(): string | undefined {
		return parentStack.length ? parentStack[parentStack.length - 1].id : undefined;
	}

	function visit(node: ts.Node): void {
		const sf = sourceFile;
		const pos = sf.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());

		// ── 类 / 接口 / 枚举 / 命名空间 ──
		if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
			ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {

			const name = node.name?.getText(sf);
			if (name) {
				const sym: CodeSymbol = {
					id: makeSymbolId(filePath, name),
					name,
					kind: getSymbolKind(node.kind),
					filePath,
					line: pos.line + 1,
					column: pos.character + 1,
					endLine: endPos.line + 1,
					endColumn: endPos.character + 1,
					parentId: getParentId(),
					visibility: getExportKind(node) === 'named' ? SymbolVisibility.Exported : getVisibility(ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined),
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
			const sym: CodeSymbol = {
				id: makeSymbolId(filePath, name),
				name,
				kind: SymbolKind.Function,
				filePath,
				line: pos.line + 1,
				column: pos.character + 1,
				endLine: endPos.line + 1,
				endColumn: endPos.character + 1,
				parentId: getParentId(),
				visibility: getExportKind(node) ? SymbolVisibility.Exported : SymbolVisibility.Public,
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
				const sym: CodeSymbol = {
					id: makeSymbolId(filePath, getParentId() ? `${getParentId()?.split('#')[1]}.${name}` : name),
					name,
					kind: SymbolKind.Method,
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
					const sym: CodeSymbol = {
						id: makeSymbolId(filePath, decl.name.text),
						name: decl.name.text,
						kind: SymbolKind.Variable,
						filePath,
						line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
						column: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).character + 1,
						endLine: sf.getLineAndCharacterOfPosition(decl.getEnd()).line + 1,
						endColumn: sf.getLineAndCharacterOfPosition(decl.getEnd()).character + 1,
						parentId: getParentId(),
						visibility: isExported ? SymbolVisibility.Exported : SymbolVisibility.Private,
						exportKind: isExported ? 'named' : undefined,
					};
					collector.symbols.push(sym);
				}
			}
		}

		// ── 类型别名 ──
		if (ts.isTypeAliasDeclaration(node)) {
			const sym: CodeSymbol = {
				id: makeSymbolId(filePath, node.name.text),
				name: node.name.text,
				kind: SymbolKind.TypeAlias,
				filePath,
				line: pos.line + 1,
				column: pos.character + 1,
				endLine: endPos.line + 1,
				endColumn: endPos.character + 1,
				parentId: getParentId(),
				visibility: SymbolVisibility.Exported,
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
			const symbols: string[] = [];
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

// ── 多语言轻量解析器（Python / Go / Rust） ─────────────────────
//
// 设计取舍：TS/JS 使用完整 AST（精确解析依赖与调用图）；
// Python/Go/Rust 使用行级正则轻量解析（零外部依赖、容错、快速），
// 覆盖 定义 / 可见性 / 签名 / 导入 记录，满足「定义定位 + 语义检索 +
// 多语言索引」需求。非 TS 语言的导入仅记录 moduleSpecifier，
// 不做相对路径文件解析（依赖图仍以 TS 体系为主，depGraph 构建时跳过）。

interface SimpleParseResult {
	symbols: CodeSymbol[];
	imports: ImportRelation[];
}

/** 提取紧邻上方连续注释行（# // /// 风格），作为简化 docComment */
function getLeadingComment(lines: string[], idx: number): string | undefined {
	const docs: string[] = [];
	for (let i = idx - 1; i >= 0; i--) {
		const m = lines[i].trim().match(/^(?:#|\/\/|\/\/\/)\s?(.*)$/);
		if (!m) {break;}
		docs.unshift(m[1]);
	}
	return docs.length ? docs.join('\n').slice(0, 300) : undefined;
}

function makeSimpleSymbol(
	filePath: string,
	name: string,
	kind: SymbolKind,
	line: number,
	column: number,
	signature: string | undefined,
	visibility: SymbolVisibility,
	parentId?: string,
	docComment?: string,
): CodeSymbol {
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
function getPythonDocstring(lines: string[], defLineIdx: number): string | undefined {
	if (defLineIdx + 1 >= lines.length) {return undefined;}
	const t = lines[defLineIdx + 1].trim();
	const m = t.match(/^('''|""")([\s\S]*)$/);
	if (!m) {return undefined;}
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

function parsePython(content: string, filePath: string): SimpleParseResult {
	const symbols: CodeSymbol[] = [];
	const imports: ImportRelation[] = [];
	const lines = content.split('\n');

	let currentClassId: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith('#')) {continue;}

		// ── class X(Base): → Class ──
		let m = trimmed.match(/^class\s+(\w+)\s*(\([^)]*\))?\s*:/);
		if (m) {
			currentClassId = undefined;
			const sym = makeSimpleSymbol(
				filePath, m[1], SymbolKind.Class, i + 1, raw.indexOf(m[1]) + 1,
				trimmed.replace(/:\s*$/, ''), SymbolVisibility.Public, undefined,
				getLeadingComment(lines, i) ?? getPythonDocstring(lines, i),
			);
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
			const sym = makeSimpleSymbol(
				filePath, name,
				isMethod ? SymbolKind.Method : SymbolKind.Function,
				i + 1, raw.indexOf(name) + 1, sig,
				name.startsWith('_') ? SymbolVisibility.Private : SymbolVisibility.Public,
				isMethod ? currentClassId : undefined,
				getLeadingComment(lines, i) ?? getPythonDocstring(lines, i),
			);
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

function parseGo(content: string, filePath: string): SimpleParseResult {
	const symbols: CodeSymbol[] = [];
	const imports: ImportRelation[] = [];
	const lines = content.split('\n');

	// 第一遍：收集 type 声明（方法需要按类型归属）
	const typeIds = new Map<string, string>();
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();
		if (!trimmed) {continue;}

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
		if (!trimmed || trimmed.startsWith('//')) {continue;}

		// import 块处理
		if (/^import\s*\(/.test(trimmed)) { inImportBlock = true; continue; }
		if (inImportBlock && trimmed === ')') { inImportBlock = false; continue; }
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
			symbols.push(makeSimpleSymbol(
				filePath, m[1], SymbolKind.Namespace, i + 1, raw.indexOf(m[1]) + 1,
				`package ${m[1]}`, SymbolVisibility.Public,
			));
			continue;
		}

		// ── type X struct/interface → Class / Interface ──
		m = trimmed.match(/^type\s+(\w+)\s+(struct|interface)\b/);
		if (m) {
			symbols.push(makeSimpleSymbol(
				filePath, m[1], m[2] === 'struct' ? SymbolKind.Class : SymbolKind.Interface,
				i + 1, raw.indexOf(m[1]) + 1, trimmed, SymbolVisibility.Public,
				undefined, getLeadingComment(lines, i),
			));
			continue;
		}

		// ── type X = ... / type X T → TypeAlias ──
		m = trimmed.match(/^type\s+(\w+)\s*=\s*(.+)$/);
		if (m) {
			symbols.push(makeSimpleSymbol(
				filePath, m[1], SymbolKind.TypeAlias, i + 1, raw.indexOf(m[1]) + 1,
				trimmed, SymbolVisibility.Public, undefined, getLeadingComment(lines, i),
			));
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
			symbols.push(makeSimpleSymbol(
				filePath, name, SymbolKind.Method, i + 1, raw.indexOf(name) + 1,
				trimmed.replace(/\{\s*$/, ''), isExported ? SymbolVisibility.Exported : SymbolVisibility.Private,
				parentId, getLeadingComment(lines, i),
			));
			continue;
		}

		// ── func Name( → Function ──
		m = trimmed.match(/^func\s+(\w+)\s*\(/);
		if (m) {
			const name = m[1];
			const isExported = /^[A-Z]/.test(name);
			symbols.push(makeSimpleSymbol(
				filePath, name, SymbolKind.Function, i + 1, raw.indexOf(name) + 1,
				trimmed.replace(/\{\s*$/, ''), isExported ? SymbolVisibility.Exported : SymbolVisibility.Private,
				undefined, getLeadingComment(lines, i),
			));
			continue;
		}

		// ── const X / var X → Variable ──
		m = trimmed.match(/^(?:const|var)\s+(\w+)/);
		if (m) {
			const name = m[1];
			const isExported = /^[A-Z]/.test(name);
			symbols.push(makeSimpleSymbol(
				filePath, name, SymbolKind.Variable, i + 1, raw.indexOf(name) + 1,
				trimmed, isExported ? SymbolVisibility.Exported : SymbolVisibility.Private,
				undefined, getLeadingComment(lines, i),
			));
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

function parseRust(content: string, filePath: string): SimpleParseResult {
	const symbols: CodeSymbol[] = [];
	const imports: ImportRelation[] = [];
	const lines = content.split('\n');


	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith('//')) {continue;}
		// 缩进的 fn（impl 块内方法）跳过，避免误判为顶层函数
		if (/^\s/.test(raw) && /(^|\s)fn\s/.test(trimmed)) {continue;}

		// ── pub struct / pub enum / pub trait → Class / Enum / Interface ──
		let m = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+(\w+)/);
		if (m) {
			const kind = m[1] === 'struct' ? SymbolKind.Class : m[1] === 'enum' ? SymbolKind.Enum : SymbolKind.Interface;
			const name = m[2];
			const isPub = /^pub/.test(trimmed);
			symbols.push(makeSimpleSymbol(
				filePath, name, kind, i + 1, raw.indexOf(name) + 1,
				trimmed.replace(/\{\s*$/, ''), isPub ? SymbolVisibility.Exported : SymbolVisibility.Private,
				undefined, getLeadingComment(lines, i),
			));
			continue;
		}

		// ── pub fn / fn → Function（顶层，无缩进） ──
		m = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?fn\s+(\w+)/);
		if (m) {
			const name = m[1];
			const isPub = /^pub/.test(trimmed);
			symbols.push(makeSimpleSymbol(
				filePath, name, SymbolKind.Function, i + 1, raw.indexOf(name) + 1,
				trimmed.replace(/\{\s*$/, ''), isPub ? SymbolVisibility.Exported : SymbolVisibility.Private,
				undefined, getLeadingComment(lines, i),
			));
			continue;
		}

		// ── pub const / pub static → Variable ──
		m = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)/);
		if (m) {
			const name = m[1];
			const isPub = /^pub/.test(trimmed);
			symbols.push(makeSimpleSymbol(
				filePath, name, SymbolKind.Variable, i + 1, raw.indexOf(name) + 1,
				trimmed.replace(/;\s*$/, ''), isPub ? SymbolVisibility.Exported : SymbolVisibility.Private,
				undefined, getLeadingComment(lines, i),
			));
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

function parseFile(filePath: string): { symbols: CodeSymbol[]; imports: ImportRelation[]; calls: CallRelation[] } | null {
	const ext = path.extname(filePath).toLowerCase();
	try {
		const content = fs.readFileSync(filePath, 'utf-8');

		// TS/JS 系：完整 AST 解析（含调用图）
		if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs' || ext === '.mts' || ext === '.cts') {
			const sourceFile = ts.createSourceFile(
				filePath, content,
				ts.ScriptTarget.Latest,
				/* setParentNodes */ true,
				ts.ScriptKind.TSX,
			);
			const collector = collectSymbols(sourceFile, filePath);
			return {
				symbols: collector.symbols,
				imports: collector.imports,
				calls: collector.calls,
			};
		}

		// 多语言：轻量行级解析（无调用图）
		const parsed: SimpleParseResult =
			ext === '.py' ? parsePython(content, filePath) :
			ext === '.go' ? parseGo(content, filePath) :
			ext === '.rs' ? parseRust(content, filePath) :
			{ symbols: [], imports: [] };
		return { symbols: parsed.symbols, imports: parsed.imports, calls: [] };
	} catch (err) {
		logger.warn(`[ProjectIndexer] parseFile failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

// ── 索引持久化 ────────────────────────────────────────────────

function getIndexPath(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'codebase', 'project-index.json') : undefined;
}

function loadExistingIndex(): ProjectIndex | null {
	const indexPath = getIndexPath();
	if (!indexPath || !fs.existsSync(indexPath)) {return null;}
	try {
		const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
		if (isRecord(raw) && isNumber(raw.version) && isRecord(raw.symbols) && isString(raw.rootPath)) {
			return raw as unknown as ProjectIndex;
		}
	} catch { /* corrupt */ }
	return null;
}

function saveIndex(index: ProjectIndex): void {
	const indexPath = getIndexPath();
	if (!indexPath) {return;}
	ensureDir(path.dirname(indexPath));
	atomicWriteFileSync(indexPath, JSON.stringify(index, null, 2));
}

// ── 增量索引（对标 Cursor Merkle 增量） ────────────────────────────

export interface IncrementalIndexResult {
	totalFiles: number;
	added: number;
	changed: number;
	removed: number;
	unchanged: number;
	durationMs: number;
}

/**
 * 增量刷新索引：按文件指纹（mtime + size）检测变更，只重解析变更/新增文件，
 * 移除已删除文件的符号与关系（对标 Cursor Merkle 树增量索引）。
 * @param session 可选构建会话号；传入时尊重 pause/delete/force 中止
 */
export async function updateProjectIndexIncrementally(
	index: ProjectIndex,
	session?: number,
): Promise<ProjectIndex> {
	const rootPath = index.rootPath;
	const start = Date.now();
	const config = DEFAULT_CONFIG;
	invalidateCursorignoreCache();

	const checkCurrent = () => {
		if (session === undefined) {return;}
		if (!isBuildCurrent(session)) {
			throw new Error('Index build cancelled');
		}
	};

	// 1) 扫描当前文件集合
	const files = discoverFiles(rootPath, config);
	checkCurrent();
	const current = new Set(files);

	const changedFiles: string[] = [];
	const removedFiles: string[] = [];

	for (const f of files) {
		const prev = index.files[f];
		if (!prev) {continue;}
		try {
			const stat = fs.statSync(f);
			if (stat.mtimeMs !== prev.lastModified || stat.size !== prev.sizeBytes) {
				changedFiles.push(f);
			}
		} catch {
			removedFiles.push(f);
		}
	}
	for (const f of Object.keys(index.files)) {
		if (!current.has(f)) {removedFiles.push(f);}
	}
	const addedFiles = files.filter(f => !index.files[f]);

	const unchanged = files.length - addedFiles.length - changedFiles.length;
	if (!addedFiles.length && !changedFiles.length && !removedFiles.length) {
		logger.info(`[ProjectIndexer] Incremental: no changes (${files.length} files)`);
		index.updatedAt = new Date().toISOString();
		return index;
	}

	// 2) 移除变更/删除文件的旧符号
	const symbols = index.symbols;
	const symbolNameIndex = index.symbolNameIndex;
	const fileSummaries = index.files;
	const affected = new Set<string>([...changedFiles, ...removedFiles]);
	for (const f of affected) {
		for (const id of Object.keys(symbols)) {
			if (id.startsWith(f + '#')) {delete symbols[id];}
		}
	}

	// 3) 重建符号名索引
	for (const k of Object.keys(symbolNameIndex)) {delete symbolNameIndex[k];}
	for (const id of Object.keys(symbols)) {
		const name = symbols[id].name;
		if (!symbolNameIndex[name]) {symbolNameIndex[name] = [];}
		symbolNameIndex[name].push(id);
	}

	// 4) 清理受影响文件的 imports/calls
	index.imports = index.imports.filter(r => !affected.has(r.importerPath) && !affected.has(r.importeePath));
	index.calls = index.calls.filter(r => {
		for (const f of affected) {
			if (r.callerId.startsWith(f + '#') || r.calleeId.startsWith(f + '#')) {return false;}
		}
		return true;
	});

	// 5) 解析变更 + 新增文件
	const toParse = [...addedFiles, ...changedFiles];
	for (let i = 0; i < toParse.length; i++) {
		if (i > 0 && i % 50 === 0) {checkCurrent();}
		const filePath = toParse[i];
		const result = parseFile(filePath);
		if (result) {
			for (const sym of result.symbols) {
				symbols[sym.id] = sym;
				if (!symbolNameIndex[sym.name]) {symbolNameIndex[sym.name] = [];}
				symbolNameIndex[sym.name].push(sym.id);
			}
			index.imports.push(...result.imports);
			index.calls.push(...result.calls);
			const stat = fs.statSync(filePath);
			const ext = path.extname(filePath);
			fileSummaries[filePath] = {
				filePath,
				relativePath: path.relative(rootPath, filePath).replace(/\\/g, '/'),
				symbolCount: result.symbols.length,
				exportCount: result.symbols.filter(s => s.visibility === SymbolVisibility.Exported || s.exportKind).length,
				importCount: result.imports.length,
				sizeBytes: stat.size,
				lastModified: stat.mtimeMs,
				language: ext.replace('.', ''),
			};
		} else {
			// 解析失败：从索引移除该文件
			for (const id of Object.keys(symbols)) {
				if (id.startsWith(filePath + '#')) {delete symbols[id];}
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
	const depGraph: Record<string, string[]> = Object.create(null);
	const revDepGraph: Record<string, string[]> = Object.create(null);
	const indexedPaths = new Set(Object.keys(fileSummaries));
	for (const imp of index.imports) {
		if (!imp.importeePath || imp.importeePath === imp.importerPath) {continue;}
		if (imp.moduleSpecifier.startsWith('.') && !indexedPaths.has(imp.importeePath)) {continue;}
		if (!depGraph[imp.importerPath]) {depGraph[imp.importerPath] = [];}
		if (!depGraph[imp.importerPath].includes(imp.importeePath)) {depGraph[imp.importerPath].push(imp.importeePath);}
		if (!revDepGraph[imp.importeePath]) {revDepGraph[imp.importeePath] = [];}
		if (!revDepGraph[imp.importeePath].includes(imp.importerPath)) {revDepGraph[imp.importeePath].push(imp.importerPath);}
	}
	index.dependencyGraph = depGraph;
	index.reverseDependencyGraph = revDepGraph;

	// 8) 重算热门符号
	const refCount: Record<string, number> = {};
	for (const id of Object.keys(symbols)) {refCount[id] = 0;}
	const nameToIds = new Map<string, string[]>();
	for (const [name, ids] of Object.entries(symbolNameIndex)) {nameToIds.set(name, ids);}
	for (const call of index.calls) {
		const shortName = call.calleeId.split('#')[1];
		const candidates = nameToIds.get(shortName);
		if (candidates) {
			for (const candidateId of candidates) {refCount[candidateId] = (refCount[candidateId] || 0) + 1;}
		}
	}
	index.hotSymbols = Object.entries(refCount)
		.filter(([, c]) => c > 0)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 50)
		.map(([id]) => id);

	// 9) 重算统计
	const newLangDist: Record<string, number> = {};
	for (const f of Object.keys(fileSummaries)) {
		const ext = path.extname(f);
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
	saveIndex(index);
	logger.info(`[ProjectIndexer] Incremental: +${addedFiles.length} added, ~${changedFiles.length} changed, -${removedFiles.length} removed (unchanged ${unchanged})`);
	return index;
}

// ── 公开 API ──────────────────────────────────────────────────

let _index: ProjectIndex | null = null;
let _indexPromise: Promise<ProjectIndex> | null = null;
let _watcher: vscode.FileSystemWatcher | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | undefined;
/** 构建世代：force / delete 时递增，使过期的 in-flight 构建放弃写回 _index */
let _buildSession = 0;

// ── 索引状态（供「索引与文档」管理面板） ──

export type IndexBuildStatus = 'idle' | 'building' | 'paused' | 'done';

export interface IndexBuildState {
	status: IndexBuildStatus;
	progress: { parsed: number; total: number };
	stats: IndexStats | null;
	files: FileIndexSummary[];
}

let _buildStatus: IndexBuildStatus = 'idle';
let _buildProgress = { parsed: 0, total: 0 };
let _buildAbort = false;

const _onIndexStateChange = new vscode.EventEmitter<IndexBuildState>();
/** 索引状态变更事件（构建进度 / 暂停 / 完成 / 删除） */
export const onIndexStateChange = _onIndexStateChange.event;

/** 获取当前索引状态快照（供面板渲染） */
export function getIndexState(): IndexBuildState {
	const idx = _index;
	return {
		status: _buildStatus,
		progress: { ..._buildProgress },
		stats: idx?.stats ?? null,
		files: getIndexFiles(30),
	};
}

function fireIndexState(): void {
	_onIndexStateChange.fire(getIndexState());
}

/** 使当前 in-flight 构建失效（不再写回内存索引） */
function invalidateInFlightBuild(): void {
	_buildSession++;
	_buildAbort = true;
}

function isBuildCurrent(session: number): boolean {
	return session === _buildSession && !_buildAbort;
}

/**
 * 暂停构建（面板 Pause Indexing）。
 * 实现为「中止当前构建」而非挂起：挂起会留下一个永不 resolve 的 _indexPromise，
 * 使后续所有 ensureProjectIndex() 卡死；中止 + Resume 重建代价相同（索引为增量友好），
 * 且无卡死风险。
 * ponytail: 中止语义，进度不冻结续传；若需真暂停续传再引入可取消任务队列。
 */
export function pauseIndexBuild(): void {
	if (_buildStatus !== 'building') {return;}
	_buildAbort = true;
	_buildStatus = 'paused';
	logger.info('[ProjectIndexer] Index build paused (aborted) by user');
	fireIndexState();
}

/** 恢复构建（面板 Resume）：重新触发全量索引 */
export function resumeIndexBuild(): void {
	if (_buildStatus !== 'paused') {return;}
	_buildStatus = 'building';
	logger.info('[ProjectIndexer] Index build resumed');
	fireIndexState();
	void ensureProjectIndex(true).catch(err =>
		logger.warn(`[ProjectIndexer] Resumed build failed: ${err instanceof Error ? err.message : String(err)}`),
	);
}

/** 删除项目索引（面板 删除索引）：中止构建、清空内存与磁盘索引 */
export async function deleteProjectIndex(): Promise<void> {
	invalidateInFlightBuild();

	disposeIndexWatcher();
	_index = null;
	// 不把 _indexPromise 置 null：让 in-flight 的 finally 自行按 session 清理；
	// 过期构建在写回前会因 session 不匹配而放弃。

	const indexPath = getIndexPath();
	try {
		if (indexPath && fs.existsSync(indexPath)) {
			fs.unlinkSync(indexPath);
		}
	} catch (err) {
		logger.warn(`[ProjectIndexer] Failed to delete index file: ${err instanceof Error ? err.message : String(err)}`);
	}

	_buildStatus = 'idle';
	_buildProgress = { parsed: 0, total: 0 };
	// 保持 _buildAbort=true，直到下一次合法构建 beginBuild 时清零
	logger.info('[ProjectIndexer] Project index deleted by user');
	fireIndexState();
}

/** 已索引文件列表（按最近修改排序；limit 省略时返回全部） */
export function getIndexFiles(limit?: number): FileIndexSummary[] {
	const idx = _index;
	if (!idx) {return [];}
	const list = Object.values(idx.files).sort((a, b) => b.lastModified - a.lastModified);
	return limit ? list.slice(0, limit) : list;
}

// ── 即时 Grep 索引（BETA，对标 Cursor「为即时 Grep 索引仓库」） ──

function getGrepIndexPath(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'codebase', 'grep-index.json') : undefined;
}

/** 全量扫描仓库文本文件清单（不限扩展名，排除构建/依赖目录），用于加速即时 Grep */
export async function ensureGrepIndex(): Promise<string[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {return [];}
	const rootPath = folder.uri.fsPath;

	const files = collectAllTextFiles(rootPath);
	const indexPath = getGrepIndexPath();
	if (indexPath) {
		try {
			ensureDir(path.dirname(indexPath));
			atomicWriteFileSync(indexPath, JSON.stringify(files, null, 2));
		} catch (err) {
			logger.warn(`[ProjectIndexer] Failed to write grep index: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return files;
}

function collectAllTextFiles(rootPath: string): string[] {
	const result: string[] = [];
	const stack = [rootPath];
	const skipDirs = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.kodrix', 'target', 'coverage', '.next', '.nuxt', '.venv', '__pycache__']);

	while (stack.length) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }

		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && !skipDirs.has(entry.name)) {
					stack.push(full);
				}
			} else if (entry.isFile()) {
				result.push(path.relative(rootPath, full).replace(/\\/g, '/'));
			}
		}
	}

	result.sort();
	return result;
}

/** 读取已缓存的 Grep 索引文件清单（未构建时返回空数组） */
export function getGrepIndexFiles(): string[] {
	const indexPath = getGrepIndexPath();
	if (!indexPath || !fs.existsSync(indexPath)) {return [];}
	try {
		const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

/** 清除 Grep 索引缓存（开关关闭时调用） */
export function clearGrepIndex(): void {
	const indexPath = getGrepIndexPath();
	try {
		if (indexPath && fs.existsSync(indexPath)) {
			fs.unlinkSync(indexPath);
		}
	} catch (err) {
		logger.warn(`[ProjectIndexer] Failed to clear grep index: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** 获取当前项目索引（懒加载） */
export function getProjectIndex(): ProjectIndex | null {
	return _index;
}

/** Build or return the cached project index, with guard against concurrent rebuilds. */
export async function ensureProjectIndex(force = false): Promise<ProjectIndex> {
	if (_index && !force) {return _index;}

	// force：作废 in-flight，避免旧构建晚到写回把新索引覆盖成「0 文件」或脏数据
	if (force) {
		invalidateInFlightBuild();
		_index = null;
	}

	// 非 force 时并入进行中的构建；force 时抛开旧 promise，另起新会话
	if (_indexPromise && !force) {return _indexPromise;}

	const running = buildProjectIndex(force);
	_indexPromise = running;
	try {
		// _index 由 buildProjectIndex 在确认 session 有效后写入；此处不再次赋值，
		// 以免 delete 清空后被过期 resolve 重新灌回。
		return await running;
	} finally {
		// 只清理自己的 promise，避免误清后来的 force 重建
		if (_indexPromise === running) {
			_indexPromise = null;
		}
	}
}

/** 全量构建项目索引 */
async function buildProjectIndex(force = false): Promise<ProjectIndex> {
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

	logger.info(`[ProjectIndexer] Starting full project index of: ${rootPath} (session=${session})`);

	// 尝试增量复用
	const existing = !force ? loadExistingIndex() : null;
	if (existing && existing.rootPath === rootPath && existing.version === INDEX_VERSION) {
		logger.info(`[ProjectIndexer] Reusing existing index, running incremental refresh`);
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
		} catch (err) {
			// 增量原地改写；仅当我们仍持有该引用时从磁盘回滚（避免覆盖 force/新会话结果）
			if (!isBuildCurrent(session) && _index === existing) {
				const reloaded = loadExistingIndex();
				_index = reloaded && reloaded.rootPath === rootPath ? reloaded : null;
			}
			throw err;
		}
	}

	// 发现文件
	const files = discoverFiles(rootPath, config);
	logger.info(`[ProjectIndexer] Discovered ${files.length} source files`);

	// 重置构建状态并广播（供「索引与文档」面板展示进度）
	_buildStatus = 'building';
	_buildProgress = { parsed: 0, total: files.length };
	fireIndexState();

	// 解析所有文件
	const allSymbols: CodeSymbol[] = [];
	const allImports: ImportRelation[] = [];
	const allCalls: CallRelation[] = [];
	const fileSummaries: Record<string, FileIndexSummary> = {};
	const langDist: Record<string, number> = {};

	let parsed = 0;
	const BATCH_SIZE = 50;

	for (let i = 0; i < files.length; i += BATCH_SIZE) {
		// 中止 / 被 force·delete 作废：不改写 status（pause/delete 已设置）
		if (!isBuildCurrent(session)) {
			throw new Error('Index build cancelled');
		}

		const batch = files.slice(i, i + BATCH_SIZE);
		for (const filePath of batch) {
			const result = parseFile(filePath);
			if (result) {
				allSymbols.push(...result.symbols);
				allImports.push(...result.imports);
				allCalls.push(...result.calls);

				const ext = path.extname(filePath);
				langDist[ext] = (langDist[ext] || 0) + 1;

				const stat = fs.statSync(filePath);
				const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
				fileSummaries[filePath] = {
					filePath,
					relativePath,
					symbolCount: result.symbols.length,
					exportCount: result.symbols.filter(s => s.visibility === SymbolVisibility.Exported || s.exportKind).length,
					importCount: result.imports.length,
					sizeBytes: stat.size,
					lastModified: stat.mtimeMs,
					language: ext.replace('.', ''),
				};
			}
			parsed++;
		}

		// 每批次报告进度（驱动面板进度条）— 仅当前会话推送
		if (isBuildCurrent(session)) {
			_buildProgress = { parsed, total: files.length };
			fireIndexState();
		}
		if (parsed % 200 === 0) {
			logger.info(`[ProjectIndexer] Parsed ${parsed}/${files.length} files (${allSymbols.length} symbols found)`);
		}
	}

	if (!isBuildCurrent(session)) {
		throw new Error('Index build cancelled');
	}

	// ── 构建索引结构 ──

	// 符号表（Object.create(null) 防止 __proto__/constructor 等符号名触发原型污染或非数组命中）
	const symbols: Record<string, CodeSymbol> = Object.create(null);
	const symbolNameIndex: Record<string, string[]> = Object.create(null);
	for (const sym of allSymbols) {
		symbols[sym.id] = sym;
		if (!symbolNameIndex[sym.name]) {symbolNameIndex[sym.name] = [];}
		symbolNameIndex[sym.name].push(sym.id);
	}

	// 依赖图：仅记录实际被索引的文件之间的关系
	const depGraph: Record<string, string[]> = Object.create(null);
	const revDepGraph: Record<string, string[]> = Object.create(null);
	const indexedPaths = new Set(Object.keys(fileSummaries));
	for (const imp of allImports) {
		// 跳过自引用和无法解析的相对路径
		if (!imp.importeePath || imp.importeePath === imp.importerPath) {continue;}
		if (imp.moduleSpecifier.startsWith('.') && !indexedPaths.has(imp.importeePath)) {continue;}

		if (!depGraph[imp.importerPath]) {depGraph[imp.importerPath] = [];}
		if (!depGraph[imp.importerPath].includes(imp.importeePath)) {
			depGraph[imp.importerPath].push(imp.importeePath);
		}
		if (!revDepGraph[imp.importeePath]) {revDepGraph[imp.importeePath] = [];}
		if (!revDepGraph[imp.importeePath].includes(imp.importerPath)) {
			revDepGraph[imp.importeePath].push(imp.importerPath);
		}
	}

	// 热门符号（被引用次数）
	// 先建立符号名→id 反向索引，避免 O(n^2) 遍历
	const refCount: Record<string, number> = {};
	for (const sym of allSymbols) {refCount[sym.id] = 0;}

	const nameToIds = new Map<string, string[]>();
	for (const [name, ids] of Object.entries(symbolNameIndex)) {
		nameToIds.set(name, ids);
	}

	for (const call of allCalls) {
		const shortName = call.calleeId.split('#')[1];
		const candidates = nameToIds.get(shortName);
		if (candidates) {
			for (const candidateId of candidates) {
				refCount[candidateId] = (refCount[candidateId] || 0) + 1;
				call.calleeId = candidateId;
			}
		}
	}
	const hotSymbols = Object.entries(refCount)
		.filter(([, c]) => c > 0)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 50)
		.map(([id]) => id);

	// 统计：按实际写入索引的文件数（与 incremental / 面板展示一致）
	const stats: IndexStats = {
		totalFiles: Object.keys(fileSummaries).length,
		totalSymbols: allSymbols.length,
		totalImports: allImports.length,
		totalCalls: allCalls.length,
		languageDistribution: langDist,
		indexDurationMs: Date.now() - startTime,
	};

	const index: ProjectIndex = {
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

	saveIndex(index);
	logger.info(`[ProjectIndexer] Index complete: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.totalImports} imports, ${stats.indexDurationMs}ms`);

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
async function refreshProjectIndexIncrementally(): Promise<ProjectIndex> {
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
		} catch (err) {
			if (!isBuildCurrent(session)) {
				// 仅当我们仍持有被改写的同一引用时回滚，避免覆盖 force/新会话结果
				if (_index === snapshot) {
					const reloaded = loadExistingIndex();
					const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					_index = reloaded && folderPath && reloaded.rootPath === folderPath ? reloaded : null;
				}
			} else {
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
	} finally {
		if (_indexPromise === running) {
			_indexPromise = null;
		}
	}
}

/** 安装文件监听器，实现增量更新 */
export function startIndexWatcher(context: vscode.ExtensionContext): void {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('codebaseIntelligence', true);
	if (!enabled) {
		logger.info('[ProjectIndexer] Disabled by configuration');
		return;
	}
	// 「索引新文件夹」开关：关闭时不做自动索引与文件监听（仍可手动重建）
	const autoIndex = vscode.workspace.getConfiguration('kodrix.codebase').get<boolean>('autoIndexNewFolders', true);
	if (!autoIndex) {
		logger.info('[ProjectIndexer] Auto index disabled by configuration (索引新文件夹 关闭)');
		return;
	}
	if (_watcher) {return;}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {return;}

	const config = DEFAULT_CONFIG;
	const pattern = `**/*.{${config.includeExtensions.map(e => e.replace('.', '')).join(',')}}`;

	_watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(folder, pattern),
	);

	const scheduleRebuild = () => {
		if (_debounceTimer) {clearTimeout(_debounceTimer);}
		_debounceTimer = setTimeout(() => {
			logger.info('[ProjectIndexer] File changed, scheduling incremental rebuild');
			// 增量刷新：勿 force 全量重建（会清空 _index 并在完成瞬间向面板推送 0 文件）
			void refreshProjectIndexIncrementally().catch(err =>
				logger.warn(`[ProjectIndexer] Incremental rebuild failed: ${err instanceof Error ? err.message : String(err)}`),
			);
		}, 500);
	};

	_watcher.onDidCreate(scheduleRebuild);
	_watcher.onDidChange(scheduleRebuild);
	_watcher.onDidDelete(scheduleRebuild);

	context.subscriptions.push(_watcher);
}

export function disposeIndexWatcher(): void {
	_watcher?.dispose();
	_watcher = null;
	if (_debounceTimer) {clearTimeout(_debounceTimer);}
}
