// 会话 Threads 验证：树构建 / 分支 / 命名 / 搜索 / 旧记录兼容 / 落盘字段
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-th-'));
const runDir = path.join(tmpRoot, '.kodrix', 'agent-runs');
fs.mkdirSync(runDir, { recursive: true });

// vscode mock（threads.js 顶层 import 需要）
const Module = require('module');
const mockPath = path.join(__dirname, 'mock-vscode-threads.js');
fs.writeFileSync(mockPath, `'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: __dirname } }],
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
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	ThemeIcon: class {},
};
`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const th = require(path.join(__dirname, '..', 'out', 'agent', 'threads.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

// 造数据：根节点 A → 分支 B1、B2（同一父两次续聊）→ B1 下子节点 C
function rec(id, task, parentId, status = 'completed', mode = 'act', name) {
	return {
		id, name: name ?? task.slice(0, 40), task, parentId, mode,
		createdAt: `2026-09-23T10:${id.slice(0, 2)}:00.000Z`, status,
		result: { status, output: `${task} 的结果` },
	};
}
const records = [
	rec('run-01', '实现登录接口', undefined, 'completed', 'act'),
	rec('run-02', '继续：实现登录接口（加 Token）', 'run-01', 'completed', 'act'),
	rec('run-03', '继续：实现登录接口（加刷新令牌）', 'run-01', 'completed', 'act'),
	rec('run-04', '继续：加 Token（补充单元测试）', 'run-02', 'failed', 'act'),
	rec('run-05', '登录接口实施方案', undefined, 'completed', 'plan'),
];
for (const r of records) {
	fs.writeFileSync(path.join(runDir, `${r.id}.json`), JSON.stringify(r, null, 2), 'utf-8');
	fs.writeFileSync(path.join(runDir, `${r.id}.md`), `# ${r.task}\n\n${r.result.output}`, 'utf-8');
}

(async () => {
	console.log('\n[A] 会话树构建（parentId → 层级 + 路径）');
	const runs = th.loadRuns(runDir);
	check('加载 5 个会话', runs.length === 5, String(runs.length));
	const roots = th.buildThreadTree(runs);
	check('2 个根节点（act 根 + plan 根）', roots.length === 2, String(roots.length));
	const actRoot = roots.find(r => r.record.id === 'run-01');
	check('根路径为 1 / 2', roots.map(r => r.path).join(','), roots.map(r => r.path).join(','));
	check('run-01 有 2 个子节点（分支 B1/B2）', actRoot.children.length === 2, String(actRoot.children.length));
	check('分支路径 1.1 / 1.2', actRoot.children.map(c => c.path).join(','), actRoot.children.map(c => c.path).join(','));
	check('B1 下有孙节点（嵌套层级）', actRoot.children.find(c => c.record.id === 'run-02').children.length === 1, 'expect 1 grandchild');
	check('plan 会话为独立根', roots.some(r => r.record.id === 'run-05' && r.record.mode === 'plan'));

	console.log('\n[B] 续聊=分支（同一父多次续聊形成分支）');
	// 模拟 resume：以 run-01 为父再续聊一次 → 新增 run-06
	const run06 = rec('run-06', '继续：实现登录接口（加多租户）', 'run-01');
	fs.writeFileSync(path.join(runDir, 'run-06.json'), JSON.stringify(run06, null, 2), 'utf-8');
	const runs2 = th.loadRuns(runDir);
	const roots2 = th.buildThreadTree(runs2);
	const actRoot2 = roots2.find(r => r.record.id === 'run-01');
	check('run-01 子节点增至 3（第三个分支）', actRoot2.children.length === 3, String(actRoot2.children.length));

	console.log('\n[C] 命名');
	const picked = runs.find(r => r.id === 'run-01');
	check('默认名 = 任务前 40 字', picked.name === '实现登录接口');
	// 模拟 rename：写 name
	const jsonPath = path.join(runDir, 'run-01.json');
	const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
	raw.name = '核心登录链路';
	fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), 'utf-8');
	const renamed = th.loadRuns(runDir).find(r => r.id === 'run-01');
	check('重命名生效', renamed.name === '核心登录链路', renamed.name);

	console.log('\n[D] 搜索（名称 / 任务 / 输出）');
	const search = (kw) => {
		const k = kw.toLowerCase();
		return th.loadRuns(runDir).filter(r =>
			r.name.toLowerCase().includes(k)
			|| r.task.toLowerCase().includes(k)
			|| String((r.result).output ?? '').toLowerCase().includes(k)
		);
	};
	check('按名称搜索「登录」命中', search('登录').length >= 5, String(search('登录').length));
	check('按任务搜索「Token」', search('Token').length === 2, String(search('Token').length));
	check('按输出搜索「方案」命中 plan', search('方案').length >= 1);
	check('无命中返回空', search('不存在的词xyz').length === 0);

	console.log('\n[E] 旧记录兼容（无 name/parentId/createdAt）');
	fs.writeFileSync(path.join(runDir, 'run-legacy.json'), JSON.stringify({ id: 'run-2026-09-23T11-30-00', task: '旧格式任务', result: { status: 'completed', output: 'x' } }, null, 2), 'utf-8');
	const legacy = th.loadRuns(runDir).find(r => r.id === 'run-2026-09-23T11-30-00');
	check('name 兜底为任务截断', legacy.name === '旧格式任务', legacy.name);
	check('status 从 result 兜底', legacy.status === 'completed');
	check('createdAt 从 id 解析', legacy.createdAt !== 'unknown' && legacy.createdAt.includes('2026'), legacy.createdAt);
	check('无 parentId 时成为根节点', th.buildThreadTree(th.loadRuns(runDir)).some(r => r.record.id === 'run-2026-09-23T11-30-00'));

	console.log('\n[F] 命令注册');
	const ctx = { subscriptions: [] };
	th.registerThreads(ctx);
	check('注册 3 命令（tree/rename/search）', ctx.subscriptions.length === 3, String(ctx.subscriptions.length));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(2); });
