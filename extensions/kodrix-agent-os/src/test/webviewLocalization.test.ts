/*---------------------------------------------------------------------------------------------
 *  测试：webview / 内嵌面板的文案本地化（I-B12）
 *
 *  覆盖：
 *    - `{{l10n:源文案}}` 占位在加载时被替换（无语言包时回退源文案），且不残留占位符
 *    - 占位符里的 `{0}` 运行时占位保留（页面脚本用 fmt() 替换），不会被宿主吞掉
 *    - 空占位安全（不产生 "undefined"）
 *    - **所有** resources/*.html：无未本地化中文（`l10n-ignore` 区间可显式豁免）
 *    - **所有** resources/*.html 的内联脚本语法可解析（防"少一个右花括号 = 整页脚本失效"）
 *    - **所有** resources/*.html 的 `{{l10n:…}}` 键都在 l10n bundle 里（否则永远翻译不了）
 *    - TS 内嵌面板（indexManager / settingsPage）：生成的 HTML 脚本可解析、
 *      脚本区不得出现宿主侧 API（`l10n.t` 在 webview 里不存在 → 整页脚本 ReferenceError）
 *    - TS 内嵌面板 + statusBar：源码无未本地化中文
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// vscode mock 已在 runTests.ts 中注册
require('./vscode-mock');
const { loadWebviewHtml, localizeWebviewText, L10N_PLACEHOLDER_RE } = require('../shared/webviewHtml');
const { buildIndexManagerHtml } = require('../codebase/indexManager');
const { buildSettingsPageHtml } = require('../codebase/settingsPage');

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const RESOURCES = path.join(EXT_ROOT, 'resources');
const SRC = path.join(EXT_ROOT, 'src');

/** 所有资源 HTML（顺序稳定，便于断言失败时定位） */
const RESOURCE_HTML = fs.readdirSync(RESOURCES).filter(f => f.endsWith('.html')).sort();

/** TS 内嵌面板 / 状态栏 */
const TS_PANEL_FILES = [
	path.join(SRC, 'codebase', 'indexManager.ts'),
	path.join(SRC, 'codebase', 'settingsPage.ts'),
	path.join(SRC, 'experience', 'statusBar.ts'),
];

function fakeWebview(): unknown {
	return {
		cspSource: 'vscode-resource://test',
		asWebviewUri: (u: unknown) => ({ toString: () => `vscode-resource://${String(u)}` }),
	};
}

/** 取 HTML 里的第一段内联脚本 */
function inlineScript(html: string): string {
	const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
	assert.ok(m, 'HTML 里应有内联脚本');
	return m![1];
}

/** 注释 → 空格（保留换行，行号与原文件一致） */
function stripComments(text: string): string {
	let out = '';
	let i = 0;
	const blank = (s: string) => s.replace(/[^\n]/g, ' ');
	while (i < text.length) {
		if (text.startsWith('<!--', i)) {
			const e = text.indexOf('-->', i);
			const end = e === -1 ? text.length : e + 3;
			out += blank(text.slice(i, end));
			i = end;
			continue;
		}
		if (text.startsWith('/*', i)) {
			const e = text.indexOf('*/', i + 2);
			const end = e === -1 ? text.length : e + 2;
			out += blank(text.slice(i, end));
			i = end;
			continue;
		}
		const prev = i > 0 ? text[i - 1] : '';
		if (text.startsWith('//', i) && prev !== ':' && prev !== '"' && prev !== '\'' && prev !== '\\') {
			const e = text.indexOf('\n', i);
			const end = e === -1 ? text.length : e;
			out += ' '.repeat(end - i);
			i = end;
			continue;
		}
		out += text[i];
		i++;
	}
	return out;
}

/** 已本地化的片段替换成占位，便于找"漏网"的中文 */
function stripLocalized(text: string): string {
	return text
		.replace(/l10n\.t\(\s*(['"`])(?:[^\\]|\\.)*?\1/g, '@@')
		.replace(/\{\{l10n:((?:[^{}]|\{\d+\})*)\}\}/g, '@@');
}

/**
 * 列出「用户可见但未走 l10n」的中文行。
 * 注释与非界面文案（`l10n-ignore` 区间，如匹配中文日志关键词的正则）不算。
 */
function unlocalizedChineseLines(file: string): string[] {
	const rawLines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
	const cleaned = stripLocalized(stripComments(fs.readFileSync(file, 'utf-8'))).split(/\r?\n/);
	const bad: string[] = [];
	let ignoring = false;
	rawLines.forEach((rawLine, i) => {
		if (rawLine.includes('l10n-ignore-start')) { ignoring = true; return; }
		if (rawLine.includes('l10n-ignore-end')) { ignoring = false; return; }
		if (ignoring || rawLine.includes('l10n-ignore')) { return; }
		const line = cleaned[i] ?? '';
		if (/[\u4e00-\u9fff]/.test(line)) { bad.push(`${i + 1}: ${line.trim()}`); }
	});
	return bad;
}

/** 资源 HTML 里的全部 `{{l10n:…}}` 源文案 */
function htmlL10nKeys(file: string): string[] {
	const html = fs.readFileSync(file, 'utf-8');
	const keys: string[] = [];
	for (const m of html.matchAll(L10N_PLACEHOLDER_RE)) {
		const text = m[1].trim();
		if (text) { keys.push(text); }
	}
	return keys;
}

/**
 * 取出页面脚本里的 `fmt` 实现并**真的求值**。
 * 存在的意义：TS 内嵌面板的脚本写在模板字符串里，`\d` 会被模板字符串吃掉变成 `d`
 * （生成出来的正则是 `(d+)`，永远匹配不上数字）——只有实际跑一次才发现得了。
 */
function evalFmt(script: string): ((template: string, ...args: unknown[]) => string) | undefined {
	const m = script.match(/const fmt = ([\s\S]*?);\r?\n/);
	if (!m) { return undefined; }
	return new Function(`return ${m[1]}`)() as (template: string, ...args: unknown[]) => string;
}

const FMT_CASES: Array<[string, unknown[], string]> = [
	['共 {0} 项', [3], '共 3 项'],
	['正在同步 (Syncing) {0}/{1}', [5, 9], '正在同步 (Syncing) 5/9'],
	['没有占位', ['x'], '没有占位'],
	['缺参数保留 {1}', [7], '缺参数保留 {1}'],
];

suite('webviewLocalization — webview / 面板文案本地化（I-B12）', () => {

	test('{{l10n:…}} 占位被替换，且不残留占位符', () => {
		const html = loadWebviewHtml(fakeWebview() as never, EXT_ROOT, 'spec-workbench.html', 'NONCE');

		assert.ok(!html.includes('{{l10n:'), '不应残留 l10n 占位符');
		assert.ok(!html.includes('{{nonce}}') && !html.includes('{{cspSource}}'), '其它占位符也不应残留');
		// 无语言包时回退英文源文案（英文为源语言）
		assert.ok(html.includes('Kiro three-pane'), '应插入源文案（语言包缺失时回退）');
		assert.ok(html.includes('Refresh Spec list'), '属性中的占位同样应被替换');
	});

	test('每个资源 HTML 的占位都被替换干净（全量回归）', () => {
		for (const file of RESOURCE_HTML) {
			const html = loadWebviewHtml(fakeWebview() as never, EXT_ROOT, file, 'NONCE');
			assert.ok(!html.includes('{{l10n:'), `${file} 残留 l10n 占位符`);
			assert.ok(!html.includes('{{nonce}}'), `${file} 残留 nonce 占位符`);
			assert.ok(!html.includes('{{cspSource}}'), `${file} 残留 cspSource 占位符`);
			assert.ok(!html.includes('{{codiconsCssUri}}'), `${file} 残留 codiconsCssUri 占位符`);
			// 每个占位都要渲染出内容，且不能变成字符串 "undefined"
			for (const key of htmlL10nKeys(path.join(RESOURCES, file))) {
				const text = String(localizeWebviewText(key));
				assert.ok(text.length > 0, `${file} 的占位渲染为空：${key}`);
				assert.ok(!text.includes('undefined'), `${file} 的占位渲染为 undefined：${key}`);
			}
		}
	});

	test('占位符里的 {0} 运行时占位会被保留（交给页面脚本 fmt 替换）', () => {
		// 宿主侧无参 l10n.t() 必须原样保留 {n}，否则页面脚本拿不到可替换的模板
		assert.strictEqual(localizeWebviewText('共 {0} 项'), '共 {0} 项');
		// 占位符语法本身要能容纳 {0}（否则这类文案根本进不了 bundle）
		const matched = [...'<b>{{l10n:检测到: {0}}}</b>'.matchAll(L10N_PLACEHOLDER_RE)].map(m => m[1]);
		assert.deepStrictEqual(matched, ['检测到: {0}']);
	});

	test('localizeWebviewText 空值/空白安全', () => {
		assert.strictEqual(localizeWebviewText('   '), '');
		assert.strictEqual(localizeWebviewText(''), '');
		assert.ok(!String(localizeWebviewText('   ')).includes('undefined'));
	});

	test('所有资源 HTML 都不含未本地化中文', () => {
		for (const file of RESOURCE_HTML) {
			const bad = unlocalizedChineseLines(path.join(RESOURCES, file));
			assert.deepStrictEqual(bad, [], `${file} 仍有未本地化中文：\n${bad.join('\n')}`);
		}
	});

	test('所有资源 HTML 的内联脚本语法可解析', () => {
		for (const file of RESOURCE_HTML) {
			const script = inlineScript(fs.readFileSync(path.join(RESOURCES, file), 'utf-8'));
			assert.doesNotThrow(
				() => { new Function(script); },
				`${file} 的内联脚本存在语法错误（整页脚本会整体失效）`,
			);
		}
	});

	test('所有资源 HTML 的 fmt 能真正替换 {0}（用到 {0} 的文件必须有 fmt）', () => {
		for (const file of RESOURCE_HTML) {
			const script = inlineScript(fs.readFileSync(path.join(RESOURCES, file), 'utf-8'));
			const fmt = evalFmt(script);
			const usesPlaceholder = htmlL10nKeys(path.join(RESOURCES, file)).some(k => /\{\d+\}/.test(k));
			if (!fmt) {
				assert.ok(!usesPlaceholder, `${file} 的文案用了 {0} 占位但没有定义 fmt`);
				continue;
			}
			for (const [template, args, expected] of FMT_CASES) {
				assert.strictEqual(fmt(template, ...args), expected, `${file} 的 fmt 行为不符`);
			}
		}
	});

	test('HTML 文案已进入 l10n bundle（否则无法翻译）', () => {
		const bundle = require(path.join(EXT_ROOT, 'l10n', 'bundle.l10n.json'));
		for (const key of ['Kiro three-pane', 'Refresh Spec list', 'Open in editor', 'New', 'Implement (Agent)']) {
			assert.ok(Object.hasOwn(bundle, key), `bundle 缺少 HTML 文案键：${key}`);
		}
		for (const file of RESOURCE_HTML) {
			for (const key of htmlL10nKeys(path.join(RESOURCES, file))) {
				assert.ok(Object.hasOwn(bundle, key), `${file} 的占位未进 bundle：${key}（先跑 npm run l10n:extract）`);
			}
		}
	});

	suite('TS 内嵌面板（indexManager / settingsPage）', () => {

		const panels = [
			{ name: 'indexManager', build: () => buildIndexManagerHtml(fakeWebview()), marker: 'Indexing & Docs' },
			{ name: 'settingsPage', build: () => buildSettingsPageHtml(fakeWebview()), marker: 'Kodrix Settings' },
		];

		for (const panel of panels) {
			test(`${panel.name}：生成的 HTML 脚本可解析且不引用宿主侧 l10n`, () => {
				const html = panel.build();
				assert.ok(html.includes(panel.marker), `${panel.name} HTML 应生成内容`);
				const script = inlineScript(html);
				assert.doesNotThrow(() => { new Function(script); }, `${panel.name} 的脚本存在语法错误`);
				// webview 里没有 l10n：脚本区出现 l10n.t(...) 会让整页脚本 ReferenceError 失效
				assert.ok(!/\bl10n\s*\./.test(script), `${panel.name} 的脚本引用了宿主侧 l10n（webview 中不存在）`);
			});

			test(`${panel.name}：生成的 fmt 能真正替换 {0}（模板字符串未吃掉反斜杠）`, () => {
				const script = inlineScript(panel.build());
				const fmt = evalFmt(script);
				assert.ok(fmt, `${panel.name} 的脚本应定义 fmt`);
				for (const [template, args, expected] of FMT_CASES) {
					assert.strictEqual(fmt(template, ...args), expected, `${panel.name} 的 fmt 行为不符`);
				}
			});
		}

		test('内嵌面板脚本里的文案来自宿主注入（l10n 数据表）', () => {
			const html = buildSettingsPageHtml(fakeWebview());
			// 数据表由宿主侧本地化后 JSON 注入：脚本里应能看到注入语句
			assert.ok(/const PAGES = \{/.test(html), '设置页应注入本地化后的 PAGES');
			assert.ok(/const L = \{/.test(html), '设置页应注入本地化后的脚本文案表');
			assert.ok(html.includes('功能开关') || html.includes('开发工作流'), '设置页应带本地化数据');
		});
	});

	test('TS 内嵌面板 / 状态栏源码不含未本地化中文', () => {
		for (const file of TS_PANEL_FILES) {
			const bad = unlocalizedChineseLines(file);
			assert.deepStrictEqual(bad, [], `${path.basename(file)} 仍有未本地化中文：\n${bad.join('\n')}`);
		}
	});
});
