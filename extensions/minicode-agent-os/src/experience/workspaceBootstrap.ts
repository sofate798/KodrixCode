/*---------------------------------------------------------------------------------------------
 *  工作区自动预热 — 打开项目即就绪（Qoder Context Engine 思维）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerInstructionFolders } from '../context/instructionRegistry';
import { notifyContextChanged } from '../context/contextEvents';
import { updateStatusBar } from '../experience/statusBar';
import { generateRepoWiki } from '../wiki/repoWiki';
import { syncProjectInstructionsFile } from '../learning/learningEngine';
import { installSessionLearningHook } from '../learning/sessionLearning';

const BOOTSTRAP_KEY = 'minicode.workspaceBootstrapped';
// 保存计时器句柄以便 deactivate 时取消
let wikiBuildTimer: ReturnType<typeof setTimeout> | undefined;
let tipTimer: ReturnType<typeof setTimeout> | undefined;
let bootTimer: ReturnType<typeof setTimeout> | undefined;

export async function bootstrapWorkspace(context: vscode.ExtensionContext): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}

	const cfg = vscode.workspace.getConfiguration('minicode');
	const autoBootstrap = cfg.get<boolean>('experience.autoBootstrap', true);
	if (!autoBootstrap) {
		return;
	}

	const folderKey = folder.uri.fsPath;
	// 使用 Set 存储已预热路径（最多保留 50 个，防止无限增长）
	const MAX_BOOTSTRAPPED = 50;
	const bootstrappedRaw = context.workspaceState.get<string[]>(BOOTSTRAP_KEY, []);
	const bootstrapped = new Set(bootstrappedRaw);
	const already = bootstrapped.has(folderKey);

	// Session Learning Hook（首次）
	if (vscode.workspace.getConfiguration('minicode.features').get<boolean>('sessionLearning', true)) {
		void installSessionLearningHook(context, { silent: true });
	}

	// Instructions 注册（每次）
	try {
		await registerInstructionFolders();
		syncProjectInstructionsFile();
	} catch {
		// 非关键路径，失败不中断其余预热步骤
	}

	// 语义索引：learning 日志存在但向量缺失时自动重建
	try {
		const { rebuildIndex, getSemanticStats } = await import('../learning/semanticMemory');
		if (getSemanticStats().totalVectors === 0) {
			rebuildIndex();
		}
	} catch {
		// 非关键
	}

	// Wiki 自动生成（若缺失）
	const wikiIndex = path.join(folder.uri.fsPath, '.minicode', 'wiki', 'INDEX.md');
	const wikiAuto = vscode.workspace.getConfiguration('minicode.features').get<boolean>('wikiAutoBuild', true);
	if (wikiAuto && !fs.existsSync(wikiIndex)) {
		wikiBuildTimer = setTimeout(() => {
			wikiBuildTimer = undefined;
			void generateRepoWiki({ recordLearning: false });
		}, 4000);
	}

	if (!already) {
		bootstrapped.add(folderKey);
		// 保持集合大小不超过上限，移除最旧的条目
		const updated = Array.from(bootstrapped).slice(-MAX_BOOTSTRAPPED);
		await context.workspaceState.update(BOOTSTRAP_KEY, updated);

		// 首次打开工作区：轻量提示
		const showTip = cfg.get<boolean>('experience.showBootstrapTip', true);
		if (showTip) {
			tipTimer = setTimeout(() => {
				tipTimer = undefined;
				void vscode.window.showInformationMessage(
					'Minicode 已为当前工作区预热 Agent 上下文（Wiki · Memory · Learning）',
					'打开 Hub',
					'智能路由',
				).then(choice => {
					if (choice === '打开 Hub') {
						void vscode.commands.executeCommand('minicode.hub.open');
					} else if (choice === '智能路由') {
						void vscode.commands.executeCommand('minicode.router.route');
					}
				});
			}, 6000);
		}
	}

	notifyContextChanged();
	updateStatusBar();
}

export function registerWorkspaceBootstrap(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void bootstrapWorkspace(context);
		}),
	);

	if (vscode.workspace.workspaceFolders?.length) {
		bootTimer = setTimeout(() => {
			bootTimer = undefined;
			void bootstrapWorkspace(context);
		}, 2500);
	}
}

/** 取消所有 Bootstrap 延迟任务（在 deactivate 时调用） */
export function cancelBootstrapTimers(): void {
	if (wikiBuildTimer) { clearTimeout(wikiBuildTimer); wikiBuildTimer = undefined; }
	if (tipTimer) { clearTimeout(tipTimer); tipTimer = undefined; }
	if (bootTimer) { clearTimeout(bootTimer); bootTimer = undefined; }
}
