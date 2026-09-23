// 全屏 diff 视图验证：stageProposal / edit 应用后版本 / delete 空暂存 / vscode.diff 调用 / preview 流程
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-df-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(wsRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\n');
fs.writeFileSync(path.join(wsRoot, 'src', 'new.ts'), '// 将被整体覆盖\n');

// 捕获 vscode.diff 调用
const diffCalls = [];
const mockPath = path.join(__dirname, 'mock-vscode-diff.js');
fs.writeFileSync(mockPath, `'use strict';
const calls = global.__diffCalls;
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: (section) => ({ get: (key, def) => def }),
		openTextDocument: async () => ({ uri: {} }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showTextDocument: async () => ({}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async (items, opts) => items.length ? (opts && opts.canPickMany ? [items[0]] : items[0]) : undefined,
		showInputBox: async () => undefined,
	},
	commands: {
		registerCommand: (_id, fn) => ({ dispose() {}, fn }),
		executeCommand: async (cmd, ...args) => { if (cmd === 'vscode.diff') calls.push(args); },
	},
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }), Assistant: (text) => ({ role: 'assistant', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
`);
global.__diffCalls = diffCalls;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};
const am = require(path.join(__dirname, '..', 'out', 'apply', 'applyManager.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[A] stageProposal：edit 应用后版本');
	const proposal = {
		name: 'p1',
		task: '改常量',
		createdAt: '2026-09-23T10:00:00.000Z',
		changes: [
			{ filePath: 'src/app.ts', type: 'edit', oldContent: 'const a = 1;', newContent: 'const a = 10;', reason: '升级' },
			{ filePath: 'src/new.ts', type: 'write', newContent: '// 全新文件\n', reason: '新建' },
			{ filePath: 'src/old.ts', type: 'delete' },
		],
	};
	fs.writeFileSync(path.join(wsRoot, 'src', 'old.ts'), '旧文件内容\n', 'utf-8');
	const staged = await am.stageProposal(proposal, wsRoot);
	check('3 个文件全部生成暂存', staged.length === 3, String(staged.length));
	const editS = staged.find(s => s.filePath === 'src/app.ts');
	const editStaged = fs.readFileSync(editS.stagedPath, 'utf-8');
	check('edit 暂存为替换后完整版本', editStaged.includes('const a = 10;') && editStaged.includes('const b = 2;'), editStaged);
	check('原文件未被改动', fs.readFileSync(path.join(wsRoot, 'src', 'app.ts'), 'utf-8').includes('const a = 1;'));
	const writeS = staged.find(s => s.filePath === 'src/new.ts');
	check('write 暂存 = 新内容', fs.readFileSync(writeS.stagedPath, 'utf-8') === '// 全新文件\n');
	const delS = staged.find(s => s.filePath === 'src/delete');
	const delS2 = staged.find(s => s.filePath === 'src/old.ts');
	check('delete 暂存为空文件', delS2 && fs.readFileSync(delS2.stagedPath, 'utf-8') === '');
	check('暂存目录在 .kodrix/apply/p1/staged', editS.stagedPath.includes(path.join('.kodrix', 'apply', 'p1', 'staged')));

	console.log('\n[B] preview 命令 → vscode.diff 调用（编辑器内全屏 diff）');
	am.saveProposal(wsRoot, proposal);
	diffCalls.length = 0;
	const ctx = { subscriptions: [] };
	am.registerApplyManager(ctx);
	check('注册 2 命令（preview/commit）', ctx.subscriptions.length === 2, String(ctx.subscriptions.length));
	const previewFn = ctx.subscriptions[0].fn;
	await previewFn();
	check('调用 vscode.diff 打开 diff', diffCalls.length === 1, String(diffCalls.length));
	const call = diffCalls[0];
	check('diff 左 = 原文件', call[0].fsPath.endsWith(path.join('src', 'app.ts')), call[0]?.fsPath);
	check('diff 右 = 暂存文件', call[1].fsPath.includes('staged'), call[1]?.fsPath);
	check('diff 标题含文件与提案', call[2] && call[2].includes('src/app.ts') && call[2].includes('p1'), String(call[2]));

	console.log('\n[C] 越界路径跳过');
	const evil = {
		name: 'evil', createdAt: '2026-09-23T10:00:00.000Z',
		changes: [{ filePath: '../outside.txt', type: 'write', newContent: 'x' }],
	};
	const evilStaged = await am.stageProposal(evil, wsRoot);
	check('越界变更跳过（不生成暂存）', evilStaged.length === 0, String(evilStaged.length));

	console.log('\n[D] renderProposalMarkdown 保留（降级可用）');
	const md = am.renderProposalMarkdown(proposal, wsRoot);
	check('Markdown 渲染仍可用', md.includes('src/app.ts') && md.includes('diff'));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
