/*---------------------------------------------------------------------------------------------
 *  Learning Engine — 越用越聪明：跨会话沉淀、自动同步 Instructions
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { notifyContextChanged } from '../context/contextEvents';
import { emitKodrixEvent } from '../context/kodrixEventBus';
import { inferLearningCategory } from './learningRetrieval';
import { readMemoryContent, persistMemoryAppend } from '../memory/memoryHelpers';
import {
	ensureDir,
	getLearningLogPath,
	getMemoryDir,
	getMemoryInstructionsPath,
} from '../paths';
import { indexLearningEntry, rebuildIndex, searchSimilar, getSemanticStats } from './semanticMemory';
import { getSessionLearningStats } from './sessionIndex';
import { isRecord, isString } from '../utils/jsonValidator';
import { atomicWriteFileSync } from '../utils/fsSafe';
import { createTrackedPanel } from '../utils/panelTracker';
import { logger } from '../logger';
import { loadWebviewHtml } from '../shared/webviewHtml';

export type LearningSource = 'manual' | 'capture' | 'session' | 'wiki' | 'spec' | 'auto';
export type LearningCategory = 'architecture' | 'convention' | 'pattern' | 'pitfall' | 'preference' | 'other';

export interface LearningEntry {
	id: string;
	timestamp: string;
	source: LearningSource;
	category: LearningCategory;
	content: string;
}

const MAX_LEARNING_IN_INSTRUCTIONS = 12;
const MAX_LEARNING_LOG_BYTES = 512_000;

const INSTRUCTIONS_FRONTMATTER = `---
applyTo: '**'
description: Kodrix 项目 Memory 与学习沉淀（自动同步，请勿手动改文件名）
---

`;

// ── Instructions 同步限流（防止高频写入磁盘） ─────────────────────

let _syncScheduled = false;

function scheduleSyncInstructions(): void {
	if (_syncScheduled) return;
	_syncScheduled = true;
	setTimeout(() => {
		_syncScheduled = false;
		try { syncProjectInstructionsFile(); } catch { /* non-critical */ }
	}, 1000);
}

function isValidLearningEntry(v: unknown): v is LearningEntry {
	return isRecord(v) && isString(v.id) && isString(v.timestamp)
		&& isString(v.source) && isString(v.category) && isString(v.content);
}

export function readLearningLog(): LearningEntry[] {
	const logPath = getLearningLogPath();
	if (!fs.existsSync(logPath)) {
		return [];
	}
	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	const entries: LearningEntry[] = [];
	for (const line of lines) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (isValidLearningEntry(parsed)) {
				entries.push(parsed);
			}
		} catch {
			// skip corrupt line
		}
	}
	return entries;
}

function appendLearningLog(entry: LearningEntry): void {
	const logPath = getLearningLogPath();
	ensureDir(getMemoryDir());
	fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');

	// 文件超限时使用原子写入压缩（保留最新 200 条）
	if (fs.statSync(logPath).size > MAX_LEARNING_LOG_BYTES) {
		const kept = readLearningLog().slice(-200);
		atomicWriteFileSync(logPath, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
	}
}

export function recordLearning(
	content: string,
	options?: { source?: LearningSource; category?: LearningCategory },
): LearningEntry {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('learning', true);
	if (!enabled) {
		return {
			id: 'disabled',
			timestamp: new Date().toISOString(),
			source: options?.source ?? 'manual',
			category: options?.category ?? 'other',
			content: content.trim(),
		};
	}

	const entry: LearningEntry = {
		id: crypto.randomUUID(),
		timestamp: new Date().toISOString(),
		source: options?.source ?? 'manual',
		category: options?.category ?? inferLearningCategory(content),
		content: content.trim(),
	};
	appendLearningLog(entry);
	indexLearningEntry(entry);
	scheduleSyncInstructions(); // 限流：1s 内只写一次磁盘
	notifyContextChanged();
	emitKodrixEvent({ type: 'learning.recorded', id: entry.id, category: entry.category });
	return entry;
}

export function syncProjectInstructionsFile(): void {
	const memory = readMemoryContent();
	const recent = readLearningLog().slice(-MAX_LEARNING_IN_INSTRUCTIONS).reverse();
	const learningSection = recent.length
		? recent.map(e => `- **${e.category}** (${e.source}, ${e.timestamp.slice(0, 10)}): ${e.content}`).join('\n')
		: '- （尚无自动学习记录 — 使用 `Kodrix: 沉淀项目知识` 或 `从对话捕获 Memory`）';

	const body = `${INSTRUCTIONS_FRONTMATTER}# Kodrix 项目上下文（自动同步）

> 此文件由 Agent OS 自动生成并注入 Agent 指令。请编辑同目录下的 \`memory.md\` 修改长期 Memory。

## 项目 Memory

${memory.trim() || '（空 — 运行 `Kodrix: 查看项目 Memory` 开始记录）'}

## 近期学习（越用越聪明）

${learningSection}

## Agent 提示

- 优先遵循上述 Memory 与近期学习中的约定
- 复杂任务前先查阅 Repo Wiki（\`.kodrix/wiki/\`）
- 使用 \`#codebase\` 补充代码语义上下文
`;

	const outPath = getMemoryInstructionsPath();
	ensureDir(getMemoryDir());
	atomicWriteFileSync(outPath, body);
}

export function getLearningContextSummary(maxEntries = 5, maxChars = 800, query?: string): string {
	const all = readLearningLog();
	if (!all.length) {
		return '';
	}

	const entries = query?.trim()
		? searchSimilar(query, maxEntries).map(r => r.entry)
		: all.slice(-maxEntries).reverse();

	if (!entries.length) {
		return '';
	}

	const header = query?.trim() ? '[Relevant Learning]' : '[Recent Learning]';
	const lines = entries.map(e => `- [${e.category}] ${e.content}`);
	const text = `${header}\n${lines.join('\n')}`;
	return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

export function getRelevantLearningForFile(filePath: string, maxEntries = 3): LearningEntry[] {
	return searchSimilar(filePath, maxEntries).map(r => r.entry);
}

export function getLearningStats(): { total: number; categories: Record<string, number>; lastUpdated?: string } {
	const entries = readLearningLog();
	const categories: Record<string, number> = {};
	for (const e of entries) {
		categories[e.category] = (categories[e.category] || 0) + 1;
	}
	return {
		total: entries.length,
		categories,
		lastUpdated: entries.at(-1)?.timestamp,
	};
}

export function getRecentLearning(limit = 5): LearningEntry[] {
	return readLearningLog().slice(-limit).reverse();
}

export async function learnFromSelection(): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('learning', true);
	if (!enabled) {
		vscode.window.showWarningMessage('Learning Engine 已关闭。可在设置中启用 kodrix.features.learning');
		return;
	}

	const editor = vscode.window.activeTextEditor;
	const selection = editor?.document.getText(editor.selection);
	const input = selection || await vscode.window.showInputBox({
		prompt: '沉淀为项目知识（将写入 Memory + 学习日志并注入 Agent）',
		placeHolder: '此模块使用 Repository 模式，测试用 vitest',
	});
	if (!input?.trim()) {
		return;
	}

	const category = await vscode.window.showQuickPick(
		([
			{ label: '架构偏好', value: 'architecture' as LearningCategory },
			{ label: '命名/约定', value: 'convention' as LearningCategory },
			{ label: '常用模式', value: 'pattern' as LearningCategory },
			{ label: '已知陷阱', value: 'pitfall' as LearningCategory },
			{ label: '个人偏好', value: 'preference' as LearningCategory },
			{ label: '其他', value: 'other' as LearningCategory },
		]),
		{ placeHolder: '选择知识类别' },
	);

	persistMemoryAppend(input.trim());
	recordLearning(input.trim(), { source: 'capture', category: category?.value ?? 'other' });
	vscode.window.showInformationMessage('已沉淀项目知识 — 下次 Agent 会话将自动携带');
}

let learningDashboardPanel: vscode.WebviewPanel | undefined;

export async function showLearningDashboard(context?: vscode.ExtensionContext): Promise<void> {
	if (learningDashboardPanel) {
		learningDashboardPanel.reveal(vscode.ViewColumn.One);
		pushLearningDashboard();
		return;
	}

	if (!context) {
		// Fallback: show text version
		const stats = getLearningStats();
		const doc = await vscode.workspace.openTextDocument({
			content: `Learning: ${stats.total} entries, categories: ${JSON.stringify(stats.categories)}`,
			language: 'markdown',
		});
		await vscode.window.showTextDocument(doc);
		return;
	}

	// 使用统一的 createTrackedPanel，确保 deactivate 时随 disposeAllTrackedPanels 一起清理
	const panel = createTrackedPanel(
		context,
		'kodrix.learningDashboard',
		'Learning Dashboard',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
		},
	);

	learningDashboardPanel = panel;
	panel.iconPath = new vscode.ThemeIcon('graph');

	try {
		panel.webview.html = loadWebviewHtml(panel.webview, context.extensionPath, 'learning-dashboard.html');
	} catch (err) {
		logger.warn('[LearningEngine] 加载 dashboard HTML 资源失败', err);
		panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>`
			+ `<body style="font-family:sans-serif;padding:24px">`
			+ `<h2>Learning Dashboard</h2><p>资源加载失败，请重新编译扩展。</p></body></html>`;
	}

	panel.webview.onDidReceiveMessage(msg => {
		if (msg.command === 'ready') pushLearningDashboard();
		if (msg.command === 'refresh') pushLearningDashboard();
		if (msg.command === 'capture') {
			void vscode.commands.executeCommand('kodrix.learn.capture');
			setTimeout(() => pushLearningDashboard(), 500);
		}
	});

	panel.onDidDispose(() => {
		learningDashboardPanel = undefined;
	});

	pushLearningDashboard();
}

function pushLearningDashboard(): void {
	if (!learningDashboardPanel) return;

	const entries = readLearningLog();
	const stats = getLearningStats();
	let ss = { processed: 0, totalInsights: 0 };
	let semantic = { totalVectors: 0 };

	try {
		semantic = getSemanticStats();
	} catch {
		// semantic index not yet built
	}

	try {
		ss = getSessionLearningStats();
	} catch {
		// session index not yet available
	}

	// Count this week
	const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const thisWeek = entries.filter(e => e.timestamp >= weekAgo).length;

	// Memory count
	let memCount = 0;
	try {
		const mc = readMemoryContent();
		memCount = mc.split('\n').filter(l => l.trim().startsWith('-')).length || (mc.trim() ? 1 : 0);
	} catch {}

	learningDashboardPanel.webview.postMessage({
		type: 'dashboard',
		entries: [...entries].reverse(), // 不原地修改 readLearningLog 返回值
		stats: {
			totalEntries: stats.total,
			sessionProcessed: ss.processed,
			semanticVectors: semantic.totalVectors,
			thisWeek,
			memoryCount: memCount,
		},
	});
}


export function registerLearningEngine(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.learn.capture', () => learnFromSelection()),
		vscode.commands.registerCommand('kodrix.learn.dashboard', () => showLearningDashboard(context)),
	);

	ensureDir(getMemoryDir());
	syncProjectInstructionsFile();
	// 语义索引重建可能读取较大日志，延迟到激活之后执行，避免阻塞扩展启动
	const rebuildTimer = setTimeout(() => {
		try {
			if (readLearningLog().length > 0 && getSemanticStats().totalVectors === 0) {
				rebuildIndex();
			}
		} catch (err) {
			logger.warn('[LearningEngine] 启动时重建语义索引失败', err);
		}
	}, 2000);
	context.subscriptions.push({ dispose: () => clearTimeout(rebuildTimer) });
}
