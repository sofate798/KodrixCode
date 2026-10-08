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
	CONFIG_FEATURES,
	COMMANDS,
	INSTRUCTION_REGISTER_DELAY_MS,
	FEATURE_FLAGS,
} from '../shared/constants';
import { isKodrixFeatureEnabled } from '../utils/featureFlags';

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
	// 记忆条目计数：以 `-` 开头的条目 + 章节标题；空记忆如实为 0（此前 Math.max(1, …) 让"空"永远不可达）
	const memoryLines = memory.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('##')).length;

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
	if (_cachedWiki && (now - _cachedWikiTime) < WIKI_CACHE_TTL_MS) {return _cachedWiki;}
	_cachedWiki = getWikiContextForAgent();
	_cachedWikiTime = now;
	return _cachedWiki;
}

/**
 * 清空上下文缓存。
 * 必须在工作区切换与上下文刷新时调用：否则同一窗口从工作区 A 切到 B 后，
 * 缓存窗口内会把 A 的仓库结构/模块清单注入到 B（跨项目内容泄漏）。
 */
export function invalidateContextCaches(): void {
	_cachedWiki = null;
	_cachedWikiTime = 0;
}

/** 获取当前编辑器内容作为上下文提示 */
function getEditorContextHint(): string {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {return '';}

	const doc = editor.document;
	const selection = doc.getText(editor.selection);
	if (selection && selection.length > 10) {return selection.slice(0, 500);}

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

/**
 * 分层字符预算。
 * 背景：原先只有"整体预算"（Chat 注入 2000 字符），而 Wiki 单层就可能到 12000 字符，
 * 于是 `combined.slice(0, 2000)` 永远只留下 Wiki —— Memory / Learning / 语义记忆
 * 在 UI 上显示"已就绪"，实际永远进不了 prompt。现在每层独立截断后再拼装。
 */
export const CONTEXT_LAYER_BUDGETS = {
	wiki: 1200,
	memory: 500,
	learning: 400,
	semantic: 400,
} as const;

/** Chat 注入总预算：四层预算之和（1200+500+400+400=2500）+ 结构开销 */
export const CHAT_CONTEXT_MAX_CHARS = 3000;

/**
 * 分层开关（单一来源：`kodrix.features.*`）。
 * 状态栏的「选择要注入的上下文层级」写的就是这些配置项，装配时必须真的读它们，
 * 否则开关只是装饰（曾出现"取消勾选后注入内容完全不变"）。
 */
export function isContextLayerEnabled(layer: 'wiki' | 'memory' | 'learning' | 'semantic'): boolean {
	const cfg = vscode.workspace.getConfiguration(CONFIG_FEATURES);
	switch (layer) {
		case 'wiki': return cfg.get<boolean>('wiki', true);
		case 'memory': return cfg.get<boolean>('memory', true);
		case 'learning': return cfg.get<boolean>('learning', true);
		case 'semantic': return cfg.get<boolean>('semanticMemory', true) !== false;
	}
}

/** Hub 卡片预览的上下文长度（与 Chat 注入预算 CHAT_CONTEXT_MAX_CHARS 分开：预览只需一小段） */
export const HUB_PREVIEW_MAX_CHARS = 600;

/** 单层超预算时截断并显式标注（避免"看起来完整、实际被砍"的误判） */
export function truncateLayer(text: string, budget: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= budget) {return trimmed;}
	return `${trimmed.slice(0, budget).trimEnd()}\n…（本层已截断，原 ${trimmed.length} 字符）`;
}

/** 按段落边界做整体预算裁剪 */
export function applyTotalBudget(combined: string, maxChars: number): string {
	if (combined.length <= maxChars) {return combined;}
	const truncated = combined.slice(0, maxChars);
	const lastBreak = truncated.lastIndexOf('\n\n');
	if (lastBreak > maxChars * 0.7) {
		return truncated.slice(0, lastBreak) + '\n\n…(truncated)';
	}
	return truncated + '\n…(truncated)';
}

/** 同步构建的上下文层（wiki / memory / learning），已按各自预算截断 */
export interface ContextLayers {
	wiki: string;
	memory: string;
	learning: string;
}

/**
 * 构建同步三层内容（wiki / memory / learning）。
 * 抽出来的目的：状态栏只需要"各层大小"，不该为此把 5 万字符拼成一个字符串（纯属浪费）。
 */
export function buildContextLayers(): ContextLayers {
	const wiki = isContextLayerEnabled('wiki') ? getCachedWikiContext() : null;
	const memory = isContextLayerEnabled('memory') ? readMemoryContent() : '';
	const learning = isContextLayerEnabled('learning') ? getRecentLearning(5) : [];

	const learningText = learning.length
		? `[Recent Learning]\n${learning.map(e => `- [${e.category}] ${e.content}`).join('\n')}`
		: '';

	return {
		wiki: wiki ? truncateLayer(wiki, CONTEXT_LAYER_BUDGETS.wiki) : '',
		memory: memory.trim() ? truncateLayer(`[Project Memory]\n${memory}`, CONTEXT_LAYER_BUDGETS.memory) : '',
		learning: learningText ? truncateLayer(learningText, CONTEXT_LAYER_BUDGETS.learning) : '',
	};
}

export function getAssembledContext(maxChars = ASSEMBLED_CONTEXT_MAX_CHARS): string {
	const layers = buildContextLayers();
	const parts = [layers.wiki, layers.memory, layers.learning].filter(Boolean);
	// NOTE: 语义记忆检索（query-based）在异步路径 getAssembledContextFull() 中
	return applyTotalBudget(parts.join('\n\n'), maxChars);
}

/**
 * 上下文规模汇总（供状态栏 tooltip 使用）：**只统计各层字符数，不拼接字符串**。
 * 此前状态栏为了显示一个数字调用了 `getAssembledContext(50000)`，等于每次刷新都做一次全量组装。
 */
export function getContextSizeSummary(): { totalChars: number; layers: Record<keyof ContextLayers, number> } {
	const layers = buildContextLayers();
	const sizes = {
		wiki: layers.wiki.length,
		memory: layers.memory.length,
		learning: layers.learning.length,
	};
	return { totalChars: sizes.wiki + sizes.memory + sizes.learning, layers: sizes };
}

/**
 * Chat 上下文提供者专用：只组装**指令文件未覆盖**的层（Learning + Semantic）。
 *
 * 为什么需要它：Wiki 与 Memory 已经由 `.kodrix/instructions/*.md` 的指令文件注入
 * （`chat.instructionsFilesLocations`，见 instructionRegistry），Chat 上下文提供者若再把
 * 同一份 Wiki/Memory 拼进来，同一个 prompt 里就会出现 2–3 份重复内容（实测约 3–4k token 浪费）。
 * 只在**指令注入关闭**时才回退到全量组装（否则用户会完全失去 Wiki/Memory 上下文）。
 */
export async function getChatOnlyContext(maxChars = CHAT_CONTEXT_MAX_CHARS): Promise<string> {
	const parts: string[] = [];

	const learning = isContextLayerEnabled('learning') ? getRecentLearning(5) : [];
	if (learning.length) {
		const lines = learning.map(e => `- [${e.category}] ${e.content}`);
		parts.push(truncateLayer(`[Recent Learning]\n${lines.join('\n')}`, CONTEXT_LAYER_BUDGETS.learning));
	}

	const editorCtx = isContextLayerEnabled('semantic') ? getEditorContextHint() : '';
	if (editorCtx) {
		try {
			const semantic = await getSemanticContext(editorCtx, CONTEXT_LAYER_BUDGETS.semantic);
			if (semantic && semantic.trim()) {
				parts.push(truncateLayer(semantic, CONTEXT_LAYER_BUDGETS.semantic));
			}
		} catch {
			// 语义检索失败：不影响 Learning 层注入
		}
	}

	return applyTotalBudget(parts.join('\n\n'), maxChars);
}

/**
 * 异步版本的完整上下文组装，包含语义记忆检索。
 * 四层各自按预算截断后再拼装，最后才做整体裁剪 —— 保证任何一层都不会被前一层挤掉。
 */
export async function getAssembledContextFull(maxChars = ASSEMBLED_CONTEXT_MAX_CHARS): Promise<string> {
	const parts: string[] = [];

	const wiki = isContextLayerEnabled('wiki') ? getCachedWikiContext() : null;
	if (wiki) {parts.push(truncateLayer(wiki, CONTEXT_LAYER_BUDGETS.wiki));}

	const memory = isContextLayerEnabled('memory') ? readMemoryContent() : '';
	if (memory.trim()) {parts.push(truncateLayer(`[Project Memory]\n${memory}`, CONTEXT_LAYER_BUDGETS.memory));}

	const learning = isContextLayerEnabled('learning') ? getRecentLearning(5) : [];
	if (learning.length) {
		const lines = learning.map(e => `- [${e.category}] ${e.content}`);
		parts.push(truncateLayer(`[Recent Learning]\n${lines.join('\n')}`, CONTEXT_LAYER_BUDGETS.learning));
	}

	// 语义记忆：以编辑器上下文为查询，单独占一层预算（失败不影响其它层）
	const editorCtx = isContextLayerEnabled('semantic') ? getEditorContextHint() : '';
	if (editorCtx) {
		try {
			const semantic = await getSemanticContext(editorCtx, CONTEXT_LAYER_BUDGETS.semantic);
			if (semantic && semantic.trim()) {
				parts.push(truncateLayer(semantic, CONTEXT_LAYER_BUDGETS.semantic));
			}
		} catch {
			// 语义检索失败：其余三层照常注入
		}
	}

	return applyTotalBudget(parts.join('\n\n'), maxChars);
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
					title: l10n.t('Related memory: {0}…', r.entry.content.slice(0, 60)),
					detail: l10n.t('[{0}] Similarity {1}%', r.entry.category, (r.score * 100).toFixed(0)),
				});
			}
		}
	}

	// Check if wiki exists
	const wiki = getCachedWikiContext();
	if (!wiki) {
		suggestions.push({
			type: 'wiki',
			title: l10n.t('Repo Wiki has not been generated yet'),
			detail: l10n.t('Run "Kodrix: Generate Repo Wiki" to help the Agent understand the project faster'),
			action: COMMANDS.wikiGenerate,
		});
	}

	// Check memory
	const memory = readMemoryContent();
	if (!memory.trim()) {
		suggestions.push({
			type: 'memory',
			title: l10n.t('Project Memory is empty'),
			detail: l10n.t('Press Ctrl+Shift+Alt+M to distill your first piece of project knowledge'),
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

	// 只统计规模，不拼接 5 万字符的上下文串（状态栏、Hub 每次刷新都会走这里）
	const charCount = getContextSizeSummary().totalChars;

	return {
		wikiOk: !!wiki,
		// 空记忆如实报 0：让状态栏/建议能给出"去沉淀第一条"的引导（此前恒 ≥1，空态永不可达）
		memoryCount: memoryLines,
		learningCount: learning.length,
		semanticVectors: semantic.totalVectors,
		contextSize: charCount > 10000 ? `${(charCount / 1000).toFixed(1)}K` : `${charCount} chars`,
	};
}

export async function refreshAllContext(): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		vscode.window.showWarningMessage(l10n.t('Please open a workspace folder first'));
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: l10n.t('Kodrix: Refreshing Agent context…') },
		async () => {
			await generateRepoWiki({ recordLearning: true });
			syncProjectInstructionsFile();
			const { rebuildIndex } = await import('../learning/semanticMemory');
			await rebuildIndex();
			await registerInstructionFolders();
			notifyContextChanged();
		},
	);
	vscode.window.showInformationMessage(l10n.t('Agent context refreshed (Wiki + Memory + Semantic + Instructions)'));
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

	const instructionTimer = setTimeout(() => {
		void registerInstructionFolders();
	}, INSTRUCTION_REGISTER_DELAY_MS);
	// 延迟注册定时器纳入 subscriptions：扩展卸载时取消（触发时机不变）
	context.subscriptions.push(new vscode.Disposable(() => clearTimeout(instructionTimer)));

	// 工作区切换 → 清空缓存（否则新工作区会短暂复用上一个工作区的 Wiki 内容）
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => invalidateContextCaches()),
	);
	// 上下文被显式刷新（wiki 重新生成 / 记忆写入 / session 学习）→ 清空缓存，保证下次注入是最新内容
	context.subscriptions.push(onContextChanged(() => invalidateContextCaches()));

	const chatApi = (vscode as typeof vscode & { chat?: ChatWorkspaceApi }).chat;
	if (chatApi?.registerChatWorkspaceContextProvider) {
		const provider = {
			onDidChangeWorkspaceChatContext: onContextChanged,
			provideWorkspaceChatContext: async (_token: vscode.CancellationToken): Promise<WorkspaceChatContextItem[]> => {
				// 总开关 kodrix.features.contextIntelligence（模块级）+ 注入开关 kodrix.features.contextInjection，
				// 任一关闭即不注入（均默认 true，不配置时行为与此前一致）
				const enabled = isKodrixFeatureEnabled(FEATURE_FLAGS.contextIntelligence)
					&& vscode.workspace.getConfiguration(CONFIG_FEATURES).get<boolean>(FEATURE_FLAGS.contextInjection, true);
				if (!enabled) {return [];}

				// 指令注入开启时：Wiki/Memory 已由指令文件提供 → 这里只补 Learning/Semantic，避免同 prompt 重复
				const instructionsActive = vscode.workspace.getConfiguration(CONFIG_FEATURES)
					.get<boolean>(FEATURE_FLAGS.contextInjection, true);
				const value = instructionsActive
					? await getChatOnlyContext(CHAT_CONTEXT_MAX_CHARS)
					: await getAssembledContextFull(CHAT_CONTEXT_MAX_CHARS);
				if (!value.trim()) {return [];}

				const summary = getContextSummary();
				const summaryText = l10n.t('Context: Wiki {0}KB + Memory {1} entries + Learning {2} entries + Semantic {3} vectors ≈ {4} tokens',
					summary.wikiKB.toFixed(1), summary.memoryCount, summary.learningCount, summary.semanticVectors, summary.estimatedTokens);

				return [
					{
						label: l10n.t('Kodrix project context (Wiki + Memory + Semantic)'),
						icon: new vscode.ThemeIcon('brain'),
						modelDescription: l10n.t('Smart assembly of Repo Wiki + Memory + learning captures + semantic memory'),
						value,
					},
					{
						label: l10n.t('Kodrix Context Summary'),
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
