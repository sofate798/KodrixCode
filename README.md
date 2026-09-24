<div align="center">
  <br />
  <img src="./icons/stable/codium_cnl.svg" alt="Kodrix Logo" width="160"/>
  <h1>Kodrix Code</h1>
  <h3>基于 VS Code / VSCodium 的 AI 原生代码编辑器</h3>
</div>

**Kodrix** 是在 VS Code / VSCodium 之上的深度定制分支，集成多 Agent 协作、智能补全、Idea Flow 等能力，面向本地可构建、可调试的完整源码工程。

当前基线：VS Code **1.128.0** · Electron **42.x** · Node **24.17+**（同 major 且 ≥ [`.nvmrc`](.nvmrc)）· 协议 **MIT**

## 目录

- [功能概览](#功能概览)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [关键配置](#关键配置)
- [构建注意](#构建注意)
- [相关文档](#相关文档)
- [上游与许可](#上游与许可)

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

## 快速开始

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
├── docs/                # 文档与体检 / 审计报告
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

| 文档 | 用途 |
|------|------|
| [`AGENTS.md`](AGENTS.md) | AI / 开发者项目导读 |
| [`REPAIR-NOTES.md`](REPAIR-NOTES.md) | 启动卡死、native 模块、语言包等排障 |
| [`SECURITY.md`](SECURITY.md) | 漏洞报告与安全实践 |
| [`docs/项目总共已更新修复完善的全部内容.md`](docs/项目总共已更新修复完善的全部内容.md) | 已更新/修复/完善（含日期） |
| [`docs/项目新发现待修复的缺陷问题审计总报告.md`](docs/项目新发现待修复的缺陷问题审计总报告.md) | 待修复缺陷总报告 |
| [`docs/项目非常有必要新实现的核心功能总报告.md`](docs/项目非常有必要新实现的核心功能总报告.md) | 必做核心新功能 |

## 上游与许可

- 基于 [Microsoft vscode](https://github.com/microsoft/vscode) 与 [VSCodium](https://github.com/VSCodium/vscodium) 构建体系与补丁实践。
- 本仓库产品二进制与源码许可为 **[MIT](LICENSE.txt)**（以仓库内 LICENSE 文件为准）。
- 部分上游扩展或市场条款可能限制其仅用于官方 Visual Studio Code；Kodrix 侧扩展市场策略与 VSCodium 类似，以本地 / Open VSX 等配置为准。
