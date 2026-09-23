/*---------------------------------------------------------------------------------------------
 *  Kodrix — 从 Cursor 导入 Rules / MCP / Skills / 设置
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { logWarn } from './logger';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { importCursorUserRulesFromSqlite } from './cursorRulesSqlite';
import { resolveUserMcpJsonPath } from './migrateConfig';

export interface CursorImportResult {
	imported: boolean;
	message: string;
	itemsApplied: string[];
}

const CURSOR_IMPORTED_KEY = 'kodrix.cursorImported';

interface CursorMcpFile {
	mcpServers?: Record<string, Record<string, unknown>>;
	servers?: Record<string, Record<string, unknown>>;
}

function readJson<T>(filePath: string): T | undefined {
	try {
		if (!fs.existsSync(filePath)) {
			return undefined;
		}
		return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
	} catch (err) {
		logWarn(`读取 JSON 失败: ${filePath}`, err);
		return undefined;
	}
}

export function resolveCursorHomeDir(): string {
	return path.join(os.homedir(), '.cursor');
}

export function resolveCursorUserSettingsPath(): string | undefined {
	const candidates: string[] = [];
	switch (process.platform) {
		case 'win32':
			if (process.env.APPDATA) {
				candidates.push(path.join(process.env.APPDATA, 'Cursor', 'User', 'settings.json'));
			}
			break;
		case 'darwin':
			candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'));
			break;
		default:
			candidates.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User', 'settings.json'));
			break;
	}
	return candidates.find(p => fs.existsSync(p));
}

async function mergeConfigLocations(
	settingKey: 'agentSkillsLocations' | 'instructionsFilesLocations',
	locations: Record<string, boolean>,
): Promise<string[]> {
	const target = vscode.ConfigurationTarget.Global;
	const existing = vscode.workspace.getConfiguration('chat').get<Record<string, boolean>>(settingKey) || {};
	const merged = { ...existing };
	const added: string[] = [];
	for (const [loc, enabled] of Object.entries(locations)) {
		if (!merged[loc]) {
			merged[loc] = enabled;
			added.push(loc);
		}
	}
	if (added.length) {
		await vscode.workspace.getConfiguration('chat').update(settingKey, merged, target);
	}
	return added;
}

function mergeMcpServers(servers: Record<string, unknown>): string | undefined {
	if (!Object.keys(servers).length) {
		return undefined;
	}
	const mcpPath = resolveUserMcpJsonPath();
	const existing = readJson<{ servers?: Record<string, unknown>; inputs?: unknown[] }>(mcpPath) || {};
	const merged = {
		servers: { ...(existing.servers || {}), ...servers },
		inputs: existing.inputs || [],
	};
	try {
		fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
		fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2), 'utf-8');
		return mcpPath;
	} catch (err) {
		logWarn(`写入 MCP 配置失败: ${mcpPath}`, err);
		return undefined;
	}
}

async function importCursorMcp(): Promise<string[]> {
	const applied: string[] = [];
	const cursorMcpPath = path.join(resolveCursorHomeDir(), 'mcp.json');
	const mcp = readJson<CursorMcpFile>(cursorMcpPath);
	const servers = mcp?.mcpServers || mcp?.servers;
	if (!servers || !Object.keys(servers).length) {
		return applied;
	}
	const mcpPath = mergeMcpServers(servers);
	if (mcpPath) {
		applied.push(`MCP 服务器（${Object.keys(servers).length} 个）→ ${mcpPath}`);
	}
	return applied;
}

async function importCursorLocations(): Promise<string[]> {
	const applied: string[] = [];
	const skillLocs = await mergeConfigLocations('agentSkillsLocations', {
		'~/.agents/skills': true,
		'~/.cursor/skills': true,
	});
	if (skillLocs.length) {
		applied.push(`Skill 目录：${skillLocs.join('、')}`);
	}

	const instructionLocs = await mergeConfigLocations('instructionsFilesLocations', {
		'.cursor/rules': true,
		'~/.cursor/rules': true,
		'~/.kodrix/instructions': true,
	});
	if (instructionLocs.length) {
		applied.push(`Rules 目录：${instructionLocs.join('、')}`);
	}
	return applied;
}

async function importWorkspaceCursorRules(): Promise<string[]> {
	const applied: string[] = [];
	for (const folder of vscode.workspace.workspaceFolders || []) {
		const cursorRules = path.join(folder.uri.fsPath, '.cursorrules');
		if (!fs.existsSync(cursorRules)) {
			continue;
		}
		const dest = path.join(folder.uri.fsPath, '.github', 'copilot-instructions.md');
		if (fs.existsSync(dest)) {
			continue;
		}
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			const content = [
				'<!-- 由 Kodrix 从 .cursorrules 自动迁移 -->',
				'',
				fs.readFileSync(cursorRules, 'utf-8'),
			].join('\n');
			fs.writeFileSync(dest, content, 'utf-8');
			applied.push(`.cursorrules → ${path.relative(folder.uri.fsPath, dest)}`);
		} catch (err) {
			logWarn(`迁移 .cursorrules 失败: ${folder.uri.fsPath}`, err);
		}
	}
	return applied;
}

async function importCursorUserRulesFile(): Promise<string[]> {
	const applied: string[] = [];
	const cursorRulesDir = path.join(resolveCursorHomeDir(), 'rules');
	if (!fs.existsSync(cursorRulesDir)) {
		return applied;
	}
	const destRoot = path.join(os.homedir(), '.kodrix', 'instructions');
	fs.mkdirSync(destRoot, { recursive: true });
	let count = 0;
	for (const entry of fs.readdirSync(cursorRulesDir, { withFileTypes: true })) {
		if (!entry.isFile()) {
			continue;
		}
		// 防御：跳过任何含路径分隔符 / 穿越段的异常文件名
		if (entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('..')) {
			logWarn(`跳过异常 Rules 文件名: ${entry.name}`);
			continue;
		}
		const ext = path.extname(entry.name).toLowerCase();
		if (ext !== '.md' && ext !== '.mdc' && ext !== '.instructions.md') {
			continue;
		}
		const base = entry.name.replace(/\.(mdc|md|instructions\.md)$/i, '');
		const destName = `${base}.instructions.md`;
		const dest = path.join(destRoot, destName);
		// 确保目标仍落在 destRoot 内（双重保险）
		if (path.relative(destRoot, dest).startsWith('..')) {
			continue;
		}
		if (fs.existsSync(dest)) {
			continue;
		}
		try {
			fs.copyFileSync(path.join(cursorRulesDir, entry.name), dest);
			count++;
		} catch (err) {
			logWarn(`复制 Rules 文件失败: ${entry.name}`, err);
		}
	}
	if (count) {
		await mergeConfigLocations('instructionsFilesLocations', { '~/.kodrix/instructions': true });
		applied.push(`用户 Rules（${count} 个）→ ~/.kodrix/instructions`);
	}
	return applied;
}

async function importCursorUserRulesFromDatabase(): Promise<string[]> {
	const applied: string[] = [];
	const result = importCursorUserRulesFromSqlite();
	if (result.imported && result.destPath) {
		await mergeConfigLocations('instructionsFilesLocations', { '~/.kodrix/instructions': true });
		applied.push(`SQLite User Rules（${result.source}）→ ~/.kodrix/instructions/cursor-user-rules.instructions.md`);
	}
	return applied;
}

async function importCursorSkillsFromDisk(): Promise<number> {
	const cursorSkillsDir = path.join(resolveCursorHomeDir(), 'skills');
	if (!fs.existsSync(cursorSkillsDir)) {
		return 0;
	}
	const destRoot = path.join(os.homedir(), '.agents', 'skills');
	fs.mkdirSync(destRoot, { recursive: true });
	let count = 0;
	for (const entry of fs.readdirSync(cursorSkillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const src = path.join(cursorSkillsDir, entry.name);
		if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
			continue;
		}
		const dest = path.join(destRoot, entry.name);
		// 非破坏性导入：已存在的 skill 保留用户本地版本，跳过而非强制覆盖删除
		if (fs.existsSync(dest)) {
			continue;
		}
		try {
			fs.cpSync(src, dest, { recursive: true });
			count++;
		} catch (err) {
			logWarn(`导入 Skill 失败: ${entry.name}`, err);
		}
	}
	return count;
}

async function importCursorSettingsHints(): Promise<string[]> {
	const applied: string[] = [];
	const settingsPath = resolveCursorUserSettingsPath();
	if (!settingsPath) {
		return applied;
	}
	const settings = readJson<Record<string, unknown>>(settingsPath);
	if (!settings) {
		return applied;
	}

	const target = vscode.ConfigurationTarget.Global;
	const mappings: Array<{ section: string; key: string; value: unknown }> = [];
	if (typeof settings['cursor.cpp.enablePartialAccepts'] === 'boolean') {
		mappings.push({ section: 'editor.inlineSuggest', key: 'enabled', value: settings['cursor.cpp.enablePartialAccepts'] });
	}
	if (typeof settings['cursor.chat.showSuggestedFiles'] === 'boolean') {
		mappings.push({ section: 'chat.repoInfo', key: 'enabled', value: settings['cursor.chat.showSuggestedFiles'] });
	}

	for (const { section, key, value } of mappings) {
		const config = vscode.workspace.getConfiguration(section);
		if (config.get(key) === undefined) {
			await config.update(key, value, target);
			applied.push(`设置：${section}.${key}`);
		}
	}
	return applied;
}

/**
 * 只读检测：报告有哪些 Cursor 配置项可供导入，但**不写入任何文件/设置**。
 * 用于 onboarding 预览步骤，避免「扫描」阶段就修改用户环境。
 */
export function detectCursorImportables(): { available: boolean; items: string[] } {
	const cursorHome = resolveCursorHomeDir();
	const userSettings = resolveCursorUserSettingsPath();
	if (!fs.existsSync(cursorHome) && !userSettings) {
		return { available: false, items: [] };
	}

	const items: string[] = [];
	const rulesDir = path.join(cursorHome, 'rules');
	const skillsDir = path.join(cursorHome, 'skills');
	const mcpFile = path.join(cursorHome, 'mcp.json');
	const stateDb = path.join(cursorHome, 'state.vscdb');

	try {
		if (fs.existsSync(rulesDir) && fs.readdirSync(rulesDir).length > 0) {
			items.push('Rules（.cursor/rules）');
		}
	} catch { /* ignore */ }
	try {
		if (fs.existsSync(skillsDir) && fs.readdirSync(skillsDir).length > 0) {
			items.push('Skills（.cursor/skills）');
		}
	} catch { /* ignore */ }
	if (fs.existsSync(mcpFile)) {
		items.push('MCP 服务器（mcp.json）');
	}
	if (fs.existsSync(stateDb)) {
		items.push('User Rules（state.vscdb）');
	}
	if (userSettings) {
		items.push('设置提示（Cursor settings.json）');
	}

	return { available: items.length > 0, items };
}

export async function importFromCursor(options?: { importSkills?: boolean }): Promise<CursorImportResult> {
	const cursorHome = resolveCursorHomeDir();
	if (!fs.existsSync(cursorHome) && !resolveCursorUserSettingsPath()) {
		return {
			imported: false,
			message: '未检测到 Cursor 配置（~/.cursor 或 Cursor User/settings.json）',
			itemsApplied: [],
		};
	}

	const applied: string[] = [];
	applied.push(...await importCursorLocations());
	applied.push(...await importCursorMcp());
	applied.push(...await importWorkspaceCursorRules());
	applied.push(...await importCursorUserRulesFile());
	applied.push(...await importCursorUserRulesFromDatabase());
	applied.push(...await importCursorSettingsHints());

	if (options?.importSkills !== false) {
		const skillCount = await importCursorSkillsFromDisk();
		if (skillCount > 0) {
			applied.push(`Skills（${skillCount} 个）→ ~/.agents/skills`);
		}
	}

	if (!applied.length) {
		return {
			imported: false,
			message: '已检查 Cursor 配置，未发现可导入的新项',
			itemsApplied: [],
		};
	}

	return {
		imported: true,
		message: '已从 Cursor 导入配置',
		itemsApplied: applied,
	};
}

export async function importFromCursorOnFirstRun(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(CURSOR_IMPORTED_KEY, false)) {
		return;
	}
	const autoImport = vscode.workspace.getConfiguration('kodrix').get<boolean>('importCursorOnFirstRun', true);
	if (!autoImport) {
		return;
	}
	const cursorHome = resolveCursorHomeDir();
	if (!fs.existsSync(cursorHome) && !resolveCursorUserSettingsPath()) {
		await context.globalState.update(CURSOR_IMPORTED_KEY, true);
		return;
	}
	try {
		await importFromCursor();
	} catch (err) {
		// 导入失败不阻断扩展激活（如 Cursor db 损坏/sqlite3 缺失）
		logWarn('首次 Cursor 配置导入失败，已跳过', err);
	}
	await context.globalState.update(CURSOR_IMPORTED_KEY, true);
}
