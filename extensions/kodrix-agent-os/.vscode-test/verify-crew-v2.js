// Crew v2 纯函数验证脚本（node + vscode stub）
// 验证：chunkTasks / getNextRunnableTasks / buildTaskContext
'use strict';
const Module = require('module');
const path = require('path');

// ── vscode stub（agentCrew.js 顶层仅 import，函数内才使用 API） ──
const mockVscodePath = path.join(__dirname, 'mock-vscode.js');
require('fs').writeFileSync(mockVscodePath, `'use strict';\nmodule.exports = { workspace: {}, window: {}, commands: {}, lm: {}, CancellationTokenSource: class {}, LanguageModelChatMessage: { User: () => ({}) } };\n`);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockVscodePath;
	return origResolve.call(this, request, ...args);
};

const crew = require(path.join(__dirname, '..', 'out', 'crew', 'agentCrew.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) {
		console.log(`  ✔ ${name}`);
	} else {
		failures++;
		console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`);
	}
}

// ── fixture ──
const ts = '2026-09-22T00:00:00.000Z';
function task(partial) {
	return Object.assign({
		id: '', title: '', description: '', assignedRole: 'coder',
		dependencies: [], status: 'pending', createdAt: ts, updatedAt: ts,
	}, partial);
}
const crewFixture = {
	name: 'demo',
	workflow: 'parallel',
	agents: [
		{ id: 'a', role: 'architect', name: 'Architect', systemPrompt: '你是架构师', tools: [] },
		{ id: 'c', role: 'coder', name: 'Coder', systemPrompt: '你是开发者', tools: [] },
		{ id: 'r', role: 'reviewer', name: 'Reviewer', systemPrompt: '你是审查者', tools: [] },
	],
	tasks: [
		task({ id: 't1', title: '设计', assignedRole: 'architect', dependencies: [] }),
		task({ id: 't2', title: '实现', assignedRole: 'coder', dependencies: ['t1'] }),
		task({ id: 't3', title: '审查', assignedRole: 'reviewer', dependencies: ['t2'] }),
		task({ id: 't4', title: '独立测试', assignedRole: 'coder', dependencies: [] }),
	],
	createdAt: ts, updatedAt: ts,
};

console.log('\n[1] chunkTasks — 分批工具');
check('空数组 → []', JSON.stringify(crew.chunkTasks([], 3)) === '[]');
check('size>len → 单批', JSON.stringify(crew.chunkTasks([1, 2], 5)) === '[[1,2]]');
check('size=1 → 每项一批', JSON.stringify(crew.chunkTasks([1, 2, 3], 1)) === '[[1],[2],[3]]');
check('size=2 → [[1,2],[3]]', JSON.stringify(crew.chunkTasks([1, 2, 3], 2)) === '[[1,2],[3]]');
check('size=0 → 回落为 1', JSON.stringify(crew.chunkTasks([1, 2], 0)) === '[[1],[2]]');

console.log('\n[2] getNextRunnableTasks — 依赖就绪判定');
let runnable = crew.getNextRunnableTasks(crewFixture);
check('初始：t1、t4 可运行', runnable.map(t => t.id).sort().join(',') === 't1,t4', JSON.stringify(runnable.map(t => t.id)));

const mid = JSON.parse(JSON.stringify(crewFixture));
mid.tasks.find(t => t.id === 't1').status = 'completed';
runnable = crew.getNextRunnableTasks(mid);
check('t1 完成后：t2 解锁', runnable.map(t => t.id).sort().join(',') === 't2,t4', JSON.stringify(runnable.map(t => t.id)));

const full = JSON.parse(JSON.stringify(mid));
full.tasks.find(t => t.id === 't2').status = 'completed';
runnable = crew.getNextRunnableTasks(full);
check('t2 完成后：t3 解锁', runnable.map(t => t.id).sort().join(',') === 't3,t4', JSON.stringify(runnable.map(t => t.id)));

const blocked = JSON.parse(JSON.stringify(crewFixture));
blocked.tasks.find(t => t.id === 't1').status = 'failed';
runnable = crew.getNextRunnableTasks(blocked);
check('t1 失败后：t2 保持阻塞', runnable.map(t => t.id).join(',') === 't4', JSON.stringify(runnable.map(t => t.id)));

console.log('\n[3] buildTaskContext — 跨 Agent 上下文传递');
// 无依赖
const noDep = crew.buildTaskContext(crewFixture, crewFixture.tasks[0]);
check('system 含角色职责', noDep.system.includes('架构师'));
check('user 含任务标题', noDep.user.includes('设计'));
check('user 依赖段为「（无）」', noDep.user.includes('（无）'));

// 有依赖输出
const withDep = JSON.parse(JSON.stringify(crewFixture));
withDep.tasks.find(t => t.id === 't1').result = '方案：使用 JWT + refresh token 双令牌机制';
const ctx = crew.buildTaskContext(withDep, withDep.tasks[1]);
check('user 注入上游输出全文', ctx.user.includes('JWT + refresh token'));
check('user 标注上游任务标题', ctx.user.includes('上游任务「设计」'));

// 依赖无输出（占位）
const noOut = JSON.parse(JSON.stringify(crewFixture));
noOut.tasks.find(t => t.id === 't1').status = 'completed'; // result 未设置
const ctx2 = crew.buildTaskContext(noOut, noOut.tasks[1]);
check('依赖无输出 → 占位说明', ctx2.user.includes('该任务无输出'));

// 截断
const longDep = JSON.parse(JSON.stringify(crewFixture));
longDep.tasks.find(t => t.id === 't1').result = 'X'.repeat(5000);
const ctx3 = crew.buildTaskContext(longDep, longDep.tasks[1], { maxDepChars: 100 });
check('依赖输出超限截断到 maxDepChars', ctx3.user.includes('X'.repeat(100)) && ctx3.user.includes('上下文截断'));
const depSection = ctx3.user.split('## 上游依赖上下文')[1] ?? '';
const xCount = (depSection.match(/X/g) || []).length;
check('截断后依赖输出本体长度 = maxDepChars(100)', xCount === 100, `xCount=${xCount}`);
check('依赖区块总长有界（<300，防上下文爆炸）', depSection.length < 300, `len=${depSection.length}`);

// 多依赖注入
const multi = JSON.parse(JSON.stringify(crewFixture));
multi.tasks = [
	task({ id: 'd1', title: '甲', dependencies: [], result: '输出A' }),
	task({ id: 'd2', title: '乙', dependencies: [], result: '输出B' }),
	task({ id: 'm1', title: '汇总', dependencies: ['d1', 'd2'] }),
];
const ctx4 = crew.buildTaskContext(multi, multi.tasks[2]);
check('多依赖按声明顺序注入', ctx4.user.indexOf('输出A') < ctx4.user.indexOf('输出B'));

// chat 模式任务不被 runAll 自动执行（调度过滤逻辑在 runAll 内，此处验证 getNextRunnableTasks 对 mode 无偏见）
const chatMode = JSON.parse(JSON.stringify(crewFixture));
chatMode.tasks[0].mode = 'chat';
runnable = crew.getNextRunnableTasks(chatMode);
check('getNextRunnableTasks 不因 mode 过滤（过滤在调度器）', runnable.some(t => t.id === 't1'));

console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
process.exit(failures === 0 ? 0 : 1);
