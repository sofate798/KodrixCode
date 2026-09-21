/*---------------------------------------------------------------------------------------------
 *  Minicode — 已配置 AI 供应商持久化
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderPreset, StoredProvider, ModelRoutes } from './types';

const PROVIDERS_KEY = 'minicode.providers';
const ACTIVE_PROVIDER_KEY = 'minicode.activeProviderId';

export type { StoredProvider, ModelRoutes, ModelRouteEntry } from './types';

export function loadStoredProviders(context: vscode.ExtensionContext): StoredProvider[] {
	return context.globalState.get<StoredProvider[]>(PROVIDERS_KEY, []);
}

export function getActiveProviderId(context: vscode.ExtensionContext): string | undefined {
	return context.globalState.get<string>(ACTIVE_PROVIDER_KEY);
}

export async function upsertStoredProvider(
	context: vscode.ExtensionContext,
	provider: StoredProvider,
	options?: { setActive?: boolean },
): Promise<void> {
	const existing = loadStoredProviders(context);
	const index = existing.findIndex(p => p.id === provider.id);
	if (index >= 0) {
		existing[index] = provider;
	} else {
		existing.push(provider);
	}
	await context.globalState.update(PROVIDERS_KEY, existing);
	if (options?.setActive !== false) {
		await context.globalState.update(ACTIVE_PROVIDER_KEY, provider.id);
	}
}

export async function storePendingProvider(
	context: vscode.ExtensionContext,
	preset: ProviderPreset,
	storageKey: string,
	groupName: string,
	overrides?: Partial<StoredProvider>,
): Promise<void> {
	const models = preset.models?.length
		? preset.models
		: (preset.model ? [preset.model] : []);
	const stored: StoredProvider = {
		id: storageKey,
		presetId: preset.id,
		name: preset.name,
		category: preset.category === 'local' ? 'local' : 'cloud',
		api_type: preset.api_type,
		base_url: preset.base_url,
		model: models[0] || preset.model,
		models,
		groupName,
		needs_api_key: !!preset.needs_api_key,
		pendingApiKey: true,
		registeredAt: Date.now(),
		...overrides,
	};
	await upsertStoredProvider(context, stored, { setActive: false });
}

export async function removeStoredProvider(
	context: vscode.ExtensionContext,
	providerId: string,
): Promise<void> {
	const existing = loadStoredProviders(context).filter(p => p.id !== providerId);
	await context.globalState.update(PROVIDERS_KEY, existing);
	const active = getActiveProviderId(context);
	if (active === providerId) {
		await context.globalState.update(ACTIVE_PROVIDER_KEY, existing[0]?.id);
	}
}

export function loadModelRoutes(): ModelRoutes {
	return vscode.workspace.getConfiguration('minicode').get<ModelRoutes>('modelRoutes', {});
}

export async function saveModelRoutes(routes: ModelRoutes): Promise<void> {
	await vscode.workspace.getConfiguration('minicode').update(
		'modelRoutes',
		routes,
		vscode.ConfigurationTarget.Global,
	);
}

export function storedProviderFromPreset(
	preset: ProviderPreset,
	models: string[],
	groupName: string,
): StoredProvider {
	return {
		id: `minicode-${preset.id}`,
		presetId: preset.id,
		name: preset.name,
		category: preset.category === 'local' ? 'local' : 'cloud',
		api_type: preset.api_type,
		base_url: preset.base_url,
		model: models[0] || preset.model,
		models,
		groupName,
		needs_api_key: !!preset.needs_api_key,
		pendingApiKey: false,
		registeredAt: Date.now(),
	};
}
