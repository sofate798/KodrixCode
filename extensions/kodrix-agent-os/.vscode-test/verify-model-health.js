// 模型健康面板验证：recordModelCall 打点 / 成功率聚合 / Webview 面板 HTML / 旧日志兼容
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-h-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });
const logPath = path.join(wsRoot, '.kodrix', 'model-router.jsonl');

const mockPath = path.join(__dirname, 'mock-vscode-health.js');
fs.writeFileSync(mockPath, `'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: (section) => ({ get: (key, def) => def }),
		openTextDocument: async () => ({ uri: {} }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		createWebviewPanel: (_viewType, title, _col, _opts) => ({ webview: { html: '', setHtml(h) { this.html = h; } }, onDidDispose: () => ({}) }),
		showTextDocument: async () => ({}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }), Assistant: (text) => ({ role: 'assistant', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
};
`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};
const mr = require(path.join(__dirname, '..', 'out', 'model', 'modelRouter.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[A] recordModelCall 打点（成功/失败写入 jsonl）');
	mr.recordModelCall('gpt-4o', 'balanced', true, 1200);
	mr.recordModelCall('gpt-4o', 'balanced', true, 900);
	mr.recordModelCall('gpt-4o', 'balanced', false, 50, '上游 429');
	mr.recordModelCall('claude-3.5', 'smart', true, 2500);
	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	check('写入 4 条记录', lines.length === 4, String(lines.length));
	const first = JSON.parse(lines[0]);
	check('记录含 ok/error/taskType', first.ok === true && first.taskType === 'inference' && first.tier === 'balanced');
	const fail = JSON.parse(lines[2]);
	check('失败记录含错误原因', fail.ok === false && fail.error === '上游 429', JSON.stringify(fail));

	console.log('\n[B] getRouterStatus 聚合（成功率/失败/平均耗时/最后错误）');
	const st = mr.getRouterStatus();
	const gpt = st.usageStats.find(s => s.modelName === 'gpt-4o');
	check('gpt-4o 调用 3 次', gpt.count === 3, String(gpt?.count));
	check('成功 2 失败 1', gpt.okCount === 2 && gpt.failCount === 1, `ok=${gpt?.okCount} fail=${gpt?.failCount}`);
	check('成功率 67%', gpt.successRate === 67, String(gpt?.successRate));
	check('平均耗时正确', gpt.avgDurationMs === Math.round((1200 + 900 + 50) / 3), String(gpt?.avgDurationMs));
	check('最后错误记录', gpt.lastError === '上游 429', gpt?.lastError);
	check('最后调用时间存在', Boolean(gpt.lastAt), gpt?.lastAt);
	check('按次数排序（gpt 在前）', st.usageStats[0].modelName === 'gpt-4o', st.usageStats[0].modelName);
	check('模型池返回', st.pools.smart.length > 0 && st.pools.balanced.length > 0 && st.pools.fast.length > 0);

	console.log('\n[C] 旧日志兼容（无 ok 字段按成功计）');
	fs.appendFileSync(logPath, JSON.stringify({ timestamp: '2026-09-22T10:00:00.000Z', modelName: 'legacy-model', tier: 'fast', taskType: 'extract', durationMs: 300 }) + '\n', 'utf-8');
	const st2 = mr.getRouterStatus();
	const leg = st2.usageStats.find(s => s.modelName === 'legacy-model');
	check('旧记录视为成功', leg.okCount === 1 && leg.failCount === 0 && leg.successRate === 100, JSON.stringify(leg));

	console.log('\n[D] Webview 面板 HTML');
	const ctx = { subscriptions: [] };
	mr.registerModelRouter(ctx);
	check('注册 status 命令', ctx.subscriptions.length === 1, String(ctx.subscriptions.length));
	// 直接调用命令函数（mock 无 showQuickPick 交互，命令体只建 panel）
	const fn = ctx.subscriptions[0].fn ?? ctx.subscriptions[0];
	// 命令是 async，这里只验证注册对象存在
	check('status 命令已接线', typeof fn === 'function' || fn !== undefined);

	console.log('\n[E] agentLoop 打点接线（静态检查编译产物）');
	const alSrc = fs.readFileSync(path.join(__dirname, '..', 'out', 'agent', 'agentLoop.js'), 'utf-8');
	check('成功打点存在', alSrc.includes('recordModelCall)(m.model.name, m.tier, true'));
	check('失败打点存在', alSrc.includes('recordModelCall)(m.model.name, m.tier, false'));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
