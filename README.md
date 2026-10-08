<div align="center">
  <br />
  <img src="./icons/stable/codium_cnl.svg" alt="Kodrix Logo" width="160"/>
  <h1>Kodrix Code</h1>
  <h3>基于 VS Code / VSCodium 的 AI 原生代码编辑器</h3>
</div>

**Kodrix** 是在 VS Code / VSCodium 之上的深度定制分支，集成多 Agent 协作、智能补全、Idea Flow 等能力，面向本地可构建、可调试的完整源码工程。

当前基线：VS Code **1.128.0** · Electron **42.x** · Node **24.17+**（同 major 且 ≥ [`.nvmrc`](.nvmrc)）· 协议 **MIT**

## 我是使用者：安装与上手

> 用已发布的安装包即可开始，**不需要** Node.js / npm / 源码。

1. **下载**：获取维护者发布的 Windows 安装包并安装（首次运行如遇 SmartScreen 警告，见 [已知问题](docs/KNOWN-ISSUES.md)；当前尚无自动更新通道）。
2. **首次启动**：跟随自动弹出的 "Welcome to Kodrix" 向导；随时可用命令面板 "Kodrix: Open Welcome Wizard" 重新打开。
3. **配置模型（BYOK，自带 API Key）**：命令面板运行 **"Kodrix: AI Provider Management"**，从 13 家供应商预设中选择（本地 Ollama / llama.cpp 免 Key，云端填 Key），运行连接测试后激活。
4. **开始使用**：`Ctrl+L` Chat · `Ctrl+I` Agent · `Ctrl+K` 内联编辑 · `@Codebase` 代码库问答 · Skill 市场。

- 完整图文上手（含 Ollama / llama.cpp / 云端配置示例、快捷键表、FAQ）：[**docs/AI个人开发者上手与使用说明.md**](docs/AI个人开发者上手与使用说明.md)
- 从 Cursor / Cursormini 迁过来：[**MIGRATION.md**](MIGRATION.md)
- 已知限制与隐私说明：[**docs/KNOWN-ISSUES.md**](docs/KNOWN-ISSUES.md)（遥测默认关闭、无崩溃上报端点）
- 版本变更：[**CHANGELOG.md**](CHANGELOG.md)

## 我是贡献者：从源码构建

### 环境要求

- **Node.js**：须匹配 [`.nvmrc`](.nvmrc)（`24.17.0`，同 major 且 ≥ 该版本，npm &lt; 12）
- **Windows**：推荐 PowerShell；打安装包需本机构建工具链
- 首次依赖安装与 Copilot 扩展打包可能较久，属正常现象
- Cursor 沙箱 PATH 若指向 Node 22，装依赖请用系统合规 Node 24

### 开发入口（根目录）

```batch
# 带实时日志的控制台调试启动（esbuild 快编译）
.\debug.bat

# 热更新：改 src/ 后自动增量重编译
.\debug.bat -Watch

# 一键全量重编译 + 带日志启动（恢复环境 / 排障）
.\debug-rebuild.bat

# 一键重新编译打包 EXE 安装包（首次约 30–90 分钟）
.\build.bat
```

等价 npm 脚本示例：

```bash
npm run dev:prepare          # 准备开发产物（不启动）
npm run package:win32        # 打 Windows EXE
npm run compile              # 编译客户端 + Copilot
```

## 功能概览

| 能力 | 说明 |
|------|------|
| Tab 补全 / Ctrl+K | Copilot Inline + NES；可选本地 Tab/FIM（默认关） |
| Composer / Agent | 多文件编辑与 Agent 协作（编排至 Copilot） |
| @Codebase | 双路径：Copilot `#codebase` · 本地 `kodrix.codebase` |
| 模型路由 | 多供应商预设（13）与 BYOK |
| Idea Flow / Agent OS | Spec、看板、记忆、Crew 等本地 Agent 能力 |
| Skill 市场 | 目录 / GitHub / URL；仓库内 `marketplace/packages` |
| 中文界面 | 官方 zh-cn 语言包注入 |

自定义扩展：`kodrix-local` · `kodrix-agent-os` · `kodrix-skills`（另含内置 Copilot 等）。从 Cursor / Cursormini 迁过来见 [`MIGRATION.md`](MIGRATION.md)。

## 项目结构

```
kodrix/
├── src/                 # 核心源码 (TypeScript / VS Code 框架)
├── extensions/          # 内置扩展（含 kodrix-*、copilot、git 等）
├── marketplace/         # Skill 示例包与 catalog
├── build/               # gulp + esbuild 构建系统
├── scripts/             # 开发 / 打包 / 修复脚本
├── patches/             # VSCodium 上游补丁
├── test/                # unit / smoke / mcp
├── docs/                # 文档（用户指南 + 内部质量记录）
├── out/                 # 编译输出 (dev)
└── .build/              # 构建缓存（electron / 扩展等）
```

更细的目录说明见 [`AGENTS.md`](AGENTS.md)。

## 关键配置

| 文件 | 说明 |
|------|------|
| `product.json` | 产品品牌与运行时配置 |
| `.nvmrc` | Node.js 版本要求 |
| `.npmrc` | npm + Electron 构建配置 |
| `package.json` | 脚本与依赖 |
| `.vscode/launch.json` | 调试启动配置 |

## 构建注意

1. **Copilot 扩展首次 esbuild 打包**约需 10–30 分钟（多路并行），不是卡死。
2. **`preinstall.ts`** 严格校验 Node：同 major 且 ≥ `.nvmrc`；npm &lt; 12。
3. **Electron** 经 `@vscode/gulp-electron` 下载到 `.build/electron/`。
4. **`dev-fast.ps1`** 设 `VSCODE_SKIP_PRELAUNCH` 加快启动；客户端过期时走 `build-fast`（`Test-ClientOutFresh`）。

常见启动 / native 模块 / 中文语言包问题见 [`REPAIR-NOTES.md`](REPAIR-NOTES.md)。

## 相关文档

### 面向使用者

| 文档 | 用途 |
|------|------|
| [`docs/AI个人开发者上手与使用说明.md`](docs/AI个人开发者上手与使用说明.md) | 安装 → 配置模型 → 核心能力 → 快捷键 → FAQ |
| [`MIGRATION.md`](MIGRATION.md) | Cursor / Cursormini 迁移 |
| [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md) | 已知限制 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录 |
| [`docs/个人开发者首次使用与发布验收.md`](docs/个人开发者首次使用与发布验收.md) | 首次使用路径与发布验收 |
| [`SECURITY.md`](SECURITY.md) | 漏洞报告与安全实践 |

### 内部质量记录（面向维护者，非用户文档）

以下 `docs/` 条目为内部审计/对标记录，含大量未完成项与内部口径，**不代表对用户的功能承诺**，外部读者请以上面的使用者文档为准：

| 文档 | 性质 |
|------|------|
| [`docs/kodrix体检与Cursor对标差距文档.html`](docs/kodrix体检与Cursor对标差距文档.html) | 体检与对标差距 |
| [`docs/项目总共已更新修复完善的全部内容.md`](docs/项目总共已更新修复完善的全部内容.md) | 已更新/修复/完善记录（含日期） |
| [`docs/项目新发现待修复的缺陷问题审计总报告.md`](docs/项目新发现待修复的缺陷问题审计总报告.md) | 待修复缺陷审计 |
| [`docs/项目非常有必要新实现的核心功能总报告.md`](docs/项目非常有必要新实现的核心功能总报告.md) | 拟实现核心功能规划 |

## 上游与许可

- 基于 [Microsoft vscode](https://github.com/microsoft/vscode) 与 [VSCodium](https://github.com/VSCodium/vscodium) 构建体系与补丁实践。
- 本仓库产品二进制与源码许可为 **[MIT](LICENSE.txt)**（以仓库内 LICENSE 文件为准）。
- 部分上游扩展或市场条款可能限制其仅用于官方 Visual Studio Code；Kodrix 侧扩展市场策略与 VSCodium 类似，以本地 / Open VSX 等配置为准。
