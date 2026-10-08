/*---------------------------------------------------------------------------------------------
 *  测试：webview 动态文本必须转义后才进 innerHTML
 *
 *  背景：webview 的 HTML 由扩展消息驱动，其中**学习条目内容 / 工作区名 / 模型产物**都来自
 *  Agent 或工作区（非扩展常量）。不经转义就拼进 innerHTML 等于把 Agent 产物当 HTML 执行，
 *  而 webview 里能拿到 `acquireVsCodeApi()`（可回传消息触发命令）。
 *
 *  覆盖：
 *    - 每个用到 innerHTML 的资源文件都必须定义 escapeHtml（或只用 textContent）
 *    - 已知的"非可信字段"插值必须被 escapeHtml 包裹（workspaceName / item.content / msg.label …）
 *    - escapeHtml 本身必须转义 & < > " '（`"`/`'` 关系到属性上下文）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const RESOURCES = path.join(EXT_ROOT, 'resources');

/** 来自 Agent / 工作区 / 模型输出，必须转义后才能进 HTML 的字段 */
const UNTRUSTED_FIELDS = [
	'workspaceName',
	'item.content',
	'item.category',
	'item.date',
	'msg.label',
	's.title',
	's.desc',
	'f.label',
	'a.label',
];

function readHtml(name: string): string {
	return fs.readFileSync(path.join(RESOURCES, name), 'utf-8');
}

/** 抽取出 escapeHtml 的函数源码（按大括号配对，避免惰性正则在体内第一个 `}` 处截断） */
function extractEscapeHtmlSource(html: string): string | undefined {
	const start = html.indexOf('function escapeHtml');
	if (start === -1) {
		return undefined;
	}
	const braceStart = html.indexOf('{', start);
	let depth = 0;
	for (let i = braceStart; i < html.length; i++) {
		if (html[i] === '{') {
			depth++;
		} else if (html[i] === '}') {
			depth--;
			if (depth === 0) {
				return html.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

/** 只对纯字符串实现的 escapeHtml 求值（DOM 实现依赖 document，Node 环境不可用） */
function loadEscapeHtml(html: string): ((v: unknown) => string) | undefined {
	const src = extractEscapeHtmlSource(html);
	if (!src || src.includes('document.')) {
		return undefined;
	}
	return new Function(`${src}; return escapeHtml;`)() as (v: unknown) => string;
}

suite('webviewEscape — innerHTML 转义护栏', () => {

	test('每个使用 innerHTML 的资源文件都具备转义手段（escapeHtml 或内联转义链）', () => {
		const files = fs.readdirSync(RESOURCES).filter(f => f.endsWith('.html'));
		assert.ok(files.length > 0);

		for (const file of files) {
			const html = readHtml(file);
			if (!/\.innerHTML\s*=/.test(html)) {
				continue;
			}
			const hasHelper = /function escapeHtml\s*\(/.test(html);
			// 有的文件选择就地转义（replace(/&/g, '&amp;') …），同样算具备转义手段
			const hasInlineChain = /replace\(\/&\/g,\s*'&amp;'\)/.test(html);
			assert.ok(
				hasHelper || hasInlineChain,
				`${file}: 使用了 innerHTML 但既没有 escapeHtml 也没有内联转义 —— 动态文本会直接当 HTML 执行`,
			);
		}
	});

	test('已知非可信字段的插值都被 escapeHtml 包裹（textContent/createTextNode 安全路径除外）', () => {
		const files = fs.readdirSync(RESOURCES).filter(f => f.endsWith('.html'));

		for (const file of files) {
			const lines = readHtml(file).split(/\r?\n/);
			for (const field of UNTRUSTED_FIELDS) {
				lines.forEach((line, idx) => {
					// 只看把该字段插进模板字符串的位置
					if (!line.includes('${' + field + '}')) {
						return;
					}
					// 走 textContent / createTextNode 的路径由浏览器负责转义，不需要 escapeHtml
					if (/createTextNode\s*\(|textContent\s*=/.test(line)) {
						return;
					}
					assert.ok(
						line.includes('${escapeHtml(' + field + ')}'),
						`${file}:${idx + 1} ${field} 未转义：${line.trim()}`,
					);
				});
			}
		}
	});

	test('escapeHtml 转义 & < > " \'（属性上下文也安全）', () => {
		const expected = '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;';
		const probe = `<img src=x onerror="alert('x')">&`;

		for (const file of ['kodrix-hub.html', 'idea-canvas.html', 'learning-dashboard.html']) {
			const html = readHtml(file);
			const src = extractEscapeHtmlSource(html);
			assert.ok(src, `${file}: 未找到 escapeHtml 函数体`);

			if (src!.includes('document.')) {
				// 基于 DOM 序列化的实现无法在 Node 里执行：静态断言它补齐了引号转义
				assert.ok(/\.replace\(\/"\/g,\s*'&quot;'\)/.test(src!), `${file}: 需补双引号转义`);
				assert.ok(/\.replace\(\/'\/g,\s*'&#39;'\)/.test(src!), `${file}: 需补单引号转义`);
				continue;
			}

			const fn = loadEscapeHtml(html);
			assert.ok(fn, `${file}: escapeHtml 无法求值`);
			assert.strictEqual(fn!(probe), expected, `${file}: 转义结果不符合预期`);
		}
	});

	test('转义函数对 null/undefined 安全（消息字段可能缺失）', () => {
		const fn = loadEscapeHtml(readHtml('kodrix-hub.html'));
		assert.ok(fn);
		assert.strictEqual(fn!(null), '');
		assert.strictEqual(fn!(undefined), '');
		assert.strictEqual(fn!(42), '42');
	});
});
