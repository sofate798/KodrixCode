/*---------------------------------------------------------------------------------------------
 *  Kodrix — Cursor 3.0 / Cursor 风格默认体验配置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { safeUpdateConfiguration } from './safeConfigUpdate';

const DEFAULTS_APPLIED_KEY = 'kodrix.cursorDefaultsApplied';
const DEFAULTS_VERSION = 5;

interface SettingEntry {
	section: string;
	key: string;
	value: unknown;
	/** 产品策略项：即使用户之前写成别的值，也写回（用于去掉 GitHub 登录门槛）。 */
	force?: boolean;
}

const CURSOR_LIKE_DEFAULTS: SettingEntry[] = [
	{ section: 'chat', key: 'agent.enabled', value: true },
	{ section: 'chat', key: 'useAgentSkills', value: true },
	{ section: 'chat.editor.localAgent', key: 'enabled', value: true },
	{ section: 'github.copilot.chat', key: 'skillTool.enabled', value: true },
	{ section: 'github.copilot.chat', key: 'exploreAgent.enabled', value: true },
	{ section: 'github.copilot.chat', key: 'switchAgent.enabled', value: true },
	{ section: 'chat.agent', key: 'maxRequests', value: 50 },
	{ section: 'editor.inlineSuggest', key: 'enabled', value: true },
	{ section: 'github.copilot.nextEditSuggestions', key: 'enabled', value: true },
	{ section: 'chat.tools.edits', key: 'autoApprove', value: true },
	{ section: 'chat', key: 'restoreLastPanelSession', value: true },
	{ section: 'chat.planReview.inlineEditor', key: 'enabled', value: true },
	{ section: 'chat', key: 'viewSessions.enabled', value: true },
	{ section: 'chat.viewSessions', key: 'orientation', value: 'sideBySide' },
	{ section: 'github.copilot.chat', key: 'backgroundAgent.enabled', value: true },
	{ section: 'github.copilot.chat', key: 'cloudAgent.enabled', value: true },
	{ section: 'chat', key: 'allowAnonymousAccess', value: true, force: true },
	{ section: 'chat.titleBar.signIn', key: 'enabled', value: false, force: true },
];

const CURSOR_SKILL_LOCATIONS: Record<string, boolean> = {
	'~/.agents/skills': true,
	'~/.cursor/skills': true,
};

const CURSOR_INSTRUCTION_LOCATIONS: Record<string, boolean> = {
	'.cursor/rules': true,
	'~/.cursor/rules': true,
};

const KODRIX_INSTRUCTION_LOCATIONS: Record<string, boolean> = {
	'~/.kodrix/instructions': true,
	'.kodrix/instructions': true,
	'.kodrix/wiki': true,
};

async function mergeLocationSetting(
	settingKey: 'agentSkillsLocations' | 'instructionsFilesLocations',
	locations: Record<string, boolean>,
	target: vscode.ConfigurationTarget,
): Promise<void> {
	const existing = vscode.workspace.getConfiguration('chat').get<Record<string, boolean>>(settingKey) || {};
	const merged = { ...existing };
	let changed = false;
	for (const [loc, enabled] of Object.entries(locations)) {
		if (!merged[loc]) {
			merged[loc] = enabled;
			changed = true;
		}
	}
	if (changed) {
		await vscode.workspace.getConfiguration('chat').update(settingKey, merged, target);
	}
}

export async function applyCursorLikeDefaults(
	context: vscode.ExtensionContext,
): Promise<void> {
	const appliedVersion = context.globalState.get<number>(DEFAULTS_APPLIED_KEY, 0);
	if (appliedVersion >= DEFAULTS_VERSION) {
		return;
	}

	const target = vscode.ConfigurationTarget.Global;
	for (const { section, key, value, force } of CURSOR_LIKE_DEFAULTS) {
		const config = vscode.workspace.getConfiguration(section);
		const current = config.get(key);
		if (force || current === undefined || (typeof current === 'boolean' && current === false && value === true)) {
			try {
				await config.update(key, value, target);
			} catch (err) {
				// 个别键在特定版本未注册/被拒时跳过，不阻断其余键写入
				console.warn(`[kodrix-local] 跳过配置写入 ${section}.${key}:`, err instanceof Error ? err.message : err);
			}
		}
	}

	await mergeLocationSetting('agentSkillsLocations', CURSOR_SKILL_LOCATIONS, target);
	await mergeLocationSetting('instructionsFilesLocations', CURSOR_INSTRUCTION_LOCATIONS, target);
	await mergeLocationSetting('instructionsFilesLocations', KODRIX_INSTRUCTION_LOCATIONS, target);

	await context.globalState.update(DEFAULTS_APPLIED_KEY, DEFAULTS_VERSION);
}

export async function applyModelRoutes(): Promise<void> {
	const routes = vscode.workspace.getConfiguration('kodrix').get<Record<string, { model?: string }>>('modelRoutes', {});
	if (!Object.keys(routes).length) {
		return;
	}

	const target = vscode.ConfigurationTarget.Global;
	const planRoute = routes.plan;
	const agentRoute = routes.agent;
	const codeRoute = routes.code;
	const fastRoute = routes.fast;

	if (planRoute?.model) {
		await safeUpdateConfiguration('chat.planAgent.defaultModel', planRoute.model, target);
	}
	if (agentRoute?.model) {
		await safeUpdateConfiguration('github.copilot.chat.implementAgent.model', agentRoute.model, target);
	}
	if (codeRoute?.model) {
		await safeUpdateConfiguration('chat.exploreAgent.defaultModel', codeRoute.model, target);
	}
	if (fastRoute?.model) {
		await safeUpdateConfiguration('chat.utilitySmallModel', fastRoute.model, target);
	}
}
