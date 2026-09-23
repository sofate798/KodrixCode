// Agent 推理循环验证：收敛 / 错误恢复 / 迭代上限 / 取消 / 路径安全 / 工具协议
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-al-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });
fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(wsRoot, 'src', 'app.ts'), 'const greeting = "hello";\n// TODO: rename to hi\n');
fs.writeFileSync(path.join(wsRoot, 'src', 'util.ts'), 'export function util() { return 1; }\n');

// ── 可编程假模型：按调用次数返回预设响应 ──
const responses = [];   // 每轮模型输出
let callCount = 0;
const modelPool = [{
	id: 'gpt-4o-mini', name: 'GPT-4o mini', family: 'gpt-4o-mini',
	async sendRequest() {
		const text = responses[Math.min(callCount, responses.length - 1)];
		callCount++;
		return { stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)(text); })() };
	},
}];

const config = { 'kodrix.modelRouter.enabled': true, 'kodrix.agentLoop.maxIterations': 20, 'kodrix.agentLoop.timeoutMs': 600000, 'kodrix.agentLoop.allowCommands': true };

const mockPath = path.join(__dirname, 'mock-vscode-al.js');
fs.writeFileSync(mockPath, `'use strict';
const __pool = [];
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixAlConfig || {};
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
	lm: { selectChatModels: async ({ family } = {}) => { const p = global.__kodrixAlPool; return family ? p.filter(m => m.family === family) : p; } },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }), Assistant: (text) => ({ role: 'assistant', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
`);
global.__kodrixAlConfig = config;
global.__kodrixAlPool = modelPool;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const al = require(path.join(__dirname, '..', 'out', 'agent', 'agentLoop.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}
function reset(seq, extraCfg = {}) {
	responses.length = 0;
	responses.push(...seq);
	callCount = 0;
	Object.assign(config, extraCfg);
}

(async () => {
	console.log('\n[A] 工具协议解析（纯函数）');
	const calls = al.parseToolCalls('<tool_call>\n<name>read_file</name>\n<arguments>{"path":"src/a.ts"}</arguments>\n</tool_call>');
	check('解析 name', calls.length === 1 && calls[0].name === 'read_file', JSON.stringify(calls));
	check('解析 arguments', calls[0].args.path === 'src/a.ts');
	const multi = al.parseToolCalls('思考…<tool_call><name>list_dir</name><arguments>{}</arguments></tool_call>后记<tool_call><name>complete</name><arguments>{"summary":"done"}</arguments></tool_call>');
	check('多调用解析', multi.length === 2 && multi[1].name === 'complete');
	check('容错：坏块跳过', al.parseToolCalls('<tool_call><name>ok</name></tool_call><tool_call>broken').length === 1);
	check('坏 JSON 兜底 raw', al.parseToolCalls('<tool_call><name>x</name><arguments>not-json</arguments></tool_call>')[0].args.raw === 'not-json');
	check('stripToolCalls 剥离调用块', al.stripToolCalls('a<tool_call><name>x</name><arguments>{}</arguments></tool_call>b') === 'a\nb'.replace(/\n/g, '') ? true : al.stripToolCalls('a<tool_call><name>x</name><arguments>{}</arguments></tool_call>b') === 'a  b');
	const stripped = al.stripToolCalls('开始\n<tool_call><name>x</name><arguments>{}</arguments></tool_call>\n[DONE] 完成');
	check('stripToolCalls 去 [DONE]', stripped.includes('完成') && !stripped.includes('[DONE]'));

	console.log('\n[B] 路径安全');
	check('合法路径解析', al.resolveInWorkspace('src/a.ts', wsRoot) === path.join(wsRoot, 'src', 'a.ts'));
	check('越界拒绝', al.resolveInWorkspace('../evil.txt', wsRoot) === undefined);
	check('绝对越界拒绝', al.resolveInWorkspace('/etc/passwd', wsRoot) === undefined);

	console.log('\n[C] 顺序执行收敛（read → edit → complete）');
	reset([
		`我先读取文件。<tool_call><name>read_file</name><arguments>{"path":"src/app.ts"}</arguments></tool_call>`,
		`看到了，修改 TODO。<tool_call><name>edit_file</name><arguments>{"path":"src/app.ts","old":"TODO: rename to hi","new":"DONE: renamed"}</arguments></tool_call>`,
		`完成。<tool_call><name>complete</name><arguments>{"summary":"已将 TODO 标记为 DONE"}</arguments></tool_call>`,
	]);
	const r1 = await al.runAgentLoop({ task: '处理 TODO', workspace: wsRoot });
	check('状态 completed', r1.status === 'completed', r1.status);
	check('完成摘要正确', r1.output.includes('DONE'), r1.output);
	check('文件已修改', fs.readFileSync(path.join(wsRoot, 'src', 'app.ts'), 'utf-8').includes('DONE: renamed'));
	check('迭代 3 轮', r1.iterations === 3, String(r1.iterations));
	check('轨迹含 read 结果', r1.trace.some(t => t.phase === 'tool_result' && t.content.includes('read_file')));
	check('轨迹含 edit 结果', r1.trace.some(t => t.phase === 'tool_result' && t.content.includes('edit_file')));
	check('轨迹含最终', r1.trace.some(t => t.phase === 'final'));

	console.log('\n[D] 错误恢复（先失败 edit → 修正 → 完成）');
	reset([
		`<tool_call><name>edit_file</name><arguments>{"path":"src/app.ts","old":"不存在的文本","new":"x"}</arguments></tool_call>`,
		`第一次 old 未匹配，换正确文本。<tool_call><name>edit_file</name><arguments>{"path":"src/app.ts","old":"const greeting","new":"const welcome"}</arguments></tool_call>`,
		`<tool_call><name>complete</name><arguments>{"summary":"变量已重命名"}</arguments></tool_call>`,
	]);
	const r2 = await al.runAgentLoop({ task: '重命名变量', workspace: wsRoot });
	check('状态 completed', r2.status === 'completed', r2.status);
	check('第一次失败被记录', r2.trace.some(t => t.content.includes('未找到匹配文本')));
	check('第二次成功', fs.readFileSync(path.join(wsRoot, 'src', 'app.ts'), 'utf-8').includes('const welcome'));
	check('迭代 3 轮', r2.iterations === 3, String(r2.iterations));

	console.log('\n[E] 迭代上限中止');
	reset([
		`<tool_call><name>read_file</name><arguments>{"path":"src/app.ts"}</arguments></tool_call>`,
		`<tool_call><name>read_file</name><arguments>{"path":"src/app.ts"}</arguments></tool_call>`,
		`<tool_call><name>read_file</name><arguments>{"path":"src/app.ts"}</arguments></tool_call>`,
	], { 'kodrix.agentLoop.maxIterations': 2 });
	const r3 = await al.runAgentLoop({ task: '不收敛任务', workspace: wsRoot });
	check('状态 max_iterations', r3.status === 'max_iterations', r3.status);

	console.log('\n[F] 无工具直接完成');
	reset(['任务很简单，无需工具。[DONE] 直接输出结果']);
	const r4 = await al.runAgentLoop({ task: '纯文本任务', workspace: wsRoot });
	check('状态 completed', r4.status === 'completed');
	check('输出含结果', r4.output.includes('直接输出结果'), r4.output);

	console.log('\n[G] 取消');
	const cts = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
	const r5 = await al.runAgentLoop({ task: '取消任务', workspace: wsRoot, cancellationToken: cts });
	check('状态 cancelled', r5.status === 'cancelled', r5.status);

	console.log('\n[H] 未知工具 → 报错但循环继续');
	reset([
		`<tool_call><name>no_such_tool</name><arguments>{}</arguments></tool_call>`,
		`<tool_call><name>complete</name><arguments>{"summary":"继续完成"}</arguments></tool_call>`,
	]);
	const r6 = await al.runAgentLoop({ task: '未知工具', workspace: wsRoot });
	check('状态 completed', r6.status === 'completed', r6.status);
	check('未知工具被拒绝', r6.trace.some(t => t.content.includes('未知工具')));

	console.log('\n[I] 路径越界工具拒绝');
	reset([
		`<tool_call><name>write_file</name><arguments>{"path":"../evil.txt","content":"hack"}</arguments></tool_call>`,
		`<tool_call><name>complete</name><arguments>{"summary":"结束"}</arguments></tool_call>`,
	]);
	const r7 = await al.runAgentLoop({ task: '越界写', workspace: wsRoot });
	check('越界被拒绝', r7.trace.some(t => t.content.includes('路径越界')));
	check('未产生越界文件', !fs.existsSync(path.join(tmpRoot, 'evil.txt')));

	console.log('\n[J] 命令禁用');
	reset([
		`<tool_call><name>run_command</name><arguments>{"command":"echo hi"}</arguments></tool_call>`,
		`<tool_call><name>complete</name><arguments>{"summary":"结束"}</arguments></tool_call>`,
	], { 'kodrix.agentLoop.allowCommands': false });
	const r8 = await al.runAgentLoop({ task: '禁命令', workspace: wsRoot });
	check('命令被拒绝', r8.trace.some(t => t.content.includes('命令执行已禁用')));

	console.log('\n[K] codebase_search 无索引提示');
	reset([
		`<tool_call><name>codebase_search</name><arguments>{"query":"router"}</arguments></tool_call>`,
		`<tool_call><name>complete</name><arguments>{"summary":"结束"}</arguments></tool_call>`,
	]);
	const r9 = await al.runAgentLoop({ task: '语义检索', workspace: wsRoot });
	check('提示构建索引', r9.trace.some(t => t.content.includes('索引未构建')));

	console.log('\n[L] 轨迹渲染');
	const md = al.renderTraceMarkdown('测试任务', r1);
	check('含任务与状态', md.includes('测试任务') && md.includes('completed'));
	check('含轨迹与成果', md.includes('轨迹') && md.includes('最终成果'));

	console.log('\n[M] 命令注册');
	const ctx = { subscriptions: [] };
	al.registerAgentLoop(ctx);
	check('注册 4 命令（run/plan/resume/list）', ctx.subscriptions.length === 4, String(ctx.subscriptions.length));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
