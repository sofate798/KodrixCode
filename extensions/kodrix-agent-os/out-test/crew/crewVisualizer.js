"use strict";
/*---------------------------------------------------------------------------------------------
 *  Crew Visualizer — 可视化 Agent 编排 DAG（对标 Cursor 的 Agent 执行可视化）
 *
 *  能力：
 *    1. 将 Crew 的任务依赖关系渲染为自包含 HTML（内联 CSS + SVG），无外部依赖、离线可开
 *    2. 拓扑分层布局：任务按最长依赖深度分列，依赖边带箭头
 *    3. 状态着色：completed 绿 / running 蓝 / failed 红 / blocked 橙 / pending 灰
 *    4. 命令「Kodrix: 可视化 Agent 编排」：选择 .kodrix/crews/*.json → 浏览器/预览查看
 *--------------------------------------------------------------------------------------------*/
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeLayers = computeLayers;
exports.layoutNodes = layoutNodes;
exports.renderCrewDagHtml = renderCrewDagHtml;
exports.renderCrewFileToHtml = renderCrewFileToHtml;
exports.registerCrewVisualizer = registerCrewVisualizer;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
/** 状态 → 颜色 */
const STATUS_COLORS = {
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
function computeLayers(tasks) {
    const depth = new Map();
    const byId = new Map(tasks.map(t => [t.id, t]));
    const visit = (id, seen) => {
        if (depth.has(id)) {
            return depth.get(id);
        }
        if (seen.has(id)) {
            return 0; // 环保护
        }
        const task = byId.get(id);
        if (!task || !task.dependencies.length) {
            depth.set(id, 0);
            return 0;
        }
        seen.add(id);
        let maxDep = -1;
        for (const depId of task.dependencies) {
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
function layoutNodes(tasks, layers) {
    const byLayer = new Map();
    for (const t of tasks) {
        const layer = layers.get(t.id) ?? 0;
        const arr = byLayer.get(layer) ?? [];
        arr.push(t.id);
        byLayer.set(layer, arr);
    }
    const pos = new Map();
    for (const [layer, ids] of byLayer) {
        const count = ids.length;
        const startY = (count - 1) * (NODE_H + V_GAP) / 2;
        ids.forEach((id, idx) => {
            pos.set(id, { x: layer * (NODE_W + H_GAP), y: startY + idx * (NODE_H + V_GAP), layer });
        });
    }
    return pos;
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** 渲染 Crew DAG 为自包含 HTML（纯函数） */
function renderCrewDagHtml(crew) {
    const layers = computeLayers(crew.tasks);
    const pos = layoutNodes(crew.tasks, layers);
    const maxLayer = Math.max(0, ...crew.tasks.map(t => layers.get(t.id) ?? 0));
    const maxCol = Math.max(0, ...crew.tasks.map(t => (pos.get(t.id)?.y ?? 0) + NODE_H));
    const width = (maxLayer + 1) * (NODE_W + H_GAP) + 20;
    const height = maxCol + 20;
    // 边（依赖 → 任务）
    const edges = [];
    for (const t of crew.tasks) {
        const to = pos.get(t.id);
        if (!to) {
            continue;
        }
        for (const depId of t.dependencies) {
            const from = pos.get(depId);
            if (!from) {
                continue;
            }
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            edges.push(`<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="#555" stroke-width="1.5" marker-end="url(#arrow)"/>`);
        }
    }
    // 节点
    const nodes = crew.tasks.map(t => {
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
	<h1>Crew「${escapeHtml(crew.name)}」— Agent 编排 DAG</h1>
	<div class="sub">共 ${crew.tasks.length} 个任务 · 依赖边 → 表示前置 · 状态着色见图例（对标 Cursor Agent 执行可视化）</div>
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
async function renderCrewFileToHtml(crewPath) {
    try {
        const raw = fs.readFileSync(crewPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return renderCrewDagHtml(parsed);
    }
    catch (err) {
        logger_1.logger.error('[CrewVisualizer] 读取 Crew 失败', err);
        return undefined;
    }
}
/** 注册可视化命令 */
function registerCrewVisualizer(context) {
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.crewVisualize, async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            await vscode.window.showErrorMessage(vscode_1.l10n.t('请先打开工作区'));
            return;
        }
        const crewsDir = path.join(folder.uri.fsPath, constants_1.WORKSPACE_KODRIX_DIR, 'crews');
        if (!fs.existsSync(crewsDir)) {
            await vscode.window.showInformationMessage(vscode_1.l10n.t('尚未创建 Crew（.kodrix/crews/）。可先通过「Kodrix: 新建 Agent Crew」创建。'));
            return;
        }
        const files = fs.readdirSync(crewsDir).filter(f => f.endsWith('.json'));
        if (!files.length) {
            await vscode.window.showInformationMessage(vscode_1.l10n.t('.kodrix/crews/ 下没有 Crew 文件'));
            return;
        }
        const picked = await vscode.window.showQuickPick(files, { placeHolder: vscode_1.l10n.t('选择要可视化的 Crew 文件') });
        if (!picked) {
            return;
        }
        const html = await renderCrewFileToHtml(path.join(crewsDir, picked));
        if (!html) {
            await vscode.window.showErrorMessage(vscode_1.l10n.t('Crew 文件解析失败'));
            return;
        }
        const doc = await vscode.workspace.openTextDocument({ content: html, language: 'html' });
        await vscode.window.showTextDocument(doc, { preview: true });
    }));
}
