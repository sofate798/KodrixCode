/*---------------------------------------------------------------------------------------------
 *  Vibe Iteration — Vibe Coding 迭代式状态管理
 *
 *  管理 Vibe Coding 会话中的多轮迭代：
 *    - 每轮迭代自动创建 Checkpoint，支持回退到任意版本
 *    - 记录用户反馈与时间线，提供迭代摘要
 *    - 会话级生命周期管理
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';
import { createCheckpoint, restoreCheckpoint } from '../checkpoint/checkpointManager';
import { logger } from '../logger';

interface VibeIterationEntry {
	checkpointId: string;
	label: string;
	timestamp: string;
	feedback?: string;
}

interface VibeIterationState {
	sessionId: string;
	originalPrompt: string;
	iterations: VibeIterationEntry[];
	currentIteration: number;
}

const _sessions = new Map<string, VibeIterationState>();

/**
 * 开始新的 Vibe 迭代会话。
 */
export function startIterationSession(originalPrompt: string): string {
	const sessionId = crypto.randomUUID();
	_sessions.set(sessionId, {
		sessionId,
		originalPrompt,
		iterations: [],
		currentIteration: 0,
	});
	logger.info(`[VibeIteration] 开始迭代会话 ${sessionId}`);
	return sessionId;
}

/**
 * 记录一次迭代（自动创建 Checkpoint）。
 * 返回 checkpointId 与迭代编号；无工作区时返回 undefined。
 */
export async function recordIteration(
	sessionId: string,
	label: string,
	feedback?: string,
): Promise<{ checkpointId: string; iterationNumber: number } | undefined> {
	const session = _sessions.get(sessionId);
	if (!session) {
		logger.warn(`[VibeIteration] 未知会话 ${sessionId}`);
		return undefined;
	}

	const cpLabel = label;
	const cpId = await createCheckpoint(cpLabel);

	session.iterations.push({
		checkpointId: cpId ?? '',
		label,
		timestamp: new Date().toISOString(),
		feedback,
	});
	session.currentIteration = session.iterations.length;

	logger.info(`[VibeIteration] 迭代 #${session.currentIteration} 已记录 (checkpoint=${cpId ?? 'none'})`);
	return { checkpointId: cpId ?? '', iterationNumber: session.currentIteration };
}

/**
 * 回退到指定迭代版本。
 */
export async function rollbackToIteration(
	sessionId: string,
	iterationNumber: number,
): Promise<boolean> {
	const session = _sessions.get(sessionId);
	if (!session || iterationNumber < 1 || iterationNumber > session.iterations.length) {
		return false;
	}

	const target = session.iterations[iterationNumber - 1];
	if (!target.checkpointId) {
		logger.warn(`[VibeIteration] 迭代 #${iterationNumber} 无 Checkpoint，无法回退`);
		return false;
	}

	try {
		await restoreCheckpoint(target.checkpointId);
		session.currentIteration = iterationNumber;
		logger.info(`[VibeIteration] 已回退到迭代 #${iterationNumber}`);
		return true;
	} catch (err) {
		logger.error(`[VibeIteration] 回退失败`, err);
		return false;
	}
}

/**
 * 获取迭代摘要（纯文本）。
 */
export function getIterationSummary(sessionId: string): string | undefined {
	const session = _sessions.get(sessionId);
	if (!session) {
		return undefined;
	}

	if (session.iterations.length === 0) {
		return l10n.t('暂无迭代记录');
	}

	return session.iterations.map((iter, i) => {
		const time = new Date(iter.timestamp).toLocaleTimeString();
		const feedbackPart = iter.feedback ? ` — ${iter.feedback}` : '';
		return `#${i + 1}: ${iter.label} (${time})${feedbackPart}`;
	}).join('\n');
}

/**
 * 获取迭代次数。
 */
export function getIterationCount(sessionId: string): number {
	return _sessions.get(sessionId)?.iterations.length ?? 0;
}

/**
 * 结束迭代会话并清理状态。
 */
export function endIterationSession(sessionId: string): void {
	_sessions.delete(sessionId);
	logger.info(`[VibeIteration] 会话 ${sessionId} 已结束`);
}
