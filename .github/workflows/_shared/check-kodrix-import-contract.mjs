#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*---------------------------------------------------------------------------------------------
 *  Kodrix — import 入库契约检查
 *
 *  防的是一类具体事故：生产代码 `import ... from './zipValidation'`，而该文件从未 `git add`。
 *  本机自测全绿（文件在磁盘上），但 CI 与新克隆的人一编译就炸——而且 lint/typecheck 之外的
 *  任何“本地跑一下”都发现不了。
 *
 *  做法：对三个 Kodrix 扩展的源文件，解析所有相对 import，要求目标文件存在于 **git 索引**
 *  （CI 里索引即当前提交的树），而不只是存在于磁盘。
 *
 *  用法：node .github/workflows/_shared/check-kodrix-import-contract.mjs [--verbose]
 *  退出码：0 = 全部解析且已入库；1 = 存在未解析或未入库引用。
 *
 *  已知局限：模板字符串里的合成代码会被当作 import 扫描，因此跳过含反引号的行；
 *  这对本仓库的真实 import 语法（独立成行、单/双引号）没有影响。
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const verbose = process.argv.includes('--verbose');

/** 只扫描自有扩展；整仓 src/vs 由上游 tsc 覆盖 */
const TARGETS = ['kodrix-local', 'kodrix-agent-os', 'kodrix-skills'];
const MODULE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js'];

/**
 * 以 git 索引为准（不是磁盘）：这样才能抓到「磁盘上有、仓库里没有」。
 * 限定到目标目录，避免在 VS Code 分支上撑爆子进程缓冲。
 */
function trackedFiles() {
	const output = execFileSync('git', ['ls-files', '--cached', '--', ...TARGETS.map(t => `extensions/${t}`)], {
		cwd: repoRoot,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	return new Set(output.split('\n').filter(Boolean));
}

function resolveSpecifier(fromAbsolute, spec) {
	const base = resolve(dirname(fromAbsolute), spec);
	const attempts = [];
	for (const ext of MODULE_EXTS) {
		attempts.push(base + ext, join(base, 'index' + ext));
	}
	attempts.push(base);
	return attempts.find(candidate => existsSync(candidate));
}

const index = trackedFiles();
const indexFiles = [...index].filter(file => /^extensions\/kodrix-[^/]+\/src\/.*\.tsx?$/.test(file));

let checked = 0;
const unresolved = [];
const untracked = [];

for (const file of indexFiles) {
	const absolute = join(repoRoot, file);
	const lines = readFileSync(absolute, 'utf8').split('\n');

	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];
		if (text.includes('`')) {
			continue; // 模板字符串内的合成代码，不是真 import
		}
		const match = /(?:^|\s)(?:from|import)\s+['"](\.[^'"]*)['"]/.exec(text);
		if (!match) { continue; }

		checked++;
		const onDisk = resolveSpecifier(absolute, match[1]);
		if (!onDisk) {
			unresolved.push(`${file}:${line + 1} -> ${match[1]}`);
			continue;
		}
		const relative = onDisk.slice(repoRoot.length + 1).replaceAll('\\', '/');
		if (!index.has(relative)) {
			untracked.push(`${file}:${line + 1} -> ${match[1]}（磁盘上有、索引里没有：${relative}）`);
		}
	}
}

console.log('Kodrix import contract check');
console.log('============================');
console.log(`  扫描源文件: ${indexFiles.length}`);
TARGETS.forEach(target => {
	const count = indexFiles.filter(f => f.startsWith(`extensions/${target}/`)).length;
	console.log(`  ${target.padEnd(18)} 文件=${count}`);
});
console.log(`  相对 import 检查数: ${checked}`);

if (unresolved.length || untracked.length) {
	if (unresolved.length) {
		console.log('');
		console.log(`FAIL — ${unresolved.length} 处 import 无法解析:`);
		unresolved.forEach(item => console.log(`  ::error file=${item} • 目标文件不存在`));
	}
	if (untracked.length) {
		console.log('');
		console.log(`FAIL — ${untracked.length} 处 import 指向未入库文件（新克隆会编译失败）:`);
		untracked.forEach(item => console.log(`  ::error ${item}`));
	}
	process.exit(1);
}

if (verbose) {
	console.log('  （--verbose）全部引用均可解析且已入库');
}
console.log('');
console.log('PASS — 每个被引用的源文件都存在于 git 索引，新克隆可编译');
