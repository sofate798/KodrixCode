"use strict";
/*---------------------------------------------------------------------------------------------
 *  Agent Crew v2 — 多智能体协作编排框架（真并行执行引擎）
 *  大厂对标：Devin multi-agent · Cursor parallel subagents · Windsurf cascade
 *
 *  v2 核心升级（对标 Cursor Subagent 并行派生）：
 *  1. 真并行执行 — runAll 通过 vscode.lm 同时驱动所有可运行任务（Promise.allSettled + 并发池）
 *  2. 跨 Agent 上下文传递 — 依赖任务的输出自动注入下游任务 prompt，无需人工搬运
 *  3. 自动状态推进 — 任务完成后自动写回 crew.json，级联触发下一波可运行任务
 *  4. 双执行模式 — auto（后台并行 LLM 执行）/ chat（打开 Agent 面板带工具执行）
 *
 *  工程化标准（与 Arena / IdeaFlow 保持一致）：
 *  - CancellationTokenSource 在 finally 中 dispose，防止资源泄漏
 *  - 原子文件写入（先写临时文件再 rename），防止进程崩溃产生不完整 crew.json
 *  - 单任务失败不阻塞同波其它任务（Promise.allSettled），失败原因记录到任务
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
exports.loadCrew = loadCrew;
exports.saveCrew = saveCrew;
exports.createCrew = createCrew;
exports.addCrewTask = addCrewTask;
exports.chunkTasks = chunkTasks;
exports.getNextRunnableTasks = getNextRunnableTasks;
exports.buildTaskContext = buildTaskContext;
exports.readCrewSharedContext = readCrewSharedContext;
exports.updateCrewSharedContext = updateCrewSharedContext;
exports.runAllRunnableTasks = runAllRunnableTasks;
exports.runNextTask = runNextTask;
exports.markTaskComplete = markTaskComplete;
exports.showCrewStatus = showCrewStatus;
exports.registerAgentCrew = registerAgentCrew;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const paths_1 = require("../paths");
const logger_1 = require("../logger");
const modelRouter_1 = require("../model/modelRouter");
const userProfile_1 = require("../profile/userProfile");
const jsonValidator_1 = require("../utils/jsonValidator");
const constants_1 = require("../shared/constants");
// ── 预定义 Agent 角色 ────────────────────────────────────────────
const ROLE_DEFS = {
    architect: {
        role: 'architect',
        name: 'Architect (架构师)',
        systemPrompt: `你是项目架构师。职责：
- 分析需求，输出技术方案和架构设计
- 定义模块边界、API 契约、数据模型
- 产出 Spec 文档（requirements / design / tasks）
- 不写具体代码实现，只做设计决策`,
        tools: ['read_file', 'search_files', 'chat'],
    },
    coder: {
        role: 'coder',
        name: 'Coder (开发者)',
        systemPrompt: `你是高级开发者。职责：
- 根据架构师的设计实现具体代码
- 遵循项目 Memory 和 Learning 中的约定
- 编写可测试、可维护的代码
- 自动运行测试验证`,
        tools: ['read_file', 'search_files', 'edit_file', 'terminal'],
    },
    reviewer: {
        role: 'reviewer',
        name: 'Reviewer (审查者)',
        systemPrompt: `你是代码审查者。职责：
- 审查 Coder 提交的代码变更
- 检查：安全漏洞、性能问题、代码风格、测试覆盖
- 给出具体修改建议
- 通过后标记为 APPROVED`,
        tools: ['read_file', 'search_files', 'git_diff'],
    },
    tester: {
        role: 'tester',
        name: 'Tester (测试者)',
        systemPrompt: `你是测试工程师。职责：
- 根据代码和 Spec 生成测试用例
- 覆盖边界条件、异常路径、性能基准
- 使用项目测试框架（Jest / Vitest / pytest）
- 报告测试结果和缺失的覆盖`,
        tools: ['read_file', 'search_files', 'edit_file', 'terminal'],
    },
    devops: {
        role: 'devops',
        name: 'DevOps (运维)',
        systemPrompt: `你是 DevOps 工程师。职责：
- 配置 CI/CD、Docker、部署脚本
- 管理环境变量、密钥、基础设施
- 监控和日志配置`,
        tools: ['read_file', 'edit_file', 'terminal'],
    },
    custom: {
        role: 'custom',
        name: 'Custom Agent',
        systemPrompt: '自定义 Agent 角色',
        tools: ['read_file', 'search_files', 'edit_file', 'terminal'],
    },
};
// ── Crew 配置管理 ────────────────────────────────────────────────
function getCrewPath() {
    const base = (0, paths_1.getWorkspaceKodrixDir)();
    return base ? path.join(base, 'crew.json') : undefined;
}
function loadCrew() {
    const p = getCrewPath();
    if (!p || !fs.existsSync(p))
        return undefined;
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if ((0, jsonValidator_1.isRecord)(raw) && (0, jsonValidator_1.isString)(raw.name) && (0, jsonValidator_1.isString)(raw.workflow)
            && Array.isArray(raw.tasks)
            && Array.isArray(raw.agents)) {
            return raw;
        }
        logger_1.logger.warn('[AgentCrew] loadCrew: invalid shape — ignoring');
        return undefined;
    }
    catch {
        return undefined;
    }
}
/** 原子写入 crew.json：先写临时文件再 rename，防止进程崩溃产生不完整配置 */
function saveCrew(config) {
    const p = getCrewPath();
    if (!p)
        return;
    (0, paths_1.ensureDir)(path.dirname(p));
    config.updatedAt = new Date().toISOString();
    const tmpPath = p + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpPath, p);
}
// ── Crew 创建 ───────────────────────────────────────────────────
async function createCrew() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('请先打开工作区'));
        return undefined;
    }
    // Step 1: Name
    const name = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Crew 名称'),
        placeHolder: 'feature-payment-system',
    });
    if (!name?.trim())
        return undefined;
    // Step 2: Workflow type
    const workflowPick = await vscode.window.showQuickPick([
        { label: '$(list-ordered) ' + vscode_1.l10n.t('顺序流水线'), description: vscode_1.l10n.t('Architect → Coder → Reviewer → Tester，依次执行'), name: vscode_1.l10n.t('顺序流水线'), value: 'sequential' },
        { label: '$(run-all) ' + vscode_1.l10n.t('并行协作'), description: vscode_1.l10n.t('多个 Coder 同时工作，最后 Reviewer 审查'), name: vscode_1.l10n.t('并行协作'), value: 'parallel' },
        { label: '$(pass) ' + vscode_1.l10n.t('审批门'), description: vscode_1.l10n.t('每个阶段需 Reviewer 批准才能进入下一阶段'), name: vscode_1.l10n.t('审批门'), value: 'review-gate' },
    ], { placeHolder: vscode_1.l10n.t('选择协作模式') });
    if (!workflowPick)
        return undefined;
    // Step 3: Select roles
    const availableRoles = ['architect', 'coder', 'reviewer', 'tester'];
    const rolePicks = await vscode.window.showQuickPick(availableRoles.map(r => ({
        label: `${ROLE_DEFS[r].name}`,
        description: ROLE_DEFS[r].systemPrompt.slice(0, 60) + '…',
        picked: r === 'coder' || r === 'reviewer',
        role: r,
    })), { canPickMany: true, placeHolder: vscode_1.l10n.t('选择参与角色（多选）') });
    if (!rolePicks?.length)
        return undefined;
    // Build agents
    const agents = rolePicks.map(rp => ({
        id: `${name.trim().replace(/\s+/g, '-')}-${rp.role}`,
        ...ROLE_DEFS[rp.role],
    }));
    const config = {
        name: name.trim(),
        description: `${rolePicks.map(r => ROLE_DEFS[r.role].name).join(' + ')} · ${workflowPick.name}`,
        workflow: workflowPick.value,
        agents,
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    saveCrew(config);
    vscode.window.showInformationMessage(vscode_1.l10n.t('Agent Crew「{0}」已创建 — {1} 个角色，{2}', config.name, agents.length, workflowPick.name));
    return config;
}
// ── 任务管理 ────────────────────────────────────────────────────
async function addCrewTask(config) {
    const crew = config || loadCrew();
    if (!crew) {
        await vscode.window.showWarningMessage(vscode_1.l10n.t('未找到 Crew 配置。请先创建 Crew。'));
        return;
    }
    const title = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('任务标题'),
        placeHolder: vscode_1.l10n.t('实现用户认证模块'),
    });
    if (!title?.trim())
        return;
    const description = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('任务描述（可选）'),
        placeHolder: vscode_1.l10n.t('包含 JWT、session、OAuth 等…'),
    }) || '';
    // Select role
    const rolePick = await vscode.window.showQuickPick(crew.agents.map(a => ({
        label: a.name,
        description: a.role,
        role: a.role,
    })), { placeHolder: vscode_1.l10n.t('分配角色') });
    if (!rolePick)
        return;
    const modePick = await vscode.window.showQuickPick([
        { label: '$(play) ' + vscode_1.l10n.t('自动执行（后台并行）'), description: vscode_1.l10n.t('vscode.lm 并行驱动，完成后自动推进，输出写入任务结果'), mode: 'auto' },
        { label: '$(comment-discussion) ' + vscode_1.l10n.t('手动执行（Agent 面板）'), description: vscode_1.l10n.t('打开 Agent Chat，可带工具执行，完成后手动标记'), mode: 'chat' },
    ], { placeHolder: vscode_1.l10n.t('执行模式（默认自动）') });
    const mode = modePick?.mode ?? 'auto';
    const depPick = await vscode.window.showQuickPick([{ label: vscode_1.l10n.t('（无依赖）'), taskId: '' }, ...crew.tasks.map(t => ({ label: t.title, taskId: t.id }))], { canPickMany: true, placeHolder: vscode_1.l10n.t('前置依赖任务（可多选，无则跳过）') });
    const task = {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: title.trim(),
        description,
        assignedRole: rolePick.role,
        dependencies: (depPick || []).filter(d => d.taskId).map(d => d.taskId),
        status: 'pending',
        mode,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    crew.tasks.push(task);
    saveCrew(crew);
    vscode.window.showInformationMessage(vscode_1.l10n.t('已添加任务：{0} → {1}（{2}）', title, rolePick.label, mode === 'auto' ? vscode_1.l10n.t('自动执行') : vscode_1.l10n.t('手动执行')));
}
// ── v2 并行执行引擎 ─────────────────────────────────────────────
/**
 * 将数组按指定大小分批（每批内任务相互独立，可并行执行）。
 * 纯函数，便于单元测试。
 */
function chunkTasks(items, size) {
    if (size < 1)
        size = 1;
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}
/**
 * 返回所有「可运行」任务：pending 且依赖全部 completed。
 * 纯函数，便于单元测试。
 */
function getNextRunnableTasks(crew) {
    const completed = new Set(crew.tasks.filter(t => t.status === 'completed').map(t => t.id));
    return crew.tasks.filter(t => t.status === 'pending' &&
        t.dependencies.every(depId => completed.has(depId)));
}
/**
 * 组装单任务的 LLM 上下文：系统角色 + 任务描述 + 上游依赖任务输出（跨 Agent 上下文传递）。
 * 纯函数（不依赖 vscode API），便于单元测试。
 */
function buildTaskContext(crew, task, opts) {
    const roleDef = ROLE_DEFS[task.assignedRole] ?? ROLE_DEFS.custom;
    const maxDepChars = opts?.maxDepChars ?? constants_1.CREW_CONTEXT_MAX_CHARS;
    // 依赖任务输出注入（按声明顺序拼接，超过上限截断）
    const depBlocks = [];
    let depChars = 0;
    for (const depId of task.dependencies) {
        const dep = crew.tasks.find(t => t.id === depId);
        if (!dep)
            continue;
        if (dep.result) {
            const remain = maxDepChars - depChars;
            if (remain <= 0)
                break;
            const snippet = dep.result.length > remain
                ? dep.result.slice(0, remain) + '\n…(上下文截断)'
                : dep.result;
            depBlocks.push(`### 上游任务「${dep.title}」的输出\n${snippet}`);
            depChars += snippet.length;
        }
        else {
            depBlocks.push(`### 上游任务「${dep.title}」\n（该任务无输出，状态：${dep.status}）`);
        }
    }
    const depsText = depBlocks.length ? depBlocks.join('\n\n') : '（无）';
    const system = [
        roleDef.systemPrompt,
        '',
        `你是 Kodrix Agent Crew「${crew.name}」中的${roleDef.name}。`,
        '请独立完成分配给你的任务，直接给出最终成果（设计决策 / 代码实现 / 审查意见 / 测试方案 / 运维脚本等），不要提问、不要输出过程性闲聊。',
        '你的输出将原样写入任务结果，并作为下游任务的输入上下文，因此请输出结构化、可直接复用的内容。',
    ].join('\n');
    const user = [
        `【Agent Crew 任务】${task.title}`,
        `角色：${roleDef.name}`,
        '',
        task.description ? `需求描述：${task.description}` : '',
        '',
        '## 上游依赖上下文',
        depsText,
        ...(opts?.sharedContext ? ['## 团队共享上下文（此前任务成果）', opts.sharedContext.slice(0, maxDepChars), ''] : []),
        '',
        '## 输出要求',
        '- 直接输出最终成果，使用 Markdown 结构化表达',
        '- 如包含代码，用代码块标注语言',
        '- 末尾附一行「[DONE]」表示任务完成',
    ].join('\n');
    return { system, user };
}
/**
 * 选择 Crew 执行模型：优先任务/角色指定的 model → 按通用模型族查找 → 兜底第一个可用。
 */
async function selectCrewModel(preferredName, taskType) {
    try {
        const routed = await (0, modelRouter_1.routeModel)({ preferred: preferredName, taskType });
        return routed?.model;
    }
    catch (err) {
        logger_1.logger.warn('[AgentCrew] model routing failed', err);
        return undefined;
    }
}
/** 角色 → 任务类型（供模型路由选档） */
function roleToTaskType(role) {
    switch (role) {
        case 'architect': return 'plan';
        case 'reviewer': return 'review';
        case 'devops': return 'terminal';
        default: return 'coding';
    }
}
/** Crew 共享上下文文件路径（工作区 .kodrix/crew-context.md） */
function getCrewContextPath() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder)
        return undefined;
    return path.join(folder.uri.fsPath, '.kodrix', 'crew-context.md');
}
/** 读取团队共享上下文（此前任务成果摘要，跨 Agent 传递） */
function readCrewSharedContext(maxChars = constants_1.CREW_CONTEXT_MAX_CHARS) {
    const p = getCrewContextPath();
    if (!p || !fs.existsSync(p))
        return '';
    try {
        const t = fs.readFileSync(p, 'utf-8');
        return t.slice(-maxChars);
    }
    catch (err) {
        logger_1.logger.warn('[AgentCrew] 读取共享上下文失败', err);
        return '';
    }
}
/** 任务执行后追加成果摘要到团队共享上下文 */
function updateCrewSharedContext(_crew, task) {
    const p = getCrewContextPath();
    if (!p)
        return;
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const summary = (task.result || task.error || '').slice(0, constants_1.CREW_RESULT_MAX_CHARS);
        const line = `\n## [${task.updatedAt}] ${task.title}（${task.assignedRole} · ${task.status}）\n${summary}\n`;
        fs.appendFileSync(p, line, 'utf-8');
        logger_1.logger.info(`[AgentCrew] 共享上下文已更新（${task.title}）`);
    }
    catch (err) {
        logger_1.logger.warn('[AgentCrew] 写入共享上下文失败', err);
    }
}
/**
 * 执行单个任务（auto 模式）：独立 LLM 请求 + 独立上下文，可与其他任务并行。
 * 结果写入 task.result / task.status / task.executionMs / task.error。
 */
async function executeTaskAuto(crew, task) {
    const start = Date.now();
    const agent = crew.agents.find(a => a.role === task.assignedRole);
    const model = await selectCrewModel(agent?.model, roleToTaskType(task.assignedRole));
    if (!model) {
        task.status = 'failed';
        task.error = '无可用语言模型（请在 Manage Models 中配置 BYOK 模型）';
        task.executionMs = Date.now() - start;
        task.updatedAt = new Date().toISOString();
        return;
    }
    const { system, user } = buildTaskContext(crew, task, { sharedContext: readCrewSharedContext(3000) });
    const cts = new vscode.CancellationTokenSource();
    const timeoutMs = vscode.workspace.getConfiguration(constants_1.CREW_CONFIG)
        .get(constants_1.CREW_CONFIG_KEYS.timeoutMs, constants_1.CREW_TASK_TIMEOUT_MS);
    const timeoutId = setTimeout(() => cts.cancel(), timeoutMs);
    try {
        // 系统提示与任务上下文合为单条 User 消息（当前 vscode.d.ts 仅提供 User/Assistant 构造器）
        const profile = (0, userProfile_1.getProfileInjection)();
        const messages = [vscode.LanguageModelChatMessage.User(`${system}\n\n${profile}\n\n${user}`)];
        const response = await model.sendRequest(messages, {}, cts.token);
        let text = '';
        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                text += chunk.value;
            }
        }
        task.result = text.slice(0, constants_1.CREW_RESULT_MAX_CHARS);
        task.status = text.trim() ? 'completed' : 'failed';
        if (task.status === 'failed') {
            task.error = '模型无响应输出';
        }
        logger_1.logger.info(`[AgentCrew] 任务「${task.title}」${task.status}（${Date.now() - start}ms）`);
    }
    catch (err) {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        logger_1.logger.error(`[AgentCrew] 任务「${task.title}」执行失败`, err);
    }
    finally {
        clearTimeout(timeoutId);
        cts.dispose();
    }
    task.executionMs = Date.now() - start;
    task.updatedAt = new Date().toISOString();
    updateCrewSharedContext(crew, task);
}
/**
 * v2 主调度器：并行执行所有可运行任务（对标 Cursor Subagent 并行派生）。
 * - 循环取「可运行波次」→ 标记 running → 受限并发池并行执行 → 自动写回结果 → 级联下一波
 * - chat 模式任务不自动执行，保持 pending 并提示
 */
async function runAllRunnableTasks(crew) {
    const maxParallel = vscode.workspace.getConfiguration(constants_1.CREW_CONFIG)
        .get(constants_1.CREW_CONFIG_KEYS.maxParallel, constants_1.CREW_DEFAULT_MAX_PARALLEL);
    let runnable = getNextRunnableTasks(crew).filter(t => t.mode !== 'chat');
    const chatPending = crew.tasks.some(t => t.mode === 'chat' && t.status === 'pending');
    if (!runnable.length) {
        vscode.window.showInformationMessage(chatPending
            ? vscode_1.l10n.t('没有可自动执行的任务（存在 chat 模式任务，请用「执行下一个 Crew 任务」在 Agent 面板中完成）')
            : vscode_1.l10n.t('没有可执行任务（全部完成或依赖未就绪）'));
        return;
    }
    const executed = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode_1.l10n.t('Agent Crew「{0}」并行执行中…', crew.name), cancellable: false }, async () => {
        let wave = 0;
        while (runnable.length) {
            wave++;
            for (const t of runnable) {
                t.status = 'running';
                t.updatedAt = new Date().toISOString();
            }
            saveCrew(crew);
            logger_1.logger.info(`[AgentCrew] wave ${wave}: 并行执行 ${runnable.length} 个任务（并发上限 ${maxParallel}）`);
            // 同波任务相互无依赖，分批并行执行
            for (const chunk of chunkTasks(runnable, maxParallel)) {
                await Promise.allSettled(chunk.map(t => executeTaskAuto(crew, t)));
            }
            // 自动写回结果与状态
            for (const t of runnable) {
                executed.push(t);
                if (t.status === 'failed') {
                    logger_1.logger.warn(`[AgentCrew] 任务「${t.title}」失败：${t.error ?? ''}`);
                }
            }
            saveCrew(crew);
            // 下一波：仅当本波有新完成任务，才可能有新解除依赖的任务
            const newlyCompleted = runnable.some(t => t.status === 'completed');
            if (!newlyCompleted)
                break;
            runnable = getNextRunnableTasks(crew).filter(t => t.mode !== 'chat');
        }
    });
    const completed = executed.filter(t => t.status === 'completed').length;
    const failed = executed.filter(t => t.status === 'failed').length;
    vscode.window.showInformationMessage(vscode_1.l10n.t('Crew「{0}」执行结束：{1} 完成 / {2} 失败 / {3} 个任务', crew.name, completed, failed, executed.length));
    await showCrewExecutionReport(crew, executed);
}
/** 生成并打开执行报告（Markdown）：任务明细 + 输出全文 + 待办提示 */
async function showCrewExecutionReport(crew, executed) {
    const pendingTasks = crew.tasks.filter(t => t.status === 'pending');
    const lines = [
        `# Agent Crew 执行报告: ${crew.name}`,
        '',
        `> ${crew.description ?? ''}`,
        `> 执行时间：${new Date().toLocaleString()}`,
        '',
        '## 汇总',
        '',
        '| 状态 | 数量 |',
        '|------|------|',
        `| 完成 | ${executed.filter(t => t.status === 'completed').length} |`,
        `| 失败 | ${executed.filter(t => t.status === 'failed').length} |`,
        `| 待办（含 chat 模式） | ${pendingTasks.length} |`,
        '',
        '## 任务明细',
        '',
        ...executed.flatMap(t => {
            const status = t.status === 'completed' ? '完成' : '失败';
            const ms = t.executionMs !== undefined ? `（${t.executionMs}ms）` : '';
            return [
                `### [${status}] ${t.title} → ${t.assignedRole}${ms}`,
                '',
                t.error ? `> 错误：${t.error}` : '',
                t.result ?? '（无输出）',
                '',
                '---',
                '',
            ].filter(Boolean);
        }),
        '## 待办提示',
        '',
        ...(pendingTasks.length
            ? pendingTasks.map(t => `- ${t.title}（依赖：${t.dependencies.map(d => crew.tasks.find(tt => tt.id === d)?.title ?? d).join(', ') || '无'}）`)
            : ['- 全部任务已处理完毕']),
        crew.tasks.some(t => t.mode === 'chat' && t.status === 'pending')
            ? '> 注：chat 模式任务需通过「Kodrix: 执行下一个 Crew 任务」在 Agent 面板中手动完成。'
            : '',
    ].filter(Boolean);
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(doc);
}
// ── Crew 执行（v1 兼容：单任务 / 手动模式） ─────────────────────
async function runNextTask(crew) {
    const runnable = getNextRunnableTasks(crew);
    if (!runnable.length)
        return undefined;
    // Pick highest priority (first in order, or by role priority)
    const order = ['architect', 'coder', 'tester', 'reviewer', 'devops'];
    runnable.sort((a, b) => order.indexOf(a.assignedRole) - order.indexOf(b.assignedRole));
    const task = runnable[0];
    // Mark as running
    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    saveCrew(crew);
    // Open an Agent chat with the task context
    const agent = crew.agents.find(a => a.role === task.assignedRole);
    const agentRole = agent?.role || task.assignedRole;
    const roleDef = ROLE_DEFS[agentRole];
    // v2: 若该任务已有依赖输出，注入到 chat 上下文（跨 Agent 上下文传递）
    const { user } = buildTaskContext(crew, task);
    const prompt = [
        `【Agent Crew 任务】${task.title}`,
        `角色：${roleDef.name}`,
        `职责：${roleDef.systemPrompt.slice(0, 100)}…`,
        '',
        task.description ? `需求描述：${task.description}` : '',
        '',
        '请在完成此任务后，手动标记任务为完成。',
        '上下文：已注入项目 Wiki + Memory + Semantic Memory。',
        '',
        '──── 自动注入的任务上下文（含上游依赖输出） ────',
        user,
    ].join('\n');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
        mode: 'agent',
        query: prompt,
        isPartialQuery: false,
    });
    return task;
}
async function markTaskComplete(taskId) {
    const crew = loadCrew();
    if (!crew)
        return;
    let task;
    if (taskId) {
        task = crew.tasks.find(t => t.id === taskId);
    }
    else {
        // Pick from running tasks
        const running = crew.tasks.filter(t => t.status === 'running');
        const pick = await vscode.window.showQuickPick(running.map(t => ({ label: t.title, task: t })), { placeHolder: vscode_1.l10n.t('选择已完成的任务') });
        task = pick?.task;
    }
    if (!task)
        return;
    task.status = 'completed';
    task.updatedAt = new Date().toISOString();
    saveCrew(crew);
    // Check if more tasks are runnable
    const next = getNextRunnableTasks(crew);
    if (next.length) {
        const choice = await vscode.window.showInformationMessage(vscode_1.l10n.t('「{0}」已完成。还有 {1} 个可执行任务。', task.title, next.length), vscode_1.l10n.t('执行下一个'), vscode_1.l10n.t('并行执行全部'), vscode_1.l10n.t('查看状态'));
        if (choice === vscode_1.l10n.t('执行下一个')) {
            await runNextTask(crew);
        }
        else if (choice === vscode_1.l10n.t('并行执行全部')) {
            await runAllRunnableTasks(crew);
        }
    }
    else {
        const allDone = crew.tasks.every(t => t.status === 'completed');
        if (allDone) {
            vscode.window.showInformationMessage(vscode_1.l10n.t('Crew「{0}」全部任务完成', crew.name));
        }
    }
}
// ── Crew 状态视图 ──────────────────────────────────────────────
async function showCrewStatus() {
    const crew = loadCrew();
    if (!crew) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('未找到 Crew 配置。使用「Kodrix: 创建 Agent Crew」开始。'));
        return;
    }
    const completed = crew.tasks.filter(t => t.status === 'completed').length;
    const running = crew.tasks.filter(t => t.status === 'running').length;
    const pending = crew.tasks.filter(t => t.status === 'pending').length;
    const failed = crew.tasks.filter(t => t.status === 'failed').length;
    const progress = crew.tasks.length > 0
        ? '█'.repeat(Math.floor(completed / crew.tasks.length * 20)) + '░'.repeat(20 - Math.floor(completed / crew.tasks.length * 20))
        : '░'.repeat(20);
    const lines = [
        `# Agent Crew: ${crew.name}`,
        '',
        `> ${crew.description}`,
        `> 工作流：${crew.workflow}`,
        '',
        '## 进度',
        '',
        `\`${progress}\` ${completed}/${crew.tasks.length} 完成`,
        `| 待办: ${pending} | 进行: ${running} | 完成: ${completed} | 失败: ${failed} |`,
        '',
        '## Agent 角色',
        '',
        ...crew.agents.map(a => `- **${a.name}** (${a.role})`),
        '',
        '## 任务列表',
        '',
        ...crew.tasks.map(t => {
            const status = t.status === 'completed' ? '完成' : t.status === 'running' ? '进行' : t.status === 'failed' ? '失败' : '待办';
            const modeTag = t.mode === 'chat' ? ' · 手动' : t.mode === 'auto' ? ' · 自动' : '';
            const resultTag = t.result ? ` — ${t.result.slice(0, 60).replace(/\s+/g, ' ')}…` : '';
            const errTag = t.error ? ` · 错误：${t.error.slice(0, 60)}` : '';
            const msTag = t.executionMs !== undefined ? `（${t.executionMs}ms）` : '';
            const deps = t.dependencies.length
                ? ` [依赖：${t.dependencies.map(d => crew.tasks.find(tt => tt.id === d)?.title?.slice(0, 15) || d.slice(0, 8)).join(', ')}]`
                : '';
            return `- [${status}] **${t.title}** → ${t.assignedRole}${modeTag}${msTag}${deps}${errTag}${resultTag}`;
        }),
        '',
        '## 快捷命令',
        '',
        '- `Kodrix: 并行执行所有可执行任务` — 自动执行全部可运行任务',
        '- `Kodrix: 执行下一个 Crew 任务` — 打开 Agent 面板手动执行',
        '- `Kodrix: 标记 Crew 任务完成` — 手动标记完成',
    ];
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(doc);
}
// ── 注册 ───────────────────────────────────────────────────────
function registerAgentCrew(context) {
    if (!vscode.workspace.getConfiguration('kodrix.features').get('agentCrew', true)) {
        return;
    }
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.crew.create', () => { void createCrew(); }), vscode.commands.registerCommand('kodrix.crew.addTask', () => { void addCrewTask(); }), vscode.commands.registerCommand('kodrix.crew.runNext', async () => {
        const crew = loadCrew();
        if (crew)
            await runNextTask(crew);
    }), vscode.commands.registerCommand('kodrix.crew.runAll', async () => {
        const crew = loadCrew();
        if (crew)
            await runAllRunnableTasks(crew);
    }), vscode.commands.registerCommand('kodrix.crew.markDone', () => { void markTaskComplete(); }), vscode.commands.registerCommand('kodrix.crew.status', () => { void showCrewStatus(); }));
}
