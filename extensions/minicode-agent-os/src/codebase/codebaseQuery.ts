/*---------------------------------------------------------------------------------------------
 *  Codebase Query — 自然语言代码问答引擎
 *
 *  大厂对标：Sourcegraph Cody + GitHub Copilot Chat + Cursor Codebase Chat
 *
 *  能力：
 *  1. 自然语言理解："这个 API 在哪定义？" → 自动定位符号位置
 *  2. 定义查找：根据符号名返回定义文件/行号
 *  3. 引用分析："哪里调用了 X？" → 返回所有调用点
 *  4. 依赖分析："X 依赖哪些模块？" → 返回依赖图
 *  5. 结构概览："这个项目的架构？" → 返回项目结构摘要
 *  6. 注册为 VS Code Chat Participant，支持 @minicode 前缀指令
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { ensureProjectIndex, getProjectIndex } from './projectIndexer';
import { logger } from '../logger';
import type { CodeSymbol, CodebaseSearchResult, ProjectIndex } from './types';
import { SymbolVisibility } from './types';

// ── 中文查询意图识别 ─────────────────────────────────────────────

type QueryIntent =
	| 'definition'     // "在哪定义？"
	| 'usage'          // "哪里用了？"
	| 'callers'        // "谁调用了？"
	| 'structure'      // "项目结构？"
	| 'dependency'     // "依赖哪些？"
	| 'architecture'   // "架构？"
	| 'natural';       // 通用自然语言

const INTENT_PATTERNS: Array<{ intent: QueryIntent; patterns: RegExp[] }> = [
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

function detectIntent(query: string): QueryIntent {
	for (const { intent, patterns } of INTENT_PATTERNS) {
		for (const pattern of patterns) {
			if (pattern.test(query)) return intent;
		}
	}
	return 'natural';
}

/** 从查询中提取目标符号名 */
function extractSymbolName(query: string): string | null {
	if (!query) return null;

	let cleaned = query
		.replace(/在哪(?:里)?定义|where.*defin|define|定义在[哪那]|是什么|what is|找到.*定义|find.*defini|查看.*定义|定位.*定义/gi, '')
		.replace(/哪里用[到了过]|who.*use|where.*use|引用[了过]?|哪些文件.*用|used.*where/gi, '')
		.replace(/谁调[用了]|caller|called by|调用了[哪谁]|调用.*关系/gi, '')
		.replace(/项目结构|目录结构|文件结构|project structure|模块列表|有哪些模块/gi, '')
		.replace(/依赖|depend|导[入了]*哪些|import.*什么/gi, '')
		.replace(/架构|architec|design pattern/gi, '')
		.replace(/[?？!！。，,]/g, ' ')
		.trim();

	if (!cleaned) return null;

	// 引号内文本优先
	const quoteMatch = cleaned.match(/["'`]([^"'`]+)["'`]/);
	if (quoteMatch) return quoteMatch[1];

	// 驼峰 / PascalCase
	const camelMatch = cleaned.match(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/);
	if (camelMatch) return camelMatch[1];

	// CONST_CASE
	const constMatch = cleaned.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/);
	if (constMatch) return constMatch[1];

	// snake_case
	const snakeMatch = cleaned.match(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/);
	if (snakeMatch) return snakeMatch[1];

	// 通用标识符：取最后一个看起来像符号的单词（>=2 字符）
	const words = cleaned.split(/\s+/).filter(w => w.length >= 2 && /^[a-zA-Z_$][\w.$]*$/.test(w));
	if (words.length > 0) return words[words.length - 1];

	return null;
}

// ── 索引搜索核心 ────────────────────────────────────────────────

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

function findSymbolByName(index: ProjectIndex, name: string): CodeSymbol[] {
	const normalized = name.toLowerCase();
	const ids = index.symbolNameIndex[name] || [];

	const fuzzyIds: string[] = [];
	for (const [key, idList] of Object.entries(index.symbolNameIndex)) {
		if (key.toLowerCase().includes(normalized) || normalized.includes(key.toLowerCase())) {
			fuzzyIds.push(...idList);
		}
	}

	const allIds = [...new Set([...ids, ...fuzzyIds])];
	return allIds.map(id => index.symbols[id]).filter(Boolean);
}

function findDefinition(index: ProjectIndex, query: string): CodebaseSearchResult[] {
	const name = extractSymbolName(query);
	if (!name) return [];

	const symbols = findSymbolByName(index, name);
	if (symbols.length === 0) return [];

	return symbols.map(sym => ({
		symbol: sym,
		reason: `「${sym.name}」定义于`,
		filePath: sym.filePath,
		score: sym.visibility === SymbolVisibility.Exported ? 0.95 : 0.8,
		lineRange: [sym.line, sym.line] as [number, number],
		snippet: sym.signature || sym.docComment?.slice(0, 200) || `line ${sym.line}`,
	}));
}

function findUsage(index: ProjectIndex, query: string): CodebaseSearchResult[] {
	const name = extractSymbolName(query);
	if (!name) return [];

	const symbols = findSymbolByName(index, name);
	const results: CodebaseSearchResult[] = [];

	for (const sym of symbols) {
		const importers = index.reverseDependencyGraph[sym.filePath] || [];
		for (const importer of importers) {
			results.push({
				symbol: sym,
				reason: `「${sym.name}」被导入于`,
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
				reason: `「${sym.name}」在 L${call.line} 被调用`,
				filePath: callerPath,
				score: 0.85,
				lineRange: [call.line, call.line] as [number, number],
			});
		}
	}

	return results.slice(0, 20);
}

function showStructure(index: ProjectIndex): CodebaseSearchResult[] {
	const results: CodebaseSearchResult[] = [];
	const root = index.rootPath;
	const topDirs = new Set<string>();

	for (const filePath of Object.keys(index.files)) {
		const rel = path.relative(root, filePath);
		const parts = rel.split(path.sep);
		if (parts.length > 0) topDirs.add(parts[0]);
	}

	for (const dir of [...topDirs].sort()) {
		results.push({
			reason: '项目顶层目录',
			filePath: path.join(root, dir),
			score: 0.5,
			snippet: `📁 ${dir}/`,
		});
	}

	for (const symId of index.hotSymbols.slice(0, 10)) {
		const sym = index.symbols[symId];
		if (sym && sym.visibility === SymbolVisibility.Exported) {
			results.push({
				symbol: sym,
				reason: '🔥 核心导出符号',
				filePath: sym.filePath,
				score: 0.7,
				snippet: sym.signature || sym.name,
				lineRange: [sym.line, sym.line] as [number, number],
			});
		}
	}

	const moduleDirs = ['src', 'lib', 'extensions', 'packages', 'app'];
	for (const md of moduleDirs) {
		const count = Object.values(index.files).filter(f => normalizePath(f.filePath).includes(`/${md}/`)).length;
		if (count > 0) {
			results.push({
				reason: '模块目录',
				filePath: path.join(root, md),
				score: 0.4,
				snippet: `📦 ${md}/ — ${count} 个文件`,
			});
		}
	}

	return results;
}

function showDependencies(index: ProjectIndex, query: string): CodebaseSearchResult[] {
	const name = extractSymbolName(query);
	const results: CodebaseSearchResult[] = [];

	if (name) {
		const symbols = findSymbolByName(index, name);
		for (const sym of symbols) {
			const deps = index.dependencyGraph[sym.filePath] || [];
			for (const dep of deps) {
				results.push({
					symbol: sym,
					reason: `「${sym.name}」所在文件依赖`,
					filePath: dep,
					score: 0.6,
				});
			}
		}
	}

	return results;
}

function naturalSearch(index: ProjectIndex, query: string): CodebaseSearchResult[] {
	const results: CodebaseSearchResult[] = [];
	const words = query.match(/[a-zA-Z_$][\w.$]*/g) || [];
	const chineseWords = query.match(/[\u4e00-\u9fff]+/g) || [];
	// 限制搜索词数量，避免长句导致过多遍历
	const allTerms = [...words, ...chineseWords].slice(0, 10);

	for (const term of allTerms) {
		if (term.length < 2) continue;
		const symbols = findSymbolByName(index, term);
		for (const sym of symbols) {
			results.push({
				symbol: sym,
				reason: `匹配「${term}」`,
				filePath: sym.filePath,
				score: 0.6,
				snippet: sym.signature || sym.docComment?.slice(0, 150),
				lineRange: [sym.line, sym.line] as [number, number],
			});
		}
	}

	const seen = new Set<string>();
	return results.filter(r => {
		const key = `${r.filePath}:${r.symbol?.id || ''}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, 20);
}

// ── 结果格式化 ──────────────────────────────────────────────────

const KIND_ICON: Record<string, string> = {
	class: '📦', interface: '🔷', function: '🔧', method: '⚙️',
	variable: '📌', type: '🏷️', enum: '📋', namespace: '📂', unknown: '❓',
};

function formatResultsToMarkdown(results: CodebaseSearchResult[], query: string, index: ProjectIndex): string {
	if (results.length === 0) {
		return `## 🔍 "${query}" 未找到匹配结果

> 建议：
> - 尝试使用更具体的符号名
> - 运行 **Minicode: 生成 Repo Wiki** 重建项目索引
> - 使用 \`#codebase\` 搜索代码库

**索引状态：** ${index.stats.totalFiles} 个文件 · ${index.stats.totalSymbols} 个符号 · ${index.stats.totalImports} 个导入关系`;
	}

	const lines: string[] = [
		`## 🔍 "${query}" — 找到 ${results.length} 个结果`,
		'',
		`> 索引：${index.stats.totalFiles} 个文件 · ${index.stats.totalSymbols} 个符号`,
		'',
	];

	const sorted = [...results].sort((a, b) => b.score - a.score);

	for (const r of sorted) {
		const sym = r.symbol;
		const relativePath = normalizePath(path.relative(index.rootPath, r.filePath));
		const icon = sym ? (KIND_ICON[sym.kind] || '•') : '📄';

		lines.push(`### ${icon} ${r.reason}`);

		if (sym) {
			lines.push('');
			lines.push(`| 属性 | 值 |`);
			lines.push(`|------|-----|`);
			lines.push(`| **符号** | \`${sym.name}\` |`);
			lines.push(`| **类型** | ${sym.kind} |`);
			lines.push(`| **可见性** | ${sym.visibility} |`);
			lines.push(`| **文件** | [\`${relativePath}\`](${r.filePath}) |`);
			lines.push(`| **行号** | L${sym.line} |`);
			if (sym.signature) {
				lines.push(`| **签名** | \`${sym.signature.slice(0, 120)}\` |`);
			}
			if (sym.docComment) {
				lines.push(`| **文档** | ${sym.docComment.slice(0, 200).replace(/\n/g, ' ')} |`);
			}
			if (sym.parentId) {
				const parentName = sym.parentId.split('#')[1];
				lines.push(`| **所属** | \`${parentName}\` |`);
			}
		}

		if (r.snippet && !sym) {
			lines.push('');
			lines.push(`📄 [\`${relativePath}\`](${r.filePath})`);
			lines.push('');
			lines.push('```');
			lines.push(r.snippet.slice(0, 300));
			lines.push('```');
		}

		if (sym) {
			const deps = index.dependencyGraph[r.filePath]?.length || 0;
			const revDeps = index.reverseDependencyGraph[r.filePath]?.length || 0;
			if (deps > 0 || revDeps > 0) {
				lines.push(`| **依赖关系** | 导入 ${deps} 个模块 · 被 ${revDeps} 个模块引用 |`);
			}
		}

		lines.push('');
	}

	lines.push('---');
	lines.push(`*Codebase Intelligence · ${new Date().toLocaleString('zh-CN')}*`);

	return lines.join('\n');
}

// ── 主查询入口 ──────────────────────────────────────────────────

export async function queryCodebase(query: string): Promise<string> {
	const index = await ensureProjectIndex();
	if (!index) {
		return '未找到项目索引。请先打开一个工作区文件夹，Minicode 将自动构建索引。';
	}

	const intent = detectIntent(query);
	logger.info(`[CodebaseQuery] "${query}" → intent: ${intent}`);

	let results: CodebaseSearchResult[];

	switch (intent) {
		case 'definition':
			results = findDefinition(index, query);
			if (results.length === 0) results = naturalSearch(index, query);
			break;

		case 'usage':
		case 'callers':
			results = findUsage(index, query);
			if (results.length === 0) results = naturalSearch(index, query);
			break;

		case 'structure':
		case 'architecture':
			results = showStructure(index);
			break;

		case 'dependency':
			results = showDependencies(index, query);
			if (results.length === 0) results = naturalSearch(index, query);
			break;

		case 'natural':
		default:
			results = naturalSearch(index, query);
			break;
	}

	return formatResultsToMarkdown(results, query, index);
}

/** 快速搜索符号（供补全等模块使用） */
export function quickSearchSymbols(
	name: string,
	limit = 10,
): Array<{ symbol: CodeSymbol; score: number }> {
	const index = getProjectIndex();
	if (!index) return [];

	const symbols = findSymbolByName(index, name);
	return symbols.slice(0, limit).map(sym => ({
		symbol: sym,
		score: sym.visibility === SymbolVisibility.Exported ? 1.0 : 0.7,
	}));
}

/** 获取文件的依赖列表 */
export function getFileDependencies(filePath: string): string[] {
	const index = getProjectIndex();
	return index?.dependencyGraph[filePath] || [];
}

/** 获取文件的被依赖列表 */
export function getFileDependents(filePath: string): string[] {
	const index = getProjectIndex();
	return index?.reverseDependencyGraph[filePath] || [];
}

// ── Chat Participant 注册 ──────────────────────────────────────

let _participant: vscode.Disposable | undefined;

export function registerCodebaseChatParticipant(context: vscode.ExtensionContext): void {
	const enabled = vscode.workspace.getConfiguration('minicode.features').get<boolean>('codebaseQuery', true);
	if (!enabled) {
		logger.info('[CodebaseQuery] Disabled by configuration');
		return;
	}

	// 注册为 VS Code Chat Participant
	try {
		interface MinimalChatRequest {
			prompt: string;
			command?: string;
		}

		interface MinimalChatResponseStream {
			markdown(value: string): void;
		}

		interface MinimalChatContext {
			history: unknown[];
		}

		interface ChatParticipantLike extends vscode.Disposable {
			onDidReceiveFeedback?: vscode.Event<unknown>;
		}

		interface VSCodeChatApi {
			createChatParticipant(
				id: string,
				handler: (
					request: MinimalChatRequest,
					context: MinimalChatContext,
					stream: MinimalChatResponseStream,
					token: vscode.CancellationToken,
				) => Promise<void>,
			): ChatParticipantLike;
		}

		const api = (vscode as unknown as { chat?: VSCodeChatApi }).chat;
		if (!api?.createChatParticipant) {
			logger.info('[CodebaseQuery] Chat participant API not available (may need newer VS Code)');
			return;
		}

		_participant = api.createChatParticipant(
			'minicode.codebase',
			async (request, _context, stream, token) => {
				const prompt = request.prompt?.trim();
				if (!prompt) {
					stream.markdown('请在 `@codebase` 后输入问题，例如：\n- `@codebase getUserProfile 在哪定义？`\n- `@codebase 这个项目有哪些模块？`\n- `@codebase 谁调用了 createUser？`');
					return;
				}

				if (token.isCancellationRequested) return;

				try {
					stream.markdown('🔍 *正在索引并搜索代码库...*');
					const result = await queryCodebase(prompt);
					stream.markdown(result);
				} catch (err) {
					stream.markdown(`查询失败: ${err instanceof Error ? err.message : String(err)}`);
				}
			},
		);

		context.subscriptions.push(_participant);
		logger.info('[CodebaseQuery] Chat participant registered as minicode.codebase');
	} catch (err) {
		logger.info(`[CodebaseQuery] Chat participant registration skipped: ${err instanceof Error ? err.message : String(err)}`);
	}

	// 注册命令作为备选入口
	context.subscriptions.push(
		vscode.commands.registerCommand('minicode.codebase.search', async () => {
			const query = await vscode.window.showInputBox({
				prompt: '输入问题（如 "getUserProfile 在哪定义？"）',
				placeHolder: '自然语言代码问答...',
			});
			if (!query) return;

			await vscode.window.withProgress(
				{ location: { viewId: 'workbench.panel.chat' }, title: '搜索代码库...' },
				async () => {
					const result = await queryCodebase(query);
					const doc = await vscode.workspace.openTextDocument({
						content: result,
						language: 'markdown',
					});
					await vscode.window.showTextDocument(doc, { preview: true });
				},
			);
		}),
	);
}
