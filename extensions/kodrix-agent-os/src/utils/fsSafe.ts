/*---------------------------------------------------------------------------------------------
 *  fsSafe — 原子文件写入工具
 *
 *  通过「写临时文件 + rename」保证写入的原子性，避免进程崩溃或并发写入
 *  导致 JSONL / JSON / Markdown 文件被截断或损坏。rename 在同一文件系统上是原子操作。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';

/** 目标路径是否位于当前工作区内（用于区分"写用户主目录"与"写工作区"） */
function isInsideWorkspace(filePath: string): boolean {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const target = path.resolve(filePath);
	return folders.some(folder => {
		const root = path.resolve(folder.uri.fsPath);
		return target === root || target.startsWith(root + path.sep);
	});
}

/**
 * 不受信任工作区里禁止写**工作区内的**文件（写用户主目录下的配置/缓存仍然允许）。
 * 语义：只有 VS Code 明确告知 isTrusted === false 时才拦截；undefined（例如测试环境）按允许处理。
 */
export function isWorkspaceWriteBlocked(target: string): boolean {
	return vscode.workspace.isTrusted === false && isInsideWorkspace(target);
}

/** 同上的抛错版本（写操作使用；只想跳过而不想中断的调用方用 isWorkspaceWriteBlocked） */
export function assertWorkspaceWriteAllowed(filePath: string): void {
	if (isWorkspaceWriteBlocked(filePath)) {
		throw new Error(l10n.t('Untrusted workspace: writing to workspace file {0} was rejected (trust the workspace first)', filePath));
	}
}

/**
 * Agent / Apply 写入前的统一闸门：
 *  1) 任一层名为 `.git` 一律拒绝（含大小写变体、子模块 nested `.git`）；
 *  2) 不受信任工作区拒绝写工作区文件。
 */
export function assertAgentCanWrite(target: string, workspace: string): void {
	const rel = path.relative(workspace, target).replace(/\\/g, '/');
	if (rel.toLowerCase().split('/').includes('.git')) {
		throw new Error('拒绝写入 .git 目录（改写 git hook/config 会导致任意代码执行）');
	}
	assertWorkspaceWriteAllowed(target);
}

/** 临时文件名：`<file>.tmp.<pid>.<rand>`（同目录，保证 rename 在同文件系统内原子） */
function tempPathFor(filePath: string): string {
	return `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
}

/** `atomicWriteFileAsync` 的分段大小（字符数）：4MB ≈ 单次编码 10ms 量级 */
const ASYNC_WRITE_CHUNK_CHARS = 4 * 1024 * 1024;

/**
 * 原子写入文本文件：先写入 `<file>.tmp.<pid>.<rand>`，再 rename 覆盖目标。
 * 失败时清理临时文件并抛出原始错误。
 * 不受信任工作区中写工作区文件会先被 assertWorkspaceWriteAllowed 拒绝。
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
	assertWorkspaceWriteAllowed(filePath);
	const dir = path.dirname(filePath);
	const tmp = tempPathFor(filePath);
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tmp, content, 'utf-8');
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
		throw err;
	}
}

/**
 * 异步版原子写入，语义与 `atomicWriteFileSync` 完全一致。
 * 用于中等大小的内容：分段写入并在段间让出事件循环。
 * 超大内容（例如 20k 文件的索引 ≈ 50MB）请用 `atomicWriteStreamAsync`，避免先构造整段字符串。
 */
export async function atomicWriteFileAsync(filePath: string, content: string): Promise<void> {
	assertWorkspaceWriteAllowed(filePath);
	const dir = path.dirname(filePath);
	const tmp = tempPathFor(filePath);
	try {
		await fs.promises.mkdir(dir, { recursive: true });
		const stream = fs.createWriteStream(tmp, { encoding: 'utf-8' });
		try {
			for (let offset = 0; offset < content.length; offset += ASYNC_WRITE_CHUNK_CHARS) {
				if (!stream.write(content.slice(offset, offset + ASYNC_WRITE_CHUNK_CHARS))) {
					await new Promise<void>(resolve => stream.once('drain', () => resolve()));
				}
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			await new Promise<void>((resolve, reject) => {
				stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
			});
		} catch (err) {
			stream.destroy();
			throw err;
		}
		await fs.promises.rename(tmp, filePath);
	} catch (err) {
		try { await fs.promises.unlink(tmp); } catch { /* best-effort cleanup */ }
		throw err;
	}
}

/**
 * 流式原子写入：由 producer 自行分段写入（可在段间让出），完成后原子 rename 覆盖目标。
 * 用于"内容大到不该先构造成一个字符串"的场景：20k 文件的索引约 50MB，
 * 一次性 `JSON.stringify` 实测单次阻塞约 175ms（数据见 `npm run measure:index-perf`）。
 * 语义与其它原子写入一致：先写 `<file>.tmp.<pid>.<rand>`，失败时清理临时文件。
 */
export async function atomicWriteStreamAsync(
	filePath: string,
	producer: (stream: fs.WriteStream) => Promise<void>,
	options?: {
		/**
		 * 落盘前的最后一道校验：返回 false 则放弃本次写入（清理临时文件、不 rename）。
		 * 用于"写入期间目标已被删除/构建已过期"的场景，避免原子 rename 把已删除的文件又写回来。
		 */
		shouldCommit?: () => boolean;
	},
): Promise<void> {
	assertWorkspaceWriteAllowed(filePath);
	const dir = path.dirname(filePath);
	const tmp = tempPathFor(filePath);
	try {
		await fs.promises.mkdir(dir, { recursive: true });
		const stream = fs.createWriteStream(tmp, { encoding: 'utf-8' });
		try {
			await producer(stream);
			await new Promise<void>((resolve, reject) => {
				stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
			});
		} catch (err) {
			stream.destroy();
			throw err;
		}
		if (options?.shouldCommit && !options.shouldCommit()) {
			throw new Error(l10n.t('Write canceled: the target was deleted while writing, or the build is stale'));
		}
		await fs.promises.rename(tmp, filePath);
	} catch (err) {
		try { await fs.promises.unlink(tmp); } catch { /* best-effort cleanup */ }
		throw err;
	}
}
