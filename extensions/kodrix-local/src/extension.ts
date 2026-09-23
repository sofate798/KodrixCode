/*---------------------------------------------------------------------------------------------
 *  Kodrix Local — 本地/云端模型供应商与配置迁移
 *
 *  大厂工程化标准：
 *   1. 抽取 promptApiKey() 消除重复的 API Key 输入框逻辑
 *   2. 迁移操作增加重试上限，避免永久失败导致每次都重试
 *   3. 所有延迟值集中为常量
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { applyCursorLikeDefaults, applyModelRoutes } from './cursorDefaults';
import { applyCursorFeatureDefaults, registerCursorFeatureCommands } from './cursorFeatures';
import { openAgentsWindowWithWorkspace } from './cursor3Experience';
import { importFromCursor, importFromCursorOnFirstRun } from './cursorImport';
import { registerCursorKeybindings } from './cursorKeybindings';
import { disposeLogger, logError } from './logger';
import { applyPreset, loadPresets, migrateFromLegacy } from './migrateConfig';
import { openProviderWorkbench, registerProviderSettingsRenderer } from './providerWorkbench';
import { registerKodrixLanguageModels } from './languageModelProvider';
import { openOnboardingWizard, registerOnboarding } from './onboarding';

// ── 常量 ────────────────────────────────────────────────────────────

const MIGRATED_KEY = 'kodrix.configMigrated';
const WELCOMED_KEY = 'kodrix.welcomed';
/** 迁移重试计数键 */
const MIGRATE_ATTEMPTS_KEY = 'kodrix.configMigrateAttempts';
/** 最大迁移重试次数，超过后不再尝试 */
const MAX_MIGRATE_ATTEMPTS = 3;
/** 欢迎页启动延迟（毫秒） */
const WELCOME_DELAY_MS = 1500;

// ── 工具函数 ────────────────────────────────────────────────────────

/** 弹出 API Key 输入框 — 消除两个 preset 应用命令中的重复逻辑 */
async function promptApiKey(presetName: string): Promise<string | undefined> {
	return await vscode.window.showInputBox({
		prompt: `${presetName} API Key（只保存在本机，不需要登录 GitHub）`,
		password: true,
		ignoreFocusOut: true,
	}) || undefined;
}

// ── 欢迎页 ──────────────────────────────────────────────────────────

async function showWelcome(context: vscode.ExtensionContext, migrated: boolean): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		migrated
			? '欢迎使用 Kodrix — Cursor 3.0 以 Agent 为中心的全新编程体验。'
			: '欢迎使用 Kodrix！并行 Agent、云端/本地大模型、Agents 窗口，精仿 Cursor 3.0。',
		{ modal: false },
		'配置 AI 模型',
		'Agents 窗口',
		'打开 Hub',
		'Agent 聊天',
		'IDE + Agents 并行',
		'Agent OS 概览',
		'从 Cursor 导入',
		'Skill 市场',
		'稍后',
	);
	// 使用对象映射替代 if-else 链，更清晰可维护
	const commandMap: Record<string, string> = {
		'配置 AI 模型': 'kodrix.openProviderWorkbench',
		'Agents 窗口': 'kodrix.openAgentsWindow',
		'打开 Hub': 'kodrix.hub.open',
		'Agent OS 概览': 'kodrix.agentOs.welcome',
		'从 Cursor 导入': 'kodrix.importCursor',
		'Skill 市场': 'kodrix.skills.openMarketplace',
	};
	if (choice && commandMap[choice]) {
		await vscode.commands.executeCommand(commandMap[choice]);
	} else if (choice === 'Agent 聊天') {
		await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
	} else if (choice === 'IDE + Agents 并行') {
		await openAgentsWindowWithWorkspace();
		await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
	}
	await context.globalState.update(WELCOMED_KEY, true);
}

// ── 激活 ─────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	try {
		await activateInternal(context);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logError('Kodrix Local activation failed', err);
		vscode.window.showErrorMessage(`Kodrix Local 激活失败: ${msg}`);
	}
}

async function activateInternal(context: vscode.ExtensionContext): Promise<void> {
	const presets = loadPresets(context.extensionPath);

	// Phase 1: Register all commands and keybindings immediately (lightweight, <10ms)
	registerOnboarding(context);
	registerCursorKeybindings(context);
	registerCursorFeatureCommands(context);
	registerKodrixLanguageModels(context);
	context.subscriptions.push(registerProviderSettingsRenderer(context));

	// Phase 2: Apply defaults and run first-run imports (async, non-blocking)
	await applyCursorLikeDefaults(context);
	await applyCursorFeatureDefaults(context);
	await importFromCursorOnFirstRun(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.migrateConfig', async () => {
			const result = await migrateFromLegacy(presets, { context });
			if (result.migrated) {
				await context.globalState.update(MIGRATED_KEY, true);
				const detail = result.settingsApplied.join('\n• ');
				await vscode.window.showInformationMessage(
					result.message,
					{ modal: true, detail: `• ${detail}` },
				);
			} else {
				vscode.window.showWarningMessage(result.message);
			}
		}),

		vscode.commands.registerCommand('kodrix.importCursor', async () => {
			const result = await importFromCursor();
			if (result.imported) {
				const detail = result.itemsApplied.join('\n• ');
				await vscode.window.showInformationMessage(
					result.message,
					{ modal: true, detail: `• ${detail}` },
				);
			} else {
				vscode.window.showWarningMessage(result.message);
			}
		}),

		vscode.commands.registerCommand('kodrix.openProviderPresets', async () => {
			const items = presets.map(p => ({
				label: `${p.icon ? p.icon + ' ' : ''}${p.name}`,
				description: `${p.category === 'local' ? '本地' : '云端'} · ${p.base_url || p.hint || '自定义'}`,
				detail: p.category === 'local' ? '无需 API Key' : (p.needs_api_key ? '需要 API Key' : ''),
				preset: p,
			}));
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: '选择模型供应商预设',
				matchOnDescription: true,
			});
			if (picked) {
				let apiKey: string | undefined;
				if (picked.preset.needs_api_key) {
					apiKey = await promptApiKey(picked.preset.name);
				}
				await applyPreset(picked.preset, apiKey, context);
			}
		}),

		vscode.commands.registerCommand('kodrix.openProviderWorkbench', () => {
			openProviderWorkbench(context);
		}),

		vscode.commands.registerCommand('kodrix.applyPreset', async (presetId: string) => {
			const preset = presets.find(p => p.id === presetId);
			if (!preset) {
				return;
			}
			let apiKey: string | undefined;
			if (preset.needs_api_key) {
				apiKey = await promptApiKey(preset.name);
			}
			await applyPreset(preset, apiKey, context);
		}),

		vscode.commands.registerCommand('kodrix.welcome', async () => {
			await showWelcome(context, context.globalState.get<boolean>(MIGRATED_KEY, false));
		}),
	);

	// ── 首次迁移逻辑（带重试上限） ──
	const migrateOnFirstRun = vscode.workspace.getConfiguration('kodrix').get<boolean>('migrateOnFirstRun', true);
	const alreadyMigrated = context.globalState.get<boolean>(MIGRATED_KEY, false);
	const alreadyWelcomed = context.globalState.get<boolean>(WELCOMED_KEY, false);

	if (migrateOnFirstRun && !alreadyMigrated) {
		const attempts = context.globalState.get<number>(MIGRATE_ATTEMPTS_KEY, 0);
		if (attempts < MAX_MIGRATE_ATTEMPTS) {
			try {
				const result = await migrateFromLegacy(presets, { applyAgentDefaults: true, context });
				if (result.migrated) {
					await context.globalState.update(MIGRATED_KEY, true);
					await context.globalState.update(MIGRATE_ATTEMPTS_KEY, 0); // 重置计数
					await applyModelRoutes();
				} else {
					// 迁移未产生变更（可能没有 legacy 配置），不增加计数
				}
			} catch {
				// 迁移失败：增加计数，下次启动重试（最多 MAX_MIGRATE_ATTEMPTS 次）
				await context.globalState.update(MIGRATE_ATTEMPTS_KEY, attempts + 1);
				logError(`Kodrix Local: migration attempt ${attempts + 1}/${MAX_MIGRATE_ATTEMPTS} failed`);
			}
		}
	}

	if (!alreadyWelcomed) {
		const welcomeTimer = setTimeout(() => {
			void openOnboardingWizard(context);
		}, WELCOME_DELAY_MS);
		context.subscriptions.push({ dispose: () => clearTimeout(welcomeTimer) });
	}
}

export function deactivate(): void {
	disposeLogger();
}
