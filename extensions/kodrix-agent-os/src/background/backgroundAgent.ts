/*---------------------------------------------------------------------------------------------
 *  Background Agent — 后台 Agent（对标 Cursor Background Agent）
 *
 *  能力：
 *    1. 派发后台任务：用户描述目标后立即返回任务 id，Agent 在后台异步执行（不阻塞编辑 UI）
 *    2. 执行：模型路由（smart 档）独立请求，结果写入 .kodrix/background/<id>.json
 *    3. 完成通知：任务完成/失败时 showInformationMessage / showWarningMessage 提醒
 *    4. 任务列表命令：查看全部后台任务及状态
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { routeModel } from '../model/modelRouter';
import { getProfileInjection } from '../profile/userProfile';
import { logger } from '../logger';
import {
	BACKGROUND_TASK_TIMEOUT_MS,
	BACKGROUND_TASK_RESULT_MAX_CHARS,
	BACKGROUND_TASKS_DIR,
	COMMANDS,
	WORKSPACE_KODRIX_DIR,
} from '../shared/constants';

/** 后台任务 */
export interface BackgroundTask {
	id: string;
	title: string;
	status: 'running' | 'completed' | 'failed';
	result?: string;
	error?: string;
	createdAt: string;
	finishedAt?: string;
}

/** 后台任务目录（工作区 .kodrix/background） */
function getTasksDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, BACKGROUND_TASKS_DIR);
}

/** 单任务文件路径 */
function getTaskFilePath(dir: string, id: string): string {
	return path.join(dir, `${id}.json`);
}

function writeTask(task: BackgroundTask): void {
	const dir = getTasksDir();
	if (!dir) {
		return;
	}
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(getTaskFilePath(dir, task.id), JSON.stringify(task, null, 2), 'utf-8');
	} catch (err) {
		logger.error('[BackgroundAgent] 写入任务失败', err);
	}
}

/** 读取全部后台任务（新→旧） */
export function listBackgroundTasks(): BackgroundTask[] {
	const dir = getTasksDir();
	if (!dir || !fs.existsSync(dir)) {
		return [];
	}
	try {
		return fs.readdirSync(dir)
			.filter(f => f.endsWith('.json'))
			.map(f => {
				try {
					return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as BackgroundTask;
				} catch {
					return undefined;
				}
			})
			.filter((t): t is BackgroundTask => t !== undefined)
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	} catch {
		return [];
	}
}

/** 执行后台任务（导出便于测试；生产由 createBackgroundTask 自动触发） */
export async function runBackgroundTask(task: BackgroundTask): Promise<void> {
	const routed = await routeModel({ taskType: 'plan' });
	if (!routed) {
		task.status = 'failed';
		task.error = '无可用语言模型（请在 Manage Models 中配置 BYOK 模型）';
		task.finishedAt = new Date().toISOString();
		writeTask(task);
		await vscode.window.showWarningMessage(`后台任务失败：${task.title}（无可用模型）`);
		return;
	}
	const cts = new vscode.CancellationTokenSource();
	const timer = setTimeout(() => cts.cancel(), BACKGROUND_TASK_TIMEOUT_MS);
	try {
		const profile = getProfileInjection();
		const messages = [vscode.LanguageModelChatMessage.User(
			[
				'你是一个后台 Agent（对标 Cursor Background Agent），独立完成以下任务，无需用户交互。',
				'直接输出可交付的最终成果（方案 / 代码 / 文档），使用 Markdown 结构化表达。',
				'',
				profile,
				'',
				`【后台任务】${task.title}`,
			].join('\n'),
		)];
		const response = await routed.model.sendRequest(messages, {}, cts.token);
		let text = '';
		for await (const chunk of response.stream) {
			if (chunk instanceof vscode.LanguageModelTextPart) {
				text += chunk.value;
			}
		}
		task.result = text.slice(0, BACKGROUND_TASK_RESULT_MAX_CHARS);
		task.status = text.trim() ? 'completed' : 'failed';
		if (task.status === 'failed') {
			task.error = '模型无响应输出';
		}
	} catch (err) {
		task.status = 'failed';
		task.error = err instanceof Error ? err.message : String(err);
		logger.error('[BackgroundAgent] 任务执行失败', err);
	} finally {
		clearTimeout(timer);
		cts.dispose();
	}
	task.finishedAt = new Date().toISOString();
	writeTask(task);
	if (task.status === 'completed') {
		await vscode.window.showInformationMessage(`后台任务完成：${task.title}`);
	} else {
		await vscode.window.showWarningMessage(`后台任务失败：${task.title}（${task.error}）`);
	}
}

/** 创建并派发后台任务（立即返回任务对象，后台异步执行） */
export async function createBackgroundTask(title: string): Promise<BackgroundTask | undefined> {
	const dir = getTasksDir();
	if (!dir) {
		return undefined;
	}
	if (!title.trim()) {
		return undefined;
	}
	const id = `bg-${new Date().toISOString().replace(/[:.]/g, '-')}`;
	const task: BackgroundTask = {
		id,
		title: title.trim(),
		status: 'running',
		createdAt: new Date().toISOString(),
	};
	writeTask(task);
	// 后台异步执行（不阻塞 UI / 不 await）
	void runBackgroundTask(task);
	return task;
}

/** 注册后台 Agent 命令 */
/** 后台 Agent 会话面板 HTML（任务队列 + 状态 + 结果摘要 + 点击打开详情 + 刷新） */
function renderBackgroundPanelHtml(tasks: BackgroundTask[]): string {
	const rows = tasks.length
		? tasks.map(t => {
			const st = t.status;
			const color = st === 'completed' ? '#3fb950' : st === 'running' ? '#d29922' : '#f85149';
			const summary = (t.result ?? t.error ?? '').slice(0, 80);
			return `<tr onclick="openTask(\'${t.id}\')" style="cursor:pointer">
	<td>${t.title}</td>
	<td><span style="color:${color};font-weight:600">${st}</span></td>
	<td>${(t.createdAt ?? '').slice(11, 19)}</td>
	<td title="${t.error ?? ''}">${summary || '—'}</td>
</tr>`.trim();
		}).join('')
		: '<tr><td colspan="4" style="text-align:center;color:#8b949e">（暂无后台任务——运行「Kodrix: 后台 Agent 派发任务」）</td></tr>';
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
body{background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);padding:16px;font-size:13px}
h1{font-size:16px;margin:0 0 4px}
.sub{color:var(--vscode-descriptionForeground);margin:0 0 14px;font-size:12px}
table{border-collapse:collapse;width:100%}
th{text-align:left;color:var(--vscode-descriptionForeground);font-size:11px;text-transform:uppercase;padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border)}
td{padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border)}
tr:hover{background:var(--vscode-list-hoverBackground)}
.btn{margin-top:10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 12px;border-radius:4px;cursor:pointer}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.legend{margin-top:10px;font-size:12px;color:var(--vscode-descriptionForeground)}
</style></head>
<body>
<h1>后台 Agent 会话</h1>
<p class="sub">点击任务行查看完整结果 · 共 ${tasks.length} 个任务</p>
<table>
<tr><th>任务</th><th>状态</th><th>创建</th><th>结果摘要</th></tr>
${rows}
</table>
<button class="btn" onclick="refresh()">刷新</button>
<div class="legend">状态：<span style="color:#3fb950">completed</span> · <span style="color:#d29922">running</span> · <span style="color:#f85149">failed</span></div>
<script>const vscode=acquireVsCodeApi();function refresh(){vscode.postMessage({command:'refresh'})}function openTask(id){vscode.postMessage({command:'open',id})}</script>
</body></html>`;
}

export function registerBackgroundAgent(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.backgroundPanel, async () => {
			const panel = vscode.window.createWebviewPanel('kodrix.background', '后台 Agent 会话', vscode.ViewColumn.Active, { enableScripts: true });
			panel.webview.html = renderBackgroundPanelHtml(listBackgroundTasks());
			panel.webview.onDidReceiveMessage(async msg => {
				if (msg?.command === 'refresh') {
					panel.webview.html = renderBackgroundPanelHtml(listBackgroundTasks());
					return;
				}
				if (msg?.command === 'open') {
					const dir = getTasksDir();
					if (!dir) return;
					try {
						const task = JSON.parse(fs.readFileSync(getTaskFilePath(dir, msg.id), 'utf-8')) as BackgroundTask;
						const doc = await vscode.workspace.openTextDocument({ content: `# ${task.title}\n\n状态：${task.status} · 创建：${task.createdAt}\n\n${task.result ?? task.error ?? '（无输出）'}`, language: 'markdown' });
						await vscode.window.showTextDocument(doc, { preview: false });
					} catch (err) {
						await vscode.window.showErrorMessage('任务文件无效或不存在');
					}
				}
			});
		}),
		vscode.commands.registerCommand(COMMANDS.backgroundDispatch, async () => {
			const title = await vscode.window.showInputBox({
				prompt: '描述后台任务目标（Agent 将独立完成并通知你）',
				placeHolder: '例如：调研项目现状并输出一份升级方案',
			});
			if (!title) {
				return;
			}
			const task = await createBackgroundTask(title);
			if (!task) {
				await vscode.window.showErrorMessage('无法派发后台任务（未打开工作区）');
				return;
			}
			await vscode.window.showInformationMessage(`后台任务已派发：${task.id}（完成后将通知你）`);
		}),
		vscode.commands.registerCommand(COMMANDS.backgroundList, async () => {
			const tasks = listBackgroundTasks();
			if (!tasks.length) {
				await vscode.window.showInformationMessage('暂无后台任务。使用「Kodrix: 派发后台任务」开始。');
				return;
			}
			const doc = await vscode.workspace.openTextDocument({
				content: [
					'# Kodrix 后台任务',
					'',
					'| ID | 标题 | 状态 | 创建时间 | 完成时间 | 结果摘要 |',
					'|----|------|------|---------|---------|---------|',
					...tasks.map(t => {
						const summary = (t.result || t.error || '—').split('\n')[0].slice(0, 60);
						return `| \`${t.id}\` | ${t.title} | ${t.status} | ${t.createdAt.slice(0, 19)} | ${t.finishedAt?.slice(0, 19) ?? '—'} | ${summary} |`;
					}),
					'',
					`共 ${tasks.length} 个任务 · 存储 .kodrix/background/`,
				].join('\n'),
				language: 'markdown',
			});
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
	);
}
