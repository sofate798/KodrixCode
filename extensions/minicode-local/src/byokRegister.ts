/*---------------------------------------------------------------------------------------------
 *  Minicode — 通过 Copilot BYOK（Custom Endpoint）注册自定义模型
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { discoverOpenAIModels } from './modelDiscovery';
import { getPresetModelCandidates } from './modelResolve';
import { waitForCopilotReady } from './copilotReady';
import { logWarn } from './logger';
import {
	storedProviderFromPreset,
	storePendingProvider,
	StoredProvider,
	upsertStoredProvider,
	loadStoredProviders,
} from './providerStore';
import { syncFromStoredProvider } from './providerSync';
import { ProviderPreset } from './types';
import { saveProviderApiKey } from './providerSecrets';
import { notifyMinicodeModelsChanged } from './languageModelProvider';

const CUSTOM_ENDPOINT_VENDOR = 'customendpoint';
const OLLAMA_VENDOR = 'ollama';

export interface CustomModelConfig {
	id: string;
	name: string;
	url: string;
	toolCalling: boolean;
	vision: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
	streaming: boolean;
	apiType?: 'chat-completions' | 'responses' | 'messages';
}

export function buildModelConfig(
	storageKey: string,
	providerName: string,
	baseUrl: string,
	model: string,
): CustomModelConfig {
	const modelId = model.trim() || storageKey;
	const displayName = model.trim() || providerName;
	return {
		id: modelId,
		name: displayName,
		url: baseUrl,
		toolCalling: true,
		vision: false,
		maxInputTokens: 128000,
		maxOutputTokens: 8192,
		streaming: true,
		apiType: 'chat-completions',
	};
}

function groupNameFor(providerName: string): string {
	return `Minicode: ${providerName}`;
}

async function migrateProviderGroup(
	vendor: string,
	name: string,
	configuration: Record<string, unknown>,
): Promise<boolean> {
	const ready = await waitForCopilotReady();
	if (!ready) {
		return false;
	}
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await vscode.commands.executeCommand('lm.migrateLanguageModelsProviderGroup', {
				vendor,
				name,
				...configuration,
			});
			return true;
		} catch (err) {
			if (attempt < 3) {
				logWarn(`BYOK 注册重试（第 ${attempt + 1}/4 次，vendor=${vendor}）`, err);
				await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
			} else {
				logWarn(`BYOK 注册失败（已重试 4 次，vendor=${vendor}）`, err);
			}
		}
	}
	return false;
}

export async function resolveModelsForPreset(
	preset: ProviderPreset,
	baseUrl: string,
	apiKey?: string,
): Promise<string[] | undefined> {
	const declared = getPresetModelCandidates(preset);
	if (declared?.length) {
		return declared;
	}

	if (preset.api_type === 'ollama' || preset.api_type === 'anthropic' || preset.api_type === 'gemini') {
		return undefined;
	}

	const discovered = await discoverOpenAIModels(baseUrl, apiKey);
	if (discovered.length === 1) {
		return discovered;
	}
	if (discovered.length > 1) {
		const presetOptions = (preset.models || []).filter(m => discovered.includes(m));
		const options = (presetOptions.length ? presetOptions : discovered).map(id => ({ label: id, id }));
		const picked = await vscode.window.showQuickPick(options, {
			placeHolder: `「${preset.name}」检测到 ${discovered.length} 个模型，请选择`,
			canPickMany: true,
		});
		if (!picked?.length) {
			return undefined;
		}
		return picked.map(item => item.id);
	}

	const manual = await vscode.window.showInputBox({
		prompt: `「${preset.name}」未能自动发现模型，请输入模型 ID`,
		placeHolder: preset.models?.[0] || '例如 qwen2.5-coder:7b',
		ignoreFocusOut: true,
	});
	if (!manual?.trim()) {
		return undefined;
	}
	return [manual.trim()];
}

async function finalizeProviderActivation(
	context: vscode.ExtensionContext | undefined,
	stored: StoredProvider,
	options?: { fillEmptyRoutesOnly?: boolean },
): Promise<void> {
	if (!context) {
		return;
	}
	await syncFromStoredProvider(stored, { fillEmptyRoutesOnly: options?.fillEmptyRoutesOnly });
}

export async function registerNativeVendor(
	vendor: 'anthropic' | 'gemini',
	groupName: string,
	apiKey: string,
	storageKey: string,
	preset: ProviderPreset,
	context?: vscode.ExtensionContext,
): Promise<boolean> {
	const ok = await migrateProviderGroup(vendor, groupName, { apiKey: apiKey.trim() });
	if (context) {
		const modelList = getPresetModelCandidates(preset) || [];
		const stored = storedProviderFromPreset(preset, modelList, groupName);
		stored.id = storageKey;
		stored.pendingApiKey = !ok;
		await saveProviderApiKey(context, storageKey, apiKey);
		await upsertStoredProvider(context, stored);
		notifyMinicodeModelsChanged();
		if (ok) {
			await finalizeProviderActivation(context, stored);
		}
	}
	return ok || !!context;
}

export async function registerOllamaEndpoint(
	baseUrl: string,
	preset: ProviderPreset,
	context?: vscode.ExtensionContext,
): Promise<boolean> {
	const configTarget = vscode.ConfigurationTarget.Global;
	await vscode.workspace.getConfiguration().update(
		'github.copilot.chat.byok.ollamaEndpoint',
		baseUrl,
		configTarget,
	);
	const ok = await migrateProviderGroup(OLLAMA_VENDOR, 'Ollama', { url: baseUrl });
	if (context) {
		const models = getPresetModelCandidates(preset) || preset.models || [];
		const stored: StoredProvider = {
			id: `minicode-${preset.id}`,
			presetId: preset.id,
			name: preset.name,
			category: 'local',
			api_type: 'ollama',
			base_url: baseUrl,
			model: models[0] || preset.model,
			models,
			groupName: 'Ollama',
			needs_api_key: false,
			pendingApiKey: false,
			registeredAt: Date.now(),
		};
		await upsertStoredProvider(context, stored);
		notifyMinicodeModelsChanged();
		if (ok) {
			await finalizeProviderActivation(context, stored, { fillEmptyRoutesOnly: true });
		}
	}
	return ok || !!context;
}

export async function registerCustomEndpointModels(
	storageKey: string,
	providerName: string,
	baseUrl: string,
	modelIds: string[],
	apiKey?: string,
	context?: vscode.ExtensionContext,
	preset?: ProviderPreset,
): Promise<boolean> {
	const groupName = groupNameFor(providerName);
	const models = modelIds.map(modelId =>
		buildModelConfig(`${storageKey}-${modelId}`, providerName, baseUrl, modelId),
	);

	const configuration: Record<string, unknown> = {
		apiType: 'chat-completions',
		models,
	};
	if (apiKey?.trim()) {
		configuration.apiKey = apiKey.trim();
	}

	const ok = await migrateProviderGroup(CUSTOM_ENDPOINT_VENDOR, groupName, configuration);
	if (context && preset) {
		const stored = storedProviderFromPreset(preset, modelIds, groupName);
		stored.id = storageKey;
		stored.base_url = baseUrl;
		stored.pendingApiKey = !apiKey?.trim() && !!preset.needs_api_key;
		await saveProviderApiKey(context, storageKey, apiKey);
		await upsertStoredProvider(context, stored);
		notifyMinicodeModelsChanged();
		if (ok) {
			await finalizeProviderActivation(context, stored);
		}
	}
	return ok || !!(context && preset);
}

export async function registerPendingNativeVendor(
	vendor: 'anthropic' | 'gemini',
	groupName: string,
	storageKey: string,
	preset: ProviderPreset,
	context: vscode.ExtensionContext,
): Promise<void> {
	await storePendingProvider(context, preset, storageKey, groupName, {
		api_type: vendor,
		base_url: preset.base_url,
	});
}

export async function applyPresetWithByok(
	preset: ProviderPreset,
	apiKey?: string,
	context?: vscode.ExtensionContext,
): Promise<void> {
	let resolved = { ...preset };

	if (resolved.api_type === 'ollama') {
		const ok = await registerOllamaEndpoint(resolved.base_url, resolved, context);
		if (ok) {
			vscode.window.showInformationMessage(`Minicode：已应用 Ollama 预设「${resolved.name}」`);
		} else {
			vscode.window.showWarningMessage(
				`Minicode：已设置 Ollama 端点，但 BYOK 注册未完成。请确认 Copilot 已加载后在 Manage Models 中检查。`,
			);
		}
		return;
	}

	if (resolved.api_type === 'anthropic' || resolved.api_type === 'gemini') {
		const groupName = resolved.api_type === 'anthropic' ? 'Anthropic' : 'Google';
		const storageKey = `minicode-${resolved.id}`;
		if (!apiKey?.trim()) {
			if (context) {
				await registerPendingNativeVendor(resolved.api_type, groupName, storageKey, resolved, context);
			}
			const choice = await vscode.window.showInformationMessage(
				`「${resolved.name}」已记录。在 Chat 中选择 Minicode 下的模型即可，无需登录 GitHub。`,
				'打开供应商管理',
			);
			if (choice === '打开供应商管理') {
				await vscode.commands.executeCommand('minicode.openProviderWorkbench');
			}
			return;
		}
		const ok = await registerNativeVendor(
			resolved.api_type,
			groupName,
			apiKey,
			storageKey,
			resolved,
			context,
		);
		if (ok) {
			vscode.window.showInformationMessage(`Minicode：已应用「${resolved.name}」并配置 API Key`);
		} else {
			vscode.window.showErrorMessage(`注册「${resolved.name}」失败。请在 AI 供应商管理中检查 base_url 与 API Key。`);
		}
		return;
	}

	if (!resolved.base_url?.trim()) {
		const baseUrl = await vscode.window.showInputBox({
			prompt: '请输入 OpenAI 兼容 API 地址',
			placeHolder: 'https://api.example.com/v1',
			ignoreFocusOut: true,
		});
		if (!baseUrl?.trim()) {
			vscode.window.showWarningMessage('Minicode：已取消，未填写 API 地址');
			return;
		}
		resolved = { ...resolved, base_url: baseUrl.trim() };
	}

	const modelIds = await resolveModelsForPreset(resolved, resolved.base_url, apiKey);
	if (!modelIds?.length) {
		vscode.window.showWarningMessage('Minicode：已取消，未选择模型');
		return;
	}

	const storageKey = `minicode-${resolved.id}`;
	if (resolved.needs_api_key && !apiKey?.trim() && context) {
		await storePendingProvider(context, resolved, storageKey, groupNameFor(resolved.name), {
			base_url: resolved.base_url,
			model: modelIds[0],
			models: modelIds,
		});
	}

	const ok = await registerCustomEndpointModels(
		storageKey,
		resolved.name,
		resolved.base_url,
		modelIds,
		apiKey,
		context,
		resolved,
	);

	if (ok && apiKey) {
		vscode.window.showInformationMessage(
			`Minicode：已应用「${resolved.name}」并配置 API Key（${modelIds.length} 个模型）`,
		);
	} else if (ok) {
		vscode.window.showInformationMessage(
			`Minicode：已应用「${resolved.name}」（${modelIds.length} 个模型）`,
		);
	} else if (resolved.needs_api_key && !apiKey) {
		const choice = await vscode.window.showInformationMessage(
			`已记录「${resolved.name}」。请在 AI 供应商管理中填写 API Key。`,
			'打开供应商管理',
		);
		if (choice === '打开供应商管理') {
			await vscode.commands.executeCommand('minicode.openProviderWorkbench');
		}
	} else {
		vscode.window.showErrorMessage(`注册「${resolved.name}」失败，请检查 base_url 是否可达。`);
	}
}

export async function reapplyStoredProvider(
	context: vscode.ExtensionContext,
	provider: StoredProvider,
	presets: ProviderPreset[],
	apiKey?: string,
): Promise<boolean> {
	// 显式构造 ProviderPreset，由编译器校验字段完整性（替代运行时 `as` 强转）
	const fallbackPreset: ProviderPreset = {
		id: provider.presetId || provider.id,
		category: provider.category,
		name: provider.name,
		api_type: provider.api_type,
		base_url: provider.base_url,
		model: provider.model,
		models: provider.models,
		needs_api_key: provider.needs_api_key,
	};
	const preset: ProviderPreset = presets.find(p => p.id === provider.presetId) || fallbackPreset;

	let ok = false;
	if (provider.api_type === 'ollama') {
		ok = await registerOllamaEndpoint(provider.base_url, preset, context);
	} else if (provider.api_type === 'anthropic' || provider.api_type === 'gemini') {
		if (!apiKey?.trim()) {
			return false;
		}
		const groupName = provider.api_type === 'anthropic' ? 'Anthropic' : 'Google';
		ok = await registerNativeVendor(
			provider.api_type,
			groupName,
			apiKey,
			provider.id,
			preset,
			context,
		);
	} else {
		const modelIds = provider.models.length
			? provider.models
			: (provider.model ? [provider.model] : []);
		if (!modelIds.length) {
			return false;
		}
		ok = await registerCustomEndpointModels(
			provider.id,
			provider.name,
			provider.base_url,
			modelIds,
			apiKey,
			context,
			preset,
		);
	}

	if (ok) {
		const updated = loadStoredProviders(context).find(p => p.id === provider.id) || provider;
		await context.globalState.update('minicode.activeProviderId', provider.id);
		await syncFromStoredProvider({ ...updated, pendingApiKey: false });
	}
	return ok;
}
