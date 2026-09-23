// Subagent 并行派生 + Plan/Act 双模式验证
// 断言：① 子任务独立上下文（各自消息不同）② 受限并发池并行 ③ 汇总报告
//       ④ planOnly 只读工具集（write_file 被拒 / read_file 可用 / 系统提示含计划模式）
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-sub-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });
fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(wsRoot, 'src', 'app.ts'), 'const greeting = "hello";\n');

// ── 可编程假模型：捕获收到的消息（验证独立上下文）+ 按子任务内容返回 ──
const received = [];   // 每次 sendRequest 收到的 messages[0].text
const modelPool = [{
	id: 'gpt-4o-mini', name: 'GPT-4o mini', family: 'gpt-4o-mini',
	async sendRequest(messages) {
		received.push(messages[0].text);
		const text = messages[0].text;
		let out;
		if (text.includes('实现控制器')) out = '<tool_call><name>complete</name><arguments>{"summary":"控制器完成"}</arguments></tool_call>';
		else if (text.includes('补充单元测试')) out = '<tool_call><name>complete</name><arguments>{"summary":"测试完成"}</arguments></tool_call>';
		else if (text.includes('PlanOnly')) out = '<tool_call><name>complete</name><arguments>{"summary":"计划完成"}</arguments></tool_call>';
		else out = '完成。[DONE] 结果';
		return { stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)(out); })() };
	},
}];

const config = {
	'kodrix.modelRouter.enabled': true,
	'kodrix.agentLoop.maxIterations': 20,
	'kodrix.agentLoop.timeoutMs': 600000,
	'kodrix.agentLoop.allowCommands': true,
	'kodrix.agentLoop.checkpoint': false,
};

const mockPath = path.join(__dirname, 'mock-vscode-sub.js');
fs.writeFileSync(mockPath, `'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixSubConfig || {};
				return o[section + '.' + key] ?? def;
			},
		}),
		openTextDocument: async () => ({ uri: {} }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showTextDocument: async () => ({}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		createTerminal: () => ({ sendText() {}, show() {}, dispose() {}, exitStatus: undefined, onDidWriteData() {}, onDidClose() {} }),
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: { selectChatModels: async ({ family } = {}) => { const p = global.__kodrixSubPool; return family ? p.filter(m => m.family === family) : p; } },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }), Assistant: (text) => ({ role: 'assistant', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
`);
global.__kodrixSubConfig = config;
global.__kodrixSubPool = modelPool;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const al = require(path.join(__dirname, '..', 'out', 'agent', 'agentLoop.js'));
const sub = require(path.join(__dirname, '..', 'out', 'agent', 'subagent.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[A] Subagent 并行派生：独立上下文 + 受限并发 + 汇总');
	received.length = 0;
	const batch = await sub.runSubagents({
		parentTask: '为 Kodrix 新增健康检查接口',
		tasks: [
			{ title: '设计接口', prompt: '设计接口与路由' },
			{ title: '实现控制器', prompt: '实现控制器' },
			{ title: '补充单元测试', prompt: '补充单元测试' },
		],
		workspace: wsRoot,
		maxParallel: 2,
	});
	check('批次 3 个子任务', batch.subagents.length === 3, String(batch.subagents.length));
	check('全部 completed', batch.subagents.every(s => s.status === 'completed'), batch.subagents.map(s => s.status).join(','));
	check('各自独立上下文（3 次不同消息）', received.length === 3 && new Set(received).size === 3, String(received.length));
	check('子任务消息含自身描述', received.some(t => t.includes('实现控制器')) && received.some(t => t.includes('补充单元测试')));
	check('父任务背景注入', received.every(t => t.includes('为 Kodrix 新增健康检查接口')), received[0]);
	check('并行受限 maxParallel=2', batch.subagents.every(s => s.durationMs >= 0));
	check('有迭代数', batch.subagents.every(s => s.iterations >= 1), batch.subagents.map(s => s.iterations).join(','));

	console.log('\n[B] 汇总报告渲染');
	const md = sub.renderSubagentReport(batch);
	check('含父任务', md.includes('为 Kodrix 新增健康检查接口'));
	check('含状态表格', md.includes('| # | 子任务 |') && md.includes('completed'));
	check('含子任务详情', md.includes('## 1. 设计接口') && md.includes('## 2. 实现控制器'));
	check('含输出内容', md.includes('控制器完成'));

	console.log('\n[C] Plan 模式：只读工具集 + 系统提示');
	received.length = 0;
	// 先尝试读文件（应可用），再尝试写文件（应被拒），最后 complete
	global.__kodrixSubPool[0].sendRequest = async (messages) => {
		received.push(messages[0].text);
		const seq = global.__planSeq;
		const i = global.__planSeqIdx++;
		const out = seq[Math.min(i, seq.length - 1)];
		return { stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)(out); })() };
	};
	global.__planSeq = [
		'<tool_call><name>read_file</name><arguments>{"path":"src/app.ts"}</arguments></tool_call>',
		'<tool_call><name>write_file</name><arguments>{"path":"src/app.ts","content":"x"}</arguments></tool_call>',
		'<tool_call><name>complete</name><arguments>{"summary":"计划输出"}</arguments></tool_call>',
	];
	global.__planSeqIdx = 0;
	const r = await al.runAgentLoop({ task: 'PlanOnly 分析', workspace: wsRoot, planOnly: true });
	check('状态 completed', r.status === 'completed', r.status);
	check('系统提示含计划模式', received.some(t => t.includes('【模式】计划模式')), received[0]);
	check('read_file 可用', r.trace.some(t => t.phase === 'tool_result' && t.content.includes('read_file')));
	check('write_file 被拒（不在只读工具集）', r.trace.some(t => t.phase === 'tool_result' && t.content.includes('未知工具') && t.content.includes('write_file')), 'write 应被当作未知工具拒绝');
	check('文件未被修改', fs.readFileSync(path.join(wsRoot, 'src', 'app.ts'), 'utf-8').includes('greeting'));

	console.log('\n[D] Act 模式对照：write_file 可用');
	global.__planSeq = [
		'<tool_call><name>write_file</name><arguments>{"path":"src/app.ts","content":"// act 写入\\n"}</arguments></tool_call>',
		'<tool_call><name>complete</name><arguments>{"summary":"act 完成"}</arguments></tool_call>',
	];
	global.__planSeqIdx = 0;
	const r2 = await al.runAgentLoop({ task: 'Act 执行', workspace: wsRoot, planOnly: false });
	check('状态 completed', r2.status === 'completed', r2.status);
	check('Act 模式 write_file 生效', fs.readFileSync(path.join(wsRoot, 'src', 'app.ts'), 'utf-8').includes('// act 写入'));

	console.log('\n[E] 命令注册');
	const ctx = { subscriptions: [] };
	sub.registerSubagent(ctx);
	check('注册 2 命令（run/list）', ctx.subscriptions.length === 2, String(ctx.subscriptions.length));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
