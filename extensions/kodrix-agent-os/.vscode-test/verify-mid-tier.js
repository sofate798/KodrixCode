// 中期项验证：模型 Auto 路由 + Agent 间共享上下文传递
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-mt-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });
fs.mkdirSync(path.join(wsRoot, '.kodrix'), { recursive: true });

// ── 模型池（family 过滤模拟） ──
const modelPool = [
	{ id: 'gpt-4o-mini', name: 'GPT-4o mini', family: 'gpt-4o-mini' },
	{ id: 'claude-3.5-haiku', name: 'Claude 3.5 Haiku', family: 'claude-3.5-haiku' },
	{ id: 'copilot-gpt-4-mini', name: 'Copilot GPT-4 mini', family: 'copilot-gpt-4-mini' },
];

// ── 配置（可运行时改） ──
const config = { 'kodrix.modelRouter.enabled': true };

const mockPath = path.join(__dirname, 'mock-vscode-mt.js');
fs.writeFileSync(mockPath, `'use strict';
const __pool = ${JSON.stringify(modelPool)};
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixMtConfig || {};
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
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: {
		selectChatModels: async ({ family } = {}) => {
			if (!family) return __pool;
			return __pool.filter(m => m.family === family);
		},
	},
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
`);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const mr = require(path.join(__dirname, '..', 'out', 'model', 'modelRouter.js'));
const crew = require(path.join(__dirname, '..', 'out', 'crew', 'agentCrew.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[A] 档位解析 resolveTier');
	check('analysis → smart', mr.resolveTier('analysis') === 'smart');
	check('review → smart', mr.resolveTier('review') === 'smart');
	check('coding → balanced', mr.resolveTier('coding') === 'balanced');
	check('terminal → balanced', mr.resolveTier('terminal') === 'balanced');
	check('quick → fast', mr.resolveTier('quick') === 'fast');
	check('未知类型 → balanced', mr.resolveTier('whatever') === 'balanced');
	check('显式 tier 优先', mr.resolveTier('analysis', 'fast') === 'fast');
	check('taskType 大小写不敏感', mr.resolveTier('ANALYSIS') === 'smart');

	console.log('\n[B] 路由决策 routeModel');
	const r1 = await mr.routeModel({ taskType: 'analysis' });
	check('analysis → 档位查找（smart 无 → 兜底 balanced 池 gpt-4o-mini）', r1?.model?.id === 'gpt-4o-mini' && r1?.tier === 'balanced', JSON.stringify(r1 && { id: r1.model.id, tier: r1.tier }));
	const r2 = await mr.routeModel({ taskType: 'coding' });
	check('coding → balanced 池 gpt-4o-mini', r2?.model?.id === 'gpt-4o-mini');
	const r3 = await mr.routeModel({ preferred: 'claude-3.5-haiku' });
	check('preferred 精确指定命中', r3?.model?.id === 'claude-3.5-haiku', String(r3?.model?.id));
	const r4 = await mr.routeModel({ preferred: 'no-such-family' });
	check('preferred 无效 → 走档位兜底', r4?.model?.id === 'gpt-4o-mini', String(r4?.model?.id));
	const r5 = await mr.routeModel({ tier: 'fast' });
	check('显式 fast → gpt-4o-mini', r5?.model?.id === 'gpt-4o-mini');
	const r6 = await mr.routeModel({ taskType: 'coding', tier: 'smart' });
	check('显式 tier 覆盖 taskType（smart 无 → 兜底）', r6?.model?.id === 'gpt-4o-mini');

	console.log('\n[C] 使用记录 recordUsage / readUsageLog / getRouterStatus');
	check('日志文件已生成', fs.existsSync(path.join(wsRoot, '.kodrix', 'model-router.jsonl')));
	const usage = mr.readUsageLog();
	check('日志条目 ≥ 6', usage.length >= 6, String(usage.length));
	check('日志按新→旧排序', usage[0].timestamp >= usage[usage.length - 1].timestamp);
	check('日志含 taskType', usage.some(u => u.taskType === 'analysis'));
	check('日志含 durationMs', usage.every(u => typeof u.durationMs === 'number'));
	const status = mr.getRouterStatus();
	check('状态含三档池', status.pools.smart.length > 0 && status.pools.balanced.length > 0 && status.pools.fast.length > 0);
	check('状态含使用统计', status.usageStats.length >= 1 && status.usageStats[0].count >= 1, JSON.stringify(status.usageStats[0]));

	console.log('\n[D] 路由开关（disabled 降级任意模型）');
	config['kodrix.modelRouter.enabled'] = false;
	const r7 = await mr.routeModel({ taskType: 'analysis' });
	check('disabled → 任意可用模型', r7?.model?.id === 'gpt-4o-mini', String(r7?.model?.id));
	config['kodrix.modelRouter.enabled'] = true;

	console.log('\n[E] 命令注册');
	const ctx = { subscriptions: [] };
	mr.registerModelRouter(ctx);
	check('注册 1 条命令', ctx.subscriptions.length === 1, String(ctx.subscriptions.length));

	console.log('\n[F] Crew 共享上下文（Agent 间传递）');
	const fakeCrew = {
		name: '验收Crew',
		agents: [{ role: 'architect', name: '架构师' }],
		tasks: [{ id: 't1', title: '设计模块', assignedRole: 'architect', dependencies: [], status: 'completed', result: '模块设计文档：含接口定义', updatedAt: '2026-09-22T10:00:00.000Z' }],
	};
	crew.updateCrewSharedContext(fakeCrew, fakeCrew.tasks[0]);
	const ctxFile = path.join(wsRoot, '.kodrix', 'crew-context.md');
	check('crew-context.md 已生成', fs.existsSync(ctxFile));
	if (fs.existsSync(ctxFile)) {
		const content = fs.readFileSync(ctxFile, 'utf-8');
		check('含任务标题', content.includes('设计模块'));
		check('含角色与状态', content.includes('architect') && content.includes('completed'));
		check('含成果摘要', content.includes('模块设计文档'));
	}
	const readBack = crew.readCrewSharedContext();
	check('readCrewSharedContext 返回内容', readBack.includes('设计模块'));
	check('maxChars 截断生效', crew.readCrewSharedContext(20).length <= 20, String(crew.readCrewSharedContext(20).length));

	console.log('\n[G] buildTaskContext 共享上下文注入');
	const t2 = { id: 't2', title: '实现模块', assignedRole: 'coder', dependencies: ['t1'], status: 'pending' };
	const withCtx = crew.buildTaskContext(fakeCrew, t2, { sharedContext: readBack });
	check('带共享上下文：user 含注入段', withCtx.user.includes('## 团队共享上下文（此前任务成果）'), withCtx.user.slice(0, 120));
	check('带共享上下文：内容透传', withCtx.user.includes('设计模块'));
	const withoutCtx = crew.buildTaskContext(fakeCrew, t2);
	check('不带共享上下文：不注入（旧调用兼容）', !withoutCtx.user.includes('## 团队共享上下文'));
	const depCtx = crew.buildTaskContext(fakeCrew, t2, { sharedContext: readBack });
	check('依赖注入仍保留', depCtx.user.includes('上游任务「设计模块」的输出'));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); process.exit(2); });
