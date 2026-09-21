/*---------------------------------------------------------------------------------------------
 *  SOLO Agent 构建进度追踪 — 与工作台 Terminal 栏联动
 *
 *  大厂工程化标准：
 *   1. 所有常量来自 constants.ts，无本地重复定义
 *   2. 使用 isBuildStatus() 类型守卫替代 as BuildStatus 不安全断言
 *   3. 定时器回调中做状态一致性检查，防止竞态条件
 *   4. watcher 创建失败时主动清理
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getSoloPlanDir } from './soloPlan';
import {
	BUILD_STATUS_FILENAME,
	SOLO_MAX_LOGS,
	SOLO_BUILD_IDLE_MS,
	SOLO_BUILD_MAX_MS,
	DEP_LOCKFILE_RE,
	PROJECT_ENTRY_RE,
	BUILD_TRACK_SKIP_DIRS,
	PHASE_LABEL,
	COMMANDS,
} from './constants';

export type BuildPhase = 'idle' | 'agent' | 'files' | 'install' | 'dev' | 'done' | 'error';

export interface BuildStatus {
	phase: BuildPhase;
	message: string;
	fileChangeCount: number;
	logs: string[];
	startedAt?: string;
	updatedAt?: string;
}

// ── 类型守卫 ────────────────────────────────────────────────────────

const VALID_PHASES = new Set<BuildPhase>(['idle', 'agent', 'files', 'install', 'dev', 'done', 'error']);

function isBuildStatus(raw: unknown): raw is BuildStatus {
	if (!raw || typeof raw !== 'object') return false;
	const r = raw as Record<string, unknown>;
	return (
		typeof r.phase === 'string' &&
		VALID_PHASES.has(r.phase as BuildPhase) &&
		typeof r.message === 'string' &&
		typeof r.fileChangeCount === 'number' &&
		Array.isArray(r.logs)
	);
}

function sanitizeBuildStatus(raw: BuildStatus): BuildStatus {
	return {
		phase: VALID_PHASES.has(raw.phase) ? raw.phase : 'idle',
		message: typeof raw.message === 'string' ? raw.message : '',
		fileChangeCount: typeof raw.fileChangeCount === 'number' ? raw.fileChangeCount : 0,
		logs: Array.isArray(raw.logs) ? raw.logs.slice(-SOLO_MAX_LOGS) : [],
		startedAt: raw.startedAt,
		updatedAt: raw.updatedAt,
	};
}

// ── 状态管理 ────────────────────────────────────────────────────────

let currentStatus: BuildStatus = { phase: 'idle', message: '等待构建', fileChangeCount: 0, logs: [] };
let watcher: vscode.FileSystemWatcher | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let maxTimer: ReturnType<typeof setTimeout> | undefined;
/** 追踪 ID：每次 beginBuildTracking 递增，定时器回调检查是否仍匹配 */
let trackingId: number = 0;
const listeners = new Set<(s: BuildStatus) => void>();

function getStatusPath(): string | undefined {
	const dir = getSoloPlanDir();
	return dir ? path.join(dir, BUILD_STATUS_FILENAME) : undefined;
}

function persistStatus(): void {
	const p = getStatusPath();
	if (!p) {
		return;
	}
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(currentStatus, null, 2), 'utf-8');
	} catch {
		// 非关键路径，写入失败不影响构建追踪
	}
}

function pushLog(line: string): void {
	const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
	const entry = `[${ts}] ${line}`;
	currentStatus.logs = [...currentStatus.logs, entry].slice(-SOLO_MAX_LOGS);
	currentStatus.updatedAt = new Date().toISOString();
}

function emit(): void {
	persistStatus();
	for (const fn of listeners) {
		fn({ ...currentStatus, logs: [...currentStatus.logs] });
	}
}

function setPhase(phase: BuildPhase, message: string): void {
	if (currentStatus.phase === phase && currentStatus.message === message) {
		return;
	}
	currentStatus.phase = phase;
	currentStatus.message = message;
	pushLog(`${PHASE_LABEL[phase] || phase} — ${message}`);
	emit();
}

// ── 空闲/超时定时器 ────────────────────────────────────────────────

function resetIdleTimer(tid: number): void {
	if (idleTimer) {
		clearTimeout(idleTimer);
	}
	idleTimer = setTimeout(() => {
		// 竞态防护：仅当 trackingId 未变时才生效
		if (trackingId !== tid) return;
		if (currentStatus.phase === 'files' || currentStatus.phase === 'agent') {
			setPhase('done', `Agent 可能已完成（${currentStatus.fileChangeCount} 个文件变更），请运行 dev server`);
		}
	}, SOLO_BUILD_IDLE_MS);
}

// ── 文件事件处理 ───────────────────────────────────────────────────

function shouldTrack(uri: vscode.Uri): boolean {
	const rel = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
	if (!rel || rel.startsWith('..')) {
		return false;
	}
	// 使用 startsWith 精确匹配前缀，避免子字符串误判
	return !BUILD_TRACK_SKIP_DIRS.some(s => rel.startsWith(s));
}

function inferPhaseFromPath(rel: string): void {
	const lower = rel.toLowerCase();
	if (DEP_LOCKFILE_RE.test(lower)) {
		setPhase('install', '检测到依赖清单变更');
	} else if (PROJECT_ENTRY_RE.test(lower) && currentStatus.phase === 'agent') {
		setPhase('files', '正在生成项目文件…');
	}
}

function handleFileEvent(uri: vscode.Uri, kind: 'create' | 'change' | 'delete', tid: number): void {
	if (!shouldTrack(uri)) {
		return;
	}
	const rel = vscode.workspace.asRelativePath(uri);
	currentStatus.fileChangeCount += 1;
	if (currentStatus.phase === 'agent' || currentStatus.phase === 'idle') {
		setPhase('files', 'Agent 正在写入工作区…');
	} else {
		pushLog(`${kind === 'create' ? '新建' : kind === 'delete' ? '删除' : '更新'}: ${rel}`);
		emit();
	}
	inferPhaseFromPath(rel);
	resetIdleTimer(tid);
}

// ── 公开 API ───────────────────────────────────────────────────────

export function getBuildStatus(): BuildStatus {
	return { ...currentStatus, logs: [...currentStatus.logs] };
}

export function onBuildStatusChange(fn: (s: BuildStatus) => void): vscode.Disposable {
	listeners.add(fn);
	fn(getBuildStatus());
	return { dispose: () => listeners.delete(fn) };
}

export function stopBuildTracking(): void {
	trackingId = 0;
	watcher?.dispose();
	watcher = undefined;
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	}
	if (maxTimer) {
		clearTimeout(maxTimer);
		maxTimer = undefined;
	}
}

export function markBuildDone(message?: string): void {
	setPhase('done', message || '构建已标记完成');
	stopBuildTracking();
}

export function markBuildDevRunning(): void {
	setPhase('dev', 'Dev Server 运行中');
	emit();
}

export function beginBuildTracking(context: vscode.ExtensionContext): void {
	stopBuildTracking();
	// 每次开始新追踪时递增 trackingId，旧的定时器回调会被忽略
	const tid = ++trackingId;

	currentStatus = {
		phase: 'agent',
		message: 'Agent 模式已启动，等待文件变更…',
		fileChangeCount: 0,
		logs: [],
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	pushLog('开始 SOLO Agent 构建');
	emit();

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		setPhase('error', '未打开工作区');
		return;
	}

	const pattern = new vscode.RelativePattern(folder, '**/*');
	watcher = vscode.workspace.createFileSystemWatcher(pattern);
	watcher.onDidCreate(u => handleFileEvent(u, 'create', tid));
	watcher.onDidChange(u => handleFileEvent(u, 'change', tid));
	watcher.onDidDelete(u => handleFileEvent(u, 'delete', tid));

	// 将 watcher 推入 subscriptions 以确保卸载时清理
	context.subscriptions.push(watcher);

	maxTimer = setTimeout(() => {
		// 竞态防护：仅当 trackingId 未变且未结束
		if (trackingId !== tid) return;
		if (currentStatus.phase !== 'done' && currentStatus.phase !== 'error') {
			setPhase('done', '构建追踪超时结束 — 请手动验证');
			stopBuildTracking();
		}
	}, SOLO_BUILD_MAX_MS);

	resetIdleTimer(tid);
}

export function loadPersistedBuildStatus(): void {
	const p = getStatusPath();
	if (!p || !fs.existsSync(p)) {
		return;
	}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
		if (isBuildStatus(raw)) {
			currentStatus = sanitizeBuildStatus(raw);
		}
	} catch {
		// 损坏的 JSON 静默忽略，使用默认状态
	}
}

export function registerBuildTracker(context: vscode.ExtensionContext): void {
	loadPersistedBuildStatus();
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.soloMarkBuildDone, () => markBuildDone()),
	);
}
