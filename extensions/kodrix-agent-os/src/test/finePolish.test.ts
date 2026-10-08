/*---------------------------------------------------------------------------------------------
 *  测试：本轮精细闭环的回归护栏（循环依赖 / 文本解码 / read_file 防护 / 上下文规模 / 清单）
 *
 *  覆盖：
 *    - C-B9 循环依赖：每个 DFS 起点必须独立 visited（此前全局共享 → 非首批可达的环全部漏报）
 *    - C-C2 环去重：按旋转归一（此前 sort 会把共享同批节点、顺序不同的环合并成一个）
 *    - C-B12 用户可编辑文本：BOM / UTF-16 / GBK 容错，读失败返回 undefined 而不抛错
 *    - A-B3 read_file：大文件与二进制文件必须被拒绝并给出可操作提示
 *    - C-C5 上下文规模汇总：只算大小、不拼接上下文串
 *    - A-B2 kodrix.router.naturalInput 必须已声明（命令面板可见）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeMock = require('./vscode-mock');
const { detectCodeSmells } = require('../wiki/codeSmellDetector');
const { readUserTextFileSync, decodeTextBuffer, stripBom } = require('../utils/textFile');
const { DEFAULT_TOOLS } = require('../agent/agentLoop');
const { getContextSizeSummary } = require('../context/contextIntelligence');

const EXT_ROOT = path.resolve(__dirname, '..', '..');

/** 构造一个最小可用索引（只填循环依赖检测需要的字段） */
function makeIndex(root: string, depGraph: Record<string, string[]>, files: string[]): unknown {
	const fileSummaries: Record<string, unknown> = {};
	for (const f of files) {
		fileSummaries[path.join(root, f)] = {
			filePath: path.join(root, f),
			relativePath: f,
			language: 'ts',
			symbolCount: 1,
			exportCount: 1,
			importCount: 0,
			callCount: 0,
			sizeBytes: 100,
			lastModified: Date.now(),
		};
	}
	return {
		version: 1,
		rootPath: root,
		createdAt: new Date().toISOString(),
		files: fileSummaries,
		symbols: {},
		imports: [],
		calls: [],
		depGraph,
		dependencyGraph: depGraph,
		reverseDepGraph: {},
		hotSymbols: [],
		stats: { totalFiles: files.length, totalSymbols: 0, totalImports: 0, totalCalls: 0, languageDistribution: {}, indexDurationMs: 1 },
	};
}

suite('finePolish — 本轮精细闭环回归', () => {
	let ws: string;

	setup(() => {
		ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-polish-'));
		vscodeMock.workspace.workspaceFolders = [{
			uri: { fsPath: ws, scheme: 'file', path: ws, toString: () => ws },
			name: 'test',
			index: 0,
		}];
		vscodeMock.__resetTestConfig();
		vscodeMock.workspace.isTrusted = true;
	});

	teardown(() => {
		vscodeMock.workspace.workspaceFolders = undefined;
		fs.rmSync(ws, { recursive: true, force: true });
	});

	// ── C-B9 ─────────────────────────────────────────────────────

	test('C-B9：非首批可达的环也要被检出（visited 每起点重置）', async () => {
		const a = path.join(ws, 'a.ts');
		const b = path.join(ws, 'b.ts');
		const c = path.join(ws, 'c.ts');
		const d = path.join(ws, 'd.ts');
		// a→b（无环）；c↔d 是环，且排在 a 之后才会被遍历到
		const depGraph: Record<string, string[]> = {
			[a]: [b],
			[b]: [],
			[c]: [d],
			[d]: [c],
		};
		const index = makeIndex(ws, depGraph, ['a.ts', 'b.ts', 'c.ts', 'd.ts']);

		const smells = await detectCodeSmells(ws, async () => index as never);
		const cycles = smells.filter((s: { type: string }) => s.type === 'circular_dep');

		assert.ok(cycles.length >= 1, `c↔d 的环必须被检出（此前会被全局 visited 吞掉）；实际检出 ${cycles.length} 个`);
		const joined = cycles.map((s: { message: string }) => s.message).join(' | ');
		assert.ok(joined.includes('c.ts') && joined.includes('d.ts'), `环内容应包含 c/d：${joined}`);
	});

	test('C-C2：共享同一批节点但顺序不同的环不应被合并', async () => {
		const a = path.join(ws, 'a.ts');
		const b = path.join(ws, 'b.ts');
		const c = path.join(ws, 'c.ts');
		// 两个不同的环都只涉及 {a,b,c}：a→b→c→a 与 a→c→b→a
		const depGraph: Record<string, string[]> = {
			[a]: [b, c],
			[b]: [c],
			[c]: [a, b],
		};
		const index = makeIndex(ws, depGraph, ['a.ts', 'b.ts', 'c.ts']);

		const smells = await detectCodeSmells(ws, async () => index as never);
		const cycles = smells.filter((s: { type: string }) => s.type === 'circular_dep');

		// 至少能区分出两条不同路径的环（旧实现 sort 后 key 相同 → 只剩 1 条）
		assert.ok(cycles.length >= 2, `应报出 ≥2 个不同环，实际 ${cycles.length}：${cycles.map((s: { message: string }) => s.message).join(' | ')}`);
	});

	// ── C-B12 ────────────────────────────────────────────────────

	test('C-B12：BOM / UTF-16 / GBK 与读失败容错', () => {
		// UTF-8 BOM
		const bomPath = path.join(ws, 'bom.md');
		fs.writeFileSync(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\n正文', 'utf-8')]));
		const bom = readUserTextFileSync(bomPath);
		assert.strictEqual(bom, '# 标题\n正文', 'UTF-8 BOM 必须被剥掉（否则会污染首行与上下文）');

		// UTF-16LE（记事本默认 Unicode）
		const u16Path = path.join(ws, 'u16.md');
		fs.writeFileSync(u16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 标题\n正文', 'utf16le')]));
		assert.strictEqual(readUserTextFileSync(u16Path), '# 标题\n正文', 'UTF-16LE 必须正确解码');

		// GBK（中文传统编码）
		const gbkPath = path.join(ws, 'gbk.md');
		fs.writeFileSync(gbkPath, Buffer.concat([Buffer.from('# ', 'utf-8'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\n', 'utf-8')]));
		const gbk = readUserTextFileSync(gbkPath);
		assert.strictEqual(gbk, '# 中文\n', 'GBK 应回退解码为中文而非替换字符');

		// 读失败（不存在）→ undefined，不抛错
		assert.strictEqual(readUserTextFileSync(path.join(ws, 'missing.md')), undefined, '读失败必须返回 undefined 而不是抛错');

		// 工具函数本身
		assert.strictEqual(stripBom('\uFEFFabc'), 'abc');
		assert.strictEqual(decodeTextBuffer(Buffer.from('中文', 'utf-8')), '中文');
	});

	// ── A-B3 ─────────────────────────────────────────────────────

	test('A-B3：read_file 拒绝超大文件与二进制文件', async () => {
		const readTool = DEFAULT_TOOLS.find((t: { name: string }) => t.name === 'read_file');
		assert.ok(readTool, '应存在 read_file 工具');
		const session = { workspace: ws, allowCommands: false, iterations: 0 };

		// 超大文件（> 2MB）
		const big = path.join(ws, 'big.txt');
		fs.writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 1024), 'utf-8');
		const bigResult = await readTool.execute({ path: 'big.txt' }, session);
		assert.strictEqual(bigResult.ok, false, '超大文件应被拒绝');
		assert.ok(bigResult.output.includes('过大'), `应说明原因：${bigResult.output}`);
		assert.ok(bigResult.output.includes('startLine') || bigResult.output.includes('分段'), '应给出可操作的替代做法');

		// 二进制文件（含 NUL）
		const bin = path.join(ws, 'bin.dat');
		fs.writeFileSync(bin, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x00]));
		const binResult = await readTool.execute({ path: 'bin.dat' }, session);
		assert.strictEqual(binResult.ok, false, '二进制文件应被拒绝');
		assert.ok(binResult.output.includes('二进制'), `应说明原因：${binResult.output}`);

		// 正常文件仍可读
		fs.writeFileSync(path.join(ws, 'ok.ts'), 'export const a = 1;\n', 'utf-8');
		const okResult = await readTool.execute({ path: 'ok.ts' }, session);
		assert.strictEqual(okResult.ok, true, '正常文件应可读');
	});

	// ── C-C5 ─────────────────────────────────────────────────────

	test('C-C5：上下文规模汇总只统计大小，不拼接上下文串', () => {
		const summary = getContextSizeSummary();
		assert.strictEqual(typeof summary.totalChars, 'number');
		assert.ok(summary.totalChars >= 0);
		assert.deepStrictEqual(Object.keys(summary.layers).sort(), ['learning', 'memory', 'wiki']);
		assert.strictEqual(
			summary.totalChars,
			summary.layers.wiki + summary.layers.memory + summary.layers.learning,
			'总字符数应等于各层之和',
		);
	});

	// ── A-B2 ─────────────────────────────────────────────────────

	test('A-B2：kodrix.router.naturalInput 已声明（命令面板可见）', () => {
		const pkg = require(path.join(EXT_ROOT, 'package.json'));
		const declared = (pkg.contributes.commands ?? []).map((c: { command: string }) => c.command);
		assert.ok(declared.includes('kodrix.router.naturalInput'), 'naturalInput 必须在 contributes.commands 中声明');
		// 声明了就必须有实现（由仓库契约检查脚本保证，这里做轻量复核）
		const source = fs.readFileSync(path.join(EXT_ROOT, 'src', 'router', 'naturalCommandPalette.ts'), 'utf-8');
		const registration = `registerCommand('kodrix.router.naturalInput'`;
		assert.ok(source.includes(registration), '应有对应 registerCommand');
	});
});
