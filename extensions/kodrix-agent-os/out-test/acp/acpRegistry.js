"use strict";
/*---------------------------------------------------------------------------------------------
 *  ACP 外部 Agent 注册 — Devin Desktop / Agent Client Protocol 风格
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
exports.registerAcpAgent = registerAcpAgent;
exports.listAcpAgents = listAcpAgents;
exports.listAcpRuns = listAcpRuns;
exports.dispatchAcpTask = dispatchAcpTask;
exports.registerAcp = registerAcp;
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const paths_1 = require("../paths");
const logger_1 = require("../logger");
const jsonValidator_1 = require("../utils/jsonValidator");
const constants_1 = require("../shared/constants");
const featureFlags_1 = require("../utils/featureFlags");
/** 功能开关 kodrix.features.acp（默认开）：关闭时拦截会启动外部 Agent 的操作 */
function ensureAcpEnabled() {
    if ((0, featureFlags_1.isKodrixFeatureEnabled)(constants_1.FEATURE_FLAGS.acp)) {
        return true;
    }
    void vscode.window.showWarningMessage((0, featureFlags_1.featureDisabledNotice)(constants_1.FEATURE_FLAGS.acp));
    return false;
}
function loadRegistry() {
    const p = (0, paths_1.getAcpAgentsPath)();
    if (!fs.existsSync(p)) {
        return { agents: [] };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if ((0, jsonValidator_1.isRecord)(raw) && Array.isArray(raw.agents)) {
            return raw;
        }
        logger_1.logger.warn('[AcpRegistry] loadRegistry: invalid shape — resetting');
        return { agents: [] };
    }
    catch {
        return { agents: [] };
    }
}
function saveRegistry(data) {
    const p = (0, paths_1.getAcpAgentsPath)();
    (0, paths_1.ensureDir)(p.replace(/[/\\][^/\\]+$/, ''));
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}
async function registerAcpAgent() {
    const name = await vscode.window.showInputBox({ prompt: vscode_1.l10n.t('Agent Name'), placeHolder: 'My Custom Agent' });
    if (!name?.trim()) {
        return;
    }
    const command = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Launch command (ACP compatible)'),
        placeHolder: 'npx my-agent-cli --acp',
    });
    if (!command?.trim()) {
        return;
    }
    const description = await vscode.window.showInputBox({ prompt: vscode_1.l10n.t('Description (optional)') }) || undefined;
    const registry = loadRegistry();
    const entry = {
        id: `acp-${Date.now()}`,
        name: name.trim(),
        command: command.trim(),
        description,
        protocol: 'acp',
        enabled: true,
        registeredAt: new Date().toISOString(),
    };
    registry.agents.push(entry);
    saveRegistry(registry);
    vscode.window.showInformationMessage(vscode_1.l10n.t('ACP Agent registered: {0} (~/.kodrix/acp/agents.json)', name));
}
async function listAcpAgents() {
    const registry = loadRegistry();
    if (!registry.agents.length) {
        vscode.window.showInformationMessage(vscode_1.l10n.t('No ACP Agents yet. Add one via "Register ACP External Agent".'));
        return;
    }
    const doc = await vscode.workspace.openTextDocument({
        content: [
            `# ${vscode_1.l10n.t('ACP External Agent List')}`,
            '',
            ...registry.agents.map(a => `- **${a.name}** (\`${a.id}\`)\n  - ${vscode_1.l10n.t('Command')}: \`${a.command}\`\n  - ${vscode_1.l10n.t('Status')}: ${a.enabled ? vscode_1.l10n.t('Enabled') : vscode_1.l10n.t('Disabled')}\n  - ${a.description || ''}`),
            '',
            `${vscode_1.l10n.t('Config file')}: \`~/.kodrix/acp/agents.json\``,
        ].join('\n'),
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc);
}
function getRunsDir() {
    return path.join((0, paths_1.getKodrixDir)(), 'acp', 'runs');
}
function writeRun(run) {
    (0, paths_1.ensureDir)(getRunsDir());
    fs.writeFileSync(path.join(getRunsDir(), `${run.id}.json`), JSON.stringify(run, null, 2), 'utf-8');
}
/** 读取历史委派运行（新→旧） */
function listAcpRuns() {
    if (!fs.existsSync(getRunsDir())) {
        return [];
    }
    try {
        return fs.readdirSync(getRunsDir())
            .filter(f => f.endsWith('.json'))
            .map(f => {
            try {
                return JSON.parse(fs.readFileSync(path.join(getRunsDir(), f), 'utf-8'));
            }
            catch {
                return undefined;
            }
        })
            .filter((r) => r !== undefined)
            .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    }
    catch {
        return [];
    }
}
/** 超时后给 close 事件的宽限期：超过则强制结算，避免 Promise 永不 settle */
const TIMEOUT_SETTLE_GRACE_MS = 2000;
/**
 * 杀掉整个进程树。
 * `shell: true` 会先起一个 shell（Windows 上是 cmd.exe），直接 `child.kill()` 只杀掉 shell，
 * 其孙进程仍持有继承来的 stdout/stderr 管道 → Node 的 `close` 事件永不触发 → Promise 挂死。
 * Windows 用 `taskkill /T /F` 连子树一起杀；POSIX 用 SIGKILL。
 */
function killProcessTree(child) {
    if (!child?.pid) {
        return;
    }
    try {
        if (process.platform === 'win32') {
            (0, child_process_1.spawnSync)('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
        }
        else {
            child.kill('SIGKILL');
        }
    }
    catch {
        // 进程可能已退出
    }
}
/** 委派任务给外部 ACP Agent（stdio JSONL 简化协议：stdin 发 task 行，stdout 收 text/纯文本行） */
async function dispatchAcpTask(agent, task, timeoutMs = 600_000, token) {
    const id = `acp-run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const run = {
        id,
        agentId: agent.id,
        agentName: agent.name,
        task,
        status: 'failed',
        output: '',
        startedAt: new Date().toISOString(),
    };
    // 信任校验下沉到派发函数本身：它是导出 API，其它模块复用时不经过命令层的门禁
    if (vscode.workspace.isTrusted === false) {
        run.error = vscode_1.l10n.t('ACP delegation is disabled in untrusted workspaces (trust the workspace first).');
        run.finishedAt = new Date().toISOString();
        run.durationMs = 0;
        writeRun(run);
        return run;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const started = Date.now();
    return await new Promise(resolve => {
        let child;
        try {
            child = (0, child_process_1.spawn)(agent.command, [], { shell: true, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        }
        catch (err) {
            run.status = 'failed';
            run.error = err instanceof Error ? err.message : String(err);
            run.finishedAt = new Date().toISOString();
            run.durationMs = Date.now() - started;
            writeRun(run);
            resolve(run);
            return;
        }
        let timedOut = false;
        /** 幂等结算：close / error / 超时兜底 三者谁先来谁生效，保证 Promise 一定会 settle */
        let settled = false;
        let settleFallback;
        /** 取消订阅：结算时释放，避免长时间挂着的监听 */
        let cancelSubscription;
        /** stdout 跨 chunk 行缓冲（避免 JSONL 被截断） */
        let stdoutBuf = '';
        /** 输出上限，防止外部 agent 无限输出撑爆内存 */
        const OUTPUT_MAX_CHARS = 2 * 1024 * 1024;
        const ERROR_MAX_CHARS = 1 * 1024 * 1024;
        let outputTruncated = false;
        let errorTruncated = false;
        const appendOutput = (text) => {
            if (outputTruncated || !text) {
                return;
            }
            const next = run.output ? `${run.output}\n${text}` : text;
            if (next.length > OUTPUT_MAX_CHARS) {
                run.output = next.slice(0, OUTPUT_MAX_CHARS);
                outputTruncated = true;
                run.error = (run.error ? run.error + '\n' : '') + vscode_1.l10n.t('Output truncated (>{0} characters)', String(OUTPUT_MAX_CHARS));
                return;
            }
            run.output = next;
        };
        const appendError = (text) => {
            if (errorTruncated || !text) {
                return;
            }
            const next = run.error ? `${run.error}\n${text}` : text;
            if (next.length > ERROR_MAX_CHARS) {
                run.error = next.slice(0, ERROR_MAX_CHARS) + '\n' + vscode_1.l10n.t('stderr truncated (>{0} characters)', String(ERROR_MAX_CHARS));
                errorTruncated = true;
                return;
            }
            run.error = next;
        };
        const consumeStdoutLine = (line) => {
            const lineText = line.trim();
            if (!lineText) {
                return;
            }
            try {
                const msg = JSON.parse(lineText);
                if (msg && typeof msg === 'object' && typeof msg.content === 'string') {
                    appendOutput(msg.content);
                    return;
                }
            }
            catch { /* 非 JSONL 行按纯文本收集 */ }
            appendOutput(lineText);
        };
        /** 幂等结算：close / error / 超时兜底 谁先到谁生效，并清理定时器与尾部缓冲 */
        const settle = (finalize) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (settleFallback) {
                clearTimeout(settleFallback);
            }
            cancelSubscription?.dispose();
            cancelSubscription = undefined;
            if (stdoutBuf.trim()) {
                consumeStdoutLine(stdoutBuf);
                stdoutBuf = '';
            }
            finalize();
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
            // close 事件可能永不触发（被杀进程的孙进程仍持有管道）→ 宽限期后强制结算
            settleFallback = setTimeout(() => {
                settle(() => {
                    run.status = 'timeout';
                    run.error = (run.error ? run.error + '\n' : '') + vscode_1.l10n.t('Timed out (>{0}ms; the process tree did not exit within the grace period)', String(timeoutMs));
                    run.finishedAt = new Date().toISOString();
                    run.durationMs = Date.now() - started;
                    writeRun(run);
                    resolve(run);
                });
            }, TIMEOUT_SETTLE_GRACE_MS);
        }, timeoutMs);
        // 用户取消：杀掉进程树并立即结算（此前 10 分钟内界面毫无反应、也无法中断）
        if (token) {
            cancelSubscription = token.onCancellationRequested(() => {
                killProcessTree(child);
                settleFallback = setTimeout(() => {
                    settle(() => {
                        run.status = 'cancelled';
                        run.error = (run.error ? run.error + '\n' : '') + vscode_1.l10n.t('Cancelled by the user (process tree terminated)');
                        run.finishedAt = new Date().toISOString();
                        run.durationMs = Date.now() - started;
                        writeRun(run);
                        resolve(run);
                    });
                }, TIMEOUT_SETTLE_GRACE_MS);
            });
        }
        child.stdout?.on('data', (chunk) => {
            stdoutBuf += String(chunk);
            const parts = stdoutBuf.split(/\r?\n/);
            stdoutBuf = parts.pop() ?? '';
            for (const line of parts) {
                consumeStdoutLine(line);
            }
        });
        child.stderr?.on('data', (chunk) => {
            appendError(String(chunk).trim());
        });
        child.on('error', (err) => {
            settle(() => {
                run.status = 'failed';
                run.error = err.message;
                run.finishedAt = new Date().toISOString();
                run.durationMs = Date.now() - started;
                writeRun(run);
                resolve(run);
            });
        });
        child.on('close', (code) => {
            settle(() => {
                if (timedOut) {
                    run.status = 'timeout';
                    run.error = (run.error ? run.error + '\n' : '') + vscode_1.l10n.t('Timed out (>{0}ms)', String(timeoutMs));
                }
                else {
                    run.status = code === 0 ? 'completed' : 'failed';
                    if (code !== 0 && !run.error) {
                        run.error = vscode_1.l10n.t('Exit code {0}', String(code));
                    }
                }
                run.finishedAt = new Date().toISOString();
                run.durationMs = Date.now() - started;
                writeRun(run);
                resolve(run);
            });
        });
        child.stdin?.on('error', () => { });
        try {
            child.stdin?.write(`${JSON.stringify({ type: 'task', task })}\n`, 'utf-8');
        }
        catch { /* 同上 */ }
    });
}
function renderAcpRunMarkdown(run) {
    return [
        vscode_1.l10n.t('# ACP Delegation Result: {0}', run.agentName),
        '',
        `- ${vscode_1.l10n.t('Task')}: ${run.task}`,
        `- ${vscode_1.l10n.t('Status')}: ${run.status}`,
        `- ${vscode_1.l10n.t('Started')}: ${run.startedAt} · ${vscode_1.l10n.t('Duration')}: ${run.durationMs ?? '—'}ms`,
        (run.error ? `- ${vscode_1.l10n.t('Error')}: ${run.error}` : ''),
        '',
        `## ${vscode_1.l10n.t('Output')}`,
        '',
        run.output || vscode_1.l10n.t('(no output)'),
    ].filter(x => x !== '').join('\n');
}
async function dispatchAcpCommand() {
    if (!vscode.workspace.isTrusted) {
        // ACP 会以 shell 执行已注册的外部 Agent 命令，不受信任工作区一律不派发
        await vscode.window.showWarningMessage(vscode_1.l10n.t('ACP delegation is disabled in untrusted workspaces (trust the workspace first).'));
        return;
    }
    const registry = loadRegistry();
    const enabled = registry.agents.filter(a => a.enabled);
    if (!enabled.length) {
        await vscode.window.showWarningMessage(vscode_1.l10n.t('No enabled ACP Agents. Use "Register External ACP Agent" first.'));
        return;
    }
    const picked = await vscode.window.showQuickPick(enabled.map(a => ({ label: a.name, description: a.command, agent: a })), { placeHolder: vscode_1.l10n.t('Select an external Agent to delegate the task to') });
    if (!picked) {
        return;
    }
    const task = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Task description (for {0})', picked.label),
        placeHolder: vscode_1.l10n.t('e.g., analyze duplicate code under src/ and produce a report'),
    });
    if (!task?.trim()) {
        return;
    }
    const run = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode_1.l10n.t('Kodrix: Delegating to ACP {0}…', picked.label), cancellable: true }, async (_progress, token) => dispatchAcpTask(picked.agent, task.trim(), 600_000, token));
    const doc = await vscode.workspace.openTextDocument({ content: renderAcpRunMarkdown(run), language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    // 结果通知带"下一步动作"：结果文档已经打开，但用户往往还想回看历史/再派一次
    const viewHistory = vscode_1.l10n.t('View Delegation History');
    if (run.status === 'completed') {
        const choice = await vscode.window.showInformationMessage(vscode_1.l10n.t('ACP Agent {0} task completed', run.agentName), viewHistory);
        if (choice === viewHistory) {
            await listAcpRunsCommand();
        }
    }
    else {
        const choice = await vscode.window.showWarningMessage(vscode_1.l10n.t('ACP Agent {0} task {1}', run.agentName, run.status === 'timeout' ? vscode_1.l10n.t('timed out') : vscode_1.l10n.t('failed')), viewHistory);
        if (choice === viewHistory) {
            await listAcpRunsCommand();
        }
    }
}
async function listAcpRunsCommand() {
    const runs = listAcpRuns();
    const doc = await vscode.workspace.openTextDocument({
        content: [
            `# ${vscode_1.l10n.t('ACP Delegation History')}`,
            '',
            ...(runs.length ? runs.map(r => `- **${r.agentName}** (${r.status}) ${r.startedAt} — ${r.task}`) : [vscode_1.l10n.t('(no delegation records yet)')]),
            '',
            `${vscode_1.l10n.t('Records directory')}: \`~/.kodrix/acp/runs/\``,
        ].join('\n'),
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc);
}
function registerAcp(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.acp.register', async () => {
        if (!ensureAcpEnabled()) {
            return;
        }
        await registerAcpAgent();
    }), vscode.commands.registerCommand('kodrix.acp.list', () => listAcpAgents()), vscode.commands.registerCommand('kodrix.acp.dispatch', async () => {
        if (!ensureAcpEnabled()) {
            return;
        }
        await dispatchAcpCommand();
    }), vscode.commands.registerCommand('kodrix.acp.runs', () => listAcpRunsCommand()));
    (0, paths_1.ensureDir)((0, paths_1.getAcpAgentsPath)().replace(/[/\\][^/\\]+$/, ''));
}
