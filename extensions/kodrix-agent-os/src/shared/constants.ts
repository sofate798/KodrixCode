/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 共享常量定义
 *
 *  大厂工程化标准：所有魔术字符串、配置键、命令 ID、默认值集中管理。
 *  好处：
 *   1. 修改一处即可全局生效
 *   2. IDE 自动补全 + 重构安全
 *   3. 消除拼写错误导致的运行时异常
 *--------------------------------------------------------------------------------------------*/

// ── 目录路径 ──────────────────────────────────────────────────────

/** 工作区级 Kodrix 元数据目录名 */
export const WORKSPACE_KODRIX_DIR = '.kodrix' as const;

/** 用户级 Kodrix 目录名 */
export const USER_KODRIX_DIR = '.kodrix' as const;

/** 默认预览端口（IdeaFlow 等通用） */
export const DEFAULT_PREVIEW_PORT = 5173;

/** 通用 Dev Server 默认端口 */
export const GENERIC_DEV_PORT = 3000;

/** Dev Server 启动命令检测正则（使用单词边界精确匹配，避免 "nodemon" 误判） */
export const DEV_SERVE_CHECK_RE = /\b(dev|serve|start)\b/i;

/** 默认预览 URL 模板 */
export function defaultPreviewUrl(port: number = DEFAULT_PREVIEW_PORT): string {
	return `http://localhost:${port}`;
}

// ── 环境变量 ──────────────────────────────────────────────────────

export const ENV_DEBUG = 'KODRIX_DEBUG' as const;

// ── 配置键 ────────────────────────────────────────────────────────

export const CONFIG_SECTION = 'kodrix' as const;
export const CONFIG_FEATURES = 'kodrix.features' as const;
export const CONFIG_ARENA = 'kodrix.arena' as const;
export const CONFIG_CHAT = 'chat' as const;

// Feature flags (kodrix.features.*)
export const FEATURE_FLAGS = {
	memory: 'memory',
	wiki: 'wiki',
	wikiAutoBuild: 'wikiAutoBuild',
	arena: 'arena',
	learning: 'learning',
	sessionLearning: 'sessionLearning',
	semanticMemory: 'semanticMemory',
	contextInjection: 'contextInjection',
	contextIntelligence: 'contextIntelligence',
	ideaFlow: 'ideaFlow',
	codebaseIntelligence: 'codebaseIntelligence',
	terminalAI: 'terminalAI',
	hooks: 'hooks',
	acp: 'acp',
	propertyTests: 'propertyTests',
} as const;

// Experience config (kodrix.experience.*)
export const EXPERIENCE_CONFIG = {
	autoBootstrap: 'experience.autoBootstrap',
	showBootstrapTip: 'experience.showBootstrapTip',
} as const;

// Arena config (kodrix.arena.*)
export const ARENA_CONFIG = {
	modelA: 'modelA',
	modelB: 'modelB',
} as const;

// ── 命令 ID ──────────────────────────────────────────────────────

export const COMMANDS = {
	// Agent OS
	codebaseBuildIndex: 'kodrix.codebase.buildIndex',
	codebaseStats: 'kodrix.codebase.stats',
	agentOsWelcome: 'kodrix.agentOs.welcome',
	contextStatus: 'kodrix.context.status',
	contextRefresh: 'kodrix.context.refresh',
	contextToggleSummary: 'kodrix.context.toggleSummary',
	hubOpen: 'kodrix.hub.open',
	routerRoute: 'kodrix.router.route',
	learnCapture: 'kodrix.learn.capture',
	wikiGenerate: 'kodrix.wiki.generate',
	crewStatus: 'kodrix.crew.status',

	// Idea Flow
	ideaOpen: 'kodrix.idea.open',
	ideaStart: 'kodrix.idea.start',
	ideaStatus: 'kodrix.idea.status',
	ideaRestart: 'kodrix.idea.restart',

	// Arena
	arenaCompare: 'kodrix.arena.compare',

	// Chat
	chatOpen: 'workbench.action.chat.open',
	terminalFocus: 'workbench.action.terminal.focus',
	simpleBrowserShow: 'simpleBrowser.show',
	explorerFocus: 'workbench.view.explorer',

	skillsRefresh: 'kodrix.skills.refresh',
	skillsFocusMarketplace: 'kodrix.skillsMarketplace.focus',
	skillsInstall: 'kodrix.skills.install',
	skillsInstallFromUrl: 'kodrix.skills.installFromUrl',
	skillsImportCursor: 'kodrix.skills.importCursor',
	skillsSearchGithub: 'kodrix.skills.searchGithub',

	// Rules (.mdc 多文件体系)
	rulesCreate: 'kodrix.rules.create',
	rulesSync: 'kodrix.rules.sync',

	// Terminal AI（对标 Cursor：Cmd+K 生成命令 · Cmd+Enter 运行）
	terminalAiPrompt: 'kodrix.terminal.aiPrompt',
	terminalAiRun: 'kodrix.terminal.aiRun',

	// Checkpoint 回滚（对标 Cursor Checkpoint）
	checkpointCreate: 'kodrix.checkpoint.create',
	checkpointList: 'kodrix.checkpoint.list',
	checkpointRestore: 'kodrix.checkpoint.restore',
	checkpointRefreshTimeline: 'kodrix.checkpoint.refreshTimeline',
	checkpointDiffGallery: 'kodrix.checkpoint.diffGallery',

	// Rules 查看
	rulesList: 'kodrix.rules.list',

	// Model Router（对标 Cursor 多模型路由）
	modelRouterStatus: 'kodrix.modelRouter.status',

	// 用户偏好画像（对标 Cursor 全局偏好记忆）
	userProfileView: 'kodrix.userProfile.view',
	userProfileReset: 'kodrix.userProfile.reset',

	// 后台 Agent（对标 Cursor Background Agent）
	backgroundDispatch: 'kodrix.background.dispatch',
	backgroundList: 'kodrix.background.list',
	backgroundPanel: 'kodrix.background.panel',

	// 可视化 Agent 编排 DAG（对标 Cursor Agent 执行可视化）
	crewVisualize: 'kodrix.crew.visualize',

	// Agent 推理循环（端到端 tool-use loop，对标 Cursor Agent）
	agentRun: 'kodrix.agent.run',
	agentList: 'kodrix.agent.list',
	agentResume: 'kodrix.agent.resume',
	// Agent 计划模式（Plan：只读分析输出计划，对标 Cursor Plan 模式）
	agentPlan: 'kodrix.agent.plan',
	// Subagent 并行派生（独立上下文，对标 Cursor Subagent）
	subagentRun: 'kodrix.subagent.run',
	subagentList: 'kodrix.subagent.list',
	// 会话 Threads（树/分支/命名/搜索，对标 Cursor 会话历史）
	threadsTree: 'kodrix.threads.tree',
	threadsRename: 'kodrix.threads.rename',
	threadsSearch: 'kodrix.threads.search',

	// 多文件 Apply + diff 确认（对标 Cursor 多文件 Apply）
	applyPreview: 'kodrix.apply.preview',
	applyCommit: 'kodrix.apply.commit',
} as const;

// ── View / Provider ID ──────────────────────────────────────────

export const VIEW_IDS = {
	kodrixHub: 'kodrix.hub',
	specWorkbench: 'kodrix.specWorkbench',
	ideaCanvas: 'kodrix.ideaCanvas',
	skillsMarketplace: 'kodrix.skillsMarketplace',
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

/** IdeaFlow 预览打开延迟（毫秒） */
export const IDEA_FLOW_PREVIEW_OPEN_DELAY_MS = 3000;

// ── Agent 状态桥常量 ────────────────────────────────────────────

/** Agent "done" 后恢复 idle 的延迟（毫秒） */
export const AGENT_DONE_IDLE_DELAY_MS = 3000;

/** Agent "error" 后恢复 idle 的延迟（毫秒） */
export const AGENT_ERROR_IDLE_DELAY_MS = 5000;

// ── 终端 AI（Terminal AI，对标 Cursor Cmd+K 命令生成） ──────────────

/** 终端 AI 命令生成超时（毫秒） */
export const TERMINAL_AI_GEN_TIMEOUT_MS = 60_000;

/** 终端 AI 命令执行捕获超时（毫秒） */
export const TERMINAL_AI_RUN_TIMEOUT_MS = 120_000;

// ── Agent Crew 并行执行（v2） ───────────────────────────────────

/** Crew 并行执行配置段 */
export const CREW_CONFIG = 'kodrix.crew' as const;

/** Crew 配置键（kodrix.crew.*） */
export const CREW_CONFIG_KEYS = {
	maxParallel: 'maxParallel',
	timeoutMs: 'timeoutMs',
} as const;

/** 默认最大并发任务数（对标 Cursor Subagent 并行派生，默认 3 路避免资源爆炸） */
export const CREW_DEFAULT_MAX_PARALLEL = 3;

/** Crew 并发上限（与 package.json kodrix.crew.maxParallel 的 maximum 保持一致） */
export const CREW_MAX_PARALLEL_LIMIT = 10;

/**
 * 钳制 Crew/Subagent 并发数：非法值（NaN/非数字）回退默认，越界值收敛到 [1, CREW_MAX_PARALLEL_LIMIT]。
 * Crew 并行调度与 Subagent 派生共用，保证设置项 kodrix.crew.maxParallel 在两条链路行为一致。
 */
export function clampCrewParallel(value: unknown, fallback: number = CREW_DEFAULT_MAX_PARALLEL): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return Math.min(CREW_MAX_PARALLEL_LIMIT, Math.max(1, Math.floor(fallback)));
	}
	return Math.min(CREW_MAX_PARALLEL_LIMIT, Math.max(1, Math.floor(value)));
}

/** 单任务默认超时（毫秒），与 IdeaFlow LLM 分析超时保持一致 */
export const CREW_TASK_TIMEOUT_MS = 180_000;

/** 依赖任务输出注入单任务 prompt 的最大字符数（防止上下文爆炸） */
export const CREW_CONTEXT_MAX_CHARS = 4000;

/** 单任务 result 写入 crew.json 的最大字符数（防止文件无限膨胀） */
export const CREW_RESULT_MAX_CHARS = 12000;

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

// ── 正则模式 ─────────────────────────────────────────────────────

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
// ── Checkpoint 回滚（对标 Cursor Checkpoint） ────────────────────────

/** Checkpoint 配置段 */
export const CHECKPOINT_CONFIG = 'kodrix.checkpoint' as const;

/** Checkpoint 配置键（kodrix.checkpoint.*） */
export const CHECKPOINT_CONFIG_KEYS = {
	autoCapture: 'autoCapture',
	maxEntries: 'maxEntries',
} as const;

/** 自动捕获队列默认上限（条） */
export const CHECKPOINT_DEFAULT_MAX_ENTRIES = 100;

/** 单个检查点最多快照文件数（防止清单膨胀） */
export const CHECKPOINT_MAX_FILES_PER_SNAPSHOT = 100;

/** 单个文件超过该字节数不入快照（二进制 / 大文件跳过） */
export const CHECKPOINT_MAX_FILE_BYTES = 1_000_000;

// ── Agent Kanban 显示设置 ─────────────────────────────────────────

/** Kanban 配置段 */
export const KANBAN_CONFIG = 'kodrix.kanban' as const;

/** Kanban 配置键（kodrix.kanban.*） */
export const KANBAN_CONFIG_KEYS = {
	showCompleted: 'showCompleted',
} as const;

// ── setContext 上下文键（package.json views/keybindings when 子句消费） ──

/** 是否已打开工作区（kodrix.checkpoints 视图可见性依赖此键） */
export const HAS_WORKSPACE_CONTEXT_KEY = 'kodrix.hasWorkspace' as const;

// ── 多文件 Apply + diff 确认（对标 Cursor 多文件 Apply） ──------------------------------

/** 变更提案目录名（工作区 .kodrix/apply） */
export const APPLY_DIR = 'apply' as const;

/** 应用前备份目录名（工作区 .kodrix/apply-backups） */
export const APPLY_BACKUP_DIR = 'apply-backups' as const;

// ── Agent 推理循环（端到端 tool-use loop，对标 Cursor Agent） ──------------------------------

/** Agent 循环配置段 */
export const AGENT_LOOP_CONFIG = 'kodrix.agentLoop' as const;

/** Agent 循环配置键（kodrix.agentLoop.*） */
export const AGENT_LOOP_CONFIG_KEYS = {
	maxIterations: 'maxIterations',
	timeoutMs: 'timeoutMs',
	allowCommands: 'allowCommands',
	allowDangerousCommands: 'allowDangerousCommands',
	checkpoint: 'checkpoint',
} as const;

/** 默认最大迭代轮数 */
export const AGENT_LOOP_DEFAULT_MAX_ITERATIONS = 20;

/** 默认总超时（ms） */
export const AGENT_LOOP_DEFAULT_TIMEOUT_MS = 600000;

/** 迭代轮数硬上限：设置项没有 maximum 时，工作区里的 .vscode/settings.json 可以写成天文数字 */
export const AGENT_LOOP_MAX_ITERATIONS_LIMIT = 100;

/** 总超时硬上限（1 小时）：同上，防止"跑飞" */
export const AGENT_LOOP_TIMEOUT_MS_LIMIT = 3_600_000;

/** 危险命令默认拦截（可在设置中显式放开） */
export const AGENT_LOOP_DEFAULT_ALLOW_DANGEROUS_COMMANDS = false;

/** 自动索引的文件数上限（默认值；可被 kodrix.codebase.maxAutoIndexFiles 覆盖，与设置说明一致） */
export const MAX_AUTO_INDEX_FILES = 50_000;

/** 自动索引上限的允许区间 */
export const MAX_AUTO_INDEX_FILES_MIN = 100;
export const MAX_AUTO_INDEX_FILES_MAX = 1_000_000;

/** 钳制自动索引文件数上限（非法值回退默认） */
export function clampMaxAutoIndexFiles(value: unknown, fallback: number = MAX_AUTO_INDEX_FILES): number {
	const base = (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
	return Math.min(MAX_AUTO_INDEX_FILES_MAX, Math.max(MAX_AUTO_INDEX_FILES_MIN, Math.floor(base)));
}

/**
 * 超限时抛出的错误前缀：启动路径据此给出"跳过自动索引 + 提供手动入口"的可操作提示，
 * 而不是把它当成普通失败（UI 文案承诺了 50k 上限，代码必须真的拦住）。
 */
export const INDEX_TOO_MANY_FILES_PREFIX = 'INDEX_TOO_MANY_FILES';

/** 钳制 Agent 迭代轮数到 [1, AGENT_LOOP_MAX_ITERATIONS_LIMIT]（非法值回退默认） */
export function clampAgentIterations(value: unknown, fallback: number = AGENT_LOOP_DEFAULT_MAX_ITERATIONS): number {
	const base = (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
	return Math.min(AGENT_LOOP_MAX_ITERATIONS_LIMIT, Math.max(1, Math.floor(base)));
}

/** 钳制 Agent 总超时到 [5s, AGENT_LOOP_TIMEOUT_MS_LIMIT]（非法值回退默认） */
export function clampAgentTimeoutMs(value: unknown, fallback: number = AGENT_LOOP_DEFAULT_TIMEOUT_MS): number {
	const base = (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
	return Math.min(AGENT_LOOP_TIMEOUT_MS_LIMIT, Math.max(5_000, Math.floor(base)));
}

/** 默认运行前自动创建检查点（可回滚 Agent 改动） */
export const AGENT_LOOP_DEFAULT_CHECKPOINT = true;

/** Agent 运行记录目录名（工作区 .kodrix/agent-runs） */
export const AGENT_RUNS_DIR = 'agent-runs' as const;

/** Subagent 并行执行报告目录（.kodrix/subagents/） */
export const SUBAGENTS_DIR = 'subagents' as const;

/** 工具结果回填模型的最大字符数 */
export const TOOL_RESULT_MAX_CHARS = 3000;
// ── 全局用户偏好画像（对标 Cursor 全局偏好记忆） ──------------------------------

/** 用户画像文件名（~/.kodrix/user-profile.json，跨项目共享） */
export const USER_PROFILE_FILE = 'user-profile.json' as const;

/** 用户画像默认值 */
export const USER_PROFILE_DEFAULT: {
	language: string;
	tone: string;
	techStack: string[];
	codingStyle: string;
	keyConstraints: string[];
} = {
	language: '简体中文',
	tone: '简洁专业',
	techStack: [],
	codingStyle: '',
	keyConstraints: [],
};

// ── Tab 补全（专用快速模型通道，对标 Cursor Tab） ──------------------------------

/** Tab 补全配置段 */
export const TAB_COMPLETION_CONFIG = 'kodrix.tabCompletion' as const;

/** Tab 补全配置键（kodrix.tabCompletion.*） */
export const TAB_COMPLETION_CONFIG_KEYS = {
	enabled: 'enabled',
	mode: 'mode',
	fimEnabled: 'fimEnabled',
	fimEndpoint: 'fimEndpoint',
	fimApiKey: 'fimApiKey',
	fimModel: 'fimModel',
	stats: 'stats',
} as const;

/** Tab 补全模式：fim = 专用 FIM 通道；fast = 通用模型通道 */
export const TAB_COMPLETION_MODE_FIM = 'fim' as const;
export const TAB_COMPLETION_MODE_FAST = 'fast' as const;
/** FIM 专线开关默认值（false 时完全跳过 FIM 通道，直连 fast） */
export const TAB_COMPLETION_FIM_ENABLED_DEFAULT = true;
/** FIM 默认端点（可被 kodrix.tabCompletion.fimEndpoint 覆盖；上游 beta 接口时效性存疑，4xx 后本会话自动跳过） */
export const FIM_DEFAULT_ENDPOINT = 'https://api.deepseek.com/beta/fim/completions';
export const FIM_DEFAULT_MODEL = 'deepseek-chat';
/** DeepSeek FIM 前后缀分隔标记（FIM 指南：prompt 以 <｜fim▁end｜> 结尾，suffix 参数独立传） */
export const FIM_SEPARATOR = '<｜fim▁end｜>';
/** FIM 请求参数 */
export const FIM_MAX_TOKENS = 128;
export const FIM_TEMPERATURE = 0;

/** Tab 补全生成超时（ms） */
export const TAB_COMPLETION_TIMEOUT_MS = 3000;

/** 补全上下文保留行数 */
export const TAB_COMPLETION_CONTEXT_LINES = 8;

/** 补全结果最大字符数 */
export const TAB_COMPLETION_MAX_RESULT_CHARS = 4000;

/** 连续击键防抖（ms）：期间新击键会取消本次请求，避免每键一次网络调用 */
export const TAB_COMPLETION_DEBOUNCE_MS = 120;

/** 发送给补全端点的光标前 / 后文本上限（行数先截，再按字符截） */
export const TAB_COMPLETION_PREFIX_LINES = 200;
export const TAB_COMPLETION_SUFFIX_LINES = 60;
export const TAB_COMPLETION_MAX_PREFIX_CHARS = 8000;
export const TAB_COMPLETION_MAX_SUFFIX_CHARS = 2000;

// ── 后台 Agent（对标 Cursor Background Agent） ──----------------------------------------

/** 后台任务目录名（工作区 .kodrix/background） */
export const BACKGROUND_TASKS_DIR = 'background' as const;

/** 后台任务执行超时（ms） */
export const BACKGROUND_TASK_TIMEOUT_MS = 180000;

/** 后台任务结果最大字符数 */
export const BACKGROUND_TASK_RESULT_MAX_CHARS = 12000;
// ── 模型 Auto 路由（Model Router，对标 Cursor 多模型路由） ──--------------------------------------

/** 模型路由配置段 */
export const MODEL_ROUTER_CONFIG = 'kodrix.modelRouter' as const;

/** 模型路由配置键（kodrix.modelRouter.*） */
export const MODEL_ROUTER_CONFIG_KEYS = {
	enabled: 'enabled',
} as const;

/** 各档位模型族（smart 深度分析 / balanced 均衡 / fast 快速） */
export const MODEL_ROUTER_TIERS = {
	smart: ['gpt-4o', 'claude-3.5-sonnet', 'claude-3.7-sonnet', 'copilot-gpt-4'],
	balanced: ['gpt-4o-mini', 'claude-3.5-haiku', 'copilot-gpt-4-mini'],
	fast: ['gpt-4o-mini', 'copilot-gpt-4-mini'],
} as const;

/** 模型路由使用日志最大条目数 */
export const MODEL_ROUTER_USAGE_LOG_MAX = 500;
// ── Idea Flow 自动执行（端到端，对标 Cursor Agent） ────────────────

/** Idea Flow 配置段 */
export const IDEA_FLOW_CONFIG = 'kodrix.idea' as const;

/** Idea Flow 配置键（kodrix.idea.*） */
export const IDEA_FLOW_CONFIG_KEYS = {
	autoExecute: 'autoExecute',
} as const;
