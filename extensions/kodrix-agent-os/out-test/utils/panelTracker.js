"use strict";
/*---------------------------------------------------------------------------------------------
 *  Panel Tracker — 统一管理所有 Webview Panel 的生命周期
 *
 *  在 deactivate() 中调用 disposeAllTrackedPanels() 可确保所有面板被正确清理，
 *  防止 VS Code 扩展停用后出现孤立 Webview 进程。
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
exports.trackPanel = trackPanel;
exports.createTrackedPanel = createTrackedPanel;
exports.getTrackedPanelCount = getTrackedPanelCount;
exports.disposeAllTrackedPanels = disposeAllTrackedPanels;
const vscode = __importStar(require("vscode"));
const _trackedPanels = new Set();
/**
 * 注册一个 WebviewPanel 到全局追踪器。
 * 面板被 dispose 时自动从追踪列表中移除。
 */
function trackPanel(panel) {
    _trackedPanels.add(panel);
    panel.onDidDispose(() => {
        _trackedPanels.delete(panel);
    });
}
/**
 * 创建一个 WebviewPanel 并自动追踪其生命周期。
 * 面板会被加入 context.subscriptions 以及全局追踪器，
 * 确保扩展停用或工作区关闭时被正确清理。
 */
function createTrackedPanel(context, viewType, title, showOptions, options) {
    const panel = vscode.window.createWebviewPanel(viewType, title, showOptions, options);
    trackPanel(panel);
    context.subscriptions.push(panel);
    return panel;
}
/**
 * 返回当前所有存活的面板数量。
 */
function getTrackedPanelCount() {
    return _trackedPanels.size;
}
/**
 * Dispose 所有被追踪的 Webview Panel。
 * 应在扩展 deactivate() 中调用。
 */
function disposeAllTrackedPanels() {
    for (const panel of _trackedPanels) {
        try {
            panel.dispose();
        }
        catch {
            // Ignore errors during cleanup
        }
    }
    _trackedPanels.clear();
}
