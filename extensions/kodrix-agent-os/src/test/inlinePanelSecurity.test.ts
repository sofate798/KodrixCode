/*---------------------------------------------------------------------------------------------
 *  测试：Background Agent / Model Health 内嵌面板 CSP + 转义
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

require('./vscode-mock');
const { renderBackgroundPanelHtml } = require('../background/backgroundAgent');
const { renderHealthHtml } = require('../model/modelRouter');
const { escapeHtml } = require('../shared/webviewHtml');

function fakeWebview(): { cspSource: string } {
	return { cspSource: 'vscode-resource://test-source' };
}

suite('inlinePanelSecurity — Background / Model Health 面板', () => {
	test('escapeHtml 转义属性与文本危险字符', () => {
		assert.strictEqual(
			escapeHtml(`<img src=x onerror=alert(1) "a" 'b'>`),
			'&lt;img src=x onerror=alert(1) &quot;a&quot; &#39;b&#39;&gt;',
		);
	});

	test('Background Agent 面板：CSP nonce、无 unsafe-inline、任务字段转义、无 onclick 拼 id', () => {
		const evil = `<img src=x onerror=alert(1)>`;
		const html = renderBackgroundPanelHtml([{
			id: 'bg-2026-01-01T00-00-00-000Z',
			title: evil,
			status: 'failed',
			error: `"</td><script>alert(1)</script>`,
			createdAt: '2026-01-01T12:34:56.000Z',
			result: evil,
		}], fakeWebview());

		assert.ok(/Content-Security-Policy/.test(html), '应有 CSP');
		assert.ok(/script-src 'nonce-/.test(html), 'script-src 应为 nonce');
		assert.ok(!/script-src[^;]*unsafe-inline/.test(html), '脚本不得 unsafe-inline');
		assert.ok(/<script nonce="[^"]+">/.test(html), '内联脚本须带 nonce');
		assert.ok(!html.includes(evil), '原始危险标题不得进 HTML');
		assert.ok(html.includes(escapeHtml(evil)), '标题应经 escapeHtml');
		assert.ok(!/onclick\s*=\s*["']openTask/.test(html), '不得用 onclick 拼任务 id');
		assert.ok(/data-id="bg-2026-01-01T00-00-00-000Z"/.test(html), '应用 data-id');
	});

	test('Model Health 面板：CSP nonce + 模型名/错误转义', () => {
		const evilName = `gpt</td><script>x</script>`;
		const html = renderHealthHtml({
			pools: { smart: ['a<script>'], balanced: ['b'], fast: ['c'] },
			usage: [],
			usageStats: [{
				modelName: evilName,
				count: 1,
				okCount: 0,
				failCount: 1,
				successRate: 0,
				avgDurationMs: 10,
				lastAt: '2026-01-01T12:34:56.000Z',
				lastError: `" onmouseover="alert(1)`,
			}],
		}, fakeWebview());

		assert.ok(/script-src 'nonce-/.test(html));
		assert.ok(!/script-src[^;]*unsafe-inline/.test(html));
		assert.ok(/<script nonce="[^"]+">/.test(html));
		assert.ok(!html.includes(evilName));
		assert.ok(html.includes(escapeHtml(evilName)));
		assert.ok(html.includes(escapeHtml(`" onmouseover="alert(1)`)));
		assert.ok(html.includes(escapeHtml('a<script>')));
	});
});
