/*---------------------------------------------------------------------------------------------
 *  Minicode — 从 ~/.cursormini / ~/.minicode 迁移模型与 Agent 配置
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { logWarn } from './logger';
import {
	applyPresetWithByok,
	registerCustomEndpointModels,
	registerNativeVendor,
	registerOllamaEndpoint,
	registerPendingNativeVendor,
} from './byokRegister';
import { resolveModelsForSilentRegistration } from './modelResolve';
import { syncFromStoredProvider } from './providerSync';
import { getActiveProviderId, loadStoredProviders } from './providerStore';
import { ProviderPreset } from './types';

export type { ProviderPreset } from './types';

export interface LegacyProvider {
	id: string;
	preset_id?: string;
	name?: string;
	api_type?: string;
	base_url?: string;
	model?: string;
	api_key?: string;
}

export interface LegacyConfig {
	api_type?: string;
	base_url?: string;
	model?: string;
	api_key?: string;
	model_routes?: Record<string, Record<string, unknown>>;
	mcp_servers?: unknown[];
	agent_plan_mode?: string;
	agent_native_tools?: boolean;
	agent_auto_rag?: boolean;
	agent_context_chars?: number;
	active_provider_id?: string;
}

export interface MigrationResult {
	migrated: boolean;
	message: string;
	settingsApplied: string[];
}

const PRODUCT_NAME = process.env.VSCODE_DEV ? 'code-oss-dev' : 'Minicode';

/**
 * 校验路径是否位于 base 目录内（解析符号链接后），防止通过环境变量指向任意目录读取敏感配置。
 */
function isWithinDir(base: string, target: string): boolean {
	try {
		const realBase = fs.realpathSync(base);
		// target 可能尚不存在，逐级向上找到最近的存在祖先再解析
		let probe = path.resolve(target);
		while (!fs.existsSync(probe)) {
			const parent = path.dirname(probe);
			if (parent === probe) { break; }
			probe = parent;
		}
		const realTarget = fs.existsSync(probe) ? fs.realpathSync(probe) : path.resolve(target);
		const rel = path.relative(realBase, realTarget);
		return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
	} catch {
		return false;
	}
}

export function resolveConfigDir(): string {
	const override = process.env.MINICODE_CONFIG_DIR || process.env.CURSORMINI_CONFIG_DIR;
	if (override) {
		const resolved = path.resolve(override);
		// 安全边界：override 必须位于用户主目录内，防止路径穿越读取任意 config.json（含 api_key）
		if (isWithinDir(os.homedir(), resolved)) {
			return resolved;
		}
		logWarn(`忽略越界的 MINICODE_CONFIG_DIR（不在用户主目录内）: ${resolved}`);
	}
	const minicodeDir = path.join(os.homedir(), '.minicode');
	const legacyDir = path.join(os.homedir(), '.cursormini');
	if (fs.existsSync(path.join(minicodeDir, 'config.json'))) { return minicodeDir; }
	if (fs.existsSync(path.join(legacyDir, 'config.json'))) { return legacyDir; }
	return minicodeDir;
}

export function resolveUserMcpJsonPath(): string {
	const portable = process.env.VSCODE_PORTABLE;
	if (portable) { return path.join(portable, 'user-data', 'User', 'mcp.json'); }
	const appData = process.env.VSCODE_APPDATA;
	if (appData) { return path.join(appData, PRODUCT_NAME, 'User', 'mcp.json'); }
	let base: string;
	switch (process.platform) {
		case 'win32':
			base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
			break;
		case 'darwin':
			base = path.join(os.homedir(), 'Library', 'Application Support');
			break;
		default:
			base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
			break;
	}
	return path.join(base, PRODUCT_NAME, 'User', 'mcp.json');
}

function readJson<T>(filePath: string): T | undefined {
	try {
		if (!fs.existsSync(filePath)) { return undefined; }
		return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
	} catch (err) {
		logWarn(`读取配置文件失败: ${filePath}`, err);
		return undefined;
	}
}

function normalizeBaseUrl(url: string): string {
	return (url || '').replace(/\/+$/, '');
}

function mcpServersToRecord(servers: unknown[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let anon = 0;
	for (const s of servers) {
		if (!s || typeof s !== 'object') { continue; }
		const srv = s as Record<string, unknown>;
		// 规范化名称：非空 trim；缺失时用递增序号，避免多个匿名 server 互相覆盖
		let name = typeof srv.name === 'string' ? srv.name.trim() : '';
		if (!name) { name = `server-${++anon}`; }
		// 名称冲突时追加后缀，保留全部条目
		let uniqueName = name;
		let dup = 1;
		while (Object.prototype.hasOwnProperty.call(out, uniqueName)) {
			uniqueName = `${name}-${++dup}`;
		}
		const entry: Record<string, unknown> = { ...srv };
		delete entry.name;
		out[uniqueName] = entry;
	}
	return out;
}

function mergeMcpConfig(mcpPath: string, servers: Record<string, unknown>): boolean {
	const existing = readJson<{ servers?: Record<string, unknown>; inputs?: unknown[] }>(mcpPath) || {};
	const merged = {
		servers: { ...(existing.servers || {}), ...servers },
		inputs: existing.inputs || [],
	};
	try {
		fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
		fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2), 'utf-8');
		return true;
	} catch (err) {
		logWarn(`写入 MCP 配置失败: ${mcpPath}`, err);
		return false;
	}
}

function storageKeyForLegacy(legacy: LegacyProvider): string {
	const slug = (legacy.preset_id || legacy.id || legacy.name || 'custom')
		.toLowerCase()
		.replace(/\s+/g, '-');
	return `minicode-${slug}`;
}

async function migrateLegacyProviderEntry(
	legacy: LegacyProvider,
	presets: ProviderPreset[],
	context?: vscode.ExtensionContext,
): Promise<string> {
	const apiType = legacy.api_type || 'openai';
	const baseUrl = normalizeBaseUrl(legacy.base_url || '');
	const model = legacy.model || '';
	const apiKey = legacy.api_key || '';
	const key = storageKeyForLegacy(legacy);

	if (apiType === 'ollama') {
		const preset = presets.find(p => p.id === 'ollama') || {
			id: 'ollama', category: 'local',
			name: legacy.name || 'Ollama', api_type: 'ollama',
			base_url: baseUrl || 'http://127.0.0.1:11434',
			model: model || 'qwen2.5-coder:7b',
		};
		const ok = await registerOllamaEndpoint(baseUrl || preset.base_url, preset, context);
		return `${preset.name}${ok ? '' : '（BYOK 待完成）'}`;
	}

	if (apiType === 'anthropic' || apiType === 'gemini') {
		const preset = presets.find(p => p.id === apiType)
			|| presets.find(p => p.id === (legacy.preset_id || ''))
			|| { id: apiType, category: 'cloud', name: legacy.name || apiType, api_type: apiType, base_url: '', model };
		const groupName = apiType === 'anthropic' ? 'Anthropic' : 'Google';
		if (apiKey && context) {
			const ok = await registerNativeVendor(apiType, groupName, apiKey, key, preset, context);
			return `${preset.name}${ok ? '（含 API Key）' : '（注册失败）'}`;
		}
		if (context) {
			await registerPendingNativeVendor(apiType, groupName, key, preset, context);
		}
		return `${preset.name}（待配置 API Key）`;
	}

	const preset = presets.find(p => p.id === (legacy.preset_id || ''));
	const providerName = legacy.name || preset?.name || 'minicode-custom';
	const normalizedUrl = baseUrl || preset?.base_url || '';
	const fallbackPreset = preset || {
		id: 'custom', category: 'cloud',
		name: providerName, api_type: 'openai',
		base_url: normalizedUrl, model,
	};

	if (!normalizedUrl) { return `${providerName}（缺少 API 地址）`; }

	const modelIds = await resolveModelsForSilentRegistration(
		fallbackPreset, normalizedUrl, model || undefined, apiKey || undefined,
	);
	if (!modelIds.length) { return `${providerName}（未解析到模型 ID）`; }

	const ok = await registerCustomEndpointModels(
		key, providerName, normalizedUrl, modelIds,
		apiKey || undefined, context, fallbackPreset,
	);
	return `${providerName}（${modelIds.length} 模型）${ok ? (apiKey ? ' + Key' : '') : ' 注册失败'}`;
}

export async function migrateFromLegacy(
	presets: ProviderPreset[],
	options?: { applyAgentDefaults?: boolean; context?: vscode.ExtensionContext },
): Promise<MigrationResult> {
	const dir = resolveConfigDir();
	const config = readJson<LegacyConfig>(path.join(dir, 'config.json'));
	const providersStore = readJson<{ active_id?: string; providers?: LegacyProvider[] }>(
		path.join(dir, 'providers.json'),
	);

	if (!config && !providersStore) {
		return {
			migrated: false,
			message: `未找到可迁移配置（已检查 ~/.minicode 与 ~/.cursormini）`,
			settingsApplied: [],
		};
	}

	const configTarget = vscode.ConfigurationTarget.Global;
	const applied: string[] = [];
	const context = options?.context;
	const activeId = providersStore?.active_id || config?.active_provider_id;

	if (providersStore?.providers?.length) {
		for (const legacy of providersStore.providers) {
			const line = await migrateLegacyProviderEntry(legacy, presets, context);
			applied.push(`供应商：${line}`);
		}
		if (activeId && context) {
			const match = providersStore.providers.find(p => p.id === activeId);
			if (match) {
				await context.globalState.update('minicode.activeProviderId', storageKeyForLegacy(match));
				const active = loadStoredProviders(context).find(p => p.id === storageKeyForLegacy(match));
				if (active) {
					await syncFromStoredProvider(active, { fillEmptyRoutesOnly: true });
				}
			}
		}
	} else {
		const legacy: LegacyProvider = {
			id: 'default',
			api_type: config?.api_type,
			base_url: config?.base_url,
			model: config?.model,
			api_key: config?.api_key,
			preset_id: config?.active_provider_id,
		};
		const line = await migrateLegacyProviderEntry(legacy, presets, context);
		applied.push(`供应商：${line}`);
	}

	const routes = config?.model_routes || {};
	if (Object.keys(routes).length > 0) {
		await vscode.workspace.getConfiguration('minicode').update('modelRoutes', routes, configTarget);
		applied.push('多模型路由');

		const planRoute = routes.plan as { model?: string } | undefined;
		const agentRoute = routes.agent as { model?: string } | undefined;
		if (planRoute?.model) {
			await vscode.workspace.getConfiguration().update('chat.planAgent.defaultModel', planRoute.model, configTarget);
			applied.push(`Plan 模型：${planRoute.model}`);
		}
		if (agentRoute?.model) {
			await vscode.workspace.getConfiguration('github.copilot.chat').update(
				'implementAgent.model', agentRoute.model, configTarget,
			);
			applied.push(`Agent 模型：${agentRoute.model}`);
		}
		const codeRoute = routes.code as { model?: string } | undefined;
		const fastRoute = routes.fast as { model?: string } | undefined;
		if (codeRoute?.model) {
			await vscode.workspace.getConfiguration().update('chat.exploreAgent.defaultModel', codeRoute.model, configTarget);
			applied.push(`Code 模型：${codeRoute.model}`);
		}
		if (fastRoute?.model) {
			await vscode.workspace.getConfiguration().update('chat.utilitySmallModel', fastRoute.model, configTarget);
			applied.push(`Fast 模型：${fastRoute.model}`);
		}
	} else if (context) {
		const activeProviderId = getActiveProviderId(context);
		const active = loadStoredProviders(context).find(p => p.id === activeProviderId);
		if (active) {
			await syncFromStoredProvider(active, { fillEmptyRoutesOnly: true });
		}
	}

	const planMode = config?.agent_plan_mode;
	if (planMode === 'review') {
		await vscode.workspace.getConfiguration('github.copilot.chat').update('switchAgent.enabled', true, configTarget);
		applied.push('Plan 审阅模式');
	}

	const mcpServers = config?.mcp_servers;
	if (Array.isArray(mcpServers) && mcpServers.length > 0) {
		const mcpPath = resolveUserMcpJsonPath();
		const record = mcpServersToRecord(mcpServers);
		const written = mergeMcpConfig(mcpPath, record);
		// 仅在实际写入成功且有有效条目时报告，避免误导用户「已迁移」
		if (written && Object.keys(record).length > 0) {
			applied.push(`MCP 服务器（${Object.keys(record).length} 个）→ ${mcpPath}`);
		}
	}

	if (options?.applyAgentDefaults) {
		const defaults: [string, unknown][] = [
			['sessions.chat.localAgent.enabled', true],
			['chat.titleBar.openInAgentsWindow.enabled', true],
			['chat.viewSessions.enabled', true],
			['chat.viewSessions.orientation', 'sideBySide'],
			['chat.unifiedAgentsBar.enabled', true],
			['chat.agentsHandoffTip.mode', 'default'],
			['chat.agentHost.enabled', true],
			['chat.agentHost.defaultSessionsProvider', true],
			['github.copilot.chat.skillTool.enabled', true],
			['chat.useAgentSkills', true],
			['github.copilot.chat.exploreAgent.enabled', true],
			['chat.agent.maxRequests', 50],
		];
		for (const [key, value] of defaults) {
			const parts = key.split('.');
			const section = parts.slice(0, -1).join('.');
			const prop = parts[parts.length - 1];
			await vscode.workspace.getConfiguration(section).update(prop, value, configTarget);
		}
		applied.push('Agent / Skill 默认开关（首次迁移）');
	}

	return {
		migrated: true,
		message: `Minicode：已从 ${dir} 迁移配置`,
		settingsApplied: applied,
	};
}

export function loadPresets(extensionPath: string): ProviderPreset[] {
	const presetsPath = path.join(extensionPath, 'resources', 'presets.json');
	const data = readJson<{ presets: ProviderPreset[] }>(presetsPath);
	return data?.presets || [];
}

export async function applyPreset(
	preset: ProviderPreset,
	apiKey?: string,
	context?: vscode.ExtensionContext,
): Promise<void> {
	await applyPresetWithByok(preset, apiKey, context);
}
