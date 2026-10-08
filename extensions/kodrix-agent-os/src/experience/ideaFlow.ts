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
import { l10n } from 'vscode';
import { ensureDir, getWorkspaceKodrixDir } from '../paths';
import { recordLearning } from '../learning/learningEngine';
import { CrewConfig, saveCrew, loadCrew, CrewTask, AgentRole, WorkflowType, runAllRunnableTasks } from '../crew/agentCrew';
import { createSpecFiles } from '../spec/specHelpers';
import { createCheckpoint, recordOperation } from '../checkpoint/checkpointManager';
import { logger } from '../logger';
import { loadWebviewHtml } from '../shared/webviewHtml';
import { createTrackedPanel } from '../utils/panelTracker';
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
	IDEA_FLOW_PREVIEW_OPEN_DELAY_MS,
	IDEA_FLOW_CONFIG,
	IDEA_FLOW_CONFIG_KEYS,
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
let _lastBuildProgress = '';
let _maxTimeout: ReturnType<typeof setTimeout> | undefined;
let _previewTimeout: ReturnType<typeof setTimeout> | undefined;
let _startDelayTimeout: ReturnType<typeof setTimeout> | undefined;

function cleanupTimers(): void {
	if (_pollInterval !== undefined) { clearInterval(_pollInterval); _pollInterval = undefined; }
	if (_maxTimeout !== undefined) { clearTimeout(_maxTimeout); _maxTimeout = undefined; }
	if (_previewTimeout !== undefined) { clearTimeout(_previewTimeout); _previewTimeout = undefined; }
	if (_startDelayTimeout !== undefined) { clearTimeout(_startDelayTimeout); _startDelayTimeout = undefined; }
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
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'idea-flow.json') : undefined;
}

function persistState(): void {
	const p = getIdeaFlowPath();
	if (!p) {return;}
	ensureDir(path.dirname(p));
	try {
		fs.writeFileSync(p, JSON.stringify(currentState, null, 2), 'utf-8');
	} catch {
		// Silently skip persistence failures — not critical
	}
}

function pushLog(msg: string): void {
	if (!currentState) {return;}
	currentState.buildLogs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
	if (currentState.buildLogs.length > IDEA_FLOW_MAX_LOGS) {
		currentState.buildLogs = currentState.buildLogs.slice(-IDEA_FLOW_MAX_LOGS);
	}
	updateState({ buildLogs: currentState.buildLogs });
	pushStateToCanvas();
}

function updateState(partial: Partial<IdeaFlowState>): void {
	if (!currentState) {return;}
	currentState = { ...currentState, ...partial, updatedAt: new Date().toISOString() };
	persistState();
	_onStateChanged?.fire(currentState);
	pushStateToCanvas();
}

function loadState(): IdeaFlowState | undefined {
	const p = getIdeaFlowPath();
	if (!p || !fs.existsSync(p)) {return undefined;}
	try {
		return normalizeIdeaFlowState(JSON.parse(fs.readFileSync(p, 'utf-8')));
	} catch { return undefined; }
}

const stringList = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : [];
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.includes(v as T) ? v as T : fallback;

const COMPLEXITIES = ['low', 'medium', 'high'] as const;
const CREW_ROLES: readonly AgentRole[] = ['architect', 'coder', 'reviewer', 'tester', 'devops', 'custom'];
const WORKFLOW_TYPES: readonly WorkflowType[] = ['sequential', 'parallel', 'review-gate'];
const IDEA_PHASES: readonly IdeaPhase[] = ['idle', 'idea-capture', 'idea-analysis', 'auto-planning', 'crew-building',
	'build-in-progress', 'preview-ready', 'product-intelligence', 'error'];

/** 预览地址只允许本机 dev server（打开的是 Simple Browser / 外部浏览器，不能被状态文件指向任意站点或协议） */
export function isLocalPreviewUrl(raw: unknown): raw is string {
	if (typeof raw !== 'string') {
		return false;
	}
	try {
		const url = new URL(raw);
		return (url.protocol === 'http:' || url.protocol === 'https:')
			&& ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** LLM 输出 / 状态文件里的分析结果逐字段校验：类型不符回退默认，避免画布与后续 .join() 崩溃 */
export function normalizeIdeaAnalysis(raw: unknown, idea: string): IdeaAnalysis {
	const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const techStack = stringList(p.techStack);
	const features = stringList(p.features);
	const roles = stringList(p.suggestedCrewRoles).filter((r): r is AgentRole => CREW_ROLES.includes(r as AgentRole));
	const files = typeof p.estimatedFiles === 'number' && Number.isFinite(p.estimatedFiles) ? Math.round(p.estimatedFiles) : 10;
	return {
		appName: (typeof p.appName === 'string' && p.appName.trim())
			|| idea.split(/\s+/).slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'app',
		description: typeof p.description === 'string' && p.description.trim() ? p.description : idea,
		techStack: techStack.length ? techStack : ['React', 'Vite', 'Tailwind CSS'],
		architecture: typeof p.architecture === 'string' && p.architecture.trim() ? p.architecture : 'Web Application',
		features: features.length ? features.slice(0, IDEA_FLOW_FEATURES_MAX) : ['Core functionality'],
		estimatedFiles: Math.min(1000, Math.max(1, files)),
		complexity: oneOf(p.complexity, COMPLEXITIES, 'medium'),
		suggestedCrewRoles: roles.length ? roles : ['architect', 'coder', 'tester'],
		workflowType: oneOf(p.workflowType, WORKFLOW_TYPES, 'sequential'),
	};
}

function normalizeIdeaFlowState(raw: unknown): IdeaFlowState | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const s = raw as Record<string, unknown>;
	const idea = typeof s.idea === 'string' ? s.idea : '';
	const now = new Date().toISOString();
	return {
		...(s as unknown as IdeaFlowState),
		phase: oneOf(s.phase, IDEA_PHASES, 'idle'),
		idea,
		analysis: s.analysis === undefined ? undefined : normalizeIdeaAnalysis(s.analysis, idea),
		startedAt: typeof s.startedAt === 'string' ? s.startedAt : now,
		updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : now,
		buildLogs: stringList(s.buildLogs).slice(-IDEA_FLOW_MAX_LOGS),
		previewUrl: isLocalPreviewUrl(s.previewUrl) ? s.previewUrl : undefined,
	};
}

// ── Idea Canvas Webview ────────────────────────────────────────

let activeCanvas: vscode.WebviewPanel | undefined;

function getCanvasHtml(webview: vscode.Webview, extensionPath: string): string {
	try {
		return loadWebviewHtml(webview, extensionPath, 'idea-canvas.html');
	} catch {
		return getMinimalFallbackHtml().replace(/\{\{cspSource\}\}/g, webview.cspSource);
	}
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
<p>${l10n.t('Failed to load the resource file. Compile the extension and try again.')}</p>
</div>
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

	const panel = createTrackedPanel(
		context,
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
		handleCanvasMessage(msg, context).catch(err => {
			logger.warn('[IdeaFlow] 处理画布消息失败', err);
			void vscode.window.showErrorMessage(l10n.t('Idea Flow error: {0}', err instanceof Error ? err.message : String(err)));
		});
	});

	// 关闭画布只丢面板引用：构建轮询 / 超时 / 预览计时器属于管线本身，继续在后台推进
	panel.onDidDispose(() => {
		activeCanvas = undefined;
	});

	// Restore state if exists
	currentState = loadState();
	if (currentState) {
		pushStateToCanvas();
	}
}

function pushStateToCanvas(): void {
	if (!activeCanvas || !currentState) {return;}
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
		vscode.window.showWarningMessage(l10n.t('Idea Flow is in progress. Wait for it to finish, or use "Reset Idea Flow" to start over.'));
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

		pushLog(l10n.t('Idea received: "{0}"', idea.slice(0, 80) + (idea.length > 80 ? '…' : '')));

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
			pushLog(l10n.t('Deep analysis skipped, using fast planning mode'));
			updateState({ phase: 'auto-planning' });
		}

		await autoPlan();
		await launchCrewBuild(context);

	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		pushLog(l10n.t('Error: {0}', errMsg));
		updateState({ phase: 'error' });
		vscode.window.showErrorMessage(l10n.t('Idea Flow error: {0}', errMsg));
	} finally {
		isFlowRunning = false;
	}
}

/**
 * Phase 1: Deep Idea Analysis using LLM with multi-model fallback
 */
async function performIdeaAnalysis(idea: string): Promise<void> {
	updateState({ phase: 'idea-analysis' });
	pushLog(l10n.t('AI is analyzing your idea in depth…'));

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
		pushLog(l10n.t('No LLM model available, using heuristic analysis'));
		requireCurrentState().analysis = generateBasicAnalysis(idea);
		updateState({ analysis: requireCurrentState().analysis });
		return;
	}

	const cts = new vscode.CancellationTokenSource();
	const timeoutId = setTimeout(() => {
		cts.cancel();
		pushLog(l10n.t('LLM analysis timed out (3 minutes), falling back to heuristic analysis'));
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
		const analysis = normalizeIdeaAnalysis({ ...JSON.parse(jsonStr), description: idea }, idea);
		requireCurrentState().analysis = analysis;
		updateState({ analysis });
		pushLog(l10n.t('Analysis complete! Project: {0} ({1} complexity, about {2} files)', analysis.appName, analysis.complexity, analysis.estimatedFiles));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		pushLog(l10n.t('LLM analysis failed: {0}, using heuristic analysis', msg));
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
	if (start === -1) {throw new Error('No JSON object found in LLM response');}
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {inString = !inString;}
		if (!inString) {
			if (ch === '{') {depth++;}
			else if (ch === '}') { depth--; if (depth === 0) {return text.slice(start, i + 1);} }
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
		[/markdown/i, l10n.t('Markdown editing and rendering')],
		[/blog|博客/i, l10n.t('Blog post management')],
		[/auth|登录|user|用户/i, l10n.t('User authentication and management')],
		[/search|搜索/i, l10n.t('Full-text search')],
		[/chat|聊天|ai|对话/i, l10n.t('AI chat interface')],
		[/drag|拖拽|dnd/i, l10n.t('Drag-and-drop interactions')],
		[/api|rest/i, 'REST API'],
		[/dark|暗色|theme|主题/i, l10n.t('Dark/light theme switching')],
		[/notif|通知/i, l10n.t('Real-time notifications')],
		[/payment|支付/i, l10n.t('Payment integration')],
		[/email|邮件/i, l10n.t('Email service')],
		[/export|导出/i, l10n.t('Data export')],
		[/import|导入/i, l10n.t('Data import')],
		[/chart|图表|dashboard|仪表盘/i, l10n.t('Data visualization')],
		[/comment|评论/i, l10n.t('Comment system')],
		[/tag|标签|categor|分类/i, l10n.t('Tags and categories')],
		[/share|分享/i, l10n.t('Social sharing')],
		[/mobile|响应|responsive/i, l10n.t('Responsive mobile adaptation')],
	];

	for (const [regex, feature] of patterns) {
		if (regex.test(lower)) {
			features.push(feature);
		}
	}

	if (features.length === 0) {
		features.push(l10n.t('Core feature modules'));
		features.push(l10n.t('User interface'));
		features.push(l10n.t('Data storage'));
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
	if (!analysis) {return;}

	pushLog(l10n.t('Generating the product plan automatically…'));

	try {
		const specDir = await createSpecFiles(analysis.appName, analysis.description);
		if (specDir) {
			requireCurrentState().specDir = specDir;
			pushLog(l10n.t('Spec generated: {0}', specDir));
		}

		const crew = await autoGenerateCrew(analysis);
		if (crew) {
			requireCurrentState().crewConfig = crew;
			saveCrew(crew);
			pushLog(l10n.t('Agent Crew created: {0} roles, {1} tasks', crew.agents.length, crew.tasks.length));
		}

		updateState({ phase: 'crew-building' });
	} catch (err: unknown) {
		pushLog(l10n.t('Auto-planning partially failed: {0}, continuing with the build', err instanceof Error ? err.message : String(err)));
		updateState({ phase: 'crew-building' });
	}
}

/**
 * Auto-generate Crew configuration from idea analysis
 */
async function autoGenerateCrew(analysis: IdeaAnalysis): Promise<CrewConfig | undefined> {
	const roles = analysis.suggestedCrewRoles;
	if (!roles.length) {return undefined;}

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
		title: l10n.t('Architecture design: {0}', analysis.appName),
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
		title: l10n.t('Test verification: {0}', analysis.appName),
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
		description: l10n.t('Idea Flow auto-generated: {0}', analysis.description.slice(0, 100)),
		workflow: analysis.workflowType || 'sequential',
		agents,
		tasks,
		createdAt: now,
		updatedAt: now,
	};
}

function getRoleDisplayName(role: AgentRole): string {
	const names: Record<AgentRole, string> = {
		architect: l10n.t('Architect'),
		coder: l10n.t('Developer'),
		reviewer: l10n.t('Reviewer'),
		tester: l10n.t('Tester'),
		devops: 'DevOps',
		custom: l10n.t('Custom Agent'),
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
			pushLog(l10n.t('Open a workspace folder first'));
			vscode.window.showWarningMessage(l10n.t('Idea Flow needs an open workspace to build the project. Please open a folder first.'));
			return;
		}
		pushLog(l10n.t('No Agent Crew configuration, opening Agent mode directly'));
		await vscode.commands.executeCommand(COMMANDS.chatOpen, {
			mode: 'agent',
			query: `[Idea Flow] 构建项目：${currentState?.idea}\n\n## 项目描述\n${currentState?.idea}\n\n## 技术栈\n${currentState?.analysis?.techStack.join(', ') || 'React + Vite + Tailwind'}\n\n## 核心功能\n${currentState?.analysis?.features.map(f => `- ${f}`).join('\n') || ''}\n\n请从零开始构建这个项目。先进行架构设计，然后逐步实现所有功能。完成后运行 dev server 以便预览。`,
			isPartialQuery: false,
		});
		pushLog(l10n.t('Agent mode started — check the chat for progress'));
		return;
	}

	pushLog(l10n.t('Starting Agent Crew "{0}" with {1} tasks', crew.name, crew.tasks.length));

	const autoExecute = vscode.workspace.getConfiguration(IDEA_FLOW_CONFIG)
		.get<boolean>(IDEA_FLOW_CONFIG_KEYS.autoExecute, true);

	if (autoExecute) {
		// 端到端自动执行（构建前检查点 + Crew v2 自动执行所有可运行任务）
		await startAutoBuild(crew);
		return;
	}

	// ── 手动模式（autoExecute=false）：chat.open 逐任务推进 ──

	const firstTask = crew.tasks.find(t => t.status === 'pending');
	if (!firstTask) {
		pushLog(l10n.t('All tasks are completed or already running'));
		updateState({ phase: 'preview-ready' });
		return;
	}

	firstTask.status = 'running';
	firstTask.updatedAt = new Date().toISOString();
	saveCrew(crew);
	pushLog(l10n.t('Executing task: {0} ({1})', firstTask.title, getRoleDisplayName(firstTask.assignedRole)));

	const agent = crew.agents.find(a => a.role === firstTask.assignedRole);
	const rolePrompt = agent?.systemPrompt || `执行任务：${firstTask.title}`;

	await vscode.commands.executeCommand(COMMANDS.chatOpen, {
		mode: 'agent',
		query: `[Idea Flow - ${crew.name}]\n\n## 任务 (1/${crew.tasks.length}): ${firstTask.title}\n${firstTask.description ? `\n${firstTask.description}\n` : ''}\n## 角色指令\n${rolePrompt}\n\n## 项目背景\n${currentState?.idea}\n\n完成后请执行「Kodrix: 标记 Crew 任务完成」以继续下一个任务。\n所有任务完成后，系统会自动启动 Dev Server 和预览。`,
		isPartialQuery: false,
	});

	pushLog(l10n.t('Task 1/{0}: "{1}" started — run "Kodrix: Mark Crew Task Complete" to continue', crew.tasks.length, firstTask.title));

	vscode.window.showInformationMessage(
		l10n.t('Idea Flow: "{0}" started (1/{1})', firstTask.title, crew.tasks.length),
		l10n.t('View Crew Status'),
	).then(async choice => {
		if (choice === l10n.t('View Crew Status')) {
			await Promise.resolve(vscode.commands.executeCommand(COMMANDS.crewStatus)).catch(() => {});
		}
	}, () => {});

	// Poll for task completion
	_pollInterval = setInterval(() => {
		const updatedCrew = loadCrew();
		if (!updatedCrew) {return;}

		const running = updatedCrew.tasks.filter(t => t.status === 'running');
		const pending = updatedCrew.tasks.filter(t => t.status === 'pending');
		const completed = updatedCrew.tasks.filter(t => t.status === 'completed');
		const failed = updatedCrew.tasks.filter(t => t.status === 'failed');

		if (running.length === 0 && pending.length > 0) {
			const nextTask = pending[0];
			nextTask.status = 'running';
			nextTask.updatedAt = new Date().toISOString();
			saveCrew(updatedCrew);
			requireCurrentState().crewConfig = updatedCrew;
			pushLog(l10n.t('Auto-advancing to the next task: {0}', nextTask.title));

			const nextAgent = updatedCrew.agents.find(a => a.role === nextTask.assignedRole);
			const nextRolePrompt = nextAgent?.systemPrompt || `执行任务：${nextTask.title}`;

			Promise.resolve(vscode.commands.executeCommand(COMMANDS.chatOpen, {
				mode: 'agent',
				query: `[Idea Flow - ${crew.name}]\n\n## 任务 (${completed.length + 1}/${crew.tasks.length}): ${nextTask.title}\n${nextTask.description ? `\n${nextTask.description}\n` : ''}\n## 角色指令\n${nextRolePrompt}\n\n## 项目背景\n${currentState?.idea}\n\n完成后请执行「Kodrix: 标记 Crew 任务完成」。`,
				isPartialQuery: false,
			})).catch(err => logger.warn('[IdeaFlow] 打开下一任务的 Agent 会话失败', err));
			pushLog(l10n.t('Task {0}/{1}: "{2}" started', completed.length + 1, crew.tasks.length, nextTask.title));
			return;
		}

		// 失败任务也算终态：否则任一任务失败后轮询永远等不到「全部完成」，直到 30 分钟超时
		if (completed.length + failed.length === updatedCrew.tasks.length && running.length === 0) {
			clearInterval(_pollInterval!);
			_pollInterval = undefined;
			if (failed.length > 0) {
				pushLog(l10n.t('{0} tasks failed; check Crew status for details', failed.length));
			}
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
			pushLog(l10n.t('Build timed out (30 minutes); finish the remaining tasks with Crew commands'));
		}
	}, IDEA_FLOW_MAX_BUILD_MS);
}

/**
 * 端到端自动构建（对标 Cursor Agent）：
 * 构建前创建检查点 → runAllRunnableTasks 自动执行全部可运行任务（依赖级联推进）→
 * 轮询完成状态（进度节流）→ 全部完成 / 失败后触发预览
 */
async function startAutoBuild(crew: CrewConfig): Promise<void> {
	const ck = await createCheckpoint(l10n.t('Idea Flow pre-build ({0})', crew.name));
	if (ck) {
		recordOperation({ type: 'idea-flow', detail: `创建构建前检查点：${crew.name}`, timestamp: new Date().toISOString() });
		pushLog(l10n.t('Pre-build checkpoint created; you can roll back at any time'));
	}

	void runAllRunnableTasks(crew).catch(err => {
		pushLog(l10n.t('Auto build error: {0}', err instanceof Error ? err.message : String(err)));
		logger.error('Idea Flow auto build failed', err);
	});
	pushLog(l10n.t('End-to-end auto build started ({0} tasks executing automatically; check Crew status anytime)', crew.tasks.length));

	_pollInterval = setInterval(() => {
		const updatedCrew = loadCrew();
		if (!updatedCrew) {
			return;
		}
		requireCurrentState().crewConfig = updatedCrew;
		const completed = updatedCrew.tasks.filter(task => task.status === 'completed').length;
		const failed = updatedCrew.tasks.filter(task => task.status === 'failed').length;
		const active = updatedCrew.tasks.filter(task => task.status === 'running' || task.status === 'pending').length;

		if (completed + failed !== updatedCrew.tasks.length) {
			// 进度日志（节流：仅数量变化时记录，避免每 5s 刷屏）
			const cur = `${completed}/${failed}/${active}`;
			if (cur !== _lastBuildProgress) {
				_lastBuildProgress = cur;
				pushLog(l10n.t('Build progress: {0}/{1} completed', completed, updatedCrew.tasks.length)
					+ (failed ? l10n.t(', {0} failed', failed) : '')
					+ (active ? l10n.t(', {0} in progress', active) : ''));
			}
			return;
		}

		clearInterval(_pollInterval!);
		_pollInterval = undefined;
		if (failed > 0) {
			pushLog(l10n.t('{0} tasks failed; check Crew status for details', failed));
		}
		void handleBuildComplete();
	}, IDEA_FLOW_POLL_INTERVAL_MS);

	_maxTimeout = setTimeout(() => {
		if (_pollInterval !== undefined) {
			clearInterval(_pollInterval);
			_pollInterval = undefined;
		}
		if (!(currentState && currentState.phase === 'product-intelligence')) {
			pushLog(l10n.t('Build timed out (30 minutes); finish the remaining tasks with Crew commands'));
		}
	}, IDEA_FLOW_MAX_BUILD_MS);
}

async function handleBuildComplete(): Promise<void> {
	pushLog(l10n.t('All tasks completed! Preparing the preview…'));
	updateState({ phase: 'preview-ready' });

	const devChoice = await vscode.window.showInformationMessage(
		l10n.t('Build complete! Start the dev server to view the preview?'),
		l10n.t('Start Dev Server'),
		l10n.t('Start manually later'),
	);

	if (devChoice === l10n.t('Start Dev Server')) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			const hasPackageJson = fs.existsSync(path.join(folder.uri.fsPath, 'package.json'));
			const hasViteConfig = fs.existsSync(path.join(folder.uri.fsPath, 'vite.config.ts'))
				|| fs.existsSync(path.join(folder.uri.fsPath, 'vite.config.js'));

			if (hasPackageJson) {
				// 不受信任工作区：package.json 的 dev/start 脚本来自工作区内容，未经信任不执行
				if (vscode.workspace.isTrusted === false) {
					pushLog(l10n.t('Workspace is not trusted; Dev Server startup was skipped'));
					void vscode.window.showWarningMessage(l10n.t('Workspace is not trusted: automatic Dev Server startup was skipped (trust the workspace first, or run npm run dev manually).'));
				} else {
					const term = vscode.window.createTerminal({ name: 'Idea Flow Dev Server' });
					term.show();
					term.sendText(hasViteConfig ? 'npm run dev' : 'npm start');
					pushLog(l10n.t('Dev Server started'));
				}

				const previewUrl = hasViteConfig
					? `http://localhost:${DEFAULT_PREVIEW_PORT}`
					: `http://localhost:${GENERIC_DEV_PORT}`;
				updateState({ previewUrl, phase: 'preview-ready' });

				// Open preview after a short delay
				_previewTimeout = setTimeout(async () => {
					try {
						await vscode.commands.executeCommand(COMMANDS.simpleBrowserShow, previewUrl);
						pushLog(l10n.t('Preview opened: {0}', previewUrl));
					} catch {
						await Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(previewUrl))).catch(() => {});
					}
				}, IDEA_FLOW_PREVIEW_OPEN_DELAY_MS);
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
	if (!analysis) {return;}

	pushLog(l10n.t('Capturing product knowledge…'));

	try {
		await recordLearning(
			l10n.t('Project [{0}] built with {1}, architecture: {2}, with {3} core features. Complexity: {4}.',
				analysis.appName, analysis.techStack.join(', '), analysis.architecture, analysis.features.length, analysis.complexity),
			{ source: 'auto', category: 'pattern' },
		);

		await recordLearning(
			l10n.t('Idea Flow auto-generated project: {0}. Tech stack: {1}. Estimated {2} files.',
				analysis.appName, analysis.techStack.join(', '), analysis.estimatedFiles),
			{ source: 'auto', category: 'architecture' },
		);

		pushLog(l10n.t('Product knowledge captured to the Learning Engine'));

		if (activeCanvas) {
			activeCanvas.webview.postMessage({
				type: 'intelUpdate',
				content: l10n.t('Project knowledge captured automatically.\nTech stack: {0}\nArchitecture: {1}\nComplexity: {2}\n\nSuggested next steps:\n- Run "Kodrix: View Context Status" to see the injected knowledge\n- Use Arena dual-model comparison to refine the code\n- Use "Kodrix: Smart Routing" to continue incremental development',
					analysis.techStack.join(', '), analysis.architecture, analysis.complexity),
			});
		}

		vscode.window.showInformationMessage(
			l10n.t('Knowledge for project [{0}] captured! It gets smarter with use.', analysis.appName),
		);
	} catch (err: unknown) {
		pushLog(l10n.t('Product intelligence capture partially failed: {0}', err instanceof Error ? err.message : String(err)));
	}

	pushLog(l10n.t('Idea Flow complete! Project "{0}" is ready.', analysis.appName));
}

/**
 * Open the preview URL in Simple Browser or external browser
 */
async function openIdeaPreview(): Promise<void> {
	const url = currentState?.previewUrl;
	if (!isLocalPreviewUrl(url)) {
		vscode.window.showWarningMessage(l10n.t('No preview available. Complete the build first.'));
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
		vscode.window.showWarningMessage(l10n.t('No Idea Flow in progress. Press Ctrl+Shift+I or start from the Hub.'));
		return;
	}

	const analysis = state.analysis;
	const lines = [
		l10n.t('# Idea Flow Status'),
		'',
		`${l10n.t('**Idea**')}: ${state.idea}`,
		`${l10n.t('**Phase**')}: ${state.phase}`,
		`${l10n.t('**Started**')}: ${state.startedAt.slice(0, 19)}`,
		`${l10n.t('**Updated**')}: ${state.updatedAt.slice(0, 19)}`,
		'',
	];

	if (analysis) {
		lines.push(
			l10n.t('## Project Analysis'),
			'',
			`${l10n.t('- **Name**')}: ${analysis.appName}`,
			`${l10n.t('- **Tech stack**')}: ${analysis.techStack.join(', ')}`,
			`${l10n.t('- **Architecture**')}: ${analysis.architecture}`,
			`${l10n.t('- **Complexity**')}: ${analysis.complexity}`,
			`${l10n.t('- **Estimated files**')}: ${analysis.estimatedFiles}`,
			`${l10n.t('- **Core features**')}: ${analysis.features.length > 0 ? analysis.features.join(', ') : l10n.t('(pending analysis)')}`,
			'',
		);
	}

	if (state.previewUrl) {
		lines.push(`${l10n.t('- **Preview**')}: ${state.previewUrl}`);
	}

	lines.push(
		'',
		l10n.t('## Build Log'),
		'',
		...(state.buildLogs.length > 0 ? state.buildLogs.map(l => `- ${l}`) : [l10n.t('(no logs yet)')]),
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
				prompt: l10n.t('Describe your idea, and AI will turn it into reality fully automatically'),
				placeHolder: l10n.t('An AI-powered knowledge management tool with bidirectional links and a graph view…'),
				ignoreFocusOut: true,
			});
			if (idea?.trim()) {
				// Reset any stale state before starting fresh
				if (!isFlowRunning) {
					pushLog(l10n.t('Resetting previous state'));
				}
				await openIdeaCanvas(context);
				_startDelayTimeout = setTimeout(() => {
					_startDelayTimeout = undefined;
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
