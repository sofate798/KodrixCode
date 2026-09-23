# Kodrix — 迁移指南

从 **Cursormini**（`~/.cursormini` / `~/.kodrix`）与 **Cursor**（`~/.cursor`）迁到 **Kodrix Code**。

Kodrix = VS Code / Electron 源码树 + `extensions/kodrix-*`，不再使用 Python + pywebview。

| 项 | 值 |
|----|-----|
| 基线 | VS Code **1.128.0** · Electron **42.x** · Node 见 `.nvmrc`（`24.17.0`） |
| 产品数据目录 | `product.json` → `.kodrix` |
| 迁移配置目录 | `~/.kodrix`（或遗留 `~/.cursormini`）；可设 `KODRIX_CONFIG_DIR` / `CURSORMINI_CONFIG_DIR`（须落在用户主目录内） |

日常开发与排障：`AGENTS.md`、`REPAIR-NOTES.md`、`README.md`。

## 扩展分工

| 扩展 | 职责 |
|------|------|
| `kodrix-local` | 模型供应商 / BYOK、Cursormini 配置迁移、Cursor 导入、快捷键与 Cursor 对标默认（多数能力编排到 Copilot） |
| `kodrix-skills` | Skill 市场（侧栏 + URL / GitHub / 导入 `~/.cursor/skills`） |
| `kodrix-agent-os` | Idea Flow、Spec、Wiki、Crew、Router、Learning、Hub、本地 `@codebase` / 可选 Tab FIM 等 |
| Copilot（内置） | Chat / Agent / NES / `#codebase` / Background & Cloud Agent 会话类型 |

## 已迁移能力（Cursormini → Kodrix）

| 能力 | 落点 | 说明 |
|------|------|------|
| 本地模型（Ollama / llama.cpp / LM Studio） | `kodrix-local` | Copilot BYOK（Ollama / Custom Endpoint） |
| 云端 API（DeepSeek / OpenAI / Anthropic / Gemini / 智谱 / 通义等） | `kodrix-local` | 预设 + Custom Endpoint / 原生供应商 |
| 多模型路由 `model_routes` | `kodrix.modelRoutes` + Copilot 模型键 | 见下方对照表 |
| MCP 服务器 | `%APPDATA%/Kodrix/User/mcp.json`（dev：`code-oss-dev`） | 合并已有 `servers` |
| Skill | `kodrix-skills` → `~/.agents/skills/` | 市场 / URL / GitHub / Cursor skills 导入 |
| Agent / Plan | Copilot | Ask / Edit / Agent、`/plan`、工具与 Skill |
| Agents 窗口 | VS Code Sessions + `kodrix-local` 封装 | 多 Agent 并行、Local / CLI / Cloud |
| 首次启动 | 欢迎向导 | `kodrix.migrateOnFirstRun` / `kodrix.importCursorOnFirstRun`（默认开） |

## Cursor 对标（`kodrix-local` + Copilot）

多数「Cursor 同款」是 **命令 / 键位 / 默认配置编排到 Copilot**，不是在 `kodrix-local` 内重写一套。

| Cursor | Kodrix | 命令 / 配置 |
|--------|--------|-------------|
| Tab 补全 + NES | **默认**：Copilot Inline + NES | `kodrix.features.tabCompletion` |
| （可选）本地 Tab/FIM | `kodrix-agent-os`，**默认关** | `kodrix.tabCompletion.enabled`（避免与 Copilot 冲突） |
| Ctrl+K 行内编辑 | Inline Chat | `Kodrix: 行内编辑（Cursor Ctrl+K）` · `Ctrl+K` |
| Ctrl+L / Ctrl+I | 打开 Chat / Agent | `Ctrl+L` · `Ctrl+I`（`mode: agent`） |
| Composer | Agent + 检查点 + Diff + 会话侧栏 | `Kodrix: 打开 Composer（多文件 Agent）` · `kodrix.features.composerUI` |
| Background Agent | Copilot CLI 会话 | `Kodrix: 在 Background Agent 中继续` |
| Cloud Agent | Copilot Coding Agent | `Kodrix: 在 Cloud Agent 中继续` |
| @Codebase | **双路径**（见下） | |
| User Rules | instructions + SQLite | `Kodrix: 从 Cursor 导入（Rules / MCP / Skills）` |
| Agents 窗口 | Sessions + `kodrix-local` | `Ctrl+Shift+A` · `kodrix.features.agentsWindow` |
| Cursor 3.0 布局 | 默认配置编排 | `Kodrix: 应用 Cursor 3.0 Agent 中心体验` |

### @Codebase 双路径

| 路径 | 入口 | 说明 |
|------|------|------|
| Copilot `#codebase` / workspace index | `Kodrix: 添加 @Codebase 上下文` · `构建代码库语义索引` | 走 Copilot；通常需 GitHub 登录 |
| 本地 `kodrix.codebase` | 聊天参与者 `@kodrix.codebase`（`/def` `/refs` 等）· `kodrix.codebase.buildIndex` | `kodrix-agent-os` 本地索引，不依赖 GitHub |

一键套用对标默认：`Kodrix: 应用 Cursor 对标功能默认配置`。

相关开关（`kodrix.features.*`，均默认 `true`）：`tabCompletion`、`backgroundAgents`、`cloudAgents`、`composerUI`、`codebaseIndex`、`codebaseIndexAutoBuild`、`agentsWindow`、`agentFirstLayout`、`agentHostPriority`、`handoffTip`。

## 首次启动与手动迁移

1. `.\debug.bat`（或打包版）启动 Kodrix  
2. 欢迎向导会尝试：
   - 从 `~/.kodrix/` 或 `~/.cursormini/` 迁模型 / 路由 / MCP / Agent 开关  
   - 从 `~/.cursor` 导入 Rules / MCP / Skills / SQLite User Rules  
3. 手动命令：
   - `Kodrix: 迁移配置（Cursormini / Kodrix）`
   - `Kodrix: 从 Cursor 导入（Rules / MCP / Skills）`
   - `Kodrix: 打开欢迎向导`

注意：

- API Key 在 Copilot 就绪后写入 BYOK。  
- **Agent 相关默认开关仅在首次自动迁移时写入**（`applyAgentDefaults: true`）；手动「迁移配置」不会重写这批开关。

### Cursormini 配置对照

| 遗留（`~/.cursormini/` 或 `~/.kodrix/`） | Kodrix |
|-----------------------------------------|--------|
| `providers.json` + `config.json` | BYOK Ollama / Custom Endpoint（全部供应商，不仅 active） |
| `model_routes.plan` | `chat.planAgent.defaultModel` + `kodrix.modelRoutes` |
| `model_routes.agent` | `github.copilot.chat.implementAgent.model` |
| `model_routes.code` | `chat.exploreAgent.defaultModel` |
| `model_routes.fast` | `chat.utilitySmallModel` |
| `mcp_servers` | `User/mcp.json` → `servers` |
| `agent_plan_mode: review` | `github.copilot.chat.switchAgent.enabled` |
| `plugins/` | **未自动迁移**；请手动拷到 `~/.agents/skills/<name>/SKILL.md` |

### Cursor 导入映射

| Cursor | Kodrix |
|--------|--------|
| `~/.cursor/mcp.json` | `User/mcp.json`（合并） |
| `~/.cursor/skills/` | `~/.agents/skills/` |
| `.cursor/rules`、`~/.cursor/rules` | `chat.instructionsFilesLocations`；副本可落 `~/.kodrix/instructions/` |
| 工作区 `.cursorrules` | `.github/copilot-instructions.md` |
| `state.vscdb`（含 `aicontext.personalContext` 等） | `~/.kodrix/instructions/cursor-user-rules.instructions.md` |
| 部分 `settings.json` 提示项 | 如 inlineSuggest / chat.repoInfo 等（见 `cursorImport.ts`） |

## 模型供应商

预设共 **13** 个（`extensions/kodrix-local/resources/presets.json`）：

- **本地（4）**：llama.cpp、Ollama、LM Studio、自定义本地  
- **云端（9）**：DeepSeek、OpenAI、Anthropic、Gemini、OpenRouter、硅基流动、智谱、通义、自定义  

命令：

- `Kodrix: 浏览模型供应商预设` / `AI 供应商管理` / `应用模型预设`  
- 应用后会同步 Copilot 默认模型与空的 `kodrix.modelRoutes` 项  
- Chat → Manage Models → 选 Ollama、Custom Endpoint 或原生供应商  

## Skill 市场（`kodrix-skills`）

- 侧栏 **Skill 市场**  
- `Kodrix: 从 URL 安装 Skill` · `搜索 GitHub Skills` · `导入 ~/.cursor/skills`  
- 仓库内示例包：`marketplace/packages/`（`catalog.json`）

## Agent OS（`kodrix-agent-os`，超出 Cursor 基线）

| 能力 | 示例命令 |
|------|----------|
| Idea Canvas / Vibe | `打开 Idea Canvas（想法→产品）` · `Vibe Coding — 一句话生成项目` |
| Spec 工作台 | `新建 Spec（需求→设计→任务）` · Spec 三栏工作台相关命令 |
| Repo Wiki / Memory | `生成 Repo Wiki` · `查看项目 Memory` |
| Crew / Hub / Router | `创建 Agent Crew（多智能体编排）` · `打开 Kodrix Hub（Agent 指挥中心）` · `智能路由（自动选 Spec/Plan/Agent/Ask）` |
| Learning | `Learning 学习仪表盘` · Session Learning Hook 相关命令 |
| 本地 @codebase | 聊天参与者 `kodrix.codebase`（`/def` `/refs` 等） |
| 其它（按需） | Kanban、Arena、ACP、Checkpoint、Terminal AI、Subagent 等（命令面板搜 `Kodrix`） |

## 快捷键（Kodrix 默认）

| 键 | 作用 |
|----|------|
| `Ctrl+L` | 打开 Chat |
| `Ctrl+I` | 打开 Agent 模式 Chat |
| `Ctrl+K` | 行内编辑 |
| `Ctrl+Shift+L` | 选区加入聊天 |
| `Ctrl+Shift+A` | 打开 Agents 窗口 |
| `Ctrl+Shift+Alt+A` | 在 Agents 窗口打开当前工作区 |

## 开发构建（摘要）

```batch
.\debug.bat              rem 日常：esbuild + 启动
.\debug.bat -Watch       rem 改 src 热更新
.\debug-rebuild.bat      rem 全量编译后启动
.\build.bat              rem Windows 安装包
```

仅编 Kodrix 扩展：

```bash
npx gulp compile-extension:kodrix-local
npx gulp compile-extension:kodrix-skills
npx gulp compile-extension:kodrix-agent-os
```

Node 需匹配 `.nvmrc`（同 major 且 ≥ `24.17.0`，npm &lt; 12）。Windows 缺 VS Build Tools / native 模块时见 `REPAIR-NOTES.md`。

## 按设计未自研迁移

由 VS Code / Copilot 承担，或已用对等能力替代：

- CodeGeeX Tab → Copilot 补全 + NES（可选再开 `kodrix.tabCompletion`）  
- 自研 Keep/Undo 审查条 → Copilot Diff + 检查点  
- pywebview 桌面壳 → Electron  

原 `Cursormini/app/` 已移除；能力在 `marketplace/packages/` 与 `extensions/kodrix-*`。
