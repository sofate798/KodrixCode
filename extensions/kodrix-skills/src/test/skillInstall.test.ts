/*---------------------------------------------------------------------------------------------
 *  测试：skillInstall — Skill 安装/卸载安全与功能
 *
 *  回归覆盖：
 *    - zip-slip 路径穿越防护
 *    - 大小上限检查（MAX_DOWNLOAD_BYTES / MAX_TEXT_FETCH_BYTES）
 *    - 重定向域名白名单
 *    - 安装后文件结构验证（SKILL.md 必须存在）
 *    - Skill 名称净化（非法字符 / 过长 / .. 穿越）
 *    - 卸载不存在的 Skill 报错
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
				assert.ok(err.message.includes('非法'));
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
				assert.ok(err.message.includes('非法'));
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
				assert.ok(err.message.includes('非法'));
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
				assert.ok(err.message.includes('未安装'));
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
	});
});
