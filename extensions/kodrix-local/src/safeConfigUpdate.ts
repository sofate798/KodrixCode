/*---------------------------------------------------------------------------------------------
 *  Kodrix — 安全写入 VS Code 配置（未注册键跳过，不阻断业务流程）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logWarn } from './logger';

/**
 * 写入配置；若键未注册、被策略拒绝或其它写入失败则记录并返回 false。
 */
export async function safeUpdateConfiguration(
	key: string,
	value: unknown,
	target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
): Promise<boolean> {
	try {
		await vscode.workspace.getConfiguration().update(key, value, target);
		return true;
	} catch (err) {
		logWarn(`跳过配置写入 ${key}`, err instanceof Error ? err.message : err);
		return false;
	}
}
