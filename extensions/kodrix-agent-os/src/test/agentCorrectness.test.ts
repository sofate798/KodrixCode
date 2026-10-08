/*---------------------------------------------------------------------------------------------
 *  测试：Agent 域最后的正确性问题（A 域 P2 回归护栏）
 *
 *  覆盖：
 *    - A-A5 工具结果截断必须显式标注（静默截断会让模型把"看到的部分"当成全部）
 *    - A-B5 会话记录逐字段校验（坏记录此前以 TypeError 形式在"续聊"时炸出）
 *    - A-B7 plan 模式的系统提示不得宣传被禁用的写/执行工具
 *    - A-A8 Hooks 预置包必须写到**真正被读取**的 `.github/hooks/`（源码级护栏）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const { truncateToolResult, filterToolDocsForActiveTools, AGENT_LOOP_SYSTEM_PROMPT } = require('../agent/agentLoop');
const { loadRuns } = require('../agent/threads');
const { getGithubHooksDir } = require('../paths');

suite('agentCorrectness — Agent 域正确性收口', () => {
	let tmp: string;

	setup(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-agentcorr-'));
		vscodeMock.workspace.workspaceFolders = [{
			uri: { fsPath: tmp, scheme: 'file', path: tmp, toString: () => tmp },
			name: 'test',
			index: 0,
		}];
		vscodeMock.workspace.isTrusted = true;
	});

	teardown(() => {
		vscodeMock.workspace.workspaceFolders = undefined;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	// ── A-A5 ─────────────────────────────────────────────────────

	suite('A-A5 工具结果截断', () => {
		test('未超限时原样返回', () => {
			const text = 'exit=0\n全部测试通过';
			assert.strictEqual(truncateToolResult(text, 100), text);
		});

		test('超限时保留原文长度并显式标注被截断', () => {
			const text = 'x'.repeat(500);
			const out = truncateToolResult(text, 100);

			assert.ok(out.startsWith('x'.repeat(100)), '应保留前缀内容');
			assert.ok(out.includes('结果已截断'), `必须标注截断：${out.slice(-80)}`);
			assert.ok(out.includes('500'), '应给出原文字符数（模型据此判断是否要分段读取）');
			assert.ok(out.includes('100'), '应给出实际提供的字符数');
		});
	});

	// ── A-B7 ─────────────────────────────────────────────────────

	suite('A-B7 plan 模式的工具说明过滤', () => {
		test('只读集合下不出现写/执行/提案工具', () => {
			const readonly = ['read_file', 'list_dir', 'search', 'codebase_search', 'complete'];
			const filtered = filterToolDocsForActiveTools(AGENT_LOOP_SYSTEM_PROMPT, readonly);

			for (const banned of ['write_file', 'edit_file', 'run_command', 'propose_changes']) {
				assert.ok(!filtered.includes(`- ${banned} `), `plan 模式不应列出 ${banned}`);
			}
			for (const kept of readonly) {
				assert.ok(filtered.includes(`- ${kept} `), `应保留只读工具说明：${kept}`);
			}
		});

		test('协议与规则段落原样保留', () => {
			const filtered = filterToolDocsForActiveTools(AGENT_LOOP_SYSTEM_PROMPT, ['read_file']);
			assert.ok(filtered.includes('工具调用协议'), '协议段落应保留');
			assert.ok(filtered.includes('路径相对工作区根'), '规则段落应保留');
			assert.ok(filtered.includes('- read_file '), '可用工具应保留');
		});

		test('全量工具集下说明文本不变（非 plan 模式行为不变）', () => {
			const all = ['read_file', 'write_file', 'edit_file', 'list_dir', 'search', 'codebase_search', 'run_command', 'propose_changes', 'complete'];
			assert.strictEqual(filterToolDocsForActiveTools(AGENT_LOOP_SYSTEM_PROMPT, all), AGENT_LOOP_SYSTEM_PROMPT);
		});
	});

	// ── A-B5 ─────────────────────────────────────────────────────

	suite('A-B5 会话记录校验', () => {
		test('字段缺失/形状异常的记录被跳过或被净化，且不抛错', () => {
			const runDir = path.join(tmp, 'agent-runs');
			fs.mkdirSync(runDir, { recursive: true });
			const good = {
				id: 'run-2026-01-01T00-00-00-000Z',
				task: '有效任务',
				createdAt: '2026-01-01T00:00:00.000Z',
				status: 'completed',
				result: { status: 'completed', trace: [{ iteration: 1, phase: 'final', content: 'ok' }], finalText: '完成' },
			};
			fs.writeFileSync(path.join(runDir, 'good.json'), JSON.stringify(good), 'utf-8');
			// 缺 task：此前 `r.task.slice(...)` 抛错
			fs.writeFileSync(path.join(runDir, 'no-task.json'), JSON.stringify({ id: 'run-x' }), 'utf-8');
			// result 形状异常：续聊时会在 buildHistoryContext 里炸
			fs.writeFileSync(path.join(runDir, 'bad-result.json'), JSON.stringify({ id: 'run-y', task: '坏 result', result: { trace: 'not-an-array' } }), 'utf-8');
			// 坏 JSON
			fs.writeFileSync(path.join(runDir, 'broken.json'), '{ not json', 'utf-8');

			const runs = loadRuns(runDir) as { id: string; result?: unknown }[];
			const ids = runs.map((r: { id: string }) => r.id);

			assert.ok(ids.includes(good.id), '有效记录应被读取');
			assert.ok(!ids.includes('run-x'), '缺 task 的记录应被跳过');
			const badResult = runs.find((r: { id: string }) => r.id === 'run-y');
			assert.ok(badResult, '有 id/task 的记录仍应保留（便于查看）');
			assert.strictEqual(badResult.result, undefined, '形状异常的 result 应被净化掉');
			assert.strictEqual(runs.length, 2, `应只保留 2 条可用记录，实际 ${runs.length}`);
		});
	});

	// ── A-A8 ─────────────────────────────────────────────────────

	suite('A-A8 Hooks 安装位置', () => {
		test('生效位置为工作区 .github/hooks，且预置实现引用它', () => {
			const dir = getGithubHooksDir();
			assert.ok(dir, '应有工作区 .github/hooks 路径');
			assert.ok(dir.replace(/\\/g, '/').endsWith('.github/hooks'), `路径应为 .github/hooks，实际 ${dir}`);

			const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'hooks', 'hooksPresets.ts'), 'utf-8');
			assert.ok(source.includes('getGithubHooksDir'), '预置实现必须使用生效位置');
			assert.ok(!source.includes('getProjectHooksPath'), '不应再写入无人读取的 .kodrix/hooks/');
			assert.ok(source.includes('not read by Kodrix'), '.cursor 目标须标注 Kodrix 不读取');
		});
	});
});
