/*---------------------------------------------------------------------------------------------
 *  Kodrix — 供应商与 Copilot 默认模型同步
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StoredProvider } from './types';
import { loadModelRoutes, saveModelRoutes } from './providerStore';
import { safeUpdateConfiguration } from './safeConfigUpdate';

export function primaryModelFromProvider(provider: StoredProvider): string | undefined {
	if (provider.model?.trim()) {
		return provider.model.trim();
	}
	return provider.models.find(m => m.trim()) || undefined;
}

/**
 * 将当前供应商的主模型同步到 Chat 默认模型与 kodrix 路由（未手动配置的路由项）。
 * Copilot 专属键（如 implementAgent.model）在未注册时会跳过，不阻断供应商保存。
 */
export async function syncDefaultChatModels(
	primaryModel: string,
	options?: { fillEmptyRoutesOnly?: boolean },
): Promise<void> {
	const target = vscode.ConfigurationTarget.Global;
	const model = primaryModel.trim();
	if (!model) {
		return;
	}

	await safeUpdateConfiguration('chat.planAgent.defaultModel', model, target);
	await safeUpdateConfiguration('github.copilot.chat.implementAgent.model', model, target);
	await safeUpdateConfiguration('chat.exploreAgent.defaultModel', model, target);
	await safeUpdateConfiguration('chat.utilitySmallModel', model, target);

	const existing = loadModelRoutes();
	const routes = { ...existing };
	const keys = ['plan', 'agent', 'code', 'fast'] as const;
	for (const key of keys) {
		if (options?.fillEmptyRoutesOnly && existing[key]?.model?.trim()) {
			continue;
		}
		routes[key] = { model };
	}
	await saveModelRoutes(routes);
}

export async function syncFromStoredProvider(
	provider: StoredProvider,
	options?: { fillEmptyRoutesOnly?: boolean },
): Promise<void> {
	const primary = primaryModelFromProvider(provider);
	if (primary) {
		await syncDefaultChatModels(primary, options);
	}
}
