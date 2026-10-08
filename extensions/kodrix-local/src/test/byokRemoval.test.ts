/*---------------------------------------------------------------------------------------------
 *  测试：移除供应商时的 BYOK 组清理
 *
 *  回归覆盖（对应说明文档“API Key、代码和隐私”一节的删除语义）：
 *    - 预设注册流程把 BYOK vendor / 组名记录进 StoredProvider
 *    - 移除供应商时用该记录调用 core 的 lm.removeLanguageModelsProviderGroup
 *    - 面板内新增的供应商没有 BYOK 组，不应触发任何命令
 *    - 组不存在（core 未提供该命令 / 已手工删除）时不抛错
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

const vscodeMock = require('./vscode-mock');
const byokRegister = require('../byokRegister');
const providerStore = require('../providerStore');

const preset = {
	id: 'deepseek',
	category: 'cloud',
	name: 'DeepSeek',
	api_type: 'openai',
	base_url: 'https://api.deepseek.com',
	model: 'deepseek-flash',
	models: ['deepseek-flash'],
	needs_api_key: true,
};

function panelProvider() {
	return {
		id: 'kodrix-custom-1',
		name: 'MyAPI',
		category: 'cloud',
		api_type: 'openai',
		base_url: 'https://api.example.com/v1',
		model: 'm1',
		models: ['m1'],
		groupName: 'MyAPI',
		needs_api_key: true,
		registeredAt: 1,
	};
}

suite('移除供应商 — BYOK 组清理', () => {

	setup(() => {
		vscodeMock.__state.commandCalls.length = 0;
		vscodeMock.__state.failCommands.clear();
	});

	test('storedProviderFromPreset 记录 BYOK vendor 与组名', () => {
		const stored = providerStore.storedProviderFromPreset(preset, ['deepseek-flash'], 'Kodrix: DeepSeek', 'customendpoint');

		assert.strictEqual(stored.byokVendor, 'customendpoint');
		assert.strictEqual(stored.byokGroupName, 'Kodrix: DeepSeek');
	});

	test('面板内新增的供应商没有 BYOK 记录，移除时不触发任何命令', async () => {
		await byokRegister.removeByokProviderGroup(panelProvider());

		assert.deepStrictEqual(vscodeMock.__state.commandCalls, []);
	});

	test('预设注册的供应商移除时同步摘掉 BYOK 组', async () => {
		const stored = providerStore.storedProviderFromPreset(preset, ['deepseek-flash'], 'Kodrix: DeepSeek', 'customendpoint');

		await byokRegister.removeByokProviderGroup(stored);

		assert.deepStrictEqual(vscodeMock.__state.commandCalls, [{
			command: 'lm.removeLanguageModelsProviderGroup',
			args: [{ vendor: 'customendpoint', name: 'Kodrix: DeepSeek' }],
		}]);
	});

	test('各原生 vendor 使用注册时的同一组名', async () => {
		const ollama = providerStore.storedProviderFromPreset(
			{ ...preset, id: 'ollama', name: 'Ollama', api_type: 'ollama', category: 'local' },
			['qwen2.5-coder:7b'], 'Ollama', 'ollama',
		);
		const gemini = providerStore.storedProviderFromPreset(
			{ ...preset, id: 'gemini', name: 'Google Gemini', api_type: 'gemini', base_url: '' },
			['gemini-2.0-flash'], 'Google', 'gemini',
		);

		await byokRegister.removeByokProviderGroup(ollama);
		await byokRegister.removeByokProviderGroup(gemini);

		assert.deepStrictEqual(vscodeMock.__state.commandCalls, [
			{ command: 'lm.removeLanguageModelsProviderGroup', args: [{ vendor: 'ollama', name: 'Ollama' }] },
			{ command: 'lm.removeLanguageModelsProviderGroup', args: [{ vendor: 'gemini', name: 'Google' }] },
		]);
	});

	test('组不存在或 core 未提供该命令时不抛错', async () => {
		const stored = providerStore.storedProviderFromPreset(preset, ['deepseek-flash'], 'Kodrix: DeepSeek', 'customendpoint');
		vscodeMock.__state.failCommands.add('lm.removeLanguageModelsProviderGroup');

		await byokRegister.removeByokProviderGroup(stored);

		assert.strictEqual(vscodeMock.__state.commandCalls.length, 1, '仍然尝试了一次，只是错误被吞掉');
	});
});
