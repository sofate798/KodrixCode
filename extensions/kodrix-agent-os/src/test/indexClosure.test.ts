/*---------------------------------------------------------------------------------------------
 *  测试：索引功能闭环（glob 匹配 / 自动索引上限 / Grep 索引真实消费者）
 *
 *  覆盖：
 *    - I-A2：`kodrix.codebase.grepIndex` 关闭时 ensureGrepIndex() 不构建、不落盘
 *    - I-A2：Agent 的 search 工具优先使用落盘的仓库文本索引（此前该索引无任何消费者）
 *    - I-A3：自动索引文件数上限真的生效（超限抛可识别错误）；手动重建不受限
 *    - A-B6：`src/**\/*.ts` 这类常见 glob 能正确命中（此前手写分支永不匹配）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const indexer = require('../codebase/projectIndexer');
const { DEFAULT_TOOLS, compileSearchGlob } = require('../agent/agentLoop');
const { INDEX_TOO_MANY_FILES_PREFIX, clampMaxAutoIndexFiles } = require('../shared/constants');

suite('indexClosure — 索引功能闭环', () => {
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

	const grepIndexPath = () => path.join(ws, '.kodrix', 'codebase', 'grep-index.json');

	setup(() => {
		ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-idxclosure-'));
		useTmpWorkspace(ws);
		vscodeMock.__resetTestConfig();
		vscodeMock.workspace.isTrusted = true;
	});

	teardown(async () => {
		try { await indexer.deleteProjectIndex(); } catch { /* best-effort */ }
		vscodeMock.workspace.workspaceFolders = undefined;
		vscodeMock.__resetTestConfig();
		fs.rmSync(ws, { recursive: true, force: true });
	});

	// ── A-B6 glob 匹配 ───────────────────────────────────────────

	suite('compileSearchGlob', () => {
		test('src/**/*.ts 能匹配不同层级（此前永不命中）', () => {
			const re = compileSearchGlob('src/**/*.ts');
			assert.ok(re.test('src/a.ts'), '应匹配 src/a.ts');
			assert.ok(re.test('src/x/y.ts'), '应匹配 src/x/y.ts');
			assert.ok(!re.test('src/a.js'), '不应匹配 .js');
			assert.ok(!re.test('other/a.ts'), '不应匹配其它目录');
		});

		test('*.ts 与 ? 通配', () => {
			assert.ok(compileSearchGlob('*.ts').test('a.ts'));
			assert.ok(!compileSearchGlob('*.ts').test('a.js'));
			assert.ok(compileSearchGlob('a?.ts').test('ab.ts'));
			assert.ok(!compileSearchGlob('a?.ts').test('abc.ts'));
		});

		test('**/ 可匹配零层目录（anchored 语义）', () => {
			const re = compileSearchGlob('**/*.md');
			assert.ok(re.test('README.md'), '**/ 应可匹配零层');
			assert.ok(re.test('docs/a.md'));
		});
	});

	// ── I-A2 Grep 索引 ──────────────────────────────────────────

	suite('Grep 索引（真实消费者）', () => {
		test('开关关闭时不构建、不落盘', async () => {
			put('src/a.ts', 'export const a = 1;');
			vscodeMock.__setTestConfig('kodrix.codebase.grepIndex', false);

			const files = await indexer.ensureGrepIndex();

			assert.deepStrictEqual(files, [], '关闭后应返回空清单');
			assert.ok(!fs.existsSync(grepIndexPath()), '关闭后不应落盘');
		});

		test('开关开启时构建并落盘（供 search 工具复用）', async () => {
			put('src/a.ts', 'export const needleA = 1;');
			put('docs/readme.md', '# needleA in docs');

			const files = await indexer.ensureGrepIndex();

			assert.ok(files.length >= 2, '应收集到源码与文档文件');
			assert.ok(fs.existsSync(grepIndexPath()), '应落盘供后续复用');
		});

		test('search 工具使用落盘索引命中内容（含 glob 过滤）', async () => {
			put('src/needle.ts', 'export const needleSymbol = 42;');
			put('docs/needle.md', 'needleSymbol 出现在文档里');
			await indexer.ensureGrepIndex();

			const searchTool = DEFAULT_TOOLS.find((t: { name: string }) => t.name === 'search');
			assert.ok(searchTool, '应存在 search 工具');
			const session = { workspace: ws, allowCommands: false, iterations: 0 };

			const all = await searchTool.execute({ query: 'needleSymbol' }, session);
			assert.ok(all.ok);
			assert.ok(all.output.includes('src/needle.ts'), `应命中源码文件，实际输出：${all.output}`);
			assert.ok(all.output.includes('docs/needle.md'), '应同时命中文档');

			const tsOnly = await searchTool.execute({ query: 'needleSymbol', glob: 'src/**/*.ts' }, session);
			assert.ok(tsOnly.output.includes('src/needle.ts'), 'glob 过滤应保留 src/needle.ts');
			assert.ok(!tsOnly.output.includes('docs/needle.md'), 'glob 过滤应排除文档');
		});
	});

	// ── I-A3 自动索引上限 ────────────────────────────────────────

	suite('自动索引文件数上限', () => {
		test('clampMaxAutoIndexFiles 边界', () => {
			assert.strictEqual(clampMaxAutoIndexFiles(50_000), 50_000);
			assert.strictEqual(clampMaxAutoIndexFiles(1), 100, '低于下限收敛');
			assert.strictEqual(clampMaxAutoIndexFiles(Number.NaN), 50_000, '非法值回退默认');
			assert.strictEqual(clampMaxAutoIndexFiles(9_999_999), 1_000_000, '超过上限收敛');
		});

		test('超限时自动索引抛可识别错误，手动重建不受限', async () => {
			// 把上限压到最低（100）并造 101 个文件
			vscodeMock.__setTestConfig('kodrix.codebase.maxAutoIndexFiles', 100);
			for (let i = 0; i < 101; i++) {
				put(`src/f${i}.ts`, `export const v${i} = ${i};`);
			}

			await assert.rejects(
				() => indexer.ensureProjectIndex(true),
				(err: Error) => err.message.startsWith(INDEX_TOO_MANY_FILES_PREFIX),
				'自动索引超限应抛可识别错误（启动路径据此给出可操作提示）',
			);

			const index = await indexer.ensureProjectIndex(true, { manual: true });
			assert.strictEqual(index.stats.totalFiles, 101, '手动重建应忽略上限');
		});
	});
});
