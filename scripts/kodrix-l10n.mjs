#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*
 * kodrix-l10n.mjs — Kodrix 扩展的 l10n 基础设施工具（提取 / 校验 / 裸字面量盘点 / 包裹）
 *
 * 语言约定（2026-10 起，kodrix-skills 已迁移，其余扩展逐步跟进）：
 *   - 源码里的 l10n.t('…') / {{l10n:…}} 占位一律写**英文源文案**（VS Code 惯例）。
 *   - 界面语言为英语（默认）时，VS Code 直接返回源串，不加载任何 bundle。
 *   - 界面语言为 zh-cn 时，VS Code 加载 l10n/bundle.l10n.zh-cn.json（英文键→中文译文）。
 *   - l10n/bundle.l10n.json 为 extract 生成的默认包（源串→源串恒等），供工具校验一致性。
 *
 * 本脚本负责：
 *   extract  扫描源码里的静态 `l10n.t('…')` 字面量 + resources/*.html 的 `{{l10n:…}}` 占位
 *            → 生成 l10n/bundle.l10n.json（源串→源串的默认包）
 *   check    校验 bundle 与源码一致：① 用到的静态串都在 bundle 里 ② bundle 里没有已失效的键
 *            ③ 若存在 bundle.l10n.zh-cn.json，其键集必须与源码静态键完全一致（缺译/失效都算失败）
 *            ④ 统计"不可外部化"的调用（模板串里带 ${} 插值，需改成 l10n.t('… {0}', x)）
 *   scan     只盘点不写盘：列出裸字面量通知 / 未包裹的 placeHolder/prompt，供人工收口
 *   wrap     把裸字面量通知/输入框文案自动包裹成 l10n.t(...)（--apply 才写盘）
 *
 * 用法：
 *   node scripts/kodrix-l10n.mjs extract [--ext kodrix-agent-os]
 *   node scripts/kodrix-l10n.mjs check [--ext kodrix-skills]
 *   node scripts/kodrix-l10n.mjs scan
 *   node scripts/kodrix-l10n.mjs wrap [--apply]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = ['kodrix-agent-os', 'kodrix-local', 'kodrix-skills'];

const args = process.argv.slice(2);
const mode = args[0] ?? 'check';
const extFilter = (() => {
	const i = args.indexOf('--ext');
	return i >= 0 ? args[i + 1] : undefined;
})();

/** 收集某扩展 src 下的 .ts（排除测试） */
function sourceFiles(ext) {
	const srcDir = path.join(repoRoot, 'extensions', ext, 'src');
	if (!fs.existsSync(srcDir)) {
		return [];
	}
	const out = [];
	const walk = dir => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'test' && entry.name !== 'node_modules') {
					walk(full);
				}
			} else if (entry.name.endsWith('.ts')) {
				out.push(full);
			}
		}
	};
	walk(srcDir);
	return out;
}

/**
 * 注释 → 空格（保留换行）。扫描必须跳过注释：否则注释里举例写的 `l10n.t('…')`
 * 会被当成真实调用，往 bundle 里塞进永不使用的"幽灵键"（check 也发现不了）。
 *
 * 必须是**字符串感知**的：`//` 与 `/*` 出现在字符串字面量里（如 URL、glob '*./*'、
 * 正则 '/\*'）时不是注释。早期实现不感知字符串，rulesManager.ts 里一个含 `/*` 的
 * 字符串会把后续整段代码误当注释剥掉，l10n.t 键静默漏采（bundle 缺键且无从发现）。
 */
function stripCommentsForScan(text) {
	let out = '';
	let i = 0;
	const blank = s => s.replace(/[^\n]/g, ' ');
	while (i < text.length) {
		const ch = text[i];
		// 块注释（真实代码位置才可能到达这里：字符串已被整体跳过）
		if (ch === '/' && text[i + 1] === '*') {
			const e = text.indexOf('*/', i + 2);
			const end = e === -1 ? text.length : e + 2;
			out += blank(text.slice(i, end));
			i = end;
			continue;
		}
		// 行注释
		if (ch === '/' && text[i + 1] === '/') {
			const e = text.indexOf('\n', i);
			const end = e === -1 ? text.length : e;
			out += ' '.repeat(end - i);
			i = end;
			continue;
		}
		// 字符串字面量：整体原样保留（含其中的 // 与 /*）
		if (ch === '\'' || ch === '"' || ch === '`') {
			const quote = ch;
			let j = i + 1;
			while (j < text.length) {
				if (text[j] === '\\') { j += 2; continue; }
				if (text[j] === quote) { break; }
				// 单/双引号串不跨行（未闭合即语法错误，保险起见跳出）
				if (quote !== '`' && text[j] === '\n') { break; }
				j++;
			}
			out += text.slice(i, Math.min(j + 1, text.length));
			i = Math.min(j + 1, text.length);
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * 抽取 `l10n.t(...)` 的调用形态。
 * - static：第一个参数是不含 ${} 的字符串字面量 → 可外部化（计入 bundle）
 * - dynamic：第一个参数含 ${} 插值 → 需人工改写为 `l10n.t('… {0}', x)`
 * - nonLiteral：第一个参数是变量/表达式 → 无法静态校验，计入 unauditable
 *
 * 注意：此前用 `l10n\.t\(\s*([\s\S]{0,400}?)\)` 这种"惰性找到第一个右括号"的写法，
 * 会把**字面量内部含 `)` 的调用整个漏掉**（例：`l10n.t('已暂停 (Paused)')` 被截成
 * `'已暂停 (Paused` → 未闭合 → 直接跳过）；嵌套调用（`l10n.t('…{1}', … ? l10n.t('，跳过 {0}') : '')`）
 * 的内层也会被整个吃掉。漏掉的键不会进 bundle，`check` 也发现不了，于是"校验通过"是假象。
 * 这里改为真正的字面量扫描 + 跳过注释。
 */
function collectCalls(file) {
	const text = stripCommentsForScan(fs.readFileSync(file, 'utf-8'));
	const staticKeys = [];
	const dynamic = [];
	const nonLiteral = [];
	const marker = /l10n\.t\(/g;
	let m;
	while ((m = marker.exec(text)) !== null) {
		const line = text.slice(0, m.index).split('\n').length;
		let i = m.index + m[0].length;
		while (i < text.length && /\s/.test(text[i])) {
			i++;
		}
		const quote = text[i];
		if (quote !== `'` && quote !== `"` && quote !== '`') {
			nonLiteral.push({ file, line, snippet: text.slice(i, i + 120).replace(/\n/g, ' ') });
			continue;
		}
		// 扫描字面量本体（正确处理转义；单/双引号串不跨行）
		let body = '';
		let j = i + 1;
		let closed = false;
		while (j < text.length) {
			const ch = text[j];
			if (ch === '\\') {
				body += ch + (text[j + 1] ?? '');
				j += 2;
				continue;
			}
			if (ch === quote) {
				closed = true;
				break;
			}
			if (quote !== '`' && ch === '\n') {
				break;
			}
			body += ch;
			j++;
		}
		if (!closed) {
			continue;
		}
		// 跳过整个实参，避免把参数里的嵌套 l10n.t 当成新的调用
		marker.lastIndex = j + 1;
		if (quote === '`' && body.includes('${')) {
			dynamic.push({ file, line, snippet: body.slice(0, 120) });
			continue;
		}
		staticKeys.push(unescapeJsString(body));
	}
	return { staticKeys, dynamic, nonLiteral };
}

/** 扩展的 resources/*.html（webview 资源文件） */
function resourceHtmlFiles(ext) {
	const dir = path.join(repoRoot, 'extensions', ext, 'resources');
	if (!fs.existsSync(dir)) {return [];}
	return fs.readdirSync(dir).filter(f => f.endsWith('.html')).map(f => path.join(dir, f));
}

/**
 * `{{l10n:源文案}}` 占位（与 extensions/kodrix-agent-os/src/shared/webviewHtml.ts 的
 * L10N_PLACEHOLDER_RE 保持一致）。文案里允许 `{0}`~`{9}` 运行时占位符。
 */
const L10N_PLACEHOLDER_RE = /\{\{l10n:((?:[^{}]|\{\d+\})*)\}\}/g;

/** JS 字符串字面量本体 → 运行时的真实字符串（单遍处理，避免 \\u 被二次解码） */
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

/** 盘点裸字面量的用户可见文案（跳过注释，避免注释里的示例被误报） */
function scanRawLiterals(file) {
	const text = stripCommentsForScan(fs.readFileSync(file, 'utf-8'));
	const findings = [];
	const patterns = [
		{ kind: '通知', re: /show(?:Information|Warning|Error)Message\(\s*(['"`])((?:[^\\]|\\.)*?)\1/g },
		{ kind: '输入框', re: /(?:placeHolder|prompt)\s*:\s*(['"`])((?:[^\\]|\\.)*?)\1/g },
		{ kind: '进度标题', re: /title\s*:\s*(['"`])((?:[^\\]|\\.)*?)\1/g },
	];
	for (const { kind, re } of patterns) {
		let m;
		while ((m = re.exec(text)) !== null) {
			const body = m[2];
			// 纯 ASCII 占位（如 id/命令名/URL）不算"用户可见文案"
			if (!/[\u4e00-\u9fff]/.test(body)) {
				continue;
			}
			findings.push({
				kind,
				line: text.slice(0, m.index).split('\n').length,
				text: body.slice(0, 90),
			});
		}
	}
	return findings;
}

function analyze(ext) {
	const files = sourceFiles(ext);
	const keys = new Map(); // key → 出现次数
	const dynamic = [];
	const nonLiteral = [];
	const raw = [];
	for (const file of files) {
		const { staticKeys, dynamic: dyn, nonLiteral: nl } = collectCalls(file);
		for (const k of staticKeys) {
			keys.set(k, (keys.get(k) ?? 0) + 1);
		}
		dynamic.push(...dyn);
		nonLiteral.push(...nl);
		for (const f of scanRawLiterals(file)) {
			raw.push({ file, ...f });
		}
	}
	// webview 资源 HTML 里的 `{{l10n:源文案}}` 占位：运行时由 localizeWebviewText() 走 l10n.t()，
	// 这里一并纳入 bundle，否则 HTML 文案永远翻译不了（只能原样回退）
	for (const htmlFile of resourceHtmlFiles(ext)) {
		const html = fs.readFileSync(htmlFile, 'utf-8');
		for (const m of html.matchAll(L10N_PLACEHOLDER_RE)) {
			const text = m[1].trim();
			if (text) {keys.set(text, (keys.get(text) ?? 0) + 1);}
		}
	}
	// 数据驱动键：presets.json / catalog.json 等数据文件的文案经运行时 l10n.t(动态串) 本地化，
	// 静态扫描看不到。l10n/data-keys.json（字符串数组）登记这些英文键，一并纳入 bundle 与校验。
	const dataKeysPath = path.join(repoRoot, 'extensions', ext, 'l10n', 'data-keys.json');
	if (fs.existsSync(dataKeysPath)) {
		let dataKeys;
		try {
			dataKeys = JSON.parse(fs.readFileSync(dataKeysPath, 'utf-8'));
		} catch (err) {
			console.error(`✗ ${ext}: l10n/data-keys.json 解析失败 — ${err.message}`);
			process.exit(1);
		}
		if (!Array.isArray(dataKeys)) {
			console.error(`✗ ${ext}: l10n/data-keys.json 必须是字符串数组`);
			process.exit(1);
		}
		for (const k of dataKeys) {
			if (typeof k === 'string' && k) {keys.set(k, (keys.get(k) ?? 0) + 1);}
		}
	}
	return { ext, files: files.length, keys, dynamic, nonLiteral, raw };
}

function bundlePath(ext) {
	return path.join(repoRoot, 'extensions', ext, 'l10n', 'bundle.l10n.json');
}

function readBundle(ext) {
	const p = bundlePath(ext);
	if (!fs.existsSync(p)) {
		return undefined;
	}
	try {
		return JSON.parse(fs.readFileSync(p, 'utf-8'));
	} catch (err) {
		console.error(`✗ ${ext}: l10n/bundle.l10n.json 解析失败 — ${err.message}`);
		process.exit(1);
	}
}

const results = EXTENSIONS.filter(e => !extFilter || e === extFilter).map(analyze);

if (mode === 'extract') {
	let changed = 0;
	for (const r of results) {
		const sorted = [...r.keys.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
		const bundle = {};
		for (const k of sorted) {
			bundle[k] = k; // 默认真实包：源串→源串（语言包在此基础上覆盖）
		}
		const p = bundlePath(r.ext);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const next = JSON.stringify(bundle, null, '\t') + '\n';
		const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
		if (prev !== next) {
			fs.writeFileSync(p, next, 'utf-8');
			changed++;
		}
		console.log(`${r.ext}: ${sorted.length} 个键 · 动态调用 ${r.dynamic.length} · 非字面量 ${r.nonLiteral.length}${prev !== next ? ' · 已更新' : ' · 无变化'}`);
	}
	console.log(changed ? `已写入 ${changed} 个 bundle` : '所有 bundle 均为最新');
	process.exit(0);
}

if (mode === 'scan') {
	for (const r of results) {
		console.log(`\n=== ${r.ext}（${r.files} 个源文件）===`);
		console.log(`  静态 l10n.t 键 ${r.keys.size} 个 · 动态插值 ${r.dynamic.length} 处 · 非字面量 ${r.nonLiteral.length} 处`);
		const byKind = new Map();
		for (const f of r.raw) {
			byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
		}
		for (const [kind, list] of byKind) {
			console.log(`  ${kind}未包裹 ${list.length} 处：`);
			for (const f of list.slice(0, 12)) {
				console.log(`    ${path.relative(repoRoot, f.file)}:${f.line}  ${f.text}`);
			}
			if (list.length > 12) {
				console.log(`    …另有 ${list.length - 12} 处`);
			}
		}
	}
	process.exit(0);
}

if (mode === 'wrap') {
	const apply = args.includes('--apply');
	const hasChinese = s => /[\u4e00-\u9fff]/.test(s);

	/** 模板串体 → `{ text, args }`；不支持（嵌套反引号/花括号不配平/插值过多）时返回 undefined */
	const convertTemplate = body => {
		const parts = [];
		const exprs = [];
		let text = '';
		for (let i = 0; i < body.length; i++) {
			if (body[i] === '\\') {
				text += body[i] + (body[i + 1] ?? '');
				i++;
				continue;
			}
			if (body[i] === '`') {
				return undefined;
			}
			if (body[i] === '$' && body[i + 1] === '{') {
				let depth = 1;
				let j = i + 2;
				let expr = '';
				while (j < body.length && depth > 0) {
					if (body[j] === '{') {
						depth++;
					} else if (body[j] === '}') {
						depth--;
						if (depth === 0) {
							break;
						}
					}
					expr += body[j];
					j++;
				}
				if (depth !== 0) {
					return undefined;
				}
				exprs.push(expr.trim());
				text += `{${exprs.length - 1}}`;
				i = j;
				continue;
			}
			text += body[i];
		}
		if (!exprs.length || exprs.length > 4) {
			return undefined;
		}
		parts.push(text, exprs);
		return { text: parts[0], args: parts[1] };
	};

	/** 单行内的字面量 → `l10n.t(...)` 文本（不含中文 / 已包裹 / 无法转换时返回 undefined） */
	const wrapLiteral = (quote, body) => {
		if (!hasChinese(body)) {
			return undefined;
		}
		if (quote === '`') {
			const conv = convertTemplate(body);
			if (!conv) {
				return undefined;
			}
						const escaped = conv.text.replace(/\\/g, '\\\\').replace(/'/g, `\'`);
			return `l10n.t('${escaped}'${conv.args.map(a => `, ${a}`).join('')})`;
		}
		const raw = body;
		if (raw.includes('${') || raw.includes('\n')) {
			return undefined;
		}
				const escaped = raw.replace(/\\/g, '\\\\').replace(/'/g, `\'`);
		return `l10n.t('${escaped}')`;
	};

	// 前缀一律用非捕获组：这样 quoted 里的 group1/group2 始终是「引号 / 字面量本体」，
	// 反向引用 \1 才指向引号本身（若前缀是捕获组，\1 会变成"前缀重复"，正文会一路吃过后面的引号）
	const quoted = String.raw`(['"\`])((?:[^\\]|\\.)*?)\1`;
	const patterns = [
		new RegExp(String.raw`(?:show(?:Information|Warning|Error)Message\(\s*)` + quoted, 'g'),
		new RegExp(String.raw`(?:(?:placeHolder|prompt)\s*:\s*)` + quoted, 'g'),
	];

	let totalWrapped = 0;
	let totalSkipped = 0;
	for (const r of results) {
		let fileCount = 0;
		for (const file of sourceFiles(r.ext)) {
			const original = fs.readFileSync(file, 'utf-8');
			let text = original;
			let wrapped = 0;
			let skipped = 0;
			for (const re of patterns) {
				text = text.replace(re, (match, quote, body, offset) => {
					// 已包裹（前缀紧邻 l10n.t( ）或前面就是 l10n.t 的一部分 → 跳过
					const before = text.slice(Math.max(0, offset - 8), offset);
					if (/l10n\.t\($/.test(before)) {
						return match;
					}
					const replacement = wrapLiteral(quote, body);
					if (!replacement) {
						if (hasChinese(body)) {
							skipped++;
						}
						return match;
					}
					wrapped++;
					return match.replace(quote + body + quote, replacement);
				});
			}
			if (wrapped > 0) {
				// 确保 l10n 已导入
				if (!/import\s*\{[^}]*\bl10n\b[^}]*\}\s*from\s*'vscode'/.test(text)) {
					if (/^import \* as vscode from 'vscode';$/m.test(text)) {
						const vscodeImport = `import * as vscode from 'vscode';`;
						const l10nImport = `import { l10n } from 'vscode';`;
						text = text.replace(/^import \* as vscode from 'vscode';$/m, `${vscodeImport}\n${l10nImport}`);
					} else {
						console.log(`  ⚠ ${path.relative(repoRoot, file)}: 需要 l10n 导入但未找到 vscode 导入行，跳过该文件`);
						totalSkipped += skipped;
						continue;
					}
				}
				fileCount++;
				totalWrapped += wrapped;
				if (apply) {
					fs.writeFileSync(file, text, 'utf-8');
				}
				console.log(`  ${apply ? '已改写' : '将改写'} ${path.relative(repoRoot, file)}：${wrapped} 处${skipped ? `（跳过 ${skipped} 处复杂写法）` : ''}`);
			} else {
				totalSkipped += skipped;
			}
		}
		console.log(`${r.ext}: ${fileCount} 个文件，共 ${apply ? '改写' : '待改写'} ${totalWrapped} 处`);
	}
	console.log(`\n合计 ${apply ? '已改写' : '待改写'} ${totalWrapped} 处，跳过 ${totalSkipped} 处（复杂写法，需人工）`);
	if (!apply) {
		console.log('（预览模式：加 --apply 才会写盘）');
	}
	process.exit(0);
}

// 默认：check
let failed = false;
for (const r of results) {
	const bundle = readBundle(r.ext);
	if (!bundle) {
		console.error(`✗ ${r.ext}: 缺少 l10n/bundle.l10n.json（先运行 extract）`);
		failed = true;
		continue;
	}
	const missing = [...r.keys.keys()].filter(k => !Object.hasOwn(bundle, k));
	const stale = Object.keys(bundle).filter(k => !r.keys.has(k));
	console.log(`${r.ext}: 源码静态键 ${r.keys.size} · bundle ${Object.keys(bundle).length} · 缺失 ${missing.length} · 失效 ${stale.length}`);
	for (const k of missing.slice(0, 8)) {
		console.error(`  ✗ 缺失键：${k.replace(/\n/g, '\\n').slice(0, 100)}`);
	}
	for (const k of stale.slice(0, 8)) {
		console.error(`  ✗ 失效键（源码已不再使用）：${k.replace(/\n/g, '\\n').slice(0, 100)}`);
	}
	if (r.dynamic.length || r.nonLiteral.length) {
		console.log(`  ⚠ 不可静态校验：动态插值 ${r.dynamic.length} 处 / 非字面量 ${r.nonLiteral.length} 处（见 scan）`);
	}
	// 英文源扩展：zh-cn 语言包存在即校验键集完整性（缺译 / 失效键都算失败）
	const zhPath = path.join(repoRoot, 'extensions', r.ext, 'l10n', 'bundle.l10n.zh-cn.json');
	if (fs.existsSync(zhPath)) {
		let zhBundle;
		try {
			zhBundle = JSON.parse(fs.readFileSync(zhPath, 'utf-8'));
		} catch (err) {
			console.error(`  ✗ ${r.ext}: l10n/bundle.l10n.zh-cn.json 解析失败 — ${err.message}`);
			failed = true;
			zhBundle = {};
		}
		const zhMissing = [...r.keys.keys()].filter(k => !Object.hasOwn(zhBundle, k));
		const zhStale = Object.keys(zhBundle).filter(k => !r.keys.has(k));
		if (zhMissing.length || zhStale.length) {
			failed = true;
			console.error(`  ✗ zh-cn 语言包不完整：缺译 ${zhMissing.length} · 失效 ${zhStale.length}`);
			for (const k of zhMissing.slice(0, 5)) {
				console.error(`    ✗ 缺译：${k.replace(/\n/g, '\\n').slice(0, 90)}`);
			}
			for (const k of zhStale.slice(0, 5)) {
				console.error(`    ✗ 失效（源码已不再使用）：${k.replace(/\n/g, '\\n').slice(0, 90)}`);
			}
		} else {
			console.log(`  ✓ zh-cn 语言包 ${Object.keys(zhBundle).length} 键完整`);
		}
	}
	const pkgPath = path.join(repoRoot, 'extensions', r.ext, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
	if (r.keys.size > 0 && pkg.l10n !== './l10n') {
		console.error(`  ✗ ${r.ext}/package.json 缺少 "l10n": "./l10n" —— 没有它，语言包不会加载该 bundle`);
		failed = true;
	}
	if (missing.length || stale.length) {
		failed = true;
	}
}
if (failed) {
	console.error('\nl10n 校验失败：运行 `npm run l10n:extract` 同步 bundle 后重试');
	process.exit(1);
}
console.log('\n✓ l10n bundle 与源码一致，且 l10n 字段已声明');
