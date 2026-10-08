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
exports.unregisterInstructionFolders = unregisterInstructionFolders;
exports.registerInstructionFolders = registerInstructionFolders;
exports.writeWikiInstructionsFile = writeWikiInstructionsFile;
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
const learningEngine_1 = require("../learning/learningEngine");
const fsSafe_1 = require("../utils/fsSafe");
const textFile_1 = require("../utils/textFile");
const paths_1 = require("../paths");
function pathJoin(a, b) {
    return `${a.replace(/[/\\]+$/, '')}/${b}`;
}
/**
 * 指令位置应写入的作用域：
 * 有工作区时写 **Workspace**（这些位置指向工作区内的 `.kodrix/`，写进用户全局会让 A 工作区的
 * 路径在 B 工作区也生效，卸载后也残留）；没有工作区时才退回 Global（例如全局指令目录）。
 */
function instructionConfigTarget() {
    return vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}
async function mergeInstructionLocation(locationKey, enabled = true) {
    const key = locationKey.replace(/\\/g, '/');
    const existing = vscode.workspace.getConfiguration('chat').get('instructionsFilesLocations') || {};
    if (existing[key] === enabled) {
        return;
    }
    await vscode.workspace.getConfiguration('chat').update('instructionsFilesLocations', { ...existing, [key]: enabled }, instructionConfigTarget());
}
/** 关掉总开关时要撤销的 Kodrix 指令位置（否则 Chat 会继续把 Kodrix 文档当 instructions 吃 token） */
function kodrixInstructionLocationKeys() {
    return [
        (0, paths_1.getGlobalInstructionsLocationKey)(),
        (0, paths_1.getWorkspaceInstructionsLocationKey)(),
        (0, paths_1.getMemoryInstructionLocationKey)(),
        (0, paths_1.getWikiInstructionLocationKey)(),
    ].filter((k) => !!k);
}
/** 取消注册本扩展登记的全部指令位置（关闭注入 / 卸载时调用） */
async function unregisterInstructionFolders() {
    for (const key of kodrixInstructionLocationKeys()) {
        await mergeInstructionLocation(key, false);
    }
}
async function registerInstructionFolders() {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('contextInjection', true);
    if (!enabled) {
        // 关闭时不只是"不再注册"，还要把已登记的位置撤掉（曾经只 return，导致关了仍持续注入）
        await unregisterInstructionFolders();
        return;
    }
    (0, paths_1.ensureDir)((0, paths_1.getGlobalInstructionsDir)());
    await mergeInstructionLocation((0, paths_1.getGlobalInstructionsLocationKey)());
    const wsInstructions = (0, paths_1.getWorkspaceInstructionsDir)();
    if (wsInstructions) {
        (0, paths_1.ensureDir)(wsInstructions);
        await mergeInstructionLocation((0, paths_1.getWorkspaceInstructionsLocationKey)());
    }
    // Memory 层：受 kodrix.features.memory 控制；关闭时不写指令文件、也不登记该位置
    const memoryEnabled = vscode.workspace.getConfiguration('kodrix.features').get('memory', true);
    if (memoryEnabled) {
        (0, paths_1.ensureDir)((0, paths_1.getMemoryDir)());
        (0, learningEngine_1.syncProjectInstructionsFile)();
        await mergeInstructionLocation((0, paths_1.getMemoryInstructionLocationKey)());
    }
    else {
        await mergeInstructionLocation((0, paths_1.getMemoryInstructionLocationKey)(), false);
    }
    // Wiki 层：受 kodrix.features.wiki 控制
    const wikiEnabled = vscode.workspace.getConfiguration('kodrix.features').get('wiki', true);
    const wikiDir = (0, paths_1.getWikiDir)();
    if (wikiEnabled && wikiDir && fs.existsSync(wikiDir)) {
        await mergeInstructionLocation((0, paths_1.getWikiInstructionLocationKey)());
    }
    else {
        await mergeInstructionLocation((0, paths_1.getWikiInstructionLocationKey)(), false);
    }
}
const WIKI_INSTRUCTIONS_FRONTMATTER = `---
applyTo: '**'
description: Repo Wiki 架构摘要（Kodrix Agent OS 自动生成）
---

`;
function writeWikiInstructionsFile() {
    // Wiki 层关闭时不生成 wiki 指令文件（否则关掉 Wiki 仍会被当作 instructions 注入）
    if (vscode.workspace.getConfiguration('kodrix.features').get('wiki', true) === false) {
        return;
    }
    const wikiDir = (0, paths_1.getWikiDir)();
    const outPath = (0, paths_1.getWikiInstructionsPath)();
    if (!wikiDir || !outPath || !fs.existsSync(pathJoin(wikiDir, 'ARCHITECTURE.md'))) {
        return;
    }
    // 用户可编辑文档：容错 BOM/UTF-16/GBK，读失败按空串处理（不中断指令文件生成）
    const arch = ((0, textFile_1.readUserTextFileSync)(pathJoin(wikiDir, 'ARCHITECTURE.md')) ?? '').slice(0, 2500);
    const modules = fs.existsSync(pathJoin(wikiDir, 'MODULES.md'))
        ? ((0, textFile_1.readUserTextFileSync)(pathJoin(wikiDir, 'MODULES.md')) ?? '').slice(0, 1500)
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
    // 走统一原子写入（同时受"不受信任工作区禁止写工作区文件"闸门约束）
    (0, fsSafe_1.atomicWriteFileSync)(outPath, body);
}
