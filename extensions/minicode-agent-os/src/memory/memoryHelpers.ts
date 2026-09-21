/*---------------------------------------------------------------------------------------------
 *  Memory 读写辅助 — 避免与 Learning Engine 循环依赖
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { ensureDir, getMemoryDir, getMemoryPath } from '../paths';
import { atomicWriteFileSync } from '../utils/fsSafe';

const DEFAULT_MEMORY = `# 项目 Memory

> Minicode 跨会话记忆 · 自动注入 Agent 上下文

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
export function readMemoryContent(): string {
	const memPath = getMemoryPath();
	if (!fs.existsSync(memPath)) {
		return DEFAULT_MEMORY;
	}
	return fs.readFileSync(memPath, 'utf-8');
}

/**
 * 确保 memory.md 存在（用于需要真实文件的场景，如在编辑器中打开）。
 * 返回文件路径。
 */
export function ensureMemoryFile(): string {
	const memPath = getMemoryPath();
	if (!fs.existsSync(memPath)) {
		ensureDir(getMemoryDir());
		atomicWriteFileSync(memPath, DEFAULT_MEMORY);
	}
	return memPath;
}

/** 将「## 捕获记录」章节头（行首）替换为带新条目的版本，仅匹配行首标题避免误伤正文 */
function insertUnderSection(content: string, sectionHeading: string, entry: string): string | undefined {
	// 使用锚定到行首的匹配，避免正文中出现同名文字时被错误替换
	const lines = content.split('\n');
	const idx = lines.findIndex(l => l.trimEnd() === sectionHeading);
	if (idx === -1) {
		return undefined;
	}
	lines.splice(idx + 1, 0, entry.replace(/^\n/, ''));
	return lines.join('\n');
}

export function appendMemoryBullet(text: string): string {
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

export function writeMemoryContentRaw(content: string): void {
	const memPath = getMemoryPath();
	ensureDir(getMemoryDir());
	atomicWriteFileSync(memPath, content);
}

export function persistMemoryAppend(text: string): void {
	writeMemoryContentRaw(appendMemoryBullet(text));
}
