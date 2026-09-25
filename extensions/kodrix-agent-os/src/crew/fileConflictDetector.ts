/*---------------------------------------------------------------------------------------------
 *  Agent Crew — 文件冲突检测模块（纯检测，不执行文件修改）
 *
 *  并行 Task 可能同时修改同一文件。本模块提供：
 *  1. FileWriteTracker — 记录各 Task 的文件修改声明
 *  2. parseToolCallsFromLLMOutput — 从 LLM 输出中提取文件修改意图
 *  3. generateConflictReport — 生成冲突检测 Markdown 报告（供执行报告嵌入）
 *
 *  设计原则：只检测、只报告，不执行任何文件写入操作。
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';

// ── 类型定义 ────────────────────────────────────────────────────

/** 记录单个 Task 对文件的修改 */
export interface FileModification {
	taskId: string;
	taskLabel: string;
	relPath: string;
	action: 'create' | 'modify' | 'delete';
	content?: string;
}

/** 冲突检测结果 */
export interface FileConflict {
	relPath: string;
	tasks: { taskId: string; taskLabel: string }[];
}

// ── FileWriteTracker ────────────────────────────────────────────

/**
 * 文件写入追踪器 — 记录并行 Task 的文件修改声明。
 * 纯数据结构，不执行任何 IO。
 */
export class FileWriteTracker {
	private _modifications: FileModification[] = [];

	record(mod: FileModification): void {
		this._modifications.push(mod);
	}

	/** 检测冲突：同一文件被多个 Task 修改 */
	detectConflicts(): FileConflict[] {
		const fileMap = new Map<string, FileModification[]>();
		for (const mod of this._modifications) {
			const existing = fileMap.get(mod.relPath) || [];
			existing.push(mod);
			fileMap.set(mod.relPath, existing);
		}

		const conflicts: FileConflict[] = [];
		for (const [relPath, mods] of fileMap) {
			if (mods.length > 1) {
				conflicts.push({
					relPath,
					tasks: mods.map(m => ({ taskId: m.taskId, taskLabel: m.taskLabel })),
				});
			}
		}
		return conflicts;
	}

	/** 所有记录的修改总数 */
	get totalModifications(): number {
		return this._modifications.length;
	}

	/** 涉及的不同文件数 */
	get totalFiles(): number {
		return new Set(this._modifications.map(m => m.relPath)).size;
	}

	clear(): void {
		this._modifications = [];
	}
}

// ── LLM 输出解析 ────────────────────────────────────────────────

/**
 * 解析 LLM 输出中的工具调用（edit_file / write_file）。
 * 返回提取到的文件修改列表。
 */
export function parseToolCallsFromLLMOutput(
	output: string,
	taskId: string,
	taskLabel: string,
): FileModification[] {
	const mods: FileModification[] = [];

	// 匹配 ```file:path\n...content...\n``` 格式
	const fileBlockRegex = /```(?:file|write_file|edit_file):(\S+)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = fileBlockRegex.exec(output)) !== null) {
		mods.push({
			taskId,
			taskLabel,
			relPath: match[1],
			action: 'modify',
			content: match[2],
		});
	}

	// 匹配 <!-- write_file: path --> 注释格式
	const commentRegex = /<!--\s*(?:write_file|edit_file):\s*(\S+)\s*-->/g;
	while ((match = commentRegex.exec(output)) !== null) {
		const relPath = match[1];
		if (!mods.some(m => m.relPath === relPath)) {
			mods.push({ taskId, taskLabel, relPath, action: 'modify' });
		}
	}

	return mods;
}

// ── 冲突报告生成 ────────────────────────────────────────────────

/**
 * 生成冲突检测 Markdown 报告段落。
 * 无冲突时返回空数组（调用方可直接 spread 到报告行中）。
 */
export function generateConflictReport(
	tracker: FileWriteTracker,
	conflicts: FileConflict[],
): string[] {
	if (conflicts.length === 0) {
		return [
			'## ' + l10n.t('文件冲突检测'),
			'',
			l10n.t('✅ 无冲突 — {0} 个 Task 修改了 {1} 个文件，无重叠。', String(tracker.totalModifications), String(tracker.totalFiles)),
			'',
		];
	}

	const lines: string[] = [
		'## ' + l10n.t('文件冲突检测'),
		'',
		l10n.t('⚠️ 检测到 {0} 个文件冲突（共 {1} 个修改声明，涉及 {2} 个文件）：', String(conflicts.length), String(tracker.totalModifications), String(tracker.totalFiles)),
		'',
		'| ' + l10n.t('冲突文件') + ' | ' + l10n.t('涉及 Task') + ' |',
		'|------|------|',
	];

	for (const c of conflicts) {
		const taskNames = c.tasks.map(t => `\`${t.taskLabel}\``).join(', ');
		lines.push(`| \`${c.relPath}\` | ${taskNames} |`);
	}

	lines.push('');
	lines.push('> ' + l10n.t('注：当前版本仅检测并报告冲突，不自动执行文件修改。请手动合并冲突文件的修改内容。'));
	lines.push('');

	return lines;
}
