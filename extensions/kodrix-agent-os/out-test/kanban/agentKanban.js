"use strict";
/*---------------------------------------------------------------------------------------------
 *  Agent Kanban — Devin / Qoder Quest 风格（增强版：进度条、时间戳、快捷过滤）
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
exports.KanbanTreeItem = void 0;
exports.isShowCompletedEnabled = isShowCompletedEnabled;
exports.getVisibleKanbanTasks = getVisibleKanbanTasks;
exports.addKanbanTask = addKanbanTask;
exports.moveKanbanTask = moveKanbanTask;
exports.openKanbanSession = openKanbanSession;
exports.deleteKanbanTask = deleteKanbanTask;
exports.getKanbanStats = getKanbanStats;
exports.registerKanban = registerKanban;
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const paths_1 = require("../paths");
const logger_1 = require("../logger");
const jsonValidator_1 = require("../utils/jsonValidator");
const constants_1 = require("../shared/constants");
const STATUS_CONFIG = {
    in_progress: { label: vscode_1.l10n.t('In Progress'), icon: 'sync~spin', color: '#3794ff', order: 0 },
    review: { label: vscode_1.l10n.t('Pending review'), icon: 'eye', color: '#cca700', order: 1 },
    blocked: { label: vscode_1.l10n.t('Blocked'), icon: 'error', color: '#f14c4c', order: 2 },
    todo: { label: vscode_1.l10n.t('To Do'), icon: 'circle-outline', color: '#999999', order: 3 },
    done: { label: vscode_1.l10n.t('Completed'), icon: 'pass-filled', color: '#40c969', order: 4 },
};
function loadKanban() {
    const p = (0, paths_1.getKanbanPath)();
    if (!p || !fs.existsSync(p)) {
        return { tasks: [] };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!(0, jsonValidator_1.isRecord)(raw) || !Array.isArray(raw.tasks)) {
            logger_1.logger.warn('[AgentKanban] loadKanban: invalid shape — resetting');
            return { tasks: [] };
        }
        return raw;
    }
    catch (e) {
        logger_1.logger.warn(`[AgentKanban] 加载看板数据失败: ${e instanceof Error ? e.message : String(e)}`);
        return { tasks: [] };
    }
}
function saveKanban(data) {
    const p = (0, paths_1.getKanbanPath)();
    if (!p) {
        return;
    }
    (0, paths_1.ensureDir)(p.replace(/[/\\][^/\\]+$/, ''));
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}
function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) {
        return vscode_1.l10n.t('Just now');
    }
    if (mins < 60) {
        return vscode_1.l10n.t('{0} minutes ago', mins);
    }
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
        return vscode_1.l10n.t('{0} hours ago', hours);
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return vscode_1.l10n.t('{0} days ago', days);
    }
    return new Date(iso).toLocaleDateString('zh-CN');
}
/** 是否显示已完成任务（kodrix.kanban.showCompleted，默认 true：不配置时行为与此前一致） */
function isShowCompletedEnabled() {
    return vscode.workspace.getConfiguration(constants_1.KANBAN_CONFIG)
        .get(constants_1.KANBAN_CONFIG_KEYS.showCompleted, true);
}
/**
 * 看板可见任务列表：按 STATUS_CONFIG.order + 更新时间排序；
 * showCompleted=false 时过滤 done 任务（数据仍保留，仅不展示）。
 */
function getVisibleKanbanTasks() {
    const showCompleted = isShowCompletedEnabled();
    const data = loadKanban();
    return data.tasks
        .filter(t => showCompleted || t.status !== 'done')
        .sort((a, b) => {
        const orderA = STATUS_CONFIG[a.status].order;
        const orderB = STATUS_CONFIG[b.status].order;
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
}
class KanbanTreeItem extends vscode.TreeItem {
    task;
    constructor(task) {
        const cfg = STATUS_CONFIG[task.status];
        super(task.title, vscode.TreeItemCollapsibleState.None);
        this.task = task;
        this.description = `${cfg.label} · ${timeAgo(task.updatedAt)}`;
        this.iconPath = new vscode.ThemeIcon(cfg.icon, new vscode.ThemeColor(task.status === 'done' ? 'charts.green' :
            task.status === 'in_progress' ? 'charts.blue' :
                task.status === 'blocked' ? 'charts.red' :
                    task.status === 'review' ? 'charts.yellow' :
                        'charts.foreground'));
        this.contextValue = `kanbanTask:${task.status}`;
        this.tooltip = [
            task.description || task.title,
            vscode_1.l10n.t('Status: {0}', cfg.label),
            vscode_1.l10n.t('Created: {0}', timeAgo(task.createdAt)),
            vscode_1.l10n.t('Updated: {0}', timeAgo(task.updatedAt)),
            task.sessionHint ? vscode_1.l10n.t('Linked session: {0}', task.sessionHint) : '',
        ].filter(Boolean).join('\n');
        if (task.description) {
            this.tooltip = `${task.description}\n\n${this.tooltip}`;
        }
        this.command = {
            command: 'kodrix.kanban.openSession',
            title: vscode_1.l10n.t('Open Agent Session'),
            arguments: [this],
        };
    }
}
exports.KanbanTreeItem = KanbanTreeItem;
class KanbanProvider {
    _onDidChange = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChange.event;
    refresh() {
        this._onDidChange.fire(undefined);
    }
    /** 释放 TreeDataProvider 的变更事件（注册处将其 push 进 context.subscriptions） */
    dispose() {
        this._onDidChange.dispose();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        return getVisibleKanbanTasks()
            .map(t => new KanbanTreeItem(t));
    }
    getParent() { return undefined; }
}
async function addKanbanTask() {
    if (!(0, paths_1.getKanbanPath)()) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Please open a workspace first'));
        return;
    }
    const title = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Task title'),
        placeHolder: vscode_1.l10n.t('Implement the user login page'),
    });
    if (!title?.trim()) {
        return;
    }
    const description = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Task description (optional, will be passed to the Agent)'),
        placeHolder: vscode_1.l10n.t('Includes form validation, JWT token storage, and error messages'),
    }) || undefined;
    const status = await vscode.window.showQuickPick([
        { label: `$(circle-outline) ${vscode_1.l10n.t('To Do')}`, status: 'todo' },
        { label: `$(sync) ${vscode_1.l10n.t('Start Now (in progress)')}`, status: 'in_progress' },
    ], { placeHolder: vscode_1.l10n.t('Task status') });
    const data = loadKanban();
    const task = {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: title.trim(),
        description,
        status: status?.status ?? 'todo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    data.tasks.unshift(task);
    saveKanban(data);
    vscode.window.showInformationMessage(vscode_1.l10n.t('Task added: {0}', title));
}
async function moveKanbanTask(item) {
    if (!item?.task) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Please select a task from the board'));
        return;
    }
    const currentCfg = STATUS_CONFIG[item.task.status];
    const allStatuses = ['todo', 'in_progress', 'review', 'blocked', 'done'];
    const picks = allStatuses
        .filter(s => s !== item.task.status)
        .map(s => ({
        label: `${STATUS_CONFIG[s].icon === 'sync~spin' ? '$(sync~spin)' : `$(${STATUS_CONFIG[s].icon})`} ${STATUS_CONFIG[s].label}`,
        description: s === item.task.status ? vscode_1.l10n.t('(current)') : '',
        status: s,
    }));
    const next = await vscode.window.showQuickPick(picks, {
        placeHolder: vscode_1.l10n.t('Current: {0} → Move to…', currentCfg.label),
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
        vscode.window.showInformationMessage(vscode_1.l10n.t('{0} → {1}', task.title, STATUS_CONFIG[next.status].label));
    }
}
async function openKanbanSession(item) {
    const title = item?.task?.title || '';
    const description = item?.task?.description || '';
    let prompt;
    if (title) {
        const parts = [vscode_1.l10n.t('[Kanban Task] {0}', title)];
        if (description) {
            parts.push(vscode_1.l10n.t('\nRequirement: {0}', description));
        }
        parts.push(vscode_1.l10n.t('\nPlease implement this task. Update the kanban status when done.'));
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
async function deleteKanbanTask(item) {
    if (!item?.task) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Please select a task from the board'));
        return;
    }
    const confirm = await vscode.window.showQuickPick([{ label: vscode_1.l10n.t('$(trash) Confirm Delete'), confirm: true }, { label: vscode_1.l10n.t('Cancel'), confirm: false }], { placeHolder: vscode_1.l10n.t('Delete "{0}"?', item.task.title) });
    if (!confirm?.confirm) {
        return;
    }
    const data = loadKanban();
    data.tasks = data.tasks.filter(t => t.id !== item.task.id);
    saveKanban(data);
    vscode.window.showInformationMessage(vscode_1.l10n.t('Deleted: {0}', item.task.title));
}
function getKanbanStats() {
    const data = loadKanban();
    return {
        total: data.tasks.length,
        todo: data.tasks.filter(t => t.status === 'todo').length,
        inProgress: data.tasks.filter(t => t.status === 'in_progress').length,
        done: data.tasks.filter(t => t.status === 'done').length,
        blocked: data.tasks.filter(t => t.status === 'blocked').length,
    };
}
function registerKanban(context) {
    const provider = new KanbanProvider();
    context.subscriptions.push(provider, vscode.window.registerTreeDataProvider('kodrix.agentKanban', provider), vscode.commands.registerCommand('kodrix.kanban.addTask', async () => {
        await addKanbanTask();
        provider.refresh();
    }), vscode.commands.registerCommand('kodrix.kanban.moveTask', async (item) => {
        await moveKanbanTask(item);
        provider.refresh();
    }), vscode.commands.registerCommand('kodrix.kanban.openSession', async (item) => {
        await openKanbanSession(item);
        provider.refresh();
    }), vscode.commands.registerCommand('kodrix.kanban.deleteTask', async (item) => {
        await deleteKanbanTask(item);
        provider.refresh();
    }), vscode.commands.registerCommand('kodrix.kanban.refresh', () => provider.refresh()), vscode.commands.registerCommand('kodrix.kanban.focus', async () => {
        // 看板视图带 when: config.kodrix.features.kanban —— 关闭时焦点命令会静默失败，
        // 用户点了没反应会以为功能坏了；这里显式说明原因并给出开关入口
        if (vscode.workspace.getConfiguration('kodrix.features').get('kanban', true) === false) {
            const enable = vscode_1.l10n.t('Enable board');
            const choice = await vscode.window.showWarningMessage(vscode_1.l10n.t('Agent Kanban is disabled (kodrix.features.kanban=false); cannot focus it.'), enable);
            if (choice === enable) {
                await vscode.workspace.getConfiguration('kodrix.features')
                    .update('kanban', true, vscode.ConfigurationTarget.Global);
            }
            return;
        }
        await vscode.commands.executeCommand('workbench.view.explorer');
        await vscode.commands.executeCommand('kodrix.agentKanban.focus');
    }), 
    // 设置项 kodrix.kanban.showCompleted 变更时即时刷新树（无需重开工作区）
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(`${constants_1.KANBAN_CONFIG}.${constants_1.KANBAN_CONFIG_KEYS.showCompleted}`)) {
            provider.refresh();
        }
    }));
}
