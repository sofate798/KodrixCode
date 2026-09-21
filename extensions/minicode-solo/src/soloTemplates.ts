/*---------------------------------------------------------------------------------------------
 *  SOLO Templates — Shared type and loader
 *  Centralizes template definitions to eliminate duplication across modules.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

export interface SoloTemplate {
	id: string;
	name: string;
	description?: string;
	category?: string;
	init_commands?: string[];
	run_command?: string;
	run_port?: number;
}

// 模板缓存：避免每次预览/构建都重新读取并解析 templates.json
const _templateCache = new Map<string, SoloTemplate[]>();

/**
 * Load SOLO project templates from the extension's resources directory.
 * Results are cached per extension path. Returns an empty array if the file
 * is missing or malformed.
 */
export function loadTemplates(extensionPath: string): SoloTemplate[] {
	const cached = _templateCache.get(extensionPath);
	if (cached) {
		return cached;
	}
	const p = path.join(extensionPath, 'resources', 'templates.json');
	try {
		const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
		const templates: SoloTemplate[] = Array.isArray(data?.templates) ? data.templates : [];
		_templateCache.set(extensionPath, templates);
		return templates;
	} catch {
		return [];
	}
}

/**
 * Clear cached SOLO resources (template cache). Called on extension deactivate.
 */
export function disposeSoloChannels(): void {
	_templateCache.clear();
}

/**
 * Detect which template best matches a given text description.
 * Uses keyword matching against template IDs.
 */
export function detectTemplate(text: string, templates: SoloTemplate[]): SoloTemplate | undefined {
	const lower = text.toLowerCase();
	for (const t of templates) {
		if (lower.includes(t.id) || lower.includes(t.id.replace('-', ' '))) {
			return t;
		}
	}
	if (/react|vite|待办|todo|web|frontend/.test(lower)) {
		return templates.find(t => t.id === 'react-vite');
	}
	if (/vue/.test(lower)) {
		return templates.find(t => t.id === 'vue-vite');
	}
	if (/fastapi|python.*api/.test(lower)) {
		return templates.find(t => t.id === 'fastapi-backend');
	}
	if (/flask/.test(lower)) {
		return templates.find(t => t.id === 'flask-backend');
	}
	return undefined;
}
