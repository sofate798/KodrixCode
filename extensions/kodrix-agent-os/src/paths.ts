/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 共享路径工具
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export function getKodrixDir(): string {
	return path.join(os.homedir(), '.kodrix');
}

/**
 * 返回工作区的「主根」文件夹。所有工作区级持久化（.kodrix/、memory hash）
 * 均以此为准，确保 memory / wiki / spec / sessions 路径在多根工作区下保持一致。
 */
export function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

export function getProjectHash(): string {
	const primary = getPrimaryWorkspaceFolder();
	if (!primary) {
		return 'global';
	}
	// 以主根路径派生 hash，与 getWorkspaceKodrixDir 使用同一个 folder，
	// 避免「memory 按全量 folder 组合 hash、而 wiki/spec 写在主根」造成的路径错位。
	return crypto.createHash('sha256').update(primary.uri.fsPath).digest('hex').slice(0, 12);
}

export function getWorkspaceKodrixDir(): string | undefined {
	const folder = getPrimaryWorkspaceFolder();
	if (!folder) {
		return undefined;
	}
	return path.join(folder.uri.fsPath, '.kodrix');
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function getWikiDir(): string | undefined {
	const base = getWorkspaceKodrixDir();
	if (!base) {
		return undefined;
	}
	return path.join(base, 'wiki');
}

export function getSpecsDir(): string | undefined {
	const base = getWorkspaceKodrixDir();
	if (!base) {
		return undefined;
	}
	return path.join(base, 'specs');
}

export function getMemoryDir(): string {
	return path.join(getKodrixDir(), 'memory', getProjectHash());
}

export function getMemoryPath(): string {
	return path.join(getMemoryDir(), 'memory.md');
}

export function getMemoryInstructionsPath(): string {
	return path.join(getMemoryDir(), 'project.instructions.md');
}

export function getLearningLogPath(): string {
	return path.join(getMemoryDir(), 'learning.jsonl');
}

export function getWikiInstructionsPath(): string | undefined {
	const wikiDir = getWikiDir();
	return wikiDir ? path.join(wikiDir, 'repo-context.instructions.md') : undefined;
}

export function getWorkspaceInstructionsDir(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'instructions') : undefined;
}

export function getGlobalInstructionsDir(): string {
	return path.join(getKodrixDir(), 'instructions');
}

export function getKanbanPath(): string | undefined {
	const base = getWorkspaceKodrixDir();
	if (!base) {
		return undefined;
	}
	return path.join(base, 'kanban.json');
}

export function getAcpAgentsPath(): string {
	return path.join(getKodrixDir(), 'acp', 'agents.json');
}

export function getHooksDir(): string {
	return path.join(getKodrixDir(), 'hooks');
}

/** VS Code instructionsFilesLocations 使用的规范路径（tilde / 工作区相对） */
export function getGlobalInstructionsLocationKey(): string {
	return '~/.kodrix/instructions';
}

export function getWorkspaceInstructionsLocationKey(): string {
	return '.kodrix/instructions';
}

export function getMemoryInstructionLocationKey(): string {
	return `~/.kodrix/memory/${getProjectHash()}`;
}

export function getWikiInstructionLocationKey(): string {
	return '.kodrix/wiki';
}

export function getIdeaFlowPath(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'idea-flow.json') : undefined;
}

export function getSessionsDir(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'sessions') : undefined;
}

export function getPendingSessionsDir(): string | undefined {
	const base = getSessionsDir();
	return base ? path.join(base, 'pending') : undefined;
}

export function getProcessedSessionsDir(): string | undefined {
	const base = getSessionsDir();
	return base ? path.join(base, 'processed') : undefined;
}

export function getSessionIndexPath(): string | undefined {
	const base = getSessionsDir();
	return base ? path.join(base, 'index.json') : undefined;
}

export function getWorkspaceHooksScriptDir(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'hooks', 'scripts') : undefined;
}

export function getGithubHooksDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return path.join(folder.uri.fsPath, '.github', 'hooks');
}
