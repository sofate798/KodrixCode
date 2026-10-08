/*---------------------------------------------------------------------------------------------
 *  工作区自动预热 — 打开项目即就绪（Qoder Context Engine 思维）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { logger } from '../logger';
import { registerInstructionFolders } from '../context/instructionRegistry';
import { ensureWorkspaceKodrixDir } from '../paths';
import { notifyContextChanged } from '../context/contextEvents';
import { updateStatusBar } from '../experience/statusBar';
import { generateRepoWiki } from '../wiki/repoWiki';
import { syncProjectInstructionsFile } from '../learning/learningEngine';
import { installSessionLearningHook } from '../learning/sessionLearning';

const BOOTSTRAP_KEY = 'kodrix.workspaceBootstrapped';
// 保存计时器句柄以便 deactivate 时取消
let wikiBuildTimer: ReturnType<typeof setTimeout> | undefined;
let tipTimer: ReturnType<typeof setTimeout> | undefined;
let bootTimer: ReturnType<typeof setTimeout> | undefined;

export async function bootstrapWorkspace(context: vscode.ExtensionContext): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}

	// 不受信任工作区：预热会构建索引 / 写工作区 .kodrix/，一律跳过（能力声明为 limited）
	if (vscode.workspace.isTrusted === false) {
		logger.warn('[WorkspaceBootstrap] 工作区未受信任，跳过自动预热与索引构建');
		return;
	}

	// 工作区 .kodrix/ 就位并写好 .gitignore：会话记录/运行记录属本机私有数据，不该被提交
	try {
		ensureWorkspaceKodrixDir();
	} catch (err) {
		logger.warn(`[WorkspaceBootstrap] 初始化 .kodrix 目录失败：${err instanceof Error ? err.message : String(err)}`);
	}

	const cfg = vscode.workspace.getConfiguration('kodrix');
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

	// Session Learning Hook（仅未装过时；装过则跳过，避免反复覆盖 .github/hooks）
	if (
		vscode.workspace.getConfiguration('kodrix.features').get<boolean>('sessionLearning', true)
		&& !context.workspaceState.get<boolean>('kodrix.sessionLearningHookInstalled')
	) {
		void installSessionLearningHook(context, { silent: true }).catch(err => {
			logger.warn('Session Learning Hook 静默安装失败', err);
		});
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
	const wikiIndex = path.join(folder.uri.fsPath, '.kodrix', 'wiki', 'INDEX.md');
	const wikiAuto = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('wikiAutoBuild', true);
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
				// 按钮文案必须与"比较用的常量"同源：此前把中文字面量写在两处并直接 `===` 比较，
				// 一旦接入 l10n（按钮显示译文）比较就永远不成立 —— 按钮点了没反应。
				const openHub = l10n.t('Open Hub');
				const smartRoute = l10n.t('Smart Routing');
				void vscode.window.showInformationMessage(
					l10n.t('Kodrix prewarmed the Agent context for the current workspace (Wiki · Memory · Learning)'),
					openHub,
					smartRoute,
				).then(choice => {
					if (choice === openHub) {
						void vscode.commands.executeCommand('kodrix.hub.open');
					} else if (choice === smartRoute) {
						void vscode.commands.executeCommand('kodrix.router.route');
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
