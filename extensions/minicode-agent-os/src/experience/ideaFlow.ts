/*---------------------------------------------------------------------------------------------
 *  Idea Flow — 让软件开发回归想法本身
 *
 *  大厂对标：Anthropic Claude Code + Devin + Lovable + Bolt.new + v0
 *  核心理念：用户只需描述想法，AI 全自动完成需求分析 → 架构设计 → 任务拆解 → 
 *            多 Agent 协同开发 → 构建验证 → 部署预览
 *
 *  流程：
 *  1. IDEA INCEPTION: 用户表达想法 → LLM 深度分析 → 需求细化
 *  2. AUTO-PLAN: 自动生成 Spec + 架构 + 任务分解 + Crew 配置
 *  3. CREW BUILD: 自动编排 Agent Crew 完成开发
 *  4. AUTO-PREVIEW: 启动 dev server + 加载预览
 *  5. PRODUCT INTELLIGENCE: 沉淀产品知识 → 提出改进建议
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDir, getWorkspaceMinicodeDir } from '../paths';
import { recordLearning } from '../learning/learningEngine';
import { CrewConfig, saveCrew, loadCrew, CrewTask, AgentRole, WorkflowType } from '../crew/agentCrew';
import { createSpecFiles } from '../spec/specHelpers';
import {
	CONFIG_FEATURES,
	FEATURE_FLAGS,
	COMMANDS,
	VIEW_IDS,
	IDEA_FLOW_LLM_TIMEOUT_MS,
	IDEA_FLOW_MODEL_FAMILIES,
	IDEA_FLOW_POLL_INTERVAL_MS,
	IDEA_FLOW_MAX_BUILD_MS,
	IDEA_FLOW_MAX_LOGS,
	IDEA_FLOW_FEATURES_MAX,
	IDEA_FLOW_CANVAS_LAUNCH_DELAY_MS,
	SOLO_PREVIEW_DELAY_MS,
	DEFAULT_PREVIEW_PORT,
	GENERIC_DEV_PORT,
} from '../shared/constants';

// ── 类型定义 ───────────────────────────────────────────────────

export type IdeaPhase =
	| 'idle'
	| 'idea-capture'
	| 'idea-analysis'
	| 'auto-planning'
	| 'crew-building'
	| 'build-in-progress'
	| 'preview-ready'
	| 'product-intelligence'
	| 'error';

export interface IdeaAnalysis {
	appName: string;
	description: string;
	techStack: string[];
	architecture: string;
	features: string[];
	estimatedFiles: number;
	complexity: 'low' | 'medium' | 'high';
	suggestedCrewRoles: AgentRole[];
	workflowType: WorkflowType;
}

export interface IdeaFlowState {
	phase: IdeaPhase;
	idea: string;
	analysis?: IdeaAnalysis;
	specDir?: string;
	crewConfig?: CrewConfig;
	startedAt: string;
	updatedAt: string;
	buildLogs: string[];
	previewUrl?: string;
}

// ── 状态管理 ───────────────────────────────────────────────────

let currentState: IdeaFlowState | undefined;

/**
 * Get the current idea flow state, throwing a descriptive error if undefined.
 *
 * All internal functions that use `currentState` are guaranteed to be called
 * within `startIdeaFlow()`, which sets the state before invoking them. Using
 * this accessor instead of `!` (non-null assertion) ensures that:
 * 1. Future refactoring won't silently crash with an NPE
 * 2. Debugging is easier because the error message pinpoints the missing state
 */
function requireCurrentState(): IdeaFlowState {
	if (!currentState) {
		throw new Error('IdeaFlow: currentState is undefined — this function must only be called within startIdeaFlow()');
	}
	return currentState;
}
let _onStateChanged: vscode.EventEmitter<IdeaFlowState> | undefined;
let isFlowRunning = false;

// Background timers that get cleaned up on panel dispose or restart
let _pollInterval: ReturnType<typeof setInterval> | undefined;
let _maxTimeout: ReturnType<typeof setTimeout> | undefined;
let _previewTimeout: ReturnType<typeof setTimeout> | undefined;

function cleanupTimers(): void {
	if (_pollInterval !== undefined) { clearInterval(_pollInterval); _pollInterval = undefined; }
	if (_maxTimeout !== undefined) { clearTimeout(_maxTimeout); _maxTimeout = undefined; }
	if (_previewTimeout !== undefined) { clearTimeout(_previewTimeout); _previewTimeout = undefined; }
}

function getOrCreateEmitter(): vscode.EventEmitter<IdeaFlowState> {
	if (!_onStateChanged) {
		_onStateChanged = new vscode.EventEmitter<IdeaFlowState>();
	}
	return _onStateChanged;
}
export const onIdeaStateChanged: vscode.Event<IdeaFlowState> = ((
	listener: (e: IdeaFlowState) => unknown,
	thisArgs?: unknown,
	disposables?: vscode.Disposable[],
) =>
	getOrCreateEmitter().event(listener, thisArgs, disposables)) as unknown as vscode.Event<IdeaFlowState>;
export function disposeIdeaFlowEmitter(): void {
	_onStateChanged?.dispose();
	_onStateChanged = undefined;
	cleanupTimers();
}

function getIdeaFlowPath(): string | undefined {
	const base = getWorkspaceMinicodeDir();
	return base ? path.join(base, 'idea-flow.json') : undefined;
}

function persistState(): void {
	const p = getIdeaFlowPath();
	if (!p) return;
	ensureDir(path.dirname(p));
	try {
		fs.writeFileSync(p, JSON.stringify(currentState, null, 2), 'utf-8');
	} catch {
		// Silently skip persistence failures — not critical
	}
}

function pushLog(msg: string): void {
	if (!currentState) return;
	currentState.buildLogs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
	if (currentState.buildLogs.length > IDEA_FLOW_MAX_LOGS) {
		currentState.buildLogs = currentState.buildLogs.slice(-IDEA_FLOW_MAX_LOGS);
	}
	updateState({ buildLogs: currentState.buildLogs });
	pushStateToCanvas();
}

function updateState(partial: Partial<IdeaFlowState>): void {
	if (!currentState) return;
	currentState = { ...currentState, ...partial, updatedAt: new Date().toISOString() };
	persistState();
	_onStateChanged?.fire(currentState);
	pushStateToCanvas();
}

function loadState(): IdeaFlowState | undefined {
	const p = getIdeaFlowPath();
	if (!p || !fs.existsSync(p)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(p, 'utf-8')) as IdeaFlowState;
	} catch { return undefined; }
}

// ── Idea Canvas Webview ────────────────────────────────────────

let activeCanvas: vscode.WebviewPanel | undefined;

function getCanvasHtml(webview: vscode.Webview, extensionPath: string): string {
	const htmlPath = path.join(extensionPath, 'resources', 'idea-canvas.html');
	let html: string;
	try {
		html = fs.readFileSync(htmlPath, 'utf-8');
	} catch {
		html = getMinimalFallbackHtml();
	}
	return html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
}

/** Minimal fallback when the resource file can't be loaded */
function getMinimalFallbackHtml(): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src {{cspSource}} 'unsafe-inline';script-src {{cspSource}};img-src {{cspSource}} data:;">
<title>Idea Canvas</title>
<style>
:root{--bg:var(--vscode-editor-background,#1e1e1e);--fg:var(--vscode-editor-foreground,#ccc);--fg-dim:var(--vscode-descriptionForeground,#999);--accent:var(--vscode-button-background,#0e639c);--border:var(--vscode-panel-border,#454545);--radius:8px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,sans-serif);font-size:13px;background:var(--bg);color:var(--fg);padding:24px;line-height:1.5}
.wrap{max-width:480px;margin:40px auto;padding:24px;border:1px solid var(--border);border-radius:var(--radius);text-align:center}
.wrap h2{margin-bottom:10px;color:var(--accent)}
.wrap p{color:var(--fg-dim);font-size:12px;margin-bottom:16px}
</style>
</head>
<body>
<div class="wrap">
<h2>Idea Canvas</h2>
<p>资源文件加载失败。请编译扩展后重试。</p>
</div>
<script>var vscode=acquireVsCodeApi();vscode.postMessage({command:'ready'});</script>
</body>
</html>`;
}

// ── Idea Canvas 管理 ───────────────────────────────────────────

export async function openIdeaCanvas(context: vscode.ExtensionContext): Promise<void> {
	const column = vscode.ViewColumn.One;

	if (activeCanvas) {
		activeCanvas.reveal(column);
		pushStateToCanvas();
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		VIEW_IDS.ideaCanvas,
		'Idea Canvas',
		column,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
		},
	);

	activeCanvas = panel;
	panel.iconPath = new vscode.ThemeIcon('lightbulb');
	panel.webview.html = getCanvasHtml(panel.webview, context.extensionPath);

	panel.webview.onDidReceiveMessage(msg => {
		void handleCanvasMessage(msg, context);
	});

	panel.onDidDispose(() => {
		activeCanvas = undefined;
		cleanupTimers();
	});

	// Restore state if exists
	currentState = loadState();
	if (currentState) {
		pushStateToCanvas();
	}
}

function pushStateToCanvas(): void {
	if (!activeCanvas || !currentState) return;
	activeCanvas.webview.postMessage({ type: 'stateUpdate', state: currentState });
}

// ── Canvas 消息处理 ─────────────────────────────────────────────

async function handleCanvasMessage(
	msg: { command: string; idea?: string; analyze?: boolean; msg?: string },
	context: vscode.ExtensionContext,
): Promise<void> {
	switch (msg.command) {
		case 'ready':
			if (currentState) {
				pushStateToCanvas();
			}
			break;

		case 'detectIdea':
			if (msg.idea && activeCanvas) {
				activeCanvas.webview.postMessage({
					type: 'ideaLikely',
					label: msg.idea.length > 40 ? msg.idea.slice(0, 40) + '…' : msg.idea,
				});
			}
			break;

		case 'startIdeaFlow':
			if (msg.idea) {
				await startIdeaFlow(msg.idea, msg.analyze !== false, context);
			}
			break;

		case 'openPreview':
			await openIdeaPreview();
			break;

		case 'openStatus':
			await showIdeaFlowStatus();
			break;

		case 'notify':
			if (msg.msg) {
				vscode.window.showInformationMessage(String(msg.msg));
			}
			break;
	}
}

// ── 核心 Idea Flow ─────────────────────────────────────────────

export async function startIdeaFlow(
	idea: string,
	deepAnalyze: boolean,
	context: vscode.ExtensionContext,
): Promise<void> {
	if (isFlowRunning) {
		vscode.window.showWarningMessage('Idea Flow 正在进行中，请等待完成或使用「重置 Idea Flow」重新开始。');
		return;
	}
	isFlowRunning = true;
	cleanupTimers();

	try {
		currentState = {
			phase: 'idea-capture',
			idea,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			buildLogs: [],
		};

		pushLog(`🚀 收到想法：「${idea.slice(0, 80)}${idea.length > 80 ? '…' : ''}」`);

		if (deepAnalyze) {
			await performIdeaAnalysis(idea);
		} else {
			currentState.analysis = {
				appName: idea.split(/\s+/).slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, ''),
				description: idea,
				techStack: ['React', 'Vite', 'Tailwind CSS'],
				architecture: 'SPA Frontend',
				features: extractFeaturesQuick(idea),
				estimatedFiles: 12,
				complexity: 'medium',
				suggestedCrewRoles: ['architect', 'coder', 'tester'],
				workflowType: 'sequential',
			};
			pushLog('📐 跳过深度分析，使用快速规划模式');
			updateState({ phase: 'auto-planning' });
		}

		await autoPlan();
		await launchCrewBuild(context);

	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		pushLog(`❌ 错误: ${errMsg}`);
		updateState({ phase: 'error' });
		vscode.window.showErrorMessage(`Idea Flow 出错: ${errMsg}`);
	} finally {
		isFlowRunning = false;
	}
}

/**
 * Phase 1: Deep Idea Analysis using LLM with multi-model fallback
 */
async function performIdeaAnalysis(idea: string): Promise<void> {
	updateState({ phase: 'idea-analysis' });
	pushLog('🔍 AI 正在深度分析你的想法…');

	const systemPrompt = `你是一个顶级产品架构师和 CTO。分析用户的软件想法并输出 JSON 分析结果。
请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "appName": "简短的项目名称（英文小写，用连字符）",
  "techStack": ["推荐技术栈数组，3-5项"],
  "architecture": "架构风格描述（如 SPA Frontend / Full-stack / Microservices / CLI Tool）",
  "features": ["核心功能列表，4-6项"],
  "estimatedFiles": 数字,
  "complexity": "low|medium|high",
  "suggestedCrewRoles": ["architect", "coder", "tester"],
  "workflowType": "sequential"
}`;

	// Try multiple model families for maximum compatibility
	let model: vscode.LanguageModelChat | undefined;

	for (const family of IDEA_FLOW_MODEL_FAMILIES) {
		try {
			const [found] = await vscode.lm.selectChatModels({ family });
			if (found) { model = found; break; }
		} catch {
			continue;
		}
	}

	if (!model) {
		pushLog('⚠️ 未找到可用 LLM 模型，使用启发式分析');
		requireCurrentState().analysis = generateBasicAnalysis(idea);
		updateState({ analysis: requireCurrentState().analysis });
		return;
	}

	const cts = new vscode.CancellationTokenSource();
	const timeoutId = setTimeout(() => {
		cts.cancel();
		pushLog('⏰ LLM 分析超时（3分钟），将使用启发式分析');
	}, IDEA_FLOW_LLM_TIMEOUT_MS);

	try {
		const messages = [
			vscode.LanguageModelChatMessage.User(`${systemPrompt}\n\n用户想法：${idea}`),
		];

		const response = await model.sendRequest(messages, {}, cts.token);
		let fullText = '';
		for await (const chunk of response.stream) {
			if (chunk instanceof vscode.LanguageModelTextPart) {
				fullText += chunk.value;
			}
		}

		const jsonStr = extractBalancedJson(fullText);
		const parsed = JSON.parse(jsonStr) as Partial<IdeaAnalysis>;
		const analysis: IdeaAnalysis = {
			appName: parsed.appName || idea.split(/\s+/).slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, ''),
			description: idea,
			techStack: parsed.techStack || ['React', 'Vite', 'Tailwind CSS'],
			architecture: parsed.architecture || 'Web Application',
			features: parsed.features || ['Core functionality'],
			estimatedFiles: parsed.estimatedFiles || 10,
			complexity: parsed.complexity || 'medium',
			suggestedCrewRoles: parsed.suggestedCrewRoles || ['architect', 'coder', 'tester'],
			workflowType: parsed.workflowType || 'sequential',
		};
		requireCurrentState().analysis = analysis;
		updateState({ analysis });
		pushLog(`✅ 分析完成！项目：${analysis.appName} (${analysis.complexity}复杂度，约${analysis.estimatedFiles}个文件)`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		pushLog(`⚠️ LLM 分析失败: ${msg}，使用启发式分析`);
		requireCurrentState().analysis = generateBasicAnalysis(idea);
		updateState({ analysis: requireCurrentState().analysis });
	} finally {
		clearTimeout(timeoutId);
		cts.dispose();
	}
}

/**
 * Extract the outermost JSON object from text with balanced brace matching.
 * Handles nested braces and string-escaped quotes correctly.
 */
function extractBalancedJson(text: string): string {
	const start = text.indexOf('{');
	if (start === -1) throw new Error('No JSON object found in LLM response');
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) inString = !inString;
		if (!inString) {
			if (ch === '{') depth++;
			else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
		}
	}
	throw new Error('Unbalanced JSON braces in LLM response');
}

function generateBasicAnalysis(idea: string): IdeaAnalysis {
	const features = extractFeaturesQuick(idea);
	return {
		appName: idea.split(/\s+/).slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, ''),
		description: idea,
		techStack: ['React', 'Vite', 'Tailwind CSS', 'TypeScript'],
		architecture: 'SPA Web Application',
		features,
		estimatedFiles: Math.max(8, Math.ceil(features.length * 2.5)),
		complexity: features.length > 5 ? 'high' : features.length > 3 ? 'medium' : 'low',
		suggestedCrewRoles: features.length > 4
			? ['architect', 'coder', 'coder', 'tester', 'reviewer']
			: ['architect', 'coder', 'tester'],
		workflowType: 'sequential',
	};
}

function extractFeaturesQuick(idea: string): string[] {
	const features: string[] = [];
	const lower = idea.toLowerCase();

	const patterns: [RegExp, string][] = [
		[/markdown/i, 'Markdown 编辑与渲染'],
		[/blog|博客/i, '博客文章管理'],
		[/auth|登录|user|用户/i, '用户认证与管理'],
		[/search|搜索/i, '全文搜索'],
		[/chat|聊天|ai|对话/i, 'AI 对话界面'],
		[/drag|拖拽|dnd/i, '拖拽交互'],
		[/api|rest/i, 'REST API'],
		[/dark|暗色|theme|主题/i, '暗色/亮色主题切换'],
		[/notif|通知/i, '实时通知'],
		[/payment|支付/i, '支付集成'],
		[/email|邮件/i, '邮件服务'],
		[/export|导出/i, '数据导出'],
		[/import|导入/i, '数据导入'],
		[/chart|图表|dashboard|仪表盘/i, '数据可视化'],
		[/comment|评论/i, '评论系统'],
		[/tag|标签|categor|分类/i, '标签与分类'],
		[/share|分享/i, '社交分享'],
		[/mobile|响应|responsive/i, '响应式移动端适配'],
	];

	for (const [regex, feature] of patterns) {
		if (regex.test(lower)) {
			features.push(feature);
		}
	}

	if (features.length === 0) {
		features.push('核心功能模块');
		features.push('用户界面');
		features.push('数据存储');
	}

	return features.slice(0, IDEA_FLOW_FEATURES_MAX);
}

/**
 * Phase 2: Auto-Planning — Generate Spec and Crew
 */
async function autoPlan(): Promise<void> {
	updateState({ phase: 'auto-planning' });
	const state = requireCurrentState();
	const analysis = state.analysis;
	if (!analysis) return;

	pushLog('📐 正在自动生成产品规划…');

	try {
		const specDir = await createSpecFiles(analysis.appName, analysis.description);
		if (specDir) {
			requireCurrentState().specDir = specDir;
			pushLog(`✅ Spec 已生成: ${specDir}`);
		}

		const crew = await autoGenerateCrew(analysis);
		if (crew) {
			requireCurrentState().crewConfig = crew;
			saveCrew(crew);
			pushLog(`👥 Agent Crew 已创建: ${crew.agents.length} 个角色, ${crew.tasks.length} 个任务`);
		}

		updateState({ phase: 'crew-building' });
	} catch (err: unknown) {
		pushLog(`⚠️ 自动规划部分失败: ${err instanceof Error ? err.message : String(err)}，继续执行构建`);
		updateState({ phase: 'crew-building' });
	}
}

/**
 * Auto-generate Crew configuration from idea analysis
 */
async function autoGenerateCrew(analysis: IdeaAnalysis): Promise<CrewConfig | undefined> {
	const roles = analysis.suggestedCrewRoles;
	if (!roles.length) return undefined;

	const now = new Date().toISOString();
	const name = `idea-${analysis.appName}-${Date.now().toString(36)}`;

	// Assign unique agent IDs
	const roleCounts: Record<string, number> = {};
	const agents = roles.map(role => {
		roleCounts[role] = (roleCounts[role] || 0) + 1;
		const suffix = roleCounts[role] > 1 ? `-${roleCounts[role]}` : '';
		return {
			id: `${name}-${role}${suffix}`,
			role: role as AgentRole,
			name: getRoleDisplayName(role) + (roleCounts[role] > 1 ? ` #${roleCounts[role]}` : ''),
			systemPrompt: getRoleSystemPrompt(role, analysis),
			tools: getRoleTools(role),
		};
	});

	// Generate tasks from features with stable IDs
	const featureTasks: CrewTask[] = analysis.features.map((feature, idx) => {
		const taskId = `task-${idx}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		return {
			id: taskId,
			title: feature,
			description: `实现功能：${feature} — 属于项目【${analysis.appName}】的核心能力。技术栈：${analysis.techStack.join(', ')}。架构：${analysis.architecture}。`,
			assignedRole: 'coder' as AgentRole,
			dependencies: [],
			status: 'pending' as const,
			createdAt: now,
			updatedAt: now,
		};
	});

	// Wire deps sequentially
	for (let i = 1; i < featureTasks.length; i++) {
		featureTasks[i].dependencies = [featureTasks[i - 1].id];
	}

	const tasks = featureTasks;

	// Architect task first (no dependencies)
	const architectTask: CrewTask = {
		id: `task-arch-${Date.now().toString(36)}`,
		title: `架构设计：${analysis.appName}`,
		description: `设计 ${analysis.appName} 的整体架构。技术选型：${analysis.techStack.join(', ')}。架构风格：${analysis.architecture}。核心功能：${analysis.features.join('、')}。`,
		assignedRole: 'architect' as AgentRole,
		dependencies: [],
		status: 'pending' as const,
		createdAt: now,
		updatedAt: now,
	};

	tasks.unshift(architectTask);

	// Tester task at end (depends on all feature tasks)
	const testerTask: CrewTask = {
		id: `task-test-${Date.now().toString(36)}`,
		title: `测试验证：${analysis.appName}`,
		description: `为 ${analysis.appName} 生成测试用例并验证功能完整性。需覆盖：${analysis.features.join('、')}。`,
		assignedRole: 'tester' as AgentRole,
		dependencies: tasks.filter(t => t.assignedRole !== 'tester').map(t => t.id),
		status: 'pending' as const,
		createdAt: now,
		updatedAt: now,
	};

	tasks.push(testerTask);

	return {
		name: analysis.appName,
		description: `Idea Flow 自动生成：${analysis.description.slice(0, 100)}`,
		workflow: analysis.workflowType || 'sequential',
		agents,
		tasks,
		createdAt: now,
		updatedAt: now,
	};
}

function getRoleDisplayName(role: AgentRole): string {
	const names: Record<AgentRole, string> = {
		architect: '架构师',
		coder: '开发者',
		reviewer: '审查者',
		tester: '测试者',
		devops: 'DevOps',
		custom: '自定义 Agent',
	};
	return names[role] || role;
}

function getRoleSystemPrompt(role: AgentRole, analysis: IdeaAnalysis): string {
	const base = {
		architect: `你是高级架构师。为项目【${analysis.appName}】设计技术架构。\n技术栈：${analysis.techStack.join(', ')}。\n核心功能：${analysis.features.join('、')}。\n输出架构文档，定义模块边界、数据流和 API 契约。`,
		coder: `你是高级开发者。实现项目【${analysis.appName}】的代码。\n技术栈：${analysis.techStack.join(', ')}。\n遵循架构设计方案，编写可测试、可维护的代码。`,
		reviewer: `你是代码审查者。审查项目【${analysis.appName}】的代码质量。\n关注：安全性、性能、代码风格、测试覆盖。`,
		tester: `你是测试工程师。为项目【${analysis.appName}】编写测试。\n核心功能：${analysis.features.join('、')}。\n覆盖单元测试、集成测试、边界条件。`,
		devops: `你是 DevOps 工程师。为项目【${analysis.appName}】配置 CI/CD 和部署。\n技术栈：${analysis.techStack.join(', ')}。`,
		custom: `自定义 Agent 角色，为项目【${analysis.appName}】工作。`,
	};
	return base[role] || base.custom;
}

function getRoleTools(role: AgentRole): string[] {
	const tools: Record<AgentRole, string[]> = {
		architect: ['read_file', 'search_files', 'chat'],
		coder: ['read_file', 'search_files', 'edit_file', 'terminal'],
		reviewer: ['read_file', 'search_files', 'git_diff'],
		tester: ['read_file', 'search_files', 'edit_file', 'terminal'],
		devops: ['read_file', 'edit_file', 'terminal'],
		custom: ['read_file', 'search_files', 'edit_file', 'terminal'],
	};
	return tools[role] || tools.custom;
}

/**
 * Phase 3: Launch Crew Build — non-blocking, polls for task completion
 */
async function launchCrewBuild(_context: vscode.ExtensionContext): Promise<void> {
	updateState({ phase: 'build-in-progress' });
	const crew = currentState?.crewConfig;
	if (!crew || !crew.tasks.length) {
		if (!vscode.workspace.workspaceFolders?.length) {
			pushLog('⚠️ 请先打开一个工作区文件夹');
			vscode.window.showWarningMessage('Idea Flow 需要一个打开的工作区才能构建项目。请先打开文件夹。');
			return;
		}
		pushLog('⚠️ 无 Agent Crew 配置，直接打开 Agent 模式');
		await vscode.commands.executeCommand(COMMANDS.chatOpen, {
			mode: 'agent',
			query: `[Idea Flow] 构建项目：${currentState?.idea}\n\n## 项目描述\n${currentState?.idea}\n\n## 技术栈\n${currentState?.analysis?.techStack.join(', ') || 'React + Vite + Tailwind'}\n\n## 核心功能\n${currentState?.analysis?.features.map(f => `- ${f}`).join('\n') || ''}\n\n请从零开始构建这个项目。先进行架构设计，然后逐步实现所有功能。完成后运行 dev server 以便预览。`,
			isPartialQuery: false,
		});
		pushLog('🤖 Agent 模式已启动 — 请在聊天中查看进度');
		return;
	}

	pushLog(`👥 启动 Agent Crew「${crew.name}」共 ${crew.tasks.length} 个任务`);

	const firstTask = crew.tasks.find(t => t.status === 'pending');
	if (!firstTask) {
		pushLog('⚠️ 所有任务已完成或已在运行');
		updateState({ phase: 'preview-ready' });
		return;
	}

	firstTask.status = 'running';
	firstTask.updatedAt = new Date().toISOString();
	saveCrew(crew);
	pushLog(`🔄 执行任务: ${firstTask.title} (${getRoleDisplayName(firstTask.assignedRole)})`);

	const agent = crew.agents.find(a => a.role === firstTask.assignedRole);
	const rolePrompt = agent?.systemPrompt || `执行任务：${firstTask.title}`;

	await vscode.commands.executeCommand(COMMANDS.chatOpen, {
		mode: 'agent',
		query: `[Idea Flow - ${crew.name}]\n\n## 任务 (1/${crew.tasks.length}): ${firstTask.title}\n${firstTask.description ? `\n${firstTask.description}\n` : ''}\n## 角色指令\n${rolePrompt}\n\n## 项目背景\n${currentState?.idea}\n\n完成后请执行「Minicode: 标记 Crew 任务完成」以继续下一个任务。\n所有任务完成后，系统会自动启动 Dev Server 和预览。`,
		isPartialQuery: false,
	});

	pushLog(`⏳ 任务 1/${crew.tasks.length}: 「${firstTask.title}」已启动 — 完成后请执行「Minicode: 标记 Crew 任务完成」继续`);

	vscode.window.showInformationMessage(
		`🚀 Idea Flow: 「${firstTask.title}」已启动 (1/${crew.tasks.length})`,
		'查看 Crew 状态',
	).then(async choice => {
		if (choice === '查看 Crew 状态') {
			await Promise.resolve(vscode.commands.executeCommand(COMMANDS.crewStatus)).catch(() => {});
		}
	}, () => {});

	// Poll for task completion
	_pollInterval = setInterval(() => {
		const updatedCrew = loadCrew();
		if (!updatedCrew) return;

		const running = updatedCrew.tasks.filter(t => t.status === 'running');
		const pending = updatedCrew.tasks.filter(t => t.status === 'pending');
		const completed = updatedCrew.tasks.filter(t => t.status === 'completed');

		if (running.length === 0 && pending.length > 0) {
			const nextTask = pending[0];
			nextTask.status = 'running';
			nextTask.updatedAt = new Date().toISOString();
			saveCrew(updatedCrew);
			requireCurrentState().crewConfig = updatedCrew;
			pushLog(`🔄 自动推进到下一个任务: ${nextTask.title}`);

			const nextAgent = updatedCrew.agents.find(a => a.role === nextTask.assignedRole);
			const nextRolePrompt = nextAgent?.systemPrompt || `执行任务：${nextTask.title}`;

			vscode.commands.executeCommand(COMMANDS.chatOpen, {
				mode: 'agent',
				query: `[Idea Flow - ${crew.name}]\n\n## 任务 (${completed.length + 1}/${crew.tasks.length}): ${nextTask.title}\n${nextTask.description ? `\n${nextTask.description}\n` : ''}\n## 角色指令\n${nextRolePrompt}\n\n## 项目背景\n${currentState?.idea}\n\n完成后请执行「Minicode: 标记 Crew 任务完成」。`,
				isPartialQuery: false,
			});
			pushLog(`⏳ 任务 ${completed.length + 1}/${crew.tasks.length}: 「${nextTask.title}」已启动`);
		}

		if (completed.length === updatedCrew.tasks.length && running.length === 0) {
			clearInterval(_pollInterval!);
			_pollInterval = undefined;
			void handleBuildComplete();
		}
	}, IDEA_FLOW_POLL_INTERVAL_MS);

	// Max build timeout
	_maxTimeout = setTimeout(() => {
		if (_pollInterval !== undefined) {
			clearInterval(_pollInterval);
			_pollInterval = undefined;
		}
		if (!(currentState && currentState.phase === 'product-intelligence')) {
			pushLog('⏰ 构建超时（30分钟），可继续通过 Crew 命令完成任务');
		}
	}, IDEA_FLOW_MAX_BUILD_MS);
}

async function handleBuildComplete(): Promise<void> {
	pushLog('🏗️ 所有任务已完成！正在准备预览…');
	updateState({ phase: 'preview-ready' });

	const devChoice = await vscode.window.showInformationMessage(
		'🎉 构建完成！是否启动开发服务器查看预览？',
		'启动 Dev Server',
		'稍后手动启动',
	);

	if (devChoice === '启动 Dev Server') {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			const hasPackageJson = fs.existsSync(path.join(folder.uri.fsPath, 'package.json'));
			const hasViteConfig = fs.existsSync(path.join(folder.uri.fsPath, 'vite.config.ts'))
				|| fs.existsSync(path.join(folder.uri.fsPath, 'vite.config.js'));

			if (hasPackageJson) {
				const term = vscode.window.createTerminal({ name: 'Idea Flow Dev Server' });
				term.show();
				term.sendText(hasViteConfig ? 'npm run dev' : 'npm start');
				pushLog('🌐 Dev Server 已启动');

				const previewUrl = hasViteConfig
					? `http://localhost:${DEFAULT_PREVIEW_PORT}`
					: `http://localhost:${GENERIC_DEV_PORT}`;
				updateState({ previewUrl, phase: 'preview-ready' });

				// Open preview after a short delay
				_previewTimeout = setTimeout(async () => {
					try {
						await vscode.commands.executeCommand(COMMANDS.simpleBrowserShow, previewUrl);
						pushLog(`🌐 预览已打开: ${previewUrl}`);
					} catch {
						await Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(previewUrl))).catch(() => {});
					}
				}, SOLO_PREVIEW_DELAY_MS);
			}
		}
	}

	await captureProductIntelligence();
}

/**
 * Phase 4: Product Intelligence
 */
async function captureProductIntelligence(): Promise<void> {
	updateState({ phase: 'product-intelligence' });
	const analysis = currentState?.analysis;
	if (!analysis) return;

	pushLog('🧠 正在沉淀产品知识…');

	try {
		await recordLearning(
			`项目【${analysis.appName}】使用 ${analysis.techStack.join(', ')} 构建，架构为 ${analysis.architecture}，包含 ${analysis.features.length} 个核心功能。复杂度：${analysis.complexity}。`,
			{ source: 'auto', category: 'pattern' },
		);

		await recordLearning(
			`Idea Flow 自动生成项目：${analysis.appName}。技术选型：${analysis.techStack.join(', ')}。预估 ${analysis.estimatedFiles} 个文件。`,
			{ source: 'auto', category: 'architecture' },
		);

		pushLog('✅ 产品知识已沉淀到 Learning Engine');

		if (activeCanvas) {
			activeCanvas.webview.postMessage({
				type: 'intelUpdate',
				content: `✅ 已自动沉淀项目知识。\n技术栈: ${analysis.techStack.join(', ')}\n架构: ${analysis.architecture}\n复杂度: ${analysis.complexity}\n\n建议下一步：\n- 运行「Minicode: 查看上下文状态」查看注入的知识\n- 使用 Arena 双模型对比优化代码\n- 打开 SOLO 工作台进行增量开发`,
			});
		}

		vscode.window.showInformationMessage(
			`🧠 项目【${analysis.appName}】知识已沉淀！越用越聪明。`,
		);
	} catch (err: unknown) {
		pushLog(`⚠️ 产品智能沉淀部分失败: ${err instanceof Error ? err.message : String(err)}`);
	}

	pushLog(`🎉 Idea Flow 完成！项目「${analysis.appName}」已就绪。`);
}

/**
 * Open the preview URL in Simple Browser or external browser
 */
async function openIdeaPreview(): Promise<void> {
	const url = currentState?.previewUrl;
	if (!url) {
		vscode.window.showWarningMessage('尚无可用预览。请先完成构建。');
		return;
	}

	try {
		await vscode.commands.executeCommand(COMMANDS.simpleBrowserShow, url);
	} catch {
		await Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))).catch(() => {});
	}
}

// ── 对外暴露 ───────────────────────────────────────────────────

export function getCurrentIdeaState(): IdeaFlowState | undefined {
	return currentState || loadState();
}

export async function showIdeaFlowStatus(): Promise<void> {
	const state = currentState || loadState();
	if (!state) {
		vscode.window.showWarningMessage('尚无进行中的 Idea Flow。按 Ctrl+Shift+I 或从 Hub 启动。');
		return;
	}

	const analysis = state.analysis;
	const lines = [
		'# Idea Flow 状态',
		'',
		`**想法**: ${state.idea}`,
		`**阶段**: ${state.phase}`,
		`**开始**: ${state.startedAt.slice(0, 19)}`,
		`**更新**: ${state.updatedAt.slice(0, 19)}`,
		'',
	];

	if (analysis) {
		lines.push(
			'## 项目分析',
			'',
			`- **名称**: ${analysis.appName}`,
			`- **技术栈**: ${analysis.techStack.join(', ')}`,
			`- **架构**: ${analysis.architecture}`,
			`- **复杂度**: ${analysis.complexity}`,
			`- **预估文件**: ${analysis.estimatedFiles}`,
			`- **核心功能**: ${analysis.features.length > 0 ? analysis.features.join('、') : '（待分析）'}`,
			'',
		);
	}

	if (state.previewUrl) {
		lines.push(`- **预览**: ${state.previewUrl}`);
	}

	lines.push(
		'',
		'## 构建日志',
		'',
		...(state.buildLogs.length > 0 ? state.buildLogs.map(l => `- ${l}`) : ['（暂无日志）']),
	);

	const doc = await vscode.workspace.openTextDocument({
		content: lines.join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc);
}

// ── 注册 ───────────────────────────────────────────────────────

export function registerIdeaFlow(context: vscode.ExtensionContext): void {
	if (!vscode.workspace.getConfiguration(CONFIG_FEATURES).get<boolean>(FEATURE_FLAGS.ideaFlow, true)) {
		return;
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.ideaOpen, () => openIdeaCanvas(context)),
		vscode.commands.registerCommand(COMMANDS.ideaStart, async (promptArg?: string) => {
			const idea = promptArg?.trim() || await vscode.window.showInputBox({
				prompt: '💡 描述你的想法，AI 将全自动将其变为现实',
				placeHolder: '一个 AI 驱动的知识管理工具，支持双向链接和图谱视图…',
				ignoreFocusOut: true,
			});
			if (idea?.trim()) {
				// Reset any stale state before starting fresh
				if (!isFlowRunning) {
					pushLog('🔄 重置之前的状态');
				}
				await openIdeaCanvas(context);
				setTimeout(() => {
					void startIdeaFlow(idea.trim(), true, context);
				}, IDEA_FLOW_CANVAS_LAUNCH_DELAY_MS);
			}
		}),
		vscode.commands.registerCommand(COMMANDS.ideaStatus, () => showIdeaFlowStatus()),
		vscode.commands.registerCommand(COMMANDS.ideaRestart, async () => {
			currentState = undefined;
			isFlowRunning = false;
			cleanupTimers();
			const p = getIdeaFlowPath();
			if (p && fs.existsSync(p)) {
				try { fs.unlinkSync(p); } catch { /* file may be locked */ }
			}
			await vscode.commands.executeCommand(COMMANDS.ideaStart);
		}),
	);
}