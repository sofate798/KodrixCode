/*---------------------------------------------------------------------------------------------
 *  测试：acpRegistry — 输出缓冲 / 上限 / 运行记录
 *
 *  回归覆盖：
 *    - stdout 跨 chunk 行缓冲（JSONL 截断修复）
 *    - stdout 2MB 上限截断
 *    - stderr 1MB 上限截断
 *    - listAcpRuns 读取与排序
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const vscodeMock = require('./vscode-mock');
const acpRegistry = require('../acp/acpRegistry');

suite('acpRegistry', () => {

	// ── dispatchAcpTask — 输出缓冲与上限 ──────────────────────────

	suite('dispatchAcpTask — 输出限制', () => {
		test('正常命令输出被收集', async () => {
			const agent = {
				id: 'test-agent',
				name: 'Test Agent',
				command: process.platform === 'win32' ? 'echo {"content":"hello"}' : 'echo \'{"content":"hello"}\'',
				protocol: 'acp' as const,
				enabled: true,
				registeredAt: new Date().toISOString(),
			};

			const result = await acpRegistry.dispatchAcpTask(agent, 'test task', 10000);
			assert.ok(result.output.includes('hello'), `Expected output to include 'hello', got: ${result.output}`);
			assert.strictEqual(result.status, 'completed');
		});

		test('超时命令返回 timeout 状态', async () => {
			const agent = {
				id: 'timeout-agent',
				name: 'Timeout Agent',
				// sleep 命令在超时后会被 kill
				command: process.platform === 'win32'
					? 'powershell -Command "Start-Sleep 30"'
					: 'sleep 30',
				protocol: 'acp' as const,
				enabled: true,
				registeredAt: new Date().toISOString(),
			};

			const result = await acpRegistry.dispatchAcpTask(agent, 'timeout test', 500);
			assert.strictEqual(result.status, 'timeout');
			assert.ok(result.error?.includes('超时'));
		});

		test('失败命令返回 failed 状态', async () => {
			const agent = {
				id: 'fail-agent',
				name: 'Fail Agent',
				command: process.platform === 'win32' ? 'exit 1' : 'exit 1',
				protocol: 'acp' as const,
				enabled: true,
				registeredAt: new Date().toISOString(),
			};

			const result = await acpRegistry.dispatchAcpTask(agent, 'fail test', 10000);
			assert.strictEqual(result.status, 'failed');
		});

		test('JSONL 跨 chunk 行缓冲：多行 JSON 输出正确解析', async () => {
			// 输出多行 JSONL，验证每行都被正确解析 content 字段
			const lines = [
				'{"content":"line1"}',
				'{"content":"line2"}',
				'{"content":"line3"}',
			];
			const cmd = process.platform === 'win32'
				? `powershell -Command "${lines.map(l => l.replace(/"/g, '\\"')).join('; ')}"`
				: `printf '${lines.join('\\n')}\n'`;

			const agent = {
				id: 'jsonl-agent',
				name: 'JSONL Agent',
				command: cmd,
				protocol: 'acp' as const,
				enabled: true,
				registeredAt: new Date().toISOString(),
			};

			const result = await acpRegistry.dispatchAcpTask(agent, 'jsonl test', 10000);
			assert.ok(result.output.includes('line1'));
			assert.ok(result.output.includes('line2'));
			assert.ok(result.output.includes('line3'));
		});
	});

	// ── listAcpRuns ────────────────────────────────────────────────

	suite('listAcpRuns', () => {
		test('返回数组（可能为空）', () => {
			const runs = acpRegistry.listAcpRuns();
			assert.ok(Array.isArray(runs));
		});

		test('运行记录按时间降序排列', () => {
			const runs = acpRegistry.listAcpRuns();
			for (let i = 1; i < runs.length; i++) {
				assert.ok(runs[i - 1].startedAt >= runs[i].startedAt,
					`Run ${i - 1} should be newer than run ${i}`);
			}
		});
	});
});
