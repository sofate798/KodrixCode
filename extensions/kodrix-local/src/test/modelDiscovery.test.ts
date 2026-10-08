/*---------------------------------------------------------------------------------------------
 *  测试：modelDiscovery — 连接测试行为
 *
 *  回归覆盖（对应《AI 个人开发者上手与使用说明》接口类型与连接测试一节）：
 *    - 填了模型名时按该模型发最小聊天请求，不依赖服务提供 /models
 *    - 未填模型名时自动探测并验证首个模型
 *    - 聊天请求失败 → 报失败 + 状态码提示（不再只要端口可达就算成功）
 *    - Ollama：先读 /api/tags 再真实聊天；空列表 / 聊天失败都报失败
 *    - Ollama 首次加载慢模型有 60s 预算，OpenAI 兼容默认 15s
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { startStubServer, StubServer } from './httpStub';

require('./vscode-mock');
const modelDiscovery = require('../modelDiscovery');

suite('modelDiscovery — 连接测试', () => {
	let stub: StubServer;

	suiteSetup(async () => {
		stub = await startStubServer();
	});

	suiteTeardown(async () => {
		await stub.close();
	});

	setup(() => {
		stub.hits.length = 0;
		stub.options.models = ['model-a'];
		stub.options.tags = ['qwen2.5-coder:7b'];
		stub.options.chatStatus = 200;
		stub.options.chatDelayMs = undefined;
	});

	test('填了模型名时按该模型发最小聊天请求，不查 /models', async () => {
		stub.options.models = 404; // 服务不公开模型列表

		const result = await modelDiscovery.testOpenAICompatibleConnection(stub.baseUrl, undefined, '  my-model  ');

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.testedModel, 'my-model');
		assert.deepStrictEqual(stub.hits, ['POST /chat/completions'], '不该依赖 /models');
	});

	test('未填模型名时自动探测 /v1/models 并验证首个模型', async () => {
		stub.options.models = ['model-a', 'model-b'];

		const result = await modelDiscovery.testOpenAICompatibleConnection(stub.baseUrl, undefined, undefined);

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.testedModel, 'model-a');
		assert.deepStrictEqual(result.models, ['model-a', 'model-b']);
		assert.deepStrictEqual(stub.hits, ['GET /v1/models', 'POST /chat/completions']);
	});

	test('聊天请求失败时报失败并给出状态码提示', async () => {
		stub.options.chatStatus = 500;

		const result = await modelDiscovery.testOpenAICompatibleConnection(stub.baseUrl, undefined, 'model-a');

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.testedModel, 'model-a');
		assert.ok(result.error?.includes('HTTP 500'), `实际错误：${result.error}`);
		assert.ok(result.error?.includes('Provider temporarily unavailable'), `实际错误：${result.error}`);
	});

	test('没有可用模型名时直接报失败，不发聊天请求', async () => {
		stub.options.models = [];

		const result = await modelDiscovery.testOpenAICompatibleConnection(stub.baseUrl, undefined, undefined);

		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('No model name available to verify'), `实际错误：${result.error}`);
		// 两个候选模型列表端点都会试一遍（/v1/models 空列表不算发现成功），但绝不发聊天请求
		assert.deepStrictEqual(stub.hits, ['GET /v1/models', 'GET /models']);
	});

	test('Ollama：模型列表为空时报失败，不发聊天请求', async () => {
		stub.options.tags = [];

		const result = await modelDiscovery.testOllamaConnection(stub.baseUrl);

		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('has no model to test'), `实际错误：${result.error}`);
		assert.ok(!stub.hits.some(h => h.endsWith('/chat/completions')), '不该把端口可达当作模型可用');
	});

	test('Ollama：先读 /api/tags，再对所选模型发真实聊天请求', async () => {
		stub.options.tags = ['qwen2.5-coder:7b', 'llama3.2'];

		const result = await modelDiscovery.testOllamaConnection(stub.baseUrl);

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.testedModel, 'qwen2.5-coder:7b');
		assert.deepStrictEqual(result.models, ['qwen2.5-coder:7b', 'llama3.2']);
		assert.deepStrictEqual(stub.hits, ['GET /api/tags', 'POST /v1/chat/completions']);
	});

	test('Ollama：聊天请求失败时报失败并带上模型名', async () => {
		stub.options.chatStatus = 404;

		const result = await modelDiscovery.testOllamaConnection(stub.baseUrl);

		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('Ollama model'), `实际错误：${result.error}`);
		assert.ok(result.error?.includes('HTTP 404'), `实际错误：${result.error}`);
	});

	test('Ollama 慢加载（16s）仍在 60s 预算内成功，OpenAI 兼容默认 15s 超时', async function (this: Mocha.Context) {
		this.timeout(45_000);
		stub.options.chatDelayMs = 16_000;

		const startedAt = Date.now();
		const ollama = await modelDiscovery.testOllamaConnection(stub.baseUrl);
		const elapsed = Date.now() - startedAt;

		assert.strictEqual(ollama.ok, true, `Ollama 应在 60s 预算内成功：${ollama.error}`);
		assert.ok(elapsed >= 15_000, `应确实等满了 16 秒，实际 ${elapsed}ms`);

		const strict = await modelDiscovery.testOpenAICompatibleConnection(
			`${stub.baseUrl}/v1`, undefined, 'qwen2.5-coder:7b',
		);
		assert.strictEqual(strict.ok, false, 'OpenAI 兼容默认 15s 预算应超时');
	});
});
