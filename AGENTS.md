# Minicode — AI Coding Agent Instructions

本项目是基于 VS Code / VSCodium 的深度定制分支（Minicode），集成多 Agent 协作、智能补全、SOLO 工作台等 AI 能力。

## 项目结构

```
minicode/
├── src/                      # 核心源码 (TypeScript, 663 个 .ts 文件)
│   ├── vs/                   # VS Code 核心框架层
│   │   ├── base/             # 通用基础库 (事件、生命周期、异步等)
│   │   ├── platform/         # 平台服务层 (文件、网络、存储、Agent 等)
│   │   ├── editor/           # 编辑器核心
│   │   ├── workbench/        # 工作台 UI 层
│   │   └── code/             # Electron 主进程入口
│   ├── main.ts               # Electron 主进程启动入口
│   ├── cli.ts                # 命令行入口
│   └── typings/              # TypeScript 类型声明
│
├── extensions/               # 内置扩展 (111 个)
│   ├── copilot/              # GitHub Copilot 扩展 (含 .esbuild.mts 构建)
│   ├── minicode-*/           # Minicode 自定义扩展 (local/skills/solo/agent-os)
│   ├── git/                  # Git 集成
│   ├── typescript-language-features/  # TypeScript 语言支持
│   └── ...                   # 其他语言支持和主题扩展
│
├── build/                    # 构建系统 (gulp + esbuild)
│   ├── lib/                  # 构建工具库
│   │   ├── extensions.ts     # 扩展编译/打包逻辑
│   │   ├── copilot.ts        # Copilot 平台包处理
│   │   ├── electron.ts       # Electron 下载/配置
│   │   ├── preLaunch.ts      # 启动前环境准备
│   │   └── dependencies.ts   # 生产依赖解析
│   ├── gulpfile.vscode.ts    # 主 gulp 任务定义 (编译/打包/签名)
│   ├── gulpfile.extensions.ts # 扩展编译任务
│   └── gulpfile.compile.ts   # 核心编译任务
│
├── scripts/                  # 运行脚本
│   ├── dev-fast.ps1          # 快速开发启动 (esbuild transpile)
│   ├── build-exe.ps1         # Windows EXE 安装包一键构建
│   ├── code.bat / code.sh    # Electron 启动脚本 (dev 模式)
│   ├── code-server.bat       # Web 服务端启动
│   └── verify-windows-build-env.ps1  # Windows 构建环境检查
│
├── patches/                  # VSCodium 上游补丁 (45 个 .patch)
│   ├── 00-*.patch            # 品牌/构建/安全补丁
│   ├── 10-*.patch            # 版本/更新补丁
│   ├── linux/ / windows/     # 平台特定补丁
│   └── *.json                # 辅助 manifest (补丁系统)
│
├── test/                     # 测试
│   ├── unit/                 # 单元测试
│   ├── smoke/                # 冒烟测试
│   └── mcp/                  # MCP 协议测试
│
├── dev/                      # CI/CD 构建脚本 (VSCodium 上游)
├── .github/                  # GitHub Actions CI 工作流
├── resources/                # 平台资源 (图标/安装器模板)
├── cli/                      # Rust CLI 工具
├── out/                      # 编译输出 (dev 模式)
├── out-build/                # 构建中间产物
├── out-vscode-min/           # 生产构建输出 (esbuild bundle)
└── .build/                   # 构建缓存 (electron/扩展/临时文件)
```

## 开发工作流

### 快速启动 (推荐)
```batch
# 准备环境 (仅首次)
.\debug.bat -Prepare

# 启动 Minicode (esbuild 快编译)
.\debug.bat

# 热更新模式 (文件变更自动重编译)
.\debug.bat -Watch

# 全量编译 (恢复环境)
.\debug.bat -FullCompile
```

### 扩展编译
```batch
# 仅编译 Minicode 自定义扩展
.\compile-ext.bat
```

### EXE 打包
```batch
# 构建 Windows 安装包 (首次约 30-90 分钟)
.\build.bat
```

## 关键配置

| 文件 | 说明 |
|------|------|
| `product.json` | 产品品牌配置 (`nameShort`, `nameLong`, `applicationName` 等) |
| `.nvmrc` | Node.js 版本要求 (24.17.0) |
| `.npmrc` | npm + Electron 构建配置 |
| `package.json` | Node 项目配置 + 脚本定义 |
| `.vscode/launch.json` | VS Code 调试启动配置 |

## 构建系统注意事项

1. **compile-copilot-extension-build** — Copilot 扩展首次 esbuild 打包需 10-30 分钟（7 路并行编译），非挂死
2. **preinstall.ts** — 严格校验 Node 版本，必须匹配 `.nvmrc`
3. **electron 下载** — 通过 `@vscode/gulp-electron` 下载 Electron 到 `.build/electron/`
4. **VSCODE_SKIP_PRELAUNCH** — dev-fast.ps1 设置此变量跳过 preLaunch (加快启动)
