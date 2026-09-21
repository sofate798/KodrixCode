/*---------------------------------------------------------------------------------------------
 *  Minicode SOLO — 集中常量定义
 *
 *  大厂工程化标准：所有魔术字符串、配置键、命令 ID、正则、默认值在此文件集中管理。
 *  原则：
 *    1. 修改一处即可全局生效
 *    2. 消除文件间重复定义
 *    3. IDE 重构安全（重命名自动传播）
 *--------------------------------------------------------------------------------------------*/

// ── 目录路径 ──────────────────────────────────────────────────────

/** SOLO 子目录名（相对于 .minicode） */
export const SOLO_SUBDIR = 'solo' as const;

/** 最后一次规划文件名 */
export const LAST_PLAN_FILENAME = 'last-plan.md' as const;

/** SOLO 上下文 Instructions 文件名 */
export const SOLO_INSTRUCTIONS_FILENAME = 'solo-context.instructions.md' as const;

/** 构建状态持久化文件名 */
export const BUILD_STATUS_FILENAME = 'build-status.json' as const;

// ── 端口 & URL ────────────────────────────────────────────────────

/** 默认预览端口 */
export const DEFAULT_PREVIEW_PORT = 5173;

/** 构建默认预览 URL */
export function defaultPreviewUrl(port: number = DEFAULT_PREVIEW_PORT): string {
	return `http://localhost:${port}`;
}

// ── 配置键 ────────────────────────────────────────────────────────

export const CONFIG_SOLO = 'minicode.solo' as const;

export const SOLO_CONFIG = {
	autoApply: 'autoApply',
	workbenchOpenChat: 'workbenchOpenChat',
} as const;

// ── 命令 ID ──────────────────────────────────────────────────────

export const COMMANDS = {
	soloStart: 'minicode.solo.start',
	soloOpenWorkbench: 'minicode.solo.openWorkbench',
	soloPreview: 'minicode.solo.preview',
	soloMarkBuildDone: 'minicode.solo.markBuildDone',
	chatOpen: 'workbench.action.chat.open',
	terminalFocus: 'workbench.action.terminal.focus',
	simpleBrowserShow: 'simpleBrowser.show',
} as const;

// ── View ID ──────────────────────────────────────────────────────

export const VIEW_IDS = {
	soloWorkbench: 'minicode.soloWorkbench',
} as const;

// ── 计时器 ────────────────────────────────────────────────────────

/** SOLO 构建预览延迟（毫秒） */
export const SOLO_PREVIEW_DELAY_MS = 3000;

/** SOLO 构建空闲判定窗口（毫秒） */
export const SOLO_BUILD_IDLE_MS = 45_000;

/** SOLO 最大构建时间（毫秒），超时自动结束 */
export const SOLO_BUILD_MAX_MS = 20 * 60_000;

// ── 限制 ─────────────────────────────────────────────────────────

/** SOLO 规划截断字符数 */
export const SOLO_PLAN_TRUNCATE_CHARS = 3500;

/** SOLO 纯确认构建阈值（字符数，短于此视为纯确认） */
export const SOLO_BUILD_CONFIRM_THRESHOLD = 80;

/** SOLO 最大日志条数 */
export const SOLO_MAX_LOGS = 80;

// ── 正则 ─────────────────────────────────────────────────────────

/** 确认构建的正则（中英双语） */
export const BUILD_CONFIRM_RE = /确认构建|执行构建|开始构建/i;

/** 依赖锁文件正则（安装阶段判定） */
export const DEP_LOCKFILE_RE = /package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt/;

/** 项目入口文件正则（文件生成阶段判定） */
export const PROJECT_ENTRY_RE = /vite\.config|index\.html|main\.tsx?|app\.py/;

/**
 * Dev Server 启动命令正则 — 使用 \b 单词边界精确匹配，
 * 避免 "nodemon server.js" 等场景误判。
 */
export const DEV_SERVE_CHECK_RE = /\b(dev|serve|start)\b/i;

// ── 文件监控跳过目录 ──────────────────────────────────────────────

/** 构建追踪跳过的路径前缀 */
export const BUILD_TRACK_SKIP_DIRS = [
	'node_modules/',
	'.git/',
	'out/',
	'dist/',
	'build/',
	'target/',
	'.minicode/solo/',
] as const;

// ── Chat Participant ID ──────────────────────────────────────────

export const CHAT_PARTICIPANT_ID = 'minicode.solo' as const;

// ── Frontmatter 模板 ──────────────────────────────────────────────

export const SOLO_INSTRUCTIONS_FRONTMATTER = `---
applyTo: '**'
description: SOLO 最新规划（Trae 风格，@solo 自动更新）
---

`;

// ── 构建阶段标签 ─────────────────────────────────────────────────

export const PHASE_LABEL: Record<string, string> = {
	idle: '待命',
	agent: 'Agent 构建中',
	files: '写入文件',
	install: '依赖安装',
	dev: '启动 Dev Server',
	done: '构建完成',
	error: '异常',
};
