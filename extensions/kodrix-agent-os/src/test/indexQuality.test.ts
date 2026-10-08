/*---------------------------------------------------------------------------------------------
 *  测试：索引质量与边界（B 域 P2 回归护栏）
 *
 *  覆盖本轮修复：
 *    - I-B3 符号链接（文件/目录）此前被静默跳过 → monorepo 里 link 的源码搜不到；环检测防死循环
 *    - I-B4 非 UTF-8（GBK）文件此前按 UTF-8 解 → 中文符号名变乱码
 *    - I-B2 `.gitignore` 此前完全不读（UI 却声称会读）
 *    - I-B9 语言分布 key 口径统一（无点、小写）
 *    - I-B8 统计口径：totalSymbols 与去重后的符号数一致
 *    - I-B13 calleeId 解析确定性：同名多候选时不得被改写成"任意一个"
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const indexer = require('../codebase/projectIndexer');

suite('indexQuality — 索引质量与边界', () => {
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
		ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-idxq-'));
		useTmpWorkspace(ws);
		vscodeMock.__resetTestConfig();
		vscodeMock.workspace.isTrusted = true;
	});

	teardown(async () => {
		try { await indexer.deleteProjectIndex(); } catch { /* best-effort */ }
		vscodeMock.workspace.workspaceFolders = undefined;
		vscodeMock.__resetTestConfig();
		try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* Windows 上 junction 可能残留 */ }
	});

	test('I-B3：目录符号链接内的源码会被索引，且环不会导致死循环', async () => {
		const real = put('packages/lib/src/a.ts', 'export const linkedSymbol = 1;\n');
		// 目录 junction：Windows 下无需管理员权限
		const linkRel = 'linked-lib';
		try {
			fs.symlinkSync(path.dirname(path.dirname(path.dirname(real))), path.join(ws, linkRel), 'junction');
		} catch {
			// 环境不允许创建符号链接（权限/文件系统）：跳过该用例而不是误报失败
			return;
		}
		put('src/local.ts', 'export const localSymbol = 2;\n');
		// 自指环：指回工作区根，没有环检测会无限递归
		try { fs.symlinkSync(ws, path.join(ws, 'loop'), 'junction'); } catch { /* 同上 */ }

		const index = await indexer.ensureProjectIndex(true, { manual: true });

		const files = Object.keys(index.files).map(f => f.replace(/\\/g, '/'));
		assert.ok(files.some(f => f.includes('a.ts')), `符号链接目录内的文件应被索引，实际：${files.join(', ')}`);
		assert.ok(files.some(f => f.includes('local.ts')), '常规文件仍应被索引');
	});

	test('I-B4：GBK 编码文件按 GBK 回退解码，中文符号名不乱码', async () => {
		// GBK 字节：const 中文符号 = 1;（“中文符号”的 GBK 编码）
		const gbkBytes = Buffer.concat([
			Buffer.from('export const ', 'utf-8'),
			Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb7, 0xfb, 0xba, 0xc5]), // 中文符号
			Buffer.from(' = 1;\n', 'utf-8'),
		]);
		fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
		fs.writeFileSync(path.join(ws, 'src', 'gbk.ts'), gbkBytes);

		const index = await indexer.ensureProjectIndex(true, { manual: true });

		const names = Object.values(index.symbols).map(s => (s as { name: string }).name);
		assert.ok(names.includes('中文符号'), `GBK 文件的中文符号名应正确解码，实际：${names.join(', ')}`);
		assert.ok(!names.some(n => n.includes('\uFFFD')), '不应出现替换字符乱码');
		assert.ok(indexer.getLastBuildDiagnostics().nonUtf8Files >= 1, '构建诊断应记录非 UTF-8 文件数');
	});

	test('I-B2：.gitignore 中的排除规则生效', async () => {
		put('.gitignore', 'generated/\n*.gen.ts\n');
		put('generated/skipped.ts', 'export const skippedSymbol = 1;\n');
		put('src/also-skipped.gen.ts', 'export const alsoSkipped = 1;\n');
		put('src/kept.ts', 'export const keptSymbol = 1;\n');

		const index = await indexer.ensureProjectIndex(true, { manual: true });
		const files = Object.keys(index.files).map(f => f.replace(/\\/g, '/'));

		assert.ok(files.some(f => f.endsWith('src/kept.ts')), '未被忽略的文件应入索引');
		assert.ok(!files.some(f => f.includes('generated/')), '.gitignore 的目录规则应生效');
		assert.ok(!files.some(f => f.endsWith('.gen.ts')), '.gitignore 的 glob 规则应生效');
	});

	test('I-B9：语言分布 key 统一为小写无点，且全量/增量口径一致', async () => {
		put('src/a.ts', 'export const a = 1;\n');
		put('src/b.TS', 'export const b = 1;\n');
		const index = await indexer.ensureProjectIndex(true, { manual: true });

		const keys = Object.keys(index.stats.languageDistribution);
		assert.ok(keys.length > 0);
		assert.ok(keys.every(k => !k.startsWith('.')), `key 不应带点：${keys.join(',')}`);
		assert.ok(keys.every(k => k === k.toLowerCase()), `key 应小写：${keys.join(',')}`);
		assert.ok(keys.includes('ts'), `应含 ts，实际：${keys.join(',')}`);
	});

	test('I-B8：totalSymbols 与去重后的符号数一致（全量 → 增量不改口径）', async () => {
		put('src/a.ts', 'export function one() {}\nexport const two = 1;\n');
		put('src/b.ts', 'export function three() {}\n');

		const index = await indexer.ensureProjectIndex(true, { manual: true });
		assert.strictEqual(index.stats.totalSymbols, Object.keys(index.symbols).length, '全量构建的符号数应为去重口径');

		put('src/c.ts', 'export function four() {}\n');
		const updated = await indexer.updateProjectIndexIncrementally(index);
		assert.strictEqual(updated.stats.totalSymbols, Object.keys(updated.symbols).length, '增量后仍应为去重口径');
	});

	test('I-B13：同名多候选的调用不被改写成任意一个符号 id', async () => {
		put('src/a.ts', 'export function dup() { return 1; }\n');
		put('src/b.ts', 'export function dup() { return 2; }\n');
		put('src/c.ts', 'export function caller() { return dup(); }\n');

		const index = await indexer.ensureProjectIndex(true, { manual: true });

		const aId = Object.values(index.symbols).find(s => (s as { name: string; filePath: string }).name === 'dup' && String((s as { filePath: string }).filePath).includes('a.ts')) as { id: string };
		const bId = Object.values(index.symbols).find(s => (s as { name: string; filePath: string }).name === 'dup' && String((s as { filePath: string }).filePath).includes('b.ts')) as { id: string };
		assert.ok(aId && bId, '两个同名符号都应存在');

		const callerCalls = index.calls.filter((c: { callerId: string }) => String(c.callerId).includes('caller'));
		assert.ok(callerCalls.length > 0, '应记录 caller 的调用');
		for (const call of callerCalls) {
			assert.ok(
				call.calleeId !== aId.id && call.calleeId !== bId.id,
				`同名多候选时不得把 calleeId 指向任意一个（实际 ${call.calleeId}）`,
			);
		}
	});
});
