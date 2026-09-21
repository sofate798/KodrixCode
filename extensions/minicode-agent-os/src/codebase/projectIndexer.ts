/*---------------------------------------------------------------------------------------------
 *  Project Indexer — 全工程级语义索引引擎
 *
 *  大厂对标：Sourcegraph SCIP + GitHub Copilot Indexing + JetBrains Full-Project Analysis
 *
 *  能力：
 *  1. AST 级别解析 TypeScript / JavaScript / TSX / JSX
 *  2. 符号表：所有类、接口、函数、变量及其可见性
 *  3. 导入图：跨文件依赖关系精确追踪
 *  4. 调用图：函数/方法间的调用链路
 *  5. 引用热度分析：被引用最多的符号 Top N
 *  6. 增量更新：文件变更时自动部分重建
 *  7. 零外部依赖：仅使用 VS Code 内置 TypeScript
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as ts from 'typescript';
import { ensureDir, getWorkspaceMinicodeDir } from '../paths';
import { logger } from '../logger';
import { isRecord, isString, isNumber } from '../utils/jsonValidator';
import type {
	CodeSymbol, ImportRelation,
	CallRelation, IndexerConfig, ProjectIndex, IndexStats, FileIndexSummary,
} from './types';
import { SymbolKind, SymbolVisibility } from './types';

// ── 默认配置 ───────────────────────────────────────────────────

const DEFAULT_CONFIG: IndexerConfig = {
	includeExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
	excludeDirs: ['node_modules', '.git', 'dist', 'out', 'build', '.minicode', '__pycache__', '.venv', 'target', 'coverage', '.next', '.nuxt'],
	excludeGlobs: ['**/*.d.ts', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/generated/**', '**/*.min.js'],
	maxFileSize: 500_000, // 500KB
	watch: true,
};

const INDEX_VERSION = 1;

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
	if (!config.includeExtensions.includes(ext)) return true;

	// 大小过滤
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > config.maxFileSize) return true;
	} catch { return true; }

	// 目录过滤
	const normalized = filePath.replace(/\\/g, '/');
	for (const dir of config.excludeDirs) {
		if (normalized.includes(`/${dir}/`) || normalized.endsWith(`/${dir}`)) return true;
	}

	// Glob 过滤：使用完整相对路径而非 basename，确保 **/ 等跨目录模式正确匹配
	const relativePath = rootPath
		? path.relative(rootPath, filePath).replace(/\\/g, '/')
		: path.basename(filePath);

	// 使用预编译的正则（由 discoverFiles 传入）避免每个文件重复编译
	const globs = compiledGlobs || compileGlobs(config.excludeGlobs);
	for (const regex of globs) {
		if (regex.test(relativePath)) return true;
	}

	return false;
}

function discoverFiles(rootPath: string, config: IndexerConfig): string[] {
	const files: string[] = [];
	const stack = [rootPath];

	// Pre-compile globs once per discovery pass — avoids recompiling per file
	const compiledGlobs = compileGlobs(config.excludeGlobs);

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
					files.push(full);
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
				if (m.kind === ts.SyntaxKind.ExportKeyword) return 'named';
				if (m.kind === ts.SyntaxKind.DefaultKeyword) return 'default';
			}
		}
	}
	return undefined;
}

function getVisibility(modifiers: readonly ts.Modifier[] | undefined): SymbolVisibility {
	if (!modifiers) return SymbolVisibility.Public;
	for (const m of modifiers) {
		if (m.kind === ts.SyntaxKind.PublicKeyword) return SymbolVisibility.Public;
		if (m.kind === ts.SyntaxKind.ProtectedKeyword) return SymbolVisibility.Protected;
		if (m.kind === ts.SyntaxKind.PrivateKeyword) return SymbolVisibility.Private;
		if (m.kind === ts.SyntaxKind.ExportKeyword) return SymbolVisibility.Exported;
	}
	return SymbolVisibility.Public;
}

function getDocComment(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
	const fullText = sourceFile.getFullText();
	const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
	if (!ranges) return undefined;

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

// ── 文件解析 ──────────────────────────────────────────────────

function parseFile(filePath: string): { symbols: CodeSymbol[]; imports: ImportRelation[]; calls: CallRelation[] } | null {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
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
	} catch (err) {
		logger.warn(`[ProjectIndexer] parseFile failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

// ── 索引持久化 ────────────────────────────────────────────────

function getIndexPath(): string | undefined {
	const base = getWorkspaceMinicodeDir();
	return base ? path.join(base, 'codebase', 'project-index.json') : undefined;
}

function loadExistingIndex(): ProjectIndex | null {
	const indexPath = getIndexPath();
	if (!indexPath || !fs.existsSync(indexPath)) return null;
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
	if (!indexPath) return;
	ensureDir(path.dirname(indexPath));
	fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}

// ── 公开 API ──────────────────────────────────────────────────

let _index: ProjectIndex | null = null;
let _indexPromise: Promise<ProjectIndex> | null = null;
let _watcher: vscode.FileSystemWatcher | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | undefined;

/** 获取当前项目索引（懒加载） */
export function getProjectIndex(): ProjectIndex | null {
	return _index;
}

/** Build or return the cached project index, with guard against concurrent rebuilds. */
export async function ensureProjectIndex(force = false): Promise<ProjectIndex> {
	if (_index && !force) return _index;

	// force=true 时忽略进行中的构建和缓存，启动全新索引
	if (force) {
		_index = null;
		_indexPromise = null;
	}

	// Deduplicate: if a build is in progress, await the same promise
	if (_indexPromise) return _indexPromise;

	try {
		_indexPromise = buildProjectIndex(force);
		const idx = await _indexPromise;
		_index = idx;
		return idx;
	} finally {
		// Always reset the promise — even on failure — so that the next call
		// triggers a fresh build attempt rather than returning a rejected promise.
		_indexPromise = null;
	}
}

/** 全量构建项目索引 */
async function buildProjectIndex(force = false): Promise<ProjectIndex> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error('No workspace folder open');
	}

	const rootPath = folder.uri.fsPath;
	const config = DEFAULT_CONFIG;
	const startTime = Date.now();

	logger.info(`[ProjectIndexer] Starting full project index of: ${rootPath}`);

	// 尝试增量复用
	const existing = !force ? loadExistingIndex() : null;
	if (existing && existing.rootPath === rootPath && existing.version === INDEX_VERSION) {
		logger.info(`[ProjectIndexer] Reusing existing index (${existing.stats.totalFiles} files, ${existing.stats.totalSymbols} symbols)`);
		return existing;
	}

	// 发现文件
	const files = discoverFiles(rootPath, config);
	logger.info(`[ProjectIndexer] Discovered ${files.length} source files`);

	// 解析所有文件
	const allSymbols: CodeSymbol[] = [];
	const allImports: ImportRelation[] = [];
	const allCalls: CallRelation[] = [];
	const fileSummaries: Record<string, FileIndexSummary> = {};
	const langDist: Record<string, number> = {};

	let parsed = 0;
	const BATCH_SIZE = 50;

	for (let i = 0; i < files.length; i += BATCH_SIZE) {
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
				const relativePath = path.relative(rootPath, filePath);
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

		// 每批次报告进度
		if (parsed % 200 === 0) {
			logger.info(`[ProjectIndexer] Parsed ${parsed}/${files.length} files (${allSymbols.length} symbols found)`);
		}
	}

	// ── 构建索引结构 ──

	// 符号表（Object.create(null) 防止 __proto__/constructor 等符号名触发原型污染或非数组命中）
	const symbols: Record<string, CodeSymbol> = Object.create(null);
	const symbolNameIndex: Record<string, string[]> = Object.create(null);
	for (const sym of allSymbols) {
		symbols[sym.id] = sym;
		if (!symbolNameIndex[sym.name]) symbolNameIndex[sym.name] = [];
		symbolNameIndex[sym.name].push(sym.id);
	}

	// 依赖图：仅记录实际被索引的文件之间的关系
	const depGraph: Record<string, string[]> = Object.create(null);
	const revDepGraph: Record<string, string[]> = Object.create(null);
	const indexedPaths = new Set(Object.keys(fileSummaries));
	for (const imp of allImports) {
		// 跳过自引用和无法解析的相对路径
		if (!imp.importeePath || imp.importeePath === imp.importerPath) continue;
		if (imp.moduleSpecifier.startsWith('.') && !indexedPaths.has(imp.importeePath)) continue;

		if (!depGraph[imp.importerPath]) depGraph[imp.importerPath] = [];
		if (!depGraph[imp.importerPath].includes(imp.importeePath)) {
			depGraph[imp.importerPath].push(imp.importeePath);
		}
		if (!revDepGraph[imp.importeePath]) revDepGraph[imp.importeePath] = [];
		if (!revDepGraph[imp.importeePath].includes(imp.importerPath)) {
			revDepGraph[imp.importeePath].push(imp.importerPath);
		}
	}

	// 热门符号（被引用次数）
	// 先建立符号名→id 反向索引，避免 O(n^2) 遍历
	const refCount: Record<string, number> = {};
	for (const sym of allSymbols) refCount[sym.id] = 0;

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

	// 统计
	const stats: IndexStats = {
		totalFiles: files.length,
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

	saveIndex(index);
	logger.info(`[ProjectIndexer] Index complete: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.totalImports} imports, ${stats.indexDurationMs}ms`);

	return index;
}

/** 安装文件监听器，实现增量更新 */
export function startIndexWatcher(context: vscode.ExtensionContext): void {
	const enabled = vscode.workspace.getConfiguration('minicode.features').get<boolean>('codebaseIntelligence', true);
	if (!enabled) {
		logger.info('[ProjectIndexer] Disabled by configuration');
		return;
	}
	if (_watcher) return;

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return;

	const config = DEFAULT_CONFIG;
	const pattern = `**/*.{${config.includeExtensions.map(e => e.replace('.', '')).join(',')}}`;

	_watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(folder, pattern),
	);

	const scheduleRebuild = () => {
		if (_debounceTimer) clearTimeout(_debounceTimer);
		_debounceTimer = setTimeout(() => {
			logger.info('[ProjectIndexer] File changed, scheduling incremental rebuild');
			void ensureProjectIndex(true);
		}, 3000);
	};

	_watcher.onDidCreate(scheduleRebuild);
	_watcher.onDidChange(scheduleRebuild);
	_watcher.onDidDelete(scheduleRebuild);

	context.subscriptions.push(_watcher);
}

export function disposeIndexWatcher(): void {
	_watcher?.dispose();
	_watcher = null;
	if (_debounceTimer) clearTimeout(_debounceTimer);
}
