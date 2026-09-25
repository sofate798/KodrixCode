/*---------------------------------------------------------------------------------------------
 *  Session Learning — Agent 会话结束自动摘要学习（Stop Hook + LLM 蒸馏）
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { notifyContextChanged } from '../context/contextEvents';
import { persistMemoryAppend } from '../memory/memoryHelpers';
import {
	ensureDir,
	getGithubHooksDir,
	getPendingSessionsDir,
	getProcessedSessionsDir,
	getWorkspaceHooksScriptDir,
} from '../paths';
import { LearningCategory, recordLearning } from './learningEngine';
import { appendSessionIndex, loadSessionIndex } from './sessionIndex';
import { formatTranscriptForLearning, isSubstantiveSession, parseTranscriptJsonl } from './transcriptParser';
import { logger } from '../logger';
import { isRecord, isString } from '../utils/jsonValidator';

export { getSessionLearningStats } from './sessionIndex';

const HOOK_INSTALLED_KEY = 'kodrix.sessionLearningHookInstalled';
const HOOK_FILE_NAME = 'kodrix-session-learning.json';

export interface SessionPendingPayload {
	sessionId: string;
	timestamp: string;
	hookEvent?: string;
	transcriptPath?: string;
	transcriptExcerpt?: string;
	cwd?: string;
}

export interface SessionInsight {
	content: string;
	category: LearningCategory;
	confidence: 'high' | 'medium' | 'low';
}

const DISTILL_SYSTEM = `你是 Kodrix Learning Engine。从 Agent 编程会话 transcript 中提取 **0-3 条** 值得跨会话记住的项目知识。

只提取：
- 架构决策、技术选型、模块边界
- 命名/代码风格/测试约定
- 反复出现的模式或踩坑

不要提取：
- 一次性的具体代码片段
- 闲聊、翻译、与项目无关的内容
- 已在 transcript 中明确标注为临时/debug 的信息

严格返回 JSON 数组（无 markdown），每项：
{"content":"一句话","category":"architecture|convention|pattern|pitfall|preference|other","confidence":"high|medium|low"}

若无有价值内容返回 []。`;

function getSessionLearningConfig(): {
	enabled: boolean;
	mode: 'auto' | 'prompt' | 'off';
	minUserMessages: number;
	autoInstallHook: boolean;
} {
	const features = vscode.workspace.getConfiguration('kodrix.features');
	const cfg = vscode.workspace.getConfiguration('kodrix.sessionLearning');
	return {
		enabled: features.get<boolean>('sessionLearning', true),
		mode: cfg.get<'auto' | 'prompt' | 'off'>('mode', 'prompt'),
		minUserMessages: cfg.get<number>('minUserMessages', 1),
		autoInstallHook: cfg.get<boolean>('autoInstallHook', true),
	};
}

function parseInsightsFromModel(text: string): SessionInsight[] {
	const jsonMatch = text.match(/\[[\s\S]*\]/);
	if (!jsonMatch) {
		return [];
	}
	try {
		const arr = JSON.parse(jsonMatch[0]) as SessionInsight[];
		return arr.filter(i => i.content?.trim() && i.confidence !== 'low').slice(0, 3);
	} catch {
		return [];
	}
}

async function distillInsights(transcriptText: string): Promise<SessionInsight[]> {
	const models = await vscode.lm.selectChatModels({});
	if (!models.length || !transcriptText.trim()) {
		return [];
	}

	const model = models[0];
	const messages = [
		vscode.LanguageModelChatMessage.User(`${DISTILL_SYSTEM}\n\n---\n\n${transcriptText.slice(0, 10_000)}`),
	];

	const cts = new vscode.CancellationTokenSource();
	try {
		const response = await model.sendRequest(messages, {}, cts.token);
		let full = '';
		for await (const chunk of response.stream) {
			if (chunk instanceof vscode.LanguageModelTextPart) {
				full += chunk.value;
			}
		}
		return parseInsightsFromModel(full);
	} catch {
		return [];
	} finally {
		cts.dispose();
	}
}

async function applyInsights(
	insights: SessionInsight[],
	sessionId: string,
	mode: 'auto' | 'prompt',
): Promise<number> {
	if (!insights.length) {
		return 0;
	}

	let toApply = insights;
	if (mode === 'prompt') {
		const preview = insights.map(i => `• [${i.category}] ${i.content}`).join('\n');
		const choice = await vscode.window.showInformationMessage(
			l10n.t('Kodrix 从 Agent 会话提炼了 {0} 条项目知识，是否沉淀？\n\n{1}', insights.length, preview),
			l10n.t('全部沉淀'), l10n.t('逐条选择'), l10n.t('忽略'),
		);
		if (choice === l10n.t('忽略') || !choice) {
			return 0;
		}
		if (choice === l10n.t('逐条选择')) {
			const picked: SessionInsight[] = [];
			for (const insight of insights) {
				const ok = await vscode.window.showQuickPick(
					[{ label: l10n.t('沉淀'), apply: true }, { label: l10n.t('跳过'), apply: false }],
					{ placeHolder: `[${insight.category}] ${insight.content}` },
				);
				if (ok?.apply) {
					picked.push(insight);
				}
			}
			toApply = picked;
		}
	}

	let applied = 0;
	for (const insight of toApply) {
		persistMemoryAppend(insight.content);
		recordLearning(insight.content, { source: 'session', category: insight.category });
		applied++;
	}
	if (applied > 0) {
		notifyContextChanged();
		vscode.window.showInformationMessage(l10n.t('已沉淀 {0} 条会话知识（会话 {1}…）', applied, sessionId.slice(0, 8)));
	}
	return applied;
}

export async function processSessionPayload(payload: SessionPendingPayload): Promise<void> {
	const cfg = getSessionLearningConfig();
	if (!cfg.enabled || cfg.mode === 'off') {
		return;
	}

	// 优先使用内联 excerpt；为空时回退读取 transcriptPath（hook 会填充其一）。
	let transcriptRaw = payload.transcriptExcerpt || '';
	if (!transcriptRaw.trim() && payload.transcriptPath) {
		try {
			const stat = fs.statSync(payload.transcriptPath);
			// 限制单次读取大小，避免超大 transcript 阻塞 extension host
			if (stat.isFile() && stat.size <= 2_000_000) {
				transcriptRaw = fs.readFileSync(payload.transcriptPath, 'utf-8');
			} else if (stat.size > 2_000_000) {
				logger.warn(`[SessionLearning] transcript 过大（${stat.size} bytes），跳过：${payload.transcriptPath}`);
			}
		} catch (err) {
			logger.warn(`[SessionLearning] 读取 transcriptPath 失败：${payload.transcriptPath}`, err);
		}
	}

	const parsed = parseTranscriptJsonl(transcriptRaw);
	if (!isSubstantiveSession(parsed, cfg.minUserMessages)) {
		return;
	}

	const transcriptText = formatTranscriptForLearning(parsed);
	const insights = await distillInsights(transcriptText);
	const applied = await applyInsights(insights, payload.sessionId, cfg.mode);

	appendSessionIndex({
		sessionId: payload.sessionId,
		processedAt: new Date().toISOString(),
		insightCount: applied,
		userMessages: parsed.userMessageCount,
		summary: insights.map(i => i.content).join('; ').slice(0, 200) || undefined,
	});
}

function moveToProcessed(pendingPath: string, sessionId: string): void {
	const processedDir = getProcessedSessionsDir();
	if (!processedDir) {
		fs.unlinkSync(pendingPath);
		return;
	}
	ensureDir(processedDir);
	const dest = path.join(processedDir, `${sessionId}.json`);
	try {
		fs.renameSync(pendingPath, dest);
	} catch {
		fs.unlinkSync(pendingPath);
	}
}

async function processPendingFile(filePath: string): Promise<void> {
	let payload: SessionPendingPayload;
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		if (!isRecord(raw) || !isString(raw.sessionId) || !isString(raw.timestamp)) {
			logger.warn(`[SessionLearning] processPendingFile: invalid payload — removing ${filePath}`);
			fs.unlinkSync(filePath);
			return;
		}
		payload = raw as unknown as SessionPendingPayload;
	} catch {
		fs.unlinkSync(filePath);
		return;
	}

	const lockHash = crypto.createHash('sha256').update(payload.transcriptExcerpt || '').digest('hex').slice(0, 16);
	const index = loadSessionIndex();
	if (index.entries.some(e => e.sessionId === payload.sessionId)) {
		moveToProcessed(filePath, payload.sessionId);
		return;
	}

	try {
		await processSessionPayload(payload);
	} finally {
		moveToProcessed(filePath, payload.sessionId || lockHash);
	}
}

const processingQueue = new Set<string>();

function enqueuePendingFile(filePath: string): void {
	if (processingQueue.has(filePath)) {
		return;
	}
	processingQueue.add(filePath);
	void processPendingFile(filePath).finally(() => {
		processingQueue.delete(filePath);
	});
}

function scanPendingSessions(): void {
	const pendingDir = getPendingSessionsDir();
	if (!pendingDir || !fs.existsSync(pendingDir)) {
		return;
	}
	for (const name of fs.readdirSync(pendingDir)) {
		if (name.endsWith('.json')) {
			enqueuePendingFile(path.join(pendingDir, name));
		}
	}
}

export async function installSessionLearningHook(
	context: vscode.ExtensionContext,
	options?: { silent?: boolean },
): Promise<boolean> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		if (!options?.silent) {
			vscode.window.showWarningMessage(l10n.t('请先打开工作区以安装 Session Learning Hook'));
		}
		return false;
	}

	const scriptSrc = path.join(context.extensionPath, 'resources', 'hooks', 'session-learn.mjs');
	const scriptDestDir = getWorkspaceHooksScriptDir();
	const hooksDir = getGithubHooksDir();
	if (!scriptDestDir || !hooksDir || !fs.existsSync(scriptSrc)) {
		return false;
	}

	ensureDir(scriptDestDir);
	ensureDir(hooksDir);
	const scriptDest = path.join(scriptDestDir, 'session-learn.mjs');
	fs.copyFileSync(scriptSrc, scriptDest);

	const hookRel = '.kodrix/hooks/scripts/session-learn.mjs';
	const hookConfig = {
		hooks: {
			Stop: [
				{
					type: 'command',
					command: `node ${hookRel}`,
					timeout: 45,
					windows: `node ${hookRel}`,
					linux: `node ${hookRel}`,
					osx: `node ${hookRel}`,
				},
			],
		},
	};

	const hookPath = path.join(hooksDir, HOOK_FILE_NAME);
	fs.writeFileSync(hookPath, JSON.stringify(hookConfig, null, 2), 'utf-8');

	await context.workspaceState.update(HOOK_INSTALLED_KEY, true);
	if (!options?.silent) {
		vscode.window.showInformationMessage(
			l10n.t('Session Learning Hook 已安装 — Agent 会话结束时将自动提炼项目知识'),
		);
	}
	return true;
}

export async function showSessionLearningStatus(): Promise<void> {
	const cfg = getSessionLearningConfig();
	const index = loadSessionIndex();
	const pendingDir = getPendingSessionsDir();
	const pendingCount = pendingDir && fs.existsSync(pendingDir)
		? fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).length
		: 0;

	const recent = index.entries.slice(-8).reverse();
	const lines = [
		'# Session Learning — Agent 会话自动学习',
		'',
		'## 配置',
		'',
		`| 项 | 值 |`,
		`|----|-----|`,
		`| 启用 | ${cfg.enabled ? '是' : '否'} |`,
		`| 模式 | ${cfg.mode}（auto=自动沉淀 / prompt=询问 / off=关闭） |`,
		`| 最少用户消息 | ${cfg.minUserMessages} |`,
		`| 待处理队列 | ${pendingCount} |`,
		`| 已处理会话 | ${index.entries.length} |`,
		'',
		'## 最近处理',
		'',
		...(recent.length
			? recent.map(e => `- \`${e.processedAt.slice(0, 16)}\` **${e.sessionId.slice(0, 8)}…** — 沉淀 ${e.insightCount} 条 · ${e.userMessages} 轮用户消息`)
			: ['- （尚无 — 完成 Agent 任务后会自动触发）']),
		'',
		'## 原理',
		'',
		'1. `.github/hooks/kodrix-session-learning.json` 在 Agent **Stop** 时运行',
		'2. Hook 将会话 transcript 写入 `.kodrix/sessions/pending/`',
		'3. Learning Engine 用 LLM 蒸馏 0-3 条项目知识 → Memory + 学习日志',
	];

	const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
	await vscode.window.showTextDocument(doc);
}

export function registerSessionLearning(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.learn.installSessionHook', () => installSessionLearningHook(context)),
		vscode.commands.registerCommand('kodrix.learn.sessionStatus', () => showSessionLearningStatus()),
		vscode.commands.registerCommand('kodrix.learn.processPendingSessions', () => {
			scanPendingSessions();
			vscode.window.showInformationMessage('已扫描待处理会话队列');
		}),
	);

	const pendingDir = getPendingSessionsDir();
	if (pendingDir) {
		ensureDir(pendingDir);
		const pattern = new vscode.RelativePattern(vscode.Uri.file(pendingDir), '*.json');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		context.subscriptions.push(
			watcher,
			watcher.onDidCreate(uri => enqueuePendingFile(uri.fsPath)),
			watcher.onDidChange(uri => enqueuePendingFile(uri.fsPath)),
		);
		setTimeout(() => scanPendingSessions(), 4000);
	}

	const cfg = getSessionLearningConfig();
	if (cfg.enabled && cfg.autoInstallHook && !context.workspaceState.get<boolean>(HOOK_INSTALLED_KEY)) {
		setTimeout(() => {
			void installSessionLearningHook(context, { silent: true });
		}, 6000);
	}
}

