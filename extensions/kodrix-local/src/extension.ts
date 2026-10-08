/*---------------------------------------------------------------------------------------------
 *  Kodrix Local — 本地/云端模型供应商与配置迁移
 *
 *  大厂工程化标准：
 *   1. 抽取 promptApiKey() 消除重复的 API Key 输入框逻辑
 *   2. 迁移操作增加重试上限，避免永久失败导致每次都重试
 *   3. 所有延迟值集中为常量
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
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
import { registerUpdateCheck } from './updateCheck';

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
		prompt: l10n.t('{0} API Key (stored locally only; no GitHub sign-in required)', presetName),
		password: true,
		ignoreFocusOut: true,
	}) || undefined;
}

// ── 欢迎页 ──────────────────────────────────────────────────────────

async function showWelcome(context: vscode.ExtensionContext, migrated: boolean): Promise<void> {
	// 通知里 VS Code 只会平铺前 2–3 个按钮，多出来的（原实现有 10 个）用户根本看不到，
	// 连"稍后"都可能被折叠掉。这里只留最常用的 2 个 + 「更多…」，其余走 QuickPick。
	const onboardingLabel = l10n.t('Getting Started Wizard');
	const providerLabel = l10n.t('Configure AI Models');
	const moreLabel = l10n.t('More Features…');

	const choice = await vscode.window.showInformationMessage(
		migrated
			? l10n.t('Welcome to Kodrix — the Cursor 3.0-style, agent-centric coding experience.')
			: l10n.t('Welcome to Kodrix! Parallel agents, cloud/local LLMs, and the Agents window — modeled on Cursor 3.0.'),
		{ modal: false },
		onboardingLabel,
		providerLabel,
		moreLabel,
	);

	if (choice === onboardingLabel) {
		await vscode.commands.executeCommand('kodrix.onboarding.open');
	} else if (choice === providerLabel) {
		await vscode.commands.executeCommand('kodrix.openProviderWorkbench');
	} else if (choice === moreLabel) {
		await showWelcomeMore();
	}
	// 点 ✕ / Esc（choice === undefined）视为"稍后"：不再打扰
	await context.globalState.update(WELCOMED_KEY, true);
}

/** 欢迎通知的次级入口：避免一次塞 10 个按钮导致按钮被折叠不可见 */
async function showWelcomeMore(): Promise<void> {
	const entries: { label: string; run: () => Thenable<unknown> }[] = [
		{ label: l10n.t('Agents Window'), run: () => vscode.commands.executeCommand('kodrix.openAgentsWindow') },
		{ label: l10n.t('Open Hub'), run: () => vscode.commands.executeCommand('kodrix.hub.open') },
		{ label: l10n.t('Agent Chat'), run: () => vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' }) },
		{
			label: l10n.t('IDE + Agents in Parallel'),
			run: async () => {
				await openAgentsWindowWithWorkspace();
				await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
			},
		},
		{ label: l10n.t('Agent OS Overview'), run: () => vscode.commands.executeCommand('kodrix.agentOs.welcome') },
		{ label: l10n.t('Import from Cursor'), run: () => vscode.commands.executeCommand('kodrix.importCursor') },
		{ label: l10n.t('Skill Market'), run: () => vscode.commands.executeCommand('kodrix.skills.openMarketplace') },
	];

	const picked = await vscode.window.showQuickPick(
		entries.map(e => e.label),
		{ title: l10n.t('Kodrix Quick Start'), placeHolder: l10n.t('Choose a Feature to Open') },
	);
	const entry = entries.find(e => e.label === picked);
	if (entry) {
		await entry.run();
	}
}

// ── 激活 ─────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	try {
		await activateInternal(context);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logError('Kodrix Local activation failed', err);
		const copyDiagnostics = l10n.t('Copy Redacted Diagnostics');
		const choice = await vscode.window.showErrorMessage(
			l10n.t('Kodrix Local failed to activate: {0}', msg),
			copyDiagnostics,
		);
		if (choice === copyDiagnostics) {
			// Keep the copied report useful for support while excluding error text,
			// workspace paths, provider URLs, prompts, and credentials.
			const diagnostics = [
				`Kodrix: ${context.extension.packageJSON.version}`,
				`VS Code: ${vscode.version}`,
				`Platform: ${process.platform} (${process.arch})`,
				`Activation error type: ${err instanceof Error ? err.name : typeof err}`,
			].join('\n');
			try {
				await vscode.env.clipboard.writeText(diagnostics);
				vscode.window.showInformationMessage(l10n.t('Redacted diagnostics copied; the content contains no keys, workspace paths, or conversation content.'));
			} catch (copyError) {
				logError('复制脱敏诊断信息失败', copyError);
				vscode.window.showWarningMessage(l10n.t('Cannot access the clipboard. Check editor permissions and retry.'));
			}
		}
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
			const items = presets.map(p => {
				const icon = p.icon && /^[a-z0-9-]+$/i.test(p.icon) ? p.icon : undefined;
				return {
					label: icon ? `$(${icon}) ${l10n.t(p.name)}` : l10n.t(p.name),
					description: `${p.category === 'local' ? l10n.t('Local') : l10n.t('Cloud')} · ${p.base_url || (p.hint ? l10n.t(p.hint) : l10n.t('Custom'))}`,
					detail: p.category === 'local' ? l10n.t('No API Key needed') : (p.needs_api_key ? l10n.t('API Key required') : ''),
					preset: p,
				};
			});
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: l10n.t('Choose a Model Provider Preset'),
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

	// ── 发布版本检查（本产品无核心自动更新通道，见 updateCheck.ts 顶部说明） ──
	registerUpdateCheck(context);

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
