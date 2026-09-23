/*---------------------------------------------------------------------------------------------
 *  fsSafe — 原子文件写入工具
 *
 *  通过「写临时文件 + rename」保证写入的原子性，避免进程崩溃或并发写入
 *  导致 JSONL / JSON / Markdown 文件被截断或损坏。rename 在同一文件系统上是原子操作。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * 原子写入文本文件：先写入 `<file>.tmp.<pid>.<rand>`，再 rename 覆盖目标。
 * 失败时清理临时文件并抛出原始错误。
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
	const dir = path.dirname(filePath);
	const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tmp, content, 'utf-8');
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
		throw err;
	}
}
