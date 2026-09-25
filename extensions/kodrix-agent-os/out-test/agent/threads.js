"use strict";
/*---------------------------------------------------------------------------------------------
 *  会话 Threads（对标 Cursor 会话树 / 分支 / 命名 / 搜索）
 *
 *  会话模型：.kodrix/agent-runs/<id>.json 即一个会话节点
 *    - name：会话名（默认任务前 40 字，可重命名）
 *    - parentId：续聊来源节点 → 天然形成【树 + 分支】（同一节点续聊多次即分支）
 *    - createdAt / status / mode（act | plan）
 *
 *  纯数据 + 命令模块，不依赖 agentLoop（agentLoop → threads 单向引用，无循环依赖）。
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
exports.loadRuns = loadRuns;
exports.buildThreadTree = buildThreadTree;
exports.registerThreads = registerThreads;
exports.pickRun = pickRun;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const constants_1 = require("../shared/constants");
// ── 数据加载 ───────────────────────────────────────────────────
/** 读取全部会话记录（兼容旧 JSON：缺 name/parentId/createdAt 时兜底） */
function loadRuns(runDir) {
    if (!fs.existsSync(runDir))
        return [];
    const runs = [];
    for (const f of fs.readdirSync(runDir)) {
        if (!f.endsWith('.json'))
            continue;
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf-8'));
            const r = raw;
            runs.push({
                id: r.id,
                name: r.name ?? r.task.slice(0, 40),
                task: r.task,
                parentId: r.parentId,
                mode: r.mode,
                createdAt: r.createdAt ?? parseDateFromId(r.id),
                status: r.status ?? r.result?.status ?? 'unknown',
                result: r.result,
            });
        }
        catch { /* 坏 JSON 跳过 */ }
    }
    return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
/** 从 run-<ISO>.json 文件名解析时间兜底 */
function parseDateFromId(id) {
    const m = /run-(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})/.exec(id);
    return m ? `${m[1]} ${m[2].replace(/-/g, ':')}` : 'unknown';
}
// ── 树构建 ─────────────────────────────────────────────────────
/** 按 parentId 建树（平铺列表带 depth/path，供 QuickPick 缩进展示） */
function buildThreadTree(runs) {
    const byId = new Map();
    for (const r of runs)
        byId.set(r.id, r);
    const childrenOf = new Map();
    for (const r of runs) {
        const p = r.parentId && byId.has(r.parentId) ? r.parentId : '';
        if (!childrenOf.has(p))
            childrenOf.set(p, []);
        childrenOf.get(p).push(r);
    }
    function build(parent, depth, prefix) {
        const kids = childrenOf.get(parent) ?? [];
        const out = [];
        kids.forEach((k, i) => {
            const p = prefix ? `${prefix}.${i + 1}` : String(i + 1);
            const node = { record: k, depth, path: p, children: build(k.id, depth + 1, p) };
            out.push(node);
        });
        return out;
    }
    return build('', 0, '');
}
// ── 命令 ───────────────────────────────────────────────────────
function registerThreads(context) {
    context.subscriptions.push(
    // 会话树浏览：树状缩进 QuickPick → 打开记录
    vscode.commands.registerCommand(constants_1.COMMANDS.threadsTree, async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder)
            return;
        const runDir = path.join(folder.uri.fsPath, constants_1.WORKSPACE_KODRIX_DIR, constants_1.AGENT_RUNS_DIR);
        const nodes = buildThreadTree(loadRuns(runDir));
        if (!nodes.length) {
            void vscode.window.showInformationMessage('暂无会话记录（先运行 Agent 任务）');
            return;
        }
        const flat = [];
        (function walk(ns) { for (const n of ns) {
            flat.push(n);
            walk(n.children);
        } })(nodes);
        const picked = await vscode.window.showQuickPick(flat.map(n => ({
            label: `${'　'.repeat(n.depth)}${n.depth ? '└ ' : '● '}${n.record.name}`,
            detail: `#${n.path} · ${n.record.status} · ${n.record.mode ?? 'act'} · ${n.record.createdAt}`,
            description: n.children.length ? `⤷ ${n.children.length} 个子会话` : undefined,
            node: n,
        })), { placeHolder: '会话树（缩进为层级，数字为路径）— 选择打开记录' });
        if (!picked)
            return;
        await openRun(runDir, picked.node.record);
    }), 
    // 命名：重命名会话
    vscode.commands.registerCommand(constants_1.COMMANDS.threadsRename, async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder)
            return;
        const runDir = path.join(folder.uri.fsPath, constants_1.WORKSPACE_KODRIX_DIR, constants_1.AGENT_RUNS_DIR);
        const runs = loadRuns(runDir);
        if (!runs.length) {
            void vscode.window.showInformationMessage('暂无会话记录');
            return;
        }
        const picked = await pickRun(runs, '选择要命名的会话');
        if (!picked)
            return;
        const name = await vscode.window.showInputBox({ prompt: '会话新名称', value: picked.name });
        if (name === undefined)
            return;
        const jsonPath = path.join(runDir, `${picked.id}.json`);
        try {
            const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            raw.name = name.trim() || picked.name;
            fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), 'utf-8');
            void vscode.window.showInformationMessage(`会话已命名：${raw.name}`);
        }
        catch {
            void vscode.window.showErrorMessage('会话文件无效，无法重命名');
        }
    }), 
    // 搜索：按名称/任务/输出全文搜索会话
    vscode.commands.registerCommand(constants_1.COMMANDS.threadsSearch, async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder)
            return;
        const runDir = path.join(folder.uri.fsPath, constants_1.WORKSPACE_KODRIX_DIR, constants_1.AGENT_RUNS_DIR);
        const runs = loadRuns(runDir);
        if (!runs.length) {
            void vscode.window.showInformationMessage('暂无会话记录');
            return;
        }
        const keyword = await vscode.window.showInputBox({ prompt: '搜索会话（匹配名称 / 任务 / 输出内容）', placeHolder: '例如：限流 或 checkpoint' });
        if (!keyword)
            return;
        const k = keyword.toLowerCase();
        const hits = runs.filter(r => r.name.toLowerCase().includes(k)
            || r.task.toLowerCase().includes(k)
            || String(r.result?.output ?? '').toLowerCase().includes(k));
        if (!hits.length) {
            void vscode.window.showInformationMessage(`未找到包含「${keyword}」的会话`);
            return;
        }
        const picked = await pickRun(hits, `找到 ${hits.length} 个会话（${keyword}）— 选择打开`);
        if (!picked)
            return;
        await openRun(runDir, picked);
    }));
}
// ── 内部 ───────────────────────────────────────────────────────
async function pickRun(runs, placeHolder) {
    const byId = new Map(runs.map(r => [r.id, r]));
    const roots = buildThreadTree(runs);
    const flat = [];
    (function walk(ns) { for (const n of ns) {
        flat.push(n);
        walk(n.children);
    } })(roots);
    const picked = await vscode.window.showQuickPick(flat.map(n => ({
        label: `${'　'.repeat(n.depth)}${n.depth ? '└ ' : '● '}${n.record.name}`,
        detail: `#${n.path} · ${n.record.status} · ${n.record.mode ?? 'act'} · ${n.record.createdAt}`,
        description: n.children.length ? `⤷ ${n.children.length} 个子会话` : undefined,
        id: n.record.id,
    })), { placeHolder });
    return picked ? byId.get(picked.id) : undefined;
}
async function openRun(runDir, record) {
    const mdPath = path.join(runDir, `${record.id}.md`);
    if (!fs.existsSync(mdPath)) {
        void vscode.window.showWarningMessage(`记录 ${record.id} 无 Markdown 文件（仅 JSON 元数据）`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(mdPath);
    await vscode.window.showTextDocument(doc, { preview: false });
}
