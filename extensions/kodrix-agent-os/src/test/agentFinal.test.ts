/*---------------------------------------------------------------------------------------------
 *  测试：Agent/上下文域收口（A-A7 / A-B4 / A-B8 / C-B6 回归护栏）
 *
 *  覆盖：
 *    - A-A7 可视化编排必须读取 Crew 的**真实文件** `.kodrix/crew.json`（此前只扫 `.kodrix/crews/`，
 *      刚建完 Crew 打开可视化仍报"尚未创建 Crew" —— 功能等于不存在）
 *    - A-B4 扩展重启后遗留的 `running` 任务必须被收敛为失败（否则永远显示"运行中"）
 *    - A-B8 无工作区时命令必须给出提示，而不是静默返回
 *    - C-B6 指令位置必须写入 Workspace 作用域（写用户全局会跨工作区串味、卸载后残留）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const { renderCrewFileToHtml } = require('../crew/crewVisualizer');
const { reconcileInterruptedTasks, listBackgroundTasks } = require('../background/backgroundAgent');

const EXT_ROOT = path.resolve(__dirname, '..', '..');

suite('agentFinal — 可视化路径 / 任务收敛 / 无工作区提示 / 配置作用域', () => {
	let ws: string;

	function useTmpWorkspace(tmpDir: string): void {
		vscodeMock.workspace.workspaceFolders = [{
			uri: { fsPath: tmpDir, scheme: 'file', path: tmpDir, toString: () => tmpDir },
			name: 'test',
			index: 0,
		}];
	}

	const put = (rel: string, content: string): string => {
		const full = path.join(ws, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, 'utf-8');
		return full;
	};

	setup(() => {
		ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-agentfinal-'));
		useTmpWorkspace(ws);
		vscodeMock.__resetTestConfig();
		vscodeMock.workspace.isTrusted = true;
	});

	teardown(() => {
		vscodeMock.workspace.workspaceFolders = undefined;
		fs.rmSync(ws, { recursive: true, force: true });
	});

	// ── A-A7 ─────────────────────────────────────────────────────

	test('A-A7：可从 .kodrix/crew.json 渲染 DAG（真实文件位置与真实字段名）', async () => {
		// 字段与 agentCrew 的 CrewTask 一致：dependencies（不是 dependsOn）、status 用 completed/pending
		const crew = {
			id: 'crew-test',
			name: '联调 Crew',
			workflow: 'feature',
			agents: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			tasks: [
				{ id: 't1', title: '设计接口', description: '', assignedRole: 'architect', dependencies: [], status: 'completed' },
				{ id: 't2', title: '实现控制器', description: '', assignedRole: 'coder', dependencies: ['t1'], status: 'pending' },
			],
		};
		const crewPath = put(path.join('.kodrix', 'crew.json'), JSON.stringify(crew));

		const html = await renderCrewFileToHtml(crewPath);

		assert.ok(html, '应能从 .kodrix/crew.json 渲染出 HTML');
		assert.ok(html.includes('设计接口') && html.includes('实现控制器'), 'DAG 应包含任务标题');
		assert.ok((html.match(/<path /g) ?? []).length >= 1, '应渲染出依赖边（<path>）');
	});

	test('A-A7：手工编辑导致字段缺失时仍可渲染（不报"解析失败"）', async () => {
		// 缺 dependencies / tasks：此前会在 task.dependencies.length 处抛错 → 整页渲染失败
		const partial = put(path.join('.kodrix', 'crew.json'), JSON.stringify({
			id: 'crew-partial',
			name: '手改过的 Crew',
			tasks: [{ id: 't1', title: '只有一个任务', status: 'pending' }],
		}));

		const html = await renderCrewFileToHtml(partial);

		assert.ok(html, '缺字段的 crew.json 也应渲染');
		assert.ok(html.includes('只有一个任务'), '应包含任务标题');
	});

	test('A-A7：可视化命令的候选路径包含真实文件位置（源码级护栏）', () => {
		const source = fs.readFileSync(path.join(EXT_ROOT, 'src', 'crew', 'crewVisualizer.ts'), 'utf-8');
		const singleCrew = `'crew.json'`;
		const legacyDir = `'crews'`;
		assert.ok(source.includes(singleCrew), '必须包含 .kodrix/crew.json 候选');
		assert.ok(source.includes(legacyDir), '保留旧目录兼容');
	});

	// ── A-B4 ─────────────────────────────────────────────────────

	test('A-B4：遗留的 running 任务在启动时被收敛为 failed', () => {
		const tasksDir = path.join(ws, '.kodrix', 'background');
		fs.mkdirSync(tasksDir, { recursive: true });
		const running = {
			id: 'bg-1',
			title: '遗留任务',
			status: 'running',
			createdAt: new Date().toISOString(),
		};
		const done = {
			id: 'bg-2',
			title: '已完成任务',
			status: 'completed',
			createdAt: new Date().toISOString(),
		};
		fs.writeFileSync(path.join(tasksDir, 'bg-1.json'), JSON.stringify(running), 'utf-8');
		fs.writeFileSync(path.join(tasksDir, 'bg-2.json'), JSON.stringify(done), 'utf-8');

		const reconciled = reconcileInterruptedTasks();

		assert.ok(reconciled >= 1, `应至少收敛 1 个任务，实际 ${reconciled}`);
		const tasks = listBackgroundTasks() as { id: string; status: string; error?: string }[];
		const t1 = tasks.find(t => t.id === 'bg-1');
		const t2 = tasks.find(t => t.id === 'bg-2');
		assert.strictEqual(t1?.status, 'failed', '遗留 running 任务应被标记为失败');
		assert.ok(t1?.error?.includes('interrupted by an extension restart'), '应说明中断原因');
		assert.strictEqual(t2?.status, 'completed', '已完成任务不应被改动');
	});

	// ── A-B8 ─────────────────────────────────────────────────────

	test('A-B8：无工作区时的静默 return 已全部替换为提示', () => {
		for (const rel of ['src/agent/agentLoop.ts', 'src/agent/threads.ts', 'src/agent/subagent.ts']) {
			const source = fs.readFileSync(path.join(EXT_ROOT, rel), 'utf-8');
			const silent = source.match(/if \(!folder\) \{return;\}/g) ?? [];
			assert.strictEqual(silent.length, 0, `${rel} 仍有静默返回`);
			assert.ok(source.includes('Please open a workspace first'), `${rel} 应有明确提示`);
		}
	});

	// ── C-B6 ─────────────────────────────────────────────────────

	test('C-B6：指令位置写入 Workspace 作用域而非用户全局', () => {
		const source = fs.readFileSync(path.join(EXT_ROOT, 'src', 'context', 'instructionRegistry.ts'), 'utf-8');
		assert.ok(source.includes('instructionConfigTarget'), '应通过统一的作用域选择函数写入');
		assert.ok(source.includes('ConfigurationTarget.Workspace'), '有工作区时必须写 Workspace');
		// 关键回归点：mergeInstructionLocation 不得再硬编码 Global
		const mergeBlock = source.slice(source.indexOf('export async function mergeInstructionLocation'), source.indexOf('function kodrixInstructionLocationKeys'));
		assert.ok(!mergeBlock.includes('ConfigurationTarget.Global'), 'mergeInstructionLocation 不应再硬编码 Global');
	});
});
