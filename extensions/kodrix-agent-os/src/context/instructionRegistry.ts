/*---------------------------------------------------------------------------------------------
 *  Instructions 路径注册 — 供 Wiki / Memory / Context 共享
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { syncProjectInstructionsFile } from '../learning/learningEngine';
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

export async function mergeInstructionLocation(locationKey: string, enabled = true): Promise<void> {
	const key = locationKey.replace(/\\/g, '/');
	const existing = vscode.workspace.getConfiguration('chat').get<Record<string, boolean>>('instructionsFilesLocations') || {};
	if (existing[key] === enabled) {
		return;
	}
	await vscode.workspace.getConfiguration('chat').update(
		'instructionsFilesLocations',
		{ ...existing, [key]: enabled },
		vscode.ConfigurationTarget.Global,
	);
}

export async function registerInstructionFolders(): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('contextInjection', true);
	if (!enabled) {
		return;
	}

	ensureDir(getGlobalInstructionsDir());
	await mergeInstructionLocation(getGlobalInstructionsLocationKey());

	const wsInstructions = getWorkspaceInstructionsDir();
	if (wsInstructions) {
		ensureDir(wsInstructions);
		await mergeInstructionLocation(getWorkspaceInstructionsLocationKey());
	}

	ensureDir(getMemoryDir());
	syncProjectInstructionsFile();
	await mergeInstructionLocation(getMemoryInstructionLocationKey());

	const wikiDir = getWikiDir();
	if (wikiDir && fs.existsSync(wikiDir)) {
		await mergeInstructionLocation(getWikiInstructionLocationKey());
	}
}

const WIKI_INSTRUCTIONS_FRONTMATTER = `---
applyTo: '**'
description: Repo Wiki 架构摘要（Kodrix Agent OS 自动生成）
---

`;

export function writeWikiInstructionsFile(): void {
	const wikiDir = getWikiDir();
	const outPath = getWikiInstructionsPath();
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

	ensureDir(wikiDir);
	fs.writeFileSync(outPath, body, 'utf-8');
}
