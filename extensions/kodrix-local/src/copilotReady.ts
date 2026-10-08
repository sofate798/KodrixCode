/*---------------------------------------------------------------------------------------------
 *  Kodrix — 等待 Copilot 扩展与 BYOK 命令就绪
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logWarn } from './logger';

const COPILOT_EXTENSION_ID = 'GitHub.copilot-chat';
const LM_MIGRATE_COMMAND = 'lm.migrateLanguageModelsProviderGroup';

export const copilotReadyTiming = {
	/** Copilot 扩展根本不存在时的宽限期：超过即判定不可用，不再空等 */
	absentGraceMs: 3_000,
};

/**
 * 等待 Copilot 扩展与 BYOK 命令就绪。
 * 扩展**不存在**（未安装 Copilot）与**存在但未激活**是两种情况：前者不可能在超时前变好，
 * 继续等待只会让每次供应商激活都白等若干秒，因此给一个短宽限期后即返回 false。
 */
export async function waitForCopilotReady(maxWaitMs = 60_000): Promise<boolean> {
	const deadline = Date.now() + maxWaitMs;
	const started = Date.now();
	while (Date.now() < deadline) {
		const ext = vscode.extensions.getExtension(COPILOT_EXTENSION_ID);
		if (!ext) {
			if (Date.now() - started > copilotReadyTiming.absentGraceMs) {
				logWarn(`未检测到 ${COPILOT_EXTENSION_ID}，跳过 Copilot BYOK 通道等待`);
				return false;
			}
			await new Promise(resolve => setTimeout(resolve, 250));
			continue;
		}
		if (!ext.isActive) {
			try {
				await ext.activate();
			} catch (err) {
				logWarn('Copilot 扩展存在但尚未就绪，稍后重试', err);
			}
		}
		if (ext.isActive) {
			const commands = await vscode.commands.getCommands(true);
			if (commands.includes(LM_MIGRATE_COMMAND)) {
				return true;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	return false;
}
