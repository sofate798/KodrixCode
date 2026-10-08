"use strict";
/*---------------------------------------------------------------------------------------------
 *  Apply Manager — 多文件变更提案 + diff 确认（对标 Cursor 多文件 Apply / diff 视图）
 *
 *  能力：
 *    1. 变更提案（FileChange[]）：write（新建/覆盖）/ edit（精确替换）/ delete，含变更原因
 *    2. 行级 LCS diff 引擎：生成 统一 diff（unified diff），供用户逐文件审查
 *    3. 应用前自动 Checkpoint（可回滚）+ 原始文件备份（.kodrix/apply-backups/）
 *    4. 校验：edit 的 oldContent 必须精确匹配，路径必须工作区内
 *    5. 与 Agent 推理循环闭环：Agent 产出提案（propose_changes）→ 用户预览 diff → 确认应用
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
exports.diffLines = diffLines;
exports.renderUnifiedDiff = renderUnifiedDiff;
exports.getApplyDir = getApplyDir;
exports.listProposals = listProposals;
exports.loadProposal = loadProposal;
exports.saveProposal = saveProposal;
exports.validateChange = validateChange;
exports.applyProposal = applyProposal;
exports.stageProposal = stageProposal;
exports.renderProposalMarkdown = renderProposalMarkdown;
exports.registerApplyManager = registerApplyManager;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
/** DP 单元上限（约 8MB 整数数组），超过则降级为全删+全增，避免 O(n×m) 内存爆炸 */
const DIFF_DP_CELL_LIMIT = 2_000_000;
/** 行级 LCS diff：返回操作序列（逐行） */
function diffLines(oldText, newText) {
    const a = oldText.split(/\r?\n/);
    const b = newText.split(/\r?\n/);
    const n = a.length;
    const m = b.length;
    // 空文本边界：旧为空 → 全新增；新为空 → 全删除
    const oldEmpty = n === 1 && a[0] === '';
    const newEmpty = m === 1 && b[0] === '';
    if (oldEmpty && !newEmpty) {
        return b.map(text => ({ type: 'add', text }));
    }
    if (newEmpty && !oldEmpty) {
        return a.map(text => ({ type: 'del', text }));
    }
    if (oldEmpty && newEmpty) {
        return [];
    }
    // 大文件降级：避免分配上亿整数
    if (n * m > DIFF_DP_CELL_LIMIT) {
        return [
            ...a.map(text => ({ type: 'del', text })),
            ...b.map(text => ({ type: 'add', text })),
        ];
    }
    // DP：dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ type: 'same', text: a[i] });
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ type: 'del', text: a[i] });
            i++;
        }
        else {
            out.push({ type: 'add', text: b[j] });
            j++;
        }
    }
    while (i < n) {
        out.push({ type: 'del', text: a[i++] });
    }
    while (j < m) {
        out.push({ type: 'add', text: b[j++] });
    }
    return out;
}
/** 渲染单文件统一 diff（标准 @@ -start,count +start,count @@ hunk 头） */
function renderUnifiedDiff(filePath, oldText, newText) {
    const a = oldText.split(/\r?\n/);
    const b = newText.split(/\r?\n/);
    const lines = diffLines(oldText, newText);
    const body = lines
        .map(l => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`)
        .join('\n');
    const oldCount = a.length;
    const newCount = b.length;
    return [
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -1,${oldCount} +1,${newCount} @@`,
        body,
    ].join('\n');
}
// ── 提案 I/O ────────────────────────────────────────────────────
/** 提案目录（工作区 .kodrix/apply） */
function getApplyDir(workspace) {
    return path.join(workspace, constants_1.WORKSPACE_KODRIX_DIR, constants_1.APPLY_DIR);
}
/** 列出工作区提案（新→旧） */
function listProposals(workspace) {
    const dir = getApplyDir(workspace);
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
}
/** 读取提案 */
function loadProposal(workspace, name) {
    try {
        const p = path.join(getApplyDir(workspace), name);
        if (!fs.existsSync(p)) {
            return null;
        }
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return raw;
    }
    catch {
        return null;
    }
}
/** 保存提案 */
function saveProposal(workspace, proposal) {
    const dir = getApplyDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${proposal.name}.json`);
    fs.writeFileSync(file, JSON.stringify(proposal, null, 2), 'utf-8');
    return file;
}
// ── 校验与应用 ──────────────────────────────────────────────────
/** 路径解析到工作区内（越界返回 undefined） */
function resolveInWs(rel, workspace) {
    const resolved = path.resolve(workspace, rel);
    const wsNorm = path.normalize(workspace);
    return resolved === wsNorm || resolved.startsWith(wsNorm + path.sep) ? resolved : undefined;
}
/** 校验单条变更 */
function validateChange(change, workspace) {
    const abs = resolveInWs(change.filePath, workspace);
    if (!abs) {
        return { ok: false, error: vscode_1.l10n.t('Path escapes the workspace: {0}', change.filePath) };
    }
    if (!change.filePath.trim()) {
        return { ok: false, error: vscode_1.l10n.t('filePath is empty') };
    }
    if (change.type === 'edit') {
        if (!change.oldContent) {
            return { ok: false, error: vscode_1.l10n.t('edit change is missing oldContent: {0}', change.filePath) };
        }
        if (!fs.existsSync(abs)) {
            return { ok: false, error: vscode_1.l10n.t('File does not exist, cannot edit: {0}', change.filePath) };
        }
        const cur = fs.readFileSync(abs, 'utf-8');
        const count = cur.split(change.oldContent).length - 1;
        if (count === 0) {
            return { ok: false, error: vscode_1.l10n.t('oldContent did not match: {0}', change.filePath) };
        }
        if (count > 1) {
            return { ok: false, error: vscode_1.l10n.t('oldContent matched {0} times (must be unique): {1}', count, change.filePath) };
        }
    }
    if (change.type === 'write' && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        return { ok: false, error: vscode_1.l10n.t('Target is a directory: {0}', change.filePath) };
    }
    if (change.type === 'delete' && !fs.existsSync(abs)) {
        return { ok: false, error: vscode_1.l10n.t('File does not exist, cannot delete: {0}', change.filePath) };
    }
    return { ok: true };
}
/**
 * 应用变更提案：备份 → 逐条应用 → 返回结果。
 * 全部变更先校验（任一失败则整体拒绝，避免部分应用）。
 */
async function applyProposal(proposal, workspace, opts = {}) {
    const checkpoint = opts.checkpoint ?? true;
    const backup = opts.backup ?? true;
    const result = { applied: [], skipped: [] };
    // 0) 前置校验：任一失败整体拒绝（skipped 覆盖全部变更，标明原因）
    const failures = [];
    const alreadyApplied = new Set();
    for (const c of proposal.changes) {
        const v = validateChange(c, workspace);
        if (!v.ok) {
            // 幂等：edit 已应用过（old 不匹配但目标内容已存在）→ 跳过，不视为失败
            if (c.type === 'edit') {
                // 幂等判据：目标内容已存在、旧内容已不在、且新内容足够长（防短子串误判）
                const abs = resolveInWs(c.filePath, workspace);
                const cur = abs && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
                if (c.newContent.length >= 1 && cur.includes(c.newContent) && !cur.includes(c.oldContent)) {
                    alreadyApplied.add(c.filePath);
                    continue;
                }
            }
            failures.push({ filePath: c.filePath, reason: v.error ?? vscode_1.l10n.t('Validation failed') });
        }
    }
    if (failures.length) {
        return {
            applied: [],
            skipped: proposal.changes.map(c => {
                const f = failures.find(x => x.filePath === c.filePath);
                return f ? { filePath: c.filePath, reason: f.reason } : { filePath: c.filePath, reason: vscode_1.l10n.t('Pre-check failed; the whole proposal was rejected (no changes applied)') };
            }),
        };
    }
    // 1) 应用前 Checkpoint（可整体回滚）
    if (checkpoint) {
        try {
            const { createCheckpoint } = require('../checkpoint/checkpointManager');
            const id = await createCheckpoint(`Apply: ${proposal.name}`);
            logger_1.logger.info(`[Apply] 已创建检查点 ${id}`);
        }
        catch (err) {
            logger_1.logger.warn('[Apply] 创建检查点失败（继续）', err);
        }
    }
    // 2) 备份目录
    const backupRoot = backup
        ? path.join(workspace, constants_1.WORKSPACE_KODRIX_DIR, constants_1.APPLY_BACKUP_DIR, `${proposal.name}-${Date.now()}`)
        : undefined;
    for (const c of proposal.changes) {
        if (alreadyApplied.has(c.filePath)) {
            result.skipped.push({ filePath: c.filePath, reason: vscode_1.l10n.t('Already applied (target content already exists)') });
            continue;
        }
        const abs = resolveInWs(c.filePath, workspace);
        if (!abs) {
            result.skipped.push({ filePath: c.filePath, reason: vscode_1.l10n.t('Path escapes the workspace') });
            continue;
        }
        try {
            if (backupRoot && fs.existsSync(abs)) {
                const bkp = path.join(backupRoot, c.filePath);
                fs.mkdirSync(path.dirname(bkp), { recursive: true });
                fs.copyFileSync(abs, bkp);
            }
            if (c.type === 'delete') {
                fs.rmSync(abs, { force: true });
            }
            else {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                if (c.type === 'edit') {
                    const cur = fs.readFileSync(abs, 'utf-8');
                    fs.writeFileSync(abs, cur.replace(c.oldContent, c.newContent), 'utf-8');
                }
                else {
                    fs.writeFileSync(abs, c.newContent, 'utf-8');
                }
            }
            opts.onBeforeApply?.(c, abs);
            result.applied.push(c.filePath);
        }
        catch (err) {
            result.skipped.push({ filePath: c.filePath, reason: vscode_1.l10n.t('Apply failed: {0}', err instanceof Error ? err.message : String(err)) });
        }
    }
    // 应用完成后清理该提案的 staged 临时文件
    try {
        const stageRoot = path.join(getApplyDir(workspace), proposal.name, 'staged');
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
    return result;
}
// ── 渲染与命令 ──────────────────────────────────────────────────
/** 渲染提案为 diff 审查文档 */
/**
 * 为提案生成「应用后版本」的 staged 临时文件（.kodrix/apply/<name>/staged/），
 * 供编辑器内 diff（vscode.diff）逐文件审查。返回原始/暂存路径对；delete 的暂存文件为空。
 */
async function stageProposal(proposal, workspace) {
    const stageRoot = path.join(getApplyDir(workspace), proposal.name, 'staged');
    // 清理旧 staged，避免审查残留无限堆积
    try {
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
    fs.mkdirSync(stageRoot, { recursive: true });
    const out = [];
    for (const c of proposal.changes) {
        const abs = resolveInWs(c.filePath, workspace);
        if (!abs) {
            continue;
        }
        const stagedPath = path.join(stageRoot, c.filePath);
        fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
        let content = '';
        if (c.type !== 'delete') {
            const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
            content = c.type === 'edit' ? cur.replace(c.oldContent, c.newContent) : c.newContent;
        }
        fs.writeFileSync(stagedPath, content, 'utf-8');
        out.push({ filePath: c.filePath, type: c.type, originalPath: abs, stagedPath });
    }
    return out;
}
function renderProposalMarkdown(proposal, workspace) {
    const lines = [
        vscode_1.l10n.t('# Change Proposal: {0}', proposal.name),
        '',
        proposal.task ? vscode_1.l10n.t('Task: {0}', proposal.task) : '',
        vscode_1.l10n.t('{0} file changes · generated {1}', proposal.changes.length, proposal.createdAt.slice(0, 19)),
        '',
        vscode_1.l10n.t('> Review each file diff before applying; a checkpoint is created automatically before applying, so you can roll back at any time.'),
        '',
    ];
    for (const c of proposal.changes) {
        const abs = resolveInWs(c.filePath, workspace);
        const exists = abs && fs.existsSync(abs);
        lines.push(`## ${c.type.toUpperCase()} ${c.filePath}${c.reason ? ` — ${c.reason}` : ''}`);
        lines.push('');
        if (c.type === 'delete') {
            lines.push(vscode_1.l10n.t('(delete file)'), '');
            continue;
        }
        const oldText = c.type === 'edit' && exists ? fs.readFileSync(abs, 'utf-8') : (exists ? fs.readFileSync(abs, 'utf-8') : '');
        lines.push('```diff');
        lines.push(renderUnifiedDiff(c.filePath, oldText, c.newContent));
        lines.push('```', '');
    }
    return lines.join('\n');
}
/** 注册 Apply 命令 */
/** 编辑器内 diff 审查：QuickPick 选择文件 → vscode.diff（全屏 diff 视图） */
async function showProposalDiff(proposal, workspace) {
    const staged = await stageProposal(proposal, workspace);
    if (!staged.length) {
        await vscode.window.showInformationMessage(vscode_1.l10n.t('The proposal has no previewable changes (all paths are out of bounds)'));
        return;
    }
    const picked = await vscode.window.showQuickPick(staged.map(s => ({
        label: `${s.type.toUpperCase()} ${s.filePath}`.trim(),
        detail: s.type === 'delete' ? vscode_1.l10n.t('Delete file (right side is empty)') : vscode_1.l10n.t('Compare: original ←→ proposed version'),
        staged: s,
    })), { placeHolder: vscode_1.l10n.t('Proposal "{0}" contains {1} files — select to view diffs in the editor (multi-select)', proposal.name, staged.length), canPickMany: true });
    if (!picked) {
        return;
    }
    for (const item of picked) {
        const s = item.staged;
        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(s.originalPath), vscode.Uri.file(s.stagedPath), vscode_1.l10n.t('{0} — proposal {1} ({2})', s.filePath, proposal.name, s.type));
    }
}
function registerApplyManager(context) {
    const pickProposal = async (workspace) => {
        const files = listProposals(workspace);
        if (!files.length) {
            await vscode.window.showInformationMessage(vscode_1.l10n.t('No change proposals yet. Run "Kodrix: Run Agent Task" to have the Agent produce a proposal, or generate one with the propose_changes tool.'));
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(files, { placeHolder: vscode_1.l10n.t('Select a change proposal') });
        if (!picked) {
            return undefined;
        }
        const proposal = loadProposal(workspace, picked);
        if (!proposal) {
            await vscode.window.showErrorMessage(vscode_1.l10n.t('Invalid proposal file'));
            return undefined;
        }
        return { name: picked, proposal };
    };
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.applyPreview, async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            await vscode.window.showErrorMessage(vscode_1.l10n.t('Please open a workspace first'));
            return;
        }
        const ws = folder.uri.fsPath;
        const picked = await pickProposal(ws);
        if (!picked) {
            return;
        }
        await showProposalDiff(picked.proposal, ws);
    }), vscode.commands.registerCommand(constants_1.COMMANDS.applyCommit, async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            await vscode.window.showErrorMessage(vscode_1.l10n.t('Please open a workspace first'));
            return;
        }
        const ws = folder.uri.fsPath;
        const picked = await pickProposal(ws);
        if (!picked) {
            return;
        }
        const { proposal } = picked;
        // 先打开编辑器内 diff 供审查（可多选）
        await showProposalDiff(proposal, ws);
        // 破坏性操作给显式「取消」按钮（只有 ✕ 时用户容易点空），且按钮文案与比较值同源
        const applyLabel = vscode_1.l10n.t('Apply changes');
        const ok = await vscode.window.showWarningMessage(vscode_1.l10n.t('Apply proposal "{0}" ({1} file changes)? A checkpoint will be created automatically before applying.', proposal.name, proposal.changes.length), { modal: true }, applyLabel, vscode_1.l10n.t('Cancel'));
        if (ok !== applyLabel) {
            return;
        }
        const result = await applyProposal(proposal, ws);
        if (result.applied.length === proposal.changes.length) {
            // 成功提示带"下一步动作"：应用完直接给可执行的下一步，而不是让用户自己找入口
            const openDocs = vscode_1.l10n.t('Open Changed Files');
            const picked2 = await vscode.window.showInformationMessage(vscode_1.l10n.t('Applied proposal "{0}" ({1} files)', proposal.name, result.applied.length), openDocs);
            if (picked2 === openDocs) {
                for (const change of proposal.changes.slice(0, 8)) {
                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, change.filePath)));
                        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
                    }
                    catch { /* 文件可能已被删除 */ }
                }
            }
        }
        else {
            const skippedText = result.skipped.map(s => `${s.filePath}（${s.reason}）`).join('; ');
            await vscode.window.showWarningMessage(vscode_1.l10n.t('Partially applied: {0}/{1} succeeded. Not applied: {2}', result.applied.length, proposal.changes.length, skippedText));
        }
    }));
}
