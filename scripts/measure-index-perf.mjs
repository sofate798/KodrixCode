#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*
 * measure-index-perf.mjs — 索引性能 / 事件循环阻塞的可复现测量
 *
 * 背景（A1）：kodrix-agent-os 的索引已改为「每批 / 每 N 目录让出事件循环」+ 热路径异步读，
 * 但仍有一批同步读留在同步函数里（semanticIndex.buildBlockDoc、repoWiki.getWikiContextForAgent 等）。
 * 是否值得继续异步化（要改公开签名）取决于实测阻塞数据，本脚本就是那个"性能数据"的来源。
 *
 * 用法：
 *   node scripts/measure-index-perf.mjs                 # 默认 400 文件 / 40 目录（临时目录，用完删除）
 *   node scripts/measure-index-perf.mjs --files 2000 --dirs 100
 *   node scripts/measure-index-perf.mjs --files 20000 --dirs 500 --dir .bench/index-perf
 *       ↑ 复用同一目录做**热态**测量（避免每轮都让杀毒软件首次扫描 2 万个新文件，数据才可比）
 *
 * 前置：先在 extensions/kodrix-agent-os 目录跑过一次 `npm test`（生成 out/ 与 out-test/）。
 *
 * 指标：
 *   - 耗时：构建索引 / 遍历目录的墙钟时间
 *   - ticks：事件循环探测定时器（10ms）在窗口内被触发的次数，0 = 全程阻塞
 *   - maxGap：相邻探测之间最长间隔，越大说明单次阻塞越久（>100ms 用户可感知卡顿）
 */

import { createRequire } from 'module';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { PerformanceObserver } from 'perf_hooks';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extRoot = join(repoRoot, 'extensions', 'kodrix-agent-os');
const mockPath = join(extRoot, 'out-test', 'test', 'vscode-mock.js');
const indexerPath = join(extRoot, 'out', 'codebase', 'projectIndexer.js');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const totalFiles = argValue('files', 400);
const totalDirs = argValue('dirs', 40);
const dirIndex = argv.indexOf('--dir');
const persistentDir = dirIndex >= 0 && argv[dirIndex + 1] ? resolve(argv[dirIndex + 1]) : undefined;
const traceEnabled = argv.includes('--trace');
/** 同进程内连续构建次数：用于区分「一次性预热开销」与「每次构建都有的阻塞」 */
const repeatCount = Math.max(1, argValue('repeat', 1));
const PROBE_INTERVAL_MS = 10;
/** 隔离实验用的分块大小，与 fsSafe.atomicWriteFileAsync 保持一致 */
const ASYNC_WRITE_CHUNK = 4 * 1024 * 1024;

for (const [label, p] of [['out-test/test/vscode-mock.js', mockPath], ['out/codebase/projectIndexer.js', indexerPath]]) {
	if (!require('fs').existsSync(p)) {
		console.error(`缺少 ${label}（${p}）。请先在 extensions/kodrix-agent-os 运行一次 npm test。`);
		process.exit(1);
	}
}

/** 生成一个可索引的工作区（--dir 时复用同一目录，做热态测量且不删除） */
function createWorkspace() {
	const root = persistentDir ?? mkdtempSync(join(tmpdir(), 'kodrix-perf-'));
	const perDir = Math.max(1, Math.ceil(totalFiles / totalDirs));
	for (let d = 0; d < totalDirs; d++) {
		const dir = join(root, 'src', `mod${d}`);
		mkdirSync(dir, { recursive: true });
		for (let f = 0; f < perDir; f++) {
			const body = [
				`export interface IThing${f} { id: string; value: number; }`,
				`export function make${f}(seed: number): IThing${f} {`,
				`	return { id: 'thing-${d}-${f}-' + seed, value: seed * ${f + 1} };`,
				`}`,
				`export class Service${f} {`,
				`	constructor(private readonly seed: number) { }`,
				`	run(input: number): number { return input + this.seed + ${f}; }`,
				`}`,
			].join('\n');
			writeFileSync(join(dir, `file${f}.ts`), body, 'utf-8');
		}
	}
	return root;
}

/** 事件循环探测：返回停止函数与结果读取器 */
function startProbe() {
	const state = { ticks: 0, maxGap: 0, maxGapAtMs: 0 };
	const started = process.hrtime.bigint();
	let last = started;
	const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
	const timer = setInterval(() => {
		const now = process.hrtime.bigint();
		const gap = Number(now - last) / 1e6;
		if (gap > state.maxGap) {
			state.maxGap = gap;
			state.maxGapAtMs = elapsedMs();
		}
		state.ticks++;
		last = now;
	}, PROBE_INTERVAL_MS);
	return {
		stop() {
			clearInterval(timer);
			// 收尾：把"最后一次 tick（或起点）到现在"也算进去，
			// 否则全程阻塞的窗口会出现 ticks=0 / maxGap=0 的误导性结果
			const tail = Number(process.hrtime.bigint() - last) / 1e6;
			if (tail > state.maxGap) {
				state.maxGap = tail;
				state.maxGapAtMs = elapsedMs();
			}
			state.windowMs = elapsedMs();
			return state;
		},
	};
}

const listFiles = (dir, out = []) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			listFiles(full, out);
		} else if (entry.name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
};

/**
 * --trace：给同步 IO 与大对象序列化打点。
 * 事件循环的空档有时没有对应的 JS 采样（同步系统调用/杀毒过滤驱动），
 * 这时只能靠"哪个同步操作自己耗时多少"来定位。
 */
function installTrace() {
	const probeStart = Date.now();
	const hits = [];
	// 注意：ESM 的 `import * as fs` 命名空间对象只读，无法打点；
	// 被测代码是 CJS（require('fs')），所以这里拿 CJS 模块对象来包装。
	const fsCjs = require('fs');
	const wrap = (obj, name, label) => {
		const original = obj[name];
		if (typeof original !== 'function') { return; }
		obj[name] = function (...args) {
			const t0 = Date.now();
			const result = original.apply(this, args);
			const cost = Date.now() - t0;
			if (cost >= 20) {
				const size = typeof args[1] === 'string' ? ` (${(args[1].length / 1024 / 1024).toFixed(1)} MB)` : '';
				hits.push(`+${String(Date.now() - probeStart).padStart(6)} ms  ${label} ${cost} ms${size}`);
			}
			return result;
		};
	};
	wrap(fsCjs, 'writeFileSync', 'fs.writeFileSync');
	wrap(fsCjs, 'readFileSync', 'fs.readFileSync');
	wrap(fsCjs.promises, 'writeFile', 'fs.promises.writeFile');
	wrap(fsCjs.promises, 'rename', 'fs.promises.rename');
	wrap(fsCjs, 'renameSync', 'fs.renameSync');
	const originalStringify = JSON.stringify;
	JSON.stringify = function (...args) {
		const t0 = Date.now();
		const result = originalStringify.apply(this, args);
		const cost = Date.now() - t0;
		if (cost >= 20) {
			hits.push(`+${String(Date.now() - probeStart).padStart(6)} ms  JSON.stringify ${cost} ms (${(result.length / 1024 / 1024).toFixed(1)} MB)`);
		}
		return result;
	};
	// GC 观测：大对象分配（例如 59MB 的索引字符串）触发的整段 GC 也是"没有 JS 采样"的空档
	const gcObserver = new PerformanceObserver(list => {
		for (const entry of list.getEntries()) {
			if (entry.duration >= 20) {
				hits.push(`+${String(Date.now() - probeStart).padStart(6)} ms  GC(${entry.kind}) ${entry.duration.toFixed(0)} ms`);
			}
		}
	});
	try {
		gcObserver.observe({ entryTypes: ['gc'] });
	} catch { /* 环境不支持则忽略 */ }
	return { hits, reset: () => { hits.length = 0; } };
}

const fmt = (n, digits = 1) => Number(n).toFixed(digits);

const workspace = createWorkspace();
const mock = require(mockPath);
const vscode = require('vscode');
vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace }, name: 'kodrix-perf', index: 0 }];
const { ensureProjectIndex, ensureGrepIndex } = require(indexerPath);

const files = listFiles(workspace);
const tracer = installTrace();
console.log(`工作区：${files.length} 个 .ts 文件 / ${totalDirs} 个目录（${workspace}）${traceEnabled ? ' · --trace 已开启' : ''}\n`);

try {
	// ① 对照组：纯同步读（展示"全程阻塞"的基线）
	{
		const probe = startProbe();
		const t0 = Date.now();
		let bytes = 0;
		for (const f of files) {
			bytes += readFileSync(f, 'utf-8').length;
		}
		const elapsed = Date.now() - t0;
		const { ticks, maxGap } = probe.stop();
		console.log('[对照] 纯同步读全部文件');
		console.log(`   耗时 ${elapsed} ms（${fmt(bytes / 1024)} KB）· ticks ${ticks} · maxGap ${fmt(maxGap)} ms\n`);
	}

	// ② 目录遍历（ensureGrepIndex 内部走 collectAllTextFiles，已按目录让出）
	{
		const probe = startProbe();
		const t0 = Date.now();
		const grepped = await ensureGrepIndex();
		const elapsed = Date.now() - t0;
		const { ticks, maxGap } = probe.stop();
		console.log('[测量] ensureGrepIndex()（目录遍历）');
		console.log(`   命中 ${grepped.length} 个文件 · 耗时 ${elapsed} ms · ticks ${ticks} · maxGap ${fmt(maxGap)} ms\n`);
	}

	// ③ 完整索引（批循环让出 + 热路径异步读 + 流式序列化）；--repeat 时连续构建以识别一次性预热
	for (let round = 1; round <= repeatCount; round++) {
		const probe = startProbe();
		const t0 = Date.now();
		tracer.reset();
		const index = await ensureProjectIndex(true);
		const elapsed = Date.now() - t0;
		const { ticks, maxGap, maxGapAtMs } = probe.stop();
		const indexed = index?.files ? Object.keys(index.files).length : 0;
		console.log(`[测量] ensureProjectIndex(force=true)（完整索引${repeatCount > 1 ? ` · 第 ${round}/${repeatCount} 轮` : ''}）`);
		console.log(`   索引 ${indexed} 个文件 · 耗时 ${elapsed} ms · ticks ${ticks} · maxGap ${fmt(maxGap)} ms（出现在 ${fmt(maxGapAtMs)} ms，即 ${fmt(maxGapAtMs / Math.max(elapsed, 1) * 100, 0)}% 处）`);
		if (traceEnabled) {
			console.log(`   [--trace] 期间耗时 ≥20ms 的同步操作（共 ${tracer.hits.length} 条，按时间序）：`);
			for (const hit of tracer.hits.slice(0, 25)) {
				console.log(`      ${hit}`);
			}
		}

		// 归因与正确性校验只在最后一轮做（隔离实验会额外写 59MB，避免每轮重复）
		if (round !== repeatCount) {
			continue;
		}
		// 归因：saveIndex 内部会对整个索引做 JSON.stringify —— 这是典型的"同步大对象序列化"嫌疑
		if (index) {
			const t1 = Date.now();
			const compact = JSON.stringify(index);
			const t2 = Date.now();
			const pretty = JSON.stringify(index, null, 2);
			const t3 = Date.now();
			console.log(`   [归因] JSON.stringify 紧凑 ${t2 - t1} ms（${fmt(compact.length / 1024 / 1024, 1)} MB）/ 缩进 ${t3 - t2} ms（${fmt(pretty.length / 1024 / 1024, 1)} MB）`);
			const heap = process.memoryUsage();
			console.log(`   [归因] 本次进程堆占用 ${fmt(heap.heapUsed / 1024 / 1024, 0)} MB（峰值 RSS ${fmt(heap.rss / 1024 / 1024, 0)} MB）`);
			if (typeof globalThis.gc === 'function') {
				const g0 = Date.now();
				globalThis.gc();
				console.log(`   [归因] 一次完整 GC 耗时 ${Date.now() - g0} ms（若与 maxGap 同量级，说明末尾阻塞主要是 GC 而非 IO）`);
				console.log(`   [归因] GC 后堆 ${fmt(process.memoryUsage().heapUsed / 1024 / 1024, 0)} MB`);
			} else {
				console.log('   [归因] 未开启 --expose-gc；想区分「写盘」与「GC」，请用：node --expose-gc scripts/measure-index-perf.mjs …');
			}

			// 隔离实验：单独复现「把索引 JSON 落盘」这一步（stringify + 分块异步写）
			{
				const sidePath = join(persistentDir ?? workspace, '.kodrix', 'index-probe.json');
				const probe2 = startProbe();
				const i0 = Date.now();
				const json = JSON.stringify(index, null, 2);
				const stringifyMs = Date.now() - i0;
				const ws = createWriteStream(sidePath, { encoding: 'utf-8' });
				for (let offset = 0; offset < json.length; offset += ASYNC_WRITE_CHUNK) {
					if (!ws.write(json.slice(offset, offset + ASYNC_WRITE_CHUNK))) {
						await new Promise(resolve => ws.once('drain', () => resolve()));
					}
					await new Promise(resolve => setImmediate(resolve));
				}
				await new Promise((resolve, reject) => ws.end(err => (err ? reject(err) : resolve())));
				const totalMs = Date.now() - i0;
				const { maxGap: gap2, maxGapAtMs: at2 } = probe2.stop();
				console.log(`   [隔离] 索引落盘单独复现：stringify ${stringifyMs} ms + 分块写 共 ${totalMs} ms · maxGap ${fmt(gap2)} ms（${fmt(at2)} ms 处）`);
			}

			// 正确性：把产品实际写出的索引读回来，与内存中的索引逐项比对
			// （流式序列化必须与 JSON.stringify(index) 等价，否则索引会在下次启动时损坏）
			{
				const kodrixDir = join(persistentDir ?? workspace, '.kodrix');
				const candidates = [];
				const walkJson = dir => {
					if (!existsSync(dir)) { return; }
					for (const entry of readdirSync(dir, { withFileTypes: true })) {
						const full = join(dir, entry.name);
						if (entry.isDirectory()) { walkJson(full); }
						// 排除本脚本 --trace 隔离实验写出的探针文件
						else if (entry.name.endsWith('.json') && entry.name !== 'index-probe.json') { candidates.push(full); }
					}
				};
				walkJson(kodrixDir);
				const biggest = candidates
					.map(p => ({ p, size: statSync(p).size }))
					.filter(c => {
						try { return typeof JSON.parse(readFileSync(c.p, 'utf-8')).files === 'object'; } catch { return false; }
					})
					.sort((a, b) => b.size - a.size)[0];
				if (!biggest) {
					console.log('   [校验] 未找到落盘索引，跳过等价性比对');
				} else {
					const parsed = JSON.parse(readFileSync(biggest.p, 'utf-8'));
					const sameFiles = Object.keys(parsed.files ?? {}).length === Object.keys(index.files ?? {}).length;
					const sameStats = parsed.stats?.totalSymbols === index.stats?.totalSymbols
						&& parsed.stats?.totalImports === index.stats?.totalImports
						&& parsed.stats?.totalCalls === index.stats?.totalCalls;
					const sameSymbols = Object.keys(parsed.symbols ?? {}).length === Object.keys(index.symbols ?? {}).length;
					console.log(`   [校验] 落盘索引 ${(biggest.size / 1024 / 1024).toFixed(1)} MB · 解析成功 ✓ · 文件数一致 ${sameFiles} · 符号数一致 ${sameSymbols} · 统计一致 ${sameStats}`);
				}
			}
		}
		console.log('');

		const verdict = maxGap > 100
			? '⚠ maxGap > 100ms：用户可感知卡顿，建议继续推进同步读异步化（需改公开签名）'
			: maxGap > 50
				? '△ maxGap 50–100ms：接近可感知阈值，建议在大仓（>2 万文件）复测后再决定'
				: '✓ maxGap ≤ 50ms：当前让出策略足够，暂不需要继续异步化';
		console.log(`结论：${verdict}`);
		console.log('（提示：把 --files/--dirs 放大到接近真实仓库规模，数据才有决策价值）');
	}
} finally {
	if (!persistentDir) {
		rmSync(workspace, { recursive: true, force: true });
	} else {
		console.log(`（--dir 模式：保留工作区 ${workspace} 以便热态复测；不需要时手动删除）`);
	}
}
