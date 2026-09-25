"use strict";
/*---------------------------------------------------------------------------------------------
 *  Instructions 路径注册 — 供 Wiki / Memory / Context 共享
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
exports.mergeInstructionLocation = mergeInstructionLocation;
exports.registerInstructionFolders = registerInstructionFolders;
exports.writeWikiInstructionsFile = writeWikiInstructionsFile;
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
const learningEngine_1 = require("../learning/learningEngine");
const paths_1 = require("../paths");
function pathJoin(a, b) {
    return `${a.replace(/[/\\]+$/, '')}/${b}`;
}
async function mergeInstructionLocation(locationKey, enabled = true) {
    const key = locationKey.replace(/\\/g, '/');
    const existing = vscode.workspace.getConfiguration('chat').get('instructionsFilesLocations') || {};
    if (existing[key] === enabled) {
        return;
    }
    await vscode.workspace.getConfiguration('chat').update('instructionsFilesLocations', { ...existing, [key]: enabled }, vscode.ConfigurationTarget.Global);
}
async function registerInstructionFolders() {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('contextInjection', true);
    if (!enabled) {
        return;
    }
    (0, paths_1.ensureDir)((0, paths_1.getGlobalInstructionsDir)());
    await mergeInstructionLocation((0, paths_1.getGlobalInstructionsLocationKey)());
    const wsInstructions = (0, paths_1.getWorkspaceInstructionsDir)();
    if (wsInstructions) {
        (0, paths_1.ensureDir)(wsInstructions);
        await mergeInstructionLocation((0, paths_1.getWorkspaceInstructionsLocationKey)());
    }
    (0, paths_1.ensureDir)((0, paths_1.getMemoryDir)());
    (0, learningEngine_1.syncProjectInstructionsFile)();
    await mergeInstructionLocation((0, paths_1.getMemoryInstructionLocationKey)());
    const wikiDir = (0, paths_1.getWikiDir)();
    if (wikiDir && fs.existsSync(wikiDir)) {
        await mergeInstructionLocation((0, paths_1.getWikiInstructionLocationKey)());
    }
}
const WIKI_INSTRUCTIONS_FRONTMATTER = `---
applyTo: '**'
description: Repo Wiki 架构摘要（Kodrix Agent OS 自动生成）
---

`;
function writeWikiInstructionsFile() {
    const wikiDir = (0, paths_1.getWikiDir)();
    const outPath = (0, paths_1.getWikiInstructionsPath)();
    if (!wikiDir || !outPath || !fs.existsSync(pathJoin(wikiDir, 'ARCHITECTURE.md'))) {
        return;
    }
    const arch = fs.readFileSync(pathJoin(wikiDir, 'ARCHITECTURE.md'), 'utf-8').slice(0, 2500);
    const modules = fs.existsSync(pathJoin(wikiDir, 'MODULES.md'))
        ? fs.readFileSync(pathJoin(wikiDir, 'MODULES.md'), 'utf-8').slice(0, 1500)
        : '';
    const body = `${WIKI_INSTRUCTIONS_FRONTMATTER}# Repo Wiki 上下文（自动注入）

> Qoder 风格 Repo Wiki · 由 Kodrix Agent OS 维护

## 架构摘要

${arch}

${modules ? `\n## 模块摘要\n\n${modules}` : ''}

## 使用方式

- 详细文档见 \`.kodrix/wiki/\`
- 重新生成：\`Kodrix: 生成 Repo Wiki\`
`;
    (0, paths_1.ensureDir)(wikiDir);
    fs.writeFileSync(outPath, body, 'utf-8');
}
