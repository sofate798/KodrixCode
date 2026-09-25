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
let activePanel;
function loadKanbanCount() {
    const p = (0, paths_1.getKanbanPath)();
    if (!p || !fs.existsSync(p))
        return 0;
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
    if (!folder)
        return false;
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
            { key: 'ideaFlow', label: 'Idea Flow 想法→产品', on: !!cfg.get('ideaFlow') },
            { key: 'wiki', label: 'Repo Wiki', on: !!cfg.get('wiki') },
            { key: 'memory', label: 'Memory', on: !!cfg.get('memory') },
            { key: 'learning', label: 'Learning', on: !!cfg.get('learning') },
            { key: 'sessionLearning', label: 'Session Learning', on: !!cfg.get('sessionLearning') },
            { key: 'agentRouter', label: '智能路由', on: !!cfg.get('agentRouter') },
            { key: 'kanban', label: 'Agent 看板', on: !!cfg.get('kanban') },
            { key: 'arena', label: 'Arena 对比', on: !!cfg.get('arena') },
            { key: 'spec', label: 'Spec 工作流', on: !!cfg.get('spec') },
            { key: 'contextInjection', label: '上下文注入', on: !!cfg.get('contextInjection') },
        ],
        contextPreview: (0, contextIntelligence_1.getAssembledContext)(600) || '（打开工作区后将自动生成 Wiki + Memory 上下文——运行「Kodrix: 刷新 Agent 上下文」手动触发）',
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
        console.warn('[Kodrix Hub] pushDashboard failed', err);
    }
}
function getHtml(webview, extensionPath) {
    try {
        return (0, webviewHtml_1.loadWebviewHtml)(webview, extensionPath, 'kodrix-hub.html');
    }
    catch (err) {
        console.warn('[Kodrix Hub] 加载 HTML 资源失败', err);
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
<title>Kodrix Hub</title>
<style>body{font-family:var(--vscode-font-family,sans-serif);background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);padding:24px}</style>
</head><body>
<h2>Kodrix Hub</h2>
<p>资源文件加载失败。请确认扩展 resources/kodrix-hub.html 存在后重试。</p>
<script>acquireVsCodeApi().postMessage({command:'ready'});</script>
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
            console.warn(`[Kodrix Hub] Unknown scenario: ${id}`);
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
            vscode.window.showInformationMessage(vscode_1.l10n.t('Repo Wiki 已重新生成'));
        }
    }
}
async function handleToggleFeature(featureKey) {
    const config = vscode.workspace.getConfiguration('kodrix.features');
    const current = config.get(featureKey);
    const newValue = !current;
    await config.update(featureKey, newValue, vscode.ConfigurationTarget.Global);
    if (activePanel)
        pushDashboard(activePanel);
    vscode.window.showInformationMessage(vscode_1.l10n.t('{0}：{1}', newValue ? '已启用' : '已关闭', featureKey));
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
                    spec: 'Spec 驱动开发',
                    plan: 'Plan 先规划',
                    agent: 'Agent 多文件编辑',
                    ask: 'Ask 问答探索',
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
            if (msg.id)
                await handleScenario(msg.id);
            break;
        case 'action':
            if (msg.id) {
                await handleAction(msg.id);
                pushDashboard(panel);
            }
            break;
        case 'toggleFeature':
            if (msg.feature)
                await handleToggleFeature(msg.feature);
            break;
        default:
            console.warn(`[Kodrix Hub] Unknown message command: ${msg.command}`);
    }
}
async function openKodrixHub(context) {
    const column = vscode.ViewColumn.One;
    if (activePanel) {
        activePanel.reveal(column);
        pushDashboard(activePanel);
        return;
    }
    const panel = vscode.window.createWebviewPanel('kodrix.hub', 'Kodrix Hub', column, {
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
    if (activePanel)
        pushDashboard(activePanel);
}
