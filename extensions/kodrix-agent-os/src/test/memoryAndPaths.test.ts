/*---------------------------------------------------------------------------------------------
 *  测试：Memory 空态语义 与 工作区 .kodrix 目录初始化（P0/P1 回归护栏）
 *
 *  覆盖：
 *    - 空 Memory 不再被伪造：不存在时 readMemoryContent() 返回空串（此前返回含示例文本的模板，
 *      导致"从没沉淀过知识，Agent 却收到示例偏好与团队约定"）
 *    - getMemoryTemplate() 仍提供完整章节结构（供首次写入使用）
 *    - ensureWorkspaceKodrixDir()：创建 .kodrix 并写好 .gitignore（会话记录等私有数据不被提交），幂等
 *    - 不受信任工作区：不创建工作区内目录、不写 .gitignore（与写入闸门一致）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const { readMemoryContent, getMemoryTemplate } = require('../memory/memoryHelpers');
const { ensureWorkspaceKodrixDir, ensureDir, getWorkspaceKodrixDir } = require('../paths');

suite('memoryAndPaths — 空态语义与工作区目录初始化', () => {
	let ws: string;

	function useTmpWorkspace(tmpDir: string): void {
		vscodeMock.workspace.workspaceFolders = [{
			uri: { fsPath: tmpDir, scheme: 'file', path: tmpDir, toString: () => tmpDir },
			name: 'test',
			index: 0,
		}];
	}

	setup(() => {
		ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-mem-'));
		useTmpWorkspace(ws);
		vscodeMock.workspace.isTrusted = true;
	});

	teardown(() => {
		vscodeMock.workspace.workspaceFolders = undefined;
		vscodeMock.workspace.isTrusted = true;
		fs.rmSync(ws, { recursive: true, force: true });
	});

	suite('Memory 空态', () => {
		test('从未沉淀过知识时，读取结果为空串（不返回示例模板）', () => {
			// 每个临时工作区派生唯一 hash → 对应的 memory.md 必然不存在
			const content = readMemoryContent();
			assert.strictEqual(content, '', '空记忆必须如实返回空串，否则示例文本会被当成真实记忆注入');
			assert.ok(!content.includes('例：'), '不得包含模板里的示例文本');
		});

		test('模板仍保留完整章节结构（供首次写入使用）', () => {
			const template = getMemoryTemplate();
			assert.ok(template.includes('# 项目 Memory'));
			for (const section of ['## 架构偏好', '## 命名规范', '## 常用库与模式', '## 团队约定', '## 已知陷阱']) {
				assert.ok(template.includes(section), `模板应包含 ${section}`);
			}
		});
	});

	suite('工作区 .kodrix 初始化', () => {
		test('创建 .kodrix 并写入 .gitignore（忽略目录内私有数据、保留自身）', () => {
			const base = ensureWorkspaceKodrixDir();
			assert.strictEqual(base, getWorkspaceKodrixDir());
			assert.ok(fs.existsSync(base!), '.kodrix 目录应被创建');

			const ignorePath = path.join(base!, '.gitignore');
			assert.ok(fs.existsSync(ignorePath), '应写入 .kodrix/.gitignore');
			const content = fs.readFileSync(ignorePath, 'utf-8');
			assert.ok(content.includes('*'), '应忽略目录内其它内容');
			assert.ok(content.includes('!.gitignore'), '应保留 .gitignore 自身可被跟踪');
		});

		test('幂等：重复调用不覆盖已有 .gitignore', () => {
			const base = ensureWorkspaceKodrixDir()!;
			const ignorePath = path.join(base, '.gitignore');
			fs.writeFileSync(ignorePath, '# 用户自定义\n', 'utf-8');

			ensureWorkspaceKodrixDir();

			assert.strictEqual(fs.readFileSync(ignorePath, 'utf-8'), '# 用户自定义\n', '不应覆盖用户已修改的文件');
		});

		test('不受信任工作区：不创建 .kodrix、不写 .gitignore', () => {
			vscodeMock.workspace.isTrusted = false;

			const base = ensureWorkspaceKodrixDir();

			assert.ok(base, '路径仍可返回（只读使用）');
			assert.ok(!fs.existsSync(base!), '不受信任工作区不应创建工作区内目录');
			assert.ok(!fs.existsSync(path.join(base!, '.gitignore')));
		});

		test('ensureDir：不受信任工作区跳过工作区内目录，但仍允许工作区外目录', () => {
			vscodeMock.workspace.isTrusted = false;
			const insideDir = path.join(ws, '.kodrix', 'should-not-exist');
			assert.doesNotThrow(() => ensureDir(insideDir), '应跳过而不是抛错（调用方多在启动/后台路径）');
			assert.ok(!fs.existsSync(insideDir));

			const outsideDir = path.join(os.tmpdir(), `kodrix-outside-${Date.now()}`);
			try {
				ensureDir(outsideDir);
				assert.ok(fs.existsSync(outsideDir), '工作区外的目录仍应创建');
			} finally {
				fs.rmSync(outsideDir, { recursive: true, force: true });
			}
		});
	});
});
