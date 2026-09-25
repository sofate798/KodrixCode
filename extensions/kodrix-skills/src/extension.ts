/*---------------------------------------------------------------------------------------------
 *  Kodrix Skills — Skill 市场扩展
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SkillMarketplaceViewProvider } from './marketplaceWebview';
import {
	CatalogItem,
	importCursorSkills,
	installFromCatalogItem,
	installFromUrl,
	loadCatalog,
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	try {
		await activateInternal(context);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(vscode.l10n.t('Kodrix Skills 激活失败: {0}', msg));
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
			} else if (item && typeof item === 'object' && 'catalogItem' in item) {
				catalog = item.catalogItem;
			} else {
				catalog = item as CatalogItem | undefined;
			}
			if (!catalog) {
				vscode.window.showWarningMessage(vscode.l10n.t('请从 Skill 市场选择要安装的项'));
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('安装 {0}…', catalog.displayName) },
				async () => {
					const name = await installFromCatalogItem(context.extensionPath, catalog!);
					provider.refresh();
					vscode.window.showInformationMessage(vscode.l10n.t('Skill 已安装：{0}（{1}/{0}）', name, SKILLS_DIR));
				},
			);
		}),

		vscode.commands.registerCommand(CMD.uninstall, async (name?: string) => {
			if (!name) {
				return;
			}
			uninstallSkill(name);
			provider.refresh();
			vscode.window.showInformationMessage(vscode.l10n.t('已卸载 Skill：{0}', name));
		}),

		vscode.commands.registerCommand(CMD.installFromUrl, async () => {
			const url = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('GitHub 仓库 URL 或 raw SKILL.md 链接'),
				placeHolder: 'https://github.com/owner/repo',
			});
			if (!url) {
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('从 URL 安装 Skill…') },
				async () => {
					const name = await installFromUrl(url);
					provider.refresh();
					vscode.window.showInformationMessage(vscode.l10n.t('Skill 已安装：{0}', name));
				},
			);
		}),

		vscode.commands.registerCommand(CMD.importCursor, async () => {
			const count = await importCursorSkills();
			provider.refresh();
			vscode.window.showInformationMessage(
				count > 0
					? vscode.l10n.t('已从 {0} 导入 {1} 个 Skill', CURSOR_SKILLS_DIR, count)
					: vscode.l10n.t('未找到 {0} 目录', CURSOR_SKILLS_DIR),
			);
		}),

		vscode.commands.registerCommand(CMD.searchGithub, async () => {
			await vscode.commands.executeCommand(CMD.openMarketplace);
		}),
	);

	await registerSkillsLocations();
}

export function deactivate(): void { }
