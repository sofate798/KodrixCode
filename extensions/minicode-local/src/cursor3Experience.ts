/*---------------------------------------------------------------------------------------------
 *  Minicode — Cursor 3.0 以 Agent 为中心的体验（Agents Window + 并行编排 + IDE 协同）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logWarn } from './logger';

export const CURSOR3_FEATURES_VERSION = 7;
export const CURSOR3_FEATURES_APPLIED_KEY = 'minicode.cursorFeaturesVersion';
export const CURSOR3_WORKSPACE_BOOTSTRAP_KEY = 'minicode.cursor3WorkspaceBootstrapped';

export interface SettingEntry {
	section: string;
	key: string;
	value: unknown;
}

/** Keys that must overwrite existing user values when applying Cursor 3 preset. */
const FORCE_OVERWRITE_KEYS = new Set<string>([
	'chat.agentsControl.enabled',
	'chat.unifiedAgentsBar.enabled',
	'chat.agentsHandoffTip.mode',
	'chat.viewSessions.enabled',
	'chat.viewSessions.orientation',
	'chat.viewProgressBadge.enabled',
	'chat.permissions.default',
	'chat.defaultConfiguration',
	'chat.agentHost.enabled',
	'chat.agentHost.defaultSessionsProvider',
	'chat.editor.defaultProvider',
	'workbench.secondarySideBar.defaultVisibility',
	'workbench.secondarySideBar.forceMaximized',
	'chat.editor.localAgent.enabled',
	'chat.titleBar.openInAgentsWindow.enabled',
	'chat.agent.enabled',
]);

export interface Cursor3FeatureToggles {
	tabCompletion?: boolean;
	backgroundAgents?: boolean;
	cloudAgents?: boolean;
	composerUI?: boolean;
	codebaseIndex?: boolean;
	agentsWindow?: boolean;
	agentFirstLayout?: boolean;
	agentHostPriority?: boolean;
	handoffTip?: boolean;
}

export function getCursor3FeatureToggles(): Cursor3FeatureToggles {
	const cfg = vscode.workspace.getConfiguration('minicode.features');
	return {
		tabCompletion: cfg.get<boolean>('tabCompletion', true),
		backgroundAgents: cfg.get<boolean>('backgroundAgents', true),
		cloudAgents: cfg.get<boolean>('cloudAgents', true),
		composerUI: cfg.get<boolean>('composerUI', true),
		codebaseIndex: cfg.get<boolean>('codebaseIndex', true),
		agentsWindow: cfg.get<boolean>('agentsWindow', true),
		agentFirstLayout: cfg.get<boolean>('agentFirstLayout', true),
		agentHostPriority: cfg.get<boolean>('agentHostPriority', true),
		handoffTip: cfg.get<boolean>('handoffTip', true),
	};
}

function tabCompletionDefaults(): SettingEntry[] {
	return [
		{ section: 'github.copilot', key: 'enable', value: { '*': true, plaintext: false, markdown: false, scminput: false } },
		{ section: 'editor.inlineSuggest', key: 'enabled', value: true },
		{ section: 'editor', key: 'tabCompletion', value: 'on' },
		{ section: 'github.copilot.nextEditSuggestions', key: 'enabled', value: true },
		{ section: 'github.copilot.nextEditSuggestions', key: 'extendedRange', value: true },
		{ section: 'github.copilot.nextEditSuggestions', key: 'fixes', value: true },
		{ section: 'github.copilot.nextEditSuggestions', key: 'eagerness', value: 'medium' },
		{ section: 'github.copilot.completions', key: 'chat.enabled', value: true },
	];
}

function backgroundCloudAgentDefaults(toggles: Cursor3FeatureToggles): SettingEntry[] {
	const entries: SettingEntry[] = [];
	if (toggles.backgroundAgents) {
		entries.push({ section: 'github.copilot.chat', key: 'backgroundAgent.enabled', value: true });
	}
	if (toggles.cloudAgents) {
		entries.push({ section: 'github.copilot.chat', key: 'cloudAgent.enabled', value: true });
	}
	return entries;
}

function composerUIDefaults(): SettingEntry[] {
	return [
		{ section: 'chat.agentSessionProjection', key: 'enabled', value: true },
		{ section: 'chat.checkpoints', key: 'enabled', value: true },
		{ section: 'chat.checkpoints', key: 'showFileChanges', value: true },
		{ section: 'chat.editing', key: 'openChangedFileInDiffEditor', value: true },
		{ section: 'chat.editing', key: 'explainChanges.enabled', value: true },
	];
}

function codebaseIndexDefaults(): SettingEntry[] {
	return [
		{ section: 'github.copilot.chat.workspace.codeSearchExternalIngest', key: 'enabled', value: true },
		{ section: 'chat.repoInfo', key: 'enabled', value: true },
	];
}

/** 越用越聪明 + 强上下文：隐式上下文、Instructions 路径（@Codebase 由 codebaseIndexDefaults 的 codeSearchExternalIngest 提供） */
function intelligenceContextDefaults(): SettingEntry[] {
	return [
		{ section: 'chat.implicitContext', key: 'enabled', value: { panel: 'always', editor: 'always' } },
		{ section: 'chat', key: 'useAgentSkills', value: true },
	];
}

/** Cursor 3：IDE 侧 Agent 编排（会话侧栏、Handoff、权限、布局） */
function agentOrchestrationDefaults(toggles: Cursor3FeatureToggles): SettingEntry[] {
	const entries: SettingEntry[] = [
		{ section: 'chat', key: 'viewSessions.enabled', value: true },
		{ section: 'chat.viewSessions', key: 'orientation', value: 'sideBySide' },
		{ section: 'chat', key: 'viewProgressBadge.enabled', value: true },
		{ section: 'chat', key: 'agentsControl.enabled', value: 'hidden' },
		{ section: 'chat', key: 'unifiedAgentsBar.enabled', value: true },
		{ section: 'chat.permissions', key: 'default', value: 'autoApprove' },
		{
			section: 'chat',
			key: 'defaultConfiguration',
			value: { mode: 'plan', approvals: 'autoApprove' },
		},
	];
	if (toggles.handoffTip) {
		entries.push({ section: 'chat', key: 'agentsHandoffTip.mode', value: 'default' });
	}
	if (toggles.agentFirstLayout) {
		entries.push(
			{ section: 'workbench', key: 'secondarySideBar.defaultVisibility', value: 'maximizedInWorkspace' },
			{ section: 'workbench', key: 'secondarySideBar.forceMaximized', value: true },
		);
	}
	return entries;
}

/** Cursor 3：Agents Window + Agent Host 优先 */
function agentsWindowDefaults(toggles: Cursor3FeatureToggles): SettingEntry[] {
	const entries: SettingEntry[] = [
		{ section: 'chat.editor.localAgent', key: 'enabled', value: true },
		{ section: 'chat', key: 'titleBar.openInAgentsWindow.enabled', value: true },
		{ section: 'chat', key: 'agent.enabled', value: true },
	];
	if (toggles.agentHostPriority) {
		entries.push(
			{ section: 'chat.agentHost', key: 'enabled', value: true },
			{ section: 'chat.agentHost', key: 'defaultSessionsProvider', value: true },
			{ section: 'chat.editor', key: 'defaultProvider', value: 'copilotAh' },
		);
	}
	return entries;
}

export function buildCursor3SettingEntries(toggles: Cursor3FeatureToggles): SettingEntry[] {
	const entries: SettingEntry[] = [];
	if (toggles.tabCompletion) {
		entries.push(...tabCompletionDefaults());
	}
	entries.push(...backgroundCloudAgentDefaults(toggles));
	if (toggles.composerUI) {
		entries.push(...composerUIDefaults());
	}
	if (toggles.codebaseIndex) {
		entries.push(...codebaseIndexDefaults());
	}
	entries.push(...intelligenceContextDefaults());
	entries.push(...agentOrchestrationDefaults(toggles));
	if (toggles.agentsWindow) {
		entries.push(...agentsWindowDefaults(toggles));
	}
	return entries;
}

export async function applySettingEntries(
	entries: SettingEntry[],
	target: vscode.ConfigurationTarget,
	options?: { force?: boolean },
): Promise<void> {
	for (const { section, key, value } of entries) {
		const config = vscode.workspace.getConfiguration(section);
		const fullKey = `${section}.${key}`;
		const current = config.get(key);
		const shouldForce = options?.force || FORCE_OVERWRITE_KEYS.has(fullKey);
		if (
			shouldForce
			|| current === undefined
			|| (typeof current === 'boolean' && current === false && value === true)
		) {
			try {
				await config.update(key, value, target);
			} catch (err) {
				// 个别键在当前版本未注册/被拒时跳过，不阻断其余键写入
				console.warn(`[minicode-local] 跳过配置写入 ${fullKey}:`, err instanceof Error ? err.message : err);
			}
		}
	}
}

export async function applyCursor3ExperienceDefaults(
	context: vscode.ExtensionContext,
	options?: { force?: boolean },
): Promise<void> {
	const appliedVersion = context.globalState.get<number>(CURSOR3_FEATURES_APPLIED_KEY, 0);
	if (!options?.force && appliedVersion >= CURSOR3_FEATURES_VERSION) {
		return;
	}

	const toggles = getCursor3FeatureToggles();
	const entries = buildCursor3SettingEntries(toggles);
	await applySettingEntries(entries, vscode.ConfigurationTarget.Global, { force: options?.force });
	await context.globalState.update(CURSOR3_FEATURES_APPLIED_KEY, CURSOR3_FEATURES_VERSION);
}

/** 首次打开工作区：最大化 Chat 侧栏并以 Agent 模式就绪（IDE 与 Agents Window 可并存） */
export async function bootstrapCursor3WorkspaceLayout(context: vscode.ExtensionContext): Promise<void> {
	if (!getCursor3FeatureToggles().agentFirstLayout) {
		return;
	}
	if (context.globalState.get<boolean>(CURSOR3_WORKSPACE_BOOTSTRAP_KEY, false)) {
		return;
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return;
	}

	await context.globalState.update(CURSOR3_WORKSPACE_BOOTSTRAP_KEY, true);

	// 注册为 Disposable，扩展停用后取消，避免卸载后仍执行布局命令
	const layoutTimer = setTimeout(async () => {
		try {
			await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
		} catch (err) {
			logWarn('maximizeAuxiliaryBar 失败（辅助栏可能已最大化）', err);
		}
		try {
			await vscode.commands.executeCommand('agentSessions.showAgentSessionsSidebar');
		} catch (err) {
			logWarn('showAgentSessionsSidebar 失败（会话侧栏可能已可见）', err);
		}
		try {
			await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
		} catch (err) {
			logWarn('chat.open 失败（聊天可能尚未就绪）', err);
		}
	}, 2500);
	context.subscriptions.push({ dispose: () => clearTimeout(layoutTimer) });
}

export async function openAgentsWindowWithWorkspace(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (folders?.length) {
		await vscode.commands.executeCommand('workbench.action.openWorkspaceInAgentsWindow');
		return;
	}
	await vscode.commands.executeCommand('workbench.action.openAgentsWindow');
}
