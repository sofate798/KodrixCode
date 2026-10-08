# Kodrix Code：AI 个人开发者上手与使用说明

本文面向**已拿到 Kodrix 安装包的个人开发者**：从安装走到第一条 AI 回复，再覆盖四个核心能力的日常用法。全部命令名、设置项名、快捷键均取自仓库真实声明，可在命令面板与设置界面逐一自查。

如果你是从 Cursor / Cursormini 迁移过来的，请先读 [MIGRATION.md](../MIGRATION.md)。

---

## 1. 安装

- 下载维护者发布的 Windows 安装包（`.exe`），双击安装即可。**使用安装包不需要 Node.js / npm / 源码**——那些是从源码构建时（贡献者）的要求。
- 首次安装运行时 Windows 可能弹出 SmartScreen 警告（安装包未做代码签名），确认来源后选择"仍要运行"。详见 [已知问题](./KNOWN-ISSUES.md)。
- 当前版本**没有**核心自动更新（编辑器内置的"检查更新"是禁用状态）。作为替代，Kodrix 提供发布版本提示：

	- 命令面板执行 **"Kodrix: Check for Updates"**（`kodrix.checkForUpdates`），会读取 GitHub Releases 清单；发现新版本时给出"查看发行说明 / 下载安装包"入口。
	- 启动后每 24 小时静默检查一次，可在设置里调整或关闭：`kodrix.updateCheck.enabled`、`.intervalHours`、`.feedUrl`、`.includePrerelease`。
	- 该检查只拉取发布清单，不发送设备或账号信息；维护者自建分发时把 `feedUrl` 指向自己的清单即可。
	- **下载后请用发布页的 `SHA256SUMS.txt` 校验安装包**（未签名期间这一步不要省）。

## 2. 首次启动

安装后首次打开 Kodrix，约 1.5 秒后会自动弹出 **"Welcome to Kodrix"** 向导（Webview 面板），它会：

1. 扫描本机环境（是否已装 Ollama / llama-server 等本地服务）；
2. 只读预览可从 Cursor 导入的内容（不写入任何东西，点"导入"按钮才执行）；
3. 提供快速入口：打开 Agent 聊天 / 配置模型 / 从 Cursor 导入。

向导关闭后不再自动出现。随时可通过命令面板重新打开：

- **"Kodrix: Open Welcome Wizard"**（`kodrix.onboarding.open`）
- **"Kodrix: Welcome to Kodrix"**（`kodrix.welcome`，旧版欢迎消息框，含全部功能入口）

## 3. 配置模型（BYOK：自带 API Key）

Kodrix 不绑定任何账号体系，主路径是 BYOK。统一入口：命令面板运行

> **"Kodrix: AI Provider Management"**（命令 ID `kodrix.openProviderWorkbench`）

这里内置 **13 家供应商预设**（本地 + 云端 + 自定义，见 `extensions/kodrix-local/resources/presets.json`）。流程：选预设 → 填地址/模型名/Key（云端必填，本地免 Key）→ 运行**连接测试** → 通过后设为当前供应商 → 在 Chat 的模型选择器里选 Kodrix 提供的模型。

> API Key 只保存在本机扩展的 SecretStorage 中，不会写进 `settings.json`（`providerSecrets.ts`）；也**不要**把 Key 粘贴到工单、截图或诊断文本里。

### 3.1 本地模型：Ollama

1. 安装并启动 [Ollama](https://ollama.com)，先拉取一个模型，例如 `ollama pull qwen2.5-coder:7b`。
2. 在 AI Provider Management 选择 **Ollama** 预设，默认地址 `http://127.0.0.1:11434`，无需 Key。
3. 运行连接测试。测试分两步：**最多等 10 秒读取模型列表，再对你选的模型实际发一条最小请求，最多等 60 秒**（`modelDiscovery.ts` 中 `AbortSignal.timeout(10_000)` / `60_000`）。首次加载大模型较慢属正常，超时失败就重试一次。
4. 服务已连接但列表里没有模型 → 提示会明确告诉你"先拉取模型或填写模型 ID"，而不是假报成功。

### 3.2 本地模型：llama.cpp

1. 启动 `llama-server`，它需提供 OpenAI 兼容的 `/v1/models` 与 `/v1/chat/completions`（默认端口 8080）。
2. 选择 **llama.cpp** 预设，默认地址 `http://127.0.0.1:8080/v1`，无需 Key，测试时自动探测模型列表。
3. 非默认端口或加了鉴权，就改用"自定义"OpenAI 兼容预设填准确地址。
4. Agent 是否调工具取决于模型 chat template 和服务端配置：普通聊天成功但 Agent 不调工具时，先核对这两项。

### 3.3 云端模型（以 DeepSeek 为例）

1. 到 DeepSeek 开放平台 `https://platform.deepseek.com` 注册并创建 API Key。
2. 选择 **DeepSeek** 预设（接口地址 `https://api.deepseek.com`，Anthropic 兼容路径为 `https://api.deepseek.com/anthropic`），粘贴 Key，选模型，运行连接测试。
3. 其他云端预设同理，Key 获取入口即预设中的官网地址：OpenAI `platform.openai.com`、Anthropic `console.anthropic.com`、Google Gemini `aistudio.google.com`、OpenRouter `openrouter.ai`、硅基流动 `siliconflow.cn`、智谱 `open.bigmodel.cn`、通义千问 `dashscope.aliyun.com`。
4. 连接测试通过仅代表"该模型能回一条消息"。Agent 工具调用、视觉输入等能力另说，且云端调用会产生费用、请求内容会发给该供应商。

## 4. 四个核心能力

### 4.1 Tab 补全

- 默认沿用 VS Code 体系（Copilot Inline / NES）。**本地 Tab/FIM 补全默认关闭**，需显式开启：设置项 `kodrix.tabCompletion.enabled`（默认 `false`）。
- 开启后可选模式 `kodrix.tabCompletion.mode`：`fim`（默认）或 `fast`；FIM 默认走 DeepSeek `beta/fim` 端点（`kodrix.tabCompletion.fimProvider = "deepseek"`，端点 `https://api.deepseek.com/beta/fim/completions`，时效性见 [已知问题](./KNOWN-ISSUES.md)），也可用 `custom` 填自己的端点与 `kodrix.tabCompletion.fimApiKey`。
- 效果自查：命令面板 **"Kodrix: Tab Completion: Acceptance Rate Stats"**（`kodrix.tabCompletion.stats`）查看采纳率统计。

### 4.2 Chat / Agent（含内联编辑与 Plan）

| 操作 | 快捷键 | 命令 |
|------|--------|------|
| 打开 Chat | `Ctrl+L` | `workbench.action.chat.open` |
| 打开 Chat 并直接进入 Agent 模式 | `Ctrl+I` | `workbench.action.chat.open {mode:agent}` |
| 选中代码加入 Chat | `Ctrl+Shift+L` | "Kodrix: Add Selection to Chat"（`kodrix.addSelectionToChat`） |
| 内联编辑（Cursor 风格 Ctrl+K） | `Ctrl+K` | "Kodrix: Inline Edit (Cursor Ctrl+K)"（`kodrix.openInlineEdit`） |
| Plan 模式（先规划再执行） | — | "Kodrix: Open Plan Mode"（`kodrix.openPlanMode`） |
| Composer 多文件编辑 | — | "Kodrix: Open Composer (Multi-file Agent)"（`kodrix.openComposer`） |
| Agents 窗口（多 Agent 并行） | `Ctrl+Shift+A` | "Kodrix: Open Agents Window"（`kodrix.openAgentsWindow`） |

Agent 会把修改以 diff 呈现，确认后落到工作区；可用 "Kodrix: Create Checkpoint (Rollback-capable)"（`kodrix.checkpoint.create`）先建回滚点，出问题用 `kodrix.checkpoint.restore` 回退。

### 4.3 @Codebase（代码库问答 / 语义索引）

双路径：Copilot 侧的 `#codebase` 上下文，以及 Kodrix 本地实现（聊天参与者 `@codebase`，命令前缀 `kodrix.codebase.*`）。

- 把代码库作为上下文附加到当前聊天："Kodrix: Add @Codebase Context"（`kodrix.attachCodebase`）。
- 自然语言问"X 定义在哪 / 谁引用了 Y / 架构长什么样"：**"Kodrix: Codebase Q&A …"**（`kodrix.codebase.search`，默认快捷键 `Ctrl+Shift+Alt+F`）。
- 索引管理："Kodrix: Build Codebase Semantic Index"（`kodrix.buildCodebaseIndex`）、"Rebuild Full-Project Semantic Index"（`kodrix.codebase.buildIndex`）、统计 `kodrix.codebase.stats`。开关：`kodrix.features.codebaseIndex`（自动建索引 `kodrix.codebaseIndexAutoBuild`）、`kodrix.features.codebaseIntelligence`。

### 4.4 Skill 市场

- 打开市场："Kodrix: Open Skill Market"（`kodrix.skills.openMarketplace`），侧边栏也有 **Skill Market** 视图。支持卡片安装、搜索、从 GitHub/URL 安装（`kodrix.skills.installFromUrl`）、导入 `~/.cursor/skills`（`kodrix.skills.importCursor`）。
- 每个 Skill 是一个含 `SKILL.md` 的目录，默认安装到 skills 目录（设置 `kodrix.skills.installDir`）；仓库自带示例见 `marketplace/packages` 与 `catalog.json`。
- 注意：Skill 会向 AI 注入指令，因此**在不受信任的工作区中市场功能被禁用**（扩展声明 `untrustedWorkspaces`）。

## 5. 快捷键总表（来自扩展真实声明）

以下为默认快捷键，均可在快捷键编辑器（`Ctrl+K Ctrl+S`）中搜索命令名修改。带条件者需对应设置开启。

| 快捷键（Win/Linux；Mac 用 Cmd） | 命令 | 生效条件 |
|------|------|----------|
| `Ctrl+L` | 打开 Chat | 非终端焦点 |
| `Ctrl+I` | 打开 Chat（Agent 模式） | `chat.agent.enabled` |
| `Ctrl+K` | Kodrix 内联编辑 | 编辑器可写 |
| `Ctrl+Shift+L` | 选中代码加入 Chat | 编辑器有选区 |
| `Ctrl+Shift+L`（编辑器外） | Kodrix 自然语言命令面板 | 非编辑器焦点 |
| `Ctrl+Shift+A` | 打开 Agents 窗口 | `chat.agent.enabled` |
| `Ctrl+Shift+Alt+A` | 当前工作区接入 Agents 窗口 | 同上，且有工作区 |
| `Ctrl+Shift+H` | Kodrix Hub（Agent 指挥中心） | `kodrix.hub.enableKeybinding` |
| `Ctrl+Shift+V` | Vibe Coding 一句话建项目 | `kodrix.features.vibeCoding` |
| `Ctrl+Shift+I` / `Ctrl+Shift+Alt+I` | Idea Flow 启动 / Idea 画布 | `kodrix.features.ideaFlow` |
| `Ctrl+Shift+Alt+K` | Spec 工作台 | `kodrix.features.spec` |
| `Ctrl+Shift+Alt+R` | Smart Router 自动选路 | `kodrix.features.agentRouter` |
| `Ctrl+Shift+Alt+M` | 沉淀项目知识 | `kodrix.features.learning` |
| `Ctrl+Shift+Alt+F` | Codebase 问答 | `kodrix.features.codebaseIntelligence` |
| `Ctrl+K`（终端内） | 终端 AI 生成命令 | `kodrix.features.terminalAI` |
| `Ctrl+Enter` | 执行终端 AI 提议的命令 | 同上，且有待执行提议 |

## 6. 常见问题

**Q：连接测试报 401 / 404 / 429？**
错误提示内置了对应解释（`modelDiscovery.ts`）：401 = Key 无效或未被接受；403 = 账户无权访问该模型；404 = 接口地址或模型名不存在；429 = 触发限流/用量上限；5xx = 服务商暂时不可用。先核对 Key、`/v1` 地址和模型 ID 三件事。

**Q：Ollama 测试一直转圈后超时？**
首次加载模型可能超过 60 秒（列表读取 10 秒 + 模型请求 60 秒上限）。先在终端 `ollama run <模型>` 预热，再回 Kodrix 重试。云端连接测试的模型请求超时为 15 秒。

**Q：Chat 模型下拉里找不到我的模型？**
确认供应商已"连接测试通过并设为当前供应商"；Kodrix 注册的模型以 "Kodrix: <供应商名>" 分组出现。改了配置不生效时重启窗口（`Ctrl+Shift+P` → "Reload Window"）。

**Q：扩展商店装不了某个微软官方扩展？**
Kodrix 的市场源是 Open VSX，部分仅授权微软市场的扩展不可用，见 [已知问题](./KNOWN-ISSUES.md)。

**Q：想登录 GitHub Copilot 账号？**
本 fork 对 Copilot 属于非受支持客户端，只支持设备码 / PAT 登录流程；日常使用推荐直接走上面的 BYOK 路径。

**Q：出问题怎么提供信息？**
激活失败弹窗中有 **"复制脱敏诊断信息"** 按钮，它只复制：Kodrix 版本、VS Code 内核版本、平台架构、错误类型四项，不含密钥、工作区路径、提示词或对话内容（`extension.ts:93-113`）。提工单时请附上这段内容，并**不要**粘贴 API Key、`config.json` 原文或含私码的截图。

---

## 相关资料

- [README（项目总览）](../README.md)
- [MIGRATION.md（Cursor / Cursormini 迁移）](../MIGRATION.md)
- [KNOWN-ISSUES.md（已知限制）](./KNOWN-ISSUES.md)
- [CHANGELOG.md（变更记录）](../CHANGELOG.md)
- [首次使用与发布验收](./个人开发者首次使用与发布验收.md)
- [REPAIR-NOTES.md（源码/构建环境排障，偏贡献者）](../REPAIR-NOTES.md)
