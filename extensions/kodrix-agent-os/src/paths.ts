/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 共享路径工具
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isWorkspaceWriteBlocked } from './utils/fsSafe';
import { logger } from './logger';

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

/**
 * 创建目录（递归）。
 * 不受信任工作区里**不创建工作区内目录**（与 fsSafe 的写入闸门一致），
 * 这里选择"跳过 + 告警"而不是抛错：调用方多处于启动/后台路径，抛错会变成未处理拒绝；
 * 真正的内容写入仍由 atomicWriteFileSync 抛错拦截。
 */
export function ensureDir(dir: string): void {
	if (isWorkspaceWriteBlocked(dir)) {
		logger.warn(`[Paths] 不受信任的工作区：跳过创建目录 ${dir}`);
		return;
	}
	fs.mkdirSync(dir, { recursive: true });
}

/** `.kodrix/` 内自动忽略规则：会话记录等属于本机私有数据，不该被 `git add .` 带进仓库 */
const KODRIX_GITIGNORE = `# Kodrix Agent OS 本机数据（会话记录/运行记录/索引缓存等）
# 由扩展自动维护：保留本文件、忽略目录内其它内容
*
!.gitignore
`;

/**
 * 确保工作区 `.kodrix/` 存在，并在其中放好 `.gitignore`。
 * 目的：会话 transcript、运行记录、索引缓存等写在工作区里，但默认不应被提交。
 */
export function ensureWorkspaceKodrixDir(): string | undefined {
	const base = getWorkspaceKodrixDir();
	if (!base) {
		return undefined;
	}
	ensureDir(base);
	const ignorePath = path.join(base, '.gitignore');
	if (!isWorkspaceWriteBlocked(ignorePath) && !fs.existsSync(ignorePath)) {
		try {
			fs.writeFileSync(ignorePath, KODRIX_GITIGNORE, 'utf-8');
		} catch (err) {
			logger.warn(`[Paths] 写入 .kodrix/.gitignore 失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return base;
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
