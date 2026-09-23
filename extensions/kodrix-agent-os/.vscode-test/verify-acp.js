// ACP 委派验证：dispatch 完成/失败/超时/落盘/历史/命令注册
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-acp-'));
const realHomedir = os.homedir;
os.homedir = () => tmpRoot;

const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });

global.__acpSpawned = [];
global.__acpChildren = [];
global.__acpChild = undefined;
global.__acpStdin = undefined;
global.__acpKilled = undefined;
global.__acpWarning = undefined;

const mockCpPath = path.join(__dirname, 'mock-cp-acp.js');
fs.writeFileSync(mockCpPath, `'use strict';
const { EventEmitter } = require('events');
module.exports = {
	spawn: (command, args, opts) => {
		global.__acpSpawned.push({ command, args, opts });
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { write: (data) => { global.__acpStdin = data; }, on: () => {}, end: () => {} };
		child.kill = () => { global.__acpKilled = true; };
		global.__acpChild = child;
		global.__acpChildren.push(child);
		return child;
	},
};
`);
const mockVscodePath = path.join(__dirname, 'mock-vscode-acp.js');
fs.writeFileSync(mockVscodePath, `'use strict';
module.exports = {
	workspace: { workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }], openTextDocument: async (o) => ({ uri: {}, getText: () => (o && o.content) || '' }) },
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showInformationMessage: async () => undefined,
		showWarningMessage: async (m) => { global.__acpWarning = m; return undefined; },
		showErrorMessage: async () => undefined,
		showQuickPick: async (items) => (items && items.length ? items[0] : undefined),
		showInputBox: async () => '调研 src 目录重复代码',
		showTextDocument: async () => ({}),
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {}, fn }), executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: (t) => ({ role: 'user', text: t }), Assistant: (t) => ({ role: 'assistant', text: t }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
};
`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockVscodePath;
	if (request === 'child_process') return mockCpPath;
	return origResolve.call(this, request, ...args);
};
const acp = require(path.join(__dirname, '..', 'out', 'acp', 'acpRegistry.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

const agent = {
	id: 'acp-test-1', name: 'Claude Code', command: 'npx claude --input-format stream-json',
	description: '', protocol: 'acp', enabled: true, registeredAt: '2026-09-23T00:00:00.000Z',
};

(async () => {
	console.log('\n[A] dispatch 完成（JSONL 输出收集 + 落盘）');
	const p1 = acp.dispatchAcpTask(agent, '调研 src 目录重复代码', 5000);
	check('spawn 收到启动命令', global.__acpSpawned.length === 1 && global.__acpSpawned[0].command.includes('claude'));
	check('stdin 写入 task JSONL', String(global.__acpStdin).includes('"type":"task"') && String(global.__acpStdin).includes('重复代码'));
	global.__acpChild.stdout.emit('data', Buffer.from('{"type":"text","content":"调研完成：3 处重复"}\n'));
	global.__acpChild.stdout.emit('data', Buffer.from('纯文本补充行\n'));
	global.__acpChild.emit('close', 0);
	const run1 = await p1;
	check('状态 completed', run1.status === 'completed', run1.status);
	check('JSONL text 行收集', run1.output.includes('调研完成：3 处重复'), run1.output);
	check('纯文本行收集', run1.output.includes('纯文本补充行'), run1.output);
	check('结果落盘 runs/<id>.json', fs.existsSync(path.join(tmpRoot, '.kodrix', 'acp', 'runs', `${run1.id}.json`)));
	const disk = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.kodrix', 'acp', 'runs', `${run1.id}.json`), 'utf-8'));
	check('落盘含 agentName/task/status', disk.agentName === 'Claude Code' && disk.task.includes('重复代码') && disk.status === 'completed');

	console.log('\n[B] dispatch 非零退出码 → failed');
	const p2 = acp.dispatchAcpTask(agent, '失败任务', 5000);
	global.__acpChild.emit('close', 1);
	const run2 = await p2;
	check('状态 failed + 退出码错误', run2.status === 'failed' && run2.error.includes('退出码 1'), `${run2.status} / ${run2.error}`);

	console.log('\n[C] dispatch 超时 → kill + timeout');
	const p3 = acp.dispatchAcpTask(agent, '慢任务', 30);
	await new Promise(r => setTimeout(r, 200));
	check('超时后 kill 被调', global.__acpKilled === true);
	global.__acpChild.emit('close', 143);
	const run3 = await p3;
	check('状态 timeout', run3.status === 'timeout', run3.status);
	check('error 含超时说明', Boolean(run3.error && run3.error.includes('超时')), run3.error);

	console.log('\n[D] dispatch 失败（error 事件）→ failed');
	const p4 = acp.dispatchAcpTask(agent, '崩溃任务', 5000);
	global.__acpChild.emit('error', new Error('spawn ENOENT'));
	global.__acpChild.emit('close', 1);
	const run4 = await p4;
	check('状态 failed + spawn 错误', run4.status === 'failed' && run4.error.includes('ENOENT'), `${run4.status} / ${run4.error}`);

	console.log('\n[E] 历史列表（新→旧）');
	const runs = acp.listAcpRuns();
	check('4 条运行记录', runs.length === 4, String(runs.length));
	check('新→旧排序', runs[0].startedAt >= runs[1].startedAt);

	console.log('\n[F] 命令注册（register/list/dispatch/runs）');
	const ctx = { subscriptions: [] };
	acp.registerAcp(ctx);
	check('注册 4 命令', ctx.subscriptions.length === 4, String(ctx.subscriptions.length));
	const dispatchFn = ctx.subscriptions[2]?.fn;
	check('dispatch 命令存在', Boolean(dispatchFn));
	// 有 agent 的交互流（mock QuickPick/InputBox 自动填）→ 走 dispatch → spawn → close(0)
	const p5 = (async () => { try { await dispatchFn(); } catch (e) { global.__acpDispatchError = String(e); } })();
	await new Promise(r => setTimeout(r, 50));
	global.__acpChild.emit('close', 0);
	await p5;
	check('交互流完成（无异常）', global.__acpDispatchError === undefined, global.__acpDispatchError);

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	os.homedir = realHomedir;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); os.homedir = realHomedir; fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
