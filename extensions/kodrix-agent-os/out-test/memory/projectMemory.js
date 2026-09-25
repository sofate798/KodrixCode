"use strict";
/*---------------------------------------------------------------------------------------------
 *  跨会话 Memory — Windsurf Memories 风格
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
exports.appendMemoryEntry = appendMemoryEntry;
exports.showMemory = showMemory;
exports.captureMemoryFromSelection = captureMemoryFromSelection;
exports.injectMemoryIntoInstructions = injectMemoryIntoInstructions;
exports.registerMemory = registerMemory;
exports.getMemoryContext = getMemoryContext;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const instructionRegistry_1 = require("../context/instructionRegistry");
const contextEvents_1 = require("../context/contextEvents");
const learningEngine_1 = require("../learning/learningEngine");
const memoryHelpers_1 = require("./memoryHelpers");
const paths_1 = require("../paths");
/** 跨平台路径规范化：Windows 大小写不敏感，统一小写比较 */
function normalizePathForCompare(p) {
    const forward = p.replace(/\\/g, '/');
    return process.platform === 'win32' ? forward.toLowerCase() : forward;
}
function appendMemoryEntry(text) {
    (0, memoryHelpers_1.persistMemoryAppend)(text);
    (0, learningEngine_1.syncProjectInstructionsFile)();
    (0, contextEvents_1.notifyContextChanged)();
}
async function showMemory() {
    const memPath = (0, memoryHelpers_1.ensureMemoryFile)();
    const doc = await vscode.workspace.openTextDocument(memPath);
    await vscode.window.showTextDocument(doc);
}
async function captureMemoryFromSelection() {
    const editor = vscode.window.activeTextEditor;
    const selection = editor?.document.getText(editor.selection);
    const input = selection || await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('输入要记住的项目知识（架构、约定、陷阱等）'),
        placeHolder: vscode_1.l10n.t('此项目使用 pnpm，测试框架为 vitest'),
    });
    if (!input?.trim()) {
        return;
    }
    appendMemoryEntry(input.trim());
    if (vscode.workspace.getConfiguration('kodrix.features').get('learning', true)) {
        // 不强制 category，交由 recordLearning 按内容推断（inferLearningCategory）
        (0, learningEngine_1.recordLearning)(input.trim(), { source: 'capture' });
    }
    vscode.window.showInformationMessage(vscode_1.l10n.t('已写入项目 Memory 并同步到 Agent 上下文'));
}
async function injectMemoryIntoInstructions() {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('memory', true);
    if (!enabled) {
        return;
    }
    (0, learningEngine_1.syncProjectInstructionsFile)();
    await (0, instructionRegistry_1.registerInstructionFolders)();
}
function registerMemory(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.memory.show', () => showMemory()), vscode.commands.registerCommand('kodrix.memory.capture', () => captureMemoryFromSelection()));
    const memoryEnabled = vscode.workspace.getConfiguration('kodrix.features').get('memory', true);
    if (memoryEnabled) {
        const memPathNorm = normalizePathForCompare((0, paths_1.getMemoryPath)());
        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
            if (normalizePathForCompare(doc.uri.fsPath) === memPathNorm) {
                (0, learningEngine_1.syncProjectInstructionsFile)();
                (0, contextEvents_1.notifyContextChanged)();
            }
        }));
        (0, paths_1.ensureDir)(path.join((0, paths_1.getKodrixDir)(), 'memory'));
        const injectTimer = setTimeout(() => {
            void injectMemoryIntoInstructions();
        }, 3000);
        context.subscriptions.push({ dispose: () => clearTimeout(injectTimer) });
    }
}
function getMemoryContext() {
    try {
        return (0, memoryHelpers_1.readMemoryContent)().slice(0, 2000);
    }
    catch {
        return '';
    }
}
