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
        const choice = await vscode.window.showInformationMessage(vscode_1.l10n.t('Kodrix distilled {0} project knowledge entries from the Agent session. Save them?\n\n{1}', insights.length, preview), vscode_1.l10n.t('Distill All'), vscode_1.l10n.t('Select one by one'), vscode_1.l10n.t('Ignore'));
        if (choice === vscode_1.l10n.t('Ignore') || !choice) {
            return 0;
        }
        if (choice === vscode_1.l10n.t('Select one by one')) {
            const picked = [];
            for (const insight of insights) {
                const ok = await vscode.window.showQuickPick([{ label: vscode_1.l10n.t('Distill'), apply: true }, { label: vscode_1.l10n.t('Skip'), apply: false }], { placeHolder: `[${insight.category}] ${insight.content}` });
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
        vscode.window.showInformationMessage(vscode_1.l10n.t('Captured {0} pieces of session knowledge (session {1}…)', applied, sessionId.slice(0, 8)));
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
/** 已处理会话的保留上限与保留天数（transcript 属私有数据，不能无限堆积在工作区里） */
const PROCESSED_KEEP_MAX = 50;
const PROCESSED_KEEP_DAYS = 7;
/** 清理已处理会话：超过天数或超过数量的旧文件删除（只保留最近若干条便于排查） */
function pruneProcessedSessions(processedDir) {
    try {
        const files = fs.readdirSync(processedDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
            const full = path.join(processedDir, f);
            return { full, mtime: fs.statSync(full).mtimeMs };
        })
            .sort((a, b) => b.mtime - a.mtime);
        const cutoff = Date.now() - PROCESSED_KEEP_DAYS * 24 * 60 * 60 * 1000;
        let removed = 0;
        for (let i = 0; i < files.length; i++) {
            if (i < PROCESSED_KEEP_MAX && files[i].mtime >= cutoff) {
                continue;
            }
            fs.unlinkSync(files[i].full);
            removed++;
        }
        if (removed > 0) {
            logger_1.logger.info(`[SessionLearning] 已清理 ${removed} 个过期会话记录（保留最多 ${PROCESSED_KEEP_MAX} 条 / ${PROCESSED_KEEP_DAYS} 天）`);
        }
    }
    catch (err) {
        logger_1.logger.warn(`[SessionLearning] 清理已处理会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
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
        pruneProcessedSessions(processedDir);
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
            vscode.window.showWarningMessage(vscode_1.l10n.t('Please open a workspace first to install the Session Learning Hook'));
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
        vscode.window.showInformationMessage(vscode_1.l10n.t('Session Learning Hook installed — project knowledge will be distilled automatically when an Agent session ends'));
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
        vscode_1.l10n.t('# Session Learning — Automatic learning from Agent sessions'),
        '',
        vscode_1.l10n.t('## Configuration'),
        '',
        vscode_1.l10n.t('| Setting | Value |'),
        '|----|-----|',
        vscode_1.l10n.t('| Enabled | {0} |', cfg.enabled ? vscode_1.l10n.t('Yes') : vscode_1.l10n.t('No')),
        vscode_1.l10n.t('| Mode | {0} (auto = distill automatically / prompt = ask each time / off = disabled) |', cfg.mode),
        vscode_1.l10n.t('| Minimum user messages | {0} |', cfg.minUserMessages),
        vscode_1.l10n.t('| Pending queue | {0} |', pendingCount),
        vscode_1.l10n.t('| Processed sessions | {0} |', index.entries.length),
        '',
        vscode_1.l10n.t('## Recently processed'),
        '',
        ...(recent.length
            ? recent.map(e => vscode_1.l10n.t('- `{0}` **{1}…** — {2} insights distilled · {3} user messages', e.processedAt.slice(0, 16), e.sessionId.slice(0, 8), e.insightCount, e.userMessages))
            : [vscode_1.l10n.t('(None yet — triggers automatically when an Agent task finishes)')]),
        '',
        vscode_1.l10n.t('## How it works'),
        '',
        vscode_1.l10n.t('1. `.github/hooks/kodrix-session-learning.json` runs when the Agent **Stop** event fires'),
        vscode_1.l10n.t('2. The Hook writes the session transcript to `.kodrix/sessions/pending/`'),
        vscode_1.l10n.t('3. The Learning Engine uses an LLM to distill 0-3 project knowledge entries → Memory + learning log'),
    ];
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(doc);
}
function registerSessionLearning(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.learn.installSessionHook', () => installSessionLearningHook(context)), vscode.commands.registerCommand('kodrix.learn.sessionStatus', () => showSessionLearningStatus()), vscode.commands.registerCommand('kodrix.learn.processPendingSessions', () => {
        scanPendingSessions();
        vscode.window.showInformationMessage(vscode_1.l10n.t('Scanned pending session queue'));
    }));
    const pendingDir = (0, paths_1.getPendingSessionsDir)();
    if (pendingDir) {
        (0, paths_1.ensureDir)(pendingDir);
        const pattern = new vscode.RelativePattern(vscode.Uri.file(pendingDir), '*.json');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const scanTimer = setTimeout(() => scanPendingSessions(), 4000);
        context.subscriptions.push(watcher, watcher.onDidCreate(uri => enqueuePendingFile(uri.fsPath)), watcher.onDidChange(uri => enqueuePendingFile(uri.fsPath)), new vscode.Disposable(() => clearTimeout(scanTimer)));
    }
    const cfg = getSessionLearningConfig();
    if (cfg.enabled && cfg.autoInstallHook && !context.workspaceState.get(HOOK_INSTALLED_KEY)) {
        const hookTimer = setTimeout(() => {
            void installSessionLearningHook(context, { silent: true });
        }, 6000);
        context.subscriptions.push(new vscode.Disposable(() => clearTimeout(hookTimer)));
    }
}
