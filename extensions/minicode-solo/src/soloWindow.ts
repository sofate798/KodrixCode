/*---------------------------------------------------------------------------------------------
 *  SOLO — 独立窗口启动
 *
 *  活动栏入口点击后打开新窗口，并在新窗口里展开 SOLO 工作台。
 *  用 globalState 上的短时标记把「打开窗口」和「新窗口激活」接起来。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { openSoloWorkbench } from './soloWorkbench';

const LAUNCH_FLAG = 'minicode.solo.launchWindowAt';
const LAUNCH_TTL_MS = 30_000;

let soloWindow = false;

export function isSoloWindow(): boolean {
	return soloWindow;
}

export async function openSoloInNewWindow(context: vscode.ExtensionContext): Promise<void> {
	await context.globalState.update(LAUNCH_FLAG, Date.now());
	const folder = vscode.workspace.workspaceFolders?.[0];
	try {
		if (folder) {
			await vscode.commands.executeCommand('vscode.openFolder', folder.uri, { forceNewWindow: true });
		} else {
			await vscode.commands.executeCommand('workbench.action.newWindow');
		}
	} catch (err) {
		await context.globalState.update(LAUNCH_FLAG, undefined);
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`无法打开 SOLO 窗口: ${msg}`);
	}
}

/** 新窗口激活时调用。命中启动标记则标记本窗口为 SOLO 窗口并打开工作台。 */
export async function consumeSoloWindowLaunch(context: vscode.ExtensionContext): Promise<void> {
	const ts = context.globalState.get<number>(LAUNCH_FLAG);
	if (!ts || Date.now() - ts > LAUNCH_TTL_MS) {
		return;
	}
	soloWindow = true;
	await context.globalState.update(LAUNCH_FLAG, undefined);
	setTimeout(() => {
		void openSoloWorkbench(context);
	}, 600);
}
