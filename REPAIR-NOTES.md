# Kodrix 排障与修复笔记

> 本地源码工程可编译、可启动、可加载扩展的关键修复与已知降级。

## 环境要求

- **Node.js**：须匹配 [`.nvmrc`](.nvmrc)（`24.17.0`）——与 `.nvmrc` **同 major**，且版本 **≥ `.nvmrc` 全文**；npm major **&lt; 12**（见 `build/npm/preinstall.ts`）。Cursor 沙箱 PATH 可能优先 Node 22，装依赖请用系统合规 v24。
- **入口命令**：

| 命令 | 用途 |
|------|------|
| `.\debug.bat` | esbuild 快编译 + 带日志启动（委托 `scripts/dev-fast.ps1`） |
| `.\debug.bat -Watch` | 改 `src/` 后增量热更新 |
| `.\debug-rebuild.bat` | 全量重编译后再启动 |
| `.\build.bat` | 打 Windows EXE 安装包 |

`dev-fast.ps1` **不会**自动跑 `restore-pw-shim` / `copy-native-modules`；首次环境或缺 native 时需手跑下表脚本。

## 启动卡死：无窗口 / MainWindowHandle=0

**症状**：主进程存活但不创建窗口；日志停在 `NativePolicyService#_updatePolicyDefinitions`。

**原因**：`@vscode/policy-watcher` 的 Dev Shim 从不调用 callback，`configurationService.initialize()` 永久等待。

**处理**：

```bash
node scripts/restore-pw-shim.mjs
```

shim 的 `createWatcher()` 创建时立即 `callback({})`。官方 `.node` 与当前 Electron ABI 不兼容时保留此 shim（企业策略监控不可用，可接受）。

注意：`copy-native-modules.mjs` **只复制 `.node`，不改写** `policy-watcher/index.js`；复制后若仍卡死，再跑一次 `restore-pw-shim.mjs`。

## Native 模块缺失

**症状**：`Unable to open DB`、spdlog/日志异常、registry 等加载失败。

**原因**：`node_modules/@vscode/*/build/Release/*.node` 未编译（无 VS Build Tools / node-gyp）。

**处理**：

```bash
# 推荐：指定本机 VS Code unpacked 路径
set VSCODE_UNPACKED_NODE_MODULES=D:\path\to\...\node_modules.asar.unpacked\@vscode
node scripts/copy-native-modules.mjs

# 或：node scripts/copy-native-modules.mjs <上述路径>
```

未设环境变量 / 未传参时，脚本默认 SRC 为本机硬编码路径（见脚本内常量，可能与你的安装位置不符）。装好 VS Build Tools 后也可 `npm rebuild`。

**可忽略降级**：

| 模块 | 影响 |
|------|------|
| `native-keymap` | 键盘布局检测为空，用默认布局 |
| `native-is-elevated` | 管理员检测恒为 false |
| `@vscode/policy-watcher` | 见上，保留 shim |

## product.json 必填字段

缺字段会导致主进程或渲染进程崩溃。当前仓库 `product.json` 已含常用字段；幂等脚本仅补缺：

| 字段 | 说明 |
|------|------|
| `defaultChatAgent` | 缺则 onboarding `assertDefined` 未捕获异常 → `scripts/fix-product-json.mjs` **只补此项** |
| `sharedDataFolderName` | 缺则 `joinPath(..., undefined)` 崩溃（应以 `product.json` 为准维护） |
| `tunnelApplicationConfig` | 缺则 Remote Tunnels 报缺配置 |
| `builtInExtensionsEnabledWithAutoUpdates` | 缺则 `is not iterable` 日志噪音 |

```bash
node scripts/fix-product-json.mjs
```

## 界面默认简体中文（dev）

dev transpile 的 `out/vs/nls.js` 对字符串 key 直接返回英文。链路：

1. 内置语言包：`extensions/ms-ceintl.vscode-language-pack-zh-hans`（版本需与内核一致，现为 1.128.x）
2. `scripts/apply-zh-langpack.mjs` 注入中文查表到 `out/vs/nls.js`
3. `scripts/dev-fast.ps1` 在编译后自动执行（幂等）

重新 `node build/next/index.ts transpile` 会还原英文 `nls.js`；语言包版本随 `package.json` 内核版本升级同步更换。

## 客户端 / 扩展过期（dev-fast）

| 检查 | 行为 |
|------|------|
| 客户端 `out/main.js` vs `src/`（`Test-ClientOutFresh`） | 过期或缺失 → 走 `build-fast` / 全量 transpile |
| kodrix 扩展 `out` vs `src` | stale → 重编译对应扩展 |

## 修复脚本（均可幂等重跑）

| 脚本 | 作用 |
|------|------|
| `scripts/fix-product-json.mjs` | 补齐 `defaultChatAgent`（若缺失） |
| `scripts/copy-native-modules.mjs` | 复制 native `.node`（不碰 shim） |
| `scripts/restore-pw-shim.mjs` | 写入 policy-watcher 修复 shim |
| `scripts/apply-zh-langpack.mjs` | 注入 zh-cn（由 `dev-fast` 调用） |

可选诊断：`scripts/fix-wms.mjs`（非日常必跑）。

## 扩展相关常见项

- **`@codebase` / chat participant**：`kodrix-agent-os` 须在 `package.json` 声明 `contributes.chatParticipants`（`kodrix.codebase`）；另有 Copilot `#codebase` 路径，见 `MIGRATION.md`。
- **proposed API**：`kodrix-agent-os` 需 `enabledApiProposals`（如 `chatContextProvider`）或启动参数 `--enable-proposed-api`。
- **上游噪音（非本分支缺陷）**：Agent Host `ENOPRO: vscode-userdata`；dev 模式 tunnel 需 Rust（`spawn cargo ENOENT`）。
