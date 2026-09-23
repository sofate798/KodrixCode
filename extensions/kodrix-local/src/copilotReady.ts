/*---------------------------------------------------------------------------------------------
 *  Kodrix — 等待 Copilot 扩展与 BYOK 命令就绪
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logWarn } from './logger';

const COPILOT_EXTENSION_ID = 'GitHub.copilot-chat';
const LM_MIGRATE_COMMAND = 'lm.migrateLanguageModelsProviderGroup';

export async function waitForCopilotReady(maxWaitMs = 60_000): Promise<boolean> {
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		const ext = vscode.extensions.getExtension(COPILOT_EXTENSION_ID);
		if (ext) {
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
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	return false;
}
