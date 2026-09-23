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
	icon?: string;
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
	needs_api_key: boolean;
	pendingApiKey?: boolean;
	registeredAt: number;
}

export interface ModelRouteEntry {
	model?: string;
}

export type ModelRoutes = Record<string, ModelRouteEntry>;
