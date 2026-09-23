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
import * as fs from 'fs';
import * as path from 'path';
import { runAgentLoop, type AgentLoopResult } from './agentLoop';
import { logger } from '../logger';
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
 * 并发上限 maxParallel（默认 3），全部完成后返回汇总批次。
 */
export async function runSubagents(opts: {
	parentTask: string;
	tasks: SubagentTask[];
	workspace: string;
	maxParallel?: number;
	onUpdate?: (index: number, title: string, phase: string) => void;
}): Promise<SubagentBatch> {
	const maxParallel = Math.max(1, opts.maxParallel ?? 3);
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
			if (i >= opts.tasks.length) return;
			const st = opts.tasks[i];
			opts.onUpdate?.(i, st.title, 'running');
			const start = Date.now();
			try {
				const r: AgentLoopResult = await runAgentLoop({
					task: `${st.prompt}\n\n（父任务背景：${opts.parentTask}）`,
					workspace: opts.workspace,
					model: st.model,
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
		`# Subagent 并行执行报告`,
		``,
		`- 批次：\`${batch.id}\``,
		`- 时间：${batch.createdAt}`,
		`- 父任务：${batch.parentTask}`,
		``,
		`| # | 子任务 | 状态 | 迭代 | 耗时 | 检查点 |`,
		`|---|--------|------|------|------|--------|`,
	];
	batch.subagents.forEach((s, i) => {
		lines.push(`| ${i + 1} | ${s.title.replace(/\|/g, '\\|')} | ${s.status} | ${s.iterations} | ${s.durationMs}ms | ${s.checkpointId ?? '—'} |`);
	});
	lines.push(``);
	for (const [i, s] of batch.subagents.entries()) {
		lines.push(`## ${i + 1}. ${s.title}`, ``);
		if (s.error) {
			lines.push(`**失败**：${s.error}`, ``);
		}
		lines.push(s.output.trim() || '（无输出）', ``);
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
				void vscode.window.showWarningMessage('请先打开一个工作区');
				return;
			}
			const parentTask = await vscode.window.showInputBox({
				prompt: '父任务描述（拆分的背景）',
				placeHolder: '例如：为 Kodrix 新增 /health 健康检查接口',
			});
			if (!parentTask) return;
			const list = await vscode.window.showInputBox({
				prompt: '子任务列表（每行一个，将各自独立上下文并行执行）',
				placeHolder: '第一行：设计接口与路由\n第二行：实现控制器\n第三行：补充单元测试',
			});
			if (!list) return;
			const tasks: SubagentTask[] = list
				.split(/\r?\n/)
				.map(s => s.trim())
				.filter(Boolean)
				.map((t, _i) => ({ title: t.length > 30 ? `${t.slice(0, 30)}…` : t, prompt: t }));
			if (!tasks.length) return;

			const ws = folder.uri.fsPath;
			const runDir = path.join(ws, WORKSPACE_KODRIX_DIR, SUBAGENTS_DIR);
			fs.mkdirSync(runDir, { recursive: true });
			void vscode.window.showInformationMessage(`Subagent 并行执行中（${tasks.length} 个子任务）…完成后自动打开报告`);
			const batch = await runSubagents({
				parentTask,
				tasks,
				workspace: ws,
				onUpdate: (_i, title, phase) => {
					logger.info(`[Subagent] #${_i + 1}「${title}」${phase}`);
				},
			});
			await saveBatch(runDir, batch);
			const docPath = path.join(runDir, `${batch.id}.md`);
			const doc = await vscode.workspace.openTextDocument(docPath);
			await vscode.window.showTextDocument(doc, { preview: false });
			void vscode.window.showInformationMessage(`Subagent 批次完成：${batch.subagents.filter(s => s.status === 'completed').length}/${tasks.length} 成功`);
		}),
		// 查看历史批次
		vscode.commands.registerCommand(COMMANDS.subagentList, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) return;
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, SUBAGENTS_DIR);
			if (!fs.existsSync(runDir)) {
				void vscode.window.showInformationMessage('暂无 Subagent 运行记录');
				return;
			}
			const files = fs.readdirSync(runDir).filter(f => f.endsWith('.md')).sort().reverse();
			if (!files.length) {
				void vscode.window.showInformationMessage('暂无 Subagent 运行记录');
				return;
			}
			const picked = await vscode.window.showQuickPick(files.slice(0, 20), { placeHolder: '选择要查看的 Subagent 批次报告' });
			if (!picked) return;
			const doc = await vscode.workspace.openTextDocument(path.join(runDir, picked));
			await vscode.window.showTextDocument(doc, { preview: false });
		}),
	);
}

async function saveBatch(runDir: string, batch: SubagentBatch): Promise<void> {
	fs.writeFileSync(path.join(runDir, `${batch.id}.md`), renderSubagentReport(batch), 'utf-8');
	fs.writeFileSync(path.join(runDir, `${batch.id}.json`), JSON.stringify(batch, null, 2), 'utf-8');
}
