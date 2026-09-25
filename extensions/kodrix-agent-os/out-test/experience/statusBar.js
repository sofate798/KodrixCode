"use strict";
/*---------------------------------------------------------------------------------------------
 *  Agent OS 状态栏 — 品牌指示器 + 上下文就绪 + 主动感知 + 路由历史
 *  （Windsurf / Cursor 大厂思维 · Kodrix 品牌升级版）
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
exports.updateStatusBar = updateStatusBar;
exports.registerStatusBar = registerStatusBar;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const contextIntelligence_1 = require("../context/contextIntelligence");
const contextEvents_1 = require("../context/contextEvents");
const kodrixEventBus_1 = require("../context/kodrixEventBus");
const proactiveContext_1 = require("../context/proactiveContext");
const agentRouter_1 = require("../router/agentRouter");
let brandStatusItem;
let contextStatusItem;
let routeStatusItem;
const TARGET_LABEL = {
    spec: 'Spec',
    plan: 'Plan',
    agent: 'Agent',
    ask: 'Ask',
};
/**
 * Brand colour palette — mirrors the CSS `--kodrix-brand-*` tokens defined
 * in `roundedCorners.css` and `2026-dark.json` so the status bar is consistent
 * with the workbench visual language.
 */
const BRAND = {
    primary: '#3994BC',
    secondary: '#58B3D9',
    accent: '#3DA8D4',
    success: '#73C991',
    warning: '#E5BA7D',
    error: '#F48771',
    info: '#58B3D9',
    muted: '#555555',
    text: '#BFBFBF',
    textSecondary: '#8C8C8C',
};
function computeBrandState(status) {
    if (!status.wikiOk && !status.memoryCount && !status.learningCount) {
        return {
            level: 'empty',
            dotColor: BRAND.muted,
            labelColor: undefined,
            icon: 'circle-outline',
            label: 'Kodrix',
        };
    }
    if (status.wikiOk && status.learningCount > 0) {
        return {
            level: 'ready',
            dotColor: BRAND.success,
            labelColor: undefined,
            icon: 'pass-filled',
            label: 'Kodrix',
        };
    }
    if (status.wikiOk || status.memoryCount > 0) {
        return {
            level: 'partial',
            dotColor: BRAND.primary,
            labelColor: undefined,
            icon: 'sync',
            label: 'Kodrix',
        };
    }
    // Fallback — context exists but not yet fully ready.
    return {
        level: 'partial',
        dotColor: BRAND.warning,
        labelColor: undefined,
        icon: 'circle-outline',
        label: 'Kodrix',
    };
}
function updateStatusBar() {
    if (!brandStatusItem || !contextStatusItem) {
        return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        brandStatusItem.hide();
        contextStatusItem.hide();
        routeStatusItem?.hide();
        return;
    }
    const status = (0, contextIntelligence_1.getContextStatus)();
    const fileHint = (0, proactiveContext_1.getLastFileContextHint)();
    const lastRoute = (0, agentRouter_1.getLastRoute)();
    const brandState = computeBrandState(status);
    // ── Brand indicator (leftmost, highest priority) ──
    const dotGlyph = '●'; // U+25CF filled circle — consistent across platforms
    brandStatusItem.text = `$(${brandState.icon}) ${dotGlyph} Kodrix`;
    brandStatusItem.color = brandState.dotColor;
    const statusParts = [];
    if (status.wikiOk)
        statusParts.push('Wiki 就绪');
    if (status.memoryCount > 0)
        statusParts.push(`Memory ${status.memoryCount}条`);
    if (status.learningCount > 0)
        statusParts.push(`Learning ${status.learningCount}条`);
    if (status.semanticVectors > 0)
        statusParts.push(`语义索引 ${status.semanticVectors}向量`);
    brandStatusItem.tooltip = new vscode.MarkdownString(`### $(hubot) Kodrix Agent OS 指挥中心\n\n`
        + (statusParts.length
            ? statusParts.map(p => `- ${p}`).join('\n') + '\n\n'
            : '*(未初始化)* 运行 **Kodrix: 生成 Repo Wiki** 以开始。\n\n')
        + `[打开 Hub](command:kodrix.hub.open) · \`Ctrl+Shift+H\``
        + `  \n[刷新上下文](command:kodrix.context.refresh)`);
    brandStatusItem.backgroundColor = brandState.level === 'ready'
        ? new vscode.ThemeColor('statusBarItem.prominentBackground')
        : undefined;
    brandStatusItem.show();
    // ── Context + proactive hint ──
    const level = brandState.level;
    const levelLabel = level === 'ready' ? '上下文就绪'
        : level === 'partial' ? '上下文部分'
            : level === 'error' ? '上下文错误'
                : '待预热';
    const levelIcon = level === 'ready' ? '$(pass-filled)'
        : level === 'partial' ? '$(circle-outline)'
            : level === 'error' ? '$(error)'
                : '$(warning)';
    let contextText = `${levelIcon} ${levelLabel}`;
    if (fileHint?.relevantCount) {
        contextText += ` $(lightbulb) ${fileHint.relevantCount}`;
    }
    contextStatusItem.text = contextText;
    const tooltipLines = [
        '**Agent 上下文 Intelligence**',
        '',
        `${levelLabel} — Wiki + Memory + Learning + Semantic`,
    ];
    if (fileHint?.relevantCount) {
        tooltipLines.push('', `**当前文件相关记忆** (${fileHint.fileName})`);
        tooltipLines.push(`- ${fileHint.relevantCount} 条匹配`);
        if (fileHint.topMatch) {
            tooltipLines.push(`- ${fileHint.topMatch}…`);
        }
    }
    tooltipLines.push('', '刷新: `Kodrix: 刷新 Agent 上下文`');
    contextStatusItem.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
    contextStatusItem.show();
    // ── Last route ──
    if (routeStatusItem) {
        if (lastRoute) {
            const label = TARGET_LABEL[lastRoute.target] ?? lastRoute.target;
            routeStatusItem.text = `$(arrow-swap) ${label}`;
            routeStatusItem.tooltip = new vscode.MarkdownString(`**上次智能路由**\n\n`
                + `- 模式: **${label}**\n`
                + `- 原因: ${lastRoute.reason}\n`
                + `- 输入: ${lastRoute.prompt.slice(0, 80)}…\n\n`
                + `点击重复上次路由 · \`Kodrix: 重复上次路由\``);
            routeStatusItem.show();
        }
        else {
            routeStatusItem.hide();
        }
    }
}
/**
 * Periodically refreshes the status bar to keep the brand indicator in sync
 * with real-time context changes (e.g. wiki generation in background).
 * Runs every 30 seconds; the interval is cleared on extension deactivation.
 */
let brandRefreshInterval;
function registerStatusBar(context) {
    // Brand indicator — leftmost, anchors the Kodrix identity.
    brandStatusItem = vscode.window.createStatusBarItem('kodrix.brand', vscode.StatusBarAlignment.Left, 50);
    brandStatusItem.name = 'Kodrix';
    brandStatusItem.command = 'kodrix.hub.open';
    brandStatusItem.accessibilityInformation = {
        label: vscode_1.l10n.t('Kodrix — 打开 Agent 指挥中心'),
    };
    // Context readiness — second from left.
    contextStatusItem = vscode.window.createStatusBarItem('kodrix.context', vscode.StatusBarAlignment.Left, 49);
    contextStatusItem.name = 'Kodrix Agent Context';
    contextStatusItem.command = 'kodrix.context.status';
    contextStatusItem.accessibilityInformation = {
        label: vscode_1.l10n.t('Agent 上下文状态'),
    };
    // Last route — third from left.
    routeStatusItem = vscode.window.createStatusBarItem('kodrix.route', vscode.StatusBarAlignment.Left, 48);
    routeStatusItem.name = 'Kodrix Last Route';
    routeStatusItem.command = 'kodrix.router.repeatLast';
    routeStatusItem.accessibilityInformation = {
        label: vscode_1.l10n.t('上次智能路由'),
    };
    context.subscriptions.push(brandStatusItem, contextStatusItem, routeStatusItem, (0, contextEvents_1.onContextChanged)(() => updateStatusBar()), (0, kodrixEventBus_1.onKodrixEvent)(e => {
        if (e.type === 'router.executed'
            || e.type === 'file.focused'
            || e.type === 'learning.recorded'
            || e.type === 'context.changed'
            || e.type === 'agent.stateChanged') {
            updateStatusBar();
        }
    }), vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatusBar()), vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('kodrix.features')) {
            updateStatusBar();
        }
    }));
    // Initial update after a short delay (wait for context warmup).
    const initTimer = setTimeout(() => updateStatusBar(), 1500);
    context.subscriptions.push({ dispose: () => clearTimeout(initTimer) });
    // Periodic refresh for live brand dot state.
    brandRefreshInterval = setInterval(() => updateStatusBar(), 30000);
    context.subscriptions.push({
        dispose: () => {
            if (brandRefreshInterval) {
                clearInterval(brandRefreshInterval);
                brandRefreshInterval = undefined;
            }
        },
    });
}
