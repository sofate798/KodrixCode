/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ESLint } from 'eslint';
import { availableParallelism } from 'os';
import { eslintFilter } from './filters.ts';

/**
 * Worker 并发数。
 * `'auto'` 按 CPU 数起 worker：在 32 核机器上会同时起 32 个 worker，
 * 触发 `ERR_WORKER_OUT_OF_MEMORY` / `DataCloneError: ... out of memory`，让门禁假红。
 * 默认封顶 8（CI 的 4 核机器不受影响），可用 KODRIX_ESLINT_CONCURRENCY 显式覆盖。
 */
function eslintConcurrency(): number {
	const override = Number(process.env['KODRIX_ESLINT_CONCURRENCY']);
	if (Number.isFinite(override) && override > 0) {
		return Math.floor(override);
	}
	return Math.max(1, Math.min(availableParallelism?.() ?? 4, 8));
}

async function eslint(): Promise<void> {
	const linter = new ESLint({
		cache: true,
		cacheLocation: '.eslintcache',
		cacheStrategy: 'content',
		concurrency: eslintConcurrency(),
		errorOnUnmatchedPattern: false,
	});
	const formatter = await linter.loadFormatter('compact');

	const results = await linter.lintFiles(Array.from(eslintFilter));
	const message = await formatter.format(results);
	if (message) {
		console.log(message);
	}

	let warningCount = 0;
	let errorCount = 0;
	for (const r of results) {
		warningCount += r.warningCount;
		errorCount += r.errorCount;
	}
	if (warningCount > 0 || errorCount > 0) {
		throw new Error(`eslint failed with ${warningCount + errorCount} warnings and/or errors`);
	}
}

if (import.meta.main) {
	eslint().catch((err) => {
		console.error();
		console.error(err);
		process.exit(1);
	});
}
