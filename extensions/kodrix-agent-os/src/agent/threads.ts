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

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { COMMANDS, AGENT_RUNS_DIR, WORKSPACE_KODRIX_DIR } from '../shared/constants';
import { logger } from '../logger';

// ── 类型 ────────────────────────────────────────────────────────

/** 一次 Agent 运行（一个会话节点） */
export interface RunRecord {
	id: string;
	name: string;
	task: string;
	parentId?: string;
	mode?: 'act' | 'plan';
	createdAt: string;
	status: string;
	/** 原始 result（兼容旧记录可能缺失字段，result 为 JSON 原文） */
	result?: unknown;
}

/** 树节点（QuickPick 展示用） */
export interface ThreadNode {
	record: RunRecord;
	depth: number;
	/** 树路径编号，如 1.2.1 */
	path: string;
	children: ThreadNode[];
}

// ── 数据加载 ───────────────────────────────────────────────────

/** 读取全部会话记录（兼容旧 JSON：缺 name/parentId/createdAt 时兜底） */
export function loadRuns(runDir: string): RunRecord[] {
	if (!fs.existsSync(runDir)) {return [];}
	const runs: RunRecord[] = [];
	for (const f of fs.readdirSync(runDir)) {
		if (!f.endsWith('.json')) {continue;}
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf-8'));
			// 逐字段校验：此前直接 `as RunRecord`，坏记录会在"续聊"时以 TypeError 形式炸出来
			if (!raw || typeof raw !== 'object') {continue;}
			const r = raw as Partial<RunRecord> & { id?: unknown; task?: unknown; result?: unknown };
			if (typeof r.id !== 'string' || typeof r.task !== 'string') {
				logger.warn(`[Threads] 跳过字段缺失的会话记录：${f}`);
				continue;
			}
			// result 只在形状可信时保留（续聊要拿它重建历史，坏形状会直接抛错）
			const result = isUsableResult(r.result) ? r.result as RunRecord['result'] : undefined;
			if (r.result !== undefined && !result) {
				logger.warn(`[Threads] 会话记录 result 形状异常，已忽略该字段：${f}`);
			}
			runs.push({
				id: r.id,
				name: r.name ?? r.task.slice(0, 40),
				task: r.task,
				parentId: r.parentId,
				mode: r.mode,
				createdAt: r.createdAt ?? parseDateFromId(r.id),
				status: r.status ?? (result as { status?: string } | undefined)?.status ?? 'unknown',
				result,
			});
		} catch { /* 坏 JSON 跳过 */ }
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 会话记录里的 result 是否可用于续聊（trace 必须是数组，task 之类允许缺省） */
function isUsableResult(value: unknown): boolean {
	if (!value || typeof value !== 'object') {return false;}
	const r = value as { trace?: unknown; finalText?: unknown; status?: unknown };
	return Array.isArray(r.trace) && (r.finalText === undefined || typeof r.finalText === 'string');
}

/** 从 run-<ISO>.json 文件名解析时间兜底 */
function parseDateFromId(id: string): string {
	const m = /run-(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})/.exec(id);
	return m ? `${m[1]} ${m[2].replace(/-/g, ':')}` : 'unknown';
}

// ── 树构建 ─────────────────────────────────────────────────────

/** 按 parentId 建树（平铺列表带 depth/path，供 QuickPick 缩进展示） */
export function buildThreadTree(runs: RunRecord[]): ThreadNode[] {
	const byId = new Map<string, RunRecord>();
	for (const r of runs) {byId.set(r.id, r);}
	const childrenOf = new Map<string, RunRecord[]>();
	for (const r of runs) {
		const p = r.parentId && byId.has(r.parentId) ? r.parentId : '';
		if (!childrenOf.has(p)) {childrenOf.set(p, []);}
		childrenOf.get(p)!.push(r);
	}
	function build(parent: string, depth: number, prefix: string): ThreadNode[] {
		const kids = childrenOf.get(parent) ?? [];
		const out: ThreadNode[] = [];
		kids.forEach((k, i) => {
			const p = prefix ? `${prefix}.${i + 1}` : String(i + 1);
			const node: ThreadNode = { record: k, depth, path: p, children: build(k.id, depth + 1, p) };
			out.push(node);
		});
		return out;
	}
	return build('', 0, '');
}

// ── 命令 ───────────────────────────────────────────────────────

export function registerThreads(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		// 会话树浏览：树状缩进 QuickPick → 打开记录
		vscode.commands.registerCommand(COMMANDS.threadsTree, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { void vscode.window.showWarningMessage(l10n.t('Please open a workspace first')); return; }
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			const nodes = buildThreadTree(loadRuns(runDir));
			if (!nodes.length) {
				void vscode.window.showInformationMessage(l10n.t('No sessions yet (run an Agent task first)'));
				return;
			}
			const flat: ThreadNode[] = [];
			(function walk(ns: ThreadNode[]) { for (const n of ns) { flat.push(n); walk(n.children); } })(nodes);
			const picked = await vscode.window.showQuickPick(flat.map(n => ({
				label: `${'　'.repeat(n.depth)}${n.depth ? '└ ' : '● '}${n.record.name}`,
				detail: `#${n.path} · ${n.record.status} · ${n.record.mode ?? 'act'} · ${n.record.createdAt}`,
				description: n.children.length ? l10n.t('⤷ {0} child sessions', n.children.length) : undefined,
				node: n,
			})), { placeHolder: l10n.t('Session tree (indentation = hierarchy, numbers = paths) — select to open a record') });
			if (!picked) {return;}
			await openRun(runDir, picked.node.record);
		}),

		// 命名：重命名会话
		vscode.commands.registerCommand(COMMANDS.threadsRename, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { void vscode.window.showWarningMessage(l10n.t('Please open a workspace first')); return; }
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			const runs = loadRuns(runDir);
			if (!runs.length) {
				void vscode.window.showInformationMessage(l10n.t('No sessions yet'));
				return;
			}
			const picked = await pickRun(runs, l10n.t('Select a session to rename'));
			if (!picked) {return;}
			const name = await vscode.window.showInputBox({ prompt: l10n.t('New session name'), value: picked.name });
			if (name === undefined) {return;}
			const jsonPath = path.join(runDir, `${picked.id}.json`);
			try {
				const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
				raw.name = name.trim() || picked.name;
				fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), 'utf-8');
				void vscode.window.showInformationMessage(l10n.t('Session named: {0}', raw.name));
			} catch {
				void vscode.window.showErrorMessage(l10n.t('Invalid session file, cannot rename'));
			}
		}),

		// 搜索：按名称/任务/输出全文搜索会话
		vscode.commands.registerCommand(COMMANDS.threadsSearch, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { void vscode.window.showWarningMessage(l10n.t('Please open a workspace first')); return; }
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			const runs = loadRuns(runDir);
			if (!runs.length) {
				void vscode.window.showInformationMessage(l10n.t('No sessions yet'));
				return;
			}
			const keyword = await vscode.window.showInputBox({ prompt: l10n.t('Search sessions (match name / task / output)'), placeHolder: l10n.t('e.g., rate limiting or checkpoint') });
			if (!keyword) {return;}
			const k = keyword.toLowerCase();
			const hits = runs.filter(r =>
				r.name.toLowerCase().includes(k)
				|| r.task.toLowerCase().includes(k)
				|| String((r.result as { output?: string } | undefined)?.output ?? '').toLowerCase().includes(k)
			);
			if (!hits.length) {
				void vscode.window.showInformationMessage(l10n.t('No sessions found containing "{0}"', keyword));
				return;
			}
			const picked = await pickRun(hits, l10n.t('Found {0} sessions ({1}) — select one to open', hits.length, keyword));
			if (!picked) {return;}
			await openRun(runDir, picked);
		}),
	);
}

// ── 内部 ───────────────────────────────────────────────────────

export async function pickRun(runs: RunRecord[], placeHolder: string): Promise<RunRecord | undefined> {
	const byId = new Map(runs.map(r => [r.id, r]));
	const roots = buildThreadTree(runs);
	const flat: ThreadNode[] = [];
	(function walk(ns: ThreadNode[]) { for (const n of ns) { flat.push(n); walk(n.children); } })(roots);
	const picked = await vscode.window.showQuickPick(flat.map(n => ({
		label: `${'　'.repeat(n.depth)}${n.depth ? '└ ' : '● '}${n.record.name}`,
		detail: `#${n.path} · ${n.record.status} · ${n.record.mode ?? 'act'} · ${n.record.createdAt}`,
		description: n.children.length ? l10n.t('⤷ {0} child sessions', n.children.length) : undefined,
		id: n.record.id,
	})), { placeHolder });
	return picked ? byId.get(picked.id) : undefined;
}

async function openRun(runDir: string, record: RunRecord): Promise<void> {
	const mdPath = path.join(runDir, `${record.id}.md`);
	if (!fs.existsSync(mdPath)) {
		void vscode.window.showWarningMessage(l10n.t('Record {0} has no Markdown file (JSON metadata only)', record.id));
		return;
	}
	const doc = await vscode.workspace.openTextDocument(mdPath);
	await vscode.window.showTextDocument(doc, { preview: false });
}
