"use strict";
/*---------------------------------------------------------------------------------------------
 *  Proactive Context — 打开文件时主动提示相关 Memory / Learning（对标 Cursor 隐式上下文）
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
exports.analyzeFileContext = analyzeFileContext;
exports.getLastFileContextHint = getLastFileContextHint;
exports.registerProactiveContext = registerProactiveContext;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const kodrixEventBus_1 = require("./kodrixEventBus");
const semanticMemory_1 = require("../learning/semanticMemory");
let lastHint;
let debounceTimer;
function buildFileQuery(filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    const dir = path.basename(path.dirname(filePath));
    const segments = filePath.replace(/\\/g, '/').split('/').slice(-3);
    return [base, dir, ...segments].join(' ');
}
function analyzeFileContext(filePath) {
    const fileName = path.basename(filePath);
    const query = buildFileQuery(filePath);
    const results = (0, semanticMemory_1.searchSimilar)(query, 3);
    return {
        filePath,
        fileName,
        relevantCount: results.length,
        topMatch: results[0]?.entry.content.slice(0, 80),
        topScore: results[0]?.score,
    };
}
function getLastFileContextHint() {
    return lastHint;
}
function handleActiveEditor(editor) {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('proactiveContext', true);
    if (!enabled || !editor?.document.uri.fsPath) {
        lastHint = undefined;
        return;
    }
    const filePath = editor.document.uri.fsPath;
    if (editor.document.uri.scheme !== 'file') {
        return;
    }
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        const hint = analyzeFileContext(filePath);
        lastHint = hint.relevantCount > 0 && (hint.topScore ?? 0) > 0.08 ? hint : undefined;
        (0, kodrixEventBus_1.emitKodrixEvent)({
            type: 'file.focused',
            filePath,
            relevantCount: hint.relevantCount,
        });
    }, 300);
}
function registerProactiveContext(context) {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(handleActiveEditor));
    if (vscode.window.activeTextEditor) {
        handleActiveEditor(vscode.window.activeTextEditor);
    }
}
