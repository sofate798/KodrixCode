/*---------------------------------------------------------------------------------------------
 *  Tab Completion Stats — 补全接受率反馈（对标 Cursor 接受率优化）
 *
 *  采集：建议数（每次返回补全）+1；接受数（handleDidAccept）+1；拒绝 ≈ 建议 - 接受。
 *  持久化：~/.kodrix/tabCompletionStats.json（按模式 fim/fast 拆分）。
 *  闭环：统计命令展示接受率 → 数据可供未来路由参考（getTabCompletionStats）。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getKodrixDir } from '../paths';
import { logger } from '../logger';
import { isRecord } from '../utils/jsonValidator';

export interface StatsEntry {
	suggestions: number;
	accepted: number;
}

/** 一次 FIM 失败记录（含 HTTP 状态码或 'network'） */
export interface FimFailureRecord {
	at: string;
	endpoint: string;
	status: number | string;
	reason: string;
}

/** FIM 专线诊断：失败计数 / 熔断跳过的请求数 / 最近一次失败 / 最近一次跳过 */
export interface FimDiagnostics {
	failures: number;
	skips: number;
	lastFailure?: FimFailureRecord;
	lastSkipAt?: string;
	lastSkipEndpoint?: string;
}

export interface TabCompletionStats {
	total: StatsEntry;
	/** 按补全「实际产出通道」（fim/fast）拆分，降级结果计入 fast，不再混入 FIM */
	byMode: Record<string, StatsEntry>;
	fim?: FimDiagnostics;
	updatedAt: string;
}

function getStatsPath(): string {
	return path.join(getKodrixDir(), 'tabCompletionStats.json');
}

function emptyStore(): TabCompletionStats {
	return { total: { suggestions: 0, accepted: 0 }, byMode: {}, updatedAt: new Date().toISOString() };
}

function loadStats(): TabCompletionStats {
	const p = getStatsPath();
	if (!fs.existsSync(p)) {
		return emptyStore();
	}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
		if (isRecord(raw) && isRecord(raw.total)) {
			return raw as unknown as TabCompletionStats;
		}
		return emptyStore();
	} catch {
		return emptyStore();
	}
}

function saveStats(stats: TabCompletionStats): void {
	try {
		fs.mkdirSync(path.dirname(getStatsPath()), { recursive: true });
		fs.writeFileSync(getStatsPath(), JSON.stringify(stats, null, 2), 'utf-8');
	} catch (err) {
		logger.warn('[TabStats] 写入失败', err);
	}
}

function entryOf(stats: TabCompletionStats, mode: string): StatsEntry {
	if (!isRecord(stats.byMode[mode])) {
		stats.byMode[mode] = { suggestions: 0, accepted: 0 };
	}
	return stats.byMode[mode];
}

function fimStoreOf(stats: TabCompletionStats): FimDiagnostics {
	if (!isRecord(stats.fim)) {
		stats.fim = { failures: 0, skips: 0 };
	}
	return stats.fim;
}

/**
 * 补全是按键级高频事件：记录先进内存队列，合并后按 FLUSH_DELAY_MS 批量落盘。
 * 落盘时重读文件再套用增量，多窗口共享 ~/.kodrix 时不会互相覆盖计数。
 */
const FLUSH_DELAY_MS = 2_000;
const _pending: Array<(stats: TabCompletionStats) => void> = [];
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

function enqueue(mutate: (stats: TabCompletionStats) => void): void {
	_pending.push(mutate);
	_flushTimer ??= setTimeout(flushTabCompletionStats, FLUSH_DELAY_MS);
}

/** 立即把内存中的统计增量写盘（扩展停用 / 展示统计前调用） */
export function flushTabCompletionStats(): void {
	if (_flushTimer) {
		clearTimeout(_flushTimer);
		_flushTimer = undefined;
	}
	if (!_pending.length) {
		return;
	}
	const stats = loadStats();
	for (const mutate of _pending.splice(0)) {
		mutate(stats);
	}
	stats.updatedAt = new Date().toISOString();
	saveStats(stats);
}

/** 记录一次补全建议 */
export function recordTabSuggestion(mode: string): void {
	enqueue(stats => {
		stats.total.suggestions++;
		entryOf(stats, mode).suggestions++;
	});
}

/** 记录一次 FIM 通道失败（含状态码/原因），供统计与诊断回看 */
export function recordTabFimFailure(endpoint: string, status: number | string, reason: string): void {
	const at = new Date().toISOString();
	enqueue(stats => {
		const fim = fimStoreOf(stats);
		fim.failures++;
		fim.lastFailure = { at, endpoint, status, reason };
	});
}

/** 记录一次因熔断（端点此前返回 4xx）而被跳过的 FIM 请求 */
export function recordTabFimSkip(endpoint: string): void {
	const at = new Date().toISOString();
	enqueue(stats => {
		const fim = fimStoreOf(stats);
		fim.skips++;
		fim.lastSkipAt = at;
		fim.lastSkipEndpoint = endpoint;
	});
}

/** 记录一次补全接受 */
export function recordTabAccept(mode: string): void {
	enqueue(stats => {
		stats.total.accepted++;
		entryOf(stats, mode).accepted++;
	});
}

/** 当前统计（供路由/面板参考） */
export function getTabCompletionStats(): TabCompletionStats {
	flushTabCompletionStats();
	return loadStats();
}

function rateOf(e: StatsEntry): number {
	return e.suggestions > 0 ? e.accepted / e.suggestions : 0;
}

/** 展示补全统计（Markdown 文档）；blockedEndpoint 来自 tabCompletion 的会话级 FIM 熔断状态 */
export async function showTabCompletionStats(blockedEndpoint?: string): Promise<void> {
	const stats = getTabCompletionStats();
	const modes = Object.keys(stats.byMode).sort();
	const rows = modes.map(m => {
		const e = stats.byMode[m];
		return `| ${m} | ${e.suggestions} | ${e.accepted} | ${e.suggestions - e.accepted} | ${(rateOf(e) * 100).toFixed(0)}% |`;
	});
	const fim = stats.fim ?? { failures: 0, skips: 0 };
	const fimLines = [
		`- 失败（含降级）：${fim.failures} 次；熔断跳过：${fim.skips} 次`,
		fim.lastFailure
			? `- 最近失败：${fim.lastFailure.at} \`HTTP ${fim.lastFailure.status}\` ${fim.lastFailure.endpoint} —— ${fim.lastFailure.reason}`
			: '- 最近失败：无',
		blockedEndpoint
			? `- **本会话已熔断端点**：\`${blockedEndpoint}\`（4xx 后不再重试；修改 kodrix.tabCompletion.fimEnabled / fimEndpoint 设置或重启后可恢复）`
			: '- 本会话已熔断端点：无',
	];
	const doc = await vscode.workspace.openTextDocument({
		content: [
			'# Tab 补全接受率',
			'',
			'接受率 = 接受 / 建议（拒绝 ≈ 建议 − 接受）；按补全**实际产出通道**统计（FIM 降级结果计入 fast）',
			'',
			'| 通道 | 建议 | 接受 | 拒绝 | 接受率 |',
			'| --- | --- | --- | --- | --- |',
			...(rows.length ? rows : ['| — | 0 | 0 | 0 | — |']),
			'',
			`累计：${stats.total.suggestions} 建议 / ${stats.total.accepted} 接受（${(rateOf(stats.total) * 100).toFixed(0)}%）`,
			'',
			'## FIM 专线诊断',
			...fimLines,
			'',
			'数据文件：`~/.kodrix/tabCompletionStats.json`',
		].join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc, { preview: false });
}
