/*---------------------------------------------------------------------------------------------
 *  Agent Kanban — Devin / Qoder Quest 风格（增强版：进度条、时间戳、快捷过滤）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { ensureDir, getKanbanPath } from '../paths';
import { logger } from '../logger';
import { isRecord } from '../utils/jsonValidator';


export type KanbanStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';

export interface KanbanTask {
	id: string;
	title: string;
	description?: string;
	status: KanbanStatus;
	createdAt: string;
	updatedAt: string;
	sessionHint?: string;
}

interface KanbanData {
	tasks: KanbanTask[];
}

const STATUS_CONFIG: Record<KanbanStatus, { label: string; icon: string; color: string; order: number }> = {
	in_progress: { label: l10n.t('进行中'), icon: 'sync~spin', color: '#3794ff', order: 0 },
	review: { label: l10n.t('待审核'), icon: 'eye', color: '#cca700', order: 1 },
	blocked: { label: l10n.t('阻塞'), icon: 'error', color: '#f14c4c', order: 2 },
	todo: { label: l10n.t('待办'), icon: 'circle-outline', color: '#999999', order: 3 },
	done: { label: l10n.t('已完成'), icon: 'pass-filled', color: '#40c969', order: 4 },
};

function loadKanban(): KanbanData {
	const p = getKanbanPath();
	if (!p || !fs.existsSync(p)) {
		return { tasks: [] };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
		if (!isRecord(raw) || !Array.isArray(raw.tasks)) {
			logger.warn('[AgentKanban] loadKanban: invalid shape — resetting');
			return { tasks: [] };
		}
		return raw as unknown as KanbanData;
	} catch (e) {
		logger.warn(`[AgentKanban] 加载看板数据失败: ${e instanceof Error ? e.message : String(e)}`);
		return { tasks: [] };
	}
}

function saveKanban(data: KanbanData): void {
	const p = getKanbanPath();
	if (!p) {
		return;
	}
	ensureDir(p.replace(/[/\\][^/\\]+$/, ''));
	fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

function timeAgo(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return l10n.t('刚刚');
	if (mins < 60) return l10n.t('{0}分钟前', mins);
	const hours = Math.floor(mins / 60);
	if (hours < 24) return l10n.t('{0}小时前', hours);
	const days = Math.floor(hours / 24);
	if (days < 7) return l10n.t('{0}天前', days);
	return new Date(iso).toLocaleDateString('zh-CN');
}

export class KanbanTreeItem extends vscode.TreeItem {
	constructor(
		public readonly task: KanbanTask,
	) {
		const cfg = STATUS_CONFIG[task.status];
		super(task.title, vscode.TreeItemCollapsibleState.None);

		this.description = `${cfg.label} · ${timeAgo(task.updatedAt)}`;
		this.iconPath = new vscode.ThemeIcon(cfg.icon, new vscode.ThemeColor(
			task.status === 'done' ? 'charts.green' :
			task.status === 'in_progress' ? 'charts.blue' :
			task.status === 'blocked' ? 'charts.red' :
			task.status === 'review' ? 'charts.yellow' :
			'charts.foreground'
		));
		this.contextValue = `kanbanTask:${task.status}`;
		this.tooltip = [
			task.description || task.title,
			l10n.t('状态: {0}', cfg.label),
			l10n.t('创建: {0}', timeAgo(task.createdAt)),
			l10n.t('更新: {0}', timeAgo(task.updatedAt)),
			task.sessionHint ? l10n.t('关联会话: {0}', task.sessionHint) : '',
		].filter(Boolean).join('\n');

		if (task.description) {
			this.tooltip = `${task.description}\n\n${this.tooltip}`;
		}

		this.command = {
			command: 'kodrix.kanban.openSession',
			title: l10n.t('打开 Agent 会话'),
			arguments: [this],
		};
	}
}

class KanbanProvider implements vscode.TreeDataProvider<KanbanTreeItem> {
	private _onDidChange = new vscode.EventEmitter<KanbanTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire(undefined);
	}

	getTreeItem(element: KanbanTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): KanbanTreeItem[] {
		const data = loadKanban();
		return data.tasks
			.sort((a, b) => {
				const orderA = STATUS_CONFIG[a.status].order;
				const orderB = STATUS_CONFIG[b.status].order;
				if (orderA !== orderB) return orderA - orderB;
				return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
			})
			.map(t => new KanbanTreeItem(t));
	}

	getParent(): undefined { return undefined; }
}

export async function addKanbanTask(): Promise<void> {
	if (!getKanbanPath()) {
		vscode.window.showWarningMessage(l10n.t('请先打开工作区'));
		return;
	}
	const title = await vscode.window.showInputBox({
		prompt: l10n.t('任务标题'),
		placeHolder: l10n.t('实现用户登录页面'),
	});
	if (!title?.trim()) {
		return;
	}
	const description = await vscode.window.showInputBox({
		prompt: l10n.t('任务描述（可选，将传递给 Agent）'),
		placeHolder: l10n.t('包含表单验证、JWT token 存储、错误提示'),
	}) || undefined;

	const status = await vscode.window.showQuickPick(
		[
			{ label: `$(circle-outline) ${l10n.t('待办')}`, status: 'todo' as KanbanStatus },
			{ label: `$(sync) ${l10n.t('立即开始（进行中）')}`, status: 'in_progress' as KanbanStatus },
		],
		{ placeHolder: l10n.t('任务状态') },
	);

	const data = loadKanban();
	const task: KanbanTask = {
		id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		title: title.trim(),
		description,
		status: status?.status ?? 'todo',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	data.tasks.unshift(task);
	saveKanban(data);
	vscode.window.showInformationMessage(l10n.t('已添加任务：{0}', title));
}

export async function moveKanbanTask(item?: KanbanTreeItem): Promise<void> {
	if (!item?.task) {
		vscode.window.showWarningMessage(l10n.t('请从看板中选择任务'));
		return;
	}
	const currentCfg = STATUS_CONFIG[item.task.status];

	const allStatuses: KanbanStatus[] = ['todo', 'in_progress', 'review', 'blocked', 'done'];
	const picks = allStatuses
		.filter(s => s !== item.task.status)
		.map(s => ({
			label: `${STATUS_CONFIG[s].icon === 'sync~spin' ? '$(sync~spin)' : `$(${STATUS_CONFIG[s].icon})`} ${STATUS_CONFIG[s].label}`,
			description: s === item.task.status ? l10n.t('（当前）') : '',
			status: s,
		}));

	const next = await vscode.window.showQuickPick(picks, {
		placeHolder: l10n.t('当前：{0} → 移动到…', currentCfg.label),
	});
	if (!next) {
		return;
	}
	const data = loadKanban();
	const task = data.tasks.find(t => t.id === item.task.id);
	if (task) {
		task.status = next.status;
		task.updatedAt = new Date().toISOString();
		saveKanban(data);
		vscode.window.showInformationMessage(
			l10n.t('{0} → {1}', task.title, STATUS_CONFIG[next.status].label)
		);
	}
}

export async function openKanbanSession(item?: KanbanTreeItem): Promise<void> {
	const title = item?.task?.title || '';
	const description = item?.task?.description || '';

	let prompt: string | undefined;
	if (title) {
		const parts = [l10n.t('【Kanban 任务】{0}', title)];
		if (description) parts.push(l10n.t('\n需求描述：{0}', description));
		parts.push(l10n.t('\n请实施此任务。完成后更新看板状态。'));
		prompt = parts.join('\n');
	}

	await vscode.commands.executeCommand('workbench.action.chat.open', {
		mode: 'agent',
		query: prompt,
		isPartialQuery: !prompt,
	});

	if (item?.task && item.task.status === 'todo') {
		const data = loadKanban();
		const task = data.tasks.find(t => t.id === item.task.id);
		if (task) {
			task.status = 'in_progress';
			task.updatedAt = new Date().toISOString();
			saveKanban(data);
		}
	}
}

export async function deleteKanbanTask(item?: KanbanTreeItem): Promise<void> {
	if (!item?.task) {
		vscode.window.showWarningMessage(l10n.t('请从看板中选择任务'));
		return;
	}
	const confirm = await vscode.window.showQuickPick(
		[{ label: l10n.t('$(trash) 确认删除'), confirm: true }, { label: l10n.t('取消'), confirm: false }],
		{ placeHolder: l10n.t('删除「{0}」？', item.task.title) },
	);
	if (!confirm?.confirm) return;

	const data = loadKanban();
	data.tasks = data.tasks.filter(t => t.id !== item.task.id);
	saveKanban(data);
	vscode.window.showInformationMessage(l10n.t('已删除：{0}', item.task.title));
}

export function getKanbanStats(): { total: number; todo: number; inProgress: number; done: number; blocked: number } {
	const data = loadKanban();
	return {
		total: data.tasks.length,
		todo: data.tasks.filter(t => t.status === 'todo').length,
		inProgress: data.tasks.filter(t => t.status === 'in_progress').length,
		done: data.tasks.filter(t => t.status === 'done').length,
		blocked: data.tasks.filter(t => t.status === 'blocked').length,
	};
}

export function registerKanban(context: vscode.ExtensionContext): void {
	const provider = new KanbanProvider();
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('kodrix.agentKanban', provider),
		vscode.commands.registerCommand('kodrix.kanban.addTask', async () => {
			await addKanbanTask();
			provider.refresh();
		}),
		vscode.commands.registerCommand('kodrix.kanban.moveTask', async (item?: KanbanTreeItem) => {
			await moveKanbanTask(item);
			provider.refresh();
		}),
		vscode.commands.registerCommand('kodrix.kanban.openSession', async (item?: KanbanTreeItem) => {
			await openKanbanSession(item);
			provider.refresh();
		}),
		vscode.commands.registerCommand('kodrix.kanban.deleteTask', async (item?: KanbanTreeItem) => {
			await deleteKanbanTask(item);
			provider.refresh();
		}),
		vscode.commands.registerCommand('kodrix.kanban.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('kodrix.kanban.focus', async () => {
			await vscode.commands.executeCommand('workbench.view.explorer');
			await vscode.commands.executeCommand('kodrix.agentKanban.focus');
		}),
	);
}
