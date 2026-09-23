# Kodrix — AI Coding Agent Instructions

本项目是 **Kodrix Code**：基于 VS Code / VSCodium 的深度定制分支，集成多 Agent 协作、智能补全、Idea Flow 等 AI 能力。

基线提示：VS Code **1.128.0** · Electron **42.x** · Node 见 `.nvmrc`（`24.17.0`，同 major 且 ≥ 该版本；npm &lt; 12）· 协议 MIT。

面向人类的产品说明见 [`README.md`](README.md)。本文供 Agent / 开发者快速定位工程。

## 项目结构

```
kodrix/
├── src/                      # 核心源码 (TypeScript)
│   ├── vs/                   # VS Code 核心框架层
│   │   ├── base/             # 通用基础库 (事件、生命周期、异步等)
│   │   ├── platform/         # 平台服务层 (文件、网络、存储、Agent Host 等)
│   │   ├── editor/           # 编辑器核心
│   │   ├── workbench/        # 工作台 UI 层
│   │   ├── sessions/         # Sessions / 移动端等相关能力
│   │   ├── server/           # 服务端相关
│   │   └── code/             # Electron 主进程入口
│   ├── main.ts               # Electron 主进程启动入口
│   ├── cli.ts                # 命令行入口
│   └── typings/              # TypeScript 类型声明
│
├── extensions/               # 内置扩展
│   ├── copilot/              # GitHub Copilot（含 .esbuild.mts 构建）
│   ├── kodrix-local/         # Cursor 体验：补全、Ctrl+K、Composer、导入、模型供应商
│   ├── kodrix-agent-os/      # Agent OS：codebase、路由、Idea Flow、Crew 等
│   ├── kodrix-skills/        # Skill 市场与安装
│   ├── git/                  # Git 集成
│   ├── typescript-language-features/
│   └── ...                   # 其他语言支持与主题
│
├── marketplace/              # Skill 包目录与 catalog（与 kodrix-skills 配套）
├── build/                    # 构建系统 (gulp + esbuild)
│   ├── lib/                  # 构建工具库
│   ├── gulpfile.vscode.ts    # 主 gulp 任务 (编译/打包/签名)
│   ├── gulpfile.extensions.ts
│   └── gulpfile.compile.ts
│
├── scripts/                  # 运行与修复脚本
│   ├── dev-fast.ps1          # 快速开发启动 (esbuild transpile；debug.bat 委托于此)
│   ├── build-exe.ps1         # Windows EXE 安装包一键构建
│   ├── code.bat / code.sh    # Electron 启动脚本 (dev 模式)
│   ├── apply-zh-langpack.mjs # 简体中文注入
│   └── fix-*.mjs / copy-native-modules.mjs / restore-pw-shim.mjs
│
├── patches/                  # VSCodium 上游补丁
├── test/                     # unit / smoke / mcp 等
├── docs/                     # 文档与体检 / 审计报告
├── out/                      # 编译输出 (dev)
└── .build/                   # 构建缓存 (electron / 扩展 / 临时文件)
```

产品定制优先改 `extensions/kodrix-*` 与 `product.json`；动 `src/vs/**` 前先确认是否已有扩展层入口可复用。

## 开发工作流

根目录入口（Windows）：

```batch
# 带实时日志的控制台调试启动（esbuild 快编译）
.\debug.bat

# 热更新：改 src/ 后自动增量重编译
.\debug.bat -Watch

# 一键全量重编译 + 带实时日志启动（恢复环境 / 排障）
.\debug-rebuild.bat

# 一键重新编译打包 EXE 安装包（首次约 30–90 分钟）
.\build.bat
```

常用 npm：`npm run dev:prepare`（准备不启动）· `npm run compile` · `npm run package:win32`。

## 关键配置

| 文件 | 说明 |
|------|------|
| `product.json` | 产品品牌与运行时配置（`nameShort`=`Kodrix` 等） |
| `.nvmrc` | Node.js 版本要求（`24.17.0`） |
| `.npmrc` | npm + Electron 构建配置 |
| `package.json` | 脚本与依赖 |
| `.vscode/launch.json` | 调试启动配置 |

## 构建注意事项

1. **compile-copilot-extension-build** — Copilot 扩展首次 esbuild 打包需 10–30 分钟（多路并行），非挂死。
2. **preinstall.ts** — 严格校验 Node：与 `.nvmrc` 同 major，且 ≥ `.nvmrc`；npm major 须 &lt; 12。Cursor 沙箱 PATH 可能指向 Node 22，装依赖请用系统合规 Node。
3. **electron 下载** — 经 `@vscode/gulp-electron` 落到 `.build/electron/`。
4. **VSCODE_SKIP_PRELAUNCH** — `dev-fast.ps1` 设此变量跳过 preLaunch 以加快启动；客户端过期时会走 `build-fast`（见 `Test-ClientOutFresh`）。

启动卡死、native 模块、语言包等问题优先查 [`REPAIR-NOTES.md`](REPAIR-NOTES.md)。

## Agent 工作约定

- **少动面**：能在 `kodrix-*` 扩展内解决的，不改核心 `src/vs`。
- **先复用**：同目录已有 logger / paths / 配置读写模式，不要新造平行工具。
- **不擅自提交**：仅在用户明确要求时 `git commit`；不改 git config、不 force push。
- **排障顺序**：日志 → `REPAIR-NOTES.md` → 相关审计报告 → 再改代码。

## 相关文档

| 文档 | 用途 |
|------|------|
| `README.md` | 产品中文说明与快速开始 |
| `REPAIR-NOTES.md` | 启动卡死、native 模块、product.json、中文语言包等排障 |
| `SECURITY.md` | 漏洞报告与贡献安全实践 |
| `MIGRATION.md` | Cursormini / Cursor 能力迁移对照 |
| `docs/项目体检与Cursor方向升级报告-2026-09-21.md` | 体检与升级详细报告 |
| `docs/项目缺陷与Bug深度审计报告-2026-09-23-复核版.md` | 缺陷审计复核（最新闭环结论） |
| `docs/项目Bug与缺陷审计报告-2026-09-23.md` | 缺陷审计原稿 |
