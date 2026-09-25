/*---------------------------------------------------------------------------------------------
 *  测试：migrateConfig — 配置迁移逻辑
 *
 *  回归覆盖：
 *    - resolveConfigDir 路径穿越防护（KODRIX_CONFIG_DIR 必须在用户主目录内）
 *    - resolveConfigDir 优先级（~/.kodrix > ~/.cursormini）
 *    - resolveUserMcpJsonPath 平台路径解析
 *    - 迁移不覆盖已设置的用户键（applyIfUnset 逻辑）
 *    - 空配置 / 无效配置路径处理
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const vscodeMock = require('./vscode-mock');
const migrateConfig = require('../migrateConfig');

suite('migrateConfig', () => {

	// ── resolveConfigDir ──────────────────────────────────────────

	suite('resolveConfigDir', () => {
		const origEnv = { ...process.env };

		teardown(() => {
			// 恢复环境变量
			process.env = { ...origEnv };
		});

		test('默认返回 ~/.kodrix 或 ~/.cursormini', () => {
			delete process.env.KODRIX_CONFIG_DIR;
			delete process.env.CURSORMINI_CONFIG_DIR;
			const dir = migrateConfig.resolveConfigDir();
			assert.ok(typeof dir === 'string');
			// 应位于用户主目录内
			assert.ok(dir.startsWith(os.homedir()));
		});

		test('KODRIX_CONFIG_DIR 覆盖默认路径', () => {
			const customDir = path.join(os.homedir(), '.kodrix-test-custom');
			process.env.KODRIX_CONFIG_DIR = customDir;
			const dir = migrateConfig.resolveConfigDir();
			assert.strictEqual(dir, customDir);
		});

		test('KODRIX_CONFIG_DIR 越界时被忽略（路径穿越防护）', () => {
			// 指向用户主目录外的路径
			process.env.KODRIX_CONFIG_DIR = process.platform === 'win32'
				? 'C:\\Windows\\Temp\\evil'
				: '/tmp/evil-config';
			const dir = migrateConfig.resolveConfigDir();
			// 应回退到默认路径，而非越界路径
			assert.ok(dir.startsWith(os.homedir()));
			assert.ok(!dir.includes('evil'));
		});

		test('~/.kodrix 优先于 ~/.cursormini', () => {
			delete process.env.KODRIX_CONFIG_DIR;
			delete process.env.CURSORMINI_CONFIG_DIR;

			const kodrixDir = path.join(os.homedir(), '.kodrix');
			const legacyDir = path.join(os.homedir(), '.cursormini');

			// 确保两个目录都存在（有 config.json）
			let createdKodrix = false;
			let createdLegacy = false;
			try {
				if (!fs.existsSync(path.join(kodrixDir, 'config.json'))) {
					fs.mkdirSync(kodrixDir, { recursive: true });
					fs.writeFileSync(path.join(kodrixDir, 'config.json'), '{}', 'utf-8');
					createdKodrix = true;
				}
				if (!fs.existsSync(path.join(legacyDir, 'config.json'))) {
					fs.mkdirSync(legacyDir, { recursive: true });
					fs.writeFileSync(path.join(legacyDir, 'config.json'), '{}', 'utf-8');
					createdLegacy = true;
				}

				const dir = migrateConfig.resolveConfigDir();
				assert.strictEqual(dir, kodrixDir);
			} finally {
				// 清理我们创建的文件
				if (createdKodrix) {
					try { fs.unlinkSync(path.join(kodrixDir, 'config.json')); } catch { /* */ }
				}
				if (createdLegacy) {
					try { fs.unlinkSync(path.join(legacyDir, 'config.json')); } catch { /* */ }
				}
			}
		});
	});

	// ── resolveUserMcpJsonPath ────────────────────────────────────

	suite('resolveUserMcpJsonPath', () => {
		const origEnv = { ...process.env };

		teardown(() => {
			process.env = { ...origEnv };
		});

		test('VSCODE_PORTABLE 覆盖路径', () => {
			process.env.VSCODE_PORTABLE = '/portable/path';
			const mcpPath = migrateConfig.resolveUserMcpJsonPath();
			assert.ok(mcpPath.includes('portable'));
			assert.ok(mcpPath.endsWith('mcp.json'));
		});

		test('默认路径以 mcp.json 结尾', () => {
			delete process.env.VSCODE_PORTABLE;
			delete process.env.VSCODE_APPDATA;
			const mcpPath = migrateConfig.resolveUserMcpJsonPath();
			assert.ok(mcpPath.endsWith('mcp.json'));
		});
	});

	// ── 迁移不覆盖已设置用户键 ────────────────────────────────────

	suite('migrateFromLegacy — 不覆盖已设置键', () => {
		let tmpDir: string;

		setup(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-migrate-'));
			// 设置 KODRIX_CONFIG_DIR 指向临时目录
			process.env.KODRIX_CONFIG_DIR = tmpDir;
		});

		teardown(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			delete process.env.KODRIX_CONFIG_DIR;
			// 重置 mock inspect 行为
		});

		test('无配置文件时返回 migrated=false', async () => {
			// 临时目录为空，无 config.json / providers.json / plugins/
			const result = await migrateConfig.migrateFromLegacy([], {});
			assert.strictEqual(result.migrated, false);
			assert.ok(result.message.includes('未找到'));
		});

		test('空 config.json + 无 providers/plugins 时 migrated=false', async () => {
			fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}', 'utf-8');
			const result = await migrateConfig.migrateFromLegacy([], {});
			assert.strictEqual(result.migrated, false);
		});

		test('inspect 返回已有 globalValue 时不覆盖', async () => {
			// 创建有 agent_native_tools 的配置
			fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
				agent_native_tools: true,
			}), 'utf-8');

			// 模拟某个键已被用户设置
			const origGetConfig = vscodeMock.workspace.getConfiguration;
			vscodeMock.workspace.getConfiguration = () => ({
				get: () => undefined,
				has: () => true,
				inspect: () => ({
					key: 'github.copilot.chat.skillTool.enabled',
					globalValue: false, // 用户已显式设置
					workspaceValue: undefined,
					workspaceFolderValue: undefined,
				}),
				update: async () => { },
			});

			try {
				const result = await migrateConfig.migrateFromLegacy([], { applyAgentDefaults: true });
				// 由于 inspect 返回 globalValue !== undefined，applyIfUnset 应跳过
				// settingsApplied 中不应包含"原生工具"相关项（因为所有键都已被"设置"）
				const hasNativeTools = result.settingsApplied.some(
					(s: string) => s.includes('原生工具')
				);
				assert.strictEqual(hasNativeTools, false, 'Should not overwrite already-set keys');
			} finally {
				vscodeMock.workspace.getConfiguration = origGetConfig;
			}
		});
	});
});
