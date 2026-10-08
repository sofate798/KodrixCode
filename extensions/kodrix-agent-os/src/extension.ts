/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 竞品精华整合 + 越用越聪明
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { registerAcp } from './acp/acpRegistry';
import { registerArena } from './arena/arenaCompare';
import { registerContextIntelligence } from './context/contextIntelligence';
import { disposeContextEvents } from './context/contextEvents';
import { disposeKodrixEventBus } from './context/kodrixEventBus';
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
import { registerLauncherView } from './experience/kodrixLauncher';
import { registerWorkspaceBootstrap, cancelBootstrapTimers } from './experience/workspaceBootstrap';
import { registerStatusBar } from './experience/statusBar';
import { registerAgentCrew } from './crew/agentCrew';
import { registerRules } from './context/rulesManager';
import { registerCheckpoints, disposeCheckpointThrottle } from './checkpoint/checkpointManager';
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
import { registerHasWorkspaceContext } from './utils/contextKeys';
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
import { AgentCodeLensProvider, registerCodeLensCommands, fireChange as fireCodeLensChange, disposeCodeLensEmitter } from './codebase/codeLensProvider';
import { onIndexStateChange, disposeIndexStateEmitter, ensureGrepIndex } from './codebase/projectIndexer';
import { logger } from './logger';
import { disposeAllTrackedPanels } from './utils/panelTracker';
import { isKodrixFeatureEnabled, featureDisabledNotice } from './utils/featureFlags';
import {
	INITIAL_INDEX_DELAY_MS,
	FEATURE_FLAGS,
	COMMANDS,
	INDEX_TOO_MANY_FILES_PREFIX,
} from './shared/constants';

async function showAgentOsWelcome(): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({
		content: l10n.t(`# Kodrix Agent OS — Let software development return to ideas

## 🆕 Idea Flow — Fully automated pipeline from idea to product

| Capability | Shortcut | Description |
|------------|----------|-------------|
| **Idea Flow** | \`Ctrl+Shift+I\` | Type an idea → AI automatically analyzes → plans → builds → previews |
| **Idea Canvas** | \`Ctrl+Shift+Alt+I\` | Visual idea canvas with voice input |
| **Smart Routing 3.0** | \`Ctrl+Shift+Alt+R\` | Weighted scoring + automatic routing to Idea/Spec/Plan/Agent/Ask |

**Core concept:** The user describes an idea in the Idea Canvas, and AI automatically handles:
1. Deep analysis (LLM evaluation + technology selection)
2. Automatic planning (Spec documents + Agent Crew configuration)
3. Multi-Agent collaborative development (Architect → Developer → Tester)
4. Automatic build preview (Dev Server + browser preview)
5. Knowledge retention (Learning Engine gets smarter with use)

## Core differentiator: gets smarter with use

| Capability | Command | Description |
|------------|---------|-------------|
| **Semantic Memory** | Automatic vector indexing | Zero-dependency TF-IDF semantic retrieval with 30-day decay weighting |
| **Proactive Context** | Analyzes opened files automatically | Related memories of the current file are linked automatically (shown in the status bar) |
| **Learning Dashboard** | \`Kodrix: Learning Dashboard\` | Interactive charts + search filters + category distribution |
| **Session Learning** | Auto-distills when an Agent finishes | Stop Hook → LLM summary → Memory + Semantic index |
| **Codebase Intelligence** | Automatic indexing | AST-level workspace-wide symbol index + dependency graph + call graph |

## Codebase Intelligence — workspace-wide semantic understanding (new)

| Capability | Entry point | Benchmark surpassed |
|------------|-------------|---------------------|
| **01 Workspace-wide semantic indexing** | Built automatically on startup | Sourcegraph + JetBrains full analysis |
| **02 Context-aware predictive completion** | Triggered automatically while editing | Copilot NES + Cursor Tab |
| **03 Natural-language code Q&A** | \`@codebase\` or the Command Palette | Cody + Copilot Chat |

## Best-of-breed integrations (all built in)

| Product | Core capability | How Kodrix goes further |
|---------|-----------------|-------------------------|
| **Cursor / Windsurf** | Cascade / Agent | **Idea Flow** — fully automated from idea to product |
| **Lovable / Bolt.new / v0** | One-sentence generation | **Idea Canvas** — deep analysis + multi-Agent collaboration |
| **Devin** | Multi-Agent collaboration | **Agent Crew** — automatic orchestration + knowledge retention |
| **Qoder** | Repo Wiki / Quest | Automatic Wiki + Agent Kanban board |
| **Kiro** | Spec-driven / Hooks | Three-pane Spec Editor + preset Hooks |

## New capabilities at a glance

| Capability | Shortcut | Benchmark surpassed |
|------------|----------|---------------------|
| **Idea Flow** | \`Ctrl+Shift+I\` | Lovable + Devin + Cascade |
| **Idea Canvas** | \`Ctrl+Shift+Alt+I\` | Visual idea canvas |
| **Vibe Coding** | \`Ctrl+Shift+V\` | Windsurf Cascade / Lovable |
| **Smart Routing 3.0** | \`Ctrl+Shift+Alt+R\` | Weighted scoring + automatic execution |
| **Agent Crew 2.0** | \`Kodrix: Create Agent Crew\` | Automatic orchestration + task dependency graph |
| **Semantic Memory** | Runs automatically | Zero-dependency vector retrieval |
| **Learning Dashboard** | \`Ctrl+Shift+Alt+M\` | Interactive Webview |
| **Kodrix Hub** | \`Ctrl+Shift+H\` | Command center + live statistics |

## Keyboard shortcut cheatsheet

| Key | Function |
|-----|----------|
| \`Ctrl+Shift+I\` | **Idea Flow** — idea → product (main entry) |
| \`Ctrl+Shift+Alt+I\` | Idea Canvas |
| \`Ctrl+Shift+H\` | Hub command center |
| \`Ctrl+Shift+V\` | Vibe Coding quick entry |
| \`Ctrl+Shift+A\` | Agents window |
| \`Ctrl+Shift+Alt+R\` | Smart routing |
| \`Ctrl+Shift+Alt+K\` | Three-pane Spec workbench |
| \`Ctrl+Shift+Alt+M\` | Distill knowledge / Learning Dashboard |
| \`Ctrl+L\` | Chat panel |
| \`Ctrl+I\` | Agent mode |

Data directories: workspace \`.kodrix/\` · user \`~/.kodrix/\`
`),
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
		vscode.window.showErrorMessage(l10n.t('Kodrix Agent OS activation failed: {0}', msg));
	}
}

/** 模块级 ExtensionContext 引用，供 SecretStorage 读取使用 */
let _extCtx: vscode.ExtensionContext | undefined;

function activateInternal(context: vscode.ExtensionContext): void {
	_extCtx = context;
	// setContext 键同步：kodrix.hasWorkspace 决定 checkpoints 视图可见性（须最先注册）
	registerHasWorkspaceContext(context);
	// Register all commands and event listeners immediately (lightweight)
	registerContextIntelligence(context);
	registerContextStatusBar(context);
	registerToggleContextLayersCommand(context);
	registerProactiveContext(context);
	registerLearningEngine(context);
	registerSessionLearning(context);
	registerWiki(context);
	registerLauncherView(context);
	registerSpec(context);
	registerSpecWorkbench(context);
	registerMemory(context);
	registerKanban(context);
	registerRouter(context);
	registerNaturalCommandPalette(context);
	registerArena(context);
	registerHooks(context);
	syncEmbeddingProvider().catch(err => logger.warn('[Kodrix] syncEmbeddingProvider failed', err));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('kodrix.semanticEmbedding')) {
				syncEmbeddingProvider().catch(err => logger.warn('[Kodrix] syncEmbeddingProvider failed', err));
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
	registerAgentLoop(context);
	registerSubagent(context);
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
	// 代码库智能总开关：关闭后所有用户入口（启动自动索引 / 手动重建 / 统计）都不再触发索引
	const codebaseEnabled = isKodrixFeatureEnabled(FEATURE_FLAGS.codebaseIntelligence);
	const requireCodebaseEnabled = (): boolean => {
		if (codebaseEnabled) { return true; }
		void vscode.window.showWarningMessage(featureDisabledNotice(FEATURE_FLAGS.codebaseIntelligence));
		return false;
	};
	/** 首次索引：失败必须让用户看见并能一键重试（此前只写日志，用户以为功能没做好） */
	const runInitialIndex = async (): Promise<void> => {
		try {
			const idx = await ensureProjectIndex();
			logger.info(`[ProjectIndexer] Initial index ready: ${idx.stats.totalFiles} files, ${idx.stats.totalSymbols} symbols`);
			// 「为即时 Grep 索引仓库」默认开启：索引完成后按开关生成一次文本清单，
			// 供 Agent 的 search 工具直接复用（此前该开关只在设置面板里点一下才有意义）
			if (vscode.workspace.getConfiguration('kodrix.codebase').get<boolean>('grepIndex', true)) {
				void ensureGrepIndex().catch(err =>
					logger.warn(`[ProjectIndexer] Grep 索引生成失败：${err instanceof Error ? err.message : String(err)}`),
				);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error('Codebase intelligence: initial index build failed', err);

			// 文件数超上限：不是"失败"，而是按设置说明主动跳过自动索引 —— 给出可操作提示
			if (message.startsWith(INDEX_TOO_MANY_FILES_PREFIX)) {
				const [, count, limit] = message.split(':');
				const indexAnyway = l10n.t('Index anyway');
				const openSettings = l10n.t('Open Index Settings');
				logger.info(`[ProjectIndexer] 自动索引已跳过：文件数 ${count} 超过上限 ${limit}`);
				const choice = await vscode.window.showWarningMessage(
					l10n.t('The current repository has {0} files, exceeding the automatic indexing limit of {1}. Automatic indexing was skipped to avoid a long-running operation (adjust the limit in settings or rebuild manually).', count, limit),
					indexAnyway,
					openSettings,
				);
				if (choice === indexAnyway) {
					try {
						const idx = await ensureProjectIndex(true, { manual: true });
						vscode.window.showInformationMessage(
							l10n.t('Indexing complete: {0} files · {1} symbols', idx.stats.totalFiles, idx.stats.totalSymbols),
						);
					} catch (manualErr) {
						vscode.window.showErrorMessage(l10n.t('Index rebuild failed: {0}', manualErr instanceof Error ? manualErr.message : String(manualErr)));
					}
				} else if (choice === openSettings) {
					await vscode.commands.executeCommand('kodrix.codebase.indexManager.open');
				}
				return;
			}

			const retry = l10n.t('Retry');
			const openSettings = l10n.t('Open Index Settings');
			const choice = await vscode.window.showErrorMessage(
				l10n.t('Failed to build the codebase index: {0}', message),
				retry,
				openSettings,
			);
			if (choice === retry) {
				await runInitialIndex();
			} else if (choice === openSettings) {
				await vscode.commands.executeCommand('kodrix.codebase.indexManager.open');
			}
		}
	};
	const initialIndexTimer = setTimeout(() => {
		if (!codebaseEnabled) {
			logger.info('[ProjectIndexer] Initial index skipped (代码库智能 关闭)');
			return;
		}
		// 尊重「索引新文件夹」开关：关闭时不做自动索引
		if (!vscode.workspace.getConfiguration('kodrix.codebase').get<boolean>('autoIndexNewFolders', true)) {
			logger.info('[ProjectIndexer] Initial index skipped (索引新文件夹 关闭)');
			return;
		}
		void runInitialIndex();
	}, INITIAL_INDEX_DELAY_MS);
	context.subscriptions.push({ dispose: () => clearTimeout(initialIndexTimer) });

	// 手动重建索引命令
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.codebaseBuildIndex, async () => {
			if (!requireCodebaseEnabled()) { return; }
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: l10n.t('Kodrix: Rebuilding project-wide semantic index...') },
					async () => {
						const idx = await ensureProjectIndex(true, { manual: true });
						vscode.window.showInformationMessage(
							l10n.t('Index rebuild complete: {0} files · {1} symbols · {2}ms', idx.stats.totalFiles, idx.stats.totalSymbols, idx.stats.indexDurationMs),
						);
					},
				);
			} catch (err) {
				logger.error('Codebase intelligence: manual index rebuild failed', err);
				vscode.window.showErrorMessage(l10n.t('Index rebuild failed: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),
	);

	// 查看索引统计命令
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.codebaseStats, async () => {
			const idx = await ensureProjectIndex();
			if (!idx) {
				vscode.window.showWarningMessage(l10n.t('No project index yet. Please open a workspace first'));
				return;
			}
			const stats = idx.stats;
			const doc = await vscode.workspace.openTextDocument({
				content: [
					l10n.t('# Kodrix Workspace-wide Semantic Index Statistics'),
					'',
					l10n.t('| Metric | Value |'),
					'|------|-----|',
					l10n.t('| Index version | v{0} |', idx.version),
					l10n.t('| Project path | {0} |', idx.rootPath),
					l10n.t('| Created | {0} |', idx.createdAt),
					l10n.t('| Updated | {0} |', idx.updatedAt),
					l10n.t('| Total files | {0} |', stats.totalFiles),
					l10n.t('| Total symbols | {0} |', stats.totalSymbols),
					l10n.t('| Import relations | {0} |', stats.totalImports),
					l10n.t('| Call relations | {0} |', stats.totalCalls),
					l10n.t('| Indexing time | {0}ms |', stats.indexDurationMs),
					l10n.t('| Hot symbols | {0} |', idx.hotSymbols.length),
					'',
					l10n.t('## Language distribution'),
					'',
					...Object.entries(stats.languageDistribution)
						.sort((a, b) => b[1] - a[1])
						.map(([lang, count]) => `| \`.${lang}\` | ${count} |`),
					'',
					l10n.t('## Top 10 hot symbols'),
					'',
					l10n.t('| # | Symbol | Kind | Visibility |'),
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
	disposeIndexStateEmitter();
	disposeCodeLensEmitter();
	disposeContextEvents();
	disposeKodrixEventBus();
	disposeCheckpointThrottle();
	logger.dispose();
}
