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
const STATUS_CONFIG = {
    in_progress: { label: vscode_1.l10n.t('进行中'), icon: 'sync~spin', color: '#3794ff', order: 0 },
    review: { label: vscode_1.l10n.t('待审核'), icon: 'eye', color: '#cca700', order: 1 },
    blocked: { label: vscode_1.l10n.t('阻塞'), icon: 'error', color: '#f14c4c', order: 2 },
    todo: { label: vscode_1.l10n.t('待办'), icon: 'circle-outline', color: '#999999', order: 3 },
    done: { label: vscode_1.l10n.t('已完成'), icon: 'pass-filled', color: '#40c969', order: 4 },
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
    if (mins < 1)
        return vscode_1.l10n.t('刚刚');
    if (mins < 60)
        return vscode_1.l10n.t('{0}分钟前', mins);
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return vscode_1.l10n.t('{0}小时前', hours);
    const days = Math.floor(hours / 24);
    if (days < 7)
        return vscode_1.l10n.t('{0}天前', days);
    return new Date(iso).toLocaleDateString('zh-CN');
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
            vscode_1.l10n.t('状态: {0}', cfg.label),
            vscode_1.l10n.t('创建: {0}', timeAgo(task.createdAt)),
            vscode_1.l10n.t('更新: {0}', timeAgo(task.updatedAt)),
            task.sessionHint ? vscode_1.l10n.t('关联会话: {0}', task.sessionHint) : '',
        ].filter(Boolean).join('\n');
        if (task.description) {
            this.tooltip = `${task.description}\n\n${this.tooltip}`;
        }
        this.command = {
            command: 'kodrix.kanban.openSession',
            title: vscode_1.l10n.t('打开 Agent 会话'),
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
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        const data = loadKanban();
        return data.tasks
            .sort((a, b) => {
            const orderA = STATUS_CONFIG[a.status].order;
            const orderB = STATUS_CONFIG[b.status].order;
            if (orderA !== orderB)
                return orderA - orderB;
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        })
            .map(t => new KanbanTreeItem(t));
    }
    getParent() { return undefined; }
}
async function addKanbanTask() {
    if (!(0, paths_1.getKanbanPath)()) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('请先打开工作区'));
        return;
    }
    const title = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('任务标题'),
        placeHolder: vscode_1.l10n.t('实现用户登录页面'),
    });
    if (!title?.trim()) {
        return;
    }
    const description = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('任务描述（可选，将传递给 Agent）'),
        placeHolder: vscode_1.l10n.t('包含表单验证、JWT token 存储、错误提示'),
    }) || undefined;
    const status = await vscode.window.showQuickPick([
        { label: `$(circle-outline) ${vscode_1.l10n.t('待办')}`, status: 'todo' },
        { label: `$(sync) ${vscode_1.l10n.t('立即开始（进行中）')}`, status: 'in_progress' },
    ], { placeHolder: vscode_1.l10n.t('任务状态') });
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
    vscode.window.showInformationMessage(vscode_1.l10n.t('已添加任务：{0}', title));
}
async function moveKanbanTask(item) {
    if (!item?.task) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('请从看板中选择任务'));
        return;
    }
    const currentCfg = STATUS_CONFIG[item.task.status];
    const allStatuses = ['todo', 'in_progress', 'review', 'blocked', 'done'];
    const picks = allStatuses
        .filter(s => s !== item.task.status)
        .map(s => ({
        label: `${STATUS_CONFIG[s].icon === 'sync~spin' ? '$(sync~spin)' : `$(${STATUS_CONFIG[s].icon})`} ${STATUS_CONFIG[s].label}`,
        description: s === item.task.status ? vscode_1.l10n.t('（当前）') : '',
        status: s,
    }));
    const next = await vscode.window.showQuickPick(picks, {
        placeHolder: vscode_1.l10n.t('当前：{0} → 移动到…', currentCfg.label),
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
        const parts = [vscode_1.l10n.t('【Kanban 任务】{0}', title)];
        if (description)
            parts.push(vscode_1.l10n.t('\n需求描述：{0}', description));
        parts.push(vscode_1.l10n.t('\n请实施此任务。完成后更新看板状态。'));
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
        vscode.window.showWarningMessage(vscode_1.l10n.t('请从看板中选择任务'));
        return;
    }
    const confirm = await vscode.window.showQuickPick([{ label: vscode_1.l10n.t('$(trash) 确认删除'), confirm: true }, { label: vscode_1.l10n.t('取消'), confirm: false }], { placeHolder: vscode_1.l10n.t('删除「{0}」？', item.task.title) });
    if (!confirm?.confirm)
        return;
    const data = loadKanban();
    data.tasks = data.tasks.filter(t => t.id !== item.task.id);
    saveKanban(data);
    vscode.window.showInformationMessage(vscode_1.l10n.t('已删除：{0}', item.task.title));
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
    context.subscriptions.push(vscode.window.registerTreeDataProvider('kodrix.agentKanban', provider), vscode.commands.registerCommand('kodrix.kanban.addTask', async () => {
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
        await vscode.commands.executeCommand('workbench.view.explorer');
        await vscode.commands.executeCommand('kodrix.agentKanban.focus');
    }));
}
