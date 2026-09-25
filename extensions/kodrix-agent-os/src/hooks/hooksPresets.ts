/*---------------------------------------------------------------------------------------------
 *  Hooks 预置包 — Kiro 风格 + Session Learning Stop Hook
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { installSessionLearningHook } from '../learning/sessionLearning';
import { ensureDir, getHooksDir, getWorkspaceKodrixDir } from '../paths';

interface HooksConfig {
	version: number;
	hooks: Record<string, Array<{ command: string; description?: string }>>;
}

const PRESET_HOOKS: HooksConfig = {
	version: 1,
	hooks: {
		afterFileEdit: [
			{
				command: 'echo Kodrix: file edited — run lint if configured',
				description: '编辑后提醒运行 lint（可替换为项目 lint 命令）',
			},
		],
		stop: [
			{
				command: 'echo Kodrix: agent session completed',
				description: 'Agent 完成时记录日志',
			},
		],
		beforeSubmitPrompt: [
			{
				command: 'echo Kodrix: prompt submitted',
				description: '提交前审计（可替换为 secrets 扫描脚本）',
			},
		],
	},
};

function getProjectHooksPath(): string | undefined {
	const ws = getWorkspaceKodrixDir();
	if (!ws) {
		return undefined;
	}
	return path.join(ws, 'hooks', 'hooks.json');
}

function getCursorHooksPath(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return path.join(folder.uri.fsPath, '.cursor', 'hooks.json');
}

export async function installHooksPresets(context: vscode.ExtensionContext): Promise<void> {
	const target = await vscode.window.showQuickPick(
		[
			{ label: l10n.t('Session Learning（推荐）'), description: l10n.t('Agent Stop 时自动蒸馏项目知识'), action: 'session' as const },
			{ label: l10n.t('工作区 .kodrix/hooks/'), path: getProjectHooksPath(), scope: 'project' as const },
			{ label: l10n.t('工作区 .cursor/hooks.json（Cursor 兼容）'), path: getCursorHooksPath(), scope: 'cursor' as const },
			{ label: l10n.t('用户 ~/.kodrix/hooks/'), path: path.join(getHooksDir(), 'hooks.json'), scope: 'user' as const },
		].filter(o => o.action === 'session' || o.path),
		{ placeHolder: l10n.t('选择 Hooks 安装类型') },
	);
	if (!target) {
		vscode.window.showWarningMessage(l10n.t('请先打开工作区'));
		return;
	}

	if (target.action === 'session') {
		await installSessionLearningHook(context);
		return;
	}

	if (!target.path) {
		return;
	}

	ensureDir(path.dirname(target.path));
	fs.writeFileSync(target.path, JSON.stringify(PRESET_HOOKS, null, 2), 'utf-8');

	const hooksDir = path.join(path.dirname(target.path), 'scripts');
	ensureDir(hooksDir);
	const readme = path.join(hooksDir, 'README.md');
	if (!fs.existsSync(readme)) {
		fs.writeFileSync(readme, `# Kodrix Hooks

预置 Hooks 已安装。推荐改用 **Session Learning**（\`Kodrix: 安装 Session Learning Hook\`），
在 Agent **Stop** 时自动将会话 transcript 送入 Learning Engine。

将 \`command\` 替换为实际脚本路径，例如：

\`\`\`json
"command": "node .kodrix/hooks/scripts/lint-after-edit.mjs"
\`\`\`
`, 'utf-8');
	}

	vscode.window.showInformationMessage(l10n.t('Hooks 预置包已安装：{0}', target.path));
}

export function registerHooks(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.hooks.installPresets', () => installHooksPresets(context)),
	);
}
