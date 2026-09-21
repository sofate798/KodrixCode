# Minicode — Cursormini 迁移指南

**Minicode** 是基于 VS Code 的本地 AI 编程 IDE，整合了原 Cursormini 核心能力，替代 Python + pywebview 架构。

## 已迁移能力

| 能力 | 扩展 | 说明 |
|------|------|------|
| 本地大模型（Ollama / llama.cpp / LM Studio） | `minicode-local` | Copilot BYOK Custom Endpoint + Ollama 端点 |
| 云端 API（DeepSeek / Anthropic / Gemini / 智谱 / 通义等） | `minicode-local` | Copilot BYOK Custom Endpoint / 原生供应商 |
| 多模型路由 `model_routes` | `minicode-local` | `minicode.modelRoutes` + Plan/Implement 模型设置 |
| MCP 服务器 | `minicode-local` | 迁移到用户配置 `User/mcp.json`（合并已有 servers） |
| Skill 技能市场 | `minicode-skills` | 侧边栏「Skill 市场」+ GitHub/URL 安装 |
| TRAE SOLO 模式 | `minicode-solo` | Chat 参与者 `@solo`：规划 → 确认 → **Agent 模式构建** |
| Agent 模式 | Copilot 内置 | Plan Agent、`/plan`、Explore 子代理、MCP、Skill 工具 |
| **Agents 窗口** | VS Code Sessions 工作台 | 多 Agent 并行会话、`minicode-local` 默认启用 Local Agent |
| 首次启动引导 | `minicode-local` | 欢迎向导 + 自动配置迁移 |

## Cursor 对标能力（`minicode-local`）

| Cursor 能力 | Minicode 实现 | 命令 / 配置 |
|-------------|---------------|-------------|
| Cursor Tab 补全 | Copilot Inline + **NES** | `minicode.features.tabCompletion` |
| Background Agent | Copilot CLI (`copilotcli`) | `Minicode: 在 Background Agent 中继续` |
| Cloud Agent | Copilot Coding Agent | `Minicode: 在 Cloud Agent 中继续` |
| Composer 多文件 UI | Agent + 检查点 + Diff 审阅 + 会话侧栏 | `Minicode: 打开 Composer` · `minicode.features.composerUI` |
| User Rules | `.cursor/rules` + `.cursorrules` + **SQLite** `state.vscdb` | `Minicode: 从 Cursor 导入` → `~/.minicode/instructions/` |
| @Codebase 向量索引 | Copilot semantic workspace index | `#codebase` · `Minicode: 构建代码库语义索引` |
| **Agents 窗口** | VS Code `vs/sessions` 工作台 | `Ctrl+Shift+A` · 紫色药丸 · `minicode.features.agentsWindow` |
| **Cursor 3.0 Agent 中心** | 全套默认 + 布局编排 | `Minicode: 应用 Cursor 3.0 Agent 中心体验` |
| **并行会话 / Handoff** | 会话侧栏 + 输入框提示 | `agentFirstLayout` · `handoffTip` · `agentHostPriority` |

从 Cursor 导入时会合并：

- `~/.cursor/mcp.json` → Minicode `User/mcp.json`
- `~/.cursor/skills/` → `~/.agents/skills/`
- `.cursor/rules` / `~/.cursor/rules` → `chat.instructionsFilesLocations`
- `state.vscdb` 键 `aicontext.personalContext` → `cursor-user-rules.instructions.md`

## 首次启动

1. 构建并启动 Minicode（见下方「开发构建」）
2. 首次启动会显示欢迎向导，并自动从 `~/.cursormini/`、`~/.minicode/` 或 **Cursor**（`~/.cursor`）迁移配置（API Key 会等待 Copilot 就绪后写入 BYOK；Agent 默认开关仅首次自动迁移时应用）
3. 也可手动执行：**Minicode: 迁移配置** 或 **Minicode: 从 Cursor 导入**

### 配置对照

| 遗留配置 (`~/.cursormini/` 或 `~/.minicode/`) | Minicode (VS Code) |
|-----------------------------------------------|-------------------|
| `providers.json` + `config.json` | BYOK Ollama / Custom Endpoint |
| `model_routes.plan` | `chat.planAgent.defaultModel` |
| `model_routes.agent` | `github.copilot.chat.implementAgent.model` |
| `model_routes.code` | `chat.exploreAgent.defaultModel` |
| `model_routes.fast` | `chat.utilitySmallModel` |
| `mcp_servers` | `%APPDATA%/Minicode/User/mcp.json`（`servers` 字段） |
| `agent_plan_mode: review` | `github.copilot.chat.switchAgent.enabled` |
| `plugins/` | `~/.agents/skills/<name>/SKILL.md` |

## 使用说明

### 模型供应商

- 命令面板：`Minicode: 浏览模型供应商预设` 或 `Minicode: AI 供应商管理`
- 应用预设后会自动同步 Copilot 默认模型与 `minicode.modelRoutes`（空路由项）
- 「设为当前」会重新注册 BYOK 并同步默认模型
- `providers.json` 中**全部供应商**都会迁移（不仅 active）
- Copilot 聊天面板：Manage Models → 选择 Ollama、Custom Endpoint 或原生供应商

### Skill 市场

- 资源管理器 → **Skill 市场**
- 命令：`Minicode: 从 URL 安装 Skill`、`Minicode: 导入 ~/.cursor/skills`

### SOLO Builder

- 命令：`Minicode: 启动 SOLO Builder`
- 或在聊天中：`@solo 用 React 做一个待办应用`
- 子命令：`@solo /plan`（仅规划）、`@solo /build`（切换 Agent 模式构建）、`@solo /templates`（模板列表）

构建阶段不会在当前 `@solo` 对话里直接写文件，而是打开 **Copilot Agent** 并注入构建提示词，由 Agent 调用编辑/终端工具完成。

### Agent 模式

- **Ask**：聊天面板 Ask 模式
- **Edit**：Inline Chat / 编辑模式
- **Agent**：Agent 模式 + 工具调用
- **Plan 审阅**：`/plan` 或 Plan Agent，确认后再执行
- **Skills**：对话中 `@skill` 或自动匹配 `SKILL.md`

## Windows 构建环境（必读）

在 Windows 上 `npm install` 失败时，日志里若出现 **`gyp ERR! find VS`** 或 **`@vscode/windows-mutex` node-gyp rebuild**，说明缺少 **C++ 原生模块编译环境**。`npm warn deprecated` 和 `.npmrc` 的 `Unknown project config` **可忽略**。

### 1. 安装 Visual Studio Build Tools（必须）

任选一种方式：

**方式 A — Visual Studio Installer（推荐）**

1. 下载 [Visual Studio Build Tools 2026](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. 勾选工作负载：**使用 C++ 的桌面开发**（Desktop development with C++）
3. 右侧确保包含 **MSVC**、**Windows SDK**、**C++ CMake tools**
4. 安装完成后 **重启电脑**

**方式 B — winget（管理员 PowerShell）**

```powershell
winget install Microsoft.VisualStudio.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

安装后验证（推荐一键脚本）：

```powershell
.\scripts\verify-windows-build-env.ps1
```

或手动用 vswhere（**`-property` 每次只能查一个字段**，不能用逗号拼接）：

```powershell
# 名称
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName
# 路径
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
# 一次看全部（JSON）
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json
```

应输出类似 `Visual Studio Build Tools 2026` 或 `Visual Studio Community 2026`。

**VS 2026 安装在 D: 等非默认盘符时**，安装依赖前先设置环境变量：

```powershell
.\scripts\verify-windows-build-env.ps1 -SetEnv   # 自动写入当前会话
# 或手动（路径以 vswhere 输出为准）：
$env:vs2026_install = "D:\Program Files\Microsoft Visual Studio\18\Community"
```

若你安装的是较旧版本，同样支持 Visual Studio 2022 / 2019（`npm install` 会通过 vswhere 或 `%ProgramFiles%\Microsoft Visual Studio\{2026|18|2022|17|2019|16}` 检测）。

### 2. Node.js 版本

项目 `.nvmrc` 为 **24.17.0**。你当前的 24.14.1 通常可用；若仍异常可安装 [Node 24.17.0](https://nodejs.org/) 或使用 nvm-windows。

另需 **Python 3.x**（node-gyp 用，你已有 3.13 即可）。

### 3. 清理被占用的 node_modules（EBUSY）

若出现 `EBUSY: resource busy or locked`：

1. 关闭所有打开本仓库的程序（含 Cursor、其他终端、正在运行的 Code/Electron）
2. 在新 PowerShell 中执行：

```powershell
cd D:\minicode
# 若仍删不掉，可先结束 node 进程
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Force package-lock.json -ErrorAction SilentlyContinue
npm install
```

### 4. 完整构建流程

```powershell
cd D:\minicode
npm install          # 首次约 10–30 分钟，需联网
npm run compile      # 完整编译（较慢）
.\scripts\code.bat   # 启动 Minicode 开发版
```

### 4b. 免编译快速调试（推荐日常开发）

首次或 `out/` 不存在时自动走 **esbuild 快速构建**（`build-fast`，比 `compile` 快很多）：

```powershell
.\debug.bat              # 快速准备 + 启动（跳过已禁用的内置扩展下载）
.\watch-dev.bat          # 后台 watch-transpile + 启动（改 src 自动增量编译）
.\compile-ext.bat        # 仅重编译四个 minicode-* 扩展
.\debug.bat -FullCompile # 强制完整 compile（排障用）
```

### 4c. 一键打包 Windows 安装程序 (.exe)

```powershell
.\build.bat                        # 自动检测 x64/arm64，生成用户版安装包
.\build.bat -Target system         # 系统级安装包
npm run package:win32              # 同上（npm 入口）
```

产物路径：

- 便携目录：`..\VSCode-win32-x64\`（仓库同级）
- 安装包：`dist\Minicode-<version>-x64-UserSetup.exe`

### 5. 无本地编译环境的替代方案

若暂时不想装 VS Build Tools，可用 **Dev Container**（需 Docker Desktop，8GB+ 内存）：

- 在 VS Code 中：**Dev Containers: Clone Repository in Container Volume**
- 见 `.devcontainer/README.md`

## 开发构建

```bash
npm install
npm run compile
# 或仅编译 Minicode 扩展：
npx gulp compile-extension:minicode-local
npx gulp compile-extension:minicode-skills
npx gulp compile-extension:minicode-solo
```

启动开发版：

```bash
# Windows — 快速调试（推荐）
.\debug.bat
# 或增量 watch + 启动
.\watch-dev.bat
# 完整预检启动
.\scripts\code.bat
# macOS / Linux
./scripts/code.sh
```

打包 Windows 安装程序：

```bash
.\build.bat
# 或
npm run package:win32
```

## 扩展目录

```
extensions/
├── minicode-local/    # 模型供应商 + 配置迁移 + 欢迎向导
├── minicode-skills/   # Skill 市场
└── minicode-solo/     # SOLO Builder
```

## 按设计未迁移

以下能力由 VS Code / Copilot 原生提供，或暂不纳入 Minicode 自研实现：

- CodeGeeX Tab 补全（可用 Copilot 补全 + NES 替代）
- 自研审查条 Keep/Undo（可用 Copilot diff 审阅 + 检查点替代）
- pywebview 桌面壳（已由 Electron 替代）

以下能力已通过 Copilot 对标启用（见 `minicode.features.*`）：

- **@Codebase** 向量索引 → Copilot `#codebase` + workspace semantic index
- **Background / Cloud Agent** → Copilot CLI / Copilot Coding Agent
- **Composer 多文件 UI** → Agent 模式 + 检查点 + Diff 审阅

原 `Cursormini/app/` 已在 Phase 5 移除；仓库为 VS Code 源码树 + `marketplace/packages/` + `extensions/minicode-*`。

