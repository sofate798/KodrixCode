# 从 Cursor / Cursormini 迁移到 Kodrix

本文描述 Kodrix **代码中已实现**的迁移能力。共两条独立路径，互不影响：

| 路径 | 来源 | 触发方式 | 实现 |
|------|------|----------|------|
| A. Cursormini / 旧版 Kodrix 配置迁移 | `~/.cursormini` 或 `~/.kodrix` | 首次启动自动执行，也可手动运行 | `extensions/kodrix-local/src/migrateConfig.ts` |
| B. Cursor 导入 | Cursor 官方编辑器（`~/.cursor` 等） | 首次启动自动执行一次，之后可手动运行 | `extensions/kodrix-local/src/cursorImport.ts` |

> 迁移完成后（无论成功与否），你可以在命令面板（`Ctrl+Shift+P`）运行 **"Kodrix: Welcome to Kodrix"** 查看结果摘要弹窗。

---

## 路径 A：Cursormini / 旧版 Kodrix（`~/.cursormini` / `~/.kodrix`）

### 如何触发

- **自动**：首次启动时后台静默迁移。可用设置 `kodrix.migrateOnFirstRun`（默认 `true`）关闭。
- **手动**：命令面板运行 **"Kodrix: Migrate Configuration (Cursormini / Kodrix)"**（命令 ID `kodrix.migrateConfig`），成功时会弹窗逐条列出迁移结果。

查找顺序：优先 `~/.kodrix/config.json`，其次 `~/.cursormini/config.json`（`migrateConfig.ts:88-92`）。也支持环境变量 `KODRIX_CONFIG_DIR` / `CURSORMINI_CONFIG_DIR` 覆盖目录，但出于安全该目录**必须位于用户主目录内**，越界值会被忽略（`migrateConfig.ts:78-93`）。

### 实际迁移哪些内容

来源为 `config.json` 与 `providers.json`（多供应商列表优先，`migrateConfig.ts:315-341`）：

| 原字段 | 迁移到 Kodrix 的落点 | 备注 |
|--------|----------------------|------|
| 供应商条目（`api_type` / `base_url` / `model` / `api_key`） | 注册为 Kodrix 模型供应商（BYOK），`active_provider_id` 对应的设为当前供应商 | Ollama / Anthropic / Gemini 走各自的注册函数；Anthropic / Gemini 带 Key 时一并保存（Key 写入扩展 SecretStorage，不进 `settings.json`，见 `providerSecrets.ts`）；OpenAI 兼容端点需能解析到模型 ID，否则报"未解析到模型 ID" |
| `model_routes`（plan / agent / code / fast 等） | 设置 `kodrix.modelRoutes`，并映射到 `chat.planAgent.defaultModel`、`github.copilot.chat.implementAgent.model`、`chat.exploreAgent.defaultModel`、`chat.utilitySmallModel` | **注意**：路由映射会直接写入这些设置项（覆盖已有值），见 `migrateConfig.ts:343-367` |
| `agent_plan_mode: "review"` | `github.copilot.chat.switchAgent.enabled = true` | 仅 `"review"` 值生效 |
| `agent_native_tools: true` | `github.copilot.chat.skillTool.enabled`、`chat.useAgentSkills` | 仅在你从未设置过这两个键时才写入（`applyIfUnset`） |
| `agent_auto_rag: true` | `chat.repoInfo.enabled`、`kodrix.features.codebaseIndex` | 同上，仅未设置时写入 |
| `agent_context_chars` | **不迁移**（无对应设置项，代码明确忽略） | `migrateConfig.ts:400` |
| `mcp_servers`（数组） | 合并写入 Kodrix 的用户级 `mcp.json` | 合并语义：保留原有 server，同名条目由迁移方覆盖；匿名/重名条目自动编号，不丢条目 |
| `plugins/` 下含 `SKILL.md` 的目录 | 复制到 `~/.agents/skills/`，并把该目录加入 `chat.agentSkillsLocations` | 目标已存在同名目录则**跳过**，不覆盖 |

自动迁移（仅首次启动那次）还会为一批 Agent/Skill 相关设置补齐默认值（`sessions.chat.localAgent.enabled`、`chat.agent.maxRequests` 等 12 项），同样只写你从未设置过的键（`migrateConfig.ts:419-443`）。

### 迁移失败会怎样

- **原配置不会被破坏**：整个迁移对 `~/.kodrix` / `~/.cursormini` **只读不写、只复制不删除**，随时可以回到旧工具继续使用。
- 单条供应商注册失败（如 BYOK 待完成、注册失败、缺少 API 地址）不会中断其余迁移，结果弹窗会逐条标注原因。
- 设置项写入失败时记录日志并跳过该键，不阻断流程（`safeConfigUpdate.ts`）。
- 整体异常时最多在后续 3 次启动时自动重试（`extension.ts:30` `MAX_MIGRATE_ATTEMPTS = 3`）；重试仍失败则不再自动尝试，可手动运行迁移命令。

---

## 路径 B：Cursor 官方编辑器（`~/.cursor`）

### 如何触发

- **自动**：首次启动检测到 Cursor 配置时导入一次；可用设置 `kodrix.importCursorOnFirstRun`（默认 `true`）关闭。即使自动导入失败也会标记为已处理，但**任何时候都可手动重跑**。
- **手动**：命令面板运行 **"Kodrix: Import from Cursor (Rules / MCP / Skills)"**（命令 ID `kodrix.importCursor`）。
- 首启向导（"Kodrix: Open Welcome Wizard"）中的"导入"步骤是**只读扫描**，不会写任何东西；点"导入"按钮才执行（`onboarding.ts`、`cursorImport.ts:284`）。

### 实际导入哪些内容

| 来源 | 去向 |
|------|------|
| `~/.cursor/mcp.json` 的 MCP 服务器 | 合并进 Kodrix 用户级 `mcp.json`（同名条目由 Cursor 侧覆盖） |
| 工作区内 `.cursorrules` | 复制为 `.github/copilot-instructions.md`（目标已存在则跳过，不覆盖） |
| `~/.cursor/rules/` 下 `.md` / `.mdc` / `.instructions.md` 文件 | 复制为 `~/.kodrix/instructions/*.instructions.md`（已存在则跳过） |
| Cursor `state.vscdb`（SQLite）中的 User Rules | 导出为 `~/.kodrix/instructions/cursor-user-rules.instructions.md` |
| `~/.cursor/skills/` 下含 `SKILL.md` 的目录 | 复制到 `~/.agents/skills/`（已存在则跳过，保留你本地版本） |
| Rules / Skills 目录本身 | 注册进 `chat.instructionsFilesLocations` 与 `chat.agentSkillsLocations` |
| Cursor `settings.json` 中 `cursor.cpp.enablePartialAccepts`、`cursor.chat.showSuggestedFiles` | 分别映射到 `editor.inlineSuggest.enabled`、`chat.repoInfo.enabled`（仅当该项从未设置时） |

**不迁移**：Cursor 的模型供应商 API Key、对话历史、快捷键等不在导入范围内；模型配置请按 [上手指南](docs/AI个人开发者上手与使用说明.md) 在"Kodrix: AI Provider Management"中重新填写。

### 失败行为

Cursor 导入整体失败（例如 Cursor 数据库损坏）只会记日志并跳过，不阻断 Kodrix 启动（`cursorImport.ts:373-379`）；所有复制/合并操作同样对 `~/.cursor` **只读**，不会修改或删除 Cursor 的任何文件。

---

## 迁移后自检清单

1. 运行 **"Kodrix: AI Provider Management"**，确认供应商列表、模型名与预期一致。
2. 对每个供应商执行"连接测试"（见上手指南），验证真实可对话，而不只是"配置存在"。
3. 打开设置搜索 `kodrix.modelRoutes`，确认路由映射正确。
4. 在聊天里输入 `@` 或 `/`，确认 Rules（`.instructions.md`）与 Skills 已被识别。
5. 若从 Cursor 导入过 MCP：在 MCP 配置界面确认服务器列表，注意检查同名服务器是否被覆盖。
