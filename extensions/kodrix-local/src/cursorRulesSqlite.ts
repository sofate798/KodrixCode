/*---------------------------------------------------------------------------------------------
 *  Kodrix — 从 Cursor state.vscdb 导入 User Rules
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import { logWarn } from './logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CURSOR_STATE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const LEGACY_RULES_KEY = 'aicontext.personalContext';

export function resolveCursorStateDbPath(): string | undefined {
	const candidates: string[] = [];
	switch (process.platform) {
		case 'win32':
			if (process.env.APPDATA) {
				candidates.push(path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
			}
			break;
		case 'darwin':
			candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
			break;
		default:
			candidates.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
			break;
	}
	return candidates.find(p => fs.existsSync(p));
}

const ALLOWED_ITEM_KEYS = new Set([
	'vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
	'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
	'vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.globalUser',
	'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.globalUser',
	'ai.context.personalContext',
	'aicontext.personalContext',
	'ai.context.workspaceContext',
]);

function readItemTableValue(dbPath: string, key: string): string | undefined {
	if (!/^[a-zA-Z0-9_\-.:]+$/.test(key)) {
		throw new Error(`Invalid ItemTable key charset: ${key}`);
	}
	if (!ALLOWED_ITEM_KEYS.has(key)) {
		throw new Error(`Untrusted ItemTable key: ${key}`);
	}
	const escapedKey = key.replace(/'/g, "''");
	try {
		const out = execFileSync('sqlite3', [dbPath, `.mode line
SELECT value FROM ItemTable WHERE key = '${escapedKey}'`], {
			encoding: 'utf-8',
			timeout: 8000,
			windowsHide: true,
		});
		const trimmed = out.trim();
		return trimmed || undefined;
	} catch (err) {
		logWarn('sqlite3 CLI 读取失败，回退到二进制扫描', err);
		return readItemTableValueFallback(dbPath, key);
	}
}

function readItemTableValueFallback(dbPath: string, key: string): string | undefined {
	try {
		const buf = fs.readFileSync(dbPath);
		const needle = Buffer.from(key, 'utf-8');
		const idx = buf.indexOf(needle);
		if (idx < 0) {
			return undefined;
		}
		const slice = buf.subarray(idx, Math.min(buf.length, idx + 65536)).toString('utf-8');
		const jsonStart = slice.indexOf('{');
		const mdStart = slice.indexOf('#');
		const textStart = slice.indexOf('\n', key.length);
		if (jsonStart >= 0 && (mdStart < 0 || jsonStart < mdStart)) {
			let depth = 0;
			for (let i = jsonStart; i < slice.length; i++) {
				if (slice[i] === '{') {
					depth++;
				} else if (slice[i] === '}') {
					depth--;
					if (depth === 0) {
						return slice.slice(jsonStart, i + 1);
					}
				}
			}
		}
		if (textStart >= 0) {
			return slice.slice(textStart + 1).trim().split('\0')[0].trim();
		}
	} catch (err) {
		logWarn('二进制扫描 state.vscdb 失败', err);
	}
	return undefined;
}

function extractRulesText(raw: string | undefined): string | undefined {
	if (!raw?.trim()) {
		return undefined;
	}
	const trimmed = raw.trim();
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			const candidates = [
				parsed.personalContext,
				parsed.userRules,
				parsed.rules,
				parsed.text,
				parsed.content,
			];
			for (const c of candidates) {
				if (typeof c === 'string' && c.trim()) {
					return c.trim();
				}
			}
			const composer = parsed.composerState as Record<string, unknown> | undefined;
			if (typeof composer?.yoloPrompt === 'string' && composer.yoloPrompt.trim()) {
				return composer.yoloPrompt.trim();
			}
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

export function importCursorUserRulesFromSqlite(): { imported: boolean; destPath?: string; source?: string } {
	const dbPath = resolveCursorStateDbPath();
	if (!dbPath) {
		return { imported: false };
	}

	const legacyRules = extractRulesText(readItemTableValue(dbPath, LEGACY_RULES_KEY));
	const appUserRaw = readItemTableValue(dbPath, CURSOR_STATE_KEY);
	let appUserRules: string | undefined;
	if (appUserRaw?.trim().startsWith('{')) {
		try {
			const parsed = JSON.parse(appUserRaw) as { composerState?: { yoloPrompt?: string; userRules?: string } };
			appUserRules = parsed.composerState?.userRules?.trim() || parsed.composerState?.yoloPrompt?.trim();
		} catch (err) {
			logWarn('解析 Cursor composerState JSON 失败', err);
		}
	}

	const rulesText = legacyRules || appUserRules;
	if (!rulesText) {
		return { imported: false };
	}

	const destRoot = path.join(os.homedir(), '.kodrix', 'instructions');
	fs.mkdirSync(destRoot, { recursive: true });
	const destPath = path.join(destRoot, 'cursor-user-rules.instructions.md');
	const source = legacyRules ? LEGACY_RULES_KEY : CURSOR_STATE_KEY;

	if (fs.existsSync(destPath)) {
		const existing = fs.readFileSync(destPath, 'utf-8');
		if (existing.includes(rulesText)) {
			return { imported: false, destPath, source };
		}
	}

	const content = [
		'<!-- 由 Kodrix 从 Cursor state.vscdb 导入 -->',
		`<!-- 来源 key: ${source} -->`,
		'',
		rulesText,
	].join('\n');
	fs.writeFileSync(destPath, content, 'utf-8');
	return { imported: true, destPath, source };
}
