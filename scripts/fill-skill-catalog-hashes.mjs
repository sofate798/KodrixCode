#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*
 * 校验/补齐 Skill catalog 里远程条目的 sha256。
 *
 * 背景：kodrix-skills 安装远程 zip 时会强制校验 catalog 声明的 sha256（不匹配即拒装），
 * 但哈希必须由发布方在发布前生成。本脚本就是那个发布步骤，也可在 CI 里用 --check 兜住
 * "新增了 downloadUrl 却没写哈希" 的情况。
 *
 * 用法：
 *   node scripts/fill-skill-catalog-hashes.mjs            # 检查（默认）：报告缺失/不匹配
 *   node scripts/fill-skill-catalog-hashes.mjs --check    # 同上，缺失/不匹配时 exit 1（CI 用）
 *   node scripts/fill-skill-catalog-hashes.mjs --fix      # 下载并按实际内容写入 sha256
 *
 * 说明：仅处理带 downloadUrl 的条目（bundle 是扩展内置的本地文件，由 VS Code 的扩展完整性机制保护）。
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultCatalogs = [
	join(repoRoot, 'extensions', 'kodrix-skills', 'resources', 'catalog.json'),
	join(repoRoot, 'marketplace', 'catalog.json'),
];

// --catalog <path> 可重复传入，便于验证脚本本身（默认检查仓库里的两套 catalog）
const catalogArgs = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--catalog' && argv[i + 1]) {
		catalogArgs.push(resolve(argv[++i]));
	}
}
const catalogs = catalogArgs.length ? catalogArgs : defaultCatalogs;

const mode = argv.includes('--fix') ? 'fix'
	: argv.includes('--check') ? 'check'
		: 'report';

function sha256(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

async function fetchBytes(url) {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

let missing = 0;
let mismatched = 0;
let verified = 0;
let remoteItems = 0;

for (const catalogPath of catalogs) {
	// 容忍 UTF-8 BOM（历史上有文件带 BOM，JSON.parse 会直接报错）
	const raw = readFileSync(catalogPath, 'utf-8').replace(/^\uFEFF/, '');
	let catalog;
	try {
		catalog = JSON.parse(raw);
	} catch (error) {
		mismatched++;
		console.error(`[${mode}] ${catalogPath}: JSON 解析失败 — ${error instanceof Error ? error.message : String(error)}`);
		continue;
	}
	const items = Array.isArray(catalog.items) ? catalog.items : [];
	let changed = false;

	for (const item of items) {
		if (!item.downloadUrl) {
			continue;
		}
		remoteItems++;
		const expected = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : undefined;

		if (mode === 'fix') {
			try {
				const actual = sha256(await fetchBytes(item.downloadUrl));
				if (actual !== expected) {
					item.sha256 = actual;
					changed = true;
					console.log(`[fix] ${item.id}: sha256 ${expected ?? '(缺失)'} → ${actual}`);
				} else {
					verified++;
					console.log(`[fix] ${item.id}: 已是最新 ${actual}`);
				}
			} catch (error) {
				mismatched++;
				console.error(`[fix] ${item.id}: 下载失败，保持原值 — ${error instanceof Error ? error.message : String(error)}`);
			}
			continue;
		}

		if (!expected) {
			missing++;
			console.error(`[${mode}] ${item.id}: 有 downloadUrl 但未声明 sha256（运行 --fix 生成）`);
			continue;
		}
		if (!/^[0-9a-f]{64}$/.test(expected)) {
			mismatched++;
			console.error(`[${mode}] ${item.id}: sha256 不是 64 位 hex`);
			continue;
		}
		verified++;
		console.log(`[${mode}] ${item.id}: sha256 已声明 ${expected.slice(0, 12)}…`);
	}

	if (changed) {
		writeFileSync(catalogPath, `${JSON.stringify(catalog, undefined, '\t')}\n`, 'utf-8');
		console.log(`[fix] 已写回 ${catalogPath}`);
	}
}

console.log(`\n远程条目 ${remoteItems} 个：已校验 ${verified}，缺哈希 ${missing}，不合法/不匹配 ${mismatched}`);
if (remoteItems === 0) {
	console.log('当前两套 catalog 全部使用本地 bundle，没有需要哈希的远程条目（代码已就绪，加入 downloadUrl 时本脚本会强制补哈希）。');
}
if (mode === 'check' && (missing > 0 || mismatched > 0)) {
	process.exit(1);
}
