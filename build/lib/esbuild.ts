/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as path from 'path';

const root = path.resolve(import.meta.dirname, '../..');

// Build timeout: 30 minutes for bundle (large projects), 10 minutes for transpile
const TRANSPILE_TIMEOUT_MS = 10 * 60 * 1000;
const BUNDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface SpawnResult {
	proc: cp.ChildProcess;
	timer: ReturnType<typeof setTimeout> | null;
}

function spawnWithTimeout(args: string[], timeoutMs: number): SpawnResult {
	const proc = cp.spawn(process.execPath, args, {
		cwd: root,
		stdio: 'inherit'
	});

	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		console.error(`[esbuild] Build timed out after ${timeoutMs / 1000}s, killing process...`);
		try {
			if (proc.pid) {
				// On Windows, tree-kill is more reliable for child processes
				if (process.platform === 'win32') {
					cp.spawnSync('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' });
				} else {
					proc.kill('SIGKILL');
				}
			}
		} catch {
			// Best effort cleanup
		}
	}, timeoutMs);

	return { proc, timer: killed ? null : timer };
}

/**
 * esbuild-based transpile task (drop-in replacement for tsc transpile).
 * Transpiles TypeScript source to JavaScript without type checking.
 */
export function runEsbuildTranspile(outDir: string, excludeTests: boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const scriptPath = path.join(root, 'build/next/index.ts');
		const args = [scriptPath, 'transpile', '--out', outDir];
		if (excludeTests) {
			args.push('--exclude-tests');
		}

		const { proc, timer } = spawnWithTimeout(args, TRANSPILE_TIMEOUT_MS);
		let settled = false;

		proc.on('error', (err) => {
			if (!settled) {
				settled = true;
				if (timer) { clearTimeout(timer); }
				reject(new Error(`esbuild transpile spawn error: ${err.message}`));
			}
		});

		proc.on('close', (code) => {
			if (!settled) {
				settled = true;
				if (timer) { clearTimeout(timer); }
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`esbuild transpile failed with exit code ${code} (outDir: ${outDir})`));
				}
			}
		});
	});
}

/**
 * esbuild-based bundle task (drop-in replacement for bundle-vscode / minify-vscode).
 * Produces the final bundled output for a specific platform target.
 */
export function runEsbuildBundle(outDir: string, minify: boolean, nls: boolean, target: 'desktop' | 'server' | 'server-web' = 'desktop', sourceMapBaseUrl?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const scriptPath = path.join(root, 'build/next/index.ts');
		const args = [scriptPath, 'bundle', '--out', outDir, '--target', target];
		if (minify) {
			args.push('--minify');
			args.push('--mangle-privates');
		}
		if (nls) {
			args.push('--nls');
		}
		if (sourceMapBaseUrl) {
			args.push('--source-map-base-url', sourceMapBaseUrl);
		}

		const { proc, timer } = spawnWithTimeout(args, BUNDLE_TIMEOUT_MS);
		let settled = false;

		proc.on('error', (err) => {
			if (!settled) {
				settled = true;
				if (timer) { clearTimeout(timer); }
				reject(new Error(`esbuild bundle spawn error: ${err.message}`));
			}
		});

		proc.on('close', (code) => {
			if (!settled) {
				settled = true;
				if (timer) { clearTimeout(timer); }
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`esbuild bundle failed with exit code ${code} (outDir: ${outDir}, minify: ${minify}, nls: ${nls}, target: ${target})`));
				}
			}
		});
	});
}
