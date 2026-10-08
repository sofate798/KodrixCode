/*---------------------------------------------------------------------------------------------
 *  Memory 读写辅助 — 避免与 Learning Engine 循环依赖
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { ensureDir, getMemoryDir, getMemoryPath } from '../paths';
import { atomicWriteFileSync } from '../utils/fsSafe';
import { readUserTextFileSync } from '../utils/textFile';

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
 * Memory 初始模板（仅用于"首次写入"与"在编辑器中打开"这类显式创建场景）。
 * 注意：不要把它当作"读取结果"返回 —— 模板里的示例文本会被当成真实项目记忆注入 prompt，
 * 并被 learningEngine 固化成 Agent 指令（曾出现"从没沉淀过知识，Agent 却收到示例偏好"）。
 */
export function getMemoryTemplate(): string {
	return DEFAULT_MEMORY;
}

/**
 * 只读读取 Memory 内容。**文件不存在时返回空串**（不写盘、也不返回模板）：
 * 让"项目 Memory 为空"这个状态能被上层如实判断并给出引导。
 */
export function readMemoryContent(): string {
	const memPath = getMemoryPath();
	if (!fs.existsSync(memPath)) {
		return '';
	}
	// 容错 BOM / UTF-16 / GBK，且读失败返回空串而不是抛错：
	// memory.md 是用户直接用编辑器改的文件，一次读失败不应把整条上下文组装链路带崩
	return readUserTextFileSync(memPath) ?? '';
}

/**
 * 确保 memory.md 存在（用于需要真实文件的场景，如在编辑器中打开）。
 * 返回文件路径。
 */
export function ensureMemoryFile(): string {
	const memPath = getMemoryPath();
	if (!fs.existsSync(memPath)) {
		ensureDir(getMemoryDir());
		atomicWriteFileSync(memPath, getMemoryTemplate());
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
	// 首次沉淀：以模板为底（保证章节结构完整），而不是从空白文件开始
	const current = readMemoryContent() || getMemoryTemplate();

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
