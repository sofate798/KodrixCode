/*---------------------------------------------------------------------------------------------
 *  Hooks 预置包 — Kiro 风格 + Session Learning Stop Hook
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { installSessionLearningHook } from '../learning/sessionLearning';
import { ensureDir, getHooksDir, getGithubHooksDir } from '../paths';
import { FEATURE_FLAGS } from '../shared/constants';
import { isKodrixFeatureEnabled, featureDisabledNotice } from '../utils/featureFlags';
import { assertWorkspaceWriteAllowed } from '../utils/fsSafe';

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
				description: l10n.t('Remind to run lint after edits (replace with your project lint command)'),
			},
		],
		stop: [
			{
				command: 'echo Kodrix: agent session completed',
				description: l10n.t('Log a line when the Agent finishes'),
			},
		],
		beforeSubmitPrompt: [
			{
				command: 'echo Kodrix: prompt submitted',
				description: l10n.t('Audit before submitting a prompt (replace with a secrets-scanning script)'),
			},
		],
	},
};

/**
 * 真正会被执行的 hooks 位置：`.github/hooks/hooks.json`（见 paths.getGithubHooksDir）。
 * 此前预置包写到 `.kodrix/hooks/` 与 `.cursor/hooks.json` —— 前者无人读取，后者只有 Cursor 读，
 * 于是"装完 hook 什么都不发生"。
 */
function getEffectiveHooksPath(): string | undefined {
	const dir = getGithubHooksDir();
	if (!dir) {return undefined;}
	return path.join(dir, 'hooks.json');
}

/** Cursor 兼容位置：仅当用户还要在 Cursor 里用同一份 hook 时才需要 */
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
			{ label: l10n.t('Session Learning (recommended)'), description: l10n.t('Distill project knowledge automatically on Agent Stop'), action: 'session' as const },
			{ label: l10n.t('Workspace .github/hooks/hooks.json (the effective location)'), path: getEffectiveHooksPath(), scope: 'project' as const },
			{ label: l10n.t('User ~/.kodrix/hooks/'), path: path.join(getHooksDir(), 'hooks.json'), scope: 'user' as const },
			{ label: l10n.t('Workspace .cursor/hooks.json (for Cursor only; not read by Kodrix)'), path: getCursorHooksPath(), scope: 'cursor' as const },
		].filter(o => o.action === 'session' || o.path),
		{ placeHolder: l10n.t('Select Hooks installation type (Kodrix reads .github/hooks/)') },
	);
	if (!target) {
		vscode.window.showWarningMessage(l10n.t('Please open a workspace first'));
		return;
	}

	if (target.action === 'session') {
		await installSessionLearningHook(context);
		return;
	}

	if (!target.path) {
		return;
	}

	try {
		assertWorkspaceWriteAllowed(target.path);
	} catch (err) {
		vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		return;
	}

	if (fs.existsSync(target.path)) {
		const overwriteLabel = l10n.t('Overwrite');
		const choice = await vscode.window.showWarningMessage(
			l10n.t('Hooks file already exists at {0}. Overwriting will replace its contents.', target.path),
			{ modal: true },
			overwriteLabel,
		);
		if (choice !== overwriteLabel) {
			return;
		}
	}

	ensureDir(path.dirname(target.path));
	fs.writeFileSync(target.path, JSON.stringify(PRESET_HOOKS, null, 2), 'utf-8');

	const hooksDir = path.join(path.dirname(target.path), 'scripts');
	ensureDir(hooksDir);
	const readme = path.join(hooksDir, 'README.md');
	if (!fs.existsSync(readme)) {
		fs.writeFileSync(readme, `# Kodrix Hooks

${l10n.t('Preset Hooks installed. Consider switching to **Session Learning** (\`Kodrix: Install Session Learning Hook\`), which automatically feeds the session transcript into the Learning Engine on Agent **Stop**.')}

${l10n.t('Replace \`command\` with the path to your actual script, for example:')}

\`\`\`json
"command": "node .github/hooks/scripts/lint-after-edit.mjs"
\`\`\`
`, 'utf-8');
	}

	vscode.window.showInformationMessage(l10n.t('Hooks preset package installed: {0}', target.path));
}

export function registerHooks(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.hooks.installPresets', async () => {
			// 功能开关 kodrix.features.hooks（默认开）：关闭时在入口拦截并指路设置项
			if (!isKodrixFeatureEnabled(FEATURE_FLAGS.hooks)) {
				vscode.window.showWarningMessage(featureDisabledNotice(FEATURE_FLAGS.hooks));
				return;
			}
			await installHooksPresets(context);
		}),
	);
}
