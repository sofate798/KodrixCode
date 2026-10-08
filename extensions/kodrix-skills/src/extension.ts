/*---------------------------------------------------------------------------------------------
 *  Kodrix Skills — Skill 市场扩展
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SkillMarketplaceViewProvider } from './marketplaceWebview';
import {
	CatalogItem,
	SkillExistsError,
	importCursorSkills,
	installFromCatalogItem,
	installFromUrl,
	loadCatalog,
	parseSha256Fragment,
	uninstallSkill,
} from './skillInstall';

const CMD = {
	refresh: 'kodrix.skills.refresh',
	openMarketplace: 'kodrix.skills.openMarketplace',
	focusMarketplace: 'kodrix.skillsMarketplace.focus',
	install: 'kodrix.skills.install',
	uninstall: 'kodrix.skills.uninstall',
	installFromUrl: 'kodrix.skills.installFromUrl',
	importCursor: 'kodrix.skills.importCursor',
	searchGithub: 'kodrix.skills.searchGithub',
} as const;

const SKILLS_DIR = '~/.agents/skills';
const CURSOR_SKILLS_DIR = '~/.cursor/skills';
const CONFIG_CHAT = 'chat' as const;
const SKILLS_LOCATIONS_KEY = 'agentSkillsLocations';

async function registerSkillsLocations(): Promise<void> {
	try {
		const chatConfig = vscode.workspace.getConfiguration(CONFIG_CHAT);
		const existing = chatConfig.get<Record<string, boolean>>(SKILLS_LOCATIONS_KEY);

		if (!existing || typeof existing !== 'object') {
			await chatConfig.update(
				SKILLS_LOCATIONS_KEY,
				{ [SKILLS_DIR]: true, [CURSOR_SKILLS_DIR]: true },
				vscode.ConfigurationTarget.Global,
			);
			return;
		}

		const merged: Record<string, boolean> = { ...existing };
		let changed = false;
		for (const dir of [SKILLS_DIR, CURSOR_SKILLS_DIR]) {
			if (existing[dir] === undefined) {
				merged[dir] = true;
				changed = true;
			}
		}
		if (changed) {
			await chatConfig.update(SKILLS_LOCATIONS_KEY, merged, vscode.ConfigurationTarget.Global);
		}
	} catch {
		// ignore
	}
}

/**
 * 安装时若目标已存在，先弹确认再以覆盖方式重试。
 * 返回 undefined 表示用户取消覆盖（调用方不应再提示"已安装"）。
 */
async function installWithOverwritePrompt(
	action: (options: { overwrite?: boolean }) => Promise<string>,
): Promise<string | undefined> {
	try {
		return await action({});
	} catch (err) {
		if (!(err instanceof SkillExistsError)) {
			throw err;
		}
		const overwriteLabel = vscode.l10n.t('Overwrite');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('{0}. Overwriting will delete the existing contents of this skill folder.', err.message),
			{ modal: true },
			overwriteLabel,
		);
		if (choice !== overwriteLabel) {
			return undefined;
		}
		return await action({ overwrite: true });
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	try {
		await activateInternal(context);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(vscode.l10n.t('Kodrix Skills failed to activate: {0}', msg));
	}
}

async function activateInternal(context: vscode.ExtensionContext): Promise<void> {
	const provider = new SkillMarketplaceViewProvider(context.extensionUri, context.extensionPath);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SkillMarketplaceViewProvider.viewId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),

		vscode.commands.registerCommand(CMD.refresh, () => provider.refresh()),

		vscode.commands.registerCommand(CMD.openMarketplace, async () => {
			await vscode.commands.executeCommand('workbench.view.extension.kodrix-skills');
			await vscode.commands.executeCommand(CMD.focusMarketplace);
		}),

		vscode.commands.registerCommand(CMD.install, async (item?: CatalogItem | { catalogItem?: CatalogItem } | string) => {
			let catalog: CatalogItem | undefined;
			if (typeof item === 'string') {
				catalog = loadCatalog(context.extensionPath).items.find(it => it.id === item);
			} else if (item && typeof item === 'object' && Object.hasOwn(item, 'catalogItem')) {
				catalog = (item as { catalogItem?: CatalogItem }).catalogItem;
			} else {
				catalog = item as CatalogItem | undefined;
			}
			if (!catalog) {
				vscode.window.showWarningMessage(vscode.l10n.t('Select an item from the Skill Market to install'));
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Installing {0}…', catalog.displayName) },
				async () => {
					const name = await installWithOverwritePrompt(o => installFromCatalogItem(context.extensionPath, catalog!, o));
					provider.refresh();
					if (name) {
						vscode.window.showInformationMessage(vscode.l10n.t('Skill installed: {0} ({1}/{0})', name, SKILLS_DIR));
					}
				},
			);
		}),

		vscode.commands.registerCommand(CMD.uninstall, async (name?: string) => {
			if (!name) {
				return;
			}
			uninstallSkill(name);
			provider.refresh();
			vscode.window.showInformationMessage(vscode.l10n.t('Skill uninstalled: {0}', name));
		}),

		vscode.commands.registerCommand(CMD.installFromUrl, async () => {
			const url = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('GitHub repository URL or raw SKILL.md link (append #sha256=<64-char hex> to pin the content hash)'),
				placeHolder: 'https://github.com/owner/repo',
			});
			if (!url) {
				return;
			}
			// O1：未固定哈希的来源无法校验完整性，必须由用户明确知情后再安装
			if (!parseSha256Fragment(url.trim())) {
				const proceedLabel = vscode.l10n.t('Install Anyway');
				const proceed = await vscode.window.showWarningMessage(
					vscode.l10n.t('This link has no pinned content hash (#sha256=…), so its integrity cannot be verified before installation. Continue only if you trust this source.'),
					{ modal: true },
					proceedLabel,
				);
				if (proceed !== proceedLabel) {
					return;
				}
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Installing skill from URL…') },
				async () => {
					const name = await installWithOverwritePrompt(o => installFromUrl(url, o));
					provider.refresh();
					if (name) {
						vscode.window.showInformationMessage(vscode.l10n.t('Skill installed: {0}', name));
					}
				},
			);
		}),

		vscode.commands.registerCommand(CMD.importCursor, async () => {
			const count = await importCursorSkills();
			provider.refresh();
			vscode.window.showInformationMessage(
				count > 0
					? vscode.l10n.t('Imported {0} skill(s) from {1}', String(count), CURSOR_SKILLS_DIR)
					: vscode.l10n.t('Directory not found: {0}', CURSOR_SKILLS_DIR),
			);
		}),

		vscode.commands.registerCommand(CMD.searchGithub, async () => {
			await vscode.commands.executeCommand(CMD.openMarketplace);
		}),
	);

	await registerSkillsLocations();
}

export function deactivate(): void { }
