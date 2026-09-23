// Tab 补全接受率反馈验证：统计模块 / item.command 回调 / accepted 命令 / stats 命令
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-tstats-'));
const realHomedir = os.homedir;
os.homedir = () => tmpRoot;
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });

const configStore = { 'enabled': true, 'mode': 'fim', 'fimProvider': 'deepseek', 'fimEndpoint': 'https://api.deepseek.com/beta/fim/completions', 'fimApiKey': '', 'fimModel': 'deepseek-chat' };
global.__tstatsRegistered = [];
global.__tstatsProvider = {};
global.__tstatsDocs = [];
global.__tstatsMode = 'fim';

const mockVscodePath = path.join(__dirname, 'mock-vscode-tstats.js');
fs.writeFileSync(mockVscodePath, `'use strict';
class Position { constructor(line, char) { this.line = line; this.character = char; } }
class Range { constructor(s, e) { this.start = s; this.end = e; } }
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: () => ({ get: (key, def) => { const v = global.__tstatsConfig[key]; return v === undefined ? def : v; } }),
		openTextDocument: async (o) => { global.__tstatsDocs.push(o.content); return { uri: {}, getText: () => (o && o.content) || '' }; },
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
	commands: { registerCommand: (id, fn) => { global.__tstatsRegistered.push({ id, fn }); return { dispose() {}, fn }; }, executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: { selectChatModels: async () => [{ id: 'm', name: 'M', vendor: 'v', maxInputTokens: 1000, maxOutputTokens: 1000 }] },
	LanguageModelChatMessage: { User: (t) => ({ role: 'user', text: t }), Assistant: (t) => ({ role: 'assistant', text: t }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
	Position, Range,
	languages: {
		registerInlineCompletionItemProvider: (_sel, provider) => {
			global.__tstatsProvider.provider = provider;
			return { dispose() {} };
		},
	},
};
`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockVscodePath;
	if (request.endsWith('modelRouter')) {
		const mockRouter = path.join(__dirname, 'mock-router-tstats.js');
		if (!fs.existsSync(mockRouter)) {
			fs.writeFileSync(mockRouter, `'use strict';
module.exports = {
	routeModel: async () => ({
		model: { sendRequest: async () => ({ stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)('fast result'); })() }) },
	}),
};
`);
		}
		return mockRouter;
	}
	return origResolve.call(this, request, ...args);
};
global.__tstatsConfig = configStore;

const stats = require(path.join(__dirname, '..', 'out', 'completion', 'tabCompletionStats.js'));
const tc = require(path.join(__dirname, '..', 'out', 'completion', 'tabCompletion.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[A] 统计模块（采集 → 落盘）');
	stats.recordTabSuggestion('fim');
	stats.recordTabSuggestion('fim');
	stats.recordTabAccept('fim');
	let s = stats.getTabCompletionStats();
	check('fim 建议 2 / 接受 1', s.byMode.fim.suggestions === 2 && s.byMode.fim.accepted === 1, JSON.stringify(s.byMode));
	check('total 聚合', s.total.suggestions === 2 && s.total.accepted === 1);
	check('落盘文件存在', fs.existsSync(path.join(tmpRoot, '.kodrix', 'tabCompletionStats.json')));
	// 多模式拆分
	stats.recordTabSuggestion('fast');
	s = stats.getTabCompletionStats();
	check('fast 单独统计', s.byMode.fast.suggestions === 1 && s.byMode.fast.accepted === 0);
	// 损坏兜底
	fs.writeFileSync(path.join(tmpRoot, '.kodrix', 'tabCompletionStats.json'), '{bad', 'utf-8');
	check('损坏兜底（不抛）', stats.getTabCompletionStats().total.suggestions === 0);

	console.log('\n[B] tabCompletion 集成：item.command 接受回调');
	// 重写损坏文件前先清统计（删除重来）
	fs.rmSync(path.join(tmpRoot, '.kodrix'), { recursive: true, force: true });
	const ctx = { subscriptions: [] };
	tc.registerTabCompletion(ctx);
	check('provider 已注册', Boolean(global.__tstatsProvider.provider));
	check('注册 3 项（provider + accepted + stats）', ctx.subscriptions.length === 3, String(ctx.subscriptions.length));
	const doc = {
		getText: () => 'const x = 1;\nconst y = ',
		lineAt: () => ({ range: { end: new (require('vscode').Position)(1, 10) } }),
		languageId: 'typescript',
		lineCount: 2,
	};
	const pos = new (require('vscode').Position)(1, 10);
	const items = await global.__tstatsProvider.provider.provideInlineCompletionItems(doc, pos, {}, {});
	check('返回补全 item', items.length === 1);
	check('item.command 为接受回调', items[0].command?.command === 'kodrix.tabCompletion.accepted', JSON.stringify(items[0].command));
	check('建议已记录（fim +1）', stats.getTabCompletionStats().total.suggestions >= 1, String(stats.getTabCompletionStats().total.suggestions));
	// 执行 accepted 命令 → 接受 +1
	const acceptedCmd = global.__tstatsRegistered.find(c => c.id === 'kodrix.tabCompletion.accepted');
	check('accepted 命令已注册', Boolean(acceptedCmd));
	const before = stats.getTabCompletionStats().total.accepted;
	await acceptedCmd.fn();
	check('接受 +1', stats.getTabCompletionStats().total.accepted === before + 1, `${before} → ${stats.getTabCompletionStats().total.accepted}`);

	console.log('\n[C] stats 命令（Markdown 文档）');
	const statsCmd = global.__tstatsRegistered.find(c => c.id === 'kodrix.tabCompletion.stats');
	check('stats 命令已注册', Boolean(statsCmd));
	await statsCmd.fn();
	check('文档含接受率表头', global.__tstatsDocs.some(c => c.includes('接受率') && c.includes('| 模式 |')));
	check('文档含模式行', global.__tstatsDocs.some(c => c.includes('| fim |')));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	os.homedir = realHomedir;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); os.homedir = realHomedir; fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
