/*---------------------------------------------------------------------------------------------
 *  测试：byokRegister — BYOK 模型注册
 *
 *  回归覆盖：
 *    - buildModelConfig 构造正确配置
 *    - 模型发现逻辑（declared models 优先于 auto-discovery）
 *    - 预设应用（applyPresetWithByok）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

require('./vscode-mock');
const byokRegister = require('../byokRegister');

suite('byokRegister', () => {

	// ── buildModelConfig ──────────────────────────────────────────

	suite('buildModelConfig', () => {
		test('使用 model 参数作为 id 和 name', () => {
			const config = byokRegister.buildModelConfig(
				'kodrix-openai', 'OpenAI', 'https://api.openai.com/v1', 'gpt-4o'
			);
			assert.strictEqual(config.id, 'gpt-4o');
			assert.strictEqual(config.name, 'gpt-4o');
			assert.strictEqual(config.url, 'https://api.openai.com/v1');
			assert.strictEqual(config.toolCalling, true);
			assert.strictEqual(config.streaming, true);
			assert.strictEqual(config.apiType, 'chat-completions');
		});

		test('model 为空时使用 storageKey 作为 id', () => {
			const config = byokRegister.buildModelConfig(
				'kodrix-custom', 'Custom Provider', 'https://api.example.com/v1', ''
			);
			assert.strictEqual(config.id, 'kodrix-custom');
		});

		test('model 为空时使用 providerName 作为 name', () => {
			const config = byokRegister.buildModelConfig(
				'kodrix-custom', 'Custom Provider', 'https://api.example.com/v1', '   '
			);
			assert.strictEqual(config.name, 'Custom Provider');
		});

		test('默认 token 限制', () => {
			const config = byokRegister.buildModelConfig(
				'key', 'name', 'url', 'model'
			);
			assert.strictEqual(config.maxInputTokens, 128000);
			assert.strictEqual(config.maxOutputTokens, 8192);
		});

		test('vision 默认 false', () => {
			const config = byokRegister.buildModelConfig(
				'key', 'name', 'url', 'model'
			);
			assert.strictEqual(config.vision, false);
		});
	});

	// ── resolveModelsForPreset ────────────────────────────────────

	suite('resolveModelsForPreset', () => {
		test('declared models 优先返回', async () => {
			const preset = {
				id: 'test-preset',
				category: 'cloud',
				name: 'Test',
				api_type: 'openai',
				base_url: 'https://api.test.com/v1',
				model: 'test-model',
				models: ['model-a', 'model-b'],
			};

			const models = await byokRegister.resolveModelsForPreset(
				preset, 'https://api.test.com/v1', 'fake-key'
			);
			// declared models 应直接返回，无需网络发现
			assert.deepStrictEqual(models, ['model-a', 'model-b']);
		});

		test('ollama 类型返回 undefined（跳过自动发现）', async () => {
			const preset = {
				id: 'ollama',
				category: 'local',
				name: 'Ollama',
				api_type: 'ollama',
				base_url: 'http://127.0.0.1:11434',
				model: 'qwen2.5-coder:7b',
			};

			const models = await byokRegister.resolveModelsForPreset(
				preset, 'http://127.0.0.1:11434'
			);
			assert.strictEqual(models, undefined);
		});

		test('anthropic 类型返回 undefined（跳过自动发现）', async () => {
			const preset = {
				id: 'anthropic',
				category: 'cloud',
				name: 'Anthropic',
				api_type: 'anthropic',
				base_url: '',
				model: 'claude-3-5-sonnet',
			};

			const models = await byokRegister.resolveModelsForPreset(
				preset, '', 'fake-key'
			);
			assert.strictEqual(models, undefined);
		});
	});
});
