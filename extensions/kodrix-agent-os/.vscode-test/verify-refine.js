// 打磨验证：Checkpoint 集成 + 模型故障转移 + 会话续聊 + BM25 + Embedding + Apply 幂等
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-rf-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });

const config = { 'kodrix.agentLoop.maxIterations': 20, 'kodrix.agentLoop.timeoutMs': 600000, 'kodrix.agentLoop.allowCommands': true, 'kodrix.agentLoop.checkpoint': true };
const modelResponses = [];
let callCount = 0;
let lastMessages = null;

// 坏模型 + 好模型（故障转移测试）
const badModel = {
	id: 'bad-model', name: 'Bad-Model', family: 'copilot-gpt-4',
	async sendRequest() { throw new Error('rate limited (429)'); },
};
const goodModel = {
	id: 'good-model', name: 'Good-Model', family: 'copilot-gpt-4-mini',
	async sendRequest(messages) {
		lastMessages = messages;
		const text = modelResponses[Math.min(callCount, modelResponses.length - 1)];
		callCount++;
		return { stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)(text); })() };
	},
};
const modelPool = [badModel, goodModel];

const mockPath = path.join(__dirname, 'mock-vscode-rf.js');
fs.writeFileSync(mockPath, `'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		textDocuments: [],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixRfConfig || {};
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
	lm: { selectChatModels: async () => (global.__kodrixRfPool || []) },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }), Assistant: (text) => ({ role: 'assistant', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
`);
global.__kodrixRfConfig = config;
global.__kodrixRfPool = modelPool;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const al = require(path.join(__dirname, '..', 'out', 'agent', 'agentLoop.js'));
const ap = require(path.join(__dirname, '..', 'out', 'apply', 'applyManager.js'));
const si = require(path.join(__dirname, '..', 'out', 'codebase', 'semanticIndex.js'));
const mr = require(path.join(__dirname, '..', 'out', 'model', 'modelRouter.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}
function reset(seq) {
	modelResponses.length = 0;
	modelResponses.push(...seq);
	callCount = 0;
	lastMessages = null;
}

(async () => {
	console.log('\n[A] 运行前自动 Checkpoint');
	reset(['<tool_call><name>complete</name><arguments>{"summary":"done"}</arguments></tool_call>']);
	const r1 = await al.runAgentLoop({ task: '测试检查点', workspace: wsRoot });
	check('循环完成', r1.status === 'completed', r1.status);
	check('返回 checkpointId', Boolean(r1.checkpointId), r1.checkpointId);
	const cpDir = path.join(wsRoot, '.kodrix', 'checkpoints');
	check('检查点目录存在', fs.existsSync(cpDir));
	check('manifest 写入', Boolean(r1.checkpointId) && fs.existsSync(path.join(cpDir, r1.checkpointId, 'manifest.json')));
	check('关闭 checkpoint 不创建', (async () => {
		reset(['<tool_call><name>complete</name><arguments>{"summary":"x"}</arguments></tool_call>']);
		const r2 = await al.runAgentLoop({ task: '关检查点', workspace: wsRoot, checkpoint: false });
		return !r2.checkpointId;
	})());

	console.log('\n[B] 模型故障转移（坏模型 → 自动降级好模型）');
	reset(['<tool_call><name>complete</name><arguments>{"summary":"降级成功"}</arguments></tool_call>']);
	const r3 = await al.runAgentLoop({ task: '触发降级', workspace: wsRoot, checkpoint: false });
	check('降级后完成', r3.status === 'completed', r3.status + ' / ' + r3.output);
	check('轨迹含降级记录', r3.trace.some(s => s.content.includes('降级到')), JSON.stringify(r3.trace[0]?.content?.slice(0, 80)));
	check('最终输出正确', r3.output === '降级成功');

	console.log('\n[C] 会话续聊（Threads 简化：resumeFrom 注入历史上下文）');
	reset(['<tool_call><name>complete</name><arguments>{"summary":"续聊完成"}</arguments></tool_call>']);
	const prev = { status: 'failed', output: '上次结果', trace: [{ iteration: 1, phase: 'thought', content: '上次思考' }], iterations: 3, durationMs: 1000 };
	const r4 = await al.runAgentLoop({ task: '续聊任务', workspace: wsRoot, checkpoint: false, resumeFrom: prev });
	check('续聊完成', r4.status === 'completed', r4.status);
	check('历史上下文注入首条消息', lastMessages && String(lastMessages[0].text).includes('历史会话上下文') && String(lastMessages[0].text).includes('上次结果'), JSON.stringify(lastMessages?.[0]?.text?.slice(0, 40)));

	console.log('\n[D] BM25 语义检索（默认路径）');
	si.invalidateSemanticIndex();
	const idx = {
		version: 2, rootPath: wsRoot, createdAt: '', updatedAt: '',
		symbols: {
			'a#validateToken': { id: 'a#validateToken', name: 'validateToken', kind: 'function', filePath: path.join(wsRoot, 'auth.ts'), line: 1, column: 1, signature: 'validateToken(token: string)', docComment: '校验用户登录令牌' },
			'b#renderUser': { id: 'b#renderUser', name: 'renderUser', kind: 'function', filePath: path.join(wsRoot, 'ui.ts'), line: 1, column: 1, signature: 'renderUser(user)', docComment: '渲染用户界面' },
			'c#sendMail': { id: 'c#sendMail', name: 'sendMail', kind: 'function', filePath: path.join(wsRoot, 'mail.ts'), line: 1, column: 1, signature: 'sendMail(to, subject)', docComment: '发送邮件' },
		},
		symbolNameIndex: {}, files: {}, imports: [], dependencyGraph: {}, reverseDependencyGraph: {}, calls: [], hotSymbols: [], stats: { totalFiles: 0, totalSymbols: 3, totalImports: 0, totalCalls: 0, languageDistribution: {}, indexDurationMs: 0 },
	};
	const hits1 = si.searchSymbols(idx, 'validateToken', 5);
	check('符号名命中第一', hits1[0]?.symbol?.name === 'validateToken', JSON.stringify(hits1.map(h => h.symbol.name)));
	const hits2 = si.searchSymbols(idx, 'token 校验 登录', 5);
	check('语义查询命中 validateToken 第一', hits2[0]?.symbol?.name === 'validateToken', JSON.stringify(hits2.map(h => [h.symbol.name, h.score])));
	check('BM25 精准命中（仅共享 token 的文档）', hits2.length === 1 && hits2[0].symbol.name === 'validateToken', JSON.stringify(hits2.map(h => [h.symbol.name, h.score])));
	const stats = si.getSemanticStats(idx);
	check('默认策略 bm25', stats.strategy === 'bm25', stats.strategy);

	console.log('\n[E] EmbeddingProvider 可插（真向量路径）');
	si.invalidateSemanticIndex();
	si.ensureSemanticIndex(idx); // 先构建缓存，预热才能取到 _cacheIndex
	si.registerEmbeddingProvider({
		name: 'mock-embedding',
		async embed(text) {
			const v = new Array(8).fill(0);
			for (const tok of (require(path.join(__dirname, '..', 'out', 'utils', 'textVector.js'))).tokenize(text)) {
				v[(tok.length + tok.charCodeAt(0)) % 8] += 1;
			}
			return v;
		},
	});
	await new Promise(r => setTimeout(r, 150)); // 等待预热
	const eh = await si.searchSymbolsAsync(idx, 'token', 5);
	check('embedding 路径命中 validateToken', eh[0]?.symbol?.name === 'validateToken', JSON.stringify(eh.map(h => h.symbol.name)));
	check('provider 可查询', si.getEmbeddingProvider()?.name === 'mock-embedding');
	const stats2 = si.getSemanticStats(idx);
	check('策略切换 embedding', stats2.strategy === 'embedding', stats2.strategy);

	console.log('\n[F] Apply 幂等（已应用跳过，不整体失败）');
	const target = path.join(wsRoot, 'idem.ts');
	fs.writeFileSync(target, 'const x = 2;\n');
	const idemProp = { name: 'idem', task: '', createdAt: new Date().toISOString(), changes: [
		{ filePath: 'idem.ts', type: 'edit', oldContent: 'const x = 1;', newContent: 'const x = 2;' },
	] };
	const ir = await ap.applyProposal(idemProp, wsRoot, { checkpoint: false });
	check('已应用 → 跳过（不失败）', ir.applied.length === 0 && ir.skipped.length === 1, JSON.stringify(ir));
	check('跳过原因标注已应用', ir.skipped[0].reason.includes('已应用'), ir.skipped[0].reason);
	check('文件未被破坏', fs.readFileSync(target, 'utf-8') === 'const x = 2;\n');

	console.log('\n[G] 模型候选列表（故障转移基础设施）');
	const cands = await mr.getModelCandidates({ taskType: 'coding' });
	check('候选含坏+好模型', cands.length === 2 && cands[0].model.id === 'bad-model' && cands[1].model.id === 'good-model', JSON.stringify(cands.map(c => c.model.id)));
	check('候选去重', new Set(cands.map(c => c.model.id)).size === cands.length);

	console.log('\n[H] 命令注册（run + resume + list）');
	const ctx = { subscriptions: [] };
	al.registerAgentLoop(ctx);
	check('注册 4 命令（run/plan/resume/list）', ctx.subscriptions.length === 4, String(ctx.subscriptions.length));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
