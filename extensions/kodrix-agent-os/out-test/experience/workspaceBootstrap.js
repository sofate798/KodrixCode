"use strict";
/*---------------------------------------------------------------------------------------------
 *  工作区自动预热 — 打开项目即就绪（Qoder Context Engine 思维）
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
exports.bootstrapWorkspace = bootstrapWorkspace;
exports.registerWorkspaceBootstrap = registerWorkspaceBootstrap;
exports.cancelBootstrapTimers = cancelBootstrapTimers;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const instructionRegistry_1 = require("../context/instructionRegistry");
const contextEvents_1 = require("../context/contextEvents");
const statusBar_1 = require("../experience/statusBar");
const repoWiki_1 = require("../wiki/repoWiki");
const learningEngine_1 = require("../learning/learningEngine");
const sessionLearning_1 = require("../learning/sessionLearning");
const BOOTSTRAP_KEY = 'kodrix.workspaceBootstrapped';
// 保存计时器句柄以便 deactivate 时取消
let wikiBuildTimer;
let tipTimer;
let bootTimer;
async function bootstrapWorkspace(context) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return;
    }
    const cfg = vscode.workspace.getConfiguration('kodrix');
    const autoBootstrap = cfg.get('experience.autoBootstrap', true);
    if (!autoBootstrap) {
        return;
    }
    const folderKey = folder.uri.fsPath;
    // 使用 Set 存储已预热路径（最多保留 50 个，防止无限增长）
    const MAX_BOOTSTRAPPED = 50;
    const bootstrappedRaw = context.workspaceState.get(BOOTSTRAP_KEY, []);
    const bootstrapped = new Set(bootstrappedRaw);
    const already = bootstrapped.has(folderKey);
    // Session Learning Hook（首次）
    if (vscode.workspace.getConfiguration('kodrix.features').get('sessionLearning', true)) {
        void (0, sessionLearning_1.installSessionLearningHook)(context, { silent: true });
    }
    // Instructions 注册（每次）
    try {
        await (0, instructionRegistry_1.registerInstructionFolders)();
        (0, learningEngine_1.syncProjectInstructionsFile)();
    }
    catch {
        // 非关键路径，失败不中断其余预热步骤
    }
    // 语义索引：learning 日志存在但向量缺失时自动重建
    try {
        const { rebuildIndex, getSemanticStats } = await Promise.resolve().then(() => __importStar(require('../learning/semanticMemory')));
        if (getSemanticStats().totalVectors === 0) {
            rebuildIndex();
        }
    }
    catch {
        // 非关键
    }
    // Wiki 自动生成（若缺失）
    const wikiIndex = path.join(folder.uri.fsPath, '.kodrix', 'wiki', 'INDEX.md');
    const wikiAuto = vscode.workspace.getConfiguration('kodrix.features').get('wikiAutoBuild', true);
    if (wikiAuto && !fs.existsSync(wikiIndex)) {
        wikiBuildTimer = setTimeout(() => {
            wikiBuildTimer = undefined;
            void (0, repoWiki_1.generateRepoWiki)({ recordLearning: false });
        }, 4000);
    }
    if (!already) {
        bootstrapped.add(folderKey);
        // 保持集合大小不超过上限，移除最旧的条目
        const updated = Array.from(bootstrapped).slice(-MAX_BOOTSTRAPPED);
        await context.workspaceState.update(BOOTSTRAP_KEY, updated);
        // 首次打开工作区：轻量提示
        const showTip = cfg.get('experience.showBootstrapTip', true);
        if (showTip) {
            tipTimer = setTimeout(() => {
                tipTimer = undefined;
                void vscode.window.showInformationMessage('Kodrix 已为当前工作区预热 Agent 上下文（Wiki · Memory · Learning）', '打开 Hub', '智能路由').then(choice => {
                    if (choice === '打开 Hub') {
                        void vscode.commands.executeCommand('kodrix.hub.open');
                    }
                    else if (choice === '智能路由') {
                        void vscode.commands.executeCommand('kodrix.router.route');
                    }
                });
            }, 6000);
        }
    }
    (0, contextEvents_1.notifyContextChanged)();
    (0, statusBar_1.updateStatusBar)();
}
function registerWorkspaceBootstrap(context) {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void bootstrapWorkspace(context);
    }));
    if (vscode.workspace.workspaceFolders?.length) {
        bootTimer = setTimeout(() => {
            bootTimer = undefined;
            void bootstrapWorkspace(context);
        }, 2500);
    }
}
/** 取消所有 Bootstrap 延迟任务（在 deactivate 时调用） */
function cancelBootstrapTimers() {
    if (wikiBuildTimer) {
        clearTimeout(wikiBuildTimer);
        wikiBuildTimer = undefined;
    }
    if (tipTimer) {
        clearTimeout(tipTimer);
        tipTimer = undefined;
    }
    if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = undefined;
    }
}
