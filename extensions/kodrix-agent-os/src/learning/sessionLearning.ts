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
			l10n.t('Kodrix distilled {0} project knowledge entries from the Agent session. Save them?\n\n{1}', insights.length, preview),
			l10n.t('Distill All'), l10n.t('Select one by one'), l10n.t('Ignore'),
		);
		if (choice === l10n.t('Ignore') || !choice) {
			return 0;
		}
		if (choice === l10n.t('Select one by one')) {
			const picked: SessionInsight[] = [];
			for (const insight of insights) {
				const ok = await vscode.window.showQuickPick(
					[{ label: l10n.t('Distill'), apply: true }, { label: l10n.t('Skip'), apply: false }],
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
		vscode.window.showInformationMessage(l10n.t('Captured {0} pieces of session knowledge (session {1}…)', applied, sessionId.slice(0, 8)));
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

/** 已处理会话的保留上限与保留天数（transcript 属私有数据，不能无限堆积在工作区里） */
const PROCESSED_KEEP_MAX = 50;
const PROCESSED_KEEP_DAYS = 7;

/** 清理已处理会话：超过天数或超过数量的旧文件删除（只保留最近若干条便于排查） */
function pruneProcessedSessions(processedDir: string): void {
	try {
		const files = fs.readdirSync(processedDir)
			.filter(f => f.endsWith('.json'))
			.map(f => {
				const full = path.join(processedDir, f);
				return { full, mtime: fs.statSync(full).mtimeMs };
			})
			.sort((a, b) => b.mtime - a.mtime);

		const cutoff = Date.now() - PROCESSED_KEEP_DAYS * 24 * 60 * 60 * 1000;
		let removed = 0;
		for (let i = 0; i < files.length; i++) {
			if (i < PROCESSED_KEEP_MAX && files[i].mtime >= cutoff) {continue;}
			fs.unlinkSync(files[i].full);
			removed++;
		}
		if (removed > 0) {
			logger.info(`[SessionLearning] 已清理 ${removed} 个过期会话记录（保留最多 ${PROCESSED_KEEP_MAX} 条 / ${PROCESSED_KEEP_DAYS} 天）`);
		}
	} catch (err) {
		logger.warn(`[SessionLearning] 清理已处理会话失败：${err instanceof Error ? err.message : String(err)}`);
	}
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
		pruneProcessedSessions(processedDir);
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
			vscode.window.showWarningMessage(l10n.t('Please open a workspace first to install the Session Learning Hook'));
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
			l10n.t('Session Learning Hook installed — project knowledge will be distilled automatically when an Agent session ends'),
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
		l10n.t('# Session Learning — Automatic learning from Agent sessions'),
		'',
		l10n.t('## Configuration'),
		'',
		l10n.t('| Setting | Value |'),
		'|----|-----|',
		l10n.t('| Enabled | {0} |', cfg.enabled ? l10n.t('Yes') : l10n.t('No')),
		l10n.t('| Mode | {0} (auto = distill automatically / prompt = ask each time / off = disabled) |', cfg.mode),
		l10n.t('| Minimum user messages | {0} |', cfg.minUserMessages),
		l10n.t('| Pending queue | {0} |', pendingCount),
		l10n.t('| Processed sessions | {0} |', index.entries.length),
		'',
		l10n.t('## Recently processed'),
		'',
		...(recent.length
			? recent.map(e => l10n.t('- `{0}` **{1}…** — {2} insights distilled · {3} user messages', e.processedAt.slice(0, 16), e.sessionId.slice(0, 8), e.insightCount, e.userMessages))
			: [l10n.t('(None yet — triggers automatically when an Agent task finishes)')]),
		'',
		l10n.t('## How it works'),
		'',
		l10n.t('1. `.github/hooks/kodrix-session-learning.json` runs when the Agent **Stop** event fires'),
		l10n.t('2. The Hook writes the session transcript to `.kodrix/sessions/pending/`'),
		l10n.t('3. The Learning Engine uses an LLM to distill 0-3 project knowledge entries → Memory + learning log'),
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
			vscode.window.showInformationMessage(l10n.t('Scanned pending session queue'));
		}),
	);

	const pendingDir = getPendingSessionsDir();
	if (pendingDir) {
		ensureDir(pendingDir);
		const pattern = new vscode.RelativePattern(vscode.Uri.file(pendingDir), '*.json');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		const scanTimer = setTimeout(() => scanPendingSessions(), 4000);
		context.subscriptions.push(
			watcher,
			watcher.onDidCreate(uri => enqueuePendingFile(uri.fsPath)),
			watcher.onDidChange(uri => enqueuePendingFile(uri.fsPath)),
			new vscode.Disposable(() => clearTimeout(scanTimer)),
		);
	}

	const cfg = getSessionLearningConfig();
	if (cfg.enabled && cfg.autoInstallHook && !context.workspaceState.get<boolean>(HOOK_INSTALLED_KEY)) {
		const hookTimer = setTimeout(() => {
			void installSessionLearningHook(context, { silent: true });
		}, 6000);
		context.subscriptions.push(new vscode.Disposable(() => clearTimeout(hookTimer)));
	}
}

