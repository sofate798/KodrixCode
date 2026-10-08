/*---------------------------------------------------------------------------------------------
 *  测试：webview 消息入口的白名单 / 归一化（消息与状态文件都视为不可信输入）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

require('./vscode-mock');
const { isWritableSetting } = require('../codebase/settingsPage');
const { isSafeCheckpointId } = require('../checkpoint/checkpointManager');
const { normalizeIdeaAnalysis, isLocalPreviewUrl } = require('../experience/ideaFlow');

const RESOURCES = path.resolve(__dirname, '..', '..', 'resources');

suite('webviewMessageGuards — 设置 / 检查点 / Idea Flow', () => {
	test('设置页只允许写设置页自身的键，且值类型需匹配', () => {
		assert.strictEqual(isWritableSetting('kodrix.features.wiki', true), true);
		assert.strictEqual(isWritableSetting('kodrix.features.wiki', 'yes'), false);
		assert.strictEqual(isWritableSetting('kodrix.tabCompletion.fimEndpoint', 'https://x.example/fim'), true);
		assert.strictEqual(isWritableSetting('kodrix.tabCompletion.mode', 'fast'), true);
		assert.strictEqual(isWritableSetting('kodrix.tabCompletion.mode', 'evil'), false);
		assert.strictEqual(isWritableSetting('terminal.integrated.shell.windows', 'calc.exe'), false);
		assert.strictEqual(isWritableSetting('kodrix.tabCompletion.fimApiKey', 'sk-x'), false, 'Key 只能走 SecretStorage');
		assert.strictEqual(isWritableSetting(42, true), false);
	});

	test('检查点 id 只能是单个目录名', () => {
		assert.strictEqual(isSafeCheckpointId('2026-10-09T01-02-03-456Z'), true);
		for (const bad of ['..', '.', '../x', '..\\x', 'a/b', '', 42, undefined]) {
			assert.strictEqual(isSafeCheckpointId(bad), false, String(bad));
		}
	});

	test('Idea 分析结果逐字段归一化：类型不符回退默认', () => {
		const a = normalizeIdeaAnalysis({
			appName: 7, techStack: 'React', features: ['A', 3, ' '], estimatedFiles: '<img src=x>',
			complexity: 'extreme', suggestedCrewRoles: ['coder', 'hacker'], workflowType: 'chaos',
		}, 'todo app');
		assert.strictEqual(a.appName, 'todo-app');
		assert.deepStrictEqual(a.techStack, ['React', 'Vite', 'Tailwind CSS']);
		assert.deepStrictEqual(a.features, ['A']);
		assert.strictEqual(a.estimatedFiles, 10);
		assert.strictEqual(a.complexity, 'medium');
		assert.deepStrictEqual(a.suggestedCrewRoles, ['coder']);
		assert.strictEqual(a.workflowType, 'sequential');
	});

	test('预览地址只允许本机 http(s)', () => {
		assert.strictEqual(isLocalPreviewUrl('http://localhost:5173'), true);
		assert.strictEqual(isLocalPreviewUrl('https://127.0.0.1:3000/'), true);
		assert.strictEqual(isLocalPreviewUrl('https://evil.example'), false);
		assert.strictEqual(isLocalPreviewUrl('file:///C:/Windows/System32/calc.exe'), false);
		assert.strictEqual(isLocalPreviewUrl('vscode://kodrix/run'), false);
	});

	test('webview 资源不得使用内联事件处理器或 confirm()/alert()（nonce CSP + 无 allow-modals 沙箱下都不生效）', () => {
		for (const file of fs.readdirSync(RESOURCES).filter(f => f.endsWith('.html'))) {
			const html = fs.readFileSync(path.join(RESOURCES, file), 'utf-8');
			assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${file}: 存在内联事件处理器`);
			assert.ok(!/[^.\w](confirm|alert)\(/.test(html), `${file}: 存在 confirm()/alert()`);
		}
	});
});
