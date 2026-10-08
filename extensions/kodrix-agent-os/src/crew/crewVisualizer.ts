/*---------------------------------------------------------------------------------------------
 *  Crew Visualizer — 可视化 Agent 编排 DAG（对标 Cursor 的 Agent 执行可视化）
 *
 *  能力：
 *    1. 将 Crew 的任务依赖关系渲染为自包含 HTML（内联 CSS + SVG），无外部依赖、离线可开
 *    2. 拓扑分层布局：任务按最长依赖深度分列，依赖边带箭头
 *    3. 状态着色：completed 绿 / running 蓝 / failed 红 / blocked 橙 / pending 灰
 *    4. 命令「Kodrix: 可视化 Agent 编排」：选择 .kodrix/crews/*.json → 浏览器/预览查看
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import { COMMANDS, WORKSPACE_KODRIX_DIR } from '../shared/constants';

/** 可视化用任务（与 CrewConfig 结构兼容的轻量接口，保持模块可独立测试） */
export interface VizTask {
	id: string;
	title: string;
	assignedRole: string;
	status: string;
	dependencies: string[];
}

/** 可视化用 Crew */
export interface VizCrew {
	name: string;
	tasks: VizTask[];
}

/** 状态 → 颜色 */
const STATUS_COLORS: Record<string, string> = {
	completed: '#4caf50',
	running: '#2196f3',
	failed: '#f44336',
	blocked: '#ff9800',
	pending: '#9e9e9e',
};

const NODE_W = 230;
const NODE_H = 58;
const H_GAP = 70;
const V_GAP = 28;

/** 计算每个任务的最长依赖深度（拓扑层） */
export function computeLayers(tasks: VizTask[]): Map<string, number> {
	const depth = new Map<string, number>();
	const byId = new Map(tasks.map(t => [t.id, t]));

	const visit = (id: string, seen: Set<string>): number => {
		if (depth.has(id)) {
			return depth.get(id)!;
		}
		if (seen.has(id)) {
			return 0; // 环保护
		}
		const task = byId.get(id);
		// 兼容手工编辑过的 crew.json：缺 dependencies 时按"无前置"处理，而不是抛错导致整页渲染失败
		const deps = task?.dependencies ?? [];
		if (!task || !deps.length) {
			depth.set(id, 0);
			return 0;
		}
		seen.add(id);
		let maxDep = -1;
		for (const depId of deps) {
			maxDep = Math.max(maxDep, visit(depId, seen));
		}
		seen.delete(id);
		const d = maxDep + 1;
		depth.set(id, d);
		return d;
	};

	for (const t of tasks) {
		visit(t.id, new Set());
	}
	return depth;
}

/** 按层分配行列坐标 */
export function layoutNodes(tasks: VizTask[], layers: Map<string, number>): Map<string, { x: number; y: number; layer: number }> {
	const byLayer = new Map<number, string[]>();
	for (const t of tasks) {
		const layer = layers.get(t.id) ?? 0;
		const arr = byLayer.get(layer) ?? [];
		arr.push(t.id);
		byLayer.set(layer, arr);
	}
	const pos = new Map<string, { x: number; y: number; layer: number }>();
	for (const [layer, ids] of byLayer) {
		const count = ids.length;
		const startY = (count - 1) * (NODE_H + V_GAP) / 2;
		ids.forEach((id, idx) => {
			pos.set(id, { x: layer * (NODE_W + H_GAP), y: startY + idx * (NODE_H + V_GAP), layer });
		});
	}
	return pos;
}

function escapeHtml(s: string | undefined | null): string {
	// 手工编辑过的 crew.json 可能缺 description 等字段：容错成空串而不是整页渲染失败
	return String(s ?? '')
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 渲染 Crew DAG 为自包含 HTML（纯函数） */
export function renderCrewDagHtml(crew: VizCrew): string {
	// 容错：crew.json 允许被手工编辑，缺 tasks 时渲染空图而不是抛错
	const tasks: VizTask[] = crew.tasks ?? [];
	const layers = computeLayers(tasks);
	const pos = layoutNodes(tasks, layers);
	const maxLayer = Math.max(0, ...tasks.map(t => layers.get(t.id) ?? 0));
	const maxCol = Math.max(0, ...tasks.map(t => (pos.get(t.id)?.y ?? 0) + NODE_H));
	const width = (maxLayer + 1) * (NODE_W + H_GAP) + 20;
	const height = maxCol + 20;

	// 边（依赖 → 任务）
	const edges: string[] = [];
	for (const t of tasks) {
		const to = pos.get(t.id);
		if (!to) {
			continue;
		}
		for (const depId of t.dependencies ?? []) {
			const from = pos.get(depId);
			if (!from) {
				continue;
			}
			const x1 = from.x + NODE_W;
			const y1 = from.y + NODE_H / 2;
			const x2 = to.x;
			const y2 = to.y + NODE_H / 2;
			const mx = (x1 + x2) / 2;
			edges.push(
				`<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="#555" stroke-width="1.5" marker-end="url(#arrow)"/>`,
			);
		}
	}

	// 节点
	const nodes = tasks.map(t => {
		const p = pos.get(t.id);
		if (!p) {
			return '';
		}
		const color = STATUS_COLORS[t.status] ?? STATUS_COLORS.pending;
		return `<g>
			<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="#1e2430" stroke="${color}" stroke-width="2"/>
			<text x="${p.x + 12}" y="${p.y + 22}" fill="#e8eaed" font-size="13" font-weight="600" font-family="Segoe UI, sans-serif">${escapeHtml(t.title.slice(0, 28))}</text>
			<text x="${p.x + 12}" y="${p.y + 40}" fill="${color}" font-size="11" font-family="Consolas, monospace">${escapeHtml(t.assignedRole)} · ${escapeHtml(t.status)}</text>
		</g>`;
	}).join('\n');

	const legend = Object.entries(STATUS_COLORS)
		.map(([k, c]) => `<span style="display:inline-flex;align-items:center;margin-right:16px;color:#c9cdd3;"><i style="width:10px;height:10px;border-radius:2px;background:${c};display:inline-block;margin-right:6px;"></i>${k}</span>`)
		.join('');

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>Kodrix Crew DAG — ${escapeHtml(crew.name)}</title>
<style>
	body { background:#12151c; color:#e8eaed; font-family:Segoe UI, "Microsoft YaHei", sans-serif; margin:0; padding:24px; }
	h1 { font-size:18px; font-weight:600; margin:0 0 4px; }
	.sub { color:#8b919c; font-size:12px; margin-bottom:16px; }
	.legend { margin-bottom:16px; }
	svg text { user-select:none; }
</style>
</head>
<body>
	<h1>${l10n.t('Crew "{0}" — Agent orchestration DAG', escapeHtml(crew.name))}</h1>
	<div class="sub">${l10n.t('{0} tasks in total · dependency arrows point from prerequisite to task · status colors follow the legend (comparable to Cursor agent execution visualization)', tasks.length)}</div>
	<div class="legend">${legend}</div>
	<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
		<defs>
			<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
				<path d="M0,0 L8,4 L0,8 z" fill="#888"/>
			</marker>
		</defs>
		${edges.join('\n')}
		${nodes}
	</svg>
</body>
</html>`;
}

/** 读取并渲染工作区 Crew 文件 */
export async function renderCrewFileToHtml(crewPath: string): Promise<string | undefined> {
	try {
		const raw = fs.readFileSync(crewPath, 'utf-8');
		const parsed = JSON.parse(raw) as VizCrew;
		return renderCrewDagHtml(parsed);
	} catch (err) {
		logger.error('[CrewVisualizer] 读取 Crew 失败', err);
		return undefined;
	}
}

/** 注册可视化命令 */
export function registerCrewVisualizer(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.crewVisualize, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				await vscode.window.showErrorMessage(l10n.t('Please open a workspace first'));
				return;
			}
			// 实际数据位置：Crew 写入的是 `.kodrix/crew.json`（单文件）；
			// 此前只扫 `.kodrix/crews/`，导致刚建完 Crew 打开可视化仍报"尚未创建 Crew"（功能等于不存在）。
			const candidates: string[] = [];
			const singleCrew = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, 'crew.json');
			if (fs.existsSync(singleCrew)) {
				candidates.push(singleCrew);
			}
			// 兼容旧位置/多 Crew 目录
			const crewsDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, 'crews');
			if (fs.existsSync(crewsDir)) {
				for (const f of fs.readdirSync(crewsDir).filter(f => f.endsWith('.json'))) {
					candidates.push(path.join(crewsDir, f));
				}
			}
			if (!candidates.length) {
				await vscode.window.showInformationMessage(l10n.t('No Crew created yet (.kodrix/crew.json). Create one via "Kodrix: New Agent Crew" first.'));
				return;
			}
			let crewPath = candidates[0];
			if (candidates.length > 1) {
				const picked = await vscode.window.showQuickPick(
					candidates.map(c => path.relative(folder.uri.fsPath, c).replace(/\\/g, '/')),
					{ placeHolder: l10n.t('Select a Crew file to visualize') },
				);
				if (!picked) {
					return;
				}
				crewPath = path.join(folder.uri.fsPath, picked);
			}
			const html = await renderCrewFileToHtml(crewPath);
			if (!html) {
				await vscode.window.showErrorMessage(l10n.t('Failed to parse Crew file'));
				return;
			}
			const doc = await vscode.workspace.openTextDocument({ content: html, language: 'html' });
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
	);
}
