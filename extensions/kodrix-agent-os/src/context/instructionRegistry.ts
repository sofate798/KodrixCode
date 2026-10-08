/*---------------------------------------------------------------------------------------------
 *  Instructions 路径注册 — 供 Wiki / Memory / Context 共享
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { syncProjectInstructionsFile } from '../learning/learningEngine';
import { atomicWriteFileSync } from '../utils/fsSafe';
import { readUserTextFileSync } from '../utils/textFile';
import {
	ensureDir,
	getGlobalInstructionsDir,
	getGlobalInstructionsLocationKey,
	getMemoryDir,
	getMemoryInstructionLocationKey,
	getWikiDir,
	getWikiInstructionLocationKey,
	getWikiInstructionsPath,
	getWorkspaceInstructionsDir,
	getWorkspaceInstructionsLocationKey,
} from '../paths';

function pathJoin(a: string, b: string): string {
	return `${a.replace(/[/\\]+$/, '')}/${b}`;
}

/**
 * 指令位置应写入的作用域：
 * 有工作区时写 **Workspace**（这些位置指向工作区内的 `.kodrix/`，写进用户全局会让 A 工作区的
 * 路径在 B 工作区也生效，卸载后也残留）；没有工作区时才退回 Global（例如全局指令目录）。
 */
function instructionConfigTarget(): vscode.ConfigurationTarget {
	return vscode.workspace.workspaceFolders?.length
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
}

export async function mergeInstructionLocation(locationKey: string, enabled = true): Promise<void> {
	const key = locationKey.replace(/\\/g, '/');
	const existing = vscode.workspace.getConfiguration('chat').get<Record<string, boolean>>('instructionsFilesLocations') || {};
	if (existing[key] === enabled) {
		return;
	}
	await vscode.workspace.getConfiguration('chat').update(
		'instructionsFilesLocations',
		{ ...existing, [key]: enabled },
		instructionConfigTarget(),
	);
}

/** 关掉总开关时要撤销的 Kodrix 指令位置（否则 Chat 会继续把 Kodrix 文档当 instructions 吃 token） */
function kodrixInstructionLocationKeys(): string[] {
	return [
		getGlobalInstructionsLocationKey(),
		getWorkspaceInstructionsLocationKey(),
		getMemoryInstructionLocationKey(),
		getWikiInstructionLocationKey(),
	].filter((k): k is string => !!k);
}

/** 取消注册本扩展登记的全部指令位置（关闭注入 / 卸载时调用） */
export async function unregisterInstructionFolders(): Promise<void> {
	for (const key of kodrixInstructionLocationKeys()) {
		await mergeInstructionLocation(key, false);
	}
}

export async function registerInstructionFolders(): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('contextInjection', true);
	if (!enabled) {
		// 关闭时不只是"不再注册"，还要把已登记的位置撤掉（曾经只 return，导致关了仍持续注入）
		await unregisterInstructionFolders();
		return;
	}

	ensureDir(getGlobalInstructionsDir());
	await mergeInstructionLocation(getGlobalInstructionsLocationKey());

	const wsInstructions = getWorkspaceInstructionsDir();
	if (wsInstructions) {
		ensureDir(wsInstructions);
		await mergeInstructionLocation(getWorkspaceInstructionsLocationKey());
	}

	// Memory 层：受 kodrix.features.memory 控制；关闭时不写指令文件、也不登记该位置
	const memoryEnabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('memory', true);
	if (memoryEnabled) {
		ensureDir(getMemoryDir());
		syncProjectInstructionsFile();
		await mergeInstructionLocation(getMemoryInstructionLocationKey());
	} else {
		await mergeInstructionLocation(getMemoryInstructionLocationKey(), false);
	}

	// Wiki 层：受 kodrix.features.wiki 控制
	const wikiEnabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('wiki', true);
	const wikiDir = getWikiDir();
	if (wikiEnabled && wikiDir && fs.existsSync(wikiDir)) {
		await mergeInstructionLocation(getWikiInstructionLocationKey());
	} else {
		await mergeInstructionLocation(getWikiInstructionLocationKey(), false);
	}
}

const WIKI_INSTRUCTIONS_FRONTMATTER = `---
applyTo: '**'
description: Repo Wiki 架构摘要（Kodrix Agent OS 自动生成）
---

`;

export function writeWikiInstructionsFile(): void {
	// Wiki 层关闭时不生成 wiki 指令文件（否则关掉 Wiki 仍会被当作 instructions 注入）
	if (vscode.workspace.getConfiguration('kodrix.features').get<boolean>('wiki', true) === false) {
		return;
	}
	const wikiDir = getWikiDir();
	const outPath = getWikiInstructionsPath();
	if (!wikiDir || !outPath || !fs.existsSync(pathJoin(wikiDir, 'ARCHITECTURE.md'))) {
		return;
	}

	// 用户可编辑文档：容错 BOM/UTF-16/GBK，读失败按空串处理（不中断指令文件生成）
	const arch = (readUserTextFileSync(pathJoin(wikiDir, 'ARCHITECTURE.md')) ?? '').slice(0, 2500);
	const modules = fs.existsSync(pathJoin(wikiDir, 'MODULES.md'))
		? (readUserTextFileSync(pathJoin(wikiDir, 'MODULES.md')) ?? '').slice(0, 1500)
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

	ensureDir(wikiDir);
	// 走统一原子写入（同时受"不受信任工作区禁止写工作区文件"闸门约束）
	atomicWriteFileSync(outPath, body);
}
