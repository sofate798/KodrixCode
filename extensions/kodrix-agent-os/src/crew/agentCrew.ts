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

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { ensureDir, getWorkspaceKodrixDir } from '../paths';
import { logger } from '../logger';
import { routeModel } from '../model/modelRouter';
import { getProfileInjection } from '../profile/userProfile';
import { isRecord, isString } from '../utils/jsonValidator';
import {
	CREW_CONFIG,
	CREW_CONFIG_KEYS,
	CREW_TASK_TIMEOUT_MS,
	CREW_CONTEXT_MAX_CHARS,
	CREW_RESULT_MAX_CHARS,
} from '../shared/constants';
import { resolveCrewMaxParallel } from '../utils/crewParallel';
import { atomicWriteFileSync } from '../utils/fsSafe';
import { FileWriteTracker, parseToolCallsFromLLMOutput, generateConflictReport } from './fileConflictDetector';

// ── 类型定义 ───────────────────────────────────────────────────

export type AgentRole = 'architect' | 'coder' | 'reviewer' | 'tester' | 'devops' | 'custom';

/** v2: 任务执行模式 — auto 后台并行 LLM 执行；chat 打开 Agent 面板带工具执行 */
export type CrewExecutionMode = 'auto' | 'chat';

export interface CrewAgentDef {
	id: string;
	role: AgentRole;
	name: string;
	systemPrompt: string;
	model?: string; // 可选指定模型
	tools?: string[]; // 允许的工具
}

export interface CrewTask {
	id: string;
	title: string;
	description: string;
	assignedRole: AgentRole;
	dependencies: string[]; // task IDs that must complete first
	status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
	sessionHint?: string;
	/** v2: 执行模式（缺省视为 auto） */
	mode?: CrewExecutionMode;
	/** v2: 自动执行输出（写入 crew.json，供下游任务与执行报告读取） */
	result?: string;
	/** v2: 自动执行耗时（毫秒） */
	executionMs?: number;
	/** v2: 失败原因 */
	error?: string;
	createdAt: string;
	updatedAt: string;
}

export type WorkflowType = 'sequential' | 'parallel' | 'review-gate';

export interface CrewConfig {
	name: string;
	description?: string;
	workflow: WorkflowType;
	agents: CrewAgentDef[];
	tasks: CrewTask[];
	createdAt: string;
	updatedAt: string;
}

// ── 预定义 Agent 角色 ────────────────────────────────────────────

const ROLE_DEFS: Record<AgentRole, Omit<CrewAgentDef, 'id'>> = {
	architect: {
		role: 'architect',
		name: l10n.t('Architect'),
		systemPrompt: `你是项目架构师。职责：
- 分析需求，输出技术方案和架构设计
- 定义模块边界、API 契约、数据模型
- 产出 Spec 文档（requirements / design / tasks）
- 不写具体代码实现，只做设计决策`,
		tools: ['read_file', 'search_files', 'chat'],
	},
	coder: {
		role: 'coder',
		name: l10n.t('Coder'),
		systemPrompt: `你是高级开发者。职责：
- 根据架构师的设计实现具体代码
- 遵循项目 Memory 和 Learning 中的约定
- 编写可测试、可维护的代码
- 自动运行测试验证`,
		tools: ['read_file', 'search_files', 'edit_file', 'terminal'],
	},
	reviewer: {
		role: 'reviewer',
		name: l10n.t('Reviewer'),
		systemPrompt: `你是代码审查者。职责：
- 审查 Coder 提交的代码变更
- 检查：安全漏洞、性能问题、代码风格、测试覆盖
- 给出具体修改建议
- 通过后标记为 APPROVED`,
		tools: ['read_file', 'search_files', 'git_diff'],
	},
	tester: {
		role: 'tester',
		name: l10n.t('Tester'),
		systemPrompt: `你是测试工程师。职责：
- 根据代码和 Spec 生成测试用例
- 覆盖边界条件、异常路径、性能基准
- 使用项目测试框架（Jest / Vitest / pytest）
- 报告测试结果和缺失的覆盖`,
		tools: ['read_file', 'search_files', 'edit_file', 'terminal'],
	},
	devops: {
		role: 'devops',
		name: l10n.t('DevOps'),
		systemPrompt: `你是 DevOps 工程师。职责：
- 配置 CI/CD、Docker、部署脚本
- 管理环境变量、密钥、基础设施
- 监控和日志配置`,
		tools: ['read_file', 'edit_file', 'terminal'],
	},
	custom: {
		role: 'custom',
		name: l10n.t('Custom Agent'),
		systemPrompt: '自定义 Agent 角色',
		tools: ['read_file', 'search_files', 'edit_file', 'terminal'],
	},
};

// ── Crew 配置管理 ────────────────────────────────────────────────

function getCrewPath(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'crew.json') : undefined;
}

export function loadCrew(): CrewConfig | undefined {
	const p = getCrewPath();
	if (!p || !fs.existsSync(p)) {return undefined;}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
		if (isRecord(raw) && isString(raw.name) && isString(raw.workflow)
			&& Array.isArray(raw.tasks)
			&& Array.isArray(raw.agents)) {
			return raw as unknown as CrewConfig;
		}
		logger.warn('[AgentCrew] loadCrew: invalid shape — ignoring');
		return undefined;
	} catch { return undefined; }
}

/** 原子写入 crew.json：先写临时文件再 rename，防止进程崩溃产生不完整配置 */
export function saveCrew(config: CrewConfig): void {
	const p = getCrewPath();
	if (!p) {return;}
	ensureDir(path.dirname(p));
	config.updatedAt = new Date().toISOString();
	const tmpPath = p + '.tmp';
	fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
	fs.renameSync(tmpPath, p);
}

// ── Crew 创建 ───────────────────────────────────────────────────

export async function createCrew(): Promise<CrewConfig | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage(l10n.t('Please open a workspace first'));
		return undefined;
	}

	// Step 1: Name
	const name = await vscode.window.showInputBox({
		prompt: l10n.t('Crew Name'),
		placeHolder: 'feature-payment-system',
	});
	if (!name?.trim()) {return undefined;}

	// Step 2: Workflow type
	const workflowPick = await vscode.window.showQuickPick(
		[
			{ label: '$(list-ordered) ' + l10n.t('Sequential pipeline'), description: l10n.t('Architect → Coder → Reviewer → Tester, executed in order'), name: l10n.t('Sequential pipeline'), value: 'sequential' as WorkflowType },
			{ label: '$(run-all) ' + l10n.t('Parallel collaboration'), description: l10n.t('Multiple Coders work in parallel, with a final Reviewer pass'), name: l10n.t('Parallel collaboration'), value: 'parallel' as WorkflowType },
			{ label: '$(pass) ' + l10n.t('Approval gate'), description: l10n.t('Each stage requires Reviewer approval before moving on to the next'), name: l10n.t('Approval gate'), value: 'review-gate' as WorkflowType },
		],
		{ placeHolder: l10n.t('Select a collaboration mode') },
	);
	if (!workflowPick) {return undefined;}

	// Step 3: Select roles
	const availableRoles: AgentRole[] = ['architect', 'coder', 'reviewer', 'tester'];
	const rolePicks = await vscode.window.showQuickPick(
		availableRoles.map(r => ({
			label: `${ROLE_DEFS[r].name}`,
			description: ROLE_DEFS[r].systemPrompt.slice(0, 60) + '…',
			picked: r === 'coder' || r === 'reviewer',
			role: r,
		})),
		{ canPickMany: true, placeHolder: l10n.t('Select participating roles (multi-select)') },
	);
	if (!rolePicks?.length) {return undefined;}

	// Build agents
	const agents: CrewAgentDef[] = rolePicks.map(rp => ({
		id: `${name.trim().replace(/\s+/g, '-')}-${rp.role}`,
		...ROLE_DEFS[rp.role],
	}));

	const config: CrewConfig = {
		name: name.trim(),
		description: `${rolePicks.map(r => ROLE_DEFS[r.role].name).join(' + ')} · ${workflowPick.name}`,
		workflow: workflowPick.value,
		agents,
		tasks: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	saveCrew(config);
	vscode.window.showInformationMessage(l10n.t('Agent Crew "{0}" created — {1} roles, {2}', config.name, agents.length, workflowPick.name));
	return config;
}

// ── 任务管理 ────────────────────────────────────────────────────

export async function addCrewTask(config?: CrewConfig): Promise<void> {
	const crew = config || loadCrew();
	if (!crew) {
		await vscode.window.showWarningMessage(l10n.t('No Crew configuration found. Create a Crew first.'));
		return;
	}

	const title = await vscode.window.showInputBox({
		prompt: l10n.t('Task title'),
		placeHolder: l10n.t('Implement the user authentication module'),
	});
	if (!title?.trim()) {return;}

	const description = await vscode.window.showInputBox({
		prompt: l10n.t('Task description (optional)'),
		placeHolder: l10n.t('Includes JWT, sessions, OAuth, etc…'),
	}) || '';

	// Select role
	const rolePick = await vscode.window.showQuickPick(
		crew.agents.map(a => ({
			label: a.name,
			description: a.role,
			role: a.role,
		})),
		{ placeHolder: l10n.t('Assign Roles') },
	);
	if (!rolePick) {return;}

	// v2: Select execution mode
	interface ModePickItem extends vscode.QuickPickItem {
		mode: CrewExecutionMode;
	}
	const modePick = await vscode.window.showQuickPick<ModePickItem>(
		[
			{ label: '$(play) ' + l10n.t('Auto-run (parallel in background)'), description: l10n.t('Driven in parallel by vscode.lm, advances automatically on completion, output written to task results'), mode: 'auto' as CrewExecutionMode },
			{ label: '$(comment-discussion) ' + l10n.t('Run manually (Agent panel)'), description: l10n.t('Open Agent Chat with optional tool execution; mark it done manually'), mode: 'chat' as CrewExecutionMode },
		],
		{ placeHolder: l10n.t('Execution mode (auto by default)') },
	);
	const mode: CrewExecutionMode = modePick?.mode ?? 'auto';

	// Select dependencies
	interface DepPickItem extends vscode.QuickPickItem {
		taskId: string;
	}
	const noDependency: DepPickItem = { label: l10n.t('(no dependencies)'), taskId: '' };
	const depPick = await vscode.window.showQuickPick<DepPickItem>(
		[noDependency, ...crew.tasks.map(t => ({ label: t.title, taskId: t.id }))],
		{ canPickMany: true, placeHolder: l10n.t('Prerequisite tasks (multi-select, skip if none)') },
	);

	const task: CrewTask = {
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
	vscode.window.showInformationMessage(l10n.t('Task added: {0} → {1} ({2})', title, rolePick.label, mode === 'auto' ? l10n.t('Auto-run') : l10n.t('Run manually')));
}

// ── v2 并行执行引擎 ─────────────────────────────────────────────

/**
 * 将数组按指定大小分批（每批内任务相互独立，可并行执行）。
 * 纯函数，便于单元测试。
 */
export function chunkTasks<T>(items: readonly T[], size: number): T[][] {
	if (size < 1) {size = 1;}
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

/**
 * 返回所有「可运行」任务：pending 且依赖全部 completed。
 * 纯函数，便于单元测试。
 */
export function getNextRunnableTasks(crew: CrewConfig): CrewTask[] {
	const completed = new Set(crew.tasks.filter(t => t.status === 'completed').map(t => t.id));
	return crew.tasks.filter(t =>
		t.status === 'pending' &&
		t.dependencies.every(depId => completed.has(depId)),
	);
}

export interface TaskContextOptions {
	/** 依赖输出注入的最大总字符数 */
	maxDepChars?: number;
	/** 团队共享上下文（此前任务成果摘要，跨 Agent 传递） */
	sharedContext?: string;
}

export interface TaskContext {
	system: string;
	user: string;
}

/**
 * 组装单任务的 LLM 上下文：系统角色 + 任务描述 + 上游依赖任务输出（跨 Agent 上下文传递）。
 * 纯函数（不依赖 vscode API），便于单元测试。
 */
export function buildTaskContext(crew: CrewConfig, task: CrewTask, opts?: TaskContextOptions): TaskContext {
	const roleDef = ROLE_DEFS[task.assignedRole] ?? ROLE_DEFS.custom;
	const maxDepChars = opts?.maxDepChars ?? CREW_CONTEXT_MAX_CHARS;

	// 依赖任务输出注入（按声明顺序拼接，超过上限截断）
	const depBlocks: string[] = [];
	let depChars = 0;
	for (const depId of task.dependencies) {
		const dep = crew.tasks.find(t => t.id === depId);
		if (!dep) {continue;}
		if (dep.result) {
			const remain = maxDepChars - depChars;
			if (remain <= 0) {break;}
			const snippet = dep.result.length > remain
				? dep.result.slice(0, remain) + '\n…(上下文截断)'
				: dep.result;
			depBlocks.push(`### 上游任务「${dep.title}」的输出\n${snippet}`);
			depChars += snippet.length;
		} else {
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
async function selectCrewModel(preferredName?: string, taskType?: string): Promise<vscode.LanguageModelChat | undefined> {
	try {
		const routed = await routeModel({ preferred: preferredName, taskType });
		return routed?.model;
	} catch (err) {
		logger.warn('[AgentCrew] model routing failed', err);
		return undefined;
	}
}

/** 角色 → 任务类型（供模型路由选档） */
function roleToTaskType(role: AgentRole): string {
	switch (role) {
		case 'architect': return 'plan';
		case 'reviewer': return 'review';
		case 'devops': return 'terminal';
		default: return 'coding';
	}
}

/** Crew 共享上下文文件路径（工作区 .kodrix/crew-context.md） */
function getCrewContextPath(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {return undefined;}
	return path.join(folder.uri.fsPath, '.kodrix', 'crew-context.md');
}

/** 读取团队共享上下文（此前任务成果摘要，跨 Agent 传递） */
export function readCrewSharedContext(maxChars = CREW_CONTEXT_MAX_CHARS): string {
	const p = getCrewContextPath();
	if (!p || !fs.existsSync(p)) {return '';}
	try {
		const t = fs.readFileSync(p, 'utf-8');
		return t.slice(-maxChars);
	} catch (err) {
		logger.warn('[AgentCrew] 读取共享上下文失败', err);
		return '';
	}
}

/** 任务执行后追加成果摘要到团队共享上下文 */
export function updateCrewSharedContext(_crew: CrewConfig, task: CrewTask): void {
	const p = getCrewContextPath();
	if (!p) {return;}
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const raw = task.result || task.error || '';
		// 显式标注截断：静默截断会让下游 Agent 以为"这就是全部成果"
		const summary = raw.length > CREW_RESULT_MAX_CHARS
			? `${raw.slice(0, CREW_RESULT_MAX_CHARS)}\n…[结果已截断：原文 ${raw.length} 字符，仅保留前 ${CREW_RESULT_MAX_CHARS} 字符]`
			: raw;
		const line = `\n## [${task.updatedAt}] ${task.title}（${task.assignedRole} · ${task.status}）\n${summary}\n`;
		fs.appendFileSync(p, line, 'utf-8');
		logger.info(`[AgentCrew] 共享上下文已更新（${task.title}）`);
		// 文件本身必须有上限：此前只 append 永不收敛，长跑 Crew 会让 crew-context.md 无限增长
		// （读取方只取尾部 maxChars，多余内容纯属占盘）
		const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
		try {
			const stat = fs.statSync(p);
			if (stat.size > MAX_CONTEXT_FILE_BYTES) {
				const tail = fs.readFileSync(p, 'utf-8').slice(-Math.floor(MAX_CONTEXT_FILE_BYTES / 2));
				const firstBreak = tail.indexOf('\n## ');
				const trimmed = firstBreak >= 0 ? tail.slice(firstBreak) : tail;
				atomicWriteFileSync(p, `# Crew 共享上下文（已滚动保留最近部分）\n${trimmed}`);
				logger.info(`[AgentCrew] 共享上下文已滚动裁剪至 ${(trimmed.length / 1024).toFixed(0)}KB`);
			}
		} catch (err) {
			logger.warn('[AgentCrew] 共享上下文滚动裁剪失败', err);
		}
	} catch (err) {
		logger.warn('[AgentCrew] 写入共享上下文失败', err);
	}
}

/**
 * 执行单个任务（auto 模式）：独立 LLM 请求 + 独立上下文，可与其他任务并行。
 * 结果写入 task.result / task.status / task.executionMs / task.error。
 */
async function executeTaskAuto(crew: CrewConfig, task: CrewTask): Promise<void> {
	const start = Date.now();
	const agent = crew.agents.find(a => a.role === task.assignedRole);
	const model = await selectCrewModel(agent?.model, roleToTaskType(task.assignedRole));
	if (!model) {
		task.status = 'failed';
		task.error = l10n.t('No language model available (configure a BYOK model in Manage Models)');
		task.executionMs = Date.now() - start;
		task.updatedAt = new Date().toISOString();
		return;
	}

	const { system, user } = buildTaskContext(crew, task, { sharedContext: readCrewSharedContext(3000) });
	const cts = new vscode.CancellationTokenSource();
	const timeoutMs = vscode.workspace.getConfiguration(CREW_CONFIG)
		.get<number>(CREW_CONFIG_KEYS.timeoutMs, CREW_TASK_TIMEOUT_MS);
	const timeoutId = setTimeout(() => cts.cancel(), timeoutMs);

	try {
		// 系统提示与任务上下文合为单条 User 消息（当前 vscode.d.ts 仅提供 User/Assistant 构造器）
		const profile = getProfileInjection();
		const messages = [vscode.LanguageModelChatMessage.User(`${system}\n\n${profile}\n\n${user}`)];
		const response = await model.sendRequest(messages, {}, cts.token);
		let text = '';
		for await (const chunk of response.stream) {
			if (chunk instanceof vscode.LanguageModelTextPart) {
				text += chunk.value;
			}
		}
		task.result = text.slice(0, CREW_RESULT_MAX_CHARS);
		task.status = text.trim() ? 'completed' : 'failed';
		if (task.status === 'failed') {
			task.error = l10n.t('Model returned no output');
		}
		logger.info(`[AgentCrew] 任务「${task.title}」${task.status}（${Date.now() - start}ms）`);
	} catch (err) {
		task.status = 'failed';
		task.error = err instanceof Error ? err.message : String(err);
		logger.error(`[AgentCrew] 任务「${task.title}」执行失败`, err);
	} finally {
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
export async function runAllRunnableTasks(crew: CrewConfig): Promise<void> {
	const maxParallel = resolveCrewMaxParallel();

	let runnable = getNextRunnableTasks(crew).filter(t => t.mode !== 'chat');
	const chatPending = crew.tasks.some(t => t.mode === 'chat' && t.status === 'pending');
	if (!runnable.length) {
		vscode.window.showInformationMessage(
			chatPending
				? l10n.t('No tasks can be executed automatically (there are chat-mode tasks; use "Execute Next Crew Task" to complete them in the Agent panel)')
				: l10n.t('No executable tasks (all completed or dependencies not ready)'),
		);
		return;
	}

	const executed: CrewTask[] = [];
	const conflictTracker = new FileWriteTracker();

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: l10n.t('Agent Crew "{0}" running in parallel…', crew.name), cancellable: false },
		async () => {
			let wave = 0;
			while (runnable.length) {
				wave++;
				for (const t of runnable) {
					t.status = 'running';
					t.updatedAt = new Date().toISOString();
				}
				saveCrew(crew);
				logger.info(`[AgentCrew] wave ${wave}: 并行执行 ${runnable.length} 个任务（并发上限 ${maxParallel}）`);

				// 同波任务相互无依赖，分批并行执行
				for (const chunk of chunkTasks(runnable, maxParallel)) {
					await Promise.allSettled(chunk.map(t => executeTaskAuto(crew, t)));
				}
				// 自动写回结果与状态，并解析文件修改声明
				for (const t of runnable) {
					executed.push(t);
					if (t.status === 'failed') {
						logger.warn(`[AgentCrew] 任务「${t.title}」失败：${t.error ?? ''}`);
					}
					// 解析 LLM 输出中的文件修改声明（仅记录，不执行）
					if (t.result) {
						const mods = parseToolCallsFromLLMOutput(t.result, t.id, t.title);
						mods.forEach(m => conflictTracker.record(m));
					}
				}
				saveCrew(crew);

				// 下一波：仅当本波有新完成任务，才可能有新解除依赖的任务
				const newlyCompleted = runnable.some(t => t.status === 'completed');
				if (!newlyCompleted) {break;}
				runnable = getNextRunnableTasks(crew).filter(t => t.mode !== 'chat');
			}
		},
	);

	const completed = executed.filter(t => t.status === 'completed').length;
	const failed = executed.filter(t => t.status === 'failed').length;
	vscode.window.showInformationMessage(
		l10n.t('Crew "{0}" finished: {1} completed / {2} failed / {3} tasks', crew.name, completed, failed, executed.length),
	);
	const conflicts = conflictTracker.detectConflicts();
	if (conflicts.length > 0) {
		logger.warn(`[AgentCrew] 检测到 ${conflicts.length} 个文件冲突`);
	}
	await showCrewExecutionReport(crew, executed, conflictTracker, conflicts);
}

/** 生成并打开执行报告（Markdown）：任务明细 + 冲突检测 + 待办提示 */
async function showCrewExecutionReport(
	crew: CrewConfig,
	executed: CrewTask[],
	conflictTracker: FileWriteTracker,
	conflicts: ReturnType<FileWriteTracker['detectConflicts']>,
): Promise<void> {
	const pendingTasks = crew.tasks.filter(t => t.status === 'pending');
	const lines = [
		`# ${l10n.t('Agent Crew Execution Report')}: ${crew.name}`,
		'',
		`> ${crew.description ?? ''}`,
		`> ${l10n.t('Execution time: {0}', new Date().toLocaleString())}`,
		'',
		`## ${l10n.t('Summary')}`,
		'',
		`| ${l10n.t('Status')} | ${l10n.t('Count')} |`,
		'|------|------|',
		`| ${l10n.t('Done')} | ${executed.filter(t => t.status === 'completed').length} |`,
		`| ${l10n.t('Failed')} | ${executed.filter(t => t.status === 'failed').length} |`,
		`| ${l10n.t('To Do (with chat mode)')} | ${pendingTasks.length} |`,
		'',
		`## ${l10n.t('Task details')}`,
		'',
		...executed.flatMap(t => {
			const status = t.status === 'completed' ? l10n.t('Done') : l10n.t('Failed');
			const ms = t.executionMs !== undefined ? `（${t.executionMs}ms）` : '';
			return [
				`### [${status}] ${t.title} → ${t.assignedRole}${ms}`,
				'',
				t.error ? `> ${l10n.t('Error: {0}', t.error)}` : '',
				t.result ?? `（${l10n.t('No output')}）`,
				'',
				'---',
				'',
			].filter(Boolean);
		}),
		`## ${l10n.t('File conflict detection')}`,
		'',
		...generateConflictReport(conflictTracker, conflicts),
		`## ${l10n.t('To Do hint')}`,
		'',
		...(pendingTasks.length
			? pendingTasks.map(t => `- ${t.title}（${l10n.t('Depends on: {0}', t.dependencies.map(d => crew.tasks.find(tt => tt.id === d)?.title ?? d).join(', ') || l10n.t('None'))}）`)
			: [`- ${l10n.t('All tasks have been processed')}`]),
		crew.tasks.some(t => t.mode === 'chat' && t.status === 'pending')
			? `> ${l10n.t('Note: chat-mode tasks must be completed manually in the Agent panel via "Kodrix: Run Next Crew Task".')}`
			: '',
	].filter(Boolean);

	const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
	await vscode.window.showTextDocument(doc);
}

// ── Crew 执行（v1 兼容：单任务 / 手动模式） ─────────────────────

export async function runNextTask(crew: CrewConfig): Promise<CrewTask | undefined> {
	const runnable = getNextRunnableTasks(crew);
	if (!runnable.length) {return undefined;}

	// Pick highest priority (first in order, or by role priority)
	const order: AgentRole[] = ['architect', 'coder', 'tester', 'reviewer', 'devops'];
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
		// 角色可限定工具范围（CrewAgentDef.tools）：此前该字段无人读取，等于摆设
		...(roleDef.tools?.length ? [`本任务仅允许使用以下工具：${roleDef.tools.join(' / ')}`] : []),
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

export async function markTaskComplete(taskId?: string): Promise<void> {
	const crew = loadCrew();
	if (!crew) {return;}

	let task: CrewTask | undefined;
	if (taskId) {
		task = crew.tasks.find(t => t.id === taskId);
	} else {
		// Pick from running tasks
		const running = crew.tasks.filter(t => t.status === 'running');
		const pick = await vscode.window.showQuickPick(
			running.map(t => ({ label: t.title, task: t })),
			{ placeHolder: l10n.t('Select a completed task') },
		);
		task = pick?.task;
	}

	if (!task) {return;}
	task.status = 'completed';
	task.updatedAt = new Date().toISOString();
	saveCrew(crew);

	// Check if more tasks are runnable
	const next = getNextRunnableTasks(crew);
	if (next.length) {
		const choice = await vscode.window.showInformationMessage(
			l10n.t('"{0}" completed. {1} actionable tasks remaining.', task.title, next.length),
			l10n.t('Run Next'), l10n.t('Run All in Parallel'), l10n.t('View Status'),
		);
		if (choice === l10n.t('Run Next')) {
			await runNextTask(crew);
		} else if (choice === l10n.t('Run All in Parallel')) {
			await runAllRunnableTasks(crew);
		}
	} else {
		const allDone = crew.tasks.every(t => t.status === 'completed');
		if (allDone) {
			vscode.window.showInformationMessage(l10n.t('Crew "{0}" all tasks completed', crew.name));
		}
	}
}

// ── Crew 状态视图 ──────────────────────────────────────────────

export async function showCrewStatus(): Promise<void> {
	const crew = loadCrew();
	if (!crew) {
		vscode.window.showWarningMessage(l10n.t('No Crew configuration found. Use "Kodrix: Create Agent Crew" to get started.'));
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
		`> ${l10n.t('Workflow: {0}', crew.workflow)}`,
		'',
		`## ${l10n.t('Progress')}`,
		'',
		`\`${progress}\` ${l10n.t('{0}/{1} completed', completed, crew.tasks.length)}`,
		`| ${l10n.t('To Do: {0}', pending)} | ${l10n.t('Running: {0}', running)} | ${l10n.t('Done: {0}', completed)} | ${l10n.t('Failed: {0}', failed)} |`,
		'',
		`## ${l10n.t('Agent Roles')}`,
		'',
		...crew.agents.map(a => `- **${a.name}** (${a.role})`),
		'',
		`## ${l10n.t('Task List')}`,
		'',
		...crew.tasks.map(t => {
			const status = t.status === 'completed' ? l10n.t('Done') : t.status === 'running' ? l10n.t('Running') : t.status === 'failed' ? l10n.t('Failed') : l10n.t('To Do');
			const modeTag = t.mode === 'chat' ? ` · ${l10n.t('Manual')}` : t.mode === 'auto' ? ` · ${l10n.t('Auto')}` : '';
			const resultTag = t.result ? ` — ${t.result.slice(0, 60).replace(/\s+/g, ' ')}…` : '';
			const errTag = t.error ? ` · ${l10n.t('Error: {0}', t.error.slice(0, 60))}` : '';
			const msTag = t.executionMs !== undefined ? `（${t.executionMs}ms）` : '';
			const deps = t.dependencies.length
				? ` [${l10n.t('Depends on: {0}', t.dependencies.map(d => crew.tasks.find(tt => tt.id === d)?.title?.slice(0, 15) || d.slice(0, 8)).join(', '))}]`
				: '';
			return `- [${status}] **${t.title}** → ${t.assignedRole}${modeTag}${msTag}${deps}${errTag}${resultTag}`;
		}),
		'',
		`## ${l10n.t('Quick Commands')}`,
		'',
		`- \`${l10n.t('Kodrix: Execute All Executable Crew Tasks in Parallel (Auto)')}\` — ${l10n.t('automatically run all runnable tasks')}`,
		`- \`${l10n.t('Kodrix: Execute Next Crew Task')}\` — ${l10n.t('open the Agent panel and run it manually')}`,
		`- \`${l10n.t('Kodrix: Mark Crew Task Done')}\` — ${l10n.t('mark a task as done manually')}`,
	];

	const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
	await vscode.window.showTextDocument(doc);
}

// ── 注册 ───────────────────────────────────────────────────────

export function registerAgentCrew(context: vscode.ExtensionContext): void {
	if (!vscode.workspace.getConfiguration('kodrix.features').get<boolean>('agentCrew', true)) {
		return;
	}
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.crew.create', () => { void createCrew(); }),
		vscode.commands.registerCommand('kodrix.crew.addTask', () => { void addCrewTask(); }),
		vscode.commands.registerCommand('kodrix.crew.runNext', async () => {
			const crew = loadCrew();
			if (crew) {await runNextTask(crew);}
		}),
		vscode.commands.registerCommand('kodrix.crew.runAll', async () => {
			const crew = loadCrew();
			if (crew) {await runAllRunnableTasks(crew);}
		}),
		vscode.commands.registerCommand('kodrix.crew.markDone', () => { void markTaskComplete(); }),
		vscode.commands.registerCommand('kodrix.crew.status', () => { void showCrewStatus(); }),
	);
}
