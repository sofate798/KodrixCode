// Tab 补全 FIM 通道验证：buildFimPrompt / DeepSeek 请求组装 / 解析 / 降级 / 配置开关
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-fim-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });

// 配置对象（供 mock vscode.workspace.getConfiguration 读取）
const configStore = {
	'enabled': false,
	'mode': 'fim',
	'fimProvider': 'deepseek',
	'fimEndpoint': 'https://api.deepseek.com/beta/fim/completions',
	'fimApiKey': 'sk-test-deepseek-123',
	'fimModel': 'deepseek-chat',
};
const routedFast = { sent: [], ok: true, text: 'return fastValue;' };
const fetchCalls = [];
global.__fimFetchImpl = async (url, opts) => {
	fetchCalls.push({ url, opts });
	return { ok: true, json: async () => ({ choices: [{ text: '```ts\nreturn a + b;\n```' }] }) };
};

const mockVscodePath = path.join(__dirname, 'mock-vscode-fim.js');
fs.writeFileSync(mockVscodePath, `'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: () => ({ get: (key, def) => { const v = global.__fimConfig[key]; return v === undefined ? def : v; } }),
		openTextDocument: async (o) => ({ uri: {}, getText: () => (o && o.content) || '' }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		showTextDocument: async () => ({}),
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {}, fn }), executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: {
		selectChatModels: async () => [{ id: 'mock-fast', name: 'Mock Fast', vendor: 'mock', maxInputTokens: 1000, maxOutputTokens: 1000 }],
	},
	LanguageModelChatMessage: { User: (t) => ({ role: 'user', text: t }), Assistant: (t) => ({ role: 'assistant', text: t }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
	languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
};
`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockVscodePath;
	return origResolve.call(this, request, ...args);
};
// mock 全局 fetch（扩展宿主 Node 全局）
global.fetch = async (url, opts) => global.__fimFetchImpl(url, opts);
global.__fimConfig = configStore;

// modelRouter mock 必须先于 tabCompletion require（依赖在 require 时立即解析）
const mockRouter = path.join(__dirname, 'mock-router-fim.js');
fs.writeFileSync(mockRouter, `'use strict';
module.exports = {
	routeModel: async ({ tier }) => {
		global.__fimFastCalled = tier;
		return {
			model: {
				sendRequest: async () => ({
					stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)('fast result'); })(),
				}),
			},
		};
	},
};
`);
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockVscodePath;
	if (request.endsWith('modelRouter')) return mockRouter;
	return origResolve.call(this, request, ...args);
};

const tc = require(path.join(__dirname, '..', 'out', 'completion', 'tabCompletion.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[A] 纯函数');
	check('buildFimPrompt 前缀+分隔标记', tc.buildFimPrompt('function add(a, b) {') === 'function add(a, b) {' + '<｜fim▁end｜>', JSON.stringify(tc.buildFimPrompt('x')));
	check('buildFimPrompt 去除尾空格', tc.buildFimPrompt('  const x = 1;   ').startsWith('  const x = 1;'));
	check('extractCompletion 剥围栏', tc.extractCompletion('```ts\nreturn a + b;\n```') === 'return a + b;');

	console.log('\n[B] FIM 请求组装（DeepSeek 默认端点）');
	configStore.enabled = true;
	configStore.mode = 'fim';
	configStore.fimApiKey = 'sk-test-deepseek-123';
	const r1 = await tc.provideTabCompletion({ prefix: 'function add(a, b) {\n  return ', suffix: '}', language: 'typescript' });
	check('解析 FIM 文本（剥围栏）', r1 === 'return a + b;', String(r1));
	check('请求 DeepSeek 默认端点', fetchCalls[0].url === 'https://api.deepseek.com/beta/fim/completions', fetchCalls[0].url);
	check('Authorization 含 Key', fetchCalls[0].opts.headers.Authorization === 'Bearer sk-test-deepseek-123');
	const body = JSON.parse(fetchCalls[0].opts.body);
	check('body.model=deepseek-chat', body.model === 'deepseek-chat');
	check('body.prompt 含分隔标记', body.prompt.endsWith('<｜fim▁end｜>'), body.prompt);
	check('body.suffix 独立传', body.suffix === '}');
	check('body.max_tokens=128 / temperature=0', body.max_tokens === 128 && body.temperature === 0);
	check('body.stream=false', body.stream === false);

	console.log('\n[C] 无 Key → 降级 fast 通道');
	global.__fimFastCalled = undefined;
	configStore.fimApiKey = '';
	const r2 = await tc.provideTabCompletion({ prefix: 'x', suffix: '', language: 'ts' });
	check('降级 fast 返回补全', typeof r2 === 'string' && r2.length > 0, String(r2));
	check('fast 通道被调用', global.__fimFastCalled === 'fast');

	console.log('\n[D] mode=fast → 直接 fast 通道（不走 fetch）');
	const before = fetchCalls.length;
	configStore.fimApiKey = 'sk-test-deepseek-123';
	configStore.mode = 'fast';
	const r3 = await tc.provideTabCompletion({ prefix: 'x', suffix: '', language: 'ts' });
	check('fast 模式返回补全', typeof r3 === 'string' && r3.length > 0, String(r3));
	check('未发起 FIM 请求', fetchCalls.length === before, `${fetchCalls.length} vs ${before}`);

	console.log('\n[E] 自定义端点（fimProvider=custom）');
	configStore.mode = 'fim';
	configStore.fimProvider = 'custom';
	configStore.fimEndpoint = 'https://my-fim.example.com/v1/completions';
	await tc.provideTabCompletion({ prefix: 'a', suffix: 'b', language: 'ts' });
	check('使用自定义端点', fetchCalls[fetchCalls.length - 1].url === 'https://my-fim.example.com/v1/completions', fetchCalls[fetchCalls.length - 1].url);

	console.log('\n[F] FIM 端点失败 → 降级 fast');
	global.__fimFetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
	configStore.fimProvider = 'deepseek';
	const r4 = await tc.provideTabCompletion({ prefix: 'a', suffix: 'b', language: 'ts' });
	check('401 降级 fast 返回补全', typeof r4 === 'string' && r4.length > 0, String(r4));

	console.log('\n[G] 开关关闭 → undefined');
	configStore.enabled = false;
	const r5 = await tc.provideTabCompletion({ prefix: 'a', suffix: 'b', language: 'ts' });
	check('关闭返回 undefined', r5 === undefined);

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
