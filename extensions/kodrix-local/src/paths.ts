/*---------------------------------------------------------------------------------------------
 *  Kodrix Local — Shared Path Utilities
 *  Centralizes all file path resolution to avoid duplication across modules.
 *--------------------------------------------------------------------------------------------*/

/** Ensure a directory exists, creating it recursively if needed */
export function ensureDir(fs: { mkdirSync: (p: string, opts?: { recursive: boolean }) => void }, dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}
