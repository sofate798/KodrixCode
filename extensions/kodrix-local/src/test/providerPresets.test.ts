/*---------------------------------------------------------------------------------------------
 *  测试：loadPresets — 内置供应商预设
 *
 *  回归覆盖：
 *    - llama.cpp 只保留一个入口（历史上 llama.cpp / llama.cpp Server 并存过）
 *    - 预设 id 不重复
 *    - presets.json 缺失时仍有唯一兜底预设
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';

require('./vscode-mock');
const migrateConfig = require('../migrateConfig');

interface Preset {
	id: string;
	name: string;
	category: string;
	api_type: string;
	base_url: string;
	icon?: string;
}

const extensionRoot = path.join(__dirname, '..', '..');

suite('loadPresets — 内置预设', () => {

	test('llama.cpp 只有唯一入口，且指向 /v1 接口', () => {
		const presets: Preset[] = migrateConfig.loadPresets(extensionRoot);
		const llama = presets.filter(p => /^llama\.cpp/i.test(p.name));

		assert.strictEqual(llama.length, 1, `实际：${llama.map(p => `${p.id}/${p.name}`).join(', ')}`);
		assert.strictEqual(llama[0].id, 'llamacpp');
		assert.strictEqual(llama[0].base_url, 'http://127.0.0.1:8080/v1');
		assert.strictEqual(llama[0].category, 'local');
		assert.ok(llama[0].icon, '本地预设应带图标，否则面板渲染成问号图标');
	});

	test('预设 id 与名称都不重复', () => {
		const presets: Preset[] = migrateConfig.loadPresets(extensionRoot);
		const ids = presets.map(p => p.id);
		const names = presets.map(p => p.name);

		assert.strictEqual(new Set(ids).size, ids.length, `重复 id：${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
		assert.strictEqual(new Set(names).size, names.length, `重复名称：${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`);
	});

	test('presets.json 缺失时兜底提供唯一的 llama.cpp 预设', () => {
		const presets: Preset[] = migrateConfig.loadPresets(path.join(extensionRoot, '__no_such_extension__'));

		assert.strictEqual(presets.length, 1);
		assert.strictEqual(presets[0].name, 'llama.cpp');
		assert.strictEqual(presets[0].base_url, 'http://127.0.0.1:8080/v1');
	});

	test('仓库内 presets.json 依然声明 llamacpp（避免兜底判据失效）', () => {
		const presets: Preset[] = migrateConfig.loadPresets(extensionRoot);
		assert.ok(presets.some(p => p.id === 'llamacpp'));
	});
});
