"use strict";
/*---------------------------------------------------------------------------------------------
 *  Kodrix Hub v2 — 统一 Agent 指挥中心（大厂思维重写）
 *  新增：实时意图预览 · 功能开关交互 · 会话学习统计 · 主动上下文建议
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
exports.openKodrixHub = openKodrixHub;
exports.registerKodrixHub = registerKodrixHub;
exports.refreshHubIfOpen = refreshHubIfOpen;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const contextIntelligence_1 = require("../context/contextIntelligence");
const contextEvents_1 = require("../context/contextEvents");
const learningEngine_1 = require("../learning/learningEngine");
const sessionIndex_1 = require("../learning/sessionIndex");
const agentRouter_1 = require("../router/agentRouter");
const specHelpers_1 = require("../spec/specHelpers");
const paths_1 = require("../paths");
const webviewHtml_1 = require("../shared/webviewHtml");
const panelTracker_1 = require("../utils/panelTracker");
const logger_1 = require("../logger");
let activePanel;
function loadKanbanCount() {
    const p = (0, paths_1.getKanbanPath)();
    if (!p || !fs.existsSync(p)) {
        return 0;
    }
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return data.tasks?.length ?? 0;
    }
    catch {
        return 0;
    }
}
function hasWiki() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return false;
    }
    return fs.existsSync(path.join(folder.uri.fsPath, '.kodrix', 'wiki', 'INDEX.md'));
}
function buildDashboard() {
    const cfg = vscode.workspace.getConfiguration('kodrix.features');
    const learning = (0, learningEngine_1.getLearningStats)();
    const folder = vscode.workspace.workspaceFolders?.[0];
    let ss = { processed: 0, totalInsights: 0 };
    try {
        ss = (0, sessionIndex_1.getSessionLearningStats)();
    }
    catch { /* not yet initialized */ }
    return {
        features: [
            { key: 'ideaFlow', label: vscode_1.l10n.t('Idea Flow: idea to product'), on: !!cfg.get('ideaFlow') },
            { key: 'wiki', label: 'Repo Wiki', on: !!cfg.get('wiki') },
            { key: 'memory', label: 'Memory', on: !!cfg.get('memory') },
            { key: 'learning', label: 'Learning', on: !!cfg.get('learning') },
            { key: 'sessionLearning', label: 'Session Learning', on: !!cfg.get('sessionLearning') },
            { key: 'agentRouter', label: vscode_1.l10n.t('Smart Routing'), on: !!cfg.get('agentRouter') },
            { key: 'kanban', label: vscode_1.l10n.t('Agent Kanban'), on: !!cfg.get('kanban') },
            { key: 'arena', label: vscode_1.l10n.t('Arena Compare'), on: !!cfg.get('arena') },
            { key: 'spec', label: vscode_1.l10n.t('Spec Workflow'), on: !!cfg.get('spec') },
            { key: 'contextInjection', label: vscode_1.l10n.t('Context Injection'), on: !!cfg.get('contextInjection') },
        ],
        contextPreview: (0, contextIntelligence_1.getAssembledContext)(contextIntelligence_1.HUB_PREVIEW_MAX_CHARS) || vscode_1.l10n.t('(Wiki + Memory context will be generated automatically when a workspace is opened — run "Kodrix: Refresh Agent Context" to trigger it manually)'),
        recentLearning: [],
        workspaceName: folder?.name,
        learningTotal: learning.total,
        specCount: (0, specHelpers_1.listSpecSlugs)().length,
        kanbanCount: loadKanbanCount(),
        hasWiki: hasWiki(),
        sessionLearningProcessed: ss.processed,
    };
}
function pushDashboard(panel) {
    try {
        const dashboard = buildDashboard();
        dashboard.recentLearning = (0, learningEngine_1.getRecentLearning)(6).map(e => ({
            category: e.category,
            content: e.content.length > 90 ? e.content.slice(0, 90) + '…' : e.content,
            date: e.timestamp.slice(0, 10),
        }));
        panel.webview.postMessage({ type: 'dashboard', data: dashboard });
    }
    catch (err) {
        logger_1.logger.warn('[Kodrix Hub] pushDashboard failed', err);
    }
}
function getHtml(webview, extensionPath) {
    try {
        return (0, webviewHtml_1.loadWebviewHtml)(webview, extensionPath, 'kodrix-hub.html');
    }
    catch (err) {
        logger_1.logger.warn('[Kodrix Hub] 加载 HTML 资源失败', err);
        // 兜底页同样使用 nonce 策略（脚本维度不再放行 'unsafe-inline'）
        const nonce = (0, webviewHtml_1.createNonce)();
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${(0, webviewHtml_1.webviewCsp)(webview, nonce)}">
<title>Kodrix Hub</title>
<style>body{font-family:var(--vscode-font-family,sans-serif);background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);padding:24px}</style>
</head><body>
<h2>Kodrix Hub</h2>
<p>${vscode_1.l10n.t('Failed to load the resource file. Make sure the extension resources/kodrix-hub.html exists, then try again.')}</p>
<script nonce="${nonce}">acquireVsCodeApi().postMessage({command:'ready'});</script>
</body></html>`;
    }
}
async function handleScenario(id) {
    switch (id) {
        case 'idea':
            await vscode.commands.executeCommand('kodrix.idea.start');
            break;
        case 'spec':
            await vscode.commands.executeCommand('kodrix.spec.openWorkbench');
            break;
        case 'agent':
            await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
            break;
        case 'ask':
            await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'ask' });
            break;
        case 'router':
            await vscode.commands.executeCommand('kodrix.router.route');
            break;
        default:
            logger_1.logger.warn(`[Kodrix Hub] Unknown scenario: ${id}`);
    }
}
async function handleAction(id) {
    const map = {
        ideaCanvas: 'kodrix.idea.open',
        specWorkbench: 'kodrix.spec.openWorkbench',
        agentsWindow: 'kodrix.openAgentsWindow',
        chat: 'workbench.action.chat.open',
        agentMode: 'kodrix.openComposer',
        wiki: 'kodrix.wiki.open',
        kanban: 'kodrix.kanban.focus',
        learning: 'kodrix.learn.dashboard',
        arena: 'kodrix.arena.compare',
        providers: 'kodrix.openProviderWorkbench',
        refreshContext: 'kodrix.context.refresh',
        importCursor: 'kodrix.importCursor',
        rebuildWiki: 'kodrix.wiki.generate',
    };
    const cmd = map[id];
    if (cmd) {
        await vscode.commands.executeCommand(cmd);
        if (id === 'rebuildWiki') {
            vscode.window.showInformationMessage(vscode_1.l10n.t('Repo Wiki regenerated'));
        }
    }
}
/** Hub 面板允许切换的功能开关白名单（此前任意 key 都能从 webview 写进用户全局设置） */
const TOGGLEABLE_FEATURES = new Set([
    'wiki', 'spec', 'memory', 'kanban', 'agentRouter', 'arena', 'hooks', 'acp',
    'propertyTests', 'learning', 'contextInjection', 'sessionLearning',
    'codebaseIntelligence', 'codebaseQuery', 'predictiveCompletion', 'agentCrew',
    'vibeCoding', 'ideaFlow', 'terminalAI', 'semanticMemory', 'proactiveContext',
    'contextIntelligence',
]);
async function handleToggleFeature(featureKey) {
    if (!TOGGLEABLE_FEATURES.has(featureKey)) {
        logger_1.logger.warn(`[Kodrix Hub] 拒绝切换未在白名单内的功能开关：${featureKey}`);
        vscode.window.showWarningMessage(vscode_1.l10n.t('Unknown feature flag: {0}', featureKey));
        return;
    }
    const config = vscode.workspace.getConfiguration('kodrix.features');
    const current = config.get(featureKey);
    const newValue = !current;
    try {
        await config.update(featureKey, newValue, vscode.ConfigurationTarget.Global);
    }
    catch (err) {
        // 不能"写失败还报成功"：用户会以为开关生效了
        const message = err instanceof Error ? err.message : String(err);
        logger_1.logger.error(`[Kodrix Hub] 写入设置失败：kodrix.features.${featureKey}`, err);
        vscode.window.showErrorMessage(vscode_1.l10n.t('Failed to switch {0}: {1}', featureKey, message));
        return;
    }
    if (activePanel) {
        pushDashboard(activePanel);
    }
    vscode.window.showInformationMessage(vscode_1.l10n.t('{0}: {1}', newValue ? vscode_1.l10n.t('Enabled') : vscode_1.l10n.t('Disabled'), featureKey));
}
async function handleMessage(msg, panel) {
    switch (msg.command) {
        case 'ready':
            pushDashboard(panel);
            break;
        case 'quickRoute':
            if (msg.prompt?.trim()) {
                await (0, agentRouter_1.routeAndExecute)(msg.prompt.trim());
                pushDashboard(panel);
            }
            break;
        case 'detectIntent':
            if (msg.prompt?.trim()) {
                const route = (0, agentRouter_1.classifyIntent)(msg.prompt.trim());
                const labels = {
                    spec: vscode_1.l10n.t('Spec-Driven Development'),
                    plan: vscode_1.l10n.t('Plan first'),
                    agent: vscode_1.l10n.t('Multi-file Agent editing'),
                    ask: vscode_1.l10n.t('Explore Q&A'),
                    terminal: vscode_1.l10n.t('Terminal AI'),
                    wiki: 'Repo Wiki',
                    checkpoint: vscode_1.l10n.t('Checkpoint management'),
                    models: vscode_1.l10n.t('Model providers'),
                    settings: vscode_1.l10n.t('Kodrix Settings'),
                };
                panel.webview.postMessage({
                    type: 'intentResult',
                    label: labels[route.target],
                    reason: route.reason,
                    target: route.target,
                });
            }
            break;
        case 'scenario':
            if (msg.id) {
                await handleScenario(msg.id);
            }
            break;
        case 'action':
            if (msg.id) {
                await handleAction(msg.id);
                pushDashboard(panel);
            }
            break;
        case 'toggleFeature':
            if (msg.feature) {
                await handleToggleFeature(msg.feature);
            }
            break;
        default:
            logger_1.logger.warn(`[Kodrix Hub] Unknown message command: ${msg.command}`);
    }
}
async function openKodrixHub(context) {
    const column = vscode.ViewColumn.One;
    if (activePanel) {
        activePanel.reveal(column);
        pushDashboard(activePanel);
        return;
    }
    const panel = (0, panelTracker_1.createTrackedPanel)(context, 'kodrix.hub', 'Kodrix Hub', column, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
    });
    activePanel = panel;
    panel.iconPath = new vscode.ThemeIcon('hubot');
    panel.webview.html = getHtml(panel.webview, context.extensionPath);
    panel.webview.onDidReceiveMessage(msg => {
        void handleMessage(msg, panel);
    });
    panel.onDidDispose(() => {
        activePanel = undefined;
    });
    pushDashboard(panel);
}
function registerKodrixHub(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.hub.open', () => openKodrixHub(context)), (0, contextEvents_1.onContextChanged)(() => refreshHubIfOpen()));
}
function refreshHubIfOpen() {
    if (activePanel) {
        pushDashboard(activePanel);
    }
}
