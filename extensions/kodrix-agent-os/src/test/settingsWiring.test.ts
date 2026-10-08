/*---------------------------------------------------------------------------------------------
 *  测试：设置项接线（死配置修复回归）
 *
 *  覆盖：
 *    - clampCrewParallel：并发钳制（下限/上限/取整/非法值回退）
 *    - resolveCrewMaxParallel：显式入参 > kodrix.crew.maxParallel > 默认 3
 *      （修复 Subagent 派生链路硬编码 3、不读设置项的问题）
 *    - getVisibleKanbanTasks：kodrix.kanban.showCompleted=false 过滤 done 任务
 *    - syncHasWorkspaceContext：kodrix.hasWorkspace 上下文键 setContext 同步
 *      （修复 checkpoints 视图 when 子句永不成立的问题）
 *    - isKodrixFeatureEnabled + registerHooks / registerPropertyTests 门控：
 *      kodrix.features.hooks / propertyTests 关闭时入口拦截（默认开，向后兼容）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// vscode mock 已在 runTests.ts 中注册
const vscodeMock = require('./vscode-mock');
const { clampCrewParallel, CREW_DEFAULT_MAX_PARALLEL } = require('../shared/constants');
const { resolveCrewMaxParallel } = require('../utils/crewParallel');
const { isKodrixFeatureEnabled } = require('../utils/featureFlags');
const { syncHasWorkspaceContext } = require('../utils/contextKeys');
const kanban = require('../kanban/agentKanban');
const { registerHooks } = require('../hooks/hooksPresets');
const { registerPropertyTests } = require('../testing/propertyTests');

/** 指向临时目录的 mock 工作区 */
function useTmpWorkspace(tmpDir: string): void {
	vscodeMock.workspace.workspaceFolders = [{
		uri: { fsPath: tmpDir, scheme: 'file', path: tmpDir, toString: () => tmpDir },
		name: 'test',
		index: 0,
	}];
}

suite('settingsWiring — 死配置接线回归', () => {

	setup(() => {
		vscodeMock.__resetTestConfig();
	});

	teardown(() => {
		vscodeMock.__resetTestConfig();
		vscodeMock.workspace.workspaceFolders = undefined;
	});

	// ── crew.maxParallel ─────────────────────────────────────────

	suite('clampCrewParallel', () => {
		test('区间内取值原样生效', () => {
			assert.strictEqual(clampCrewParallel(5), 5);
			assert.strictEqual(clampCrewParallel(1), 1);
			assert.strictEqual(clampCrewParallel(10), 10);
		});

		test('低于下限收敛到 1', () => {
			assert.strictEqual(clampCrewParallel(0), 1);
			assert.strictEqual(clampCrewParallel(-4), 1);
		});

		test('超过上限收敛到 10（与 package.json maximum 一致）', () => {
			assert.strictEqual(clampCrewParallel(999), 10);
		});

		test('小数向下取整', () => {
			assert.strictEqual(clampCrewParallel(4.7), 4);
		});

		test('非法值（NaN/字符串/undefined）回退默认 3', () => {
			assert.strictEqual(clampCrewParallel(Number.NaN), CREW_DEFAULT_MAX_PARALLEL);
			assert.strictEqual(clampCrewParallel('5'), CREW_DEFAULT_MAX_PARALLEL);
			assert.strictEqual(clampCrewParallel(undefined), CREW_DEFAULT_MAX_PARALLEL);
		});
	});

	suite('resolveCrewMaxParallel（Crew + Subagent 共用）', () => {
		test('显式入参优先于设置项', () => {
			vscodeMock.__setTestConfig('kodrix.crew.maxParallel', 2);
			assert.strictEqual(resolveCrewMaxParallel(7), 7);
		});

		test('无显式入参时读取 kodrix.crew.maxParallel', () => {
			vscodeMock.__setTestConfig('kodrix.crew.maxParallel', 5);
			assert.strictEqual(resolveCrewMaxParallel(), 5);
		});

		test('未配置时保持默认 3（向后兼容原硬编码值）', () => {
			assert.strictEqual(resolveCrewMaxParallel(), 3);
		});

		test('越界配置值被钳制', () => {
			vscodeMock.__setTestConfig('kodrix.crew.maxParallel', 100);
			assert.strictEqual(resolveCrewMaxParallel(), 10);
			vscodeMock.__setTestConfig('kodrix.crew.maxParallel', -2);
			assert.strictEqual(resolveCrewMaxParallel(), 1);
		});

		test('类型错误的配置值回退默认', () => {
			vscodeMock.__setTestConfig('kodrix.crew.maxParallel', 'many');
			assert.strictEqual(resolveCrewMaxParallel(), 3);
		});
	});

	// ── kanban.showCompleted ─────────────────────────────────────

	suite('kodrix.kanban.showCompleted 过滤', () => {
		let tmpDir: string;

		const task = (id: string, status: string, updatedAt: string) => ({
			id, title: id, status, createdAt: updatedAt, updatedAt,
		});

		setup(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-kanban-'));
			useTmpWorkspace(tmpDir);
			const dir = path.join(tmpDir, '.kodrix');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'kanban.json'), JSON.stringify({
				tasks: [
					task('t1', 'todo', '2026-01-01T00:00:00.000Z'),
					task('t2', 'done', '2026-01-02T00:00:00.000Z'),
					task('t3', 'in_progress', '2026-01-03T00:00:00.000Z'),
					task('t4', 'done', '2026-01-04T00:00:00.000Z'),
				],
			}), 'utf-8');
		});

		teardown(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		test('默认（不配置）显示已完成任务 — 向后兼容', () => {
			assert.strictEqual(kanban.isShowCompletedEnabled(), true);
			const ids = kanban.getVisibleKanbanTasks().map((t: { id: string }) => t.id);
			assert.deepStrictEqual(ids.sort(), ['t1', 't2', 't3', 't4']);
		});

		test('showCompleted=false 时过滤 done，数据文件不被修改', () => {
			vscodeMock.__setTestConfig('kodrix.kanban.showCompleted', false);
			const ids = kanban.getVisibleKanbanTasks().map((t: { id: string }) => t.id);
			assert.deepStrictEqual(ids.sort(), ['t1', 't3']);
			// 持久化数据仍然完整（仅视图过滤）
			const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, '.kodrix', 'kanban.json'), 'utf-8'));
			assert.strictEqual(raw.tasks.length, 4);
		});

		test('过滤后仍保持状态序 + 更新时间序', () => {
			vscodeMock.__setTestConfig('kodrix.kanban.showCompleted', true);
			const ordered = kanban.getVisibleKanbanTasks().map((t: { id: string }) => t.id);
			// 状态序：in_progress(0) → todo(3) → done(4)；done 内按更新时间倒序（t4 比 t2 新）
			assert.deepStrictEqual(ordered, ['t3', 't1', 't4', 't2']);
		});
	});

	// ── hasWorkspace 上下文键 ────────────────────────────────────

	suite('kodrix.hasWorkspace setContext 同步', () => {
		test('无工作区时同步为 false', async () => {
			vscodeMock.workspace.workspaceFolders = undefined;
			await syncHasWorkspaceContext();
			const calls = vscodeMock.commands.__executedCommands
				.filter((c: { command: string }) => c.command === 'setContext');
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].args[0], 'kodrix.hasWorkspace');
			assert.strictEqual(calls[0].args[1], false);
		});

		test('有工作区时同步为 true（checkpoints 视图可见性依赖）', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-ctx-'));
			try {
				useTmpWorkspace(tmpDir);
				await syncHasWorkspaceContext();
				const calls = vscodeMock.commands.__executedCommands
					.filter((c: { command: string }) => c.command === 'setContext');
				assert.strictEqual(calls.length, 1);
				assert.strictEqual(calls[0].args[0], 'kodrix.hasWorkspace');
				assert.strictEqual(calls[0].args[1], true);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// ── features.* 门控 ──────────────────────────────────────────

	suite('isKodrixFeatureEnabled', () => {
		test('未配置时默认启用（向后兼容）', () => {
			assert.strictEqual(isKodrixFeatureEnabled('hooks'), true);
			assert.strictEqual(isKodrixFeatureEnabled('acp'), true);
			assert.strictEqual(isKodrixFeatureEnabled('propertyTests'), true);
			assert.strictEqual(isKodrixFeatureEnabled('contextIntelligence'), true);
		});

		test('注入 false 后返回 false（读取 kodrix.features.<flag>）', () => {
			vscodeMock.__setTestConfig('kodrix.features.hooks', false);
			assert.strictEqual(isKodrixFeatureEnabled('hooks'), false);
			assert.strictEqual(isKodrixFeatureEnabled('acp'), true);
		});
	});

	suite('功能入口门控（关闭时拦截且不产生副作用）', () => {
		let tmpDir: string;
		let warnings: string[];
		let originalWarn: unknown;
		const fakeContext = { subscriptions: [] as Array<{ dispose: () => void }> };

		setup(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-gate-'));
			useTmpWorkspace(tmpDir);
			warnings = [];
			originalWarn = vscodeMock.window.showWarningMessage;
			vscodeMock.window.showWarningMessage = async (msg: string) => { warnings.push(msg); };
			registerHooks(fakeContext);
			registerPropertyTests(fakeContext);
		});

		teardown(() => {
			vscodeMock.window.showWarningMessage = originalWarn;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		test('kodrix.features.hooks=false：安装命令被拦截并提示', async () => {
			vscodeMock.__setTestConfig('kodrix.features.hooks', false);
			const handler = vscodeMock.commands.__commands['kodrix.hooks.installPresets'];
			assert.ok(typeof handler === 'function', 'installPresets 命令应已注册');
			await handler();
			assert.strictEqual(warnings.length, 1);
			assert.ok(warnings[0].includes('kodrix.features.hooks'), '提示应指路设置项');
			// 未产生安装副作用
			assert.strictEqual(fs.existsSync(path.join(tmpDir, '.kodrix', 'hooks')), false);
		});

		test('kodrix.features.propertyTests=false：生成命令被拦截并提示', async () => {
			vscodeMock.__setTestConfig('kodrix.features.propertyTests', false);
			const handler = vscodeMock.commands.__commands['kodrix.testing.generatePropertyTests'];
			assert.ok(typeof handler === 'function', 'generatePropertyTests 命令应已注册');
			await handler();
			assert.strictEqual(warnings.length, 1);
			assert.ok(warnings[0].includes('kodrix.features.propertyTests'), '提示应指路设置项');
		});
	});
});
