/*---------------------------------------------------------------------------------------------
 *  Minicode Local — Shared Path Utilities
 *  Centralizes all file path resolution to avoid duplication across modules.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

/** Resolve a path relative to the user's home directory (supports ~/ prefix) */
export function resolveHomePath(input: string): string {
	if (input.startsWith('~')) {
		return path.join(os.homedir(), input.slice(1).replace(/^[/\\]/, ''));
	}
	return input;
}

/** Ensure a directory exists, creating it recursively if needed */
export function ensureDir(fs: { mkdirSync: (p: string, opts?: { recursive: boolean }) => void }, dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/** Validate that a resolved path stays within a base directory (path traversal check) */
export function isWithin(base: string, target: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedTarget = path.resolve(target);
	return resolvedTarget.startsWith(resolvedBase) && resolvedTarget !== resolvedBase;
}

/** Get the Minicode user config directory (platform-aware) */
export function getMinicodeUserDir(): string {
	const productName = process.env.VSCODE_DEV ? 'code-oss-dev' : 'Minicode';
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, productName);
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', productName);
	}
	const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
	return path.join(xdg, productName.toLowerCase());
}
