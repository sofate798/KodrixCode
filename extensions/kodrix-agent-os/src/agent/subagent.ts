/*---------------------------------------------------------------------------------------------
 *  Subagent 并行派生（对标 Cursor Subagent 核心卖点）
 *
 *  主任务拆分为多个子任务 → 每个子任务拥有【独立 Agent 会话】
 *  （独立消息上下文 / 独立轨迹 / 独立 Checkpoint）→ 受限并发池并行执行
 *  → 自动汇总报告落盘 .kodrix/subagents/<id>.md + .json
 *
 *  与 Agent Crew 的区别：Crew 共享工作区与上下文（配置式编排）；
 *  Subagent 每次调用 runAgentLoop 都是全新推理循环，子任务间上下文互不可见。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { runAgentLoop, type AgentLoopResult } from './agentLoop';
import { logger } from '../logger';
import { resolveCrewMaxParallel } from '../utils/crewParallel';

/** 单次派生的子任务硬上限：每个子任务都是完整 Agent 循环，规模必须有界 */
export const SUBAGENT_MAX_TASKS = 20;
import { COMMANDS, SUBAGENTS_DIR, WORKSPACE_KODRIX_DIR } from '../shared/constants';

// ── 类型 ────────────────────────────────────────────────────────

/** 单个子任务（独立上下文执行的单元） */
export interface SubagentTask {
	title: string;
	prompt: string;
	/** 可选首选模型 family */
	model?: string;
}

/** 单个子任务执行结果 */
export interface SubagentOutcome {
	title: string;
	status: string;
	output: string;
	iterations: number;
	durationMs: number;
	checkpointId?: string;
	error?: string;
}

/** 一批 Subagent 的汇总 */
export interface SubagentBatch {
	id: string;
	createdAt: string;
	parentTask: string;
	subagents: SubagentOutcome[];
}

// ── 核心：并行派生 ─────────────────────────────────────────────

/**
 * 将主任务拆为多个子任务并行执行，每个子任务独立 Agent 会话（独立上下文）。
 * 并发上限取 kodrix.crew.maxParallel（默认 3，与 Crew 共用钳制规则），全部完成后返回汇总批次。
 */
export async function runSubagents(opts: {
	parentTask: string;
	tasks: SubagentTask[];
	workspace: string;
	maxParallel?: number;
	onUpdate?: (index: number, title: string, phase: string) => void;
	/** 取消令牌：贯通到每个子任务的 Agent 循环（含其终端命令），让"取消"真的能停下来 */
	token?: vscode.CancellationToken;
}): Promise<SubagentBatch> {
	const maxParallel = resolveCrewMaxParallel(opts.maxParallel);
	const batch: SubagentBatch = {
		id: `sub-${new Date().toISOString().replace(/[:.]/g, '-')}`,
		createdAt: new Date().toISOString(),
		parentTask: opts.parentTask,
		subagents: new Array(opts.tasks.length),
	};
	let next = 0;

	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= opts.tasks.length) {return;}
			const st = opts.tasks[i];
			opts.onUpdate?.(i, st.title, 'running');
			const start = Date.now();
			try {
				const r: AgentLoopResult = await runAgentLoop({
					task: `${st.prompt}\n\n（父任务背景：${opts.parentTask}）`,
					workspace: opts.workspace,
					model: st.model,
					cancellationToken: opts.token,
					onUpdate: (phase, detail) => opts.onUpdate?.(i, st.title, `${phase}: ${detail.slice(0, 80)}`),
				});
				batch.subagents[i] = {
					title: st.title,
					status: r.status,
					output: r.output,
					iterations: r.iterations,
					durationMs: r.durationMs,
					checkpointId: r.checkpointId,
				};
			} catch (err) {
				batch.subagents[i] = {
					title: st.title,
					status: 'failed',
					output: '',
					iterations: 0,
					durationMs: Date.now() - start,
					error: err instanceof Error ? err.message : String(err),
				};
			}
			opts.onUpdate?.(i, st.title, batch.subagents[i].status);
		}
	}

	await Promise.all(Array.from({ length: Math.min(maxParallel, opts.tasks.length) }, () => worker()));
	return batch;
}

// ── 报告渲染 ───────────────────────────────────────────────────

/** 汇总报告（Markdown） */
export function renderSubagentReport(batch: SubagentBatch): string {
	const lines: string[] = [
		l10n.t('# Subagent Parallel Run Report'),
		``,
		`- ${l10n.t('Batch')}: \`${batch.id}\``,
		`- ${l10n.t('Time')}: ${batch.createdAt}`,
		`- ${l10n.t('Parent task')}: ${batch.parentTask}`,
		``,
		`| # | ${l10n.t('Subtask')} | ${l10n.t('Status')} | ${l10n.t('Iterations')} | ${l10n.t('Duration')} | ${l10n.t('Checkpoint')} |`,
		`|---|--------|------|------|------|--------|`,
	];
	batch.subagents.forEach((s, i) => {
		lines.push(`| ${i + 1} | ${s.title.replace(/\|/g, '\\|')} | ${s.status} | ${s.iterations} | ${s.durationMs}ms | ${s.checkpointId ?? '—'} |`);
	});
	lines.push(``);
	for (const [i, s] of batch.subagents.entries()) {
		lines.push(`## ${i + 1}. ${s.title}`, ``);
		if (s.error) {
			lines.push(`**${l10n.t('Failed')}**: ${s.error}`, ``);
		}
		lines.push(s.output.trim() || l10n.t('(no output)'), ``);
	}
	return lines.join('\n');
}

// ── 命令注册 ───────────────────────────────────────────────────

export function registerSubagent(context: vscode.ExtensionContext): void {
	// 派生 Subagent：输入主任务 + 子任务列表（每行一个）→ 并行执行
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.subagentRun, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage(l10n.t('Please open a workspace first'));
				return;
			}
			const parentTask = await vscode.window.showInputBox({
				prompt: l10n.t('Parent task description (context for the split)'),
				placeHolder: l10n.t('e.g., add a /health check endpoint to Kodrix'),
			});
			if (!parentTask) {return;}
			const list = await vscode.window.showInputBox({
				prompt: l10n.t('Subtask list (one per line; each runs in parallel with its own context)'),
				placeHolder: l10n.t('Line 1: Design the interfaces and routes\\nLine 2: Implement the controllers\\nLine 3: Add unit tests'),
			});
			if (!list) {return;}
			const tasks: SubagentTask[] = list
				.split(/\r?\n/)
				.map(s => s.trim())
				.filter(Boolean)
				// 硬上限：粘贴 50 行需求 = 50 个完整 Agent 循环并发盲写同一批文件（后写覆盖先写）
				.slice(0, SUBAGENT_MAX_TASKS)
				.map((t, _i) => ({ title: t.length > 30 ? `${t.slice(0, 30)}…` : t, prompt: t }));
			if (!tasks.length) {return;}
			const requestedCount = list.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
			if (requestedCount > SUBAGENT_MAX_TASKS) {
				const continueLabel = l10n.t('Continue');
				const proceed = await vscode.window.showWarningMessage(
					l10n.t('Subtask count {0} exceeds the limit of {1}; only the first {1} will run. Consider splitting into multiple batches to avoid concurrent writes overwriting each other.', requestedCount, SUBAGENT_MAX_TASKS),
					{ modal: true },
					continueLabel,
					l10n.t('Cancel'),
				);
				if (proceed !== continueLabel) {return;}
			}

			const ws = folder.uri.fsPath;
			const runDir = path.join(ws, WORKSPACE_KODRIX_DIR, SUBAGENTS_DIR);
			fs.mkdirSync(runDir, { recursive: true });
			// 可取消进度：多个子 Agent 并行跑分钟级任务，此前只有一条"执行中"通知，看不到进展也无法中断
			const batch = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: l10n.t('Kodrix Subagent: running {0} subtasks in parallel', tasks.length),
					cancellable: true,
				},
				async (progress, token) => {
					const done = new Set<string>();
					return runSubagents({
						parentTask,
						tasks,
						workspace: ws,
						token,
						onUpdate: (i, title, phase) => {
							logger.info(`[Subagent] #${i + 1}「${title}」${phase}`);
							// 同一子任务只报一次增量，避免进度条抖动
							const key = `${i}:${phase.split(':')[0]}`;
							if (!done.has(key)) {
								done.add(key);
								progress.report({ message: `#${i + 1} ${title}` });
							}
						},
					});
				},
			);
			await saveBatch(runDir, batch);
			const docPath = path.join(runDir, `${batch.id}.md`);
			const doc = await vscode.workspace.openTextDocument(docPath);
			await vscode.window.showTextDocument(doc, { preview: false });
			void vscode.window.showInformationMessage(l10n.t('Subagent batch completed: {0}/{1} succeeded', batch.subagents.filter(s => s.status === 'completed').length, tasks.length));
		}),
		// 查看历史批次
		vscode.commands.registerCommand(COMMANDS.subagentList, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { void vscode.window.showWarningMessage(l10n.t('Please open a workspace first')); return; }
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, SUBAGENTS_DIR);
			if (!fs.existsSync(runDir)) {
				void vscode.window.showInformationMessage(l10n.t('No Subagent runs yet'));
				return;
			}
			const files = fs.readdirSync(runDir).filter(f => f.endsWith('.md')).sort().reverse();
			if (!files.length) {
				void vscode.window.showInformationMessage(l10n.t('No Subagent runs yet'));
				return;
			}
			const picked = await vscode.window.showQuickPick(files.slice(0, 20), { placeHolder: l10n.t('Select a Subagent batch report to view') });
			if (!picked) {return;}
			const doc = await vscode.workspace.openTextDocument(path.join(runDir, picked));
			await vscode.window.showTextDocument(doc, { preview: false });
		}),
	);
}

async function saveBatch(runDir: string, batch: SubagentBatch): Promise<void> {
	fs.writeFileSync(path.join(runDir, `${batch.id}.md`), renderSubagentReport(batch), 'utf-8');
	fs.writeFileSync(path.join(runDir, `${batch.id}.json`), JSON.stringify(batch, null, 2), 'utf-8');
}
