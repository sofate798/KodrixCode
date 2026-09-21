/*---------------------------------------------------------------------------------------------
 *  Session Learning index — shared read/write for sessionLearning + dashboard stats
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { getSessionIndexPath } from '../paths';
import { isRecord, isNumber } from '../utils/jsonValidator';
import { atomicWriteFileSync } from '../utils/fsSafe';
import { logger } from '../logger';

export interface SessionIndexEntry {
	sessionId: string;
	processedAt: string;
	insightCount: number;
	userMessages: number;
	summary?: string;
}

interface SessionIndex {
	version: number;
	entries: SessionIndexEntry[];
}

export function loadSessionIndex(): SessionIndex {
	const indexPath = getSessionIndexPath();
	if (!indexPath || !fs.existsSync(indexPath)) {
		return { version: 1, entries: [] };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
		if (isRecord(raw) && isNumber(raw.version) && Array.isArray(raw.entries)) {
			return raw as unknown as SessionIndex;
		}
		logger.warn('[SessionIndex] loadSessionIndex: invalid shape — resetting');
		return { version: 1, entries: [] };
	} catch {
		return { version: 1, entries: [] };
	}
}

export function saveSessionIndex(index: SessionIndex): void {
	const indexPath = getSessionIndexPath();
	if (!indexPath) {
		return;
	}
	const entries = index.entries.slice(-200);
	atomicWriteFileSync(indexPath, JSON.stringify({ version: 1, entries }, null, 2));
}

export function appendSessionIndex(entry: SessionIndexEntry): void {
	const index = loadSessionIndex();
	index.entries.push(entry);
	saveSessionIndex(index);
}

export function getSessionLearningStats(): { processed: number; totalInsights: number } {
	const index = loadSessionIndex();
	return {
		processed: index.entries.length,
		totalInsights: index.entries.reduce((n, e) => n + e.insightCount, 0),
	};
}
