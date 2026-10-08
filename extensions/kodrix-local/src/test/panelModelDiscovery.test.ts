/*---------------------------------------------------------------------------------------------
 *  测试：本地预设的模型自动探测（面板保存与命令面板预设共用同一逻辑）
 *
 *  回归覆盖（对应说明文档 llama.cpp 一节）：
 *    - 探测到单个模型 → 直接采用
 *    - 探测到多个模型 → 让用户挑选
 *    - 探测不到 → 回落到手动输入模型 ID
 *    - 用户取消 → 返回 undefined（由调用方提示手动填写）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { startStubServer, StubServer } from './httpStub';

const vscodeMock = require('./vscode-mock');
const byokRegister = require('../byokRegister');

suite('本地预设模型自动探测', () => {
	let stub: StubServer;

	suiteSetup(async () => {
		stub = await startStubServer();
	});

	suiteTeardown(async () => {
		await stub.close();
	});

	setup(() => {
		stub.hits.length = 0;
		stub.options.models = ['qwen2.5-coder:7b'];
		vscodeMock.__state.quickPickResult = undefined;
		vscodeMock.__state.inputBoxResult = undefined;
	});

	/** 面板里点击 llama.cpp 预设后填出的表单（模型名为空） */
	function llamaPreset() {
		return {
			id: 'llama-cpp-local',
			category: 'local',
			name: 'llama.cpp',
			api_type: 'openai',
			base_url: stub.baseUrl,
			model: '',
			models: [],
		};
	}

	test('探测到单个模型时直接采用，不再询问', async () => {
		stub.options.models = ['qwen2.5-coder:7b'];

		const models = await byokRegister.resolveModelsForPreset(llamaPreset(), stub.baseUrl);

		assert.deepStrictEqual(models, ['qwen2.5-coder:7b']);
		assert.deepStrictEqual(stub.hits, ['GET /v1/models']);
	});

	test('探测到多个模型时让用户挑选', async () => {
		stub.options.models = ['model-a', 'model-b'];
		vscodeMock.__state.quickPickResult = [{ label: 'model-a', id: 'model-a' }, { label: 'model-b', id: 'model-b' }];

		const models = await byokRegister.resolveModelsForPreset(llamaPreset(), stub.baseUrl);

		assert.deepStrictEqual(models, ['model-a', 'model-b']);
	});

	test('服务不公开模型列表时回落到手动输入', async () => {
		stub.options.models = 404;
		vscodeMock.__state.inputBoxResult = 'manual-model';

		const models = await byokRegister.resolveModelsForPreset(llamaPreset(), stub.baseUrl);

		assert.deepStrictEqual(models, ['manual-model']);
	});

	test('用户取消输入时返回 undefined（由调用方提示手动填写）', async () => {
		stub.options.models = 404;
		vscodeMock.__state.inputBoxResult = undefined;

		const models = await byokRegister.resolveModelsForPreset(llamaPreset(), stub.baseUrl);

		assert.strictEqual(models, undefined);
	});

	test('本地服务没启动（连接被拒）时不抛错，回落到手动输入', async () => {
		vscodeMock.__state.inputBoxResult = 'manual-after-refused';

		const models = await byokRegister.resolveModelsForPreset(llamaPreset(), 'http://127.0.0.1:1');

		assert.deepStrictEqual(models, ['manual-after-refused']);
	});
});
