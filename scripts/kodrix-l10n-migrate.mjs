#!/usr/bin/env node
/*
 * kodrix-l10n-migrate.mjs — 一次性迁移工具：把扩展源码里的 `l10n.t('中文源'…)` 键
 * 与 webview HTML 里的 `{{l10n:中文源}}` 占位按 zh→en 映射表批量改写为英文源。
 *
 * 用法：node scripts/kodrix-l10n-migrate.mjs --ext kodrix-local --map <zh→en.json>
 * 输出：改写统计 + 未映射键清单（未映射的保持原样，便于补齐映射后重跑）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const getOpt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ext = getOpt('--ext');
const mapPath = getOpt('--map');
if (!ext || !mapPath) {
	console.error('用法: node scripts/kodrix-l10n-migrate.mjs --ext <extension> --map <zh→en.json>');
	process.exit(1);
}
const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));

/** JS 字面量本体（已去引号）→ 按目标引号转义 */
function escapeFor(body, quote) {
	return body
		.replace(/\\/g, '\\\\')
		.replace(new RegExp(quote === '`' ? '`' : quote, 'g'), '\\' + quote)
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');
}

/** JS 字符串字面量本体 → 运行时真实字符串（左到右单遍，与 kodrix-l10n.mjs 的 unescapeJsString 一致） */
function unescapeJsString(s) {
	return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, esc) => {
		switch (esc[0]) {
			case 'n': return '\n';
			case 't': return '\t';
			case 'r': return '\r';
			case 'u': return esc[1] === '{'
				? String.fromCodePoint(parseInt(esc.slice(2, -1), 16))
				: String.fromCharCode(parseInt(esc.slice(1), 16));
			case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
			default: return esc;
		}
	});
}

/** 文件本体 → 改写后的本体（l10n.t('zh', …) → l10n.t('en', …)） */
function rewriteTs(text, stats) {
	let out = '';
	let i = 0;
	const marker = /l10n\.t\(/g;
	let m;
	while ((m = marker.exec(text)) !== null) {
		let j = m.index + m[0].length;
		while (j < text.length && /\s/.test(text[j])) { j++; }
		const quote = text[j];
		if (quote !== '\'' && quote !== '"' && quote !== '`') { continue; }
		// 扫描字面量本体
		let body = '';
		let k = j + 1;
		let closed = false;
		while (k < text.length) {
			const ch = text[k];
			if (ch === '\\') { body += ch + (text[k + 1] ?? ''); k += 2; continue; }
			if (ch === quote) { closed = true; break; }
			if (quote !== '`' && ch === '\n') { break; }
			body += ch;
			k++;
		}
		if (!closed) { continue; }
		marker.lastIndex = k + 1;
		const raw = unescapeJsString(body);
		if (!(raw in map)) {
			// 幂等：纯 ASCII/英文键（上一轮已改写或本就是英文源）不算未映射
			if (/[\u4e00-\u9fff]/.test(raw)) {
				stats.unmapped.add(raw);
			}
			continue;
		}
		const en = escapeFor(map[raw], quote);
		out += text.slice(i, j + 1) + en + quote;
		i = k + 1;
	}
	out += text.slice(i);
	return out;
}

function sourceFiles(dir) {
	const out = [];
	if (!fs.existsSync(dir)) { return out; }
	const walk = d => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) {
				if (e.name !== 'node_modules' && e.name !== 'test') { walk(full); }
			} else if (e.name.endsWith('.ts')) {
				out.push(full);
			}
		}
	};
	walk(dir);
	return out;
}

const stats = { files: 0, rewritten: 0, unmapped: new Set() };

for (const file of sourceFiles(path.join(repoRoot, 'extensions', ext, 'src'))) {
	const original = fs.readFileSync(file, 'utf-8');
	// 先数一遍命中数（rewriteTs 内部统计不便，直接对比改写前后 l10n.t 键数量差）
	const next = rewriteTs(original, stats);
	if (next !== original) {
		fs.writeFileSync(file, next, 'utf-8');
		stats.files++;
	}
}

// webview 资源 HTML：{{l10n:中文}} → {{l10n:English}}
const resDir = path.join(repoRoot, 'extensions', ext, 'resources');
if (fs.existsSync(resDir)) {
	for (const f of fs.readdirSync(resDir).filter(f => f.endsWith('.html'))) {
		const full = path.join(resDir, f);
		const original = fs.readFileSync(full, 'utf-8');
		const next = original.replace(/\{\{l10n:((?:[^{}]|\{\d+\})*)\}\}/g, (whole, zh) => {
			const key = zh.trim();
			if (key in map) {
				stats.rewritten++;
				return `{{l10n:${map[key]}}}`;
			}
			// 幂等：已是英文的占位不报错
			if (/[\u4e00-\u9fff]/.test(key)) {
				stats.unmapped.add(key);
			}
			return whole;
		});
		if (next !== original) {
			fs.writeFileSync(full, next, 'utf-8');
		}
	}
}

console.log(`${ext}: 改写 ${stats.files} 个 TS 文件；未映射键 ${stats.unmapped.size} 个`);
for (const k of [...stats.unmapped].slice(0, 40)) {
	console.error(`  ✗ 未映射: ${k.replace(/\n/g, '\\n').slice(0, 110)}`);
}
if (stats.unmapped.size) { process.exit(2); }
