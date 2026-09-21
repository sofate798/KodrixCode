/*---------------------------------------------------------------------------------------------
 *  Minicode Agent OS — 共享常量定义
 *
 *  大厂工程化标准：所有魔术字符串、配置键、命令 ID、默认值集中管理。
 *  好处：
 *   1. 修改一处即可全局生效
 *   2. IDE 自动补全 + 重构安全
 *   3. 消除拼写错误导致的运行时异常
 *--------------------------------------------------------------------------------------------*/

// ── 目录路径 ──────────────────────────────────────────────────────

/** 工作区级 Minicode 元数据目录名 */
export const WORKSPACE_MINICODE_DIR = '.minicode' as const;

/** 用户级 Minicode 目录名 */
export const USER_MINICODE_DIR = '.minicode' as const;

/** 默认预览端口（SOLO / IdeaFlow 通用） */
export const DEFAULT_PREVIEW_PORT = 5173;

/** Vite 默认端口（与 DEFAULT_PREVIEW_PORT 统一值，但语义独立，便于未来独立调整） */
export const VITE_DEFAULT_PORT = DEFAULT_PREVIEW_PORT;

/** 通用 Dev Server 默认端口 */
export const GENERIC_DEV_PORT = 3000;

/** Dev Server 启动命令检测正则（使用单词边界精确匹配，避免 "nodemon" 误判） */
export const DEV_SERVE_CHECK_RE = /\b(dev|serve|start)\b/i;

/** 默认预览 URL 模板 */
export function defaultPreviewUrl(port: number = DEFAULT_PREVIEW_PORT): string {
	return `http://localhost:${port}`;
}

// ── 环境变量 ──────────────────────────────────────────────────────

export const ENV_DEBUG = 'MINICODE_DEBUG' as const;

// ── 配置键 ────────────────────────────────────────────────────────

export const CONFIG_SECTION = 'minicode' as const;
export const CONFIG_FEATURES = 'minicode.features' as const;
export const CONFIG_SOLO = 'minicode.solo' as const;
export const CONFIG_ARENA = 'minicode.arena' as const;
export const CONFIG_CHAT = 'chat' as const;

// Feature flags (minicode.features.*)
export const FEATURE_FLAGS = {
	memory: 'memory',
	wiki: 'wiki',
	wikiAutoBuild: 'wikiAutoBuild',
	arena: 'arena',
	learning: 'learning',
	sessionLearning: 'sessionLearning',
	semanticMemory: 'semanticMemory',
	contextInjection: 'contextInjection',
	ideaFlow: 'ideaFlow',
	codebaseIntelligence: 'codebaseIntelligence',
} as const;

// Experience config (minicode.experience.*)
export const EXPERIENCE_CONFIG = {
	autoBootstrap: 'experience.autoBootstrap',
	showBootstrapTip: 'experience.showBootstrapTip',
} as const;

// SOLO config (minicode.solo.*)
export const SOLO_CONFIG = {
	autoApply: 'autoApply',
	workbenchOpenChat: 'workbenchOpenChat',
} as const;

// Arena config (minicode.arena.*)
export const ARENA_CONFIG = {
	modelA: 'modelA',
	modelB: 'modelB',
} as const;

// ── 命令 ID ──────────────────────────────────────────────────────

export const COMMANDS = {
	// Agent OS
	codebaseBuildIndex: 'minicode.codebase.buildIndex',
	codebaseStats: 'minicode.codebase.stats',
	agentOsWelcome: 'minicode.agentOs.welcome',
	contextStatus: 'minicode.context.status',
	contextRefresh: 'minicode.context.refresh',
	hubOpen: 'minicode.hub.open',
	routerRoute: 'minicode.router.route',
	learnCapture: 'minicode.learn.capture',
	wikiGenerate: 'minicode.wiki.generate',
	crewStatus: 'minicode.crew.status',

	// Idea Flow
	ideaOpen: 'minicode.idea.open',
	ideaStart: 'minicode.idea.start',
	ideaStatus: 'minicode.idea.status',
	ideaRestart: 'minicode.idea.restart',

	// SOLO
	soloStart: 'minicode.solo.start',
	soloOpenWorkbench: 'minicode.solo.openWorkbench',
	soloPreview: 'minicode.solo.preview',
	soloMarkBuildDone: 'minicode.solo.markBuildDone',

	// Arena
	arenaCompare: 'minicode.arena.compare',

	// Chat
	chatOpen: 'workbench.action.chat.open',
	terminalFocus: 'workbench.action.terminal.focus',
	simpleBrowserShow: 'simpleBrowser.show',
	explorerFocus: 'workbench.view.explorer',

	// Local Extension
	openProviderWorkbench: 'minicode.openProviderWorkbench',
	openAgentsWindow: 'minicode.openAgentsWindow',
	openProviderPresets: 'minicode.openProviderPresets',
	applyPreset: 'minicode.applyPreset',
	welcome: 'minicode.welcome',
	importCursor: 'minicode.importCursor',
	migrateConfig: 'minicode.migrateConfig',

	// Skills Extension
	skillsOpenMarketplace: 'minicode.skills.openMarketplace',
	skillsRefresh: 'minicode.skills.refresh',
	skillsFocusMarketplace: 'minicode.skillsMarketplace.focus',
	skillsInstall: 'minicode.skills.install',
	skillsInstallFromUrl: 'minicode.skills.installFromUrl',
	skillsImportCursor: 'minicode.skills.importCursor',
	skillsSearchGithub: 'minicode.skills.searchGithub',
} as const;

// ── View / Provider ID ──────────────────────────────────────────

export const VIEW_IDS = {
	minicodeHub: 'minicode.hub',
	soloWorkbench: 'minicode.soloWorkbench',
	specWorkbench: 'minicode.specWorkbench',
	ideaCanvas: 'minicode.ideaCanvas',
	skillsMarketplace: 'minicode.skillsMarketplace',
} as const;

// ── 上下文断点 ──────────────────────────────────────────────────

/** 组装上下文的最大字符数 */
export const ASSEMBLED_CONTEXT_MAX_CHARS = 6000;

/** 组装上下文预览截断字符数 */
export const ASSEMBLED_CONTEXT_PREVIEW_CHARS = 3000;

/** 紧凑上下文最大字符数 */
export const COMPACT_CONTEXT_MAX_CHARS = 300;

/** Wiki 缓存 TTL（毫秒） */
export const WIKI_CACHE_TTL_MS = 5000;

/** 索引缓存 TTL（毫秒） */
export const INDEX_CACHE_TTL_MS = 5000;

/** 工作区预热启动延迟（毫秒） */
export const BOOTSTRAP_DELAY_MS = 2500;

/** Wiki 自动生成延迟（毫秒） */
export const WIKI_AUTO_BUILD_DELAY_MS = 4000;

/** Bootstrap 提示延迟（毫秒） */
export const BOOTSTRAP_TIP_DELAY_MS = 6000;

/** 指令文件夹注册延迟（毫秒） */
export const INSTRUCTION_REGISTER_DELAY_MS = 2000;

/** 初始索引构建延迟（毫秒） */
export const INITIAL_INDEX_DELAY_MS = 5000;

// ── IdeaFlow 常量 ───────────────────────────────────────────────

/** IdeaFlow LLM 分析超时（毫秒） */
export const IDEA_FLOW_LLM_TIMEOUT_MS = 180_000;

/** IdeaFlow 构建轮询间隔（毫秒） */
export const IDEA_FLOW_POLL_INTERVAL_MS = 5000;

/** IdeaFlow 最大构建时间（毫秒） */
export const IDEA_FLOW_MAX_BUILD_MS = 30 * 60_000;

/** IdeaFlow 最大日志条数 */
export const IDEA_FLOW_MAX_LOGS = 200;

/** IdeaFlow Canvas 启动延迟（毫秒） */
export const IDEA_FLOW_CANVAS_LAUNCH_DELAY_MS = 500;

/** IdeaFlow LLM 模型查找顺序 */
export const IDEA_FLOW_MODEL_FAMILIES = [
	'gpt-4o',
	'gpt-4',
	'claude-3.5-sonnet',
	'copilot-gpt-4',
] as const;

/** IdeaFlow 快速特征提取缓存大小 */
export const IDEA_FLOW_FEATURES_MAX = 8;

// ── Agent 状态桥常量 ────────────────────────────────────────────

/** Agent "done" 后恢复 idle 的延迟（毫秒） */
export const AGENT_DONE_IDLE_DELAY_MS = 3000;

/** Agent "error" 后恢复 idle 的延迟（毫秒） */
export const AGENT_ERROR_IDLE_DELAY_MS = 5000;

// ── SOLO 构建常量 ──────────────────────────────────────────────

/** SOLO 构建预览延迟（毫秒） */
export const SOLO_PREVIEW_DELAY_MS = 3000;

/** SOLO 构建空闲判定（毫秒） */
export const SOLO_BUILD_IDLE_MS = 45_000;

/** SOLO 最大构建时间（毫秒） */
export const SOLO_BUILD_MAX_MS = 20 * 60_000;

/** SOLO 最大日志条数 */
export const SOLO_MAX_LOGS = 80;

/** SOLO 规划截断字符数 */
export const SOLO_PLAN_TRUNCATE_CHARS = 3500;

/** SOLO 纯确认构建阈值（字符数） */
export const SOLO_BUILD_CONFIRM_THRESHOLD = 80;

// ── 存储限制 ────────────────────────────────────────────────────

/** Bootstrap 最大已预热工作区数（防止无限增长） */
export const MAX_BOOTSTRAPPED_WORKSPACES = 50;

/** Memory Instructions 最大条目数 */
export const MAX_LEARNING_IN_INSTRUCTIONS = 12;

/** 学习日志最大字节数 */
export const MAX_LEARNING_LOG_BYTES = 512_000;

/** 日志最大最近错误数 */
export const MAX_RECENT_ERRORS = 50;

// ── Instructions 文件后缀 ──────────────────────────────────────────

export const INSTRUCTIONS_FILE_EXT = '.instructions.md' as const;

// ── 文件监控跳过目录 ──────────────────────────────────────────────

export const FILE_WATCH_SKIP_DIRS = [
	'node_modules/',
	'.git/',
	'out/',
	'dist/',
	'build/',
	'target/',
] as const;

/** SOLO 构建追踪跳过的路径前缀（继承通用跳过目录 + SOLO 内部文件） */
export const BUILD_TRACK_SKIP_DIRS = [
	...FILE_WATCH_SKIP_DIRS,
	'.minicode/solo/',
] as const;

// ── 正则模式 ─────────────────────────────────────────────────────

/** 确认构建的正则（共享给 soloParticipant 和 soloPlan） */
export const BUILD_CONFIRM_RE = /确认构建|执行构建|开始构建/i;

/** 依赖锁文件正则 */
export const DEP_LOCKFILE_RE = /package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt/;

/** 项目入口文件正则 */
export const PROJECT_ENTRY_RE = /vite\.config|index\.html|main\.tsx?|app\.py/;

// ── Skills 共享常量 ─────────────────────────────────────────────

/** Agent Skills 位置配置键 */
export const AGENT_SKILLS_LOCATIONS_KEY = 'agentSkillsLocations' as const;

/** Agent Skills 默认安装目录 */
export const SKILLS_DIR = '~/.agents/skills' as const;

/** Cursor Skills 默认目录 */
export const CURSOR_SKILLS_DIR = '~/.cursor/skills' as const;

// ── 欢迎/载入延迟通用常量 ────────────────────────────────────────

/** 首次欢迎页延迟（毫秒） */
export const WELCOME_DELAY_MS = 1500;
