# Minicode 工程修复记录

> 修复时间：2026-09-20
> 修复目标：让 D:\minicode（基于 VSCodium 深度定制的 AI 编程编辑器源码工程）可以在本地编译出可运行的发行版，并能正常启动窗口、加载扩展（Agent 协作 / SOLO 工作台 / Skill 生态 / 本地模型）。

## 一、修复前症状

用 `debug.bat` 启动后：
- 主进程存活但**永不创建窗口**（内存 74MB 恒定、CPU 几乎不动、`MainWindowHandle=0`）
- 无渲染进程、无扩展宿主；`%APPDATA%\code-oss-dev\logs\20*\main.log` 一直不存在
- 启动日志稳定停在 `NativePolicyService#_updatePolicyDefinitions - Creating watcher for productName Minicode` 之后

## 二、根因与修复（4 个问题）

### 1. `@vscode/policy-watcher` 的 Dev Shim 永不触发回调 → 主进程启动卡死
- **文件**：`node_modules\@vscode\policy-watcher\index.js`
- **原因**：该文件被替换成 "Minicode Dev Shim"（mock），`createWatcher()` 返回一个 no-op stub，**从不调用 callback**；而 `out\vs\platform\policy\node\nativePolicyService.js` 的 `_updatePolicyDefinitions` 用 `new Promise((c) => { this.watcher.value = createWatcher(..., (update) => { ...; c(); }); })` 等待**首次策略更新回调**——回调永不触发 → promise 永不 resolve → `configurationService.initialize()` 挂起 → `CodeApplication.startup()` 永不执行 → 无窗口。
- **修复**：shim 的 `createWatcher()` 在创建时立即调用一次 `callback({})`（空更新），让等待方解除挂起。
- **脚本**：`scripts/restore-pw-shim.mjs`

### 2. 多个 `@vscode/*` native 模块缺少编译产物 → 启动链路抛异常
- **文件**（均为 `node_modules\@vscode\*\build\Release\*.node` 缺失）：`windows-registry`、`sqlite3`、`spdlog`、`deviceid`、`native-watchdog`、`windows-ca-certs`、`windows-mutex`、`windows-process-tree`、`policy-watcher`
- **原因**：工作区的 node_modules 只含源码/构建配置，native 二进制未编译（本机无 VS Build Tools / node-gyp 工具链，无法现场编译）。
- **修复**：
  - 从本机官方 VS Code 安装 `D:\Program\Microsoft VS Code\7debcd0e2a\resources\app\node_modules.asar.unpacked\@vscode\` 复制全部 9 个 `.node` 到 Minicode 对应位置（N-API 模块跨 ABI 兼容；实测 sqlite3 / spdlog / deviceid / windows-registry 等加载成功，主进程日志系统恢复）。
  - `windows-registry\dist\index.js`：顶层 `require(...winregistry.node)` 改为 try/catch 降级（避免模块级加载崩溃）；有编译产物时走原生路径。
  - **脚本**：`scripts/copy-native-modules.mjs`
- **例外**：`@vscode/policy-watcher` 的官方 `.node` 与当前 Electron 42 ABI 导出不兼容（`createWatcher is not a function`），因此保留修复版 shim（见问题 1）。

### 3. `product.json` 缺 `sharedDataFolderName` → `joinPath(this.userHome, undefined)` 崩溃
- **文件**：`product.json`
- **原因**：缺 `sharedDataFolderName` 字段，`EnvironmentMainService#appSharedDataHome` 在 `StorageMainService` 创建时抛 `path argument must be of type string. Received undefined`，主进程退出。
- **修复**：补 `"sharedDataFolderName": ".minicode"`（与 `dataFolderName` 一致）。
- **脚本**：`scripts/fix-product-json.mjs`

### 4. `product.json` 缺 `defaultChatAgent` → 渲染进程 onboarding 未捕获异常
- **文件**：`product.json`
- **原因**：缺 `defaultChatAgent` 字段，`welcomeOnboarding/onboardingVariationA.js` 的 `assertDefined(product.defaultChatAgent, ...)` 在窗口渲染时抛 uncaught exception。
- **修复**：补官方默认结构（`extensionId: "GitHub.copilot"`、`chatExtensionId: "GitHub.copilot-chat"`、provider 等）。
- **脚本**：`scripts/fix-product-json.mjs`

## 三、当前状态（已验证）

- `debug.bat` / `scripts/dev-fast.ps1` 规范启动成功：[1/5]→[5/5] 全过，窗口创建（`MainWindowHandle != 0`）
- 主进程 / 渲染进程 / 扩展宿主 / Agent Host / Copilot 全部运行
- 日志系统完整：`main.log`、`exthost.log`、`agenthost`、`mcpGateway.log` 等 12 个日志文件正常生成
- 状态存储（sqlite）正常（`@vscode/sqlite3` 加载成功，不再出现 `Unable to open DB`）
- 扩展宿主正常加载扩展（MCP SERVERS 视图、Agent 会话、Copilot 进程均在工作）

## 四、已知残留（非阻塞，均为优雅降级）

| 模块 | 现象 | 影响 | 处理 |
|---|---|---|---|
| `native-keymap`（keymapping） | 缺 `.node`，加载报错 | 键盘布局检测返回空（用默认布局） | 可忽略；有 VS Build Tools 后 `npm rebuild native-keymap` |
| `native-is-elevated`（iselevated） | 缺 `.node`，加载报错 | 管理员权限检测恒为 false | 可忽略；同上 |
| `@vscode/policy-watcher` | 官方 `.node` ABI 不兼容 | 企业策略（managed settings）不监控 | 保留修复版 shim（启动正常） |

## 五、环境要求（重要）

- **Node.js**：`.nvmrc` 要求 24.17.0（major=24 且 minor>=17，npm<12）。本机合规版本在 `D:\Program\nodejs\node.exe`（v24.21.0）。
  - 注意：系统 PATH 上可能存在沙箱附带的 Node v22（不合规），编译/转译请显式使用 v24。
- **常用命令**：
  - 快速启动：`.\debug.bat`（esbuild 转译 + 启动，秒级）
  - 全量编译：`.\debug.bat -FullCompile`
  - 仅准备环境：`.\debug.bat -Prepare`
  - 还原 `out/`：`node build/next/index.ts transpile`（在 v24 PATH 下）
- **若以后装了 VS Build Tools**：可 `npm rebuild` 补齐全部 native 模块（policy-watcher 可换回原生 `scripts/copy-native-modules.mjs` 注释中的加载方式）。

## 六、修复脚本位置

- `scripts/fix-product-json.mjs` —— 补 product.json 字段（幂等）
- `scripts/copy-native-modules.mjs` —— 从官方 VS Code 复制 native 二进制（幂等）
- `scripts/restore-pw-shim.mjs` —— 恢复/写入 policy-watcher 修复版 shim（幂等）

---

## 七、界面默认简体中文（2026-09-20 追加）

### 背景
dev 构建（esbuild transpile）产物的 `out/vs/nls.js` 是 NLS 简化版：`localize(data, message)` 在 data 为字符串 key（未启用索引机制）时直接返回英文默认值，因此虽然 `code.bat` 已传 `--locale=zh-cn`，核心界面仍显示英文。

### 方案（三层，可重放）
1. **安装官方中文语言包为内置扩展**：`extensions/ms-ceintl.vscode-language-pack-zh-hans`（MS-CEINTL v1.128.0，engines `^1.128.0` 与本工程内核 1.128.0 匹配，languageId `zh-cn`）。扩展级翻译（git、typescript-language-features 等内置扩展的 l10n 字符串）由 VS Code LocalizationService 自动生效。
2. **核心 UI 中文化脚本** `scripts/apply-zh-langpack.mjs`（幂等）：
   - 读取语言包 `translations/main.i18n.json`（`contents{模块:{key:中文}}`），拍平为全局 `{key:中文}` 查表；同一 key 多处出现且译文冲突时取出现频次最高的译文。
   - 将查表逻辑注入 `out/vs/nls.js`（`localize`/`localize2` 的字符串 key 分支命中中文表时返回中文，未命中回退原逻辑，不影响 NLS 索引机制）。
   - 输出命中率校验（out/vs 源码 localize key 命中率约 84%，核心 UI 文件抽样命中率 100%）。
3. **挂接构建流程**：`scripts/dev-fast.ps1` 在 [3/5] 编译之后新增 `[3.5/5] Applying zh-cn language pack...` 自动执行（transpile 每次会重建 nls.js，故置于编译之后；幂等跳过）。

### 验证（已实测）
- 窗口标题「欢迎 - Minicode Dev」；菜单栏（文件/编辑/选择/查看/搜索）、侧栏（资源管理器、打开文件夹）、欢迎页（新建文件/打开文件/打开文件夹/连接到…/生成新工作区…）全部中文。
- `debug.bat` / `dev-fast.ps1` 完整链路（transpile → 语言包注入 → 启动）正常。

### 附：顺带修复
- `product.json` 补 `"builtInExtensionsEnabledWithAutoUpdates": []`（消除 `extensionsScannerService` 等对 undefined 迭代导致的 `builtInExtensionsEnabledWithAutoUpdates is not iterable` 日志报错）。

### 还原方式
重新 `node build/next/index.ts transpile` 即还原英文版 `out/vs/nls.js`；如需彻底移除，删除语言包扩展目录与 dev-fast.ps1 中的挂接段即可。

### 备注
- 语言包临时解压副本 `D:\minicode\.langpack-zh`（100 个文件）为下载中间产物，功能上无用途（正式副本已安装到 extensions），可手动删除；因批量删除被系统安全策略拦截，未由脚本自动清理。
- 语言包版本需与内核版本匹配：升级内核（package.json version）时应同步更换 `extensions/ms-ceintl.vscode-language-pack-zh-hans` 为对应版本（open-vsx.org 下载），否则翻译覆盖率下降或 engines 校验失败。

---

## 八、minicode-local AI 功能体检与修复（2026-09-21 追加）

### 检查范围
逐项核验 minicode-local 扩展声明能力（13 个供应商预设 / OpenAI 兼容自动探测 / 模型路由 plan·agent·code·fast / Tab 补全 NES / Ctrl+K 行内编辑 / Composer 多文件 Agent / @Codebase / Background Agent / Cloud Agent / Agents 窗口 / 导入 Cursor 配置）的**完善性与是否正常**。方法：源码细读 → 44 配置键 / 9 命令存在性扫描 → 运行态验证（启动 Minicode 查 exthost / 扩展日志 / 用户配置写入）。

### 结论概览：11 项能力全部就位，修复 4 处缺陷后运行态验证通过

| 能力 | 实现位置 | 核验结果 |
|---|---|---|
| 13 供应商预设 | `resources/presets.json`（本地 4 + 云端 8 + custom） | ✅ 完整 |
| OpenAI 兼容自动探测 | `modelDiscovery.ts`（/v1/models、/models、Ollama /api/tags，Bearer + 10s 超时） | ✅ 完整 |
| 模型路由 plan/agent/code/fast | `modelResolve.ts` + `applyModelRoutes` → chat.planAgent.defaultModel / implementAgent.model / exploreAgent.defaultModel / utilitySmallModel | ✅ 完整 |
| Tab 补全 + NES | `cursor3Experience.ts`（github.copilot.enable、inlineSuggest、tabCompletion、nextEditSuggestions×4） | ✅ 完整（editor.tabCompletion 确认存在，enum 139） |
| Ctrl+K 行内编辑 | `cursorKeybindings.ts` → `inlineChat.start`（核心命令存在） | ✅ 完整 |
| Composer 多文件 Agent | `cursorFeatures.ts` openComposer → chat.open + `{mode:'agent'}` | ✅ 完整 |
| @Codebase | attachCodebase → `#codebase` 查询；索引由 `github.copilot.buildRemoteWorkspaceIndex`（copilot 提供） | ✅ 完整（时序告警见遗留） |
| Background Agent | continueInBackground → `openNewChatSessionInPlace.copilotcli`（**动态注册命令**，chatSessions.contribution.js 按会话类型生成） | ✅ 完整 |
| Cloud Agent | continueInCloud → `openNewChatSessionInPlace.copilot-cloud-agent`（同上动态注册，copilot 扩展含该会话类型） | ✅ 完整 |
| Agents 窗口 | openAgentsWindow → `workbench.action.openAgentsWindow`；openWorkspaceInAgentsWindow（核心命令存在） | ✅ 完整 |
| 导入 Cursor 配置 | `cursorImport.ts` + `cursorRulesSqlite.ts`（rules/mcp/skills/settings + state.vscdb SQLite） | ✅ 完整（修复后） |

### 修复的 4 处缺陷（均已重编译并运行态验证）

1. **Ctrl+I 绑定命令不存在**（`package.json` keybindings）
   - 原绑定 `workbench.action.chat.openAgent` 在 VS Code 1.128 核心**不存在**（1.128 打开 Agent 模式的正确命令是 `workbench.action.chat.open` + `{mode:'agent'}`，核心默认键 Ctrl+Shift+I；纯 Ctrl+I 默认被 voiceChat 占用）。
   - 修复：改为 `"command": "workbench.action.chat.open"` + `"args": {"mode": "agent"}`。

2. **配置写入中断导致激活失败**（`cursorDefaults.ts` / `cursor3Experience.ts`）
   - `config.update()` 对**未注册配置键**抛 `CodeExpectedError`（"没有注册配置 …"），未捕获 → 整条默认配置循环中断 → 扩展激活失败（弹窗），Cursor 对标配置无法落盘。
   - 根因键：`sessions.chat.localAgent.enabled` 在 1.128 已改名 `chat.editor.localAgent.enabled`（constants.ts `EditorLocalAgentEnabled`）。
   - 修复：a) 键名更正（cursorDefaults + cursor3Experience 的 FORCE 集）；b) 所有 `config.update` 包 try/catch，未注册键跳过并告警，不阻断其余键；c) 版本号提升（DEFAULTS_VERSION 3→4、CURSOR3_FEATURES_VERSION 6→7）强制重放。

3. **Cursor SQLite 导入白名单键名不一致**（`cursorRulesSqlite.ts`）
   - `LEGACY_RULES_KEY = 'aicontext.personalContext'` 与白名单 `'ai.context.personalContext'` 不一致；`CURSOR_STATE_KEY` 带 `src.` 前缀而白名单不带 → 两者均抛 `Untrusted ItemTable key`。
   - 修复：白名单补齐 4 个真实键（含 `src.` 前缀变体），SQLite 导入路径放行；`importFromCursorOnFirstRun` 包 try/catch，导入失败仅告警不阻断激活（本机 sqlite3 CLI 缺失时实测走二进制扫描降级，无报错）。

4. **`github.copilot.chat.codebase.enabled` 无效配置键**（`cursor3Experience.ts`）
   - 该键在 copilot 1.128 **不存在**（codebase 是聊天工具 `copilot_searchCodebase`，非配置）；此前写入被静默忽略。
   - 修复：从 `intelligenceContextDefaults()` 移除该无效条目（@Codebase 实际由 `chat.workspace.codeSearchExternalIngest.enabled` + `#codebase` 语法提供，均已核验）。

### 运行态验证证据（第四次启动，日志 `code-oss-dev/logs/20260921T172531`）
- exthost：`_doActivateExtension minicode.minicode-local` 正常，**无 activation failed**。
- 扩展日志（2-Minicode.log）：仅 1 条无害告警 `buildRemoteWorkspaceIndex not found`（copilot 扩展尚未激活时的时序提示，copilot 就绪后命令可用；代码有 try/catch + 用户提示）。
- 用户配置：`User/settings.json` 由 2 键 → **21 键**（viewSessions / agentsControl / unifiedAgentsBar / permissions.default=autoApprove / defaultConfiguration=plan+autoApprove / secondarySideBar / agentHost.enabled / editor.defaultProvider=copilotAh / restoreLastPanelSession 等全部落盘）。

### 遗留说明（非 minicode-local 问题）
- `No bundle location found`：是**本地化 bundle（package.nls.json）缺失**的日志噪音，扩展仍正常激活；4 个 minicode 自定义扩展均有此日志。需要消除可给扩展补 `package.nls.json`，不补无功能影响。
- `minicode-agent-os` 激活失败：`chatContextProvider` API proposal 未在 package.json#enabledApiProposals 声明（需 `--enable-proposed-api minicode.minicode-agent-os` 或补声明）。属 agent-os 扩展，不在本次 minicode-local 范围。
- `buildRemoteWorkspaceIndex` 首次启动的时序告警：copilot 激活前调用即 not found；属预期降级（有 try/catch），用户可稍后在命令面板手动触发「构建代码库索引」。
