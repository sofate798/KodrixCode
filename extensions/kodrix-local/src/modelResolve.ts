/*---------------------------------------------------------------------------------------------
 *  Kodrix — 模型 ID 解析（交互 / 静默）
 *--------------------------------------------------------------------------------------------*/

import { ProviderPreset } from './types';
import { discoverOpenAIModels } from './modelDiscovery';

/** 预设中声明的模型列表（去重，主模型优先）。无声明时返回 undefined 表示需探测。 */
export function getPresetModelCandidates(preset: ProviderPreset): string[] | undefined {
	const fromList = (preset.models || []).map(m => m.trim()).filter(Boolean);
	const primary = preset.model?.trim();
	if (fromList.length > 0) {
		const ordered = new Set<string>();
		if (primary) {
			ordered.add(primary);
		}
		for (const id of fromList) {
			ordered.add(id);
		}
		return [...ordered];
	}
	if (primary) {
		return [primary];
	}
	return undefined;
}

/**
 * 迁移或后台注册：不弹 UI。有预设列表则注册全部声明模型；否则最多返回一个探测结果。
 */
export async function resolveModelsForSilentRegistration(
	preset: ProviderPreset,
	baseUrl: string,
	explicitModel?: string,
	apiKey?: string,
): Promise<string[]> {
	if (explicitModel?.trim()) {
		return [explicitModel.trim()];
	}
	const candidates = getPresetModelCandidates(preset);
	if (candidates?.length) {
		return candidates;
	}
	const discovered = await discoverOpenAIModels(baseUrl, apiKey);
	if (discovered.length > 0) {
		return [discovered[0]];
	}
	return [];
}
