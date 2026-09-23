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

export interface TabCompletionStats {
	total: StatsEntry;
	byMode: Record<string, StatsEntry>;
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

/** 记录一次补全建议 */
export function recordTabSuggestion(mode: string): void {
	const stats = loadStats();
	stats.total.suggestions++;
	entryOf(stats, mode).suggestions++;
	stats.updatedAt = new Date().toISOString();
	saveStats(stats);
}

/** 记录一次补全接受 */
export function recordTabAccept(mode: string): void {
	const stats = loadStats();
	stats.total.accepted++;
	entryOf(stats, mode).accepted++;
	stats.updatedAt = new Date().toISOString();
	saveStats(stats);
}

/** 当前统计（供路由/面板参考） */
export function getTabCompletionStats(): TabCompletionStats {
	return loadStats();
}

function rateOf(e: StatsEntry): number {
	return e.suggestions > 0 ? e.accepted / e.suggestions : 0;
}

/** 展示补全统计（Markdown 文档） */
export async function showTabCompletionStats(): Promise<void> {
	const stats = loadStats();
	const modes = Object.keys(stats.byMode).sort();
	const rows = modes.map(m => {
		const e = stats.byMode[m];
		return `| ${m} | ${e.suggestions} | ${e.accepted} | ${e.suggestions - e.accepted} | ${(rateOf(e) * 100).toFixed(0)}% |`;
	});
	const doc = await vscode.workspace.openTextDocument({
		content: [
			'# Tab 补全接受率',
			'',
			'接受率 = 接受 / 建议（拒绝 ≈ 建议 − 接受）',
			'',
			'| 模式 | 建议 | 接受 | 拒绝 | 接受率 |',
			'| --- | --- | --- | --- | --- |',
			...(rows.length ? rows : ['| — | 0 | 0 | 0 | — |']),
			'',
			`累计：${stats.total.suggestions} 建议 / ${stats.total.accepted} 接受（${(rateOf(stats.total) * 100).toFixed(0)}%）`,
			'',
			'数据文件：`~/.kodrix/tabCompletionStats.json`',
		].join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc, { preview: false });
}
