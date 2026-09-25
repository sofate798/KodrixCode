"use strict";
/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 共享常量定义
 *
 *  大厂工程化标准：所有魔术字符串、配置键、命令 ID、默认值集中管理。
 *  好处：
 *   1. 修改一处即可全局生效
 *   2. IDE 自动补全 + 重构安全
 *   3. 消除拼写错误导致的运行时异常
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEP_LOCKFILE_RE = exports.FILE_WATCH_SKIP_DIRS = exports.INSTRUCTIONS_FILE_EXT = exports.MAX_RECENT_ERRORS = exports.MAX_LEARNING_LOG_BYTES = exports.MAX_LEARNING_IN_INSTRUCTIONS = exports.MAX_BOOTSTRAPPED_WORKSPACES = exports.CREW_RESULT_MAX_CHARS = exports.CREW_CONTEXT_MAX_CHARS = exports.CREW_TASK_TIMEOUT_MS = exports.CREW_DEFAULT_MAX_PARALLEL = exports.CREW_CONFIG_KEYS = exports.CREW_CONFIG = exports.TERMINAL_AI_RUN_TIMEOUT_MS = exports.TERMINAL_AI_GEN_TIMEOUT_MS = exports.AGENT_ERROR_IDLE_DELAY_MS = exports.AGENT_DONE_IDLE_DELAY_MS = exports.IDEA_FLOW_PREVIEW_OPEN_DELAY_MS = exports.IDEA_FLOW_FEATURES_MAX = exports.IDEA_FLOW_MODEL_FAMILIES = exports.IDEA_FLOW_CANVAS_LAUNCH_DELAY_MS = exports.IDEA_FLOW_MAX_LOGS = exports.IDEA_FLOW_MAX_BUILD_MS = exports.IDEA_FLOW_POLL_INTERVAL_MS = exports.IDEA_FLOW_LLM_TIMEOUT_MS = exports.INITIAL_INDEX_DELAY_MS = exports.INSTRUCTION_REGISTER_DELAY_MS = exports.BOOTSTRAP_TIP_DELAY_MS = exports.WIKI_AUTO_BUILD_DELAY_MS = exports.BOOTSTRAP_DELAY_MS = exports.INDEX_CACHE_TTL_MS = exports.WIKI_CACHE_TTL_MS = exports.COMPACT_CONTEXT_MAX_CHARS = exports.ASSEMBLED_CONTEXT_PREVIEW_CHARS = exports.ASSEMBLED_CONTEXT_MAX_CHARS = exports.VIEW_IDS = exports.COMMANDS = exports.ARENA_CONFIG = exports.EXPERIENCE_CONFIG = exports.FEATURE_FLAGS = exports.CONFIG_CHAT = exports.CONFIG_ARENA = exports.CONFIG_FEATURES = exports.CONFIG_SECTION = exports.ENV_DEBUG = exports.DEV_SERVE_CHECK_RE = exports.GENERIC_DEV_PORT = exports.DEFAULT_PREVIEW_PORT = exports.USER_KODRIX_DIR = exports.WORKSPACE_KODRIX_DIR = void 0;
exports.IDEA_FLOW_CONFIG_KEYS = exports.IDEA_FLOW_CONFIG = exports.MODEL_ROUTER_USAGE_LOG_MAX = exports.MODEL_ROUTER_TIERS = exports.MODEL_ROUTER_CONFIG_KEYS = exports.MODEL_ROUTER_CONFIG = exports.BACKGROUND_TASK_RESULT_MAX_CHARS = exports.BACKGROUND_TASK_TIMEOUT_MS = exports.BACKGROUND_TASKS_DIR = exports.TAB_COMPLETION_MAX_RESULT_CHARS = exports.TAB_COMPLETION_CONTEXT_LINES = exports.TAB_COMPLETION_TIMEOUT_MS = exports.FIM_TEMPERATURE = exports.FIM_MAX_TOKENS = exports.FIM_SEPARATOR = exports.FIM_DEFAULT_MODEL = exports.FIM_DEFAULT_ENDPOINT = exports.FIM_PROVIDER_CUSTOM = exports.FIM_PROVIDER_DEEPSEEK = exports.TAB_COMPLETION_MODE_FAST = exports.TAB_COMPLETION_MODE_FIM = exports.TAB_COMPLETION_CONFIG_KEYS = exports.TAB_COMPLETION_CONFIG = exports.USER_PROFILE_DEFAULT = exports.USER_PROFILE_FILE = exports.TOOL_RESULT_MAX_CHARS = exports.SUBAGENTS_DIR = exports.AGENT_RUNS_DIR = exports.AGENT_LOOP_DEFAULT_CHECKPOINT = exports.AGENT_LOOP_DEFAULT_TIMEOUT_MS = exports.AGENT_LOOP_DEFAULT_MAX_ITERATIONS = exports.AGENT_LOOP_CONFIG_KEYS = exports.AGENT_LOOP_CONFIG = exports.APPLY_BACKUP_DIR = exports.APPLY_DIR = exports.CHECKPOINT_MAX_FILE_BYTES = exports.CHECKPOINT_MAX_FILES_PER_SNAPSHOT = exports.CHECKPOINT_DEFAULT_MAX_ENTRIES = exports.CHECKPOINT_CONFIG_KEYS = exports.CHECKPOINT_CONFIG = exports.WELCOME_DELAY_MS = exports.CURSOR_SKILLS_DIR = exports.SKILLS_DIR = exports.AGENT_SKILLS_LOCATIONS_KEY = exports.PROJECT_ENTRY_RE = void 0;
exports.defaultPreviewUrl = defaultPreviewUrl;
// ── 目录路径 ──────────────────────────────────────────────────────
/** 工作区级 Kodrix 元数据目录名 */
exports.WORKSPACE_KODRIX_DIR = '.kodrix';
/** 用户级 Kodrix 目录名 */
exports.USER_KODRIX_DIR = '.kodrix';
/** 默认预览端口（IdeaFlow 等通用） */
exports.DEFAULT_PREVIEW_PORT = 5173;
/** 通用 Dev Server 默认端口 */
exports.GENERIC_DEV_PORT = 3000;
/** Dev Server 启动命令检测正则（使用单词边界精确匹配，避免 "nodemon" 误判） */
exports.DEV_SERVE_CHECK_RE = /\b(dev|serve|start)\b/i;
/** 默认预览 URL 模板 */
function defaultPreviewUrl(port = exports.DEFAULT_PREVIEW_PORT) {
    return `http://localhost:${port}`;
}
// ── 环境变量 ──────────────────────────────────────────────────────
exports.ENV_DEBUG = 'KODRIX_DEBUG';
// ── 配置键 ────────────────────────────────────────────────────────
exports.CONFIG_SECTION = 'kodrix';
exports.CONFIG_FEATURES = 'kodrix.features';
exports.CONFIG_ARENA = 'kodrix.arena';
exports.CONFIG_CHAT = 'chat';
// Feature flags (kodrix.features.*)
exports.FEATURE_FLAGS = {
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
    terminalAI: 'terminalAI',
};
// Experience config (kodrix.experience.*)
exports.EXPERIENCE_CONFIG = {
    autoBootstrap: 'experience.autoBootstrap',
    showBootstrapTip: 'experience.showBootstrapTip',
};
// Arena config (kodrix.arena.*)
exports.ARENA_CONFIG = {
    modelA: 'modelA',
    modelB: 'modelB',
};
// ── 命令 ID ──────────────────────────────────────────────────────
exports.COMMANDS = {
    // Agent OS
    codebaseBuildIndex: 'kodrix.codebase.buildIndex',
    codebaseStats: 'kodrix.codebase.stats',
    agentOsWelcome: 'kodrix.agentOs.welcome',
    contextStatus: 'kodrix.context.status',
    contextRefresh: 'kodrix.context.refresh',
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
    // Local Extension
    openProviderWorkbench: 'kodrix.openProviderWorkbench',
    openAgentsWindow: 'kodrix.openAgentsWindow',
    openProviderPresets: 'kodrix.openProviderPresets',
    applyPreset: 'kodrix.applyPreset',
    welcome: 'kodrix.welcome',
    importCursor: 'kodrix.importCursor',
    migrateConfig: 'kodrix.migrateConfig',
    // Skills Extension
    skillsOpenMarketplace: 'kodrix.skills.openMarketplace',
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
};
// ── View / Provider ID ──────────────────────────────────────────
exports.VIEW_IDS = {
    kodrixHub: 'kodrix.hub',
    specWorkbench: 'kodrix.specWorkbench',
    ideaCanvas: 'kodrix.ideaCanvas',
    skillsMarketplace: 'kodrix.skillsMarketplace',
};
// ── 上下文断点 ──────────────────────────────────────────────────
/** 组装上下文的最大字符数 */
exports.ASSEMBLED_CONTEXT_MAX_CHARS = 6000;
/** 组装上下文预览截断字符数 */
exports.ASSEMBLED_CONTEXT_PREVIEW_CHARS = 3000;
/** 紧凑上下文最大字符数 */
exports.COMPACT_CONTEXT_MAX_CHARS = 300;
/** Wiki 缓存 TTL（毫秒） */
exports.WIKI_CACHE_TTL_MS = 5000;
/** 索引缓存 TTL（毫秒） */
exports.INDEX_CACHE_TTL_MS = 5000;
/** 工作区预热启动延迟（毫秒） */
exports.BOOTSTRAP_DELAY_MS = 2500;
/** Wiki 自动生成延迟（毫秒） */
exports.WIKI_AUTO_BUILD_DELAY_MS = 4000;
/** Bootstrap 提示延迟（毫秒） */
exports.BOOTSTRAP_TIP_DELAY_MS = 6000;
/** 指令文件夹注册延迟（毫秒） */
exports.INSTRUCTION_REGISTER_DELAY_MS = 2000;
/** 初始索引构建延迟（毫秒） */
exports.INITIAL_INDEX_DELAY_MS = 5000;
// ── IdeaFlow 常量 ───────────────────────────────────────────────
/** IdeaFlow LLM 分析超时（毫秒） */
exports.IDEA_FLOW_LLM_TIMEOUT_MS = 180_000;
/** IdeaFlow 构建轮询间隔（毫秒） */
exports.IDEA_FLOW_POLL_INTERVAL_MS = 5000;
/** IdeaFlow 最大构建时间（毫秒） */
exports.IDEA_FLOW_MAX_BUILD_MS = 30 * 60_000;
/** IdeaFlow 最大日志条数 */
exports.IDEA_FLOW_MAX_LOGS = 200;
/** IdeaFlow Canvas 启动延迟（毫秒） */
exports.IDEA_FLOW_CANVAS_LAUNCH_DELAY_MS = 500;
/** IdeaFlow LLM 模型查找顺序 */
exports.IDEA_FLOW_MODEL_FAMILIES = [
    'gpt-4o',
    'gpt-4',
    'claude-3.5-sonnet',
    'copilot-gpt-4',
];
/** IdeaFlow 快速特征提取缓存大小 */
exports.IDEA_FLOW_FEATURES_MAX = 8;
/** IdeaFlow 预览打开延迟（毫秒） */
exports.IDEA_FLOW_PREVIEW_OPEN_DELAY_MS = 3000;
// ── Agent 状态桥常量 ────────────────────────────────────────────
/** Agent "done" 后恢复 idle 的延迟（毫秒） */
exports.AGENT_DONE_IDLE_DELAY_MS = 3000;
/** Agent "error" 后恢复 idle 的延迟（毫秒） */
exports.AGENT_ERROR_IDLE_DELAY_MS = 5000;
// ── 终端 AI（Terminal AI，对标 Cursor Cmd+K 命令生成） ──────────────
/** 终端 AI 命令生成超时（毫秒） */
exports.TERMINAL_AI_GEN_TIMEOUT_MS = 60_000;
/** 终端 AI 命令执行捕获超时（毫秒） */
exports.TERMINAL_AI_RUN_TIMEOUT_MS = 120_000;
// ── Agent Crew 并行执行（v2） ───────────────────────────────────
/** Crew 并行执行配置段 */
exports.CREW_CONFIG = 'kodrix.crew';
/** Crew 配置键（kodrix.crew.*） */
exports.CREW_CONFIG_KEYS = {
    maxParallel: 'maxParallel',
    timeoutMs: 'timeoutMs',
};
/** 默认最大并发任务数（对标 Cursor Subagent 并行派生，默认 3 路避免资源爆炸） */
exports.CREW_DEFAULT_MAX_PARALLEL = 3;
/** 单任务默认超时（毫秒），与 IdeaFlow LLM 分析超时保持一致 */
exports.CREW_TASK_TIMEOUT_MS = 180_000;
/** 依赖任务输出注入单任务 prompt 的最大字符数（防止上下文爆炸） */
exports.CREW_CONTEXT_MAX_CHARS = 4000;
/** 单任务 result 写入 crew.json 的最大字符数（防止文件无限膨胀） */
exports.CREW_RESULT_MAX_CHARS = 12000;
// ── 存储限制 ────────────────────────────────────────────────────
/** Bootstrap 最大已预热工作区数（防止无限增长） */
exports.MAX_BOOTSTRAPPED_WORKSPACES = 50;
/** Memory Instructions 最大条目数 */
exports.MAX_LEARNING_IN_INSTRUCTIONS = 12;
/** 学习日志最大字节数 */
exports.MAX_LEARNING_LOG_BYTES = 512_000;
/** 日志最大最近错误数 */
exports.MAX_RECENT_ERRORS = 50;
// ── Instructions 文件后缀 ──────────────────────────────────────────
exports.INSTRUCTIONS_FILE_EXT = '.instructions.md';
// ── 文件监控跳过目录 ──────────────────────────────────────────────
exports.FILE_WATCH_SKIP_DIRS = [
    'node_modules/',
    '.git/',
    'out/',
    'dist/',
    'build/',
    'target/',
];
// ── 正则模式 ─────────────────────────────────────────────────────
/** 依赖锁文件正则 */
exports.DEP_LOCKFILE_RE = /package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt/;
/** 项目入口文件正则 */
exports.PROJECT_ENTRY_RE = /vite\.config|index\.html|main\.tsx?|app\.py/;
// ── Skills 共享常量 ─────────────────────────────────────────────
/** Agent Skills 位置配置键 */
exports.AGENT_SKILLS_LOCATIONS_KEY = 'agentSkillsLocations';
/** Agent Skills 默认安装目录 */
exports.SKILLS_DIR = '~/.agents/skills';
/** Cursor Skills 默认目录 */
exports.CURSOR_SKILLS_DIR = '~/.cursor/skills';
// ── 欢迎/载入延迟通用常量 ────────────────────────────────────────
/** 首次欢迎页延迟（毫秒） */
exports.WELCOME_DELAY_MS = 1500;
// ── Checkpoint 回滚（对标 Cursor Checkpoint） ────────────────────────
/** Checkpoint 配置段 */
exports.CHECKPOINT_CONFIG = 'kodrix.checkpoint';
/** Checkpoint 配置键（kodrix.checkpoint.*） */
exports.CHECKPOINT_CONFIG_KEYS = {
    autoCapture: 'autoCapture',
    maxEntries: 'maxEntries',
};
/** 自动捕获队列默认上限（条） */
exports.CHECKPOINT_DEFAULT_MAX_ENTRIES = 100;
/** 单个检查点最多快照文件数（防止清单膨胀） */
exports.CHECKPOINT_MAX_FILES_PER_SNAPSHOT = 100;
/** 单个文件超过该字节数不入快照（二进制 / 大文件跳过） */
exports.CHECKPOINT_MAX_FILE_BYTES = 1_000_000;
// ── 多文件 Apply + diff 确认（对标 Cursor 多文件 Apply） ──------------------------------
/** 变更提案目录名（工作区 .kodrix/apply） */
exports.APPLY_DIR = 'apply';
/** 应用前备份目录名（工作区 .kodrix/apply-backups） */
exports.APPLY_BACKUP_DIR = 'apply-backups';
// ── Agent 推理循环（端到端 tool-use loop，对标 Cursor Agent） ──------------------------------
/** Agent 循环配置段 */
exports.AGENT_LOOP_CONFIG = 'kodrix.agentLoop';
/** Agent 循环配置键（kodrix.agentLoop.*） */
exports.AGENT_LOOP_CONFIG_KEYS = {
    maxIterations: 'maxIterations',
    timeoutMs: 'timeoutMs',
    allowCommands: 'allowCommands',
    checkpoint: 'checkpoint',
};
/** 默认最大迭代轮数 */
exports.AGENT_LOOP_DEFAULT_MAX_ITERATIONS = 20;
/** 默认总超时（ms） */
exports.AGENT_LOOP_DEFAULT_TIMEOUT_MS = 600000;
/** 默认运行前自动创建检查点（可回滚 Agent 改动） */
exports.AGENT_LOOP_DEFAULT_CHECKPOINT = true;
/** Agent 运行记录目录名（工作区 .kodrix/agent-runs） */
exports.AGENT_RUNS_DIR = 'agent-runs';
/** Subagent 并行执行报告目录（.kodrix/subagents/） */
exports.SUBAGENTS_DIR = 'subagents';
/** 工具结果回填模型的最大字符数 */
exports.TOOL_RESULT_MAX_CHARS = 3000;
// ── 全局用户偏好画像（对标 Cursor 全局偏好记忆） ──------------------------------
/** 用户画像文件名（~/.kodrix/user-profile.json，跨项目共享） */
exports.USER_PROFILE_FILE = 'user-profile.json';
/** 用户画像默认值 */
exports.USER_PROFILE_DEFAULT = {
    language: '简体中文',
    tone: '简洁专业',
    techStack: [],
    codingStyle: '',
    keyConstraints: [],
};
// ── Tab 补全（专用快速模型通道，对标 Cursor Tab） ──------------------------------
/** Tab 补全配置段 */
exports.TAB_COMPLETION_CONFIG = 'kodrix.tabCompletion';
/** Tab 补全配置键（kodrix.tabCompletion.*） */
exports.TAB_COMPLETION_CONFIG_KEYS = {
    enabled: 'enabled',
    mode: 'mode',
    fimProvider: 'fimProvider',
    fimEndpoint: 'fimEndpoint',
    fimApiKey: 'fimApiKey',
    fimModel: 'fimModel',
    stats: 'stats',
};
/** Tab 补全模式：fim = 专用 FIM 通道；fast = 通用模型通道 */
exports.TAB_COMPLETION_MODE_FIM = 'fim';
exports.TAB_COMPLETION_MODE_FAST = 'fast';
/** FIM 提供方：deepseek（默认）或 custom（自定义端点） */
exports.FIM_PROVIDER_DEEPSEEK = 'deepseek';
exports.FIM_PROVIDER_CUSTOM = 'custom';
exports.FIM_DEFAULT_ENDPOINT = 'https://api.deepseek.com/beta/fim/completions';
exports.FIM_DEFAULT_MODEL = 'deepseek-chat';
/** DeepSeek FIM 前后缀分隔标记（FIM 指南：prompt 以 <｜fim▁end｜> 结尾，suffix 参数独立传） */
exports.FIM_SEPARATOR = '<｜fim▁end｜>';
/** FIM 请求参数 */
exports.FIM_MAX_TOKENS = 128;
exports.FIM_TEMPERATURE = 0;
/** Tab 补全生成超时（ms） */
exports.TAB_COMPLETION_TIMEOUT_MS = 3000;
/** 补全上下文保留行数 */
exports.TAB_COMPLETION_CONTEXT_LINES = 8;
/** 补全结果最大字符数 */
exports.TAB_COMPLETION_MAX_RESULT_CHARS = 4000;
// ── 后台 Agent（对标 Cursor Background Agent） ──----------------------------------------
/** 后台任务目录名（工作区 .kodrix/background） */
exports.BACKGROUND_TASKS_DIR = 'background';
/** 后台任务执行超时（ms） */
exports.BACKGROUND_TASK_TIMEOUT_MS = 180000;
/** 后台任务结果最大字符数 */
exports.BACKGROUND_TASK_RESULT_MAX_CHARS = 12000;
// ── 模型 Auto 路由（Model Router，对标 Cursor 多模型路由） ──--------------------------------------
/** 模型路由配置段 */
exports.MODEL_ROUTER_CONFIG = 'kodrix.modelRouter';
/** 模型路由配置键（kodrix.modelRouter.*） */
exports.MODEL_ROUTER_CONFIG_KEYS = {
    enabled: 'enabled',
};
/** 各档位模型族（smart 深度分析 / balanced 均衡 / fast 快速） */
exports.MODEL_ROUTER_TIERS = {
    smart: ['gpt-4o', 'claude-3.5-sonnet', 'claude-3.7-sonnet', 'copilot-gpt-4'],
    balanced: ['gpt-4o-mini', 'claude-3.5-haiku', 'copilot-gpt-4-mini'],
    fast: ['gpt-4o-mini', 'copilot-gpt-4-mini'],
};
/** 模型路由使用日志最大条目数 */
exports.MODEL_ROUTER_USAGE_LOG_MAX = 500;
// ── Idea Flow 自动执行（端到端，对标 Cursor Agent） ────────────────
/** Idea Flow 配置段 */
exports.IDEA_FLOW_CONFIG = 'kodrix.idea';
/** Idea Flow 配置键（kodrix.idea.*） */
exports.IDEA_FLOW_CONFIG_KEYS = {
    autoExecute: 'autoExecute',
};
