---
kind: dependency_management
name: Kodrix 发行版的多语言依赖管理体系（npm + Cargo + 补丁/锁定文件）
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - .npmrc
    - extensions/package.json
    - extensions/.npmrc
    - remote/package.json
    - cli/Cargo.toml
    - cli/Cargo.lock
    - cli/.cargo/config.toml
    - .github/dependabot.yml
    - cgmanifest.json
    - ThirdPartyNotices.txt
    - cglicenses.json
---

## 1. 使用的系统与工具

本仓库是一个以 VS Code 上游源码为基底的跨语言发行工程，依赖管理覆盖三种语言生态：

- **Node.js / TypeScript**：使用 npm 作为包管理器，通过根 `package.json`、`extensions/package.json`、`remote/package.json`、`test/package.json` 以及各内置扩展子目录的 `package.json` 声明依赖；通过 `package-lock.json` 锁定版本。
- **Rust (CLI)**：`cli/Cargo.toml` 声明 Rust 依赖，`cli/Cargo.lock` 锁定版本；构建时通过 `.cargo/config.toml` 配置目标平台编译参数。
- **Electron 原生模块**：通过 `.npmrc` 中的 `disturl`、`target`、`runtime="electron"` 等 node-gyp 配置，配合 `build/npm/preinstall.ts` 下载 Electron 42.5.0 的头文件进行原生模块编译。

## 2. 关键文件与位置

| 作用 | 关键文件 |
|---|---|
| 根级 npm 依赖声明与脚本入口 | `package.json` |
| npm 行为与 Electron 原生模块头文件配置 | `.npmrc` |
| 所有扩展共享的 npm 依赖 | `extensions/package.json` |
| 各内置扩展的独立依赖 | `extensions/<ext>/package.json` |
| 远程运行时依赖隔离 | `remote/package.json` |
| Rust CLI 依赖声明与锁定 | `cli/Cargo.toml`、`cli/Cargo.lock` |
| Rust 目标平台编译参数 | `cli/.cargo/config.toml` |
| 自动化依赖更新（GitHub Actions） | `.github/dependabot.yml` |
| 第三方许可证与来源清单 | `cgmanifest.json`、`ThirdPartyNotices.txt`、`cglicenses.json` |
| 构建期补丁（影响依赖解析/安装） | `patches/` 下的 `00-build-*`、`00-remote-*` 等 |

## 3. 架构与约定

### 3.1 Node.js 依赖分层

- **根工作区** (`package.json`) 声明核心运行时依赖（如 `@microsoft/dev-tunnels-*`、`@xterm/*`、`undici`、`playwright-core`、`electron` 等），并通过 `overrides` 强制统一某些传递依赖的版本（例如 `node-gyp-build=4.8.1`、`serialize-javascript^7.0.3`、`ssh2.cpu-features=0.0.0`）。
- **extensions 聚合层** (`extensions/package.json`) 仅声明构建期共享依赖（`typescript ^6.0.3`、`esbuild 0.28.1`、`@parcel/watcher`、`vscode-grammar-updater`），由 `postinstall.mjs` 驱动各扩展的构建流程。
- **每个内置扩展** 拥有独立的 `package.json`、`package-lock.json` 和 `node_modules`，实现扩展间依赖隔离；部分扩展还自带 `.npmrc`（如 `configuration-editing`、`emmet`、`git`、`github-authentication`、`html-language-features`、`ipynb`、`markdown-language-features`、`php-language-features`、`simple-browser`、`terminal-suggest`、`tunnel-forwarding`、`vscode-api-tests`、`vscode-test-resolver` 等）来定制安装行为。
- **remote 运行时** (`remote/package.json`) 单独声明远程服务器端所需的 npm 依赖，与桌面/客户端依赖解耦。

### 3.2 原生模块与 Electron 集成

`.npmrc` 中显式设置 `disturl="https://electronjs.org/headers"`、`target="42.5.0"`、`runtime="electron"`，使 `node-gyp` 在构建阶段从 Electron 官方镜像下载对应版本的 C++ 头文件。同时启用 `build_from_source="true"` 与 `legacy-peer-deps="true"`，并设置 `timeout=180000` 以应对慢速网络环境。`preinstall` 钩子会校验 npm 版本并要求 `<12`，因为 npm 11 对 node-gyp 的配置键发出警告。

### 3.3 Rust CLI 依赖管理

`cli/Cargo.toml` 使用语义化版本约束声明依赖，并通过 `[patch.crates-io]` 将 `russh`、`russh-cryptovec`、`russh-keys` 三个 crate 替换为 Microsoft fork 的 `vscode-russh` 仓库的 `main` 分支，用于修复 SSH 相关功能。`[profile.release]` 开启 `strip=true` 与 `lto=thin` 以减小产物体积。Windows 目标额外启用 `/guard:cf` 与 `/CETCOMPAT` 安全链接选项。

### 3.4 补丁驱动的依赖/构建定制

`patches/` 目录下集中存放针对上游 VS Code 源码的 diff，其中多个补丁直接影响依赖行为：
- `00-build-download-extensions-from-gh.patch`：修改内置扩展下载源。
- `00-build-fix-npm-preinstall.patch`：调整 npm preinstall 行为。
- `00-remote-add-missing-dependencies.patch`：为 remote 运行时补充缺失依赖。
- `00-security-*`、`00-telemetry-disable`、`00-update-*` 等补丁在构建期应用，从而改变最终产物所引入的第三方库。

### 3.5 第三方来源与许可证追踪

仓库根及 `extensions/`、`test/` 下均维护 `cgmanifest.json`，记录第三方组件的来源 URL、版本与许可证信息；`ThirdPartyNotices.txt` 与 `cglicenses.json` 汇总所有第三方许可证文本，供发布产物附带。

## 4. 约定与约束

- **锁文件策略**：npm 生态使用 `package-lock.json` 锁定完整依赖树；Rust 生态使用 `Cargo.lock` 锁定版本。两者均需随代码提交，确保可重现构建。
- **依赖版本约束风格**：npm 依赖普遍使用 `^` 前缀（允许小版本升级），但关键二进制/原生模块（如 `electron`、`playwright-core`、`kerberos`、`node-pty`、`vscode-oniguruma`）采用精确主版本或带 `-vscode` 后缀的定制版本；Rust 依赖同样倾向较宽松的语义化范围。
- **传递依赖强制统一**：通过根 `package.json` 的 `overrides` 字段强制覆盖 `node-gyp-build`、`serialize-javascript`、`ssh2.cpu-features`、`yauzl` 等传递依赖版本，避免多扩展间版本冲突。
- **私有/替代源**：未配置全局私有 npm registry，但通过 GitHub 上的 Microsoft 仓库（如 `dev-tunnels`、`vscode-russh`）作为 Git 依赖源；Rust 侧通过 `[patch.crates-io]` 指向 fork 仓库。
- **CI 自动更新**：`.github/dependabot.yml` 仅对 GitHub Actions 工作流启用每周依赖更新，对 npm/Rust 依赖未启用自动 PR，说明依赖升级需人工评审后合并。
- **构建前置校验**：`preinstall` 钩子强制要求 npm < 12，且 `build_from_source` 必须为真，保证原生模块按预期从源码编译而非使用预编译二进制。
- **扩展内聚性**：每个内置扩展独立维护自己的 `package.json`/`package-lock.json`，禁止跨扩展直接共享 `node_modules`，依赖变更应限定在对应扩展范围内。