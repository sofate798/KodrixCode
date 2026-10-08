/*---------------------------------------------------------------------------------------------
 *  Kodrix — 通过 Copilot BYOK（Custom Endpoint）注册自定义模型
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { discoverOpenAIModels } from './modelDiscovery';
import { getPresetModelCandidates } from './modelResolve';
import { waitForCopilotReady } from './copilotReady';
import { logWarn } from './logger';
import { safeUpdateConfiguration } from './safeConfigUpdate';
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
import { notifyKodrixModelsChanged, supportsKodrixNativePath } from './languageModelProvider';

const CUSTOM_ENDPOINT_VENDOR = 'customendpoint';
const OLLAMA_VENDOR = 'ollama';

/**
 * BYOK 相关等待时长。集中在此便于测试缩短，也便于把「主路径不被 Copilot 拖慢」这一约束写死在一处。
 * 语义区分：Kodrix 直连可用时 BYOK 只是镜像同步，等待必须短；Gemini 只有 BYOK 一条路，可以等更久但要给进度。
 */
export const byokTiming = {
	mirrorWaitMs: 10_000,
	byokOnlyWaitMs: 60_000,
	/** 镜像注册的重试退避基数（总尝试 4 次）；核心命令偶发未就绪时靠它兜住 */
	mirrorRetryBaseMs: 1_500,
};

/** 注册结果：两条通道各自独立，UI 必须按通道如实播报，不能合并成一个「成功」 */
export interface ProviderRegistrationResult {
	/** Kodrix 自有通道是否已可用（Chat 模型选择器 vendor=Kodrix，不依赖 Copilot） */
	usableViaKodrix: boolean;
	/** Copilot BYOK 供应商组是否注册成功（决定 Copilot 侧模型列表能否看到该供应商） */
	byokRegistered: boolean;
	/** 失败原因，用于给出可行动提示；全部成功时为 undefined */
	failureReason?: 'copilot-not-ready' | 'command-failed' | 'missing-api-key' | 'missing-model';
}

/**
 * 把「两条通道各自状态」翻译为如实的用户提示。
 * 之前的实现把结果压成一个布尔值，导致 Copilot BYOK 注册失败时仍然弹「已应用」，
 * 用户在 Manage Models 里找不到模型却不知道为什么。
 */
/** 失败原因 → 面向用户的行动指引（避免把不同成因糊成一句「注册失败」） */
export function failureGuidance(reason: ProviderRegistrationResult['failureReason']): string {
	switch (reason) {
		case 'missing-api-key':
			return l10n.t('No API Key entered yet. Fill in this provider\'s API Key in AI Provider Management.');
		case 'missing-model':
			return l10n.t('No usable model ID parsed. Make sure the endpoint returns a model list, or specify a model ID manually.');
		case 'command-failed':
			return l10n.t('BYOK registration command failed. Check that base_url and the model ID are correct.');
		case 'copilot-not-ready':
		default:
			return l10n.t('No installed and ready Copilot extension detected; this API is not supported by the Kodrix direct channel and requires the Copilot BYOK channel.');
	}
}

function describeRegistration(
	name: string,
	res: ProviderRegistrationResult,
	modelCount?: number,
): { severity: 'info' | 'warning' | 'error'; message: string } {
	const countSuffix = modelCount === undefined ? '' : l10n.t(' ({0} models)', String(modelCount));
	if (res.usableViaKodrix && res.byokRegistered) {
		return {
			severity: 'info',
			message: l10n.t('Kodrix: applied "{0}" {1}; pick it in the Kodrix group in Chat. Copilot BYOK is synced.', name, countSuffix),
		};
	}
	if (res.usableViaKodrix) {
		return {
			severity: 'info',
			message: l10n.t(
				'Kodrix: applied "{0}" {1}; pick it in the Kodrix group in Chat. Copilot-side BYOK was not synced — the Kodrix channel is unaffected.',
				name, countSuffix,
			),
		};
	}
	if (res.byokRegistered) {
		return {
			severity: 'info',
			message: l10n.t('Kodrix: registered "{0}" {1} via Copilot BYOK.', name, countSuffix),
		};
	}
	return {
		severity: 'error',
		message: l10n.t('Kodrix: neither channel could be established for "{0}". {1}', name, failureGuidance(res.failureReason)),
	};
}

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
	return `Kodrix: ${providerName}`;
}

interface ByokMirrorOutcome {
	registered: boolean;
	reason?: 'copilot-not-ready' | 'command-failed';
}

async function migrateProviderGroup(
	vendor: string,
	name: string,
	configuration: Record<string, unknown>,
	maxWaitMs: number,
): Promise<ByokMirrorOutcome> {
	const ready = await waitForCopilotReady(maxWaitMs);
	if (!ready) {
		logWarn(`Copilot BYOK 通道在 ${Math.round(maxWaitMs / 1000)}s 内未就绪（vendor=${vendor}），已跳过镜像注册`);
		return { registered: false, reason: 'copilot-not-ready' };
	}
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await vscode.commands.executeCommand('lm.migrateLanguageModelsProviderGroup', {
				vendor,
				name,
				...configuration,
			});
			return { registered: true };
		} catch (err) {
			if (attempt < 3) {
				logWarn(`BYOK 注册重试（第 ${attempt + 1}/4 次，vendor=${vendor}）`, err);
				await new Promise(r => setTimeout(r, byokTiming.mirrorRetryBaseMs * (attempt + 1)));
			} else {
				logWarn(`BYOK 注册失败（已重试 4 次，vendor=${vendor}）`, err);
			}
		}
	}
	return { registered: false, reason: 'command-failed' };
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
			placeHolder: l10n.t('"{0}" detected {1} models; please choose', preset.name, String(discovered.length)),
			canPickMany: true,
		});
		if (!picked?.length) {
			return undefined;
		}
		return picked.map(item => item.id);
	}

	const manual = await vscode.window.showInputBox({
		prompt: l10n.t('"{0}" could not auto-discover models; please enter a model ID', preset.name),
		placeHolder: preset.models?.[0] || l10n.t('e.g. qwen2.5-coder:7b'),
		ignoreFocusOut: true,
	});
	if (!manual?.trim()) {
		return undefined;
	}
	return [manual.trim()];
}

function notify(report: { severity: 'info' | 'warning' | 'error'; message: string }): void {
	if (report.severity === 'error') {
		void vscode.window.showErrorMessage(report.message);
	} else if (report.severity === 'warning') {
		void vscode.window.showWarningMessage(report.message);
	} else {
		void vscode.window.showInformationMessage(report.message);
	}
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
): Promise<ProviderRegistrationResult> {
	const kodrixPathUsable = supportsKodrixNativePath(vendor);
	let stored: StoredProvider | undefined;

	// 先落盘再镜像：Kodrix 自有通道不依赖 Copilot，落盘成功模型就立即可用，
	// 不应该被 Copilot 就绪等待阻塞（此前主路径最坏要白等 60s）。
	if (context) {
		const modelList = getPresetModelCandidates(preset) || [];
		stored = storedProviderFromPreset(preset, modelList, groupName, vendor);
		stored.id = storageKey;
		await saveProviderApiKey(context, storageKey, apiKey);
		await upsertStoredProvider(context, stored);
		notifyKodrixModelsChanged();
	}

	const mirror = await (async () => {
		if (kodrixPathUsable) {
			return migrateProviderGroup(vendor, groupName, { apiKey: apiKey.trim() }, byokTiming.mirrorWaitMs);
		}
		// Gemini 原生接口只有 Copilot BYOK 一条路，等待更长，但必须可见
		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: l10n.t('Kodrix: registering "{0}" via Copilot BYOK (this API does not support the Kodrix direct channel)…', preset.name),
				cancellable: false,
			},
			() => migrateProviderGroup(vendor, groupName, { apiKey: apiKey.trim() }, byokTiming.byokOnlyWaitMs),
		);
	})();

	const usableViaKodrix = !!context && !!stored && kodrixPathUsable;
	if (context && stored) {
		stored.pendingApiKey = !mirror.registered && !kodrixPathUsable;
		await upsertStoredProvider(context, stored);
		notifyKodrixModelsChanged();
		if (usableViaKodrix || mirror.registered) {
			await finalizeProviderActivation(context, stored);
		}
	}

	return {
		usableViaKodrix,
		byokRegistered: mirror.registered,
		failureReason: mirror.reason
			?? (!usableViaKodrix && !mirror.registered ? 'copilot-not-ready' : undefined),
	};
}

export async function registerOllamaEndpoint(
	baseUrl: string,
	preset: ProviderPreset,
	context?: vscode.ExtensionContext,
): Promise<ProviderRegistrationResult> {
	const configTarget = vscode.ConfigurationTarget.Global;
	await safeUpdateConfiguration('github.copilot.chat.byok.ollamaEndpoint', baseUrl, configTarget);

	let stored: StoredProvider | undefined;
	if (context) {
		const models = getPresetModelCandidates(preset) || preset.models || [];
		stored = {
			id: `kodrix-${preset.id}`,
			presetId: preset.id,
			name: preset.name,
			category: 'local',
			api_type: 'ollama',
			base_url: baseUrl,
			model: models[0] || preset.model,
			models,
			groupName: 'Ollama',
			byokVendor: OLLAMA_VENDOR,
			byokGroupName: 'Ollama',
			needs_api_key: false,
			pendingApiKey: false,
			registeredAt: Date.now(),
		};
		await upsertStoredProvider(context, stored);
		notifyKodrixModelsChanged();
	}

	const mirror = await migrateProviderGroup(OLLAMA_VENDOR, 'Ollama', { url: baseUrl }, byokTiming.mirrorWaitMs);

	const usableViaKodrix = !!stored && supportsKodrixNativePath('ollama');
	if (context && stored && (usableViaKodrix || mirror.registered)) {
		await finalizeProviderActivation(context, stored, { fillEmptyRoutesOnly: true });
	}

	return {
		usableViaKodrix,
		byokRegistered: mirror.registered,
		failureReason: mirror.reason,
	};
}

export async function registerCustomEndpointModels(
	storageKey: string,
	providerName: string,
	baseUrl: string,
	modelIds: string[],
	apiKey?: string,
	context?: vscode.ExtensionContext,
	preset?: ProviderPreset,
): Promise<ProviderRegistrationResult> {
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

	const apiType = preset?.api_type || 'openai';
	const kodrixPathUsable = supportsKodrixNativePath(apiType);

	// 先落盘：Kodrix 直连通道可用时，模型立即出现在 Chat 的 Kodrix 分组下
	let stored: StoredProvider | undefined;
	if (context && preset) {
		stored = storedProviderFromPreset(preset, modelIds, groupName, CUSTOM_ENDPOINT_VENDOR);
		stored.id = storageKey;
		stored.base_url = baseUrl;
		stored.pendingApiKey = !apiKey?.trim() && !!preset.needs_api_key;
		await saveProviderApiKey(context, storageKey, apiKey);
		await upsertStoredProvider(context, stored);
		notifyKodrixModelsChanged();
	}

	const mirror = await migrateProviderGroup(CUSTOM_ENDPOINT_VENDOR, groupName, configuration, byokTiming.mirrorWaitMs);

	const usableViaKodrix = !!stored && kodrixPathUsable;
	if (context && stored && (usableViaKodrix || mirror.registered)) {
		await finalizeProviderActivation(context, stored);
	}

	return {
		usableViaKodrix,
		byokRegistered: mirror.registered,
		failureReason: mirror.reason,
	};
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
		const res = await registerOllamaEndpoint(resolved.base_url, resolved, context);
		notify(describeRegistration(resolved.name, res));
		return;
	}

	if (resolved.api_type === 'anthropic' || resolved.api_type === 'gemini') {
		const groupName = resolved.api_type === 'anthropic' ? 'Anthropic' : 'Google';
		const storageKey = `kodrix-${resolved.id}`;
		if (!apiKey?.trim()) {
			if (context) {
				await registerPendingNativeVendor(resolved.api_type, groupName, storageKey, resolved, context);
			}
			const choice = await vscode.window.showInformationMessage(
				l10n.t('"{0}" saved. Pick a model under Kodrix in Chat — no GitHub sign-in needed.', resolved.name),
				l10n.t('Open Provider Management'),
			);
			if (choice === l10n.t('Open Provider Management')) {
				await vscode.commands.executeCommand('kodrix.openProviderWorkbench');
			}
			return;
		}
		const res = await registerNativeVendor(
			resolved.api_type,
			groupName,
			apiKey,
			storageKey,
			resolved,
			context,
		);
		notify(describeRegistration(resolved.name, res));
		return;
	}

	if (!resolved.base_url?.trim()) {
		const baseUrl = await vscode.window.showInputBox({
			prompt: l10n.t('Enter an OpenAI-compatible API base URL'),
			placeHolder: 'https://api.example.com/v1',
			ignoreFocusOut: true,
		});
		if (!baseUrl?.trim()) {
			vscode.window.showWarningMessage(l10n.t('Kodrix: cancelled — no API URL entered'));
			return;
		}
		resolved = { ...resolved, base_url: baseUrl.trim() };
	}

	const modelIds = await resolveModelsForPreset(resolved, resolved.base_url, apiKey);
	if (!modelIds?.length) {
		vscode.window.showWarningMessage(l10n.t('Kodrix: cancelled — no model selected'));
		return;
	}

	const storageKey = `kodrix-${resolved.id}`;
	if (resolved.needs_api_key && !apiKey?.trim() && context) {
		await storePendingProvider(context, resolved, storageKey, groupNameFor(resolved.name), {
			base_url: resolved.base_url,
			model: modelIds[0],
			models: modelIds,
		});
	}

	const res = await registerCustomEndpointModels(
		storageKey,
		resolved.name,
		resolved.base_url,
		modelIds,
		apiKey,
		context,
		resolved,
	);

	if (resolved.needs_api_key && !apiKey?.trim()) {
		const choice = await vscode.window.showInformationMessage(
			l10n.t('"{0}" saved. Fill in the API Key before making actual requests.', resolved.name),
			l10n.t('Open Provider Management'),
		);
		if (choice === l10n.t('Open Provider Management')) {
			await vscode.commands.executeCommand('kodrix.openProviderWorkbench');
		}
		return;
	}

	notify(describeRegistration(resolved.name, res, modelIds.length));
}

/**
 * 移除供应商时，同步摘掉它在 Copilot BYOK 里注册的供应商组。
 * core 的 `lm.removeLanguageModelsProviderGroup` 会一并删除该组在密钥存储里的条目，
 * 因此 Kodrix 侧 SecretStorage 与 BYOK 侧的密钥不会留下任何一个。
 * 面板内新增的供应商（byokVendor 为空）没有 BYOK 组，直接跳过；组不存在（注册失败或用户已手工删除）也不算错误。
 */
export async function removeByokProviderGroup(provider: StoredProvider): Promise<void> {
	const vendor = provider.byokVendor;
	const name = provider.byokGroupName;
	if (!vendor || !name) {
		return;
	}
	try {
		await vscode.commands.executeCommand('lm.removeLanguageModelsProviderGroup', { vendor, name });
	} catch (err) {
		logWarn(`移除 BYOK 供应商组失败（vendor=${vendor}，name=${name}），可能未注册成功或已被手动删除`, err);
	}
}

/**
 * 重新应用一个已登记的供应商：写入 activeProviderId、同步路由，并**重新尝试 BYOK 镜像注册**。
 * 供应商面板的「设为当前供应商」调用它，使镜像曾经失败的供应商有机会自愈
 * （此前该函数无人调用，镜像失败后用户在 UI 里没有任何修复入口）。
 * 需要真实 API Key 的供应商若 Key 尚未保存，返回 usableViaKodrix=false 且 failureReason 保持原样。
 */
export async function reapplyStoredProvider(
	context: vscode.ExtensionContext,
	provider: StoredProvider,
	presets: ProviderPreset[],
	apiKey?: string,
): Promise<ProviderRegistrationResult> {
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

	if (provider.needs_api_key && !apiKey?.trim()) {
		return { usableViaKodrix: false, byokRegistered: false, failureReason: 'missing-api-key' };
	}

	let res: ProviderRegistrationResult;
	if (provider.api_type === 'ollama') {
		res = await registerOllamaEndpoint(provider.base_url, preset, context);
	} else if (provider.api_type === 'anthropic' || provider.api_type === 'gemini') {
		const groupName = provider.api_type === 'anthropic' ? 'Anthropic' : 'Google';
		res = await registerNativeVendor(
			provider.api_type,
			groupName,
			apiKey || '',
			provider.id,
			preset,
			context,
		);
	} else {
		const modelIds = provider.models.length
			? provider.models
			: (provider.model ? [provider.model] : []);
		if (!modelIds.length) {
			return { usableViaKodrix: false, byokRegistered: false, failureReason: 'missing-model' };
		}
		res = await registerCustomEndpointModels(
			provider.id,
			provider.name,
			provider.base_url,
			modelIds,
			apiKey,
			context,
			preset,
		);
	}

	if (res.usableViaKodrix || res.byokRegistered) {
		const updated = loadStoredProviders(context).find(p => p.id === provider.id) || provider;
		await context.globalState.update('kodrix.activeProviderId', provider.id);
		await syncFromStoredProvider({ ...updated, pendingApiKey: false });
	}
	return res;
}
