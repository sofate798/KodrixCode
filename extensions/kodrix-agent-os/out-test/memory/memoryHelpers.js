"use strict";
/*---------------------------------------------------------------------------------------------
 *  Memory 读写辅助 — 避免与 Learning Engine 循环依赖
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
exports.readMemoryContent = readMemoryContent;
exports.ensureMemoryFile = ensureMemoryFile;
exports.appendMemoryBullet = appendMemoryBullet;
exports.writeMemoryContentRaw = writeMemoryContentRaw;
exports.persistMemoryAppend = persistMemoryAppend;
const fs = __importStar(require("fs"));
const paths_1 = require("../paths");
const fsSafe_1 = require("../utils/fsSafe");
const DEFAULT_MEMORY = `# 项目 Memory

> Kodrix 跨会话记忆 · 自动注入 Agent 上下文

## 架构偏好

- （例：使用 TypeScript strict 模式）
- （例：React 函数组件 + hooks）

## 命名规范

- （例：文件名 kebab-case，组件 PascalCase）

## 常用库与模式

- （例：状态管理用 zustand，HTTP 用 fetch）

## 团队约定

- （例：commit 使用 Conventional Commits）

## 已知陷阱

- （例：此项目 API 需要 X-Custom-Header）
`;
/**
 * 只读读取 Memory 内容。文件不存在时返回默认模板但**不写盘**（避免读操作产生副作用）。
 * 首次写入由 appendMemoryBullet / writeMemoryContentRaw / ensureMemoryFile 显式完成。
 */
function readMemoryContent() {
    const memPath = (0, paths_1.getMemoryPath)();
    if (!fs.existsSync(memPath)) {
        return DEFAULT_MEMORY;
    }
    return fs.readFileSync(memPath, 'utf-8');
}
/**
 * 确保 memory.md 存在（用于需要真实文件的场景，如在编辑器中打开）。
 * 返回文件路径。
 */
function ensureMemoryFile() {
    const memPath = (0, paths_1.getMemoryPath)();
    if (!fs.existsSync(memPath)) {
        (0, paths_1.ensureDir)((0, paths_1.getMemoryDir)());
        (0, fsSafe_1.atomicWriteFileSync)(memPath, DEFAULT_MEMORY);
    }
    return memPath;
}
/** 将「## 捕获记录」章节头（行首）替换为带新条目的版本，仅匹配行首标题避免误伤正文 */
function insertUnderSection(content, sectionHeading, entry) {
    // 使用锚定到行首的匹配，避免正文中出现同名文字时被错误替换
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.trimEnd() === sectionHeading);
    if (idx === -1) {
        return undefined;
    }
    lines.splice(idx + 1, 0, entry.replace(/^\n/, ''));
    return lines.join('\n');
}
function appendMemoryBullet(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return readMemoryContent();
    }
    const entry = `- ${trimmed} _(${new Date().toISOString().slice(0, 10)})_`;
    const current = readMemoryContent();
    const underCapture = insertUnderSection(current, '## 捕获记录', entry);
    if (underCapture) {
        return underCapture;
    }
    const underTeam = insertUnderSection(current, '## 团队约定', entry);
    if (underTeam) {
        return underTeam;
    }
    return `${current}\n## 捕获记录\n${entry}\n`;
}
function writeMemoryContentRaw(content) {
    const memPath = (0, paths_1.getMemoryPath)();
    (0, paths_1.ensureDir)((0, paths_1.getMemoryDir)());
    (0, fsSafe_1.atomicWriteFileSync)(memPath, content);
}
function persistMemoryAppend(text) {
    writeMemoryContentRaw(appendMemoryBullet(text));
}
