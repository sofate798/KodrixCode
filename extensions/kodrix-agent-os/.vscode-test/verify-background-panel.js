// 后台 Agent 会话视图验证：面板 HTML 渲染 / 状态 / 命令注册 / open+refresh 消息
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-bg-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(path.join(wsRoot, '.kodrix', 'background'), { recursive: true });

const tasks = [
	{ id: 'bg-1', title: '调研项目现状', status: 'completed', result: '完成调研：三层架构，建议升级索引', createdAt: '2026-09-23T09:00:00.000Z', finishedAt: '2026-09-23T09:02:00.000Z' },
	{ id: 'bg-2', title: '生成升级方案', status: 'running', createdAt: '2026-09-23T09:10:00.000Z' },
	{ id: 'bg-3', title: '清理临时文件', status: 'failed', error: '上游 429 限流', createdAt: '2026-09-23T08:00:00.000Z', finishedAt: '2026-09-23T08:00:05.000Z' },
];
for (const t of tasks) {
	fs.writeFileSync(path.join(wsRoot, '.kodrix', 'background', `${t.id}.json`), JSON.stringify(t, null, 2), 'utf-8');
}

const msgHandlers = [];
const mockPath = path.join(__dirname, 'mock-vscode-bg.js');
fs.writeFileSync(mockPath, `'use strict';
const handlers = global.__bgHandlers;
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: (section) => ({ get: (key, def) => def }),
		openTextDocument: async () => ({ uri: {}, getText: () => '' }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		createWebviewPanel: (_viewType, _title, _col, _opts) => {
			const panel = { webview: { html: '', setHtml(h) { this.html = h; }, onDidReceiveMessage: (fn) => handlers.push(fn) } };
			global.__bgPanel = panel;
			return panel;
		},
		showTextDocument: async () => ({}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {}, fn }), executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }), Assistant: (text) => ({ role: 'assistant', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
};
`);
global.__bgHandlers = msgHandlers;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};
const bg = require(path.join(__dirname, '..', 'out', 'background', 'backgroundAgent.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[A] 命令注册 + 面板建立');
	const ctx = { subscriptions: [] };
	bg.registerBackgroundAgent(ctx);
	check('注册 3 命令（dispatch/list/panel）', ctx.subscriptions.length === 3, String(ctx.subscriptions.length));
	const panelFn = ctx.subscriptions.find(s => s.fn && s.fn.toString().includes('createWebviewPanel'));
	check('panel 命令存在', Boolean(panelFn));
	await panelFn.fn();
	check('panel 已建立', Boolean(global.__bgPanel));
	const html = global.__bgPanel.webview.html;
	check('HTML 含面板标题', html.includes('后台 Agent 会话'));
	check('HTML 含全部任务标题', ['调研项目现状', '生成升级方案', '清理临时文件'].every(x => html.includes(x)));
	check('状态着色（completed 绿 / failed 红）', html.includes('#3fb950') && html.includes('#f85149'));
	check('结果摘要展示', html.includes('三层架构'));
	check('错误摘要展示', html.includes('上游 429'));
	check('行可点击（openTask）', html.includes('openTask('));

	console.log('\n[B] 消息交互：open → 打开任务详情（无异常）');
	check('消息处理器已注册', msgHandlers.length === 1, String(msgHandlers.length));
	await msgHandlers[0]({ command: 'open', id: 'bg-1' });

	console.log('\n[C] 消息交互：refresh → 重渲染');
	await msgHandlers[0]({ command: 'refresh' });
	check('刷新后 HTML 更新', global.__bgPanel.webview.html.includes('共 3 个任务'));

	console.log('\n[D] 任务列表（新→旧）');
	const listed = bg.listBackgroundTasks();
	check('3 个任务且新→旧排序', listed.length === 3 && listed[0].id === 'bg-2' && listed[2].id === 'bg-3', listed.map(t => t.id).join(','));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
