"use strict";
/*---------------------------------------------------------------------------------------------
 *  Session Learning — Agent 会话结束自动摘要学习（Stop Hook + LLM 蒸馏）
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
exports.getSessionLearningStats = void 0;
exports.processSessionPayload = processSessionPayload;
exports.installSessionLearningHook = installSessionLearningHook;
exports.showSessionLearningStatus = showSessionLearningStatus;
exports.registerSessionLearning = registerSessionLearning;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const contextEvents_1 = require("../context/contextEvents");
const memoryHelpers_1 = require("../memory/memoryHelpers");
const paths_1 = require("../paths");
const learningEngine_1 = require("./learningEngine");
const sessionIndex_1 = require("./sessionIndex");
const transcriptParser_1 = require("./transcriptParser");
const logger_1 = require("../logger");
const jsonValidator_1 = require("../utils/jsonValidator");
var sessionIndex_2 = require("./sessionIndex");
Object.defineProperty(exports, "getSessionLearningStats", { enumerable: true, get: function () { return sessionIndex_2.getSessionLearningStats; } });
const HOOK_INSTALLED_KEY = 'kodrix.sessionLearningHookInstalled';
const HOOK_FILE_NAME = 'kodrix-session-learning.json';
const DISTILL_SYSTEM = `你是 Kodrix Learning Engine。从 Agent 编程会话 transcript 中提取 **0-3 条** 值得跨会话记住的项目知识。

只提取：
- 架构决策、技术选型、模块边界
- 命名/代码风格/测试约定
- 反复出现的模式或踩坑

不要提取：
- 一次性的具体代码片段
- 闲聊、翻译、与项目无关的内容
- 已在 transcript 中明确标注为临时/debug 的信息

严格返回 JSON 数组（无 markdown），每项：
{"content":"一句话","category":"architecture|convention|pattern|pitfall|preference|other","confidence":"high|medium|low"}

若无有价值内容返回 []。`;
function getSessionLearningConfig() {
    const features = vscode.workspace.getConfiguration('kodrix.features');
    const cfg = vscode.workspace.getConfiguration('kodrix.sessionLearning');
    return {
        enabled: features.get('sessionLearning', true),
        mode: cfg.get('mode', 'prompt'),
        minUserMessages: cfg.get('minUserMessages', 1),
        autoInstallHook: cfg.get('autoInstallHook', true),
    };
}
function parseInsightsFromModel(text) {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
        return [];
    }
    try {
        const arr = JSON.parse(jsonMatch[0]);
        return arr.filter(i => i.content?.trim() && i.confidence !== 'low').slice(0, 3);
    }
    catch {
        return [];
    }
}
async function distillInsights(transcriptText) {
    const models = await vscode.lm.selectChatModels({});
    if (!models.length || !transcriptText.trim()) {
        return [];
    }
    const model = models[0];
    const messages = [
        vscode.LanguageModelChatMessage.User(`${DISTILL_SYSTEM}\n\n---\n\n${transcriptText.slice(0, 10_000)}`),
    ];
    const cts = new vscode.CancellationTokenSource();
    try {
        const response = await model.sendRequest(messages, {}, cts.token);
        let full = '';
        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                full += chunk.value;
            }
        }
        return parseInsightsFromModel(full);
    }
    catch {
        return [];
    }
    finally {
        cts.dispose();
    }
}
async function applyInsights(insights, sessionId, mode) {
    if (!insights.length) {
        return 0;
    }
    let toApply = insights;
    if (mode === 'prompt') {
        const preview = insights.map(i => `• [${i.category}] ${i.content}`).join('\n');
        const choice = await vscode.window.showInformationMessage(vscode_1.l10n.t('Kodrix 从 Agent 会话提炼了 {0} 条项目知识，是否沉淀？\n\n{1}', insights.length, preview), vscode_1.l10n.t('全部沉淀'), vscode_1.l10n.t('逐条选择'), vscode_1.l10n.t('忽略'));
        if (choice === vscode_1.l10n.t('忽略') || !choice) {
            return 0;
        }
        if (choice === vscode_1.l10n.t('逐条选择')) {
            const picked = [];
            for (const insight of insights) {
                const ok = await vscode.window.showQuickPick([{ label: vscode_1.l10n.t('沉淀'), apply: true }, { label: vscode_1.l10n.t('跳过'), apply: false }], { placeHolder: `[${insight.category}] ${insight.content}` });
                if (ok?.apply) {
                    picked.push(insight);
                }
            }
            toApply = picked;
        }
    }
    let applied = 0;
    for (const insight of toApply) {
        (0, memoryHelpers_1.persistMemoryAppend)(insight.content);
        (0, learningEngine_1.recordLearning)(insight.content, { source: 'session', category: insight.category });
        applied++;
    }
    if (applied > 0) {
        (0, contextEvents_1.notifyContextChanged)();
        vscode.window.showInformationMessage(vscode_1.l10n.t('已沉淀 {0} 条会话知识（会话 {1}…）', applied, sessionId.slice(0, 8)));
    }
    return applied;
}
async function processSessionPayload(payload) {
    const cfg = getSessionLearningConfig();
    if (!cfg.enabled || cfg.mode === 'off') {
        return;
    }
    // 优先使用内联 excerpt；为空时回退读取 transcriptPath（hook 会填充其一）。
    let transcriptRaw = payload.transcriptExcerpt || '';
    if (!transcriptRaw.trim() && payload.transcriptPath) {
        try {
            const stat = fs.statSync(payload.transcriptPath);
            // 限制单次读取大小，避免超大 transcript 阻塞 extension host
            if (stat.isFile() && stat.size <= 2_000_000) {
                transcriptRaw = fs.readFileSync(payload.transcriptPath, 'utf-8');
            }
            else if (stat.size > 2_000_000) {
                logger_1.logger.warn(`[SessionLearning] transcript 过大（${stat.size} bytes），跳过：${payload.transcriptPath}`);
            }
        }
        catch (err) {
            logger_1.logger.warn(`[SessionLearning] 读取 transcriptPath 失败：${payload.transcriptPath}`, err);
        }
    }
    const parsed = (0, transcriptParser_1.parseTranscriptJsonl)(transcriptRaw);
    if (!(0, transcriptParser_1.isSubstantiveSession)(parsed, cfg.minUserMessages)) {
        return;
    }
    const transcriptText = (0, transcriptParser_1.formatTranscriptForLearning)(parsed);
    const insights = await distillInsights(transcriptText);
    const applied = await applyInsights(insights, payload.sessionId, cfg.mode);
    (0, sessionIndex_1.appendSessionIndex)({
        sessionId: payload.sessionId,
        processedAt: new Date().toISOString(),
        insightCount: applied,
        userMessages: parsed.userMessageCount,
        summary: insights.map(i => i.content).join('; ').slice(0, 200) || undefined,
    });
}
function moveToProcessed(pendingPath, sessionId) {
    const processedDir = (0, paths_1.getProcessedSessionsDir)();
    if (!processedDir) {
        fs.unlinkSync(pendingPath);
        return;
    }
    (0, paths_1.ensureDir)(processedDir);
    const dest = path.join(processedDir, `${sessionId}.json`);
    try {
        fs.renameSync(pendingPath, dest);
    }
    catch {
        fs.unlinkSync(pendingPath);
    }
}
async function processPendingFile(filePath) {
    let payload;
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!(0, jsonValidator_1.isRecord)(raw) || !(0, jsonValidator_1.isString)(raw.sessionId) || !(0, jsonValidator_1.isString)(raw.timestamp)) {
            logger_1.logger.warn(`[SessionLearning] processPendingFile: invalid payload — removing ${filePath}`);
            fs.unlinkSync(filePath);
            return;
        }
        payload = raw;
    }
    catch {
        fs.unlinkSync(filePath);
        return;
    }
    const lockHash = crypto.createHash('sha256').update(payload.transcriptExcerpt || '').digest('hex').slice(0, 16);
    const index = (0, sessionIndex_1.loadSessionIndex)();
    if (index.entries.some(e => e.sessionId === payload.sessionId)) {
        moveToProcessed(filePath, payload.sessionId);
        return;
    }
    try {
        await processSessionPayload(payload);
    }
    finally {
        moveToProcessed(filePath, payload.sessionId || lockHash);
    }
}
const processingQueue = new Set();
function enqueuePendingFile(filePath) {
    if (processingQueue.has(filePath)) {
        return;
    }
    processingQueue.add(filePath);
    void processPendingFile(filePath).finally(() => {
        processingQueue.delete(filePath);
    });
}
function scanPendingSessions() {
    const pendingDir = (0, paths_1.getPendingSessionsDir)();
    if (!pendingDir || !fs.existsSync(pendingDir)) {
        return;
    }
    for (const name of fs.readdirSync(pendingDir)) {
        if (name.endsWith('.json')) {
            enqueuePendingFile(path.join(pendingDir, name));
        }
    }
}
async function installSessionLearningHook(context, options) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        if (!options?.silent) {
            vscode.window.showWarningMessage(vscode_1.l10n.t('请先打开工作区以安装 Session Learning Hook'));
        }
        return false;
    }
    const scriptSrc = path.join(context.extensionPath, 'resources', 'hooks', 'session-learn.mjs');
    const scriptDestDir = (0, paths_1.getWorkspaceHooksScriptDir)();
    const hooksDir = (0, paths_1.getGithubHooksDir)();
    if (!scriptDestDir || !hooksDir || !fs.existsSync(scriptSrc)) {
        return false;
    }
    (0, paths_1.ensureDir)(scriptDestDir);
    (0, paths_1.ensureDir)(hooksDir);
    const scriptDest = path.join(scriptDestDir, 'session-learn.mjs');
    fs.copyFileSync(scriptSrc, scriptDest);
    const hookRel = '.kodrix/hooks/scripts/session-learn.mjs';
    const hookConfig = {
        hooks: {
            Stop: [
                {
                    type: 'command',
                    command: `node ${hookRel}`,
                    timeout: 45,
                    windows: `node ${hookRel}`,
                    linux: `node ${hookRel}`,
                    osx: `node ${hookRel}`,
                },
            ],
        },
    };
    const hookPath = path.join(hooksDir, HOOK_FILE_NAME);
    fs.writeFileSync(hookPath, JSON.stringify(hookConfig, null, 2), 'utf-8');
    await context.workspaceState.update(HOOK_INSTALLED_KEY, true);
    if (!options?.silent) {
        vscode.window.showInformationMessage(vscode_1.l10n.t('Session Learning Hook 已安装 — Agent 会话结束时将自动提炼项目知识'));
    }
    return true;
}
async function showSessionLearningStatus() {
    const cfg = getSessionLearningConfig();
    const index = (0, sessionIndex_1.loadSessionIndex)();
    const pendingDir = (0, paths_1.getPendingSessionsDir)();
    const pendingCount = pendingDir && fs.existsSync(pendingDir)
        ? fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).length
        : 0;
    const recent = index.entries.slice(-8).reverse();
    const lines = [
        '# Session Learning — Agent 会话自动学习',
        '',
        '## 配置',
        '',
        `| 项 | 值 |`,
        `|----|-----|`,
        `| 启用 | ${cfg.enabled ? '是' : '否'} |`,
        `| 模式 | ${cfg.mode}（auto=自动沉淀 / prompt=询问 / off=关闭） |`,
        `| 最少用户消息 | ${cfg.minUserMessages} |`,
        `| 待处理队列 | ${pendingCount} |`,
        `| 已处理会话 | ${index.entries.length} |`,
        '',
        '## 最近处理',
        '',
        ...(recent.length
            ? recent.map(e => `- \`${e.processedAt.slice(0, 16)}\` **${e.sessionId.slice(0, 8)}…** — 沉淀 ${e.insightCount} 条 · ${e.userMessages} 轮用户消息`)
            : ['- （尚无 — 完成 Agent 任务后会自动触发）']),
        '',
        '## 原理',
        '',
        '1. `.github/hooks/kodrix-session-learning.json` 在 Agent **Stop** 时运行',
        '2. Hook 将会话 transcript 写入 `.kodrix/sessions/pending/`',
        '3. Learning Engine 用 LLM 蒸馏 0-3 条项目知识 → Memory + 学习日志',
    ];
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(doc);
}
function registerSessionLearning(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.learn.installSessionHook', () => installSessionLearningHook(context)), vscode.commands.registerCommand('kodrix.learn.sessionStatus', () => showSessionLearningStatus()), vscode.commands.registerCommand('kodrix.learn.processPendingSessions', () => {
        scanPendingSessions();
        vscode.window.showInformationMessage('已扫描待处理会话队列');
    }));
    const pendingDir = (0, paths_1.getPendingSessionsDir)();
    if (pendingDir) {
        (0, paths_1.ensureDir)(pendingDir);
        const pattern = new vscode.RelativePattern(vscode.Uri.file(pendingDir), '*.json');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        context.subscriptions.push(watcher, watcher.onDidCreate(uri => enqueuePendingFile(uri.fsPath)), watcher.onDidChange(uri => enqueuePendingFile(uri.fsPath)));
        setTimeout(() => scanPendingSessions(), 4000);
    }
    const cfg = getSessionLearningConfig();
    if (cfg.enabled && cfg.autoInstallHook && !context.workspaceState.get(HOOK_INSTALLED_KEY)) {
        setTimeout(() => {
            void installSessionLearningHook(context, { silent: true });
        }, 6000);
    }
}
