/*---------------------------------------------------------------------------------------------
 *  Kodrix — AI 供应商共享类型
 *--------------------------------------------------------------------------------------------*/

export interface ProviderPreset {
	id: string;
	category: string;
	name: string;
	api_type: string;
	base_url: string;
	model: string;
	models?: string[];
	needs_api_key?: boolean;
	hint?: string;
	icon?: string; // codicon 名，如 server / robot；QuickPick 用 $(name)
	featured?: boolean;
	website?: string;
}

export interface StoredProvider {
	id: string;
	presetId?: string;
	name: string;
	category: 'local' | 'cloud';
	api_type: string;
	base_url: string;
	model: string;
	models: string[];
	groupName: string;
	/** 该供应商在 Copilot BYOK 里注册的 vendor 与组名；仅经预设流程注册时存在，面板内新增的没有 */
	byokVendor?: string;
	byokGroupName?: string;
	needs_api_key: boolean;
	pendingApiKey?: boolean;
	registeredAt: number;
}

export interface ModelRouteEntry {
	model?: string;
}

export type ModelRoutes = Record<string, ModelRouteEntry>;
