/*---------------------------------------------------------------------------------------------
 *  测试：fsSafe — 原子写入与"不受信任工作区"写入闸门
 *
 *  回归覆盖：
 *    - 受信任工作区可正常写入
 *    - isTrusted === false 时拒绝写工作区内文件
 *    - isTrusted === false 但仍允许写工作区外的路径（用户主目录/临时目录）
 *    - 写入失败时不留临时文件
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const fsSafe = require('../utils/fsSafe');

suite('fsSafe — 工作区写入闸门', () => {
	let workspaceDir: string;
	let outsideDir: string;
	const originalIsTrusted = vscodeMock.workspace.isTrusted;

	setup(() => {
		workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-ws-'));
		outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-out-'));
		vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspaceDir }, name: 'ws', index: 0 }];
		vscodeMock.workspace.isTrusted = true;
	});

	teardown(() => {
		vscodeMock.workspace.isTrusted = originalIsTrusted;
		vscodeMock.workspace.workspaceFolders = undefined;
		fs.rmSync(workspaceDir, { recursive: true, force: true });
		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	test('受信任工作区可写入工作区内文件', () => {
		const target = path.join(workspaceDir, '.kodrix', 'a.json');
		fsSafe.atomicWriteFileSync(target, '{"ok":true}');
		assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{"ok":true}');
	});

	test('不受信任工作区拒绝写工作区内文件，且不留临时文件', () => {
		vscodeMock.workspace.isTrusted = false;
		const target = path.join(workspaceDir, '.kodrix', 'b.json');

		assert.throws(() => fsSafe.atomicWriteFileSync(target, 'x'), /Untrusted workspace/);
		assert.strictEqual(fs.existsSync(target), false);
		const leftovers = fs.existsSync(path.dirname(target))
			? fs.readdirSync(path.dirname(target)).filter(f => f.includes('.tmp.'))
			: [];
		assert.deepStrictEqual(leftovers, []);
	});

	test('不受信任工作区仍允许写工作区外的路径', () => {
		vscodeMock.workspace.isTrusted = false;
		const target = path.join(outsideDir, 'c.json');

		fsSafe.atomicWriteFileSync(target, '{"outside":true}');

		assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{"outside":true}');
	});

	test('assertWorkspaceWriteAllowed 边界：工作区根目录本身也算工作区内', () => {
		vscodeMock.workspace.isTrusted = false;
		assert.throws(() => fsSafe.assertWorkspaceWriteAllowed(workspaceDir), /Untrusted workspace/);
		// 前缀相似但不在工作区内的目录不受影响（防止 startsWith 误判）
		const sibling = `${workspaceDir}-sibling`;
		fsSafe.assertWorkspaceWriteAllowed(path.join(sibling, 'd.json'));
		assert.strictEqual(fs.existsSync(sibling), false);
	});
});
