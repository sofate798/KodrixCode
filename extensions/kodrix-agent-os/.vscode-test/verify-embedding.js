// Embedding 语义检索验证：智谱 provider 请求组装/解析/降级 + register/clear + 向量检索路径
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-emb-'));

const fetchCalls = [];
global.__embFetchImpl = async (url, opts) => {
	fetchCalls.push({ url, opts });
	const raw = JSON.parse(opts.body).input;
	const input = Array.isArray(raw) ? raw[0] : raw;
	const vec = input.includes('alpha') ? [1, 0, 0] : input.includes('beta') ? [0, 1, 0] : [0.5, 0.5, 0];
	return { ok: true, json: async () => ({ data: [{ embedding: vec }], model: 'embedding-3' }) };
};
global.fetch = async (url, opts) => global.__embFetchImpl(url, opts);

const mockVscodePath = path.join(__dirname, 'mock-vscode-emb.js');
fs.writeFileSync(mockVscodePath, `'use strict';
module.exports = {
	workspace: { workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(path.join(tmpRoot, 'ws'))} } }], openTextDocument: async (o) => ({ uri: {}, getText: () => (o && o.content) || '' }) },
	window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, showQuickPick: async () => undefined, showInputBox: async () => undefined, showTextDocument: async () => ({}) },
	commands: { registerCommand: (_id, fn) => ({ dispose() {}, fn }), executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: (t) => ({ role: 'user', text: t }), Assistant: (t) => ({ role: 'assistant', text: t }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
	languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
};
`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockVscodePath;
	return origResolve.call(this, request, ...args);
};

const ep = require(path.join(__dirname, '..', 'out', 'codebase', 'embeddingProvider.js'));
const si = require(path.join(__dirname, '..', 'out', 'codebase', 'semanticIndex.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

// 构造最小 ProjectIndex（2 符号）
const index = {
	version: 1,
	rootPath: '/ws',
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	symbols: {
		'a.ts#alphaFunc': { id: 'a.ts#alphaFunc', name: 'alphaFunc', kind: 'function', filePath: '/ws/a.ts', line: 1, column: 1, signature: 'function alphaFunc(x: number): number', doc: 'alpha 相关工具' },
		'b.ts#betaClass': { id: 'b.ts#betaClass', name: 'betaClass', kind: 'class', filePath: '/ws/b.ts', line: 5, column: 1, signature: 'class betaClass', doc: 'beta 实体' },
	},
	symbolNameIndex: { alphaFunc: ['a.ts#alphaFunc'], betaClass: ['b.ts#betaClass'] },
	files: {},
};

(async () => {
	console.log('\n[A] 智谱 Provider 请求组装');
	const provider = ep.createZhipuEmbeddingProvider({ apiKey: 'sk-zhipu-456', model: 'embedding-3' });
	check('name 含模型', provider.name === 'zhipu:embedding-3', provider.name);
	const vec = await provider.embed('alphaFunc 工具');
	check('解析向量', JSON.stringify(vec) === JSON.stringify([1, 0, 0]), JSON.stringify(vec));
	check('默认端点', fetchCalls[0].url === 'https://open.bigmodel.cn/api/paas/v4/embeddings', fetchCalls[0].url);
	check('Authorization 含 Key', fetchCalls[0].opts.headers.Authorization === 'Bearer sk-zhipu-456');
	const body = JSON.parse(fetchCalls[0].opts.body);
	check('body.model=embedding-3', body.model === 'embedding-3');
	check('body.input 为数组（单条）', Array.isArray(body.input) && body.input.length === 1 && body.input[0].includes('alphaFunc'), JSON.stringify(body.input));

	console.log('\n[B] 失败 / 无 Key 降级（返回 undefined）');
	global.__embFetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
	check('401 → undefined', (await ep.createZhipuEmbeddingProvider({ apiKey: 'k' }).embed('x')) === undefined);
	check('无 Key → undefined', (await ep.createZhipuEmbeddingProvider({ apiKey: '' }).embed('x')) === undefined);
	check('自定义端点覆盖', (async () => { global.__embFetchImpl = async (url) => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2] }] }) }); await ep.createZhipuEmbeddingProvider({ apiKey: 'k', endpoint: 'https://custom.emb/v1' }).embed('x'); return fetchCalls[fetchCalls.length - 1].url === 'https://custom.emb/v1'; })());

	console.log('\n[B2] 批量编码（embedBatch）');
	global.__embFetchImpl = async (url, opts) => {
		fetchCalls.push({ url, opts });
		return { ok: true, json: async () => ({ data: [
			{ embedding: [1, 0, 0], index: 0 },
			{ embedding: [0, 1, 0], index: 1 },
			{ embedding: [0, 0, 1], index: 2 },
		] }) };
	};
	const batchBody = (i) => JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
	const pv = ep.createZhipuEmbeddingProvider({ apiKey: 'sk-batch-1' });
	const vecs = await pv.embedBatch(['alpha doc', 'beta doc', 'gamma doc']);
	check('批量一次请求多文本', Array.isArray(batchBody().input) && batchBody().input.length === 3, JSON.stringify(batchBody().input));
	check('批量按 index 返回', vecs.length === 3 && JSON.stringify(vecs[0]) === JSON.stringify([1, 0, 0]) && JSON.stringify(vecs[2]) === JSON.stringify([0, 0, 1]), JSON.stringify(vecs));
	check('embed 委托 batch（单条）', JSON.stringify(await pv.embed('alpha doc')) === JSON.stringify([1, 0, 0]));
	global.__embFetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ embedding: 'bad', index: 0 }] }) });
	const badVecs = await pv.embedBatch(['x']);
	check('非法向量 → undefined 占位', badVecs.length === 1 && badVecs[0] === undefined);

	console.log('\n[C] 向量检索路径（register → warmup → embedding 优先）');
	global.__embFetchImpl = async (url, opts) => {
		const raw = JSON.parse(opts.body).input;
		const input = Array.isArray(raw) ? raw[0] : raw;
		const vec = input.includes('alpha') ? [1, 0, 0] : input.includes('beta') ? [0, 1, 0] : [0.5, 0.5, 0];
		return { ok: true, json: async () => ({ data: [{ embedding: vec }] }) };
	};
	check('初始无 provider', si.getEmbeddingProvider() === null);
	si.registerEmbeddingProvider(ep.createZhipuEmbeddingProvider({ apiKey: 'sk-zhipu-456' }));
	check('注册后 provider 非空', si.getEmbeddingProvider()?.name.startsWith('zhipu'));
	// 轮询 warmup 完成（strategy 变 embedding）
	let stats = si.getSemanticStats(index);
	for (let i = 0; i < 50 && stats.strategy === 'bm25'; i++) {
		await new Promise(r => setTimeout(r, 50));
		stats = si.getSemanticStats(index);
	}
	check('warmup 后 strategy=embedding', stats.strategy === 'embedding', stats.strategy);
	const res = await si.searchSymbolsAsync(index, 'alphaFunc', 10);
	check('向量检索：alpha 相关命中且首位', res.length > 0 && res[0].symbol.name === 'alphaFunc', JSON.stringify(res.map(r => r.symbol.name)));
	check('向量检索：beta 被滤除（余弦 0）', res.every(r => r.symbol.name !== 'betaClass'), JSON.stringify(res.map(r => r.symbol.name)));
	const files = await si.searchFilesAsync(index, 'alphaFunc', 8);
	check('文件级向量检索返回', files.length > 0 && files[0].filePath === '/ws/a.ts', JSON.stringify(files));

	console.log('\n[D] clear → 回退 BM25');
	si.clearEmbeddingProvider();
	check('清除后 provider 为 null', si.getEmbeddingProvider() === null);
	stats = si.getSemanticStats(index);
	check('清除后 strategy=bm25', stats.strategy === 'bm25', stats.strategy);
	const res2 = await si.searchSymbolsAsync(index, 'alphaFunc', 10);
	check('BM25 回退仍可检索', res2.length > 0 && res2[0].symbol.name === 'alphaFunc', JSON.stringify(res2.map(r => r.symbol.name)));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
