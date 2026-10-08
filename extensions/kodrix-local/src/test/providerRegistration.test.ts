/*---------------------------------------------------------------------------------------------
 *  测试：供应商注册的双通道状态与如实播报
 *
 *  背景（回归目标）：Kodrix 自有 LM 通道与 Copilot BYOK 镜像是两条独立通道。
 *  旧实现把两者压成一个布尔值并 `return ok || !!context`，导致
 *    - Copilot 缺席/命令报错时仍然弹「已应用」（用户到 Manage Models 里找不到模型且无从判断原因）
 *    - 只有 Gemini 这种「两条路都不通」的真失败被混在同一句提示里
 *    - 主路径白等 Copilot 就绪（未安装时也要等满超时）
 *  本文件锁住修复后的语义：分通道结果、失败原因分类、快速返回、激活自愈。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

const vscodeMock = require('./vscode-mock');
const byokRegister = require('../byokRegister');
const providerStore = require('../providerStore');
const lmProvider = require('../languageModelProvider');
const copilotReady = require('../copilotReady');

const MIGRATE_COMMAND = 'lm.migrateLanguageModelsProviderGroup';

const openaiPreset = {
	id: 'deepseek',
	category: 'cloud',
	name: 'DeepSeek',
	api_type: 'openai',
	base_url: 'https://api.deepseek.com/v1',
	model: 'deepseek-chat',
	models: ['deepseek-chat'],
	needs_api_key: true,
};

const geminiPreset = {
	id: 'gemini',
	category: 'cloud',
	name: 'Google Gemini',
	api_type: 'gemini',
	base_url: '',
	model: 'gemini-2.0-flash',
	models: ['gemini-2.0-flash'],
	needs_api_key: true,
};

/** 最小可用的 ExtensionContext：globalState / secrets / subscriptions */
function fakeContext() {
	const globalState = new Map<string, unknown>();
	const secrets = new Map<string, string>();
	return {
		globalState: {
			get(key: string, defaultValue?: unknown) {
				return globalState.has(key) ? globalState.get(key) : defaultValue;
			},
			async update(key: string, value: unknown) {
				if (value === undefined) {
					globalState.delete(key);
				} else {
					globalState.set(key, value);
				}
			},
		},
		secrets: {
			async get(key: string) { return secrets.get(key); },
			async store(key: string, value: string) { secrets.set(key, value); },
			async delete(key: string) { secrets.delete(key); },
		},
		subscriptions: [] as Array<{ dispose: () => void }>,
	};
}

function registerOpenai(context: unknown) {
	return byokRegister.registerCustomEndpointModels(
		'kodrix-deepseek', 'DeepSeek', 'https://api.deepseek.com/v1',
		['deepseek-chat'], 'sk-test', context, openaiPreset,
	);
}

suite('供应商注册 — 双通道状态与如实播报', () => {

	const originalTiming = {
		mirror: byokRegister.byokTiming.mirrorWaitMs,
		byokOnly: byokRegister.byokTiming.byokOnlyWaitMs,
		retryBase: byokRegister.byokTiming.mirrorRetryBaseMs,
		absentGrace: copilotReady.copilotReadyTiming.absentGraceMs,
	};

	setup(() => {
		vscodeMock.__state.commandCalls.length = 0;
		vscodeMock.__state.failCommands.clear();
		vscodeMock.__state.notifications.length = 0;
		vscodeMock.__state.copilotReady = true;
		// 测试里把等待压到毫秒级：本文件断言的是语义，不是真实超时策略
		byokRegister.byokTiming.mirrorWaitMs = 400;
		byokRegister.byokTiming.byokOnlyWaitMs = 400;
		byokRegister.byokTiming.mirrorRetryBaseMs = 20;
		copilotReady.copilotReadyTiming.absentGraceMs = 120;
	});

	teardown(() => {
		byokRegister.byokTiming.mirrorWaitMs = originalTiming.mirror;
		byokRegister.byokTiming.byokOnlyWaitMs = originalTiming.byokOnly;
		byokRegister.byokTiming.mirrorRetryBaseMs = originalTiming.retryBase;
		copilotReady.copilotReadyTiming.absentGraceMs = originalTiming.absentGrace;
		vscodeMock.__state.copilotReady = true;
	});

	test('Kodrix 直连能力判断与模型列表过滤同源（不会出现两边口径不一致）', () => {
		assert.strictEqual(lmProvider.supportsKodrixNativePath('openai'), true);
		assert.strictEqual(lmProvider.supportsKodrixNativePath('anthropic'), true);
		assert.strictEqual(lmProvider.supportsKodrixNativePath('ollama'), true);
		assert.strictEqual(lmProvider.supportsKodrixNativePath('gemini'), false);
	});

	test('Copilot 就绪且 BYOK 命令成功时，两条通道都可用', async () => {
		const context = fakeContext();

		const res = await registerOpenai(context);

		assert.strictEqual(res.usableViaKodrix, true);
		assert.strictEqual(res.byokRegistered, true);
		assert.strictEqual(res.failureReason, undefined);
		assert.ok(
			vscodeMock.__state.commandCalls.some((c: { command: string }) => c.command === MIGRATE_COMMAND),
			'应当尝试向 Copilot 镜像注册',
		);
	});

	test('Copilot 未就绪时，Kodrix 直连供应商仍然可用，且不得判定为失败', async () => {
		vscodeMock.__state.copilotReady = false;
		const context = fakeContext();

		const res = await registerOpenai(context);

		assert.strictEqual(res.usableViaKodrix, true, 'Kodrix 通道不依赖 Copilot，必须仍然可用');
		assert.strictEqual(res.byokRegistered, false);
		assert.strictEqual(res.failureReason, 'copilot-not-ready');
		const stored = providerStore.loadStoredProviders(context);
		assert.ok(
			stored.some((p: { id: string }) => p.id === 'kodrix-deepseek'),
			'供应商必须已落盘，否则 Chat 里选不到',
		);
	});

	test('BYOK 命令报错时，Kodrix 通道可用并如实报告镜像未同步', async () => {
		vscodeMock.__state.failCommands.add(MIGRATE_COMMAND);
		const context = fakeContext();

		const res = await registerOpenai(context);

		assert.strictEqual(res.usableViaKodrix, true);
		assert.strictEqual(res.byokRegistered, false);
		assert.strictEqual(res.failureReason, 'command-failed');
	});

	test('Gemini 只有 BYOK 一条路：Copilot 缺席时必须判定为真失败', async () => {
		vscodeMock.__state.copilotReady = false;
		const context = fakeContext();

		const res = await byokRegister.registerNativeVendor(
			'gemini', 'Google', 'g-key', 'kodrix-gemini', geminiPreset, context,
		);

		assert.strictEqual(res.usableViaKodrix, false, 'Kodrix 通道不支持 gemini，不能谎报可用');
		assert.strictEqual(res.byokRegistered, false);
	});

	test('Copilot 缺席时注册路径快速返回，不再空等满超时', async () => {
		vscodeMock.__state.copilotReady = false;
		copilotReady.copilotReadyTiming.absentGraceMs = 80;
		byokRegister.byokTiming.mirrorWaitMs = 30_000;
		const context = fakeContext();

		const started = Date.now();
		await registerOpenai(context);
		const elapsed = Date.now() - started;

		assert.ok(elapsed < 5_000, `扩展不存在应快速失败，实际耗时 ${elapsed}ms`);
	});

	test('缺 API Key 时 reapply 如实失败且不改变当前供应商', async () => {
		const context = fakeContext();
		const provider = providerStore.storedProviderFromPreset(
			openaiPreset, ['deepseek-chat'], 'Kodrix: DeepSeek', 'customendpoint',
		);
		provider.id = 'kodrix-deepseek';

		const res = await byokRegister.reapplyStoredProvider(context, provider, [openaiPreset], undefined);

		assert.strictEqual(res.failureReason, 'missing-api-key');
		assert.strictEqual(res.usableViaKodrix, false);
		assert.strictEqual(providerStore.getActiveProviderId(context), undefined, '失败不应把供应商切为当前');
	});

	test('激活会重新尝试 BYOK 镜像，使曾经失败的供应商可自愈', async () => {
		const context = fakeContext();
		const provider = providerStore.storedProviderFromPreset(
			openaiPreset, ['deepseek-chat'], 'Kodrix: DeepSeek', 'customendpoint',
		);
		provider.id = 'kodrix-deepseek';

		// 第一次：BYOK 命令失败（Kodrix 通道仍可用，供应商被切为当前）
		vscodeMock.__state.failCommands.add(MIGRATE_COMMAND);
		const first = await byokRegister.reapplyStoredProvider(context, provider, [openaiPreset], 'sk-test');
		assert.strictEqual(first.usableViaKodrix, true);
		assert.strictEqual(first.byokRegistered, false);
		assert.strictEqual(providerStore.getActiveProviderId(context), 'kodrix-deepseek');

		// 第二次：Copilot 恢复后再次激活，镜像补齐
		vscodeMock.__state.failCommands.delete(MIGRATE_COMMAND);
		const second = await byokRegister.reapplyStoredProvider(context, provider, [openaiPreset], 'sk-test');
		assert.strictEqual(second.byokRegistered, true, '重新激活必须补上 BYOK 镜像');
	});

	test('无模型 ID 的供应商判定为缺模型，而不是含糊的注册失败', async () => {
		const context = fakeContext();
		const provider = providerStore.storedProviderFromPreset(
			{ ...openaiPreset, models: [] }, [], 'Kodrix: DeepSeek', 'customendpoint',
		);
		provider.id = 'kodrix-empty';
		provider.models = [];
		provider.model = '';

		const res = await byokRegister.reapplyStoredProvider(context, provider, [openaiPreset], 'sk-test');

		assert.strictEqual(res.failureReason, 'missing-model');
	});

	test('空 Key 调用不会覆盖掉已保存的 API Key（激活不得清密）', async () => {
		const context = fakeContext();
		await context.secrets.store('kodrix.apiKey.kodrix-deepseek', 'sk-existing');

		await byokRegister.registerCustomEndpointModels(
			'kodrix-deepseek', 'DeepSeek', 'https://api.deepseek.com/v1',
			['deepseek-chat'], undefined, context, openaiPreset,
		);

		assert.strictEqual(
			await context.secrets.get('kodrix.apiKey.kodrix-deepseek'), 'sk-existing',
			'apiKey 为空时必须保持原值，否则激活一次就把用户的 Key 洗掉了',
		);
	});
});
