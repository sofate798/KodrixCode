/*---------------------------------------------------------------------------------------------
 *  测试：webview CSP / nonce 一致性
 *
 *  背景：CSP 与内联 <script> 必须用**同一个** nonce。任何一处漏填，脚本会被浏览器静默拦截，
 *  表现为"webview 打开是空白的 / 按钮点了没反应"，且控制台外看不到任何错误。
 *  这类回归在编译期与 lint 期都发现不了，只能靠断言资源文件本身。
 *
 *  覆盖：
 *    - webviewCsp()：脚本维度只放行 nonce（不含 'unsafe-inline'）；样式仍允许内联；含 cspSource
 *    - createNonce()：每次调用都不同（硬编码 nonce 等于没有防护）
 *    - 每个 resources/*.html：CSP 的 script-src 用 nonce，且每个内联 <script> 都带同一占位 nonce
 *    - loadWebviewHtml()：把 {{nonce}} 占位替换成传入值（真实文件 + 真实替换路径）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const { createNonce, webviewCsp, loadWebviewHtml } = require('../shared/webviewHtml');

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const RESOURCES = path.join(EXT_ROOT, 'resources');

function fakeWebview(): { cspSource: string; asWebviewUri: (u: unknown) => { toString: () => string } } {
	return {
		cspSource: 'vscode-resource://test-source',
		asWebviewUri: (u: unknown) => ({ toString: () => `vscode-resource://${String(u)}` }),
	};
}

suite('webviewCsp — CSP 与 nonce 一致性', () => {

	test('脚本只放行 nonce，不含 unsafe-inline；样式保留内联', () => {
		const testNonce = 'TESTNONCE';
		const csp = webviewCsp(fakeWebview() as never, testNonce);

		assert.ok(csp.includes(`script-src 'nonce-${testNonce}'`), `脚本策略应为 nonce：${csp}`);
		assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), `脚本维度不得放行 unsafe-inline：${csp}`);
		assert.ok(/style-src[^;]*unsafe-inline/.test(csp), '样式维度应保留 unsafe-inline（页面大量内联样式）');
		assert.ok(csp.includes('vscode-resource://test-source'), '应包含 webview.cspSource');
		assert.ok(csp.startsWith(`default-src 'none'`), '默认应为 default-src none');
	});

	test('createNonce 每次不同（硬编码 nonce 等于没有防护）', () => {
		const a = createNonce();
		const b = createNonce();
		assert.notStrictEqual(a, b);
		assert.ok(a.length >= 16, `nonce 过短：${a.length}`);
	});

	test('resources 下每个内联脚本都有 nonce，且 CSP 用 nonce 策略', () => {
		const files = fs.readdirSync(RESOURCES).filter(f => f.endsWith('.html'));
		assert.ok(files.length > 0, '应存在 webview 资源文件');

		for (const file of files) {
			const html = fs.readFileSync(path.join(RESOURCES, file), 'utf-8');
			const cspMatch = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
			assert.ok(cspMatch, `${file}: 缺少 CSP meta`);

			const csp = cspMatch![1];
			assert.ok(/script-src[^;]*'nonce-\{\{nonce\}\}'/.test(csp), `${file}: script-src 应使用 {{nonce}} 占位：${csp}`);
			assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), `${file}: script-src 不得含 unsafe-inline`);

			// 每个内联 <script>（无 src）都必须带 nonce，否则会被 CSP 拦截
			const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? [];
			assert.ok(inlineScripts.length > 0, `${file}: 预期存在内联脚本`);
			for (const tag of inlineScripts) {
				assert.ok(/nonce="\{\{nonce\}\}"/.test(tag), `${file}: 内联脚本缺少 nonce 占位 → ${tag}`);
			}
		}
	});

	test('loadWebviewHtml 会把 {{nonce}} 替换为真实值（真实资源文件）', () => {
		const nonce = createNonce();
		const html = loadWebviewHtml(fakeWebview() as never, EXT_ROOT, 'kodrix-hub.html', nonce);

		assert.ok(html.includes(`'nonce-${nonce}'`), 'CSP 中应替换为真实 nonce');
		assert.ok(html.includes(`<script nonce="${nonce}">`), '内联脚本应替换为真实 nonce');
		assert.ok(!html.includes('{{nonce}}'), '不应残留 {{nonce}} 占位符');
		assert.ok(!html.includes('{{cspSource}}'), '不应残留 {{cspSource}} 占位符');
	});
});
