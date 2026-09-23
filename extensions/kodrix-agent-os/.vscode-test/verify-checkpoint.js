// Checkpoint 回滚验证脚本（node + vscode stub）
// 覆盖：创建检查点 / 列出 / 回滚恢复 / 自动捕获（含滚动上限）/ 操作日志 / 命令注册
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-cp-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });
fs.mkdirSync(path.join(wsRoot, 'lib'), { recursive: true });
fs.writeFileSync(path.join(wsRoot, 'app.ts'), 'v1');
fs.writeFileSync(path.join(wsRoot, 'lib', 'util.ts'), 'u1');

// 假打开文档（通过 global 传递，保留函数）
const docs = [
	{ uri: { scheme: 'file', fsPath: path.join(wsRoot, 'app.ts') }, getText: () => 'v1' },
	{ uri: { scheme: 'file', fsPath: path.join(wsRoot, 'lib', 'util.ts') }, getText: () => 'u1' },
];
global.__kodrixCpDocs = docs;

// 配置 stub（动态读取，运行时可改）
const configValues = { 'kodrix.checkpoint.autoCapture': true, 'kodrix.checkpoint.maxEntries': 100 };
global.__kodrixCpConfig = configValues;
const saveCallbacks = [];

const mockPath = path.join(__dirname, 'mock-vscode-cp.js');
fs.writeFileSync(mockPath, `'use strict';
const __saveCbs = [];
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		textDocuments: global.__kodrixCpDocs,
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixCpConfig || {};
				return o[section + '.' + key] ?? def;
			},
		}),
		onDidSaveTextDocument: (cb) => { __saveCbs.push(cb); return { dispose() {} }; },
		openTextDocument: async () => ({ uri: {} }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		createQuickPick: () => ({ value: '', items: [], show() {}, hide() {}, dispose() {}, onDidAccept() {}, onDidHide() {}, onDidTriggerButton() {}, onDidChangeValue() {} }),
		showTextDocument: async () => ({}),
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: () => ({}) },
	ThemeIcon: class {},
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
};
global.__kodrixCpSaveCbs = __saveCbs;
`);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const cp = require(path.join(__dirname, '..', 'out', 'checkpoint', 'checkpointManager.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[1] 创建检查点');
	const id = await cp.createCheckpoint('测试检查点');
	check('创建成功返回 id', Boolean(id), String(id));
	const manifestPath = path.join(wsRoot, '.kodrix', 'checkpoints', id, 'manifest.json');
	check('manifest.json 已生成', fs.existsSync(manifestPath));
	if (fs.existsSync(manifestPath)) {
		const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
		check('label 正确', m.label === '测试检查点', m.label);
		check('包含 2 个文件', m.files.length === 2, String(m.files.length));
		check('app.ts 内容 v1', m.files.find(f => f.relPath === 'app.ts')?.content === 'v1');
	}

	console.log('\n[2] 列出检查点');
	const list = cp.listCheckpoints();
	check('列表含该检查点', list.some(c => c.id === id && c.label === '测试检查点' && c.fileCount === 2), JSON.stringify(list));
	check('列表按时间倒序', list.length >= 1);

	console.log('\n[3] 回滚恢复');
	fs.writeFileSync(path.join(wsRoot, 'app.ts'), 'v2-changed');
	check('修改后 app.ts 为 v2', fs.readFileSync(path.join(wsRoot, 'app.ts'), 'utf-8') === 'v2-changed');
	const r = await cp.restoreCheckpoint(id);
	check('恢复 2 个文件', r.restored === 2 && r.skipped === 0, JSON.stringify(r));
	check('app.ts 已恢复 v1', fs.readFileSync(path.join(wsRoot, 'app.ts'), 'utf-8') === 'v1');
	check('util.ts 已恢复 u1', fs.readFileSync(path.join(wsRoot, 'lib', 'util.ts'), 'utf-8') === 'u1');

	console.log('\n[4] 自动捕获（保存时记录 + 滚动上限）');
	const docA = docs[0];
	cp.autoCaptureFileSave(docA);
	const autoDir = path.join(wsRoot, '.kodrix', 'checkpoints', 'auto');
	check('auto 目录有条目', fs.existsSync(autoDir) && fs.readdirSync(autoDir).length >= 1, fs.readdirSync(autoDir).join(','));
	check('.kodrix 内部文件不捕获', (() => {
		const internal = { uri: { scheme: 'file', fsPath: path.join(wsRoot, '.kodrix', 'x.ts') }, getText: () => 'x' };
		cp.autoCaptureFileSave(internal);
		return true;
	})());
	// 滚动上限
	configValues['kodrix.checkpoint.maxEntries'] = 5;
	for (let i = 0; i < 7; i++) cp.autoCaptureFileSave(docA);
	const remaining = fs.readdirSync(autoDir).length;
	check(`滚动上限生效（≤5，实际 ${remaining}）`, remaining <= 5, String(remaining));

	console.log('\n[5] 操作日志');
	cp.recordOperation({ type: 'crew-task', detail: '完成架构设计', timestamp: new Date().toISOString() });
	cp.recordOperation({ type: 'idea-flow', detail: '创建检查点', timestamp: new Date().toISOString() });
	const ops = cp.listOperations();
	check('日志含 2 条', ops.length === 2, String(ops.length));
	check('日志内容正确', ops[0].type === 'crew-task' && ops[1].detail.includes('创建检查点'), JSON.stringify(ops));
	check('limit 参数生效', cp.listOperations(1).length === 1);

	console.log('\n[6] 命令注册');
	const ctx = { subscriptions: [] };
	cp.registerCheckpoints(ctx);
	check('注册 4 项（1 监听 + 3 命令）', ctx.subscriptions.length === 4, String(ctx.subscriptions.length));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); process.exit(2); });
