// Terminal AI 验证脚本（node + vscode stub，v2）
// 覆盖：命令清理 / 终端获取 / 命令发送 / runCommandInTerminal（shell integration、输出捕获、超时）/ 命令注册
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── fake terminal 工厂 ──
function makeTerminal(name) {
	const t = {
		name,
		sent: [],
		showCalls: 0,
		disposed: false,
		sendText(text, execute) { t.sent.push({ text, execute }); },
		show() { t.showCalls++; },
		dispose() { t.disposed = true; },
	};
	return t;
}

// ── 全局通信对象（mock 与测试脚本共享） ──
const evt = global.__kodrixTermEvents = { terminalData: [], shellExec: [] };
global.__kodrixActiveTerminal = undefined;
const createdTerminal = global.__kodrixCreatedTerminal = makeTerminal('Kodrix Terminal');

// ── vscode stub（源码模板，保留函数） ──
const mockPath = path.join(__dirname, 'mock-vscode-terminal.js');
fs.writeFileSync(mockPath, `'use strict';
const __evt = global.__kodrixTermEvents || (global.__kodrixTermEvents = { terminalData: [], shellExec: [] });
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: __dirname } }],
		getConfiguration: () => ({ get: () => true }),
	},
	window: {
		activeTerminal: global.__kodrixActiveTerminal,
		createTerminal: () => global.__kodrixCreatedTerminal,
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		onDidWriteTerminalData: cb => { __evt.terminalData.push(cb); return { dispose() {} }; },
		onDidStartTerminalShellExecution: cb => { __evt.shellExec.push(cb); return { dispose() {} }; },
		showInformationMessage: async () => undefined,
		showInputBox: async () => undefined,
		createQuickPick: () => ({ value: '', items: [], show() {}, hide() {}, dispose() {}, onDidChangeValue() {}, onDidAccept() {}, onDidHide() {}, onDidTriggerButton() {} }),
	},
	commands: { executeCommand: async () => undefined, registerCommand: (_id, fn) => ({ dispose() {} }) },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: () => ({}) },
	ThemeIcon: class {},
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	Disposable: class {},
};
`);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const ai = require(path.join(__dirname, '..', 'out', 'terminal', 'terminalAi.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[1] 命令清理 sanitizeCommand');
	check('围栏剥离', ai.sanitizeCommand('```bash\nnpm run dev\n```') === 'npm run dev');
	check('语言标签围栏', ai.sanitizeCommand('```sh\nls -la\n```') === 'ls -la');
	check('首尾引号清理', ai.sanitizeCommand("'npm install'") === 'npm install');
	const multi = ai.sanitizeCommand('  npm run build\n\n  git status  ');
	check('多行：首尾 trim + 行尾 trim（保留中间空行）', multi === 'npm run build\n\n  git status', JSON.stringify(multi));
	check('普通命令原样', ai.sanitizeCommand('echo hello') === 'echo hello');

	console.log('\n[2] 终端获取与命令发送');
	const t2 = makeTerminal('t2');
	ai.sendToTerminal(t2, 'npm run dev\ngit status');
	check('多行命令逐行发送', t2.sent.length === 2 && t2.sent[0].text === 'npm run dev' && t2.sent[1].text === 'git status', JSON.stringify(t2.sent));
	const t3 = makeTerminal('t3');
	ai.sendToTerminal(t3, 'a\n\nb');
	check('空行被跳过', t3.sent.length === 2);
	ai.sendToTerminal(t3, '  ');
	check('纯空白行不发送', t3.sent.length === 2);

	console.log('\n[3] runCommandInTerminal — shell integration 完成检测');
	await (() => {
		const term = makeTerminal('shell');
		const p = ai.runCommandInTerminal('echo hi', { terminal: term, timeoutMs: 5000 });
		evt.terminalData.forEach(cb => cb({ terminal: term, data: 'hi\r\n' }));
		const exec = { exitCode: 0, onDidEnd(cb) { setTimeout(() => cb(), 10); } };
		evt.shellExec.forEach(cb => cb({ terminal: term, execution: exec }));
		return p.then(r => {
			check('命令已发送', term.sent.length === 1 && term.sent[0].text === 'echo hi');
			check('输出已捕获', r.output === 'hi\r\n', JSON.stringify(r.output));
			check('退出码透传', r.exitCode === 0, String(r.exitCode));
			check('未超时', r.timedOut === false);
		});
	})();

	console.log('\n[4] runCommandInTerminal — 超时兜底');
	await (() => {
		const term = makeTerminal('timeout');
		return ai.runCommandInTerminal('sleep 999', { terminal: term, timeoutMs: 80 }).then(r => {
			check('超时标记 timedOut=true', r.timedOut === true);
			check('超时仍有输出拼接', typeof r.output === 'string');
		});
	})();

	console.log('\n[5] ensureTerminal 行为');
	(() => {
		global.__kodrixActiveTerminal = undefined;
		const t = ai.ensureTerminal();
		check('无活动终端时新建', t === createdTerminal && t.name === 'Kodrix Terminal', t.name);
		global.__kodrixActiveTerminal = t;
		const t2 = ai.ensureTerminal();
		check('有活动终端时复用', t2 === t);
	})();

	console.log('\n[6] 命令注册');
	const ctx = { subscriptions: [] };
	ai.registerTerminalAI(ctx);
	check('注册了 2 个命令', ctx.subscriptions.length === 2, String(ctx.subscriptions.length));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); process.exit(2); });
