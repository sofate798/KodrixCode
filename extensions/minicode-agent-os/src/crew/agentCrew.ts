/*---------------------------------------------------------------------------------------------
 *  Agent Crew v1 — 多智能体协作编排框架
 *  大厂对标：Devin multi-agent · Cursor parallel agents · Windsurf cascade
 *
 *  核心能力：
 *  1. 预定义 Agent 角色（Architect / Coder / Reviewer / Tester）
 *  2. 工作流编排：顺序流水线 / 并行协作 / 审批门
 *  3. 任务依赖图 + 进度追踪
 *  4. Crew 配置：.minicode/crew.json
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDir, getWorkspaceMinicodeDir } from '../paths';
import { logger } from '../logger';
import { isRecord, isString } from '../utils/jsonValidator';

// ── 类型定义 ───────────────────────────────────────────────────

export type AgentRole = 'architect' | 'coder' | 'reviewer' | 'tester' | 'devops' | 'custom';

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

function getCrewPath(): string | undefined {
	const base = getWorkspaceMinicodeDir();
	return base ? path.join(base, 'crew.json') : undefined;
}

export function loadCrew(): CrewConfig | undefined {
	const p = getCrewPath();
	if (!p || !fs.existsSync(p)) return undefined;
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

export function saveCrew(config: CrewConfig): void {
	const p = getCrewPath();
	if (!p) return;
	ensureDir(path.dirname(p));
	config.updatedAt = new Date().toISOString();
	fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8');
}

// ── Crew 创建 ───────────────────────────────────────────────────

export async function createCrew(): Promise<CrewConfig | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage('请先打开工作区');
		return undefined;
	}

	// Step 1: Name
	const name = await vscode.window.showInputBox({
		prompt: 'Crew 名称',
		placeHolder: 'feature-payment-system',
	});
	if (!name?.trim()) return undefined;

	// Step 2: Workflow type
	const workflowPick = await vscode.window.showQuickPick(
		[
			{ label: '🔗 顺序流水线', description: 'Architect → Coder → Reviewer → Tester，依次执行', value: 'sequential' as WorkflowType },
			{ label: '⚡ 并行协作', description: '多个 Coder 同时工作，最后 Reviewer 审查', value: 'parallel' as WorkflowType },
			{ label: '🚦 审批门', description: '每个阶段需 Reviewer 批准才能进入下一阶段', value: 'review-gate' as WorkflowType },
		],
		{ placeHolder: '选择协作模式' },
	);
	if (!workflowPick) return undefined;

	// Step 3: Select roles
	const availableRoles: AgentRole[] = ['architect', 'coder', 'reviewer', 'tester'];
	const rolePicks = await vscode.window.showQuickPick(
		availableRoles.map(r => ({
			label: `${ROLE_DEFS[r].name}`,
			description: ROLE_DEFS[r].systemPrompt.slice(0, 60) + '…',
			picked: r === 'coder' || r === 'reviewer',
			role: r,
		})),
		{ canPickMany: true, placeHolder: '选择参与角色（多选）' },
	);
	if (!rolePicks?.length) return undefined;

	// Build agents
	const agents: CrewAgentDef[] = rolePicks.map(rp => ({
		id: `${name.trim().replace(/\s+/g, '-')}-${rp.role}`,
		...ROLE_DEFS[rp.role],
	}));

	const config: CrewConfig = {
		name: name.trim(),
		description: `${rolePicks.map(r => ROLE_DEFS[r.role].name).join(' + ')} · ${workflowPick.label.split(' ')[1] || workflowPick.value}`,
		workflow: workflowPick.value,
		agents,
		tasks: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	saveCrew(config);
	vscode.window.showInformationMessage(`Agent Crew「${config.name}」已创建 — ${agents.length} 个角色，${workflowPick.label}`);
	return config;
}

// ── 任务管理 ────────────────────────────────────────────────────

export async function addCrewTask(config?: CrewConfig): Promise<void> {
	const crew = config || loadCrew();
	if (!crew) {
		await vscode.window.showWarningMessage('未找到 Crew 配置。请先创建 Crew。');
		return;
	}

	const title = await vscode.window.showInputBox({
		prompt: '任务标题',
		placeHolder: '实现用户认证模块',
	});
	if (!title?.trim()) return;

	const description = await vscode.window.showInputBox({
		prompt: '任务描述（可选）',
		placeHolder: '包含 JWT、session、OAuth 等…',
	}) || '';

	// Select role
	const rolePick = await vscode.window.showQuickPick(
		crew.agents.map(a => ({
			label: a.name,
			description: a.role,
			role: a.role,
		})),
		{ placeHolder: '分配角色' },
	);
	if (!rolePick) return;

	// Select dependencies
	interface DepPickItem extends vscode.QuickPickItem {
		taskId: string;
	}
	const depPick = await vscode.window.showQuickPick(
		[{ label: '（无依赖）', taskId: '' } as DepPickItem, ...crew.tasks.map(t => ({ label: t.title, taskId: t.id }))],
		{ canPickMany: true, placeHolder: '前置依赖任务（可多选，无则跳过）' },
	);

	const task: CrewTask = {
		id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		title: title.trim(),
		description,
		assignedRole: rolePick.role,
		dependencies: (depPick || []).filter(d => d.taskId).map(d => d.taskId),
		status: 'pending',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	crew.tasks.push(task);
	saveCrew(crew);
	vscode.window.showInformationMessage(`已添加任务：${title} → ${rolePick.label}`);
}

// ── Crew 执行 ───────────────────────────────────────────────────

function getNextRunnableTasks(crew: CrewConfig): CrewTask[] {
	const completed = new Set(crew.tasks.filter(t => t.status === 'completed').map(t => t.id));
	return crew.tasks.filter(t =>
		t.status === 'pending' &&
		t.dependencies.every(depId => completed.has(depId)),
	);
}

export async function runNextTask(crew: CrewConfig): Promise<CrewTask | undefined> {
	const runnable = getNextRunnableTasks(crew);
	if (!runnable.length) return undefined;

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

	const prompt = [
		`【Agent Crew 任务】${task.title}`,
		`角色：${roleDef.name}`,
		`职责：${roleDef.systemPrompt.slice(0, 100)}…`,
		'',
		task.description ? `需求描述：${task.description}` : '',
		'',
		'请在完成此任务后，手动标记任务为完成。',
		'上下文：已注入项目 Wiki + Memory + Semantic Memory。',
	].filter(Boolean).join('\n');

	await vscode.commands.executeCommand('workbench.action.chat.open', {
		mode: 'agent',
		query: prompt,
		isPartialQuery: false,
	});

	return task;
}

export async function markTaskComplete(taskId?: string): Promise<void> {
	const crew = loadCrew();
	if (!crew) return;

	let task: CrewTask | undefined;
	if (taskId) {
		task = crew.tasks.find(t => t.id === taskId);
	} else {
		// Pick from running tasks
		const running = crew.tasks.filter(t => t.status === 'running');
		const pick = await vscode.window.showQuickPick(
			running.map(t => ({ label: t.title, task: t })),
			{ placeHolder: '选择已完成的任务' },
		);
		task = pick?.task;
	}

	if (!task) return;
	task.status = 'completed';
	task.updatedAt = new Date().toISOString();
	saveCrew(crew);

	// Check if more tasks are runnable
	const next = getNextRunnableTasks(crew);
	if (next.length) {
		const choice = await vscode.window.showInformationMessage(
			`✅ ${task.title} 已完成。还有 ${next.length} 个可执行任务。`,
			'执行下一个', '查看状态',
		);
		if (choice === '执行下一个') {
			await runNextTask(crew);
		}
	} else {
		const allDone = crew.tasks.every(t => t.status === 'completed');
		if (allDone) {
			vscode.window.showInformationMessage(`🎉 Crew「${crew.name}」全部任务完成！`);
		}
	}
}

// ── Crew 状态视图 ──────────────────────────────────────────────

export async function showCrewStatus(): Promise<void> {
	const crew = loadCrew();
	if (!crew) {
		vscode.window.showWarningMessage('未找到 Crew 配置。使用「Minicode: 创建 Agent Crew」开始。');
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
		`| ⏳ 待办: ${pending} | 🔄 进行: ${running} | ✅ 完成: ${completed} | ❌ 失败: ${failed} |`,
		'',
		'## Agent 角色',
		'',
		...crew.agents.map(a => `- **${a.name}** (${a.role})`),
		'',
		'## 任务列表',
		'',
		...crew.tasks.map(t => {
			const icon = t.status === 'completed' ? '✅' : t.status === 'running' ? '🔄' : t.status === 'failed' ? '❌' : '⏳';
			const deps = t.dependencies.length
				? ` [依赖：${t.dependencies.map(d => crew.tasks.find(tt => tt.id === d)?.title?.slice(0, 15) || d.slice(0, 8)).join(', ')}]`
				: '';
			return `- ${icon} **${t.title}** → ${t.assignedRole}${deps}`;
		}),
	];

	const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
	await vscode.window.showTextDocument(doc);
}

// ── 注册 ───────────────────────────────────────────────────────

export function registerAgentCrew(context: vscode.ExtensionContext): void {
	if (!vscode.workspace.getConfiguration('minicode.features').get<boolean>('agentCrew', true)) {
		return;
	}
	context.subscriptions.push(
		vscode.commands.registerCommand('minicode.crew.create', () => { void createCrew(); }),
		vscode.commands.registerCommand('minicode.crew.addTask', () => { void addCrewTask(); }),
		vscode.commands.registerCommand('minicode.crew.runNext', async () => {
			const crew = loadCrew();
			if (crew) await runNextTask(crew);
		}),
		vscode.commands.registerCommand('minicode.crew.markDone', () => { void markTaskComplete(); }),
		vscode.commands.registerCommand('minicode.crew.status', () => { void showCrewStatus(); }),
	);
}
