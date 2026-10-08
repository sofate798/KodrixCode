/*---------------------------------------------------------------------------------------------
 *  测试：Agent 循环的安全边界与协议解析（纯函数回归护栏）
 *
 *  覆盖（对应审计发现的两个 P0）：
 *    - P0 信任：assertAgentCanWrite —— `.git/**` 一律拒绝；不受信任工作区拒绝写工作区文件
 *    - P0 协议：parseToolCalls / stripToolCalls —— 解析容错行为与"坏块不产生调用"的事实锁定
 *    - 路径安全：resolveInWorkspace —— 工作区外（含 ../ 穿越、绝对路径）一律返回 undefined
 *
 *  注：主循环里"模型未产出 <tool_call> 时判 failed"的逻辑依赖完整 LLM 会话，
 *  这里锁定它依赖的两个纯函数前置条件（不产出调用 / 不产出文本），避免协议回归时无人发现。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const { resolveInWorkspace, assertAgentCanWrite, parseToolCalls, stripToolCalls } = require('../agent/agentLoop');

suite('agentGuard — Agent 安全边界与协议解析', () => {
	const workspace = path.join(os.tmpdir(), 'kodrix-agent-ws');

	function useWorkspace(): void {
		vscodeMock.workspace.workspaceFolders = [{
			uri: { fsPath: workspace, scheme: 'file', path: workspace, toString: () => workspace },
			name: 'test',
			index: 0,
		}];
	}

	setup(() => {
		useWorkspace();
		vscodeMock.workspace.isTrusted = true;
	});

	teardown(() => {
		vscodeMock.workspace.workspaceFolders = undefined;
		vscodeMock.workspace.isTrusted = true;
	});

	// ── 路径安全 ──────────────────────────────────────────────────

	suite('resolveInWorkspace', () => {
		test('工作区内相对路径解析为绝对路径', () => {
			assert.strictEqual(resolveInWorkspace('src/a.ts', workspace), path.join(workspace, 'src', 'a.ts'));
			assert.strictEqual(resolveInWorkspace('.', workspace), path.normalize(workspace));
		});

		test('越界路径返回 undefined（../ 穿越、绝对路径、前缀相似目录）', () => {
			assert.strictEqual(resolveInWorkspace('../outside.ts', workspace), undefined);
			assert.strictEqual(resolveInWorkspace('src/../../outside.ts', workspace), undefined);
			assert.strictEqual(resolveInWorkspace(path.join(os.tmpdir(), 'other', 'x.ts'), workspace), undefined);
			// 前缀相似但不是子目录：不能用 startsWith 裸判断
			assert.strictEqual(resolveInWorkspace(`${workspace}-sibling/x.ts`, workspace), undefined);
		});
	});

	// ── 写入闸门（P0） ───────────────────────────────────────────

	suite('assertAgentCanWrite', () => {
		test('受信任工作区允许写普通文件', () => {
			assert.doesNotThrow(() => assertAgentCanWrite(path.join(workspace, 'src', 'a.ts'), workspace));
		});

		test('.git 目录一律拒绝（即使工作区受信任）', () => {
			assert.throws(
				() => assertAgentCanWrite(path.join(workspace, '.git', 'hooks', 'pre-commit'), workspace),
				/\.git/,
			);
			assert.throws(() => assertAgentCanWrite(path.join(workspace, '.git'), workspace), /\.git/);
		});

		test('.git 拒绝大小写变体与嵌套子模块路径', () => {
			assert.throws(
				() => assertAgentCanWrite(path.join(workspace, '.GIT', 'hooks', 'pre-commit'), workspace),
				/\.git/,
			);
			assert.throws(
				() => assertAgentCanWrite(path.join(workspace, 'vendor', 'lib', '.git', 'config'), workspace),
				/\.git/,
			);
		});

		test('字面量替换时 newText 中的 $ 不被 String.replace 特殊解释', () => {
			// 锁定 edit_file / apply 使用的 () => newText 形态；裸字符串 replacement 会把 $$ 收成 $
			const content = 'const x = PRICE;';
			const fixed = content.replace('PRICE', () => '$$price');
			assert.strictEqual(fixed, 'const x = $$price;');
			assert.notStrictEqual(content.replace('PRICE', '$$price'), 'const x = $$price;');
		});

		test('不受信任工作区拒绝写工作区文件', () => {
			vscodeMock.workspace.isTrusted = false;
			assert.throws(
				() => assertAgentCanWrite(path.join(workspace, 'src', 'a.ts'), workspace),
				/Untrusted workspace/,
			);
		});

		test('不受信任工作区仍允许写工作区外的路径（用户主目录等）', () => {
			vscodeMock.workspace.isTrusted = false;
			assert.doesNotThrow(() => assertAgentCanWrite(path.join(os.tmpdir(), 'kodrix-outside', 'a.json'), workspace));
		});
	});

	// ── 工具协议解析 ─────────────────────────────────────────────

	suite('parseToolCalls / stripToolCalls', () => {
		test('解析标准工具调用块', () => {
			const text = [
				'我先看一下文件。',
				'<tool_call>',
				'<name>read_file</name>',
				'<arguments>{"path": "src/a.ts", "maxLines": 50}</arguments>',
				'</tool_call>',
			].join('\n');
			const calls = parseToolCalls(text);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].name, 'read_file');
			assert.deepStrictEqual(calls[0].args, { path: 'src/a.ts', maxLines: 50 });
		});

		test('可解析多个调用', () => {
			const text = [
				'<tool_call><name>read_file</name><arguments>{"path":"a.ts"}</arguments></tool_call>',
				'<tool_call><name>complete</name><arguments>{"summary":"done"}</arguments></tool_call>',
			].join('\n');
			assert.deepStrictEqual(parseToolCalls(text).map((c: { name: string }) => c.name), ['read_file', 'complete']);
		});

		test('缺 <name> 的块被跳过；JSON 非法时退化为 args.raw（容错而非崩溃）', () => {
			const noName = '<tool_call><arguments>{"path":"a.ts"}</arguments></tool_call>';
			assert.deepStrictEqual(parseToolCalls(noName), []);

			const badJson = '<tool_call><name>write_file</name><arguments>{not json}</arguments></tool_call>';
			const calls = parseToolCalls(badJson);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0].args, { raw: '{not json}' });
		});

		test('纯自然语言（无工具调用）不产生调用 —— 主循环据此判协议不兼容', () => {
			const natural = '我已经完成了任务，代码看起来没问题。';
			assert.deepStrictEqual(parseToolCalls(natural), []);
			assert.strictEqual(stripToolCalls(natural), natural);
		});

		test('stripToolCalls 剥离工具块与 [DONE]', () => {
			const text = '思考\n<tool_call><name>complete</name><arguments>{}</arguments></tool_call>\n[DONE]\n收尾文本';
			const stripped = stripToolCalls(text);
			assert.ok(!stripped.includes('<tool_call>'));
			assert.ok(!stripped.includes('[DONE]'));
			assert.ok(stripped.includes('收尾文本'));
		});
	});
});
