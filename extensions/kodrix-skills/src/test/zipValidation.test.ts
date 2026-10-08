/*---------------------------------------------------------------------------------------------
 *  测试：zipValidation — 解压前的 ZIP 归档校验
 *
 *  回归覆盖：
 *    - 合法归档通过并返回条目数 / 解压后总大小
 *    - 路径穿越（../、反斜杠形式）、绝对路径（/、C:\、UNC）
 *    - 符号链接条目、加密条目、重名条目
 *    - 条目数上限、解压后总大小上限（zip bomb）、ZIP64 拒绝
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildZip } from './zipFixture';

// zipValidation 依赖 vscode.l10n（错误文案本地化），必须先注册 mock 再加载被测模块
require('./vscode-mock');
const { validateZipArchive, MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_TOTAL_BYTES } = require('../zipValidation');

suite('zipValidation', () => {
	let tmpDir: string;

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-zip-test-'));
	});

	teardown(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeArchive(name: string, entries: Parameters<typeof buildZip>[0]): string {
		const file = path.join(tmpDir, name);
		fs.writeFileSync(file, buildZip(entries));
		return file;
	}

	test('合法归档通过校验', () => {
		const file = writeArchive('ok.zip', [
			{ name: 'SKILL.md', data: '# Skill' },
			{ name: 'scripts/run.sh', data: 'echo hi' },
		]);

		const summary = validateZipArchive(file);

		assert.strictEqual(summary.entries, 2);
		assert.ok(summary.totalUncompressedBytes > 0);
	});

	test('拒绝路径穿越条目（../）', () => {
		const file = writeArchive('traversal.zip', [{ name: '../evil.txt', data: 'x' }]);
		assert.throws(() => validateZipArchive(file), /path traversal/);
	});

	test('拒绝反斜杠形式的穿越条目', () => {
		const file = writeArchive('traversal-backslash.zip', [{ name: 'a\\..\\..\\evil.txt', data: 'x' }]);
		assert.throws(() => validateZipArchive(file), /path traversal/);
	});

	test('拒绝绝对路径条目（/ 与 C:\\）', () => {
		const unixAbsolute = writeArchive('abs-unix.zip', [{ name: '/etc/passwd', data: 'x' }]);
		assert.throws(() => validateZipArchive(unixAbsolute), /absolute path/);

		const windowsAbsolute = writeArchive('abs-win.zip', [{ name: 'C:\\evil.txt', data: 'x' }]);
		assert.throws(() => validateZipArchive(windowsAbsolute), /absolute path/);

		const unc = writeArchive('unc.zip', [{ name: '\\\\server\\share\\evil.txt', data: 'x' }]);
		assert.throws(() => validateZipArchive(unc), /absolute path/);
	});

	test('拒绝符号链接条目', () => {
		const file = writeArchive('symlink.zip', [
			{ name: 'link', data: '/etc/passwd', externalAttrs: 0xA1FF0000 },
		]);
		assert.throws(() => validateZipArchive(file), /symbolic link/);
	});

	test('拒绝加密条目', () => {
		const file = writeArchive('encrypted.zip', [{ name: 'secret.txt', data: 'x', flags: 0x1 }]);
		assert.throws(() => validateZipArchive(file), /encrypted/);
	});

	test('拒绝重名条目（大小写不敏感）', () => {
		const file = writeArchive('duplicate.zip', [
			{ name: 'SKILL.md', data: 'a' },
			{ name: 'skill.md', data: 'b' },
		]);
		assert.throws(() => validateZipArchive(file), /duplicate/);
	});

	test('拒绝条目数超限的归档', () => {
		const entries = Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt` }));
		const file = writeArchive('many.zip', entries);
		assert.throws(() => validateZipArchive(file), /too many entries/);
	});

	test('拒绝解压后总大小超限的归档（zip bomb）', () => {
		const file = writeArchive('bomb.zip', [
			{ name: 'big.bin', sizeOverride: MAX_ARCHIVE_TOTAL_BYTES + 1 },
		]);
		assert.throws(() => validateZipArchive(file), /total uncompressed size/);
	});

	test('拒绝 ZIP64 大小标记', () => {
		const file = writeArchive('zip64.zip', [{ name: 'big.bin', sizeOverride: 0xFFFFFFFF }]);
		assert.throws(() => validateZipArchive(file), /ZIP64/);
	});

	test('非 ZIP 文件报错', () => {
		const file = path.join(tmpDir, 'not-a-zip.zip');
		fs.writeFileSync(file, Buffer.from('this is definitely not a zip file'));
		assert.throws(() => validateZipArchive(file), /valid ZIP/);
	});
});
