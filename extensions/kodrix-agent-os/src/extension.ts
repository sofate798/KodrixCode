/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 竞品精华整合 + 越用越聪明
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { registerAcp } from './acp/acpRegistry';
import { registerArena } from './arena/arenaCompare';
import { registerContextIntelligence } from './context/contextIntelligence';
import { registerContextStatusBar, registerToggleContextLayersCommand } from './context/contextStatusBar';
import { registerProactiveContext } from './context/proactiveContext';
import { registerHooks } from './hooks/hooksPresets';
import { registerKanban } from './kanban/agentKanban';
import { registerLearningEngine } from './learning/learningEngine';
import { registerSessionLearning } from './learning/sessionLearning';
import { registerMemory } from './memory/projectMemory';
import { registerPropertyTests } from './testing/propertyTests';
import { registerRouter } from './router/agentRouter';
import { registerNaturalCommandPalette } from './router/naturalCommandPalette';
import { registerSpec } from './spec/specWorkflow';
import { registerSpecWorkbench } from './spec/specWorkbench';
import { registerWiki } from './wiki/repoWiki';
import { registerKodrixHub } from './experience/kodrixHub';
import { registerWorkspaceBootstrap, cancelBootstrapTimers } from './experience/workspaceBootstrap';
import { registerStatusBar } from './experience/statusBar';
import { registerAgentCrew } from './crew/agentCrew';
import { registerRules } from './context/rulesManager';
import { registerCheckpoints } from './checkpoint/checkpointManager';
import { registerCheckpointTimeline } from './checkpoint/checkpointTimelineView';
import { registerCheckpointDiffGallery } from './checkpoint/checkpointDiffGallery';
import { registerModelRouter } from './model/modelRouter';
import { registerUserProfile } from './profile/userProfile';
import { registerTabCompletion } from './completion/tabCompletion';
import { registerBackgroundAgent } from './background/backgroundAgent';
import { registerCrewVisualizer } from './crew/crewVisualizer';
import { registerAgentLoop } from './agent/agentLoop';
import { registerSubagent } from './agent/subagent';
import { registerThreads } from './agent/threads';
import { registerApplyManager } from './apply/applyManager';
import { registerTerminalAI } from './terminal/terminalAi';
import { registerVibeCoding } from './experience/vibeCoding';
import { registerIdeaFlow, disposeIdeaFlowEmitter } from './experience/ideaFlow';
import { registerAgentStateListener, disposeAgentStateTimers } from './experience/agentStateBridge';
import {
	ensureProjectIndex,
	startIndexWatcher,
	disposeIndexWatcher,
	registerCodebaseChatParticipant,
	registerPredictiveCompletion,
} from './codebase/index';
import { registerEmbeddingProvider, clearEmbeddingProvider } from './codebase/semanticIndex';
import { createZhipuEmbeddingProvider, ZHIPU_DEFAULT_ENDPOINT, ZHIPU_DEFAULT_MODEL } from './codebase/embeddingProvider';
import { getEmbeddingApiKey } from './secretStorage';
import { setEmbeddingProvider as setSemanticEmbeddingProvider } from './learning/semanticMemory';
import { registerIndexManager } from './codebase/indexManager';
import { registerSettingsPage } from './codebase/settingsPage';
import { AgentCodeLensProvider, registerCodeLensCommands, fireChange as fireCodeLensChange } from './codebase/codeLensProvider';
import { onIndexStateChange } from './codebase/projectIndexer';
import { logger } from './logger';
import { disposeAllTrackedPanels } from './utils/panelTracker';
import {
	INITIAL_INDEX_DELAY_MS,
	CONFIG_FEATURES,
	FEATURE_FLAGS,
	COMMANDS,
} from './shared/constants';

async function showAgentOsWelcome(): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({
		content: `# Kodrix Agent OS — 让软件开发回归想法本身

## 🆕 Idea Flow — 想法到产品的全自动流水线

| 能力 | 快捷键 | 说明 |
|------|--------|------|
| **Idea Flow 启动** | \`Ctrl+Shift+I\` | 输入想法 → AI 全自动分析→规划→构建→预览 |
| **Idea Canvas** | \`Ctrl+Shift+Alt+I\` | 可视化想法画布，支持语音输入 |
| **智能路由 3.0** | \`Ctrl+Shift+Alt+R\` | 加权评分 + 自动路由到 Idea/Spec/Plan/Agent/Ask |

**核心理念：** 用户在 Idea Canvas 中描述想法，AI 自动完成：
1. 深度分析（LLM 评估 + 技术选型）
2. 自动规划（Spec 文档 + Agent Crew 配置）
3. 多 Agent 协同开发（架构师→开发者→测试者）
4. 自动构建预览（Dev Server + 浏览器预览）
5. 知识沉淀（Learning Engine 越用越聪明）

## 核心差异化：越用越聪明

| 能力 | 命令 | 说明 |
|------|------|------|
| **Semantic Memory** | 自动向量索引 | 零依赖 TF-IDF 语义检索，30 天衰减权重 |
| **Proactive Context** | 打开文件自动分析 | 当前文件相关记忆自动关联（状态栏显示） |
| **Learning Dashboard** | \`Kodrix: Learning 学习仪表盘\` | 交互式图表 + 搜索过滤 + 类别分布 |
| **Session Learning** | Agent 结束自动蒸馏 | Stop Hook → LLM 摘要 → Memory + Semantic 索引 |
| **Codebase Intelligence** | 自动索引 | AST 级全工程符号索引 + 依赖图 + 调用图 |

## Codebase Intelligence — 全工程语义理解（全新）

| 能力 | 入口 | 对标超越 |
|------|------|---------|
| **01 全工程级语义索引** | 启动时自动构建 | Sourcegraph + JetBrains 全量分析 |
| **02 上下文精准预测补全** | 编辑时自动触发 | Copilot NES + Cursor Tab |
| **03 自然语言代码问答** | \`@codebase\` 或命令面板 | Cody + Copilot Chat |

## 竞品精华整合（全内置）

| 竞品 | 核心能力 | Kodrix 超越 |
|------|---------|-------------|
| **Cursor / Windsurf** | Cascade / Agent | **Idea Flow** — 从想法到产品全自动 |
| **Lovable / Bolt.new / v0** | 一句话生成 | **Idea Canvas** — 深度分析 + 多 Agent 协同 |
| **Devin** | 多 Agent 协作 | **Agent Crew** — 自动编排 + 知识沉淀 |
| **Qoder** | Repo Wiki / Quest | 自动 Wiki + Agent Kanban 看板 |
| **Kiro** | Spec 驱动 / Hooks | 三栏 Spec Editor + Hooks 预置 |

## 新能力速览

| 能力 | 快捷键 | 对标超越 |
|------|--------|---------|
| **Idea Flow** | \`Ctrl+Shift+I\` | Lovable + Devin + Cascade |
| **Idea Canvas** | \`Ctrl+Shift+Alt+I\` | 可视化想法画布 |
| **Vibe Coding** | \`Ctrl+Shift+V\` | Windsurf Cascade / Lovable |
| **智能路由 3.0** | \`Ctrl+Shift+Alt+R\` | 加权评分 + 自动执行 |
| **Agent Crew 2.0** | \`Kodrix: 创建 Agent Crew\` | 自动编排 + 任务依赖图 |
| **Semantic Memory** | 自动运行 | 零依赖向量检索 |
| **Learning Dashboard** | \`Ctrl+Shift+Alt+M\` | 交互式 Webview |
| **Kodrix Hub** | \`Ctrl+Shift+H\` | 指挥中心 + 实时统计 |

## 快捷键速查

| 键 | 功能 |
|----|------|
| \`Ctrl+Shift+I\` | **Idea Flow** — 想法→产品（主入口） |
| \`Ctrl+Shift+Alt+I\` | Idea Canvas 画布 |
| \`Ctrl+Shift+H\` | Hub 指挥中心 |
| \`Ctrl+Shift+V\` | Vibe Coding 快捷入口 |
| \`Ctrl+Shift+A\` | Agents 窗口 |
| \`Ctrl+Shift+Alt+R\` | 智能路由 |
| \`Ctrl+Shift+Alt+K\` | Spec 三栏工作台 |
| \`Ctrl+Shift+Alt+M\` | 沉淀知识 / 学习仪表盘 |
| \`Ctrl+L\` | Chat 面板 |
| \`Ctrl+I\` | Agent 模式 |

数据目录：工作区 \`.kodrix/\` · 用户 \`~/.kodrix/\`
`,
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc);
}

/** 语义检索 Embedding：设置 kodrix.semanticEmbedding.enabled + SecretStorage 中存有 apiKey 即启用（默认智谱 embedding-3） */
async function syncEmbeddingProvider(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('kodrix.semanticEmbedding');
	const enabled = cfg.get<boolean>('enabled', false);
	const apiKey = _extCtx ? await getEmbeddingApiKey(_extCtx) : undefined;
	if (enabled && apiKey) {
		const provider = createZhipuEmbeddingProvider({
			apiKey,
			endpoint: cfg.get<string>('endpoint', ZHIPU_DEFAULT_ENDPOINT),
			model: cfg.get<string>('model', ZHIPU_DEFAULT_MODEL),
		});
		registerEmbeddingProvider(provider);
		setSemanticEmbeddingProvider(provider);
		logger.info('[Kodrix] 语义检索已接入 Embedding（智谱 embedding-3）');
	} else {
		clearEmbeddingProvider();
		setSemanticEmbeddingProvider(undefined);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	// ── 错误边界：确保扩展激活失败时有用户可见的错误信息，
	//        而不是静默失败（大厂工程化标准要求）。
	try {
		activateInternal(context);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error('Agent OS activation failed', err);
		vscode.window.showErrorMessage(l10n.t('Kodrix Agent OS 激活失败: {0}', msg));
	}
}

/** 模块级 ExtensionContext 引用，供 SecretStorage 读取使用 */
let _extCtx: vscode.ExtensionContext | undefined;

function activateInternal(context: vscode.ExtensionContext): void {
	_extCtx = context;
	// Register all commands and event listeners immediately (lightweight)
	registerContextIntelligence(context);
	registerContextStatusBar(context);
	registerToggleContextLayersCommand(context);
	registerProactiveContext(context);
	registerLearningEngine(context);
	registerSessionLearning(context);
	registerWiki(context);
	registerSpec(context);
	registerSpecWorkbench(context);
	registerMemory(context);
	registerKanban(context);
	registerRouter(context);
	registerNaturalCommandPalette(context);
	registerArena(context);
	registerHooks(context);
	syncEmbeddingProvider().catch(err => console.warn('[Kodrix] syncEmbeddingProvider failed:', err));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('kodrix.semanticEmbedding')) {
				syncEmbeddingProvider().catch(err => console.warn('[Kodrix] syncEmbeddingProvider failed:', err));
			}
		}),
	);
	registerAcp(context);
	registerPropertyTests(context);
	registerKodrixHub(context);
	registerWorkspaceBootstrap(context);
	registerStatusBar(context);
	registerAgentCrew(context);
	registerRules(context);
	registerCheckpoints(context);
	registerCheckpointTimeline(context);
	registerCheckpointDiffGallery(context);
	registerModelRouter(context);
	registerUserProfile(context);
	registerTabCompletion(context);
	registerBackgroundAgent(context);
	registerCrewVisualizer(context);
	registerAgentLoop(context)
	registerSubagent(context)
	registerThreads(context);
	registerApplyManager(context);
	registerTerminalAI(context);
	registerVibeCoding(context);
	registerIdeaFlow(context);
	registerAgentStateListener(context);

	// ── 全工程级语义索引（三大核心能力） ──
	registerPredictiveCompletion(context);
	registerCodebaseChatParticipant(context);

	// 「索引与文档」管理面板（对标 Cursor 代码库索引视图）
	registerIndexManager(context);

	// Kodrix Settings — 设置编辑器内嵌自定义设置页（仿 Cursor Settings）
	registerSettingsPage(context);

	// ── Code Lens for Agents ──
	const codeLensProvider = new AgentCodeLensProvider();
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ language: 'typescript' }, codeLensProvider),
		vscode.languages.registerCodeLensProvider({ language: 'typescriptreact' }, codeLensProvider),
	);
	registerCodeLensCommands(context);

	// 索引更新时刷新 CodeLens
	context.subscriptions.push(
		onIndexStateChange(() => fireCodeLensChange()),
	);

	// 后台启动项目索引构建 + 文件监听
	startIndexWatcher(context);
	const codebaseEnabled = vscode.workspace.getConfiguration(CONFIG_FEATURES)
		.get<boolean>(FEATURE_FLAGS.codebaseIntelligence, true);
	const initialIndexTimer = setTimeout(() => {
		if (!codebaseEnabled) return;
		// 尊重「索引新文件夹」开关：关闭时不做自动索引
		if (!vscode.workspace.getConfiguration('kodrix.codebase').get<boolean>('autoIndexNewFolders', true)) {
			logger.info('[ProjectIndexer] Initial index skipped (索引新文件夹 关闭)');
			return;
		}
		void ensureProjectIndex().catch(err =>
			logger.error('Codebase intelligence: initial index build failed', err),
		);
	}, INITIAL_INDEX_DELAY_MS);
	context.subscriptions.push({ dispose: () => clearTimeout(initialIndexTimer) });

	// 手动重建索引命令
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.codebaseBuildIndex, async () => {
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: l10n.t('Kodrix: 重建全工程语义索引...') },
					async () => {
						const idx = await ensureProjectIndex(true);
						vscode.window.showInformationMessage(
							l10n.t('索引重建完成: {0} 个文件 · {1} 个符号 · {2}ms', idx.stats.totalFiles, idx.stats.totalSymbols, idx.stats.indexDurationMs),
						);
					},
				);
			} catch (err) {
				logger.error('Codebase intelligence: manual index rebuild failed', err);
				vscode.window.showErrorMessage(l10n.t('索引重建失败：{0}', err instanceof Error ? err.message : String(err)));
			}
		}),
	);

	// 查看索引统计命令
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.codebaseStats, async () => {
			const idx = await ensureProjectIndex();
			if (!idx) {
				vscode.window.showWarningMessage(l10n.t('暂无项目索引，请先打开工作区'));
				return;
			}
			const stats = idx.stats;
			const doc = await vscode.workspace.openTextDocument({
				content: [
					'# Kodrix 全工程语义索引统计',
					'',
					'| 指标 | 值 |',
					'|------|-----|',
					`| 索引版本 | v${idx.version} |`,
					`| 项目路径 | ${idx.rootPath} |`,
					`| 创建时间 | ${idx.createdAt} |`,
					`| 更新时间 | ${idx.updatedAt} |`,
					`| 文件总数 | ${stats.totalFiles} |`,
					`| 符号总数 | ${stats.totalSymbols} |`,
					`| 导入关系 | ${stats.totalImports} |`,
					`| 调用关系 | ${stats.totalCalls} |`,
					`| 索引耗时 | ${stats.indexDurationMs}ms |`,
					`| 热门符号 | ${idx.hotSymbols.length} 个 |`,
					'',
					'## 语言分布',
					'',
					...Object.entries(stats.languageDistribution)
						.sort((a, b) => b[1] - a[1])
						.map(([lang, count]) => `| \`.${lang}\` | ${count} |`),
					'',
					'## Top 10 热门符号',
					'',
					'| # | 符号 | 类型 | 可见性 |',
					'|---|------|------|--------|',
					...(idx.hotSymbols.slice(0, 10).map((symId, i) => {
						const sym = idx.symbols[symId];
						return sym ? `| ${i + 1} | \`${sym.name}\` | ${sym.kind} | ${sym.visibility} |` : null;
					}).filter(Boolean) as string[]),
				].join('\n'),
				language: 'markdown',
			});
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.agentOsWelcome, () => showAgentOsWelcome()),
	);
}

export function deactivate(): void {
	disposeAllTrackedPanels();
	cancelBootstrapTimers();
	disposeAgentStateTimers();
	disposeIdeaFlowEmitter();
	disposeIndexWatcher();
	logger.dispose();
}
