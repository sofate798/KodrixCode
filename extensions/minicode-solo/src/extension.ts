/*---------------------------------------------------------------------------------------------
 *  Minicode SOLO Builder — 扩展入口
 *
 *  大厂工程化标准：
 *   1. activate 必须有 try/catch 错误边界，失败时给出用户可见的错误提示
 *   2. 所有命令 ID 使用集中常量管理（constants.ts）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerSoloParticipant } from './soloParticipant';
import { openSoloPreview, disposeSoloPreviewTimers } from './soloPreview';
import { registerBuildTracker } from './soloBuildTracker';
import { openSoloWorkbench } from './soloWorkbench';
import { disposeSoloChannels } from './soloTemplates';
import { registerSoloLauncher } from './soloLauncher';
import { logger } from './logger';
import { COMMANDS } from './constants';

export function activate(context: vscode.ExtensionContext): void {
	try {
		activateInternal(context);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error('SOLO extension activation failed', err);
		vscode.window.showErrorMessage(`Minicode SOLO 激活失败: ${msg}`);
	}
}

function activateInternal(context: vscode.ExtensionContext): void {
	registerBuildTracker(context);
	registerSoloParticipant(context);
	registerSoloLauncher(context);

	context.subscriptions.push(
		// SOLO Start 和 OpenWorkbench 共用同一入口函数，但保留两个命令 ID 以兼容不同入口
		vscode.commands.registerCommand(COMMANDS.soloStart, () => openSoloWorkbench(context)),
		vscode.commands.registerCommand(COMMANDS.soloOpenWorkbench, () => openSoloWorkbench(context)),
		vscode.commands.registerCommand(COMMANDS.soloPreview, () => openSoloPreview(context.extensionPath)),
	);
}

export function deactivate(): void {
	disposeSoloChannels();
	disposeSoloPreviewTimers();
	logger.dispose();
}
