/*---------------------------------------------------------------------------------------------
 *  测试：上下文分层装配（P0 回归护栏）
 *
 *  背景：原先只有"整体预算"（Chat 注入 2000 字符），而 Wiki 单层可达 12000 字符，
 *  于是整体截断永远只留下 Wiki —— Memory / Learning / 语义记忆在 UI 上显示"已就绪"，
 *  实际永远进不了 prompt。这里锁定分层预算的不变量与分层开关的真实生效。
 *
 *  覆盖：
 *    - 不变量：各层预算之和 ≤ Chat 总预算（否则必然有层被挤掉）
 *    - 分层预算：单层超预算只截自己，不影响其它层
 *    - 整体裁剪：按段落边界裁剪并标注
 *    - 分层开关：kodrix.features.<layer> 显式 false 时该层被判定为关闭（状态栏开关写的就是这些键）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

const vscodeMock = require('./vscode-mock');
const {
	CONTEXT_LAYER_BUDGETS,
	CHAT_CONTEXT_MAX_CHARS,
	truncateLayer,
	applyTotalBudget,
	isContextLayerEnabled,
} = require('../context/contextIntelligence');

suite('contextAssembly — 分层预算与分层开关', () => {

	setup(() => {
		vscodeMock.__resetTestConfig();
	});

	teardown(() => {
		vscodeMock.__resetTestConfig();
	});

	suite('预算不变量', () => {
		test('四层预算之和不超过 Chat 总预算（防止某一层重新独占）', () => {
			const layers = Object.values(CONTEXT_LAYER_BUDGETS) as number[];
			const sum = layers.reduce((a, b) => a + b, 0);
			assert.ok(sum <= CHAT_CONTEXT_MAX_CHARS, `分层预算之和 ${sum} 超出总预算 ${CHAT_CONTEXT_MAX_CHARS}`);
		});

		test('每层都有非零的下限预算（任何一层都不会被设计成 0）', () => {
			for (const [layer, budget] of Object.entries(CONTEXT_LAYER_BUDGETS) as [string, number][]) {
				assert.ok(budget >= 200, `${layer} 层预算 ${budget} 过小`);
			}
		});

		test('总预算至少能容纳四层最小内容（≥ 2000）', () => {
			assert.ok(CHAT_CONTEXT_MAX_CHARS >= 2000, 'Chat 总预算被调得过小，四层内容会互相挤占');
		});
	});

	suite('truncateLayer', () => {
		test('未超预算时原样返回（并去除首尾空白）', () => {
			assert.strictEqual(truncateLayer('  hello  ', 100), 'hello');
			assert.strictEqual(truncateLayer('x'.repeat(100), 100), 'x'.repeat(100));
		});

		test('超预算时只截本层，并显式标注原长度', () => {
			const out = truncateLayer('y'.repeat(500), 100);
			assert.ok(out.startsWith('y'.repeat(100)));
			assert.ok(out.includes('本层已截断'));
			assert.ok(out.includes('500'));
			assert.ok(out.length < 200, '截断后长度应接近预算而非原长度');
		});
	});

	suite('applyTotalBudget', () => {
		test('未超总预算时原样返回', () => {
			assert.strictEqual(applyTotalBudget('abc', 10), 'abc');
		});

		test('超总预算时在段落边界截断并标注', () => {
			const text = `${'a'.repeat(80)}\n\n${'b'.repeat(80)}`;
			const out = applyTotalBudget(text, 100);
			assert.ok(out.length <= 100 + 20);
			assert.ok(out.includes('truncated'));
			assert.ok(out.startsWith('a'.repeat(80)), '应保留第一段完整内容');
		});
	});

	suite('isContextLayerEnabled', () => {
		test('默认四层全开（不配置时行为与历史一致）', () => {
			for (const layer of ['wiki', 'memory', 'learning', 'semantic'] as const) {
				assert.strictEqual(isContextLayerEnabled(layer), true, `${layer} 默认应为开启`);
			}
		});

		test('显式 false 时对应层关闭（状态栏开关写的就是这些键）', () => {
			vscodeMock.__setTestConfig('kodrix.features.wiki', false);
			assert.strictEqual(isContextLayerEnabled('wiki'), false);
			assert.strictEqual(isContextLayerEnabled('memory'), true, '关闭 wiki 不应影响 memory');

			vscodeMock.__setTestConfig('kodrix.features.memory', false);
			vscodeMock.__setTestConfig('kodrix.features.learning', false);
			vscodeMock.__setTestConfig('kodrix.features.semanticMemory', false);
			assert.strictEqual(isContextLayerEnabled('memory'), false);
			assert.strictEqual(isContextLayerEnabled('learning'), false);
			assert.strictEqual(isContextLayerEnabled('semantic'), false);
		});
	});
});
