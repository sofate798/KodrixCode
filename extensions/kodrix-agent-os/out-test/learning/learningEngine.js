"use strict";
/*---------------------------------------------------------------------------------------------
 *  Learning Engine — 越用越聪明：跨会话沉淀、自动同步 Instructions
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
exports.readLearningLog = readLearningLog;
exports.recordLearning = recordLearning;
exports.syncProjectInstructionsFile = syncProjectInstructionsFile;
exports.getLearningContextSummary = getLearningContextSummary;
exports.getRelevantLearningForFile = getRelevantLearningForFile;
exports.getLearningStats = getLearningStats;
exports.getRecentLearning = getRecentLearning;
exports.learnFromSelection = learnFromSelection;
exports.showLearningDashboard = showLearningDashboard;
exports.registerLearningEngine = registerLearningEngine;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const contextEvents_1 = require("../context/contextEvents");
const kodrixEventBus_1 = require("../context/kodrixEventBus");
const learningRetrieval_1 = require("./learningRetrieval");
const memoryHelpers_1 = require("../memory/memoryHelpers");
const paths_1 = require("../paths");
const semanticMemory_1 = require("./semanticMemory");
const sessionIndex_1 = require("./sessionIndex");
const jsonValidator_1 = require("../utils/jsonValidator");
const fsSafe_1 = require("../utils/fsSafe");
const panelTracker_1 = require("../utils/panelTracker");
const logger_1 = require("../logger");
const webviewHtml_1 = require("../shared/webviewHtml");
const MAX_LEARNING_IN_INSTRUCTIONS = 12;
const MAX_LEARNING_LOG_BYTES = 512_000;
const INSTRUCTIONS_FRONTMATTER = `---
applyTo: '**'
description: Kodrix 项目 Memory 与学习沉淀（自动同步，请勿手动改文件名）
---

`;
// ── Instructions 同步限流（防止高频写入磁盘） ─────────────────────
let _syncScheduled = false;
function scheduleSyncInstructions() {
    if (_syncScheduled)
        return;
    _syncScheduled = true;
    setTimeout(() => {
        _syncScheduled = false;
        try {
            syncProjectInstructionsFile();
        }
        catch { /* non-critical */ }
    }, 1000);
}
function isValidLearningEntry(v) {
    return (0, jsonValidator_1.isRecord)(v) && (0, jsonValidator_1.isString)(v.id) && (0, jsonValidator_1.isString)(v.timestamp)
        && (0, jsonValidator_1.isString)(v.source) && (0, jsonValidator_1.isString)(v.category) && (0, jsonValidator_1.isString)(v.content);
}
function readLearningLog() {
    const logPath = (0, paths_1.getLearningLogPath)();
    if (!fs.existsSync(logPath)) {
        return [];
    }
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (isValidLearningEntry(parsed)) {
                entries.push(parsed);
            }
        }
        catch {
            // skip corrupt line
        }
    }
    return entries;
}
function appendLearningLog(entry) {
    const logPath = (0, paths_1.getLearningLogPath)();
    (0, paths_1.ensureDir)((0, paths_1.getMemoryDir)());
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    // 文件超限时使用原子写入压缩（保留最新 200 条）
    if (fs.statSync(logPath).size > MAX_LEARNING_LOG_BYTES) {
        const kept = readLearningLog().slice(-200);
        (0, fsSafe_1.atomicWriteFileSync)(logPath, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
    }
}
function recordLearning(content, options) {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('learning', true);
    if (!enabled) {
        return {
            id: 'disabled',
            timestamp: new Date().toISOString(),
            source: options?.source ?? 'manual',
            category: options?.category ?? 'other',
            content: content.trim(),
        };
    }
    const entry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        source: options?.source ?? 'manual',
        category: options?.category ?? (0, learningRetrieval_1.inferLearningCategory)(content),
        content: content.trim(),
    };
    appendLearningLog(entry);
    (0, semanticMemory_1.indexLearningEntry)(entry);
    scheduleSyncInstructions(); // 限流：1s 内只写一次磁盘
    (0, contextEvents_1.notifyContextChanged)();
    (0, kodrixEventBus_1.emitKodrixEvent)({ type: 'learning.recorded', id: entry.id, category: entry.category });
    return entry;
}
function syncProjectInstructionsFile() {
    const memory = (0, memoryHelpers_1.readMemoryContent)();
    const recent = readLearningLog().slice(-MAX_LEARNING_IN_INSTRUCTIONS).reverse();
    const learningSection = recent.length
        ? recent.map(e => `- **${e.category}** (${e.source}, ${e.timestamp.slice(0, 10)}): ${e.content}`).join('\n')
        : '- （尚无自动学习记录 — 使用 `Kodrix: 沉淀项目知识` 或 `从对话捕获 Memory`）';
    const body = `${INSTRUCTIONS_FRONTMATTER}# Kodrix 项目上下文（自动同步）

> 此文件由 Agent OS 自动生成并注入 Agent 指令。请编辑同目录下的 \`memory.md\` 修改长期 Memory。

## 项目 Memory

${memory.trim() || '（空 — 运行 `Kodrix: 查看项目 Memory` 开始记录）'}

## 近期学习（越用越聪明）

${learningSection}

## Agent 提示

- 优先遵循上述 Memory 与近期学习中的约定
- 复杂任务前先查阅 Repo Wiki（\`.kodrix/wiki/\`）
- 使用 \`#codebase\` 补充代码语义上下文
`;
    const outPath = (0, paths_1.getMemoryInstructionsPath)();
    (0, paths_1.ensureDir)((0, paths_1.getMemoryDir)());
    (0, fsSafe_1.atomicWriteFileSync)(outPath, body);
}
function getLearningContextSummary(maxEntries = 5, maxChars = 800, query) {
    const all = readLearningLog();
    if (!all.length) {
        return '';
    }
    const entries = query?.trim()
        ? (0, semanticMemory_1.searchSimilar)(query, maxEntries).map(r => r.entry)
        : all.slice(-maxEntries).reverse();
    if (!entries.length) {
        return '';
    }
    const header = query?.trim() ? '[Relevant Learning]' : '[Recent Learning]';
    const lines = entries.map(e => `- [${e.category}] ${e.content}`);
    const text = `${header}\n${lines.join('\n')}`;
    return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}
function getRelevantLearningForFile(filePath, maxEntries = 3) {
    return (0, semanticMemory_1.searchSimilar)(filePath, maxEntries).map(r => r.entry);
}
function getLearningStats() {
    const entries = readLearningLog();
    const categories = {};
    for (const e of entries) {
        categories[e.category] = (categories[e.category] || 0) + 1;
    }
    return {
        total: entries.length,
        categories,
        lastUpdated: entries.at(-1)?.timestamp,
    };
}
function getRecentLearning(limit = 5) {
    return readLearningLog().slice(-limit).reverse();
}
async function learnFromSelection() {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('learning', true);
    if (!enabled) {
        vscode.window.showWarningMessage('Learning Engine 已关闭。可在设置中启用 kodrix.features.learning');
        return;
    }
    const editor = vscode.window.activeTextEditor;
    const selection = editor?.document.getText(editor.selection);
    const input = selection || await vscode.window.showInputBox({
        prompt: '沉淀为项目知识（将写入 Memory + 学习日志并注入 Agent）',
        placeHolder: '此模块使用 Repository 模式，测试用 vitest',
    });
    if (!input?.trim()) {
        return;
    }
    const category = await vscode.window.showQuickPick(([
        { label: '架构偏好', value: 'architecture' },
        { label: '命名/约定', value: 'convention' },
        { label: '常用模式', value: 'pattern' },
        { label: '已知陷阱', value: 'pitfall' },
        { label: '个人偏好', value: 'preference' },
        { label: '其他', value: 'other' },
    ]), { placeHolder: '选择知识类别' });
    (0, memoryHelpers_1.persistMemoryAppend)(input.trim());
    recordLearning(input.trim(), { source: 'capture', category: category?.value ?? 'other' });
    vscode.window.showInformationMessage('已沉淀项目知识 — 下次 Agent 会话将自动携带');
}
let learningDashboardPanel;
async function showLearningDashboard(context) {
    if (learningDashboardPanel) {
        learningDashboardPanel.reveal(vscode.ViewColumn.One);
        pushLearningDashboard();
        return;
    }
    if (!context) {
        // Fallback: show text version
        const stats = getLearningStats();
        const doc = await vscode.workspace.openTextDocument({
            content: `Learning: ${stats.total} entries, categories: ${JSON.stringify(stats.categories)}`,
            language: 'markdown',
        });
        await vscode.window.showTextDocument(doc);
        return;
    }
    // 使用统一的 createTrackedPanel，确保 deactivate 时随 disposeAllTrackedPanels 一起清理
    const panel = (0, panelTracker_1.createTrackedPanel)(context, 'kodrix.learningDashboard', 'Learning Dashboard', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
    });
    learningDashboardPanel = panel;
    panel.iconPath = new vscode.ThemeIcon('graph');
    try {
        panel.webview.html = (0, webviewHtml_1.loadWebviewHtml)(panel.webview, context.extensionPath, 'learning-dashboard.html');
    }
    catch (err) {
        logger_1.logger.warn('[LearningEngine] 加载 dashboard HTML 资源失败', err);
        panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>`
            + `<body style="font-family:sans-serif;padding:24px">`
            + `<h2>Learning Dashboard</h2><p>资源加载失败，请重新编译扩展。</p></body></html>`;
    }
    panel.webview.onDidReceiveMessage(msg => {
        if (msg.command === 'ready')
            pushLearningDashboard();
        if (msg.command === 'refresh')
            pushLearningDashboard();
        if (msg.command === 'capture') {
            void vscode.commands.executeCommand('kodrix.learn.capture');
            setTimeout(() => pushLearningDashboard(), 500);
        }
    });
    panel.onDidDispose(() => {
        learningDashboardPanel = undefined;
    });
    pushLearningDashboard();
}
function pushLearningDashboard() {
    if (!learningDashboardPanel)
        return;
    const entries = readLearningLog();
    const stats = getLearningStats();
    let ss = { processed: 0, totalInsights: 0 };
    let semantic = { totalVectors: 0 };
    try {
        semantic = (0, semanticMemory_1.getSemanticStats)();
    }
    catch {
        // semantic index not yet built
    }
    try {
        ss = (0, sessionIndex_1.getSessionLearningStats)();
    }
    catch {
        // session index not yet available
    }
    // Count this week
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thisWeek = entries.filter(e => e.timestamp >= weekAgo).length;
    // Memory count
    let memCount = 0;
    try {
        const mc = (0, memoryHelpers_1.readMemoryContent)();
        memCount = mc.split('\n').filter(l => l.trim().startsWith('-')).length || (mc.trim() ? 1 : 0);
    }
    catch { }
    learningDashboardPanel.webview.postMessage({
        type: 'dashboard',
        entries: [...entries].reverse(), // 不原地修改 readLearningLog 返回值
        stats: {
            totalEntries: stats.total,
            sessionProcessed: ss.processed,
            semanticVectors: semantic.totalVectors,
            thisWeek,
            memoryCount: memCount,
        },
    });
}
function registerLearningEngine(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.learn.capture', () => learnFromSelection()), vscode.commands.registerCommand('kodrix.learn.dashboard', () => showLearningDashboard(context)));
    (0, paths_1.ensureDir)((0, paths_1.getMemoryDir)());
    syncProjectInstructionsFile();
    // 语义索引重建可能读取较大日志，延迟到激活之后执行，避免阻塞扩展启动
    const rebuildTimer = setTimeout(() => {
        try {
            if (readLearningLog().length > 0 && (0, semanticMemory_1.getSemanticStats)().totalVectors === 0) {
                (0, semanticMemory_1.rebuildIndex)();
            }
        }
        catch (err) {
            logger_1.logger.warn('[LearningEngine] 启动时重建语义索引失败', err);
        }
    }, 2000);
    context.subscriptions.push({ dispose: () => clearTimeout(rebuildTimer) });
}
