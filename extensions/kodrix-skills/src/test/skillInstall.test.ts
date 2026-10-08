/*---------------------------------------------------------------------------------------------
 *  测试：skillInstall — Skill 安装/卸载安全与功能
 *
 *  回归覆盖：
 *    - 解压前 ZIP 校验（穿越/符号链接/大小，见 zipValidation.test.ts）+ 解压路径
 *    - 大小上限检查（MAX_DOWNLOAD_BYTES / MAX_TEXT_FETCH_BYTES）
 *    - 重定向/来源域名白名单（hostname 精确匹配 + 强制 https）
 *    - 安装后文件结构验证（SKILL.md 必须存在）
 *    - Skill 名称净化（非法字符 / 过长 / . / .. / 保留名 / 结尾点号）
 *    - 卸载只允许真正的 Skill 目录
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildZip } from './zipFixture';

const vscodeMock = require('./vscode-mock');
const skillInstall = require('../skillInstall');

suite('skillInstall', () => {
	let tmpDir: string;

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-skill-'));
		// 将 skills 安装目录指向临时目录
		vscodeMock.workspace.getConfiguration = (section?: string) => {
			if (section === 'kodrix.skills') {
				return {
					get: (key: string, defaultValue?: unknown) => {
						if (key === 'installDir') { return tmpDir; }
						return defaultValue;
					},
					has: () => true,
					inspect: () => undefined,
					update: async () => { },
				};
			}
			return {
				get: () => undefined,
				has: () => false,
				inspect: () => undefined,
				update: async () => { },
			};
		};
	});

	teardown(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── resolveSkillsDir ──────────────────────────────────────────

	suite('resolveSkillsDir', () => {
		test('使用配置中的安装目录', () => {
			const dir = skillInstall.resolveSkillsDir();
			assert.strictEqual(dir, tmpDir);
		});
	});

	// ── installSkillFromDir ───────────────────────────────────────

	suite('installSkillFromDir', () => {
		test('安装含 SKILL.md 的目录', async () => {
			const sourceDir = path.join(tmpDir, 'source-skill');
			fs.mkdirSync(sourceDir, { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Test Skill', 'utf-8');

			// 安装到不同的安装目录
			const installDir = path.join(tmpDir, 'installed');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});

			const name = await skillInstall.installSkillFromDir(sourceDir, 'my-skill');
			assert.strictEqual(name, 'my-skill');
			assert.ok(fs.existsSync(path.join(installDir, 'my-skill', 'SKILL.md')));
		});

		test('无 SKILL.md 时报错', async () => {
			const sourceDir = path.join(tmpDir, 'no-skill-md');
			fs.mkdirSync(sourceDir, { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'README.md'), 'no skill', 'utf-8');

			try {
				await skillInstall.installSkillFromDir(sourceDir, 'bad-skill');
				assert.fail('Should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes('SKILL.md'));
			}
		});

		test('名称净化：拒绝 .. 穿越', async () => {
			const sourceDir = path.join(tmpDir, 'source');
			fs.mkdirSync(sourceDir, { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Skill', 'utf-8');

			try {
				await skillInstall.installSkillFromDir(sourceDir, '../../../etc/evil');
				assert.fail('Should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes('Invalid skill name'));
			}
		});

		test('名称净化：拒绝非法字符', async () => {
			const sourceDir = path.join(tmpDir, 'source');
			fs.mkdirSync(sourceDir, { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Skill', 'utf-8');

			try {
				await skillInstall.installSkillFromDir(sourceDir, 'skill with spaces!');
				assert.fail('Should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes('Invalid skill name'));
			}
		});

		test('名称净化：拒绝超长名称（>64 字符）', async () => {
			const sourceDir = path.join(tmpDir, 'source');
			fs.mkdirSync(sourceDir, { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Skill', 'utf-8');

			const longName = 'a'.repeat(65);
			try {
				await skillInstall.installSkillFromDir(sourceDir, longName);
				assert.fail('Should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes('Invalid skill name'));
			}
		});

		test('安装后文件结构正确', async () => {
			const sourceDir = path.join(tmpDir, 'full-skill');
			fs.mkdirSync(path.join(sourceDir, 'scripts'), { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Full Skill', 'utf-8');
			fs.writeFileSync(path.join(sourceDir, 'scripts', 'run.sh'), '#!/bin/bash', 'utf-8');

			const installDir = path.join(tmpDir, 'installed');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});

			await skillInstall.installSkillFromDir(sourceDir, 'full-skill');

			// 验证文件结构
			assert.ok(fs.existsSync(path.join(installDir, 'full-skill', 'SKILL.md')));
			assert.ok(fs.existsSync(path.join(installDir, 'full-skill', 'scripts', 'run.sh')));
		});

		// ── 名称边界（H1 回归：`.` 曾可解析到技能根目录并被递归删除） ──

		for (const badName of ['.', '..', 'a..b', 'name.', '.hidden', 'a/b', 'a\\b', '/etc', 'C:\\Windows', 'CON', 'com1', 'skill with spaces']) {
			test(`名称净化：拒绝 ${JSON.stringify(badName)}`, async () => {
				const sourceDir = path.join(tmpDir, 'source-guard');
				fs.mkdirSync(sourceDir, { recursive: true });
				fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Skill', 'utf-8');

				try {
					await skillInstall.installSkillFromDir(sourceDir, badName);
					assert.fail(`应当拒绝名称：${badName}`);
				} catch (err) {
					assert.ok(err instanceof Error);
					assert.ok(err.message.includes('Invalid skill name'), `实际错误：${err.message}`);
				}
			});
		}

		test('名称净化：合法名称仍然通过', async () => {
			const installDir = path.join(tmpDir, 'installed-legit');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});
			for (const goodName of ['my-skill', 'skill_v2', 'My.Skill.v1', 'a+b']) {
				const sourceDir = path.join(tmpDir, `source-${goodName}`);
				fs.mkdirSync(sourceDir, { recursive: true });
				fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Skill', 'utf-8');
				const name = await skillInstall.installSkillFromDir(sourceDir, goodName);
				assert.strictEqual(name, goodName);
			}
		});
	});

	// ── 来源/重定向域名校验 ────────────────────────────────────────

	suite('isTrustedHttpsUrl', () => {
		test('接受 GitHub 家族的 https 主机', () => {
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('https://github.com/u/r/archive/refs/heads/main.zip'), true);
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('https://raw.githubusercontent.com/u/r/main/SKILL.md'), true);
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('https://codeload.github.com/u/r/zip/refs/heads/main'), true);
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('https://api.github.com/repos/u/r'), true);
		});

		test('拒绝前缀伪装 / userinfo 伪装 / 明文 http', () => {
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('https://github.com.evil.tld/x.zip'), false);
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('https://raw.githubusercontent.com.evil.tld/x'), false);
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('https://github.com@evil.tld/x.zip'), false);
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('http://github.com/u/r.zip'), false);
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('file:///etc/passwd'), false);
			assert.strictEqual(skillInstall.isTrustedHttpsUrl('not a url'), false);
		});
	});

	// ── 解压路径 ──────────────────────────────────────────────────

	suite('extractZip', () => {
		test('合法归档可被解压（Windows 走 -File 传参）', function (this: Mocha.Context) {
			if (process.platform !== 'win32') {
				this.skip();
			}
			const zip = path.join(tmpDir, 'ok.zip');
			fs.writeFileSync(zip, buildZip([
				{ name: 'SKILL.md', data: '# Skill' },
				{ name: 'sub/a.txt', data: 'hello' },
			]));
			const dest = path.join(tmpDir, 'extract-ok');
			fs.mkdirSync(dest, { recursive: true });

			skillInstall.extractZip(zip, dest);

			assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
			assert.ok(fs.existsSync(path.join(dest, 'sub', 'a.txt')));
		});

		test('穿越归档在解压前被拒，目标目录外不产生文件', () => {
			const zip = path.join(tmpDir, 'evil.zip');
			fs.writeFileSync(zip, buildZip([{ name: '../escaped.txt', data: 'evil' }]));
			const dest = path.join(tmpDir, 'extract-evil');
			fs.mkdirSync(dest, { recursive: true });

			assert.throws(() => skillInstall.extractZip(zip, dest), /path traversal/);
			assert.strictEqual(fs.existsSync(path.join(tmpDir, 'escaped.txt')), false);
		});
	});

	// ── listInstalledSkills ────────────────────────────────────────

	suite('listInstalledSkills', () => {
		test('空目录返回空数组', () => {
			const skills = skillInstall.listInstalledSkills();
			assert.ok(Array.isArray(skills));
			assert.strictEqual(skills.length, 0);
		});

		test('只列出含 SKILL.md 的子目录', () => {
			const installDir = path.join(tmpDir, 'skills-list');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});

			// 创建有效 skill
			fs.mkdirSync(path.join(installDir, 'valid-skill'), { recursive: true });
			fs.writeFileSync(path.join(installDir, 'valid-skill', 'SKILL.md'), '# Valid', 'utf-8');

			// 创建无效目录（无 SKILL.md）
			fs.mkdirSync(path.join(installDir, 'not-a-skill'), { recursive: true });
			fs.writeFileSync(path.join(installDir, 'not-a-skill', 'README.md'), 'no', 'utf-8');

			const skills = skillInstall.listInstalledSkills();
			assert.strictEqual(skills.length, 1);
			assert.strictEqual(skills[0], 'valid-skill');
		});
	});

	// ── uninstallSkill ─────────────────────────────────────────────

	suite('uninstallSkill', () => {
		test('卸载已安装的 Skill', () => {
			const installDir = path.join(tmpDir, 'skills-uninstall');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});

			fs.mkdirSync(path.join(installDir, 'to-remove'), { recursive: true });
			fs.writeFileSync(path.join(installDir, 'to-remove', 'SKILL.md'), '# Remove', 'utf-8');

			skillInstall.uninstallSkill('to-remove');
			assert.strictEqual(fs.existsSync(path.join(installDir, 'to-remove')), false);
		});

		test('拒绝删除不含 SKILL.md 的目录（避免误删用户数据）', () => {
			const installDir = path.join(tmpDir, 'skills-guard');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});

			fs.mkdirSync(path.join(installDir, 'not-a-skill'), { recursive: true });
			fs.writeFileSync(path.join(installDir, 'not-a-skill', 'README.md'), 'precious', 'utf-8');

			try {
				skillInstall.uninstallSkill('not-a-skill');
				assert.fail('Should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes('not a skill folder'), `实际错误：${err.message}`);
			}
			assert.ok(fs.existsSync(path.join(installDir, 'not-a-skill', 'README.md')), '目录内容应保持完好');
		});

		test('卸载不存在的 Skill 报错', () => {
			const installDir = path.join(tmpDir, 'skills-empty');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});

			try {
				skillInstall.uninstallSkill('nonexistent');
				assert.fail('Should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes('Not installed'));
			}
		});
	});

	// ── loadCatalog ───────────────────────────────────────────────

	suite('loadCatalog', () => {
		test('不存在的 catalog 返回空 items', () => {
			const result = skillInstall.loadCatalog('/nonexistent/path');
			assert.ok(Array.isArray(result.items));
			assert.strictEqual(result.items.length, 0);
		});

		test('有效 catalog.json 被正确解析', () => {
			const catalogDir = path.join(tmpDir, 'catalog');
			fs.mkdirSync(path.join(catalogDir, 'resources'), { recursive: true });
			fs.writeFileSync(
				path.join(catalogDir, 'resources', 'catalog.json'),
				JSON.stringify({ items: [{ id: 'test.skill', displayName: 'Test' }] }),
				'utf-8',
			);

			const result = skillInstall.loadCatalog(catalogDir);
			assert.strictEqual(result.items.length, 1);
			assert.strictEqual(result.items[0].id, 'test.skill');
		});

		test('非法条目被丢弃，合法条目保留', () => {
			const catalogDir = path.join(tmpDir, 'catalog-mixed');
			fs.mkdirSync(path.join(catalogDir, 'resources'), { recursive: true });
			fs.writeFileSync(
				path.join(catalogDir, 'resources', 'catalog.json'),
				JSON.stringify({
					items: [
						{ id: 'good.skill', displayName: 'Good', bundle: 'good-skill', sha256: 'A'.repeat(64) },
						{ displayName: '缺少 id' },
						{ id: 'bad.http', displayName: 'HTTP 源', downloadUrl: 'http://example.com/a.zip' },
						{ id: 'bad.hash', displayName: '哈希非法', sha256: 'not-a-hash' },
						'not-an-object',
					],
				}),
				'utf-8',
			);

			const result = skillInstall.loadCatalog(catalogDir);
			assert.deepStrictEqual(result.items.map((i: { id: string }) => i.id), ['good.skill']);
			// 声明了 sha256 的条目会被规范成小写
			assert.strictEqual(result.items[0].sha256, 'a'.repeat(64));
		});
	});

	// ── 完整性校验工具 ─────────────────────────────────────────────

	suite('完整性校验', () => {
		test('computeFileSha256 与已知向量一致', () => {
			const file = path.join(tmpDir, 'abc.txt');
			fs.writeFileSync(file, 'abc', 'utf-8');
			// sha256("abc")
			assert.strictEqual(
				skillInstall.computeFileSha256(file),
				'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
			);
		});

		test('computeTextSha256 与 computeFileSha256 对同一内容一致', () => {
			const text = '# Skill\n内容';
			const file = path.join(tmpDir, 'same.txt');
			fs.writeFileSync(file, text, 'utf-8');
			assert.strictEqual(skillInstall.computeTextSha256(text), skillInstall.computeFileSha256(file));
		});

		test('parseSha256Fragment 只接受 #sha256=<64位hex>', () => {
			const hex = 'a'.repeat(64);
			assert.strictEqual(skillInstall.parseSha256Fragment(`https://raw.githubusercontent.com/u/r/main/SKILL.md#sha256=${hex}`), hex);
			assert.strictEqual(skillInstall.parseSha256Fragment('https://raw.githubusercontent.com/u/r/main/SKILL.md'), undefined);
			assert.strictEqual(skillInstall.parseSha256Fragment('https://raw.githubusercontent.com/u/r/main/SKILL.md#sha256=zz'), undefined);
			assert.strictEqual(skillInstall.parseSha256Fragment(`https://raw.githubusercontent.com/u/r/main/SKILL.md#sha256=${'a'.repeat(63)}`), undefined);
		});
	});

	// ── GitHub URL 归一化 ──────────────────────────────────────────

	suite('toRawSkillUrl', () => {
		test('blob 页面转成 raw 地址', () => {
			assert.strictEqual(
				skillInstall.toRawSkillUrl('https://github.com/owner/repo/blob/main/skills/demo/SKILL.md'),
				'https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md',
			);
		});

		test('非 blob 地址原样返回', () => {
			const raw = 'https://raw.githubusercontent.com/owner/repo/main/SKILL.md';
			assert.strictEqual(skillInstall.toRawSkillUrl(raw), raw);
			assert.strictEqual(skillInstall.toRawSkillUrl('https://github.com/owner/repo'), 'https://github.com/owner/repo');
		});
	});

	// ── 覆盖语义 ──────────────────────────────────────────────────

	suite('覆盖安装确认', () => {
		function makeSource(dirName: string, content: string): string {
			const sourceDir = path.join(tmpDir, dirName);
			fs.mkdirSync(sourceDir, { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), content, 'utf-8');
			return sourceDir;
		}

		test('目标已存在且未确认覆盖时报错，且不动原内容', async () => {
			const installDir = path.join(tmpDir, 'skills-overwrite');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});
			const source = makeSource('src-a', '# version 1');

			await skillInstall.installSkillFromDir(source, 'demo-skill');
			fs.writeFileSync(path.join(source, 'SKILL.md'), '# version 2', 'utf-8');

			try {
				await skillInstall.installSkillFromDir(source, 'demo-skill');
				assert.fail('Should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err instanceof skillInstall.SkillExistsError, `实际错误：${err.message}`);
			}
			assert.strictEqual(fs.readFileSync(path.join(installDir, 'demo-skill', 'SKILL.md'), 'utf-8'), '# version 1');
		});

		test('显式 overwrite 时才替换内容', async () => {
			const installDir = path.join(tmpDir, 'skills-overwrite2');
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => installDir,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});
			const source = makeSource('src-b', '# version 1');

			await skillInstall.installSkillFromDir(source, 'demo-skill');
			fs.writeFileSync(path.join(source, 'SKILL.md'), '# version 2', 'utf-8');

			await skillInstall.installSkillFromDir(source, 'demo-skill', { overwrite: true });

			assert.strictEqual(fs.readFileSync(path.join(installDir, 'demo-skill', 'SKILL.md'), 'utf-8'), '# version 2');
		});
	});

	// ── 安装目录取值校验 ───────────────────────────────────────────

	suite('resolveSkillsDir 取值校验', () => {
		function withInstallDir(value: string) {
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => value,
				has: () => true,
				inspect: () => undefined,
				update: async () => { },
			});
		}

		test('拒绝文件系统根目录', () => {
			withInstallDir(path.parse(tmpDir).root);
			assert.throws(() => skillInstall.resolveSkillsDir(), /Invalid skill install directory/);
		});

		test('拒绝用户主目录本身', () => {
			withInstallDir(os.homedir());
			assert.throws(() => skillInstall.resolveSkillsDir(), /Invalid skill install directory/);
		});

		test('接受普通绝对路径并做规范化', () => {
			withInstallDir(path.join(tmpDir, 'nested', '..', 'skills-ok'));
			assert.strictEqual(skillInstall.resolveSkillsDir(), path.join(tmpDir, 'skills-ok'));
		});
	});
});
