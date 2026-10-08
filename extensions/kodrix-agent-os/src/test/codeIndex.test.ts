/*---------------------------------------------------------------------------------------------
 *  测试：代码索引（codebase）核心链路
 *
 *  覆盖（对应「上线可用」的判据）：
 *    - 构建：文件数 / 符号表 / 导出可见性 / 依赖边（正向 + 反向）
 *    - 缓存：force=false 复用内存索引，不重复构建
 *    - 增量一致性：源文件删除后重建不留幽灵条目
 *    - 容错：落盘索引损坏时自愈（不抛错 + 重写为合法 JSON）
 *    - 边界：无工作区、node_modules/.git/构建目录、excludeGlobs、超大文件
 *    - .cursorignore：忽略规则与 `!` 取反（gitignore 语义：后者覆盖前者）
 *    - 信任：不受信任工作区只在内存中建索引、不落盘
 *    - 查询：getIndexFiles 排序/limit、quickSearchSymbols、依赖/被依赖查询
 *    - Grep 索引：清单落盘 → 读取 → 清除
 *    - 状态：getIndexState 的 status/progress/stats/files 自洽
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vscode mock 已在 runTests.ts 中注册
const vscodeMock = require('./vscode-mock');
const indexer = require('../codebase/projectIndexer');
const query = require('../codebase/codebaseQuery');
const { SymbolVisibility } = require('../codebase/types');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

suite('codeIndex — 代码索引核心链路', () => {
	let ws: string;

	function useTmpWorkspace(tmpDir: string): void {
		vscodeMock.workspace.workspaceFolders = [{
			uri: { fsPath: tmpDir, scheme: 'file', path: tmpDir, toString: () => tmpDir },
			name: 'test',
			index: 0,
		}];
	}

	/** 写入工作区文件并返回绝对路径 */
	function put(rel: string, content: string): string {
		const full = path.join(ws, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, 'utf-8');
		return full;
	}

	const indexPath = () => path.join(ws, '.kodrix', 'codebase', 'project-index.json');
	const grepIndexPath = () => path.join(ws, '.kodrix', 'codebase', 'grep-index.json');
	const symbolNames = (index: { symbols: Record<string, { name: string }> }) => Object.values(index.symbols).map(s => s.name);
	const filePaths = (index: { files: Record<string, unknown> }) => Object.keys(index.files).map(f => f.replace(/\\/g, '/'));
	const findSymbol = (index: { symbols: Record<string, { name: string; visibility: string }> }, name: string) =>
		Object.values(index.symbols).find(s => s.name === name);

	setup(() => {
		ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-idx-'));
		useTmpWorkspace(ws);
		vscodeMock.__resetTestConfig();
	});

	teardown(async () => {
		try {
			await indexer.deleteProjectIndex();
		} catch { /* best-effort */ }
		vscodeMock.workspace.workspaceFolders = undefined;
		vscodeMock.workspace.isTrusted = true;
		fs.rmSync(ws, { recursive: true, force: true });
	});

	// ── 构建与结构 ────────────────────────────────────────────────

	test('构建索引：文件数、符号表、导出可见性与依赖边', async () => {
		const alphaPath = put('src/alpha.ts', [
			'export function alphaOne(x: number): number { return x + 1; }',
			'export class AlphaClass { run(): number { return alphaOne(1); } }',
			'function alphaHidden(): void { /* 未导出 */ }',
		].join('\n'));
		const betaPath = put('src/beta.ts', [
			`import { alphaOne } from './alpha';`,
			'export function betaOne(): number { return alphaOne(2); }',
		].join('\n'));

		const index = await indexer.ensureProjectIndex(true);

		assert.strictEqual(index.stats.totalFiles, 2, '应索引 2 个源文件');
		const names = symbolNames(index);
		for (const expected of ['alphaOne', 'AlphaClass', 'alphaHidden', 'betaOne']) {
			assert.ok(names.includes(expected), `符号表应包含 ${expected}`);
		}
		assert.strictEqual(findSymbol(index, 'alphaOne')?.visibility, SymbolVisibility.Exported);
		assert.notStrictEqual(findSymbol(index, 'alphaHidden')?.visibility, SymbolVisibility.Exported, '未导出符号不应标记为 exported');

		assert.ok((index.dependencyGraph[betaPath] ?? []).includes(alphaPath), 'beta 应依赖 alpha');
		assert.ok((index.reverseDependencyGraph[alphaPath] ?? []).includes(betaPath), 'alpha 应记录被 beta 依赖');
	});

	test('缓存：force=false 复用内存索引（对象同一）', async () => {
		put('src/cache.ts', 'export const cacheValue = 1;');
		const first = await indexer.ensureProjectIndex(true);
		const second = await indexer.ensureProjectIndex(false);
		const third = await indexer.ensureProjectIndex(false);
		assert.strictEqual(second, first);
		assert.strictEqual(third, first);
	});

	test('增量一致性：删除源文件后重建不留幽灵条目', async () => {
		put('src/stays.ts', 'export function staysFn(): void { }');
		put('src/gone.ts', 'export function goneFn(): void { }');
		const before = await indexer.ensureProjectIndex(true);
		assert.ok(filePaths(before).some(f => f.endsWith('src/gone.ts')));

		fs.rmSync(path.join(ws, 'src', 'gone.ts'));

		const after = await indexer.ensureProjectIndex(true);
		assert.ok(filePaths(after).some(f => f.endsWith('src/stays.ts')), '保留的文件应仍在索引里');
		assert.ok(!filePaths(after).some(f => f.endsWith('src/gone.ts')), '已删除文件不应残留在索引里');
		assert.ok(!symbolNames(after).includes('goneFn'), '已删除文件的符号不应残留');
	});

	test('容错：落盘索引损坏时自愈并重写为合法 JSON', async () => {
		put('src/selfheal.ts', 'export function selfHealFn(): void { }');
		await indexer.ensureProjectIndex(true);
		assert.ok(fs.existsSync(indexPath()), '索引应落盘');

		await indexer.deleteProjectIndex();                  // 清掉内存索引（同时删除文件）
		fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
		fs.writeFileSync(indexPath(), '{ 这不是合法 JSON', 'utf-8');

		const rebuilt = await indexer.ensureProjectIndex(false);  // 会先尝试加载旧索引 → 解析失败 → 全量重建
		assert.strictEqual(rebuilt.stats.totalFiles, 1, '损坏索引应触发重建而不是失败');
		assert.doesNotThrow(() => JSON.parse(fs.readFileSync(indexPath(), 'utf-8')), '重建后应写回合法 JSON');
	});

	// ── 边界与排除 ────────────────────────────────────────────────

	test('边界：无工作区时构建报错、grep 索引返回空', async () => {
		vscodeMock.workspace.workspaceFolders = undefined;
		await assert.rejects(() => indexer.ensureProjectIndex(true), /No workspace folder open/);
		assert.deepStrictEqual(await indexer.ensureGrepIndex(), []);
	});

	test('排除：node_modules/.git/构建目录、excludeGlobs 与超大文件都不进索引', async () => {
		put('src/keep.ts', 'export function keepFn(): void { }');
		put('node_modules/pkg/index.ts', 'export function nmFn(): void { }');
		put('.git/hook.ts', 'export function gitFn(): void { }');
		put('out/built.ts', 'export function outFn(): void { }');
		put('src/thing.test.ts', 'export function testFn(): void { }');   // excludeGlobs: **/*.test.*
		put('src/huge.ts', 'x'.repeat(600_000));                          // maxFileSize = 500KB

		const index = await indexer.ensureProjectIndex(true);
		const names = symbolNames(index);

		assert.ok(filePaths(index).some(f => f.endsWith('src/keep.ts')));
		for (const [label, symbol] of [['node_modules', 'nmFn'], ['.git', 'gitFn'], ['out', 'outFn'], ['*.test.*', 'testFn']] as const) {
			assert.ok(!names.includes(symbol), `${label} 中的符号不应被索引`);
		}
		assert.ok(!filePaths(index).some(f => f.endsWith('huge.ts')), '超大文件应被跳过');
	});

	test('.cursorignore：忽略规则与 `!` 取反（后者覆盖前者）', async () => {
		put('src/normal.ts', 'export function normalFn(): void { }');
		put('ignored/drop.ts', 'export function dropFn(): void { }');
		put('ignored/keep.ts', 'export function keepMeFn(): void { }');
		fs.writeFileSync(path.join(ws, '.cursorignore'), [
			'# 注释行',
			'ignored/**',
			'!ignored/keep.ts',
			'',
		].join('\n'), 'utf-8');

		const index = await indexer.ensureProjectIndex(true);
		const files = filePaths(index);

		assert.ok(files.some(f => f.endsWith('src/normal.ts')));
		assert.ok(!files.some(f => f.endsWith('ignored/drop.ts')), '被忽略的文件不应进索引');
		assert.ok(files.some(f => f.endsWith('ignored/keep.ts')), '`!` 取反规则应重新纳入文件');
	});

	test('信任：不受信任工作区只在内存建索引、不落盘', async () => {
		put('src/untrusted.ts', 'export function untrustedFn(): void { }');
		vscodeMock.workspace.isTrusted = false;
		try {
			const index = await indexer.ensureProjectIndex(true);
			assert.strictEqual(index.stats.totalFiles, 1, '不受信任工作区仍应能在内存中建索引');
			assert.ok(!fs.existsSync(indexPath()), '不受信任工作区不应把索引写入工作区');
		} finally {
			vscodeMock.workspace.isTrusted = true;
		}
	});

	// ── 查询与状态 ────────────────────────────────────────────────

	test('getIndexFiles：按修改时间倒序 + limit 生效', async () => {
		put('src/older.ts', 'export function olderFn(): void { }');
		await sleep(25);
		put('src/newer.ts', 'export function newerFn(): void { }');
		await indexer.ensureProjectIndex(true);

		const list = indexer.getIndexFiles();
		assert.strictEqual(list.length, 2);
		assert.ok(list[0].lastModified >= list[1].lastModified, '应按 lastModified 倒序');
		assert.strictEqual(indexer.getIndexFiles(1).length, 1);
	});

	test('quickSearchSymbols：精确命中排首位且导出符号满分', async () => {
		put('src/find.ts', [
			'export function findTargetXYZ(): void { }',
			'function findTargetXYZHelper(): void { }',
		].join('\n'));
		await indexer.ensureProjectIndex(true);

		const hits = query.quickSearchSymbols('findTargetXYZ');
		assert.ok(hits.length >= 1, '应命中符号');
		assert.strictEqual(hits[0].symbol.name, 'findTargetXYZ');
		assert.strictEqual(hits[0].score, 1, '导出符号得分应为 1');
	});

	test('依赖查询：getFileDependencies / getFileDependents 与索引边一致', async () => {
		const cPath = put('src/c.ts', `import { dFn } from './d';\nexport function cFn(): void { dFn(); }`);
		const dPath = put('src/d.ts', 'export function dFn(): void { }');
		await indexer.ensureProjectIndex(true);

		assert.ok(query.getFileDependencies(cPath).includes(dPath));
		assert.ok(query.getFileDependents(dPath).includes(cPath));
		assert.deepStrictEqual(query.getFileDependencies(dPath), [], '无依赖的文件应返回空数组');
	});

	test('Grep 索引：清单落盘 → 读取 → 清除', async () => {
		put('src/g.ts', 'export const gValue = 1;');
		put('README.md', '# hello');

		const files: string[] = await indexer.ensureGrepIndex();
		const normalized = files.map(f => f.replace(/\\/g, '/'));
		assert.ok(normalized.some(f => f.endsWith('src/g.ts')), '源码文件应在清单里');
		assert.ok(normalized.some(f => f.endsWith('README.md')), '非源码文本文件也应在清单里');
		assert.ok(fs.existsSync(grepIndexPath()), 'grep 索引应落盘');
		assert.strictEqual(indexer.getGrepIndexFiles().length, files.length);

		indexer.clearGrepIndex();
		assert.deepStrictEqual(indexer.getGrepIndexFiles(), []);
		assert.ok(!fs.existsSync(grepIndexPath()), '清除后文件应被删除');
	});

	test('状态：getIndexState 的 status/progress/stats/files 自洽', async () => {
		put('src/state.ts', 'export function stateFn(): void { }');
		const index = await indexer.ensureProjectIndex(true);
		const state = indexer.getIndexState();

		assert.strictEqual(state.status, 'done');
		assert.strictEqual(state.progress.total, index.stats.totalFiles);
		assert.strictEqual(state.progress.parsed, index.stats.totalFiles);
		assert.ok(state.stats && state.stats.totalFiles === index.stats.totalFiles);
		assert.ok(state.files.length <= 30, 'files 列表最多 30 条（面板展示用）');
	});

	test('状态：空闲时 pauseIndexBuild 是安全 no-op，resume 后能重新构建', async () => {
		put('src/pause.ts', 'export function pauseFn(): void { }');
		await indexer.ensureProjectIndex(true);

		indexer.pauseIndexBuild();   // 非 building 状态下应为 no-op，不得把状态改成 paused
		assert.strictEqual(indexer.getIndexState().status, 'done');

		indexer.resumeIndexBuild();  // 非 paused 状态下同样 no-op
		const rebuilt = await indexer.ensureProjectIndex(false);
		assert.ok(symbolNames(rebuilt).includes('pauseFn'));
	});
});
