/*---------------------------------------------------------------------------------------------
 *  Minicode Skills — Skill 市场扩展
 *
 *  大厂工程化标准：
 *   1. activate 必须有 try/catch 错误边界
 *   2. 集中管理命令 ID 和配置键常量
 *   3. agentSkillsLocations 写入前做类型校验，避免覆盖用户配置
 *   4. deactivate() 保留注释说明空实现的意图
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SkillMarketplaceProvider } from './marketplaceView';
import {
	CatalogItem,
	importCursorSkills,
	installFromCatalogItem,
	installFromUrl,
} from './skillInstall';

// ── 常量 ────────────────────────────────────────────────────────────

const CMD = {
	refresh: 'minicode.skills.refresh',
	openMarketplace: 'minicode.skills.openMarketplace',
	focusMarketplace: 'minicode.skillsMarketplace.focus',
	install: 'minicode.skills.install',
	installFromUrl: 'minicode.skills.installFromUrl',
	importCursor: 'minicode.skills.importCursor',
	searchGithub: 'minicode.skills.searchGithub',
} as const;

const SKILLS_DIR = '~/.agents/skills';
const CURSOR_SKILLS_DIR = '~/.cursor/skills';
const CONFIG_CHAT = 'chat' as const;
const SKILLS_LOCATIONS_KEY = 'agentSkillsLocations';

// ── 工具 ────────────────────────────────────────────────────────────

/**
 * 安全合并 agentSkillsLocations 配置：
 * - 仅在有效对象时才合并，避免覆盖用户已有配置
 * - 用户明确设置为 false 的路径不会被强制启用
 */
async function registerSkillsLocations(): Promise<void> {
	try {
		const chatConfig = vscode.workspace.getConfiguration(CONFIG_CHAT);
		const existing = chatConfig.get<Record<string, boolean>>(SKILLS_LOCATIONS_KEY);

		// 类型校验：确保 existing 是合法对象
		if (!existing || typeof existing !== 'object') {
			await chatConfig.update(
				SKILLS_LOCATIONS_KEY,
				{ [SKILLS_DIR]: true, [CURSOR_SKILLS_DIR]: true },
				vscode.ConfigurationTarget.Global,
			);
			return;
		}

		const merged: Record<string, boolean> = { ...existing };
		// 仅当用户未显式设为 false 时才启用
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
		// 配置更新失败不阻塞扩展激活
	}
}

// ── 激活 ─────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	try {
		await activateInternal(context);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Minicode Skills 激活失败: ${msg}`);
	}
}

async function activateInternal(context: vscode.ExtensionContext): Promise<void> {
	const provider = new SkillMarketplaceProvider(context.extensionPath);
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('minicode.skillsMarketplace', provider),

		vscode.commands.registerCommand(CMD.refresh, () => provider.refresh()),

		vscode.commands.registerCommand(CMD.openMarketplace, async () => {
			await vscode.commands.executeCommand('workbench.view.explorer');
			await vscode.commands.executeCommand(CMD.focusMarketplace);
		}),

		vscode.commands.registerCommand(CMD.install, async (item?: CatalogItem) => {
			if (!item) {
				vscode.window.showWarningMessage('请从 Skill 市场列表中选择要安装的项');
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `安装 ${item.displayName}…` },
				async () => {
					const name = await installFromCatalogItem(context.extensionPath, item);
					provider.refresh();
					vscode.window.showInformationMessage(`Skill 已安装：${name}（${SKILLS_DIR}/${name}）`);
				},
			);
		}),

		vscode.commands.registerCommand(CMD.installFromUrl, async () => {
			const url = await vscode.window.showInputBox({
				prompt: 'GitHub 仓库 URL 或 raw SKILL.md 链接',
				placeHolder: 'https://github.com/owner/repo',
			});
			if (!url) {
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '从 URL 安装 Skill…' },
				async () => {
					const name = await installFromUrl(url);
					provider.refresh();
					vscode.window.showInformationMessage(`Skill 已安装：${name}`);
				},
			);
		}),

		vscode.commands.registerCommand(CMD.importCursor, async () => {
			const count = await importCursorSkills();
			provider.refresh();
			vscode.window.showInformationMessage(
				count > 0
					? `已从 ${CURSOR_SKILLS_DIR} 导入 ${count} 个 Skill`
					: `未找到 ${CURSOR_SKILLS_DIR} 目录`,
			);
		}),

		vscode.commands.registerCommand(CMD.searchGithub, async () => {
			const q = await vscode.window.showInputBox({
				prompt: '搜索 GitHub Skill 仓库',
				value: 'cursor skill SKILL.md',
			});
			if (q) {
				const url = `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`;
				await vscode.env.openExternal(vscode.Uri.parse(url));
			}
		}),
	);

	// 注册 Skills 发现路径到 Agent 配置
	await registerSkillsLocations();
}

// deactivate() 为空是因为本扩展没有需要手动清理的资源（TreeView / 命令均由
// context.subscriptions 自动管理），保留此函数以满足扩展 API 契约。
export function deactivate(): void { }
