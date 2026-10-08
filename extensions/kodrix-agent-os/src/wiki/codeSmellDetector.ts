/*---------------------------------------------------------------------------------------------
 *  Code Smell Detector — 基于 ProjectIndex 的静态代码异味分析
 *
 *  能力：
 *  1. 过大文件检测（>500 行估算）
 *  2. 高耦合文件检测（依赖数 > 15）
 *  3. 循环依赖检测（DFS）
 *  4. 未使用导出检测（导出符号无反向依赖）
 *  5. 过长函数检测（>200 行）
 *  6. 生成 CODE_SMELLS.md 报告
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { l10n } from 'vscode';
import { SymbolKind, type ProjectIndex } from '../codebase/types';
import { logger } from '../logger';

/** 单个 Code Smell 记录 */
export interface CodeSmell {
	file: string;
	type: 'long_function' | 'unused_export' | 'circular_dep' | 'large_file' | 'high_coupling';
	severity: 'warning' | 'info';
	message: string;
	line?: number;
}

/** 估算行数的平均字节/行 */
const AVG_BYTES_PER_LINE = 45;
/** 过大文件阈值（估算行数） */
const LARGE_FILE_LINE_THRESHOLD = 500;
/** 高耦合阈值（依赖文件数） */
const HIGH_COUPLING_THRESHOLD = 15;
/** 未使用导出的最低导出数阈值 */
const UNUSED_EXPORT_THRESHOLD = 2;
/** 过长函数阈值（行数） */
const LONG_FUNCTION_THRESHOLD = 200;

/**
 * 基于 ProjectIndex 数据检测 Code Smell。
 */
export async function detectCodeSmells(
	workspaceRoot: string,
	getIndex: () => Promise<ProjectIndex | undefined>,
): Promise<CodeSmell[]> {
	let index: ProjectIndex | undefined;
	try {
		index = await getIndex();
	} catch (err) {
		logger.warn(`[CodeSmellDetector] Failed to get project index: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
	if (!index) {
		return [];
	}

	const smells: CodeSmell[] = [];

	// 1. 过大文件（估算行数 > 500）
	for (const [filePath, summary] of Object.entries(index.files)) {
		const estimatedLines = Math.round(summary.sizeBytes / AVG_BYTES_PER_LINE);
		if (estimatedLines > LARGE_FILE_LINE_THRESHOLD) {
			const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
			smells.push({
				file: relPath,
				type: 'large_file',
				severity: 'warning',
				message: l10n.t('File too large: about {0} lines ({1} bytes)', estimatedLines, summary.sizeBytes),
			});
		}
	}

	// 2. 高耦合文件（依赖数 > 15）
	const depGraph = index.dependencyGraph;
	for (const [filePath, deps] of Object.entries(depGraph)) {
		if (deps.length > HIGH_COUPLING_THRESHOLD) {
			const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
			smells.push({
				file: relPath,
				type: 'high_coupling',
				severity: 'warning',
				message: l10n.t('Highly coupled: depends on {0} files', deps.length),
			});
		}
	}

	// 3. 循环依赖检测（DFS）
	// visited 必须**每个起点重置**：此前是全局共享的 Set，第一个根遍历过的节点在后续根的
	// DFS 里会立刻返回空，导致"除首批可达节点外"的环全部漏报。
	const inStack = new Set<string>();

	function dfs(node: string, pathSoFar: string[], visited: Set<string>): string[][] {
		if (inStack.has(node)) {
			const cycleStart = pathSoFar.indexOf(node);
			return [pathSoFar.slice(cycleStart).concat(node)];
		}
		if (visited.has(node)) {
			return [];
		}
		visited.add(node);
		inStack.add(node);
		const cycles: string[][] = [];
		for (const dep of (depGraph[node] || [])) {
			cycles.push(...dfs(dep, [...pathSoFar, node], visited));
		}
		inStack.delete(node);
		return cycles;
	}

	/**
	 * 环的规范化：按**旋转**归一（固定从字典序最小的节点开始），保留遍历顺序。
	 * 此前用 `sort().join('|')`，会把共享同一批节点但顺序不同的环合并成一个（漏报）。
	 */
	const canonicalCycle = (cycle: string[]): string => {
		const nodes = cycle.slice(0, -1); // 去掉收尾处重复的起点
		if (!nodes.length) {return '';}
		let minIdx = 0;
		for (let i = 1; i < nodes.length; i++) {
			if (nodes[i] < nodes[minIdx]) {minIdx = i;}
		}
		return [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)].join('|');
	};

	const reportedCycles = new Set<string>();
	const MAX_REPORTED_CYCLES = 50;
	for (const file of Object.keys(depGraph)) {
		if (reportedCycles.size >= MAX_REPORTED_CYCLES) {break;}
		// 每个起点一份 visited（局部传播），inStack 仍然全局但成对增删，不会跨起点残留
		const cycles = dfs(file, [], new Set<string>());
		for (const cycle of cycles) {
			const key = canonicalCycle(cycle);
			if (!key || reportedCycles.has(key)) {continue;}
			reportedCycles.add(key);
			const relCycle = cycle.map(f => path.relative(workspaceRoot, f).replace(/\\/g, '/'));
			smells.push({
				file: relCycle[0],
				type: 'circular_dep',
				severity: 'warning',
				message: l10n.t('Circular dependencies: {0}', relCycle.join(' → ')),
			});
			if (reportedCycles.size >= MAX_REPORTED_CYCLES) {break;}
		}
	}

	// 4. 未使用导出（导出符号无反向依赖）
	const revDepGraph = index.reverseDependencyGraph;
	for (const [filePath, summary] of Object.entries(index.files)) {
		if (summary.exportCount > UNUSED_EXPORT_THRESHOLD) {
			const reverseDeps = revDepGraph[filePath] || [];
			if (reverseDeps.length === 0) {
				const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
				smells.push({
					file: relPath,
					type: 'unused_export',
					severity: 'info',
					message: l10n.t('{0} exported symbols are not referenced by other files', summary.exportCount),
				});
			}
		}
	}

	// 5. 过长函数检测（>200 行）
	for (const sym of Object.values(index.symbols)) {
		if ((sym.kind === SymbolKind.Function || sym.kind === SymbolKind.Method) && sym.endLine !== undefined) {
			const length = sym.endLine - sym.line;
			if (length > LONG_FUNCTION_THRESHOLD) {
				const relPath = path.relative(workspaceRoot, sym.filePath).replace(/\\/g, '/');
				smells.push({
					type: 'long_function',
					file: relPath,
					line: sym.line,
					message: l10n.t('Function {0} is too long ({1} lines, threshold {2})', sym.name, length, LONG_FUNCTION_THRESHOLD),
					severity: 'warning',
				});
			}
		}
	}

	return smells;
}

/** Code Smell 类型的中文标签 */
function smellTypeLabel(type: CodeSmell['type']): string {
	switch (type) {
		case 'large_file': return l10n.t('Oversized files');
		case 'high_coupling': return l10n.t('High coupling');
		case 'circular_dep': return l10n.t('Circular dependencies');
		case 'unused_export': return l10n.t('Unused exports');
		case 'long_function': return l10n.t('Overly long functions');
	}
}

/**
 * 生成 CODE_SMELLS.md 报告。
 */
export function renderCodeSmellsReport(smells: CodeSmell[], _workspaceRoot: string): string {
	if (smells.length === 0) {
		return `# Code Smells 报告

> 由 Kodrix Code Smell Detector 自动生成 · ${new Date().toISOString().slice(0, 10)}

## 结果

✅ 未检测到明显的 Code Smell。
`;
	}

	// 按类型分组
	const grouped = new Map<CodeSmell['type'], CodeSmell[]>();
	for (const smell of smells) {
		if (!grouped.has(smell.type)) {
			grouped.set(smell.type, []);
		}
		grouped.get(smell.type)!.push(smell);
	}

	const warningCount = smells.filter(s => s.severity === 'warning').length;
	const infoCount = smells.filter(s => s.severity === 'info').length;

	let md = `# Code Smells 报告

> 由 Kodrix Code Smell Detector 自动生成 · ${new Date().toISOString().slice(0, 10)}

## 概览

| 指标 | 值 |
|------|-----|
| 总计 | ${smells.length} |
| 警告 | ${warningCount} |
| 提示 | ${infoCount} |

`;

	// 按类型输出
	const typeOrder: CodeSmell['type'][] = ['circular_dep', 'high_coupling', 'large_file', 'unused_export', 'long_function'];
	for (const type of typeOrder) {
		const items = grouped.get(type);
		if (!items || items.length === 0) {
			continue;
		}
		md += `## ${smellTypeLabel(type)}（${items.length}）\n\n`;
		md += `| 文件 | 严重度 | 说明 |\n`;
		md += `|------|--------|------|\n`;
		for (const item of items) {
			const severityIcon = item.severity === 'warning' ? '⚠️' : 'ℹ️';
			md += `| \`${item.file}\` | ${severityIcon} | ${item.message} |\n`;
		}
		md += '\n';
	}

	md += `## 建议

- **循环依赖**：考虑提取公共模块或引入中间层解耦
- **高耦合**：拆分职责，减少单文件依赖数量
- **过大文件**：按功能模块拆分为更小的文件
- **未使用导出**：清理无用导出或检查是否有外部消费者
- **过长函数**：拆分为更小的、职责单一的子函数
`;

	return md;
}
