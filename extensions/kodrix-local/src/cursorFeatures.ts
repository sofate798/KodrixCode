/*---------------------------------------------------------------------------------------------
 *  Kodrix — Cursor 对标能力：Tab 补全 / Agent / Composer / @Codebase / Cursor 3
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';
import { waitForCopilotReady } from './copilotReady';
import {
	applyCursor3ExperienceDefaults,
	bootstrapCursor3WorkspaceLayout,
	openAgentsWindowWithWorkspace,
} from './cursor3Experience';

/** GitHub Copilot 代码库语义索引命令 */
const BUILD_INDEX_COMMAND = 'github.copilot.buildRemoteWorkspaceIndex';
/** 自动构建等待 Copilot 就绪的上限（毫秒） */
const AUTO_BUILD_WAIT_MS = 20_000;
/** 手动构建等待 Copilot 就绪的上限（毫秒） */
const MANUAL_BUILD_WAIT_MS = 60_000;

export async function applyCursorFeatureDefaults(context: vscode.ExtensionContext): Promise<void> {
	await applyCursor3ExperienceDefaults(context);
}

/**
 * 构建代码库语义索引（Copilot workspace index）。
 *
 * 修复说明：Copilot 扩展激活是异步的——激活过程中会先联网初始化实验配置，
 * 之后才注册索引命令。此前这里在打开工作区 8 秒后无条件执行
 * `github.copilot.buildRemoteWorkspaceIndex`，很容易撞上「命令尚未注册」的窗口，
 * 导致 executeCommand 抛出异常，每次启动都弹出「无法构建代码库索引」。
 * 现在的处理：
 *   1. 未登录 GitHub 时直接跳过（远端索引依赖 GitHub 账号，本地模型环境通常未登录）；
 *   2. 先等待 Copilot 扩展激活、索引命令注册完毕再触发，保证在可用时真正构建成功；
 *   3. 自动构建（silent）失败只记日志不再弹窗；仅手动触发时给出可操作的提示。
 */
export async function triggerCodebaseIndexBuild(options?: { silent?: boolean }): Promise<void> {
	const silent = options?.silent ?? false;
	try {
		// 远端代码库索引依赖 GitHub 登录：无会话时构建必然失败，自动构建直接跳过
		let githubSession: vscode.AuthenticationSession | undefined;
		try {
			githubSession = await vscode.authentication.getSession('github', [], { silent: true });
		} catch {
			githubSession = undefined;
		}
		if (!githubSession) {
			if (silent) {
				logInfo('构建代码库索引已跳过：未检测到 GitHub 登录');
			} else {
				vscode.window.showWarningMessage(
					'无法构建代码库索引：未检测到 GitHub 登录。请先在「账号」中登录 GitHub（Copilot 代码库索引需要 GitHub 账号）。',
				);
			}
			return;
		}

		// 等待 Copilot 扩展激活完成并注册命令，避免「命令尚未注册」竞态
		const copilotReady = await waitForCopilotReady(silent ? AUTO_BUILD_WAIT_MS : MANUAL_BUILD_WAIT_MS);
		if (!copilotReady) {
			throw new Error('Copilot 扩展未就绪（未安装或未激活），无法构建代码库索引');
		}

		// 双保险：确认索引命令已注册后再触发
		const commands = await vscode.commands.getCommands(true);
		if (!commands.includes(BUILD_INDEX_COMMAND)) {
			throw new Error(`索引命令 ${BUILD_INDEX_COMMAND} 未注册`);
		}

		await vscode.commands.executeCommand(BUILD_INDEX_COMMAND);
	} catch (err) {
		logWarn('构建代码库索引失败', err);
		if (!silent) {
			vscode.window.showWarningMessage(
				'无法构建代码库索引。请确认已登录 GitHub Copilot 后重载窗口；或直接在聊天中输入 #codebase 使用即时检索。',
			);
		}
	}
}

export async function attachCodebaseToChat(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.chat.open', {
		query: '#codebase ',
		isPartialQuery: true,
	});
}

export async function openComposerMode(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.chat.open', {
		mode: 'agent',
	});
}

export async function continueInBackgroundAgent(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.chat.openNewChatSessionInPlace.copilotcli', 'sidebar');
}

export async function continueInCloudAgent(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.chat.openNewChatSessionInPlace.copilot-cloud-agent', 'sidebar');
}

export async function openAgentsWindow(): Promise<void> {
	try {
		await vscode.commands.executeCommand('workbench.action.openAgentsWindow');
	} catch (err) {
		logWarn('打开 Agents 窗口失败', err);
		vscode.window.showWarningMessage(
			'无法打开 Agents 窗口。请确认已启用 Agent 模式（chat.agent.enabled）并重载窗口。',
		);
	}
}

export async function openWorkspaceInAgentsWindow(): Promise<void> {
	try {
		await openAgentsWindowWithWorkspace();
	} catch (err) {
		logWarn('在当前工作区打开 Agents 窗口失败', err);
		vscode.window.showWarningMessage(
			'无法在当前工作区打开 Agents 窗口。请确认已启用 Agent 模式并重载窗口。',
		);
	}
}

export function registerCursorFeatureCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.buildCodebaseIndex', () => triggerCodebaseIndexBuild()),
		vscode.commands.registerCommand('kodrix.attachCodebase', () => attachCodebaseToChat()),
		vscode.commands.registerCommand('kodrix.openComposer', () => openComposerMode()),
		vscode.commands.registerCommand('kodrix.continueInBackground', () => continueInBackgroundAgent()),
		vscode.commands.registerCommand('kodrix.continueInCloud', () => continueInCloudAgent()),
		vscode.commands.registerCommand('kodrix.openAgentsWindow', () => openAgentsWindow()),
		vscode.commands.registerCommand('kodrix.openWorkspaceInAgentsWindow', () => openWorkspaceInAgentsWindow()),
		vscode.commands.registerCommand('kodrix.applyCursorFeatures', async () => {
			await applyCursor3ExperienceDefaults(context, { force: true });
			vscode.window.showInformationMessage('Kodrix：已应用 Cursor 3.0 Agent 中心体验默认配置');
		}),
		vscode.commands.registerCommand('kodrix.applyCursor3Experience', async () => {
			await applyCursor3ExperienceDefaults(context, { force: true });
			await bootstrapCursor3WorkspaceLayout(context);
			vscode.window.showInformationMessage('Kodrix：已应用 Cursor 3.0 完整体验并重载布局');
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void bootstrapCursor3WorkspaceLayout(context);
		}),
	);

	if (vscode.workspace.getConfiguration('kodrix.features').get<boolean>('codebaseIndexAutoBuild', true)) {
		const folders = vscode.workspace.workspaceFolders;
		if (folders?.length) {
			const codebaseTimer = setTimeout(() => {
				void triggerCodebaseIndexBuild({ silent: true });
			}, 8000);
			context.subscriptions.push({ dispose: () => clearTimeout(codebaseTimer) });
		}
	}

	void bootstrapCursor3WorkspaceLayout(context);
}
