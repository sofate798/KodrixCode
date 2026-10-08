/*---------------------------------------------------------------------------------------------
 *  Checkpoint Manager — 检查点回滚（对标 Cursor Checkpoint）
 *
 *  能力：
 *    1. 手动创建检查点：保存当前打开文件快照 + 标签（可随时回滚）
 *    2. 自动捕获：文件保存时自动记录版本，滚动保留最近 N 条
 *    3. 查看检查点：按时间 / 标签列出，可预览文件清单
 *    4. 回滚：将快照内容写回原文件（支持目录重建与文件重建）
 *    5. 操作日志：Crew / Idea Flow / 终端等动作记录，供检查点回顾
 *
 *  存储：.kodrix/checkpoints/<id>/manifest.json · auto/（自动捕获）· operations.jsonl
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import {
	COMMANDS,
	CHECKPOINT_CONFIG,
	CHECKPOINT_CONFIG_KEYS,
	CHECKPOINT_DEFAULT_MAX_ENTRIES,
	CHECKPOINT_MAX_FILES_PER_SNAPSHOT,
	CHECKPOINT_MAX_FILE_BYTES,
	WORKSPACE_KODRIX_DIR,
} from '../shared/constants';

/** 检查点快照中的单个文件 */
export interface CheckpointFile {
	relPath: string;
	content: string;
	/**
	 * 该文件在快照时是否已存在。
	 * `false` 表示"快照时还不存在、由 Agent 新建"——回滚时应删除它，否则删不掉 Agent 新建的文件。
	 * 缺省视为 true（兼容既有 manifest）。
	 */
	existed?: boolean;
}

/** 操作日志条目 */
export interface CheckpointOperation {
	type: string;
	detail: string;
	timestamp: string;
}

/** 检查点 manifest */
export interface CheckpointManifest {
	id: string;
	label: string;
	createdAt: string;
	files: CheckpointFile[];
}

/** 检查点摘要（列表展示用） */
export interface CheckpointSummary {
	id: string;
	label: string;
	createdAt: string;
	fileCount: number;
}

/** 检查点根目录（工作区 .kodrix/checkpoints） */
function getCheckpointRoot(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, 'checkpoints');
}

/** 相对路径判断（仅工作区内文件） */
function workspaceRelative(fsPath: string): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	const rel = path.relative(folder.uri.fsPath, fsPath);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		return undefined;
	}
	return rel;
}

/**
 * 校验 manifest 中的 relPath 不会逃出工作区（防路径穿越）。
 * 创建时已过滤；恢复时必须再校验（manifest 可能被篡改/损坏）。
 */
function resolveSafeRestorePath(workspace: string, relPath: string): string | undefined {
	if (!relPath || typeof relPath !== 'string') {
		return undefined;
	}
	// 拒绝绝对路径、空段、以及含 .. 的穿越
	const normalized = path.normalize(relPath);
	if (path.isAbsolute(normalized) || normalized.split(/[\\/]/).includes('..')) {
		return undefined;
	}
	const resolved = path.resolve(workspace, normalized);
	const wsNorm = path.normalize(workspace);
	if (resolved !== wsNorm && !resolved.startsWith(wsNorm + path.sep)) {
		return undefined;
	}
	return resolved;
}

/** 是否应跳过 .kodrix 内部文件 */
function isKodrixInternal(relPath: string): boolean {
	return relPath.split(/[\\/]/)[0] === WORKSPACE_KODRIX_DIR;
}

async function readManifest(id: string): Promise<CheckpointManifest | undefined> {
	const root = getCheckpointRoot();
	if (!root) {
		return undefined;
	}
	const p = path.join(root, id, 'manifest.json');
	try {
		return JSON.parse(await fs.promises.readFile(p, 'utf-8')) as CheckpointManifest;
	} catch {
		return undefined;
	}
}

/**
 * 创建检查点：收集当前打开的（工作区内）文本文档内容快照。
 * 返回检查点 id；无工作区时返回 undefined。
 */
export async function createCheckpoint(label?: string): Promise<string | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const root = getCheckpointRoot();
	if (!folder || !root) {
		return undefined;
	}

	const id = new Date().toISOString().replace(/[:.]/g, '-');
	const dir = path.join(root, id);
	await fs.promises.mkdir(dir, { recursive: true });

	const files: CheckpointFile[] = [];
	for (const doc of vscode.workspace.textDocuments) {
		if (doc.uri.scheme !== 'file') {
			continue;
		}
		const rel = workspaceRelative(doc.uri.fsPath);
		if (!rel || isKodrixInternal(rel)) {
			continue;
		}
		try {
			const stat = await fs.promises.stat(doc.uri.fsPath);
			if (stat.size > CHECKPOINT_MAX_FILE_BYTES) {
				continue;
			}
			// 快照取磁盘已保存内容，避免用 dirty 缓冲覆盖外部更新
			const content = await fs.promises.readFile(doc.uri.fsPath, 'utf-8');
			files.push({ relPath: rel, content });
		} catch {
			continue;
		}
		if (files.length >= CHECKPOINT_MAX_FILES_PER_SNAPSHOT) {
			logger.warn(`[Checkpoint] 已达单次快照上限 ${CHECKPOINT_MAX_FILES_PER_SNAPSHOT} 个文件，其余打开文档未纳入`);
			break;
		}
	}

	const manifest: CheckpointManifest = {
		id,
		label: label?.trim() || l10n.t('Manual checkpoint'),
		createdAt: new Date().toISOString(),
		files,
	};
	await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
	logger.info(`[Checkpoint] 已创建「${manifest.label}」(${files.length} 个文件)`);
	return id;
}

/**
 * 在写入之前，把若干文件的原内容补进指定检查点的快照。
 *
 * 背景：`createCheckpoint` 只快照"当前已打开的文档"，而 Agent 会新建/修改从未在编辑器里打开的
 * 文件（CI 配置、脚本、新模块）。不补这一步，"可回滚 Agent 改动"的承诺就是假的。
 *
 * @returns 实际新增的快照条目数
 */
export async function snapshotFilesIntoCheckpoint(id: string | undefined, absPaths: string[]): Promise<number> {
	if (!id || absPaths.length === 0) {
		return 0;
	}
	const root = getCheckpointRoot();
	if (!root) {
		return 0;
	}
	const manifest = await readManifest(id);
	if (!manifest) {
		return 0;
	}
	const existing = new Set(manifest.files.map(f => f.relPath));
	let added = 0;
	for (const abs of absPaths) {
		const rel = workspaceRelative(abs);
		if (!rel || isKodrixInternal(rel) || existing.has(rel)) {
			continue;
		}
		try {
			if (fs.existsSync(abs)) {
				const stat = await fs.promises.stat(abs);
				if (stat.size > CHECKPOINT_MAX_FILE_BYTES) {
					logger.warn(`[Checkpoint] 文件过大未纳入快照：${rel}`);
					continue;
				}
				manifest.files.push({ relPath: rel, content: await fs.promises.readFile(abs, 'utf-8'), existed: true });
			} else {
				// 尚不存在：记录"由 Agent 新建"，回滚时删除
				manifest.files.push({ relPath: rel, content: '', existed: false });
			}
			existing.add(rel);
			added++;
		} catch (err) {
			logger.warn(`[Checkpoint] 补快照失败：${rel} — ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (added > 0) {
		try {
			await fs.promises.writeFile(path.join(root, id, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
			logger.info(`[Checkpoint] 已为「${manifest.label}」补入 ${added} 个文件快照（共 ${manifest.files.length}）`);
		} catch (err) {
			logger.warn(`[Checkpoint] 写回 manifest 失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return added;
}

/** 列出检查点（新→旧） */
export async function listCheckpoints(): Promise<CheckpointSummary[]> {	const root = getCheckpointRoot();
	if (!root) {
		return [];
	}
	try {
		await fs.promises.stat(root);
	} catch {
		return [];
	}
	try {
		const entries = await fs.promises.readdir(root);
		const results: CheckpointSummary[] = [];
		for (const name of entries) {
			if (name === 'auto' || name === 'operations.jsonl') {
				continue;
			}
			const m = await readManifest(name);
			if (m && m.files.length > 0) {
				results.push({
					id: name,
					label: m.label ?? l10n.t('(no label)'),
					createdAt: m.createdAt ?? name,
					fileCount: m.files.length,
				});
			}
		}
		return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	} catch {
		return [];
	}
}

/** 获取检查点文件清单 */
export async function getCheckpointFiles(id: string): Promise<CheckpointFile[]> {
	const manifest = await readManifest(id);
	return manifest?.files ?? [];
}

/** 回滚：将快照内容写回原文件 */
export async function restoreCheckpoint(id: string): Promise<{ restored: number; skipped: number }> {
	const manifest = await readManifest(id);
	if (!manifest) {
		throw new Error(l10n.t('Checkpoint not found: {0}', id));
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error(l10n.t('Please open a workspace first'));
	}
	let restored = 0;
	let skipped = 0;
	for (const f of manifest.files) {
		const abs = resolveSafeRestorePath(folder.uri.fsPath, f.relPath);
		if (!abs) {
			skipped++;
			logger.warn(`[Checkpoint] 跳过不安全路径：${f.relPath}`);
			continue;
		}
		try {
			// 快照时该文件还不存在 → 它是 Agent 新建的，回滚应删除
			if (f.existed === false) {
				if (fs.existsSync(abs)) {
					await fs.promises.unlink(abs);
				}
				restored++;
				continue;
			}
			await fs.promises.mkdir(path.dirname(abs), { recursive: true });
			await fs.promises.writeFile(abs, f.content, 'utf-8');
			restored++;
		} catch (err) {
			skipped++;
			logger.error(`[Checkpoint] 恢复 ${f.relPath} 失败`, err);
		}
	}
	logger.info(`[Checkpoint] 回滚「${manifest.label}」完成：${restored} 恢复，${skipped} 跳过`);
	return { restored, skipped };
}

/** operations.jsonl 滚动上限（行数） */
const OPERATIONS_MAX_LINES = 2000;

/** 记录操作日志（供检查点回顾 / 历史追踪） */
export async function recordOperation(op: CheckpointOperation): Promise<void> {
	const root = getCheckpointRoot();
	if (!root) {
		return;
	}
	try {
		await fs.promises.mkdir(root, { recursive: true });
		const p = path.join(root, 'operations.jsonl');
		await fs.promises.appendFile(p, JSON.stringify(op) + '\n', 'utf-8');
		// 滚动清理，避免无限增长
		try {
			const stat = await fs.promises.stat(p);
			if (stat.size > 512 * 1024) {
				const lines = (await fs.promises.readFile(p, 'utf-8')).split('\n').filter(Boolean);
				if (lines.length > OPERATIONS_MAX_LINES) {
					await fs.promises.writeFile(p, lines.slice(-OPERATIONS_MAX_LINES).join('\n') + '\n', 'utf-8');
				}
			}
		} catch { /* 滚动失败不影响主路径 */ }
	} catch (err) {
		logger.error('[Checkpoint] 记录操作失败', err);
	}
}

/** 读取最近操作日志 */
export async function listOperations(limit = 50): Promise<CheckpointOperation[]> {
	const root = getCheckpointRoot();
	if (!root) {
		return [];
	}
	const p = path.join(root, 'operations.jsonl');
	try {
		await fs.promises.stat(p);
	} catch {
		return [];
	}
	try {
		const lines = (await fs.promises.readFile(p, 'utf-8')).split('\n').filter(Boolean);
		return lines.slice(-limit)
			.map(l => {
				try {
					return JSON.parse(l) as CheckpointOperation;
				} catch {
					return undefined;
				}
			})
			.filter((x): x is CheckpointOperation => x !== undefined);
	} catch {
		return [];
	}
}

/** 自动捕获：文件保存时记录版本（滚动保留 maxEntries 条） */
let _autoCaptureThrottle: NodeJS.Timeout | null = null;
export function autoCaptureFileSave(doc: vscode.TextDocument): void {
	if (!vscode.workspace.getConfiguration(CHECKPOINT_CONFIG)
		.get<boolean>(CHECKPOINT_CONFIG_KEYS.autoCapture, true)) {
		return;
	}
	if (doc.uri.scheme !== 'file') {
		return;
	}
	const rel = workspaceRelative(doc.uri.fsPath);
	if (!rel || isKodrixInternal(rel)) {
		return;
	}
	const root = getCheckpointRoot();
	if (!root) {
		return;
	}
	// 简单节流：1 秒内只执行一次
	if (_autoCaptureThrottle) {
		return;
	}
	_autoCaptureThrottle = setTimeout(() => { _autoCaptureThrottle = null; }, 1000);
	void doAutoCaptureFileSave(doc, rel, root);
}

/** 取消自动捕获节流定时器（在 deactivate 时调用；触发时机不变） */
export function disposeCheckpointThrottle(): void {
	if (_autoCaptureThrottle) {
		clearTimeout(_autoCaptureThrottle);
		_autoCaptureThrottle = null;
	}
}

async function doAutoCaptureFileSave(doc: vscode.TextDocument, rel: string, root: string): Promise<void> {
	try {
		const autoDir = path.join(root, 'auto');
		await fs.promises.mkdir(autoDir, { recursive: true });
		const stat = await fs.promises.stat(doc.uri.fsPath);
		if (stat.size > CHECKPOINT_MAX_FILE_BYTES) {
			return;
		}
		const id = new Date().toISOString().replace(/[:.]/g, '-');
		const entry = { relPath: rel, content: doc.getText(), savedAt: new Date().toISOString() };
		await fs.promises.writeFile(path.join(autoDir, `${id}-${rel.replace(/[\\/]/g, '_')}.json`), JSON.stringify(entry), 'utf-8');

		// 滚动清理：超过 maxEntries 删除最旧
		const max = vscode.workspace.getConfiguration(CHECKPOINT_CONFIG)
			.get<number>(CHECKPOINT_CONFIG_KEYS.maxEntries, CHECKPOINT_DEFAULT_MAX_ENTRIES);
		const entries = (await fs.promises.readdir(autoDir)).sort();
		for (const name of entries.slice(0, Math.max(0, entries.length - max))) {
			await fs.promises.unlink(path.join(autoDir, name));
		}
	} catch (err) {
		logger.error('[Checkpoint] 自动捕获失败', err);
	}
}

/** 格式化时间（列表展示） */
function formatTime(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) {
		return iso;
	}
	return d.toLocaleString();
}

/** 预览检查点文件清单 */
async function showCheckpointFilesPreview(id: string): Promise<void> {
	const files = await getCheckpointFiles(id);
	const manifest = await readManifest(id);
	const doc = await vscode.workspace.openTextDocument({
		content: [
			l10n.t('# Checkpoint: {0}', manifest?.label ?? id),
			'',
			l10n.t('Created: {0}', manifest?.createdAt ?? ''),
			l10n.t('Files: {0}', files.length),
			'',
			l10n.t('## File List'),
			'',
			...files.map(f => `- \`${f.relPath}\``),
		].join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc, { preview: true });
}

/** 读取检查点完整 manifest（含文件内容） */
export async function readCheckpointManifest(id: string): Promise<CheckpointManifest | undefined> {
	return readManifest(id);
}

/** 删除检查点 */
export async function deleteCheckpoint(id: string): Promise<boolean> {
	const root = getCheckpointRoot();
	if (!root) {
		return false;
	}
	const dir = path.join(root, id);
	try {
		await fs.promises.rm(dir, { recursive: true, force: true });
		logger.info(`[Checkpoint] 已删除检查点 ${id}`);
		return true;
	} catch (err) {
		logger.error(`[Checkpoint] 删除检查点 ${id} 失败`, err);
		return false;
	}
}

/** 注册 Checkpoint 命令与自动捕获 */
export function registerCheckpoints(context: vscode.ExtensionContext): void {
	// 自动捕获：文件保存
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			autoCaptureFileSave(doc);
		}),
	);

	// 创建检查点
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.checkpointCreate, async () => {
			const label = await vscode.window.showInputBox({
				title: l10n.t('Create Checkpoint'),
				prompt: l10n.t('Create a rollback marker for the current code state (optional)'),
				placeHolder: l10n.t('e.g., before an Idea Flow build'),
				ignoreFocusOut: true,
			});
			if (label === undefined) {
				return;
			}
			const id = await createCheckpoint(label);
			if (id) {
				vscode.window.showInformationMessage(l10n.t('Checkpoint created: {0}', label?.trim() || l10n.t('Manual checkpoint')));
			} else {
				vscode.window.showWarningMessage(l10n.t('Failed to create checkpoint: open a workspace first'));
			}
		}),
	);

	// 查看检查点（选择后：回滚 / 查看文件清单）
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.checkpointList, async () => {
			const list = await listCheckpoints();
			if (!list.length) {
				vscode.window.showInformationMessage(l10n.t('No checkpoints yet. Use "Kodrix: Create Checkpoint", or save a file to capture one automatically'));
				return;
			}
			const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { cid: string }>();
			qp.title = l10n.t('Checkpoint list');
			qp.placeholder = l10n.t('Select a checkpoint');
			qp.items = list.map(c => ({
				cid: c.id,
				label: `${formatTime(c.createdAt)} — ${c.label}`,
				description: l10n.t('{0} files', c.fileCount),
			}));
			qp.onDidAccept(async () => {
				const pick = qp.activeItems[0] as (vscode.QuickPickItem & { cid: string }) | undefined;
				if (!pick) {
					return;
				}
				qp.hide();
				const choice = await vscode.window.showQuickPick(
					[l10n.t('$(debug-restart) Roll Back to This Checkpoint'), l10n.t('$(files) View File List')],
					{ title: l10n.t('Checkpoint: {0}', pick.label), placeHolder: l10n.t('Select an action') },
				);
				if (choice?.includes(l10n.t('Roll Back'))) {
					const ok = await vscode.window.showWarningMessage(
						l10n.t('Roll back to "{0}"? This will overwrite {1}', pick.label, pick.description ?? ''),
						{ modal: true },
						l10n.t('Roll Back'),
					);
					if (ok !== l10n.t('Roll Back')) {
						return;
					}
					try {
						const r = await restoreCheckpoint(pick.cid);
						vscode.window.showInformationMessage(l10n.t('Rollback complete: restored {0} files{1}', r.restored, r.skipped ? l10n.t(', skipped {0}', r.skipped) : ''));
					} catch (err) {
						vscode.window.showErrorMessage(l10n.t('Rollback failed: {0}', err instanceof Error ? err.message : String(err)));
					}
				} else if (choice?.includes(l10n.t('View'))) {
					await showCheckpointFilesPreview(pick.cid);
				}
			});
			qp.onDidHide(() => qp.dispose());
			qp.show();
		}),
	);

	// 回滚（快捷命令）
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.checkpointRestore, async () => {
			const list = await listCheckpoints();
			if (!list.length) {
				vscode.window.showInformationMessage(l10n.t('No checkpoints to roll back to'));
				return;
			}
			const pick = await vscode.window.showQuickPick(
				list.map(c => ({
					label: `${formatTime(c.createdAt)} — ${c.label}`,
					description: l10n.t('{0} files', c.fileCount),
					cid: c.id,
				})),
				{ title: l10n.t('Roll Back to Checkpoint') },
			);
			if (!pick) {
				return;
			}
			const rollbackLabel = l10n.t('Roll Back');
			const ok = await vscode.window.showWarningMessage(
				l10n.t('Roll back to "{0}"? This will overwrite {1}', pick.label, pick.description ?? ''),
				{ modal: true },
				rollbackLabel,
				l10n.t('Cancel'),
			);
			if (ok !== rollbackLabel) {
				return;
			}
			try {
				const r = await restoreCheckpoint((pick as { cid: string }).cid);
				vscode.window.showInformationMessage(l10n.t('Rollback complete: restored {0} files{1}', r.restored, r.skipped ? l10n.t(', skipped {0}', r.skipped) : ''));
			} catch (err) {
				vscode.window.showErrorMessage(l10n.t('Rollback failed: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),
	);
}
