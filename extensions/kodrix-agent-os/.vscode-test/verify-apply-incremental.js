// Apply + propose_changes 闭环 + 增量索引 验证
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-ap-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });

// ── vscode mock（applyManager + projectIndexer + agentLoop + terminalAi 共用） ──
const config = { 'kodrix.modelRouter.enabled': true, 'kodrix.agentLoop.maxIterations': 20, 'kodrix.agentLoop.timeoutMs': 600000, 'kodrix.agentLoop.allowCommands': true };
const modelResponses = [];  // 由测试填充
let callCount = 0;
const modelPool = [{
	id: 'gpt-4o-mini', name: 'GPT-4o mini', family: 'gpt-4o-mini',
	async sendRequest() {
		const text = modelResponses[Math.min(callCount, modelResponses.length - 1)];
		callCount++;
		return { stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)(text); })() };
	},
}];

const mockPath = path.join(__dirname, 'mock-vscode-ap.js');
fs.writeFileSync(mockPath, `'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixApConfig || {};
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
	lm: { selectChatModels: async ({ family } = {}) => { const p = global.__kodrixApPool; return family ? p.filter(m => m.family === family) : p; } },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }), Assistant: (text) => ({ role: 'assistant', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
`);
global.__kodrixApConfig = config;
global.__kodrixApPool = modelPool;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const ap = require(path.join(__dirname, '..', 'out', 'apply', 'applyManager.js'));
const al = require(path.join(__dirname, '..', 'out', 'agent', 'agentLoop.js'));
const pi = require(path.join(__dirname, '..', 'out', 'codebase', 'projectIndexer.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}
function reset(seq) {
	modelResponses.length = 0;
	modelResponses.push(...seq);
	callCount = 0;
}

(async () => {
	console.log('\n[A] 行级 diff 引擎');
	const d1 = ap.diffLines('a\nb\nc', 'a\nX\nc');
	check('diff 序列正确', d1.length === 4 && d1[0].type === 'same' && d1[1].type === 'del' && d1[1].text === 'b' && d1[2].type === 'add' && d1[2].text === 'X', JSON.stringify(d1));
	const d2 = ap.diffLines('', 'new');
	check('空旧文本全 add', d2.length === 1 && d2[0].type === 'add');
	const d3 = ap.diffLines('gone', '');
	check('空新文本全 del', d3.length === 1 && d3[0].type === 'del');
	const d4 = ap.diffLines('same', 'same');
	check('无差异全 same', d4.length === 1 && d4[0].type === 'same');
	const ud = ap.renderUnifiedDiff('src/x.ts', 'line1\nold\nline3', 'line1\nnew\nline3');
	check('unified diff 头', ud.includes('--- a/src/x.ts') && ud.includes('+++ b/src/x.ts') && ud.includes('@@'));
	check('unified diff 增减行', ud.includes('-old') && ud.includes('+new'));

	console.log('\n[B] 变更校验');
	check('edit old 不匹配', ap.validateChange({ filePath: 'nope.ts', type: 'edit', oldContent: 'x', newContent: 'y' }, wsRoot).ok === false);
	check('edit 文件不存在', ap.validateChange({ filePath: 'missing.ts', type: 'edit', oldContent: 'x', newContent: 'y' }, wsRoot).ok === false);
	check('越界路径', ap.validateChange({ filePath: '../evil.ts', type: 'write', newContent: '' }, wsRoot).ok === false);
	check('delete 不存在文件', ap.validateChange({ filePath: 'absent.ts', type: 'delete', newContent: '' }, wsRoot).ok === false);
	fs.writeFileSync(path.join(wsRoot, 'ok.ts'), 'abc\nabc\n');
	check('edit 多匹配拒绝', ap.validateChange({ filePath: 'ok.ts', type: 'edit', oldContent: 'abc', newContent: 'zzz' }, wsRoot).ok === false);
	check('write 合法', ap.validateChange({ filePath: 'newfile.ts', type: 'write', newContent: 'x' }, wsRoot).ok === true);

	console.log('\n[C] 提案 I/O');
	const prop = { name: 'p1', task: '测试', createdAt: new Date().toISOString(), changes: [
		{ filePath: 'src/a.ts', type: 'write', newContent: 'export const a = 1;\n' },
		{ filePath: 'src/b.ts', type: 'write', newContent: 'export const b = 2;\n' },
	] };
	const saved = ap.saveProposal(wsRoot, prop);
	check('提案已保存', fs.existsSync(saved));
	check('列表可查', ap.listProposals(wsRoot).includes('p1.json'));
	const loaded = ap.loadProposal(wsRoot, 'p1.json');
	check('读回 2 个变更', loaded?.changes.length === 2);

	console.log('\n[D] 应用提案（write + edit + delete + 备份）');
	fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
	fs.writeFileSync(path.join(wsRoot, 'src', 'a.ts'), 'const old = 1;\n');
	fs.writeFileSync(path.join(wsRoot, 'src', 'b.ts'), 'const keep = 2;\n');
	const prop2 = { name: 'p2', task: '应用', createdAt: new Date().toISOString(), changes: [
		{ filePath: 'src/a.ts', type: 'write', newContent: 'export const a = 10;\n' },
		{ filePath: 'src/b.ts', type: 'edit', oldContent: 'const keep = 2;', newContent: 'export const keep2 = 20;' },
		{ filePath: 'src/c.ts', type: 'write', newContent: 'export const c = 30;\n' },
		{ filePath: 'src/delete-me.ts', type: 'delete', newContent: '' },
	] };
	fs.writeFileSync(path.join(wsRoot, 'src', 'delete-me.ts'), 'bye');
	const r = await ap.applyProposal(prop2, wsRoot, { checkpoint: false });
	check('应用 4 个文件', r.applied.length === 4, JSON.stringify(r));
	check('write 生效', fs.readFileSync(path.join(wsRoot, 'src', 'a.ts'), 'utf-8') === 'export const a = 10;\n');
	check('edit 生效', fs.readFileSync(path.join(wsRoot, 'src', 'b.ts'), 'utf-8').includes('export const keep2 = 20;'));
	check('新建生效', fs.readFileSync(path.join(wsRoot, 'src', 'c.ts'), 'utf-8').includes('const c = 30'));
	check('删除生效', !fs.existsSync(path.join(wsRoot, 'src', 'delete-me.ts')));
	check('备份已生成', fs.existsSync(path.join(wsRoot, '.kodrix', 'apply-backups')));

	console.log('\n[E] 校验失败整体拒绝');
	const bad = { name: 'p3', task: '', createdAt: new Date().toISOString(), changes: [
		{ filePath: 'src/a.ts', type: 'edit', oldContent: '不存在的文本', newContent: 'x' },
		{ filePath: 'src/ok2.ts', type: 'write', newContent: 'fine' },
	] };
	const r2 = await ap.applyProposal(bad, wsRoot, { checkpoint: false });
	check('整体拒绝（0 应用）', r2.applied.length === 0 && r2.skipped.length === 2, JSON.stringify(r2));
	check('未产生 ok2.ts', !fs.existsSync(path.join(wsRoot, 'src', 'ok2.ts')));

	console.log('\n[F] propose_changes 闭环（Agent Loop 工具）');
	reset([
		`分析完毕。<tool_call><name>propose_changes</name><arguments>{"task":"生成补丁","changes":[{"filePath":"src/patch.ts","type":"write","newContent":"export const patch = 1;","reason":"新增补丁文件"}]}</arguments></tool_call>`,
		`<tool_call><name>complete</name><arguments>{"summary":"提案已生成"}</arguments></tool_call>`,
	]);
	const rl = await al.runAgentLoop({ task: '生成变更提案', workspace: wsRoot });
	check('循环完成', rl.status === 'completed', rl.status);
	const proposals = ap.listProposals(wsRoot);
	check('提案列表含 agent 提案', proposals.some(f => f.startsWith('agent-')), proposals.join(','));
	const agentPropName = proposals.find(f => f.startsWith('agent-'));
	const agentProp = ap.loadProposal(wsRoot, agentPropName);
	check('agent 提案变更正确', agentProp?.changes[0]?.filePath === 'src/patch.ts' && agentProp.changes[0].newContent.includes('patch = 1'));
	check('未实际修改文件', !fs.existsSync(path.join(wsRoot, 'src', 'patch.ts')));

	console.log('\n[G] 提案渲染 + 命令注册');
	const md = ap.renderProposalMarkdown(prop2, wsRoot);
	check('渲染含 diff 代码块', md.includes('```diff') && md.includes('src/c.ts'));
	const ctx = { subscriptions: [] };
	ap.registerApplyManager(ctx);
	check('注册 2 命令', ctx.subscriptions.length === 2, String(ctx.subscriptions.length));

	console.log('\n[H] 增量索引（Merkle 式）');
	fs.mkdirSync(path.join(wsRoot, 'proj'), { recursive: true });
	fs.writeFileSync(path.join(wsRoot, 'proj', 'a.ts'), 'export function alpha() { return 1; }\n');
	fs.writeFileSync(path.join(wsRoot, 'proj', 'b.ts'), 'export function betaFn() { return 2; }\n');
	const statA = fs.statSync(path.join(wsRoot, 'proj', 'a.ts'));
	const statB = fs.statSync(path.join(wsRoot, 'proj', 'b.ts'));
	const idx = {
		version: 2,
		rootPath: path.join(wsRoot, 'proj'),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		symbols: {
			[path.join(wsRoot, 'proj', 'a.ts') + '#alpha']: { id: path.join(wsRoot, 'proj', 'a.ts') + '#alpha', name: 'alpha', kind: 'function', filePath: path.join(wsRoot, 'proj', 'a.ts'), line: 1, column: 1 },
			[path.join(wsRoot, 'proj', 'b.ts') + '#betaFn']: { id: path.join(wsRoot, 'proj', 'b.ts') + '#betaFn', name: 'betaFn', kind: 'function', filePath: path.join(wsRoot, 'proj', 'b.ts'), line: 1, column: 1 },
		},
		symbolNameIndex: {
			alpha: [path.join(wsRoot, 'proj', 'a.ts') + '#alpha'],
			betaFn: [path.join(wsRoot, 'proj', 'b.ts') + '#betaFn'],
		},
		files: {
			[path.join(wsRoot, 'proj', 'a.ts')]: { filePath: path.join(wsRoot, 'proj', 'a.ts'), relativePath: 'a.ts', symbolCount: 1, exportCount: 1, importCount: 0, sizeBytes: statA.size, lastModified: statA.mtimeMs, language: 'ts' },
			[path.join(wsRoot, 'proj', 'b.ts')]: { filePath: path.join(wsRoot, 'proj', 'b.ts'), relativePath: 'b.ts', symbolCount: 1, exportCount: 1, importCount: 0, sizeBytes: statB.size, lastModified: statB.mtimeMs, language: 'ts' },
		},
		imports: [],
		dependencyGraph: {},
		reverseDependencyGraph: {},
		calls: [],
		hotSymbols: [],
		stats: { totalFiles: 2, totalSymbols: 2, totalImports: 0, totalCalls: 0, languageDistribution: { '.ts': 2 }, indexDurationMs: 0 },
	};
	// 变更：a.ts 改名 alpha→alpha2；删除 b.ts；新增 c.ts
	fs.writeFileSync(path.join(wsRoot, 'proj', 'a.ts'), 'export function alpha2() { return 1; }\n');
	fs.rmSync(path.join(wsRoot, 'proj', 'b.ts'));
	fs.writeFileSync(path.join(wsRoot, 'proj', 'c.ts'), 'export function gamma() { return 3; }\n');
	const upd = await pi.updateProjectIndexIncrementally(idx);
	check('符号 alpha 移除', !Object.keys(upd.symbols).some(id => id.endsWith('#alpha')));
	check('符号 alpha2 加入', Object.keys(upd.symbols).some(id => id.endsWith('#alpha2')), Object.keys(upd.symbols).join(','));
	check('符号 betaFn 移除', !Object.keys(upd.symbols).some(id => id.endsWith('#betaFn')));
	check('符号 gamma 加入', Object.keys(upd.symbols).some(id => id.endsWith('#gamma')));
	check('files 计数 2（a+c）', upd.stats.totalFiles === 2, String(upd.stats.totalFiles));
	check('b.ts 从 files 移除', !upd.files[path.join(wsRoot, 'proj', 'b.ts')]);
	check('c.ts 进入 files', Boolean(upd.files[path.join(wsRoot, 'proj', 'c.ts')]));
	check('符号总数 2', upd.stats.totalSymbols === 2, String(upd.stats.totalSymbols));
	check('语言分布更新', upd.stats.languageDistribution['.ts'] === 2);
	// 无变更时快速返回
	const again = await pi.updateProjectIndexIncrementally(upd);
	check('无变更幂等返回', again === upd);

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
