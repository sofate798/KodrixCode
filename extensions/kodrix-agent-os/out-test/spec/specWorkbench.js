"use strict";
/*---------------------------------------------------------------------------------------------
 *  Spec 三栏工作台 — Kiro Spec Editor 风格
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
exports.notifySpecUpdated = notifySpecUpdated;
exports.openSpecWorkbench = openSpecWorkbench;
exports.registerSpecWorkbench = registerSpecWorkbench;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const specHelpers_1 = require("./specHelpers");
const learningEngine_1 = require("../learning/learningEngine");
const panelTracker_1 = require("../utils/panelTracker");
const webviewHtml_1 = require("../shared/webviewHtml");
let activePanel;
let currentSlug;
let specWatcher;
function getHtml(webview, extensionPath) {
    return (0, webviewHtml_1.loadWebviewHtml)(webview, extensionPath, 'spec-workbench.html');
}
function pushSpecList(panel, selected) {
    panel.webview.postMessage({
        type: 'specList',
        slugs: (0, specHelpers_1.listSpecSlugs)(),
        selected: selected || currentSlug || '',
    });
}
function pushSpecContent(panel, slug) {
    const bundle = (0, specHelpers_1.readSpecBundle)(slug);
    panel.webview.postMessage({
        type: 'specContent',
        requirements: bundle.requirements,
        design: bundle.design,
        tasks: bundle.tasks,
    });
}
function setupSpecWatcher(panel, _context) {
    // 复用单一 watcher：切换 Spec 时先销毁旧 watcher，避免监听器在 subscriptions 中累积泄漏。
    // 面板 dispose 时会一并销毁（见 openSpecWorkbench 的 onDidDispose）。
    specWatcher?.dispose();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !currentSlug) {
        return;
    }
    const pattern = new vscode.RelativePattern(folder, `.kodrix/specs/${currentSlug}/**`);
    specWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = () => {
        if (currentSlug) {
            pushSpecContent(panel, currentSlug);
        }
    };
    specWatcher.onDidChange(refresh);
    specWatcher.onDidCreate(refresh);
    specWatcher.onDidDelete(refresh);
}
async function createSpecFromWorkbench() {
    const feature = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('功能名称'),
        placeHolder: 'user-authentication',
    });
    if (!feature) {
        return undefined;
    }
    const description = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('简要描述'),
    }) || '（待补充）';
    const specDir = await (0, specHelpers_1.createSpecFiles)(feature, description);
    if (specDir) {
        await (0, learningEngine_1.recordLearning)(`新建 Spec：${feature}（${(0, specHelpers_1.slugify)(feature)}）`, { source: 'spec', category: 'architecture' });
    }
    return specDir;
}
async function handleMessage(msg, panel, context) {
    switch (msg.command) {
        case 'ready':
        case 'refresh':
            pushSpecList(panel, currentSlug);
            if (currentSlug) {
                pushSpecContent(panel, currentSlug);
            }
            break;
        case 'selectSpec':
            // 校验 slug 必须是已存在的 Spec，拒绝来自 Webview 的任意路径段
            if (msg.slug && (0, specHelpers_1.listSpecSlugs)().includes(msg.slug)) {
                currentSlug = msg.slug;
                pushSpecContent(panel, currentSlug);
                setupSpecWatcher(panel, context);
            }
            break;
        case 'editFile':
            // 校验 file 必须是受支持的三件套之一，避免任意文件路径
            if (currentSlug && msg.file && specHelpers_1.SPEC_FILES.includes(msg.file)) {
                await (0, specHelpers_1.openSpecFile)(currentSlug, msg.file);
            }
            break;
        case 'newSpec': {
            const dir = await createSpecFromWorkbench();
            if (dir) {
                currentSlug = path.basename(dir);
                pushSpecList(panel, currentSlug);
                pushSpecContent(panel, currentSlug);
                setupSpecWatcher(panel, context);
            }
            break;
        }
        case 'implement': {
            if (!currentSlug) {
                vscode.window.showWarningMessage(vscode_1.l10n.t('请先选择 Spec'));
                break;
            }
            const dir = (0, specHelpers_1.getSpecDir)(currentSlug);
            if (dir) {
                await (0, specHelpers_1.launchSpecImplementation)(dir);
            }
            break;
        }
    }
}
function notifySpecUpdated(slug) {
    if (activePanel && currentSlug === slug) {
        pushSpecContent(activePanel, slug);
    }
}
async function openSpecWorkbench(context, slug) {
    const column = vscode.ViewColumn.Beside;
    if (activePanel) {
        activePanel.reveal(column);
        if (slug) {
            currentSlug = slug;
            pushSpecList(activePanel, slug);
            pushSpecContent(activePanel, slug);
            setupSpecWatcher(activePanel, context);
        }
        return;
    }
    const panel = (0, panelTracker_1.createTrackedPanel)(context, 'kodrix.specWorkbench', 'Spec Editor', column, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
    });
    activePanel = panel;
    currentSlug = slug || (0, specHelpers_1.listSpecSlugs)()[0];
    panel.webview.html = getHtml(panel.webview, context.extensionPath);
    panel.webview.onDidReceiveMessage((m) => {
        handleMessage(m, panel, context).catch(err => vscode.window.showErrorMessage(vscode_1.l10n.t('Spec Workbench error: {0}', err instanceof Error ? err.message : String(err))));
    });
    panel.onDidDispose(() => {
        activePanel = undefined;
        currentSlug = undefined;
        specWatcher?.dispose();
        specWatcher = undefined;
    });
    if (currentSlug) {
        setupSpecWatcher(panel, context);
    }
    pushSpecList(panel, currentSlug);
    if (currentSlug) {
        pushSpecContent(panel, currentSlug);
    }
}
function registerSpecWorkbench(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.spec.openWorkbench', (slug) => openSpecWorkbench(context, slug)));
}
