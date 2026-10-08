/*---------------------------------------------------------------------------------------------
 *  Kodrix Skills — Skill 市场扩展
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SkillMarketplaceViewProvider } from './marketplaceWebview';
import {
	CatalogItem,
	importCursorSkills,
	installFromCatalogItem,
	installFromUrl,
	confirmUninstallSkill,
	installWithOverwritePrompt,
	loadCatalog,
	parseSha256Fragment,
	resolveSkillsDir,
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

/** 把绝对安装目录收成 chat.agentSkillsLocations 可用的键（优先 ~/…） */
function skillsLocationKey(absDir: string): string {
	const home = os.homedir();
	const normHome = path.normalize(home);
	const normDir = path.normalize(absDir);
	if (normDir === normHome || normDir.startsWith(normHome + path.sep)) {
		const rel = path.relative(normHome, normDir).replace(/\\/g, '/');
		return rel ? `~/${rel}` : '~';
	}
	return normDir;
}

async function registerSkillsLocations(): Promise<void> {
	try {
		const dirs = new Set<string>([SKILLS_DIR, CURSOR_SKILLS_DIR]);
		try {
			dirs.add(skillsLocationKey(resolveSkillsDir()));
		} catch {
			// installDir 非法时仍注册默认目录，避免激活失败
		}
		const chatConfig = vscode.workspace.getConfiguration(CONFIG_CHAT);
		const existing = chatConfig.get<Record<string, boolean>>(SKILLS_LOCATIONS_KEY);

		if (!existing || typeof existing !== 'object') {
			const initial: Record<string, boolean> = {};
			for (const dir of dirs) {
				initial[dir] = true;
			}
			await chatConfig.update(SKILLS_LOCATIONS_KEY, initial, vscode.ConfigurationTarget.Global);
			return;
		}

		const merged: Record<string, boolean> = { ...existing };
		let changed = false;
		for (const dir of dirs) {
			if (existing[dir] === undefined) {
				merged[dir] = true;
				changed = true;
			}
		}
		if (changed) {
			await chatConfig.update(SKILLS_LOCATIONS_KEY, merged, vscode.ConfigurationTarget.Global);
		}
	} catch {
		// 配置服务未就绪时静默跳过；下次配置变更或重载会再试
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
						const destHint = skillsLocationKey(resolveSkillsDir());
						vscode.window.showInformationMessage(vscode.l10n.t('Skill installed: {0} ({1}/{0})', name, destHint));
					}
				},
			);
		}),

		vscode.commands.registerCommand(CMD.uninstall, async (name?: string) => {
			if (!name) {
				return;
			}
			if (!(await confirmUninstallSkill(name))) {
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
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('kodrix.skills.installDir')) {
				void registerSkillsLocations();
			}
		}),
	);
}

export function deactivate(): void { }
