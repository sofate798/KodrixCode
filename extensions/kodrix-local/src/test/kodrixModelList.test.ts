/*---------------------------------------------------------------------------------------------
 *  测试：languageModelProvider — Kodrix 模型列表
 *
 *  回归覆盖：
 *    - Gemini 原生供应商不进入 Kodrix 模型列表（否则 Chat 里挂着必然报错的模型）
 *    - 其余 openai / anthropic / ollama 供应商的模型照常列出
 *    - 升级前已选中的旧 gemini 模型 ID 仍给出明确引导错误
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

const vscodeMock = require('./vscode-mock');
const { registerKodrixLanguageModels } = require('../languageModelProvider');

const storedProviders = [
	{ id: 'p-openai', name: 'MyAPI', category: 'cloud', api_type: 'openai', base_url: 'https://api.example.com/v1', model: 'm1', models: ['m1', 'm2'], groupName: 'MyAPI', needs_api_key: true, registeredAt: 1 },
	{ id: 'p-anthropic', name: 'Claude', category: 'cloud', api_type: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-x', models: ['claude-x'], groupName: 'Anthropic', needs_api_key: true, registeredAt: 2 },
	{ id: 'p-ollama', name: 'Ollama', category: 'local', api_type: 'ollama', base_url: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b', models: ['qwen2.5-coder:7b'], groupName: 'Ollama', needs_api_key: false, registeredAt: 3 },
	{ id: 'p-gemini', name: 'Google Gemini', category: 'cloud', api_type: 'gemini', base_url: '', model: 'gemini-2.0-flash', models: ['gemini-2.0-flash', 'gemini-2.5-pro'], groupName: 'Google', needs_api_key: true, registeredAt: 4 },
];

function createContext() {
	return {
		subscriptions: [] as Array<{ dispose(): void }>,
		globalState: {
			get: (key: string, defaultValue: unknown) => (key === 'kodrix.providers' ? storedProviders : defaultValue),
			update: async () => { /* no-op */ },
		},
		secrets: {
			get: async () => 'test-key',
			store: async () => { /* no-op */ },
			delete: async () => { /* no-op */ },
		},
	};
}

function registerAndGetProvider() {
	const context = createContext();
	registerKodrixLanguageModels(context);
	const registrations = vscodeMock.__state.lmRegistrations;
	return registrations[registrations.length - 1];
}

suite('languageModelProvider — Kodrix 模型列表', () => {

	setup(() => {
		vscodeMock.__state.lmRegistrations.length = 0;
	});

	test('以 kodrix 作为 vendor 注册', () => {
		const registration = registerAndGetProvider();
		assert.strictEqual(registration.vendor, 'kodrix');
	});

	test('gemini 供应商的模型不进入 Kodrix 模型列表', async () => {
		const registration = registerAndGetProvider();

		const infos = await registration.provider.provideLanguageModelChatInformation();

		assert.ok(!infos.some((i: { id: string }) => i.id.includes('gemini')), `实际：${infos.map((i: { id: string }) => i.id).join(', ')}`);
		assert.deepStrictEqual(
			infos.map((i: { id: string }) => i.id),
			['p-openai::m1', 'p-openai::m2', 'p-anthropic::claude-x', 'p-ollama::qwen2.5-coder:7b'],
		);
	});

	test('升级前已选中的旧 gemini 模型仍给出明确引导错误', async () => {
		const registration = registerAndGetProvider();
		const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { /* no-op */ } }) };
		const progress = { report: () => { /* no-op */ } };

		await assert.rejects(
			() => registration.provider.provideLanguageModelChatResponse(
				{ providerId: 'p-gemini', modelId: 'gemini-2.0-flash' }, [], {}, progress, token,
			),
			/do not support the native Gemini API/,
		);
	});
});
