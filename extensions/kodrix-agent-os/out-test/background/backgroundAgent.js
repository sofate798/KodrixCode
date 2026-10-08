"use strict";
/*---------------------------------------------------------------------------------------------
 *  Background Agent — 后台 Agent（对标 Cursor Background Agent）
 *
 *  能力：
 *    1. 派发后台任务：用户描述目标后立即返回任务 id，Agent 在后台异步执行（不阻塞编辑 UI）
 *    2. 执行：模型路由（smart 档）独立请求，结果写入 .kodrix/background/<id>.json
 *    3. 完成通知：任务完成/失败时 showInformationMessage / showWarningMessage 提醒
 *    4. 任务列表命令：查看全部后台任务及状态
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
exports.listBackgroundTasks = listBackgroundTasks;
exports.runBackgroundTask = runBackgroundTask;
exports.createBackgroundTask = createBackgroundTask;
exports.reconcileInterruptedTasks = reconcileInterruptedTasks;
exports.registerBackgroundAgent = registerBackgroundAgent;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const modelRouter_1 = require("../model/modelRouter");
const userProfile_1 = require("../profile/userProfile");
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
const panelTracker_1 = require("../utils/panelTracker");
/** 后台任务目录（工作区 .kodrix/background） */
function getTasksDir() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    return path.join(folder.uri.fsPath, constants_1.WORKSPACE_KODRIX_DIR, constants_1.BACKGROUND_TASKS_DIR);
}
/** 单任务文件路径 */
function getTaskFilePath(dir, id) {
    return path.join(dir, `${id}.json`);
}
function writeTask(task) {
    const dir = getTasksDir();
    if (!dir) {
        return;
    }
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(getTaskFilePath(dir, task.id), JSON.stringify(task, null, 2), 'utf-8');
    }
    catch (err) {
        logger_1.logger.error('[BackgroundAgent] 写入任务失败', err);
    }
}
/** 读取全部后台任务（新→旧） */
function listBackgroundTasks() {
    const dir = getTasksDir();
    if (!dir || !fs.existsSync(dir)) {
        return [];
    }
    try {
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
            try {
                return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
            }
            catch {
                return undefined;
            }
        })
            .filter((t) => t !== undefined)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    catch {
        return [];
    }
}
/** 执行后台任务（导出便于测试；生产由 createBackgroundTask 自动触发） */
async function runBackgroundTask(task) {
    const routed = await (0, modelRouter_1.routeModel)({ taskType: 'plan' });
    if (!routed) {
        task.status = 'failed';
        task.error = vscode_1.l10n.t('No language model available (configure a BYOK model in Manage Models)');
        task.finishedAt = new Date().toISOString();
        writeTask(task);
        await vscode.window.showWarningMessage(vscode_1.l10n.t('Background task failed: {0} (no model available)', task.title));
        return;
    }
    const cts = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => cts.cancel(), constants_1.BACKGROUND_TASK_TIMEOUT_MS);
    try {
        const profile = (0, userProfile_1.getProfileInjection)();
        const messages = [vscode.LanguageModelChatMessage.User([
                '你是一个后台 Agent（对标 Cursor Background Agent），独立完成以下任务，无需用户交互。',
                '直接输出可交付的最终成果（方案 / 代码 / 文档），使用 Markdown 结构化表达。',
                '',
                profile,
                '',
                `【后台任务】${task.title}`,
            ].join('\n'))];
        const response = await routed.model.sendRequest(messages, {}, cts.token);
        let text = '';
        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                text += chunk.value;
            }
        }
        task.result = text.slice(0, constants_1.BACKGROUND_TASK_RESULT_MAX_CHARS);
        task.status = text.trim() ? 'completed' : 'failed';
        if (task.status === 'failed') {
            task.error = vscode_1.l10n.t('The model returned no output');
        }
    }
    catch (err) {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        logger_1.logger.error('[BackgroundAgent] 任务执行失败', err);
    }
    finally {
        clearTimeout(timer);
        cts.dispose();
    }
    task.finishedAt = new Date().toISOString();
    writeTask(task);
    if (task.status === 'completed') {
        // 成功提示带"下一步动作"：直接跳到任务详情/结果，而不是只留一句"完成"
        const viewTask = vscode_1.l10n.t('View Tasks');
        const choice = await vscode.window.showInformationMessage(vscode_1.l10n.t('Background task completed: {0}', task.title), viewTask);
        if (choice === viewTask) {
            await vscode.commands.executeCommand(constants_1.COMMANDS.backgroundList);
        }
    }
    else {
        const viewTask = vscode_1.l10n.t('View Tasks');
        const choice = await vscode.window.showWarningMessage(vscode_1.l10n.t('Background task failed: {0} ({1})', task.title, task.error ?? vscode_1.l10n.t('unknown reason')), viewTask);
        if (choice === viewTask) {
            await vscode.commands.executeCommand(constants_1.COMMANDS.backgroundList);
        }
    }
}
/** 创建并派发后台任务（立即返回任务对象，后台异步执行） */
async function createBackgroundTask(title) {
    const dir = getTasksDir();
    if (!dir) {
        return undefined;
    }
    if (!title.trim()) {
        return undefined;
    }
    const id = `bg-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const task = {
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
let _backgroundPanel;
/** 后台 Agent 会话面板 HTML（任务队列 + 状态 + 结果摘要 + 点击打开详情 + 刷新） */
function renderBackgroundPanelHtml(tasks) {
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
        : vscode_1.l10n.t('<tr><td colspan="4" style="text-align:center;color:#8b949e">(no background tasks yet — run "Kodrix: Dispatch Background Task")</td></tr>');
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
<h1>${vscode_1.l10n.t('Background Agent Sessions')}</h1>
<p class="sub">${vscode_1.l10n.t('Click a task row to view the full result · {0} tasks in total', tasks.length)}</p>
<table>
<tr><th>${vscode_1.l10n.t('Task')}</th><th>${vscode_1.l10n.t('Status')}</th><th>${vscode_1.l10n.t('Created')}</th><th>${vscode_1.l10n.t('Result Summary')}</th></tr>
${rows}
</table>
<button class="btn" onclick="refresh()">${vscode_1.l10n.t('Refresh')}</button>
<div class="legend">${vscode_1.l10n.t('Status')}:<span style="color:#3fb950">completed</span> · <span style="color:#d29922">running</span> · <span style="color:#f85149">failed</span></div>
<script>const vscode=acquireVsCodeApi();function refresh(){vscode.postMessage({command:'refresh'})}function openTask(id){vscode.postMessage({command:'open',id})}</script>
</body></html>`;
}
/**
 * 任务状态收敛：进程重启后，持久化为 `running` 的任务其执行上下文已经不存在，
 * 永远不会自己变成 completed/failed —— 用户会看到"一直在运行"的僵尸任务。
 * 扩展激活时调用一次，把它们标记为失败并注明原因。
 * @returns 收敛（改写）的任务数
 */
function reconcileInterruptedTasks() {
    const dir = getTasksDir();
    if (!dir || !fs.existsSync(dir)) {
        return 0;
    }
    let reconciled = 0;
    for (const task of listBackgroundTasks()) {
        if (task.status !== 'running') {
            continue;
        }
        task.status = 'failed';
        task.error = task.error
            ? `${task.error}\n${vscode_1.l10n.t('The task was interrupted by an extension restart')}`
            : vscode_1.l10n.t('The task was interrupted by an extension restart (it will not resume on its own; dispatch it again)');
        task.finishedAt = task.finishedAt ?? new Date().toISOString();
        writeTask(task);
        reconciled++;
    }
    if (reconciled > 0) {
        logger_1.logger.info(`[BackgroundAgent] 已将 ${reconciled} 个遗留的 running 任务标记为中断`);
    }
    return reconciled;
}
function registerBackgroundAgent(context) {
    // 启动即收敛遗留状态（读盘失败不影响激活）
    try {
        reconcileInterruptedTasks();
    }
    catch (err) {
        logger_1.logger.warn(`[BackgroundAgent] 遗留任务状态收敛失败：${err instanceof Error ? err.message : String(err)}`);
    }
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.backgroundPanel, async () => {
        if (_backgroundPanel) {
            _backgroundPanel.reveal(vscode.ViewColumn.Active);
            _backgroundPanel.webview.html = renderBackgroundPanelHtml(listBackgroundTasks());
            return;
        }
        const panel = (0, panelTracker_1.createTrackedPanel)(context, 'kodrix.background', vscode_1.l10n.t('Background Agent Sessions'), vscode.ViewColumn.Active, { enableScripts: true });
        _backgroundPanel = panel;
        panel.webview.html = renderBackgroundPanelHtml(listBackgroundTasks());
        panel.onDidDispose(() => { _backgroundPanel = undefined; });
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.command === 'refresh') {
                panel.webview.html = renderBackgroundPanelHtml(listBackgroundTasks());
                return;
            }
            if (msg?.command === 'open') {
                const dir = getTasksDir();
                if (!dir) {
                    return;
                }
                try {
                    const task = JSON.parse(fs.readFileSync(getTaskFilePath(dir, msg.id), 'utf-8'));
                    const doc = await vscode.workspace.openTextDocument({ content: `# ${task.title}\n\n${vscode_1.l10n.t('Status')}: ${task.status} · ${vscode_1.l10n.t('Created')}: ${task.createdAt}\n\n${task.result ?? task.error ?? vscode_1.l10n.t('(no output)')}`, language: 'markdown' });
                    await vscode.window.showTextDocument(doc, { preview: false });
                }
                catch (err) {
                    await vscode.window.showErrorMessage(vscode_1.l10n.t('Task file is invalid or does not exist'));
                }
            }
        });
    }), vscode.commands.registerCommand(constants_1.COMMANDS.backgroundDispatch, async () => {
        const title = await vscode.window.showInputBox({
            prompt: vscode_1.l10n.t('Describe the background task goal (the Agent will complete it independently and notify you)'),
            placeHolder: vscode_1.l10n.t('e.g., investigate the project status and produce an upgrade plan'),
        });
        if (!title) {
            return;
        }
        const task = await createBackgroundTask(title);
        if (!task) {
            await vscode.window.showErrorMessage(vscode_1.l10n.t('Cannot dispatch background task (no workspace open)'));
            return;
        }
        await vscode.window.showInformationMessage(vscode_1.l10n.t('Background task dispatched: {0} (you will be notified when it completes)', task.id));
    }), vscode.commands.registerCommand(constants_1.COMMANDS.backgroundList, async () => {
        const tasks = listBackgroundTasks();
        if (!tasks.length) {
            await vscode.window.showInformationMessage(vscode_1.l10n.t('No background tasks yet. Use "Kodrix: Dispatch Background Task" to get started.'));
            return;
        }
        const doc = await vscode.workspace.openTextDocument({
            content: [
                vscode_1.l10n.t('# Kodrix Background Tasks'),
                '',
                `| ID | ${vscode_1.l10n.t('Title')} | ${vscode_1.l10n.t('Status')} | ${vscode_1.l10n.t('Created')} | ${vscode_1.l10n.t('Finished')} | ${vscode_1.l10n.t('Result Summary')} |`,
                '|----|------|------|---------|---------|---------|',
                ...tasks.map(t => {
                    const summary = (t.result || t.error || '—').split('\n')[0].slice(0, 60);
                    return `| \`${t.id}\` | ${t.title} | ${t.status} | ${t.createdAt.slice(0, 19)} | ${t.finishedAt?.slice(0, 19) ?? '—'} | ${summary} |`;
                }),
                '',
                vscode_1.l10n.t('{0} tasks in total · stored under .kodrix/background/', tasks.length),
            ].join('\n'),
            language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
    }));
}
