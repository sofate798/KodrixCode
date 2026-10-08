/*---------------------------------------------------------------------------------------------
 *  测试：Tab 补全 FIM 专线 — 端点可配置 / 专线开关 / 降级可观测 / 4xx 会话级熔断 / 统计口径
 *
 *  策略：
 *    - 在 require tabCompletion 之前，向 Module 缓存注入 modelRouter 与 logger 的 stub，
 *      使 fast 通道与日志断言无需真实 VS Code Language Model API；
 *    - 统计模块用真实实现，但将 os.homedir 重定向到临时目录（getKodrixDir 按调用时解析）；
 *    - fetch 全局桩记录每次请求 URL，用于断言端点来源与熔断后不再请求。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vscode mock 已在 runTests.ts 中注册
const vscodeMock = require('./vscode-mock');

// ── 模块 stub（必须先于 tabCompletion 加载注入） ─────────────────────────

function stubModule(relative: string, exportsObj: unknown): void {
	const resolved = require.resolve(relative);
	require.cache[resolved] = {
		id: resolved, filename: resolved, loaded: true, exports: exportsObj, children: [], paths: [],
	} as unknown as NodeModule;
}

const routerState = { calls: 0, fastText: 'FAST_TEXT' as string | undefined };
stubModule('../model/modelRouter', {
	routeModel: async () => {
		routerState.calls++;
		if (!routerState.fastText) {
			return undefined;
		}
		return {
			model: {
				sendRequest: async () => ({
					stream: (async function* () {
						yield new vscodeMock.LanguageModelTextPart(routerState.fastText);
					})(),
				}),
			},
		};
	},
});

const logLines: Array<{ level: string; msg: string }> = [];
stubModule('../logger', {
	logger: {
		info: (m: string) => logLines.push({ level: 'info', msg: m }),
		warn: (m: string, e?: unknown) => logLines.push({ level: 'warn', msg: m + (e ? ` ${String(e)}` : '') }),
		error: (m: string, e?: unknown) => logLines.push({ level: 'error', msg: m + (e ? ` ${String(e)}` : '') }),
		debug: (m: string) => logLines.push({ level: 'debug', msg: m }),
	},
});

const tabCompletion = require('../completion/tabCompletion');
const stats = require('../completion/tabCompletionStats');
const { FIM_DEFAULT_ENDPOINT } = require('../shared/constants');

// ── 测试夹具 ────────────────────────────────────────────────────────────

interface FetchCall { url: string; body: string }
const fetchCalls: FetchCall[] = [];
const originalFetch = (globalThis as Record<string, unknown>).fetch;
const pathsModule = require('../paths');
const originalGetKodrixDir = pathsModule.getKodrixDir;
let tmpHome = '';

const secretState = { apiKey: 'sk-test' as string | undefined };
const fakeContext = {
	subscriptions: [] as Array<{ dispose: () => void }>,
	secrets: { get: async (_key: string) => secretState.apiKey },
};

function stubFetch(response: {
	ok: boolean;
	status: number;
	json?: unknown;
	body?: string;
}): void {
	(globalThis as Record<string, unknown>).fetch = async (url: string | URL, init?: { body?: string }) => {
		fetchCalls.push({ url: String(url), body: String(init?.body ?? '') });
		return {
			ok: response.ok,
			status: response.status,
			json: async () => response.json ?? {},
			text: async () => response.body ?? '',
		};
	};
}

function okFimResponse(text = 'FIM_TEXT'): void {
	stubFetch({ ok: true, status: 200, json: { choices: [{ text }] } });
}

const fakeDoc = {
	languageId: 'typescript',
	lineCount: 2,
	uri: { scheme: 'file', fsPath: '/tmp/sample.ts' },
	getText: (_range?: unknown) => 'function add(a, b) {\n  return ',
	lineAt: (_i: number) => ({ range: { end: { line: 1, character: 0 } } }),
};

function liveToken() {
	return new vscodeMock.CancellationTokenSource().token;
}

function warnText(): string {
	return logLines.filter(l => l.level === 'warn').map(l => l.msg).join('\n');
}

function allLogText(): string {
	return logLines.map(l => `[${l.level}] ${l.msg}`).join('\n');
}

suite('tabCompletion — FIM 专线可配置与可观测', () => {

	setup(async () => {
		vscodeMock.__resetTestConfig();
		vscodeMock.__setTestConfig('kodrix.tabCompletion.enabled', true);
		logLines.length = 0;
		fetchCalls.length = 0;
		routerState.calls = 0;
		routerState.fastText = 'FAST_TEXT';
		secretState.apiKey = 'sk-test';
		tabCompletion.resetFimEndpointBlocklist();
		// 统计文件写入临时目录，不污染真实 ~/.kodrix（tabCompletionStats 按调用时解析 getKodrixDir）
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-fimhome-'));
		pathsModule.getKodrixDir = () => tmpHome;
		tabCompletion.registerTabCompletion(fakeContext);
	});

	teardown(() => {
		stats.flushTabCompletionStats();
		(globalThis as Record<string, unknown>).fetch = originalFetch;
		pathsModule.getKodrixDir = originalGetKodrixDir;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	// ── 端点配置 ─────────────────────────────────────────────────────

	test('未配置时端点保持历史默认值（向后兼容）', async () => {
		okFimResponse();
		const outcome = await tabCompletion.provideTabCompletionOutcome({ prefix: 'x', suffix: '', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 1);
		assert.strictEqual(fetchCalls[0].url, FIM_DEFAULT_ENDPOINT);
		assert.strictEqual(FIM_DEFAULT_ENDPOINT, 'https://api.deepseek.com/beta/fim/completions');
		assert.strictEqual(outcome.channel, 'fim');
		assert.strictEqual(outcome.text, 'FIM_TEXT');
	});

	test('端点来自 kodrix.tabCompletion.fimEndpoint 设置；空值回退默认', async () => {
		okFimResponse();
		vscodeMock.__setTestConfig('kodrix.tabCompletion.fimEndpoint', 'https://my-fim.example.com/v1/completions');
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls[0].url, 'https://my-fim.example.com/v1/completions');
		// 空串/纯空白视为未配置 → 回退默认端点
		fetchCalls.length = 0;
		vscodeMock.__setTestConfig('kodrix.tabCompletion.fimEndpoint', '   ');
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls[0].url, FIM_DEFAULT_ENDPOINT);
	});

	// ── FIM 专线开关 ─────────────────────────────────────────────────

	test('kodrix.tabCompletion.fimEnabled=false 时不发起 FIM 请求，直走 fast', async () => {
		okFimResponse();
		vscodeMock.__setTestConfig('kodrix.tabCompletion.fimEnabled', false);
		const outcome = await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 0, '不应有任何 FIM 网络请求');
		assert.strictEqual(routerState.calls, 1);
		assert.strictEqual(outcome.channel, 'fast');
		assert.strictEqual(outcome.text, 'FAST_TEXT');
	});

	test('默认（不配置 fimEnabled）仍走 FIM — 向后兼容', async () => {
		okFimResponse();
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 1);
	});

	test('无 API Key 时不发 FIM 请求', async () => {
		okFimResponse();
		secretState.apiKey = undefined;
		const outcome = await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 0);
		assert.strictEqual(outcome.channel, 'fast');
	});

	// ── 失败降级 + 可观测 ────────────────────────────────────────────

	test('FIM 500 失败：自动降级但仍产出补全，实际通道记为 fast', async () => {
		stubFetch({ ok: false, status: 500, body: 'Internal Server Error' });
		const outcome = await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.ok(outcome, '降级后仍应产出补全');
		assert.strictEqual(outcome.text, 'FAST_TEXT');
		assert.strictEqual(outcome.channel, 'fast');
	});

	test('FIM 失败被记录：logger 含状态码与端点，统计含 fim.lastFailure', async () => {
		stubFetch({ ok: false, status: 502, body: 'Bad Gateway' });
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.ok(warnText().includes('status=502'), `warn 日志应含状态码，实际：${allLogText()}`);
		assert.ok(warnText().includes(FIM_DEFAULT_ENDPOINT), 'warn 日志应含端点');
		assert.ok(warnText().includes('降级'), '降级事件应有日志');
		const s = stats.getTabCompletionStats();
		assert.strictEqual(s.fim.failures, 1);
		assert.strictEqual(s.fim.lastFailure.status, 502);
		assert.strictEqual(s.fim.lastFailure.endpoint, FIM_DEFAULT_ENDPOINT);
		assert.ok(s.fim.lastFailure.reason.includes('HTTP 502'));
	});

	test('统计口径：降级结果计入 fast 建议，不混入 FIM 命中率（经 Inline provider）', async () => {
		stubFetch({ ok: false, status: 500, body: 'boom' });
		const provider = vscodeMock.languages.__inlineProviders[vscodeMock.languages.__inlineProviders.length - 1];
		const items = await provider.provideInlineCompletionItems(fakeDoc, new vscodeMock.Position(0, 9), {}, liveToken());
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].insertText, 'FAST_TEXT');
		const s = stats.getTabCompletionStats();
		assert.strictEqual(s.byMode.fast?.suggestions, 1, '降级产出应记入 fast 通道');
		assert.strictEqual(s.byMode.fim, undefined, 'FIM 通道不应混计');
		// 接受事件按实际通道归因
		await vscodeMock.commands.__commands['kodrix.tabCompletion.accepted']();
		const s2 = stats.getTabCompletionStats();
		assert.strictEqual(s2.byMode.fast.accepted, 1);
	});

	test('FIM 成功时建议记入 fim 通道', async () => {
		okFimResponse();
		const provider = vscodeMock.languages.__inlineProviders[vscodeMock.languages.__inlineProviders.length - 1];
		await provider.provideInlineCompletionItems(fakeDoc, new vscodeMock.Position(0, 9), {}, liveToken());
		const s = stats.getTabCompletionStats();
		assert.strictEqual(s.byMode.fim?.suggestions, 1);
		assert.strictEqual(s.byMode.fast, undefined);
	});

	test('防抖期间被取消（继续击键）时不发任何请求、不记建议', async () => {
		okFimResponse();
		const provider = vscodeMock.languages.__inlineProviders[vscodeMock.languages.__inlineProviders.length - 1];
		const cts = new vscodeMock.CancellationTokenSource();
		const pending = provider.provideInlineCompletionItems(fakeDoc, new vscodeMock.Position(0, 9), {}, cts.token);
		cts.cancel();
		const items = await pending;
		assert.deepStrictEqual(items, []);
		assert.strictEqual(fetchCalls.length, 0);
		assert.strictEqual(routerState.calls, 0);
		assert.strictEqual(stats.getTabCompletionStats().total.suggestions, 0);
	});

	test('请求中途取消：中止 FIM、不降级 fast、不记失败', async () => {
		const cts = new vscodeMock.CancellationTokenSource();
		(globalThis as Record<string, unknown>).fetch = (_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(new Error('aborted')));
			cts.cancel();
		});
		const outcome = await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' }, cts.token);
		assert.strictEqual(outcome, undefined);
		assert.strictEqual(routerState.calls, 0, '取消后不应降级 fast');
		assert.strictEqual(stats.getTabCompletionStats().fim?.failures ?? 0, 0);
	});

	test('非 https 远端 FIM 端点拒绝携带 Key', async () => {
		okFimResponse();
		vscodeMock.__setTestConfig('kodrix.tabCompletion.fimEndpoint', 'http://evil.example/fim');
		const outcome = await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 0);
		assert.strictEqual(outcome.channel, 'fast');
	});

	// ── 4xx 会话级熔断 ───────────────────────────────────────────────

	test('4xx（404）后端点本会话被跳过：不再发请求，且日志/统计可见', async () => {
		stubFetch({ ok: false, status: 404, body: 'Not Found' });
		const r1 = await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 1);
		assert.strictEqual(r1.text, 'FAST_TEXT');
		assert.strictEqual(tabCompletion.getFimBlockedEndpoint(), FIM_DEFAULT_ENDPOINT);

		// 第二次请求：端点被熔断，fetch 不再被调用，但补全仍由 fast 产出
		fetchCalls.length = 0;
		logLines.length = 0;
		const r2 = await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 0, '熔断端点不应再被请求');
		assert.strictEqual(r2.channel, 'fast');
		assert.ok(warnText().includes('跳过'), `跳过事件应进日志，实际：${allLogText()}`);
		const s = stats.getTabCompletionStats();
		assert.ok(s.fim.skips >= 1, '跳过事件应计入统计 fim.skips');
		assert.strictEqual(s.fim.lastFailure.status, 404);
	});

	test('5xx 不触发熔断（下一次仍尝试 FIM）', async () => {
		stubFetch({ ok: false, status: 500, body: 'boom' });
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 2);
		assert.strictEqual(tabCompletion.getFimBlockedEndpoint(), undefined);
	});

	test('429 限流不触发熔断（瞬时错误）', async () => {
		stubFetch({ ok: false, status: 429, body: 'rate limited' });
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 2);
		assert.strictEqual(tabCompletion.getFimBlockedEndpoint(), undefined);
	});

	test('resetFimEndpointBlocklist 后可恢复请求', async () => {
		stubFetch({ ok: false, status: 404, body: 'gone' });
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(tabCompletion.getFimBlockedEndpoint(), FIM_DEFAULT_ENDPOINT);
		tabCompletion.resetFimEndpointBlocklist();
		okFimResponse();
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		assert.strictEqual(fetchCalls.length, 2);
	});

	// ── 统计面板 ─────────────────────────────────────────────────────

	test('统计面板输出 FIM 专线诊断段（含熔断端点）', async () => {
		stubFetch({ ok: false, status: 503, body: 'unavailable' });
		await tabCompletion.provideTabCompletionOutcome({ prefix: 'a', suffix: 'b', language: 'ts' });
		let captured = '';
		const originalOpen = vscodeMock.workspace.openTextDocument;
		vscodeMock.workspace.openTextDocument = async (opts: { content?: string }) => {
			captured = opts?.content ?? '';
			return originalOpen(opts);
		};
		try {
			await stats.showTabCompletionStats('https://blocked.example/fim');
		} finally {
			vscodeMock.workspace.openTextDocument = originalOpen;
		}
		assert.ok(captured.includes('FIM 专线诊断'), '面板应含 FIM 专线诊断段');
		assert.ok(captured.includes('HTTP 503'), '面板应显示最近失败状态码');
		assert.ok(captured.includes('https://blocked.example/fim'), '面板应显示本会话熔断端点');
	});
});
