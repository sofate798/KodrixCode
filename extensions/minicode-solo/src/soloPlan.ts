/*---------------------------------------------------------------------------------------------
 *  SOLO 规划持久化 — 工作台与 @solo 共享
 *
 *  大厂工程化标准：
 *   1. 所有常量统一从 constants.ts 引用
 *   2. readSoloPlan 返回 { content, exists } 区分"不存在"和"读取失败"
 *   3. 共用原子写入逻辑，消除代码重复
 *   4. 文件操作有 try/catch 守卫，非关键路径不中断主流程
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	SOLO_SUBDIR,
	LAST_PLAN_FILENAME,
	SOLO_INSTRUCTIONS_FILENAME,
	SOLO_PLAN_TRUNCATE_CHARS,
	SOLO_BUILD_CONFIRM_THRESHOLD,
	BUILD_CONFIRM_RE,
	SOLO_INSTRUCTIONS_FRONTMATTER,
} from './constants';

// ── 原子写入工具 ────────────────────────────────────────────────────

/**
 * 原子写入文件：先写入临时文件再 rename，避免写入过程中读取到不完整数据。
 * 非关键路径异常静默吞咽，调用方无需 try/catch。
 */
function atomicWriteFile(destPath: string, content: string): void {
	try {
		const tmpPath = destPath + '.tmp';
		fs.mkdirSync(path.dirname(destPath), { recursive: true });
		fs.writeFileSync(tmpPath, content, 'utf-8');
		fs.renameSync(tmpPath, destPath);
	} catch {
		// 非关键路径，写入失败不中断主流程
	}
}

// ── 路径工具 ────────────────────────────────────────────────────────

export function getSoloPlanDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return path.join(folder.uri.fsPath, '.minicode', SOLO_SUBDIR);
}

export function getSoloPlanPath(): string | undefined {
	const dir = getSoloPlanDir();
	return dir ? path.join(dir, LAST_PLAN_FILENAME) : undefined;
}

export function getSoloInstructionsPath(): string | undefined {
	const dir = getSoloPlanDir();
	return dir ? path.join(dir, SOLO_INSTRUCTIONS_FILENAME) : undefined;
}

// ── 读取规划 ────────────────────────────────────────────────────────

/**
 * 读取已保存的 SOLO 规划。
 *
 * @returns { content, exists } — 调用方可区分"文件不存在"和"读取失败"两种场景。
 */
export function readSoloPlan(): { content: string; exists: boolean } {
	const planPath = getSoloPlanPath();
	if (!planPath) return { content: '', exists: false };
	if (!fs.existsSync(planPath)) return { content: '', exists: false };
	try {
		return { content: fs.readFileSync(planPath, 'utf-8'), exists: true };
	} catch {
		return { content: '', exists: false };
	}
}

/**
 * @deprecated 使用 readSoloPlan() 获取结构化结果。
 */
export function readSoloPlanRaw(): string {
	return readSoloPlan().content;
}

// ── 写入 ────────────────────────────────────────────────────────────

function writeSoloInstructions(planContent: string, userPrompt: string): void {
	const outPath = getSoloInstructionsPath();
	if (!outPath) return;
	const summary = planContent.trim().slice(0, SOLO_PLAN_TRUNCATE_CHARS);
	const body = `${SOLO_INSTRUCTIONS_FRONTMATTER}# SOLO 规划上下文


> 需求摘要 · ${new Date().toISOString().slice(0, 10)}

## 用户需求

${userPrompt}

## 规划摘要

${summary || '（空）'}

完整规划见 \`last-plan.md\`。
`;
	atomicWriteFile(outPath, body);
}

export function persistSoloPlan(planContent: string, userPrompt: string): void {
	const dir = getSoloPlanDir();
	if (!dir || !planContent.trim()) {
		return;
	}
	const body = `# SOLO Plan

> ${new Date().toISOString()}

## 需求

${userPrompt}

## 规划

${planContent}

---
*工作台与 Agent 通过 \`.minicode/solo/last-plan.md\` 共享上下文。*
`;
	const destPath = path.join(dir, LAST_PLAN_FILENAME);
	atomicWriteFile(destPath, body);
	writeSoloInstructions(planContent, userPrompt);
}

export async function openSoloPlanDocument(): Promise<void> {
	const planPath = getSoloPlanPath();
	if (!planPath || !fs.existsSync(planPath)) {
		vscode.window.showWarningMessage('尚无 SOLO 规划。请先在 Chat 中使用 @solo 生成规划。');
		return;
	}
	const doc = await vscode.workspace.openTextDocument(planPath);
	await vscode.window.showTextDocument(doc, { preview: false });
}

// ── 构建上下文 ──────────────────────────────────────────────────────

/** 构建阶段合并已保存规划与用户输入 */
export function resolveSoloBuildContext(userPrompt: string): string {
	const { content: saved, exists } = readSoloPlan();
	if (!exists || !saved.trim()) {
		return userPrompt;
	}
	if (BUILD_CONFIRM_RE.test(userPrompt.trim()) && userPrompt.trim().length < SOLO_BUILD_CONFIRM_THRESHOLD) {
		return saved;
	}
	return `${saved}\n\n---\n\n用户补充：\n${userPrompt}`;
}
