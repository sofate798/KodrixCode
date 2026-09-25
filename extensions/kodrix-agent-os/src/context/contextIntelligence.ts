/*---------------------------------------------------------------------------------------------
 *  Context Intelligence v2 — 多层上下文组装 + 语义记忆检索 + 主动上下文建议
 *  大厂对标：Cursor implicit context + Windsurf memories + Qoder knowledge graph
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { onContextChanged, notifyContextChanged } from '../context/contextEvents';
import { registerInstructionFolders } from './instructionRegistry';
import { syncProjectInstructionsFile, getRecentLearning } from '../learning/learningEngine';
import { readMemoryContent } from '../memory/memoryHelpers';
import { generateRepoWiki, getWikiContextForAgent } from '../wiki/repoWiki';
import { getSemanticContext, getTopicalMemories, getSemanticStats } from '../learning/semanticMemory';
import {
	WIKI_CACHE_TTL_MS,
	ASSEMBLED_CONTEXT_MAX_CHARS,
	COMPACT_CONTEXT_MAX_CHARS,
	CONFIG_FEATURES,
	COMMANDS,
	INSTRUCTION_REGISTER_DELAY_MS,
} from '../shared/constants';

/** 上下文摘要结构化数据 */
export interface ContextSummary {
	wikiKB: number;
	memoryCount: number;
	learningCount: number;
	semanticVectors: number;
	estimatedTokens: number;
	totalKB: number;
}

/** 获取上下文结构化摘要（供状态栏 / Chat context 使用） */
export function getContextSummary(): ContextSummary {
	const wiki = getCachedWikiContext();
	const wikiBytes = wiki ? wiki.length * 2 : 0;
	const wikiKB = wikiBytes / 1024;

	const memory = readMemoryContent();
	const memoryLines = Math.max(1, memory.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('##')).length);

	const learning = getRecentLearning(100);
	const semantic = getSemanticStats();

	const assembled = getAssembledContext(50000);
	const totalKB = (assembled.length * 2) / 1024;
	const estimatedTokens = Math.ceil(assembled.length / 4);

	return {
		wikiKB: Math.round(wikiKB * 10) / 10,
		memoryCount: memoryLines,
		learningCount: learning.length,
		semanticVectors: semantic.totalVectors,
		estimatedTokens,
		totalKB: Math.round(totalKB * 10) / 10,
	};
}

export { mergeInstructionLocation, registerInstructionFolders, writeWikiInstructionsFile } from './instructionRegistry';

// Cache wiki context to avoid redundant file I/O within a single render frame
let _cachedWiki: string | null = null;
let _cachedWikiTime = 0;

function getCachedWikiContext(): string | null {
	const now = Date.now();
	if (_cachedWiki && (now - _cachedWikiTime) < WIKI_CACHE_TTL_MS) return _cachedWiki;
	_cachedWiki = getWikiContextForAgent();
	_cachedWikiTime = now;
	return _cachedWiki;
}

/** 获取当前编辑器内容作为上下文提示 */
function getEditorContextHint(): string {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return '';

	const doc = editor.document;
	const selection = doc.getText(editor.selection);
	if (selection && selection.length > 10) return selection.slice(0, 500);

	// 获取当前行附近内容
	const cursor = editor.selection.active;
	const startLine = Math.max(0, cursor.line - 10);
	const endLine = Math.min(doc.lineCount - 1, cursor.line + 10);
	const contextLines: string[] = [];
	for (let i = startLine; i <= endLine; i++) {
		contextLines.push(doc.lineAt(i).text);
	}
	return contextLines.join('\n').slice(0, 800);
}

export function getAssembledContext(maxChars = ASSEMBLED_CONTEXT_MAX_CHARS): string {
	const parts: string[] = [];

	// 1. Wiki context (cached to avoid redundant file I/O)
	const wiki = getCachedWikiContext();
	if (wiki) parts.push(wiki);

	// 2. Memory
	const memory = readMemoryContent().slice(0, 2000);
	if (memory) parts.push(`[Project Memory]\n${memory}`);

	// 3. Recent learning (recency-based, sync path — no semantic query)
	const learning = getRecentLearning(5);
	if (learning.length) {
		const header = '[Recent Learning]';
		const lines = learning.map(e => `- [${e.category}] ${e.content}`);
		parts.push(`${header}\n${lines.join('\n')}`);
	}

	// NOTE: 语义记忆检索（query-based）已移至异步路径 getAssembledContextFull()

	const combined = parts.join('\n\n');
	if (combined.length <= maxChars) return combined;

	// Graceful truncation: cut at the last double-newline (paragraph boundary)
	const truncated = combined.slice(0, maxChars);
	const lastBreak = truncated.lastIndexOf('\n\n');
	if (lastBreak > maxChars * 0.7) {
		return truncated.slice(0, lastBreak) + '\n\n…(truncated)';
	}
	return truncated + '\n…(truncated)';
}

/**
 * 异步版本的完整上下文组装，包含语义记忆检索
 */
export async function getAssembledContextFull(maxChars = ASSEMBLED_CONTEXT_MAX_CHARS): Promise<string> {
	const sync = getAssembledContext(maxChars);
	const editorCtx = getEditorContextHint();
	if (!editorCtx) return sync;

	try {
		const semantic = await getSemanticContext(editorCtx, 1000);
		if (semantic && !sync.includes(semantic.slice(10, 50))) {
			const combined = sync + '\n\n' + semantic;
			if (combined.length <= maxChars) return combined;
			return combined.slice(0, maxChars) + '\n…(truncated)';
		}
	} catch {
		// semantic search failed, return sync version
	}
	return sync;
}

/** 获取简短上下文（用于状态栏 / tooltip） */
export function getCompactContext(maxChars = COMPACT_CONTEXT_MAX_CHARS): string {
	const parts: string[] = [];
	const wiki = getCachedWikiContext();
	if (wiki) parts.push(wiki.slice(0, 80));
	const memory = readMemoryContent();
	if (memory) parts.push(`Memory: ${memory.slice(0, 60)}…`);
	const learning = getRecentLearning(2);
	if (learning.length) {
		parts.push(`Learning: ${learning.map(e => e.category).join(', ')}`);
	}
	return parts.join(' | ').slice(0, maxChars);
}

/** 智能上下文建议（根据当前编辑器内容推荐关注点） */
export interface ContextSuggestion {
	type: 'wiki' | 'memory' | 'learning' | 'semantic';
	title: string;
	detail: string;
	action?: string; // command to execute
}

export async function getContextSuggestions(): Promise<ContextSuggestion[]> {
	const suggestions: ContextSuggestion[] = [];
	const editorCtx = getEditorContextHint();

	if (editorCtx) {
		// Semantic memory suggestions
		const topical = await getTopicalMemories(editorCtx, 3);
		for (const r of topical) {
			if (r.score > 0.2) {
				suggestions.push({
					type: 'semantic',
					title: `相关记忆：${r.entry.content.slice(0, 60)}…`,
					detail: `[${r.entry.category}] 相似度 ${(r.score * 100).toFixed(0)}%`,
				});
			}
		}
	}

	// Check if wiki exists
	const wiki = getCachedWikiContext();
	if (!wiki) {
		suggestions.push({
			type: 'wiki',
			title: '尚未生成 Repo Wiki',
			detail: '运行「Kodrix: 生成 Repo Wiki」加速 Agent 理解项目',
			action: COMMANDS.wikiGenerate,
		});
	}

	// Check memory
	const memory = readMemoryContent();
	if (!memory.trim()) {
		suggestions.push({
			type: 'memory',
			title: '项目 Memory 为空',
			detail: '使用 Ctrl+Shift+Alt+M 沉淀第一条项目知识',
			action: COMMANDS.learnCapture,
		});
	}

	return suggestions;
}

/** 获取完整上下文状态（供 Hub 仪表盘） */
export function getContextStatus(): {
	wikiOk: boolean;
	memoryCount: number;
	learningCount: number;
	semanticVectors: number;
	contextSize: string;
} {
	// 避免重复调用昂贵的 I/O 操作: 每个 getWikiContextForAgent() / getAssembledContext()
	// 都可能涉及文件读取和 wiki 解析。使用缓存版本避免冗余 I/O。
	const wiki = getCachedWikiContext();
	const memory = readMemoryContent();
	const memoryLines = memory.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('##')).length;
	const learning = getRecentLearning(100);
	const semantic = getSemanticStats();

	const assembled = getAssembledContext(50000);
	const charCount = assembled.length;

	return {
		wikiOk: !!wiki,
		memoryCount: Math.max(1, memoryLines),
		learningCount: learning.length,
		semanticVectors: semantic.totalVectors,
		contextSize: charCount > 10000 ? `${(charCount / 1000).toFixed(1)}K` : `${charCount} chars`,
	};
}

export async function refreshAllContext(): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		vscode.window.showWarningMessage(l10n.t('请先打开工作区文件夹'));
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: l10n.t('Kodrix: 刷新 Agent 上下文…') },
		async () => {
			await generateRepoWiki({ recordLearning: true });
			syncProjectInstructionsFile();
			const { rebuildIndex } = await import('../learning/semanticMemory');
			await rebuildIndex();
			await registerInstructionFolders();
			notifyContextChanged();
		},
	);
	vscode.window.showInformationMessage(l10n.t('Agent 上下文已刷新（Wiki + Memory + Semantic + Instructions）'));
}

export async function showContextStatus(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration(CONFIG_FEATURES);
	const status = getContextStatus();
	const suggestions = await getContextSuggestions();
	const locations = vscode.workspace.getConfiguration('chat').get<Record<string, boolean>>('instructionsFilesLocations') || {};
	const kodrixLocs = Object.entries(locations).filter(([k]) => k.includes('.kodrix') || k.includes('kodrix'));

	const lines = [
		'# Kodrix 上下文状态（大厂级诊断）',
		'',
		'## 功能开关',
		'',
		`| 功能 | 状态 |`,
		`|------|------|`,
		`| Memory | ${cfg.get('memory') ? '开' : '关'} |`,
		`| Wiki | ${cfg.get('wiki') ? '开' : '关'} |`,
		`| Learning | ${cfg.get('learning') ? '开' : '关'} |`,
		`| Session Learning | ${cfg.get('sessionLearning') ? '开' : '关'} |`,
		`| Semantic Memory | ${cfg.get('semanticMemory') !== false ? '开' : '关'} |`,
		`| Context 注入 | ${cfg.get('contextInjection') ? '开' : '关'} |`,
		'',
		'## 上下文数据',
		'',
		`| 项目 Wiki | ${status.wikiOk ? '已生成' : '未生成'} |`,
		`| Memory 条目 | ${status.memoryCount} 条 |`,
		`| Learning 条目 | ${status.learningCount} 条 |`,
		`| 语义向量索引 | ${status.semanticVectors} 条 |`,
		`| 组装后大小 | ${status.contextSize} |`,
		'',
		'## Instructions 位置',
		'',
		...(kodrixLocs.length ? kodrixLocs.map(([k, v]) => `- \`${k}\` → ${v ? '启用' : '禁用'}`) : ['- （尚未注册 Kodrix 路径）']),
		'',
		'## 智能建议',
		'',
		...(suggestions.length
			? suggestions.map(s => `- **${s.title}**\n  ${s.detail}${s.action ? ` → \`${s.action}\`` : ''}`)
			: ['- 上下文完整，无需操作']),
		'',
		'## 组装预览（截断 3K）',
		'',
		'```',
		getAssembledContext(3000),
		'```',
	];

	const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
	await vscode.window.showTextDocument(doc);
}

/** 状态栏显示上下文摘要 */
export function getStatusBarText(): string {
	const status = getContextStatus();
	const parts: string[] = [];
	if (status.wikiOk) parts.push('W');
	if (status.memoryCount > 0) parts.push(`M${status.memoryCount}`);
	if (status.learningCount > 0) parts.push(`L${status.learningCount}`);
	if (status.semanticVectors > 0) parts.push(`S${status.semanticVectors}`);
	return parts.length ? `Kodrix: ${parts.join('·')}` : 'Kodrix';
}

type WorkspaceChatContextItem = {
	label: string;
	icon?: vscode.ThemeIcon;
	modelDescription?: string;
	value: string;
};

type ChatWorkspaceApi = {
	registerChatWorkspaceContextProvider?: (
		id: string,
		provider: {
			onDidChangeWorkspaceChatContext?: vscode.Event<void>;
			provideWorkspaceChatContext: (token: vscode.CancellationToken) => vscode.ProviderResult<WorkspaceChatContextItem[]>;
		},
	) => vscode.Disposable;
};

export function registerContextIntelligence(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.contextStatus, () => showContextStatus()),
		vscode.commands.registerCommand(COMMANDS.contextRefresh, () => refreshAllContext()),
	);

	setTimeout(() => {
		void registerInstructionFolders();
	}, INSTRUCTION_REGISTER_DELAY_MS);

	const chatApi = (vscode as typeof vscode & { chat?: ChatWorkspaceApi }).chat;
	if (chatApi?.registerChatWorkspaceContextProvider) {
		const provider = {
			onDidChangeWorkspaceChatContext: onContextChanged,
			provideWorkspaceChatContext: async (_token: vscode.CancellationToken): Promise<WorkspaceChatContextItem[]> => {
				const enabled = vscode.workspace.getConfiguration(CONFIG_FEATURES).get<boolean>('contextInjection', true);
				if (!enabled) return [];

				const value = await getAssembledContextFull(2000);
				if (!value.trim()) return [];

				const summary = getContextSummary();
				const summaryText = l10n.t('上下文: Wiki {0}KB + Memory {1}条 + Learning {2}条 + Semantic {3}向量 ≈ {4} tokens',
					summary.wikiKB.toFixed(1), summary.memoryCount, summary.learningCount, summary.semanticVectors, summary.estimatedTokens);

				return [
					{
						label: l10n.t('Kodrix 项目上下文（Wiki + Memory + Semantic）'),
						icon: new vscode.ThemeIcon('brain'),
						modelDescription: l10n.t('Repo Wiki + Memory + 学习沉淀 + 语义记忆的智能组装'),
						value,
					},
					{
						label: l10n.t('Kodrix 上下文摘要'),
						icon: new vscode.ThemeIcon('info'),
						modelDescription: summaryText,
						value: summaryText,
					},
				];
			},
		};
		context.subscriptions.push(chatApi.registerChatWorkspaceContextProvider('kodrix.agentOs', provider));
	}
}
