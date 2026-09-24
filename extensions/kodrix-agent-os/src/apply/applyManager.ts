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

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import { COMMANDS, APPLY_DIR, APPLY_BACKUP_DIR, WORKSPACE_KODRIX_DIR } from '../shared/constants';

// ── 类型定义 ────────────────────────────────────────────────────

/** 变更类型 */
export type FileChangeType = 'write' | 'edit' | 'delete';

/** 单文件变更 */
export interface FileChange {
	/** 相对工作区路径 */
	filePath: string;
	/** write=新建/整体覆盖（不校验旧内容）· edit=精确替换（校验 oldContent）· delete=删除 */
	type: FileChangeType;
	/** edit 时必填：需精确匹配的旧内容 */
	oldContent?: string;
	/** 新内容（delete 时忽略） */
	newContent: string;
	/** 变更原因（Agent 说明） */
	reason?: string;
}

/** 变更提案（一次 Agent 产出 / 一次用户确认） */
export interface ApplyProposal {
	name: string;
	task?: string;
	createdAt: string;
	changes: FileChange[];
}

/** 应用结果 */
export interface ApplyResult {
	applied: string[];
	skipped: Array<{ filePath: string; reason: string }>;
}

// ── 行级 diff（LCS，大文件降级） ────────────────────────────────────

export interface DiffLine {
	type: 'same' | 'add' | 'del';
	text: string;
}

/** DP 单元上限（约 8MB 整数数组），超过则降级为全删+全增，避免 O(n×m) 内存爆炸 */
const DIFF_DP_CELL_LIMIT = 2_000_000;

/** 行级 LCS diff：返回操作序列（逐行） */
export function diffLines(oldText: string, newText: string): DiffLine[] {
	const a = oldText.split(/\r?\n/);
	const b = newText.split(/\r?\n/);
	const n = a.length;
	const m = b.length;
	// 空文本边界：旧为空 → 全新增；新为空 → 全删除
	const oldEmpty = n === 1 && a[0] === '';
	const newEmpty = m === 1 && b[0] === '';
	if (oldEmpty && !newEmpty) return b.map(text => ({ type: 'add', text }));
	if (newEmpty && !oldEmpty) return a.map(text => ({ type: 'del', text }));
	if (oldEmpty && newEmpty) return [];
	// 大文件降级：避免分配上亿整数
	if (n * m > DIFF_DP_CELL_LIMIT) {
		return [
			...a.map(text => ({ type: 'del' as const, text })),
			...b.map(text => ({ type: 'add' as const, text })),
		];
	}
	// DP：dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ type: 'same', text: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ type: 'del', text: a[i] });
			i++;
		} else {
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
export function renderUnifiedDiff(filePath: string, oldText: string, newText: string): string {
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
export function getApplyDir(workspace: string): string {
	return path.join(workspace, WORKSPACE_KODRIX_DIR, APPLY_DIR);
}

/** 列出工作区提案（新→旧） */
export function listProposals(workspace: string): string[] {
	const dir = getApplyDir(workspace);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter(f => f.endsWith('.json'))
		.sort()
		.reverse();
}

/** 读取提案 */
export function loadProposal(workspace: string, name: string): ApplyProposal | null {
	try {
		const p = path.join(getApplyDir(workspace), name);
		if (!fs.existsSync(p)) return null;
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as ApplyProposal;
		return raw;
	} catch {
		return null;
	}
}

/** 保存提案 */
export function saveProposal(workspace: string, proposal: ApplyProposal): string {
	const dir = getApplyDir(workspace);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${proposal.name}.json`);
	fs.writeFileSync(file, JSON.stringify(proposal, null, 2), 'utf-8');
	return file;
}

// ── 校验与应用 ──────────────────────────────────────────────────

/** 路径解析到工作区内（越界返回 undefined） */
function resolveInWs(rel: string, workspace: string): string | undefined {
	const resolved = path.resolve(workspace, rel);
	const wsNorm = path.normalize(workspace);
	return resolved === wsNorm || resolved.startsWith(wsNorm + path.sep) ? resolved : undefined;
}

/** 校验单条变更 */
export function validateChange(change: FileChange, workspace: string): { ok: boolean; error?: string } {
	const abs = resolveInWs(change.filePath, workspace);
	if (!abs) return { ok: false, error: `路径越界：${change.filePath}` };
	if (!change.filePath.trim()) return { ok: false, error: 'filePath 为空' };
	if (change.type === 'edit') {
		if (!change.oldContent) return { ok: false, error: `edit 变更缺少 oldContent：${change.filePath}` };
		if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在，无法 edit：${change.filePath}` };
		const cur = fs.readFileSync(abs, 'utf-8');
		const count = cur.split(change.oldContent).length - 1;
		if (count === 0) return { ok: false, error: `oldContent 未匹配：${change.filePath}` };
		if (count > 1) return { ok: false, error: `oldContent 匹配 ${count} 处（需唯一）：${change.filePath}` };
	}
	if (change.type === 'write' && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
		return { ok: false, error: `目标是目录：${change.filePath}` };
	}
	if (change.type === 'delete' && !fs.existsSync(abs)) {
		return { ok: false, error: `文件不存在，无法删除：${change.filePath}` };
	}
	return { ok: true };
}

export interface ApplyOptions {
	/** 应用前创建 Checkpoint（默认 true） */
	checkpoint?: boolean;
	/** 是否备份原始文件到 .kodrix/apply-backups/（默认 true） */
	backup?: boolean;
	/** 应用前钩子（可注入额外校验/通知） */
	onBeforeApply?: (change: FileChange, absPath: string) => void;
}

/**
 * 应用变更提案：备份 → 逐条应用 → 返回结果。
 * 全部变更先校验（任一失败则整体拒绝，避免部分应用）。
 */
export async function applyProposal(proposal: ApplyProposal, workspace: string, opts: ApplyOptions = {}): Promise<ApplyResult> {
	const checkpoint = opts.checkpoint ?? true;
	const backup = opts.backup ?? true;
	const result: ApplyResult = { applied: [], skipped: [] };

	// 0) 前置校验：任一失败整体拒绝（skipped 覆盖全部变更，标明原因）
	const failures: Array<{ filePath: string; reason: string }> = [];
	const alreadyApplied = new Set<string>();
	for (const c of proposal.changes) {
		const v = validateChange(c, workspace);
		if (!v.ok) {
			// 幂等：edit 已应用过（old 不匹配但目标内容已存在）→ 跳过，不视为失败
			if (c.type === 'edit') {
				// 幂等判据：目标内容已存在、旧内容已不在、且新内容足够长（防短子串误判）
				const abs = resolveInWs(c.filePath, workspace);
				const cur = abs && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
				if (c.newContent.length >= 1 && cur.includes(c.newContent) && !cur.includes(c.oldContent!)) {
					alreadyApplied.add(c.filePath);
					continue;
				}
			}
			failures.push({ filePath: c.filePath, reason: v.error ?? '校验失败' });
		}
	}
	if (failures.length) {
		return {
			applied: [],
			skipped: proposal.changes.map(c => {
				const f = failures.find(x => x.filePath === c.filePath);
				return f ? { filePath: c.filePath, reason: f.reason } : { filePath: c.filePath, reason: '前置校验失败，整体拒绝（未应用任何变更）' };
			}),
		};
	}

	// 1) 应用前 Checkpoint（可整体回滚）
	if (checkpoint) {
		try {
			const { createCheckpoint } = require('../checkpoint/checkpointManager') as typeof import('../checkpoint/checkpointManager');
			const id = await createCheckpoint(`Apply: ${proposal.name}`);
			logger.info(`[Apply] 已创建检查点 ${id}`);
		} catch (err) {
			logger.warn('[Apply] 创建检查点失败（继续）', err);
		}
	}

	// 2) 备份目录
	const backupRoot = backup
		? path.join(workspace, WORKSPACE_KODRIX_DIR, APPLY_BACKUP_DIR, `${proposal.name}-${Date.now()}`)
		: undefined;

	for (const c of proposal.changes) {
		if (alreadyApplied.has(c.filePath)) {
			result.skipped.push({ filePath: c.filePath, reason: '已应用（目标内容已存在）' });
			continue;
		}
		const abs = resolveInWs(c.filePath, workspace);
		if (!abs) {
			result.skipped.push({ filePath: c.filePath, reason: '路径越界' });
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
			} else {
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				if (c.type === 'edit') {
					const cur = fs.readFileSync(abs, 'utf-8');
					fs.writeFileSync(abs, cur.replace(c.oldContent!, c.newContent), 'utf-8');
				} else {
					fs.writeFileSync(abs, c.newContent, 'utf-8');
				}
			}
			opts.onBeforeApply?.(c, abs);
			result.applied.push(c.filePath);
		} catch (err) {
			result.skipped.push({ filePath: c.filePath, reason: `应用失败：${err instanceof Error ? err.message : String(err)}` });
		}
	}
	// 应用完成后清理该提案的 staged 临时文件
	try {
		const stageRoot = path.join(getApplyDir(workspace), proposal.name, 'staged');
		fs.rmSync(stageRoot, { recursive: true, force: true });
	} catch { /* best-effort */ }
	return result;
}

// ── 渲染与命令 ──────────────────────────────────────────────────

/** 渲染提案为 diff 审查文档 */
/**
 * 为提案生成「应用后版本」的 staged 临时文件（.kodrix/apply/<name>/staged/），
 * 供编辑器内 diff（vscode.diff）逐文件审查。返回原始/暂存路径对；delete 的暂存文件为空。
 */
export async function stageProposal(proposal: ApplyProposal, workspace: string): Promise<Array<{ filePath: string; type: FileChangeType; originalPath: string; stagedPath: string }>> {
	const stageRoot = path.join(getApplyDir(workspace), proposal.name, 'staged');
	// 清理旧 staged，避免审查残留无限堆积
	try {
		fs.rmSync(stageRoot, { recursive: true, force: true });
	} catch { /* best-effort */ }
	fs.mkdirSync(stageRoot, { recursive: true });
	const out: Array<{ filePath: string; type: FileChangeType; originalPath: string; stagedPath: string }> = [];
	for (const c of proposal.changes) {
		const abs = resolveInWs(c.filePath, workspace);
		if (!abs) continue;
		const stagedPath = path.join(stageRoot, c.filePath);
		fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
		let content = '';
		if (c.type !== 'delete') {
			const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
			content = c.type === 'edit' ? cur.replace(c.oldContent!, c.newContent) : c.newContent;
		}
		fs.writeFileSync(stagedPath, content, 'utf-8');
		out.push({ filePath: c.filePath, type: c.type, originalPath: abs, stagedPath });
	}
	return out;
}

export function renderProposalMarkdown(proposal: ApplyProposal, workspace: string): string {
	const lines = [
		`# 变更提案：${proposal.name}`,
		'',
		proposal.task ? `任务：${proposal.task}` : '',
		`共 ${proposal.changes.length} 个文件变更 · 生成时间 ${proposal.createdAt.slice(0, 19)}`,
		'',
		'> 确认应用前请逐文件核对 diff；应用前将自动创建检查点，可随时回滚。',
		'',
	];
	for (const c of proposal.changes) {
		const abs = resolveInWs(c.filePath, workspace);
		const exists = abs && fs.existsSync(abs);
		lines.push(`## ${c.type.toUpperCase()} ${c.filePath}${c.reason ? ` — ${c.reason}` : ''}`);
		lines.push('');
		if (c.type === 'delete') {
			lines.push('（删除文件）', '');
			continue;
		}
		const oldText = c.type === 'edit' && exists ? fs.readFileSync(abs!, 'utf-8') : (exists ? fs.readFileSync(abs!, 'utf-8') : '');
		lines.push('```diff');
		lines.push(renderUnifiedDiff(c.filePath, oldText, c.newContent));
		lines.push('```', '');
	}
	return lines.join('\n');
}

/** 注册 Apply 命令 */
/** 编辑器内 diff 审查：QuickPick 选择文件 → vscode.diff（全屏 diff 视图） */
async function showProposalDiff(proposal: ApplyProposal, workspace: string): Promise<void> {
	const staged = await stageProposal(proposal, workspace);
	if (!staged.length) {
		await vscode.window.showInformationMessage('提案没有可预览的变更（路径均越界）');
		return;
	}
	const picked = await vscode.window.showQuickPick(staged.map(s => ({
		label: `${s.type.toUpperCase()} ${s.filePath}`.trim(),
		detail: s.type === 'delete' ? '删除文件（右侧为空）' : '对比：原文件 ←→ 提案版本',
		staged: s,
	})), { placeHolder: `提案「${proposal.name}」共 ${staged.length} 个文件 — 选择查看编辑器 diff（可多选）`, canPickMany: true });
	if (!picked) return;
	for (const item of picked) {
		const s = item.staged;
		await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(s.originalPath), vscode.Uri.file(s.stagedPath), `${s.filePath} — 提案 ${proposal.name}（${s.type}）`);
	}
}

export function registerApplyManager(context: vscode.ExtensionContext): void {
	const pickProposal = async (workspace: string): Promise<{ name: string; proposal: ApplyProposal } | undefined> => {
		const files = listProposals(workspace);
		if (!files.length) {
			await vscode.window.showInformationMessage('暂无变更提案。可运行「Kodrix: 运行 Agent 任务」让 Agent 产出提案，或用 propose_changes 工具生成。');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(files, { placeHolder: '选择变更提案' });
		if (!picked) return undefined;
		const proposal = loadProposal(workspace, picked);
		if (!proposal) {
			await vscode.window.showErrorMessage('提案文件无效');
			return undefined;
		}
		return { name: picked, proposal };
	};

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.applyPreview, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				await vscode.window.showErrorMessage('请先打开工作区');
				return;
			}
			const ws = folder.uri.fsPath;
			const picked = await pickProposal(ws);
			if (!picked) return;
			await showProposalDiff(picked.proposal, ws);
		}),
		vscode.commands.registerCommand(COMMANDS.applyCommit, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				await vscode.window.showErrorMessage('请先打开工作区');
				return;
			}
			const ws = folder.uri.fsPath;
			const picked = await pickProposal(ws);
			if (!picked) return;
			const { proposal } = picked;
			// 先打开编辑器内 diff 供审查（可多选）
			await showProposalDiff(proposal, ws);
			const ok = await vscode.window.showWarningMessage(
				`确认应用提案「${proposal.name}」（${proposal.changes.length} 个文件变更）？应用前将自动创建检查点。`,
				{ modal: true },
				'应用变更',
			);
			if (ok !== '应用变更') return;
			const result = await applyProposal(proposal, ws);
			if (result.applied.length === proposal.changes.length) {
				await vscode.window.showInformationMessage(`已应用提案「${proposal.name}」（${result.applied.length} 个文件）`);
			} else {
				const skippedText = result.skipped.map(s => `${s.filePath}（${s.reason}）`).join('; ');
				await vscode.window.showWarningMessage(`部分应用：${result.applied.length}/${proposal.changes.length} 成功。未应用：${skippedText}`);
			}
		}),
	);
}
