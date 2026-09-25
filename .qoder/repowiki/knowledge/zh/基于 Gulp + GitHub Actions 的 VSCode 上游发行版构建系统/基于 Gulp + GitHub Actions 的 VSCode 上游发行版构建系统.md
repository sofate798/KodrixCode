---
kind: build_system
name: 基于 Gulp + GitHub Actions 的 VSCode 上游发行版构建系统
category: build_system
scope:
    - '**'
source_files:
    - gulpfile.mjs
    - package.json
    - product.json
    - dev/build.sh
    - dev/build_docker.sh
    - .github/workflows/ci-build-linux.yml
    - .github/workflows/ci-build-macos.yml
    - .github/workflows/ci-build-windows.yml
    - .github/workflows/release.yml
    - scripts/code-server.sh
    - scripts/code-web.sh
    - scripts/code.sh
    - scripts/build-exe.ps1
    - patches/00-telemetry-disable.patch
    - patches/00-build-replace-unicode.patch
    - patches/00-security-add-command-filter.patch
    - remote/package.json
    - remote/web/package.json
    - Directory.Build.props
---

## 1. 构建系统与工具链

本仓库以 VS Code 上游源码为基底，通过 **Gulp**（`gulpfile.mjs` 转发到 `build/gulpfile.ts`）作为核心构建编排器，配合 **esbuild**、**TypeScript**、**Electron**、**Rust (cargo)** 完成多目标产物编译与打包。顶层 `package.json` 暴露大量 npm scripts（如 `compile-client`、`compile-cli`、`compile-web`、`minify-vscode`、`smoketest` 等），统一入口为 `node ./node_modules/gulp/bin/gulp.js`。

- 客户端/工作区代码：通过 `src/tsconfig.json` 等 tsconfig 编译，输出至 `out/`；Web 端额外产出 `out-build/`、`out-vscode-min/`。
- CLI（`cli/`）：Rust crate，使用 `Cargo.toml` + `build.rs` 构建，产物由 `scripts/build-exe.ps1` 包装。
- 扩展（`extensions/*`）：每个扩展独立 `package.json` + `esbuild.mts`/`vite.config.ts`，由根级 gulp 任务批量编译。
- Electron 应用：依赖 `electron@42.5.0`，通过 `@vscode/gulp-electron` 打包。

## 2. 关键文件与目录

- `gulpfile.mjs` → 转发到 `build/gulpfile.ts`，所有构建任务定义在此。
- `package.json`：npm scripts、依赖、`distro`（上游 commit）、`version` 版本号。
- `product.json`：品牌元数据（`nameShort: Kodrix`、`applicationName: kodrix`、`serverApplicationName: kodrix-server`、`quality: dev`、extension marketplace URL 指向 open-vsx.org 等）。
- `patches/*.patch`：对上游源码的 diff 补丁集合，用于定制品牌、禁用遥测、修改更新源、添加安全策略等。
- `dev/build.sh`：VSCodium 风格的跨平台构建入口脚本，设置 `APP_NAME`、`BINARY_NAME`、`VSCODE_QUALITY`、`OS_NAME`、`VSCODE_ARCH` 等环境变量后调用上游 `./build.sh`。
- `scripts/code-server.*` / `scripts/code-web.*` / `scripts/code.*`：本地启动/运行 server/web/cli 的 shell 包装。
- `.github/workflows/*.yml`：CI/CD 流水线（Linux/macOS/Windows 构建、Insider/Stable 发布、nightly、PR 检查）。
- `remote/package.json`、`remote/web/package.json`：Remote 与 Web 运行时依赖隔离清单。
- `Directory.Build.props`：MSBuild 属性，供 Windows 原生模块构建使用。

## 3. 架构与约定

### 3.1 多阶段构建流程

1. **源码准备**：`dev/build.sh` 通过 `get_repo.sh` 拉取上游 VS Code 源码，`version.sh` 解析版本，写入 `dev/build.env`。
2. **编译**：进入 `vscode/` 子目录执行 `./build.sh`，内部调用 Gulp 任务编译 TypeScript、esbuild 前端资源、下载内置扩展。
3. **打包**：按平台调用 `build/linux/package_bin.sh`、`build/osx/...`、`build/win32/...` 生成安装包（AppImage、deb、rpm、dmg、msi 等）。
4. **资源准备**：`prepare_assets.sh` 将二进制、图标、shell 补全、LICENSE 等整理到 `assets/`。
5. **测试**：`scripts/test*.sh` 封装 Mocha/Playwright 测试；`release.yml` 中触发 `npm run smoketest`。

### 3.2 质量通道（Quality Channel）

通过环境变量 `VSCODE_QUALITY=stable|insider` 区分稳定版与预览版，GitHub Actions 根据分支 `master`/`insider` 自动选择。`dev/build.sh` 支持 `-i` 切换 insider 模式，`-l` 拉取最新上游 tag。

### 3.3 多架构矩阵构建

`.github/workflows/ci-build-linux.yml` 使用 matrix 同时构建 x64/arm64/armhf/riscv64/loong64/ppc64le 共 6 种 Linux 架构，各架构使用专用 Docker 镜像 `vscodium/vscodium-linux-build-agent:*`。

### 3.4 补丁驱动定制

`patches/` 目录下集中存放针对上游源码的 patch，命名规则体现优先级（如 `00-*` 基础修补、`10-*` 版本相关、`20-*` 策略、`30-*` 依赖、`40-*` CLI、`50-*` gulp 任务增强、`60-*` 安全、`80-*` UI 行为）。构建时通过 `dev/merge-patches.sh` / `dev/patch.sh` 应用。

### 3.5 产物与目录约定

- `out/`：开发态编译输出（含 sourcemap）。
- `out-build/`：生产构建输出（压缩、剥离调试信息）。
- `out-vscode-min/`：最小化 web 运行时产物。
- `dist/`：最终打包产物暂存目录。
- `resources/{darwin,linux,win32}/`：平台专属资源（图标、plist、manifest、启动脚本）。

## 4. 约定与约束

- **Node 版本**：通过 `.nvmrc` 锁定，CI 使用 `actions/setup-node` 读取该文件。
- **内存限制**：构建脚本显式设置 `NODE_OPTIONS="--max-old-space-size=8192"`，防止大项目 OOM。
- **扩展市场**：`product.json` 将 extension gallery 指向 `open-vsx.org`，而非 Visual Studio Marketplace。
- **遥测/更新**：通过 patches（如 `00-telemetry-disable.patch`、`00-update-disable.yet`）关闭遥测与自动更新。
- **签名**：macOS 构建需加载 `dev/osx/codesign.env` 中的证书环境变量；Windows 使用 Inno Setup (`innosetup`) 生成安装包。
- **测试入口**：禁止直接 `npm test`（会提示去 `scripts/` 下运行），统一通过 `scripts/test.sh`、`scripts/test-integration.sh`、`scripts/test-web-integration.sh` 等脚本执行。
- **ESLint 自定义规则**：`.eslint-plugin-local/` 提供仓库级规则（分层、禁止危险模式、vscode.d.ts 规范等），通过 `npm run eslint` 或 pre-commit 钩子强制执行。
- **CI 触发**：push 到 `master`/`insider`、任意 PR 都会触发 CI；tag 推送 `v*` 触发 Release 流程（构建 + 冒烟测试 + 发布占位）。
- **产物上传**：CI job 通过 `actions/upload-artifact` 上传 `bin-${arch}` 与 `vscode.tar.gz`，保留期分别为 3 天与 1 天。

## 5. 总结

该仓库的构建系统本质上是 **VS Code 上游构建系统的二次封装**：通过 `dev/build.sh` 与 `patches/` 注入品牌与功能裁剪，用 Gulp/esbuild/Electron/Rust 组合产出桌面/远程/Web 三套运行时，并由 GitHub Actions 在多平台、多架构矩阵上自动化构建与发布。所有构建参数集中在环境变量与 `product.json` 中，使 stable/insider 双通道与多平台分发具备一致的可重复性。