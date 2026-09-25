"use strict";
/*---------------------------------------------------------------------------------------------
 *  Context Intelligence v2 — 多层上下文组装 + 语义记忆检索 + 主动上下文建议
 *  大厂对标：Cursor implicit context + Windsurf memories + Qoder knowledge graph
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
exports.writeWikiInstructionsFile = exports.registerInstructionFolders = exports.mergeInstructionLocation = void 0;
exports.getAssembledContext = getAssembledContext;
exports.getCompactContext = getCompactContext;
exports.getContextSuggestions = getContextSuggestions;
exports.getContextStatus = getContextStatus;
exports.refreshAllContext = refreshAllContext;
exports.showContextStatus = showContextStatus;
exports.getStatusBarText = getStatusBarText;
exports.registerContextIntelligence = registerContextIntelligence;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const contextEvents_1 = require("../context/contextEvents");
const instructionRegistry_1 = require("./instructionRegistry");
const learningEngine_1 = require("../learning/learningEngine");
const memoryHelpers_1 = require("../memory/memoryHelpers");
const repoWiki_1 = require("../wiki/repoWiki");
const semanticMemory_1 = require("../learning/semanticMemory");
const constants_1 = require("../shared/constants");
var instructionRegistry_2 = require("./instructionRegistry");
Object.defineProperty(exports, "mergeInstructionLocation", { enumerable: true, get: function () { return instructionRegistry_2.mergeInstructionLocation; } });
Object.defineProperty(exports, "registerInstructionFolders", { enumerable: true, get: function () { return instructionRegistry_2.registerInstructionFolders; } });
Object.defineProperty(exports, "writeWikiInstructionsFile", { enumerable: true, get: function () { return instructionRegistry_2.writeWikiInstructionsFile; } });
// Cache wiki context to avoid redundant file I/O within a single render frame
let _cachedWiki = null;
let _cachedWikiTime = 0;
function getCachedWikiContext() {
    const now = Date.now();
    if (_cachedWiki && (now - _cachedWikiTime) < constants_1.WIKI_CACHE_TTL_MS)
        return _cachedWiki;
    _cachedWiki = (0, repoWiki_1.getWikiContextForAgent)();
    _cachedWikiTime = now;
    return _cachedWiki;
}
/** 获取当前编辑器内容作为上下文提示 */
function getEditorContextHint() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return '';
    const doc = editor.document;
    const selection = doc.getText(editor.selection);
    if (selection && selection.length > 10)
        return selection.slice(0, 500);
    // 获取当前行附近内容
    const cursor = editor.selection.active;
    const startLine = Math.max(0, cursor.line - 10);
    const endLine = Math.min(doc.lineCount - 1, cursor.line + 10);
    const contextLines = [];
    for (let i = startLine; i <= endLine; i++) {
        contextLines.push(doc.lineAt(i).text);
    }
    return contextLines.join('\n').slice(0, 800);
}
function getAssembledContext(maxChars = constants_1.ASSEMBLED_CONTEXT_MAX_CHARS) {
    const parts = [];
    // 1. Wiki context (cached to avoid redundant file I/O)
    const wiki = getCachedWikiContext();
    if (wiki)
        parts.push(wiki);
    // 2. Memory
    const memory = (0, memoryHelpers_1.readMemoryContent)().slice(0, 2000);
    if (memory)
        parts.push(`[Project Memory]\n${memory}`);
    // 3. Recent learning (recency-based)
    const learning = (0, learningEngine_1.getLearningContextSummary)();
    if (learning)
        parts.push(learning);
    // 4. Semantic memory (relevance-based, using editor context)
    const editorCtx = getEditorContextHint();
    if (editorCtx) {
        const semantic = (0, semanticMemory_1.getSemanticContext)(editorCtx, 1000);
        if (semantic && !parts.some(p => p.includes(semantic.slice(10, 50)))) {
            parts.push(semantic);
        }
    }
    const combined = parts.join('\n\n');
    if (combined.length <= maxChars)
        return combined;
    // Graceful truncation: cut at the last double-newline (paragraph boundary)
    // so the model doesn't receive a mid-sentence fragment.
    const truncated = combined.slice(0, maxChars);
    const lastBreak = truncated.lastIndexOf('\n\n');
    if (lastBreak > maxChars * 0.7) {
        return truncated.slice(0, lastBreak) + '\n\n…(truncated)';
    }
    return truncated + '\n…(truncated)';
}
/** 获取简短上下文（用于状态栏 / tooltip） */
function getCompactContext(maxChars = constants_1.COMPACT_CONTEXT_MAX_CHARS) {
    const parts = [];
    const wiki = getCachedWikiContext();
    if (wiki)
        parts.push(wiki.slice(0, 80));
    const memory = (0, memoryHelpers_1.readMemoryContent)();
    if (memory)
        parts.push(`Memory: ${memory.slice(0, 60)}…`);
    const learning = (0, learningEngine_1.getRecentLearning)(2);
    if (learning.length) {
        parts.push(`Learning: ${learning.map(e => e.category).join(', ')}`);
    }
    return parts.join(' | ').slice(0, maxChars);
}
function getContextSuggestions() {
    const suggestions = [];
    const editorCtx = getEditorContextHint();
    if (editorCtx) {
        // Semantic memory suggestions
        const topical = (0, semanticMemory_1.getTopicalMemories)(editorCtx, 3);
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
            action: constants_1.COMMANDS.wikiGenerate,
        });
    }
    // Check memory
    const memory = (0, memoryHelpers_1.readMemoryContent)();
    if (!memory.trim()) {
        suggestions.push({
            type: 'memory',
            title: '项目 Memory 为空',
            detail: '使用 Ctrl+Shift+Alt+M 沉淀第一条项目知识',
            action: constants_1.COMMANDS.learnCapture,
        });
    }
    return suggestions;
}
/** 获取完整上下文状态（供 Hub 仪表盘） */
function getContextStatus() {
    // 避免重复调用昂贵的 I/O 操作: 每个 getWikiContextForAgent() / getAssembledContext()
    // 都可能涉及文件读取和 wiki 解析。使用缓存版本避免冗余 I/O。
    const wiki = getCachedWikiContext();
    const memory = (0, memoryHelpers_1.readMemoryContent)();
    const memoryLines = memory.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('##')).length;
    const learning = (0, learningEngine_1.getRecentLearning)(100);
    const semantic = (0, semanticMemory_1.getSemanticStats)();
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
async function refreshAllContext() {
    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('请先打开工作区文件夹'));
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode_1.l10n.t('Kodrix: 刷新 Agent 上下文…') }, async () => {
        await (0, repoWiki_1.generateRepoWiki)({ recordLearning: true });
        (0, learningEngine_1.syncProjectInstructionsFile)();
        const { rebuildIndex } = await Promise.resolve().then(() => __importStar(require('../learning/semanticMemory')));
        rebuildIndex();
        await (0, instructionRegistry_1.registerInstructionFolders)();
        (0, contextEvents_1.notifyContextChanged)();
    });
    vscode.window.showInformationMessage(vscode_1.l10n.t('Agent 上下文已刷新（Wiki + Memory + Semantic + Instructions）'));
}
async function showContextStatus() {
    const cfg = vscode.workspace.getConfiguration(constants_1.CONFIG_FEATURES);
    const status = getContextStatus();
    const suggestions = getContextSuggestions();
    const locations = vscode.workspace.getConfiguration('chat').get('instructionsFilesLocations') || {};
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
function getStatusBarText() {
    const status = getContextStatus();
    const parts = [];
    if (status.wikiOk)
        parts.push('W');
    if (status.memoryCount > 0)
        parts.push(`M${status.memoryCount}`);
    if (status.learningCount > 0)
        parts.push(`L${status.learningCount}`);
    if (status.semanticVectors > 0)
        parts.push(`S${status.semanticVectors}`);
    return parts.length ? `Kodrix: ${parts.join('·')}` : 'Kodrix';
}
function registerContextIntelligence(context) {
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.contextStatus, () => showContextStatus()), vscode.commands.registerCommand(constants_1.COMMANDS.contextRefresh, () => refreshAllContext()));
    setTimeout(() => {
        void (0, instructionRegistry_1.registerInstructionFolders)();
    }, constants_1.INSTRUCTION_REGISTER_DELAY_MS);
    const chatApi = vscode.chat;
    if (chatApi?.registerChatWorkspaceContextProvider) {
        const provider = {
            onDidChangeWorkspaceChatContext: contextEvents_1.onContextChanged,
            provideWorkspaceChatContext: (_token) => {
                const enabled = vscode.workspace.getConfiguration(constants_1.CONFIG_FEATURES).get('contextInjection', true);
                if (!enabled)
                    return [];
                const value = getAssembledContext(2000);
                if (!value.trim())
                    return [];
                return [{
                        label: vscode_1.l10n.t('Kodrix 项目上下文（Wiki + Memory + Semantic）'),
                        icon: new vscode.ThemeIcon('brain'),
                        modelDescription: vscode_1.l10n.t('Repo Wiki + Memory + 学习沉淀 + 语义记忆的智能组装'),
                        value,
                    }];
            },
        };
        context.subscriptions.push(chatApi.registerChatWorkspaceContextProvider('kodrix.agentOs', provider));
    }
}
