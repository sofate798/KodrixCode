---
kind: frontend_style
name: VS Code 主题与 CSS 样式体系（CSS Modules + 设计令牌 + JSON 主题）
category: frontend_style
scope:
    - '**'
source_files:
    - src/vs/workbench/browser/style.ts
    - src/vs/workbench/browser/media/style.css
    - src/vs/base/browser/domStylesheets.ts
    - src/vs/base/browser/ui/actionbar/actionbar.css
    - extensions/theme-defaults/themes/dark_modern.json
    - extensions/theme-defaults/themes/light_modern.json
    - extensions/theme-defaults/themes/dark_plus.json
    - extensions/theme-defaults/themes/light_plus.json
    - extensions/theme-defaults/themes/hc_black.json
    - extensions/theme-defaults/themes/hc_light.json
    - extensions/theme-defaults/themes/2026-dark.json
    - extensions/theme-defaults/themes/2026-light.json
    - extensions/theme-defaults/fileicons/vs_minimal-icon-theme.json
    - src/vs/editor/common/core/editorColorRegistry.ts
    - src/vs/workbench/common/theme.js
    - .eslint-plugin-local/code-import-patterns.ts
    - .eslint-plugin-local/code-no-icons-in-localized-strings.ts
---

## 1. 系统/方法概述

Kodrix 发行版直接继承 VS Code 上游的前端样式体系，采用 **CSS + JSON 主题** 的组合方案：
- 所有 UI 组件的样式以独立 `.css` 文件形式存在，并通过 TypeScript 模块 `import './xxx.css'` 按需加载。
- 颜色、阴影、圆角等视觉变量通过 CSS 自定义属性（`--vscode-*`）暴露给 CSS 层；这些变量的值由运行时主题引擎根据当前主题 JSON 动态注入。
- 主题定义以 JSON 文件形式集中在 `extensions/theme-defaults/themes/`，每个文件声明一组 `colors` 映射到 VS Code 语义化 token（如 `editor.background`、`button.background`），并通过 `include` 实现主题叠加。
- 运行时通过 `registerThemingParticipant` 将主题色转换为 CSS 规则或 CSS 变量，供组件使用。

该体系同时服务于 Electron、Node 远程服务器和 Web 三种宿主环境，样式在 `src/vs/workbench/browser`、`src/vs/base/browser/ui/*` 以及各内置扩展中统一生效。

## 2. 关键文件与包

- 工作区根样式入口：`src/vs/workbench/browser/style.ts` —— 注册主题参与者，设置 `monaco-workbench` 背景、选择高亮、Safari/iOS 兼容规则，并同步 `<meta name="theme-color">`。
- 全局样式表：`src/vs/workbench/browser/media/style.css` —— 定义字体族（按平台与语言切换）、`body` 基础样式、`.monaco-workbench` 容器、阴影变量（`--vscode-shadow-*`）、边框与链接样式等。
- 通用 UI 组件样式：`src/vs/base/browser/ui/*/` 下每个子目录对应一个原生组件（actionbar、breadcrumbs、countBadge、dialog、dropdown、inputbox、list、menu、progressbar、radio、selectBox、table、toggle、toolbar、tree 等），各自维护独立的 `.css` 文件。
- 样式工具库：`src/vs/base/browser/domStylesheets.ts` —— 提供 `createStyleSheet`、`createCSSRule`、`removeCSSRulesContainingSelector`、`createStyleSheetFromObservable` 等 API，用于安全地创建/克隆/移除 `<style>` 节点。
- 主题定义：`extensions/theme-defaults/themes/` —— 包含 `dark_modern.json`、`light_modern.json`、`dark_plus.json`、`light_plus.json`、`hc_black.json`、`hc_light.json`、`2026-dark.json`、`2026-light.json` 等主题；通过 `include` 继承基础主题并覆盖 `colors`。
- 图标主题：`extensions/theme-defaults/fileicons/vs_minimal-icon-theme.json`。
- 编辑器颜色注册中心：`src/vs/editor/common/core/editorColorRegistry.ts` —— 通过 `registerColor` 声明编辑器相关 token 及其默认值。
- 工作区颜色常量：`src/vs/workbench/common/theme.js` —— 导出 `WORKBENCH_BACKGROUND`、`TITLE_BAR_ACTIVE_BACKGROUND` 等供主题参与者消费。

## 3. 架构与约定

### 3.1 主题参与模型（Theming Participant）
- 组件通过 `registerThemingParticipant((theme, collector) => { ... })` 注册回调，在主题变化时重新计算 CSS 规则。
- 回调内通过 `theme.getColor(token)` 获取解析后的颜色，再调用 `collector.addRule(...)` 追加 CSS 规则。
- 示例：`workbench/browser/style.ts` 为 `.monaco-workbench` 设置背景色、为 `::selection` 设置选中色、为 Safari 设置 `touch-action` 与 `user-select`。

### 3.2 颜色注册与消费
- 新增颜色 token 必须先在 `colorRegistry` / `editorColorRegistry` 中通过 `registerColor(name, default, description, supportsReducedMotion?)` 声明。
- 组件通过 `asCssVariable(token)` 生成 `var(--vscode-xxx)` 引用，或在 TS 中 `theme.getColor(token)` 取色。
- 主题 JSON 中的 `colors` 字段将 token 名映射到具体颜色值，支持 dark/light/hcDark/hcLight 四套值。

### 3.3 CSS 组织方式
- 每个 UI 组件目录（`base/browser/ui/<component>/`）内包含 `*.ts` + 同名 `*.css`，TS 文件顶部 `import './xxx.css'` 触发构建期打包。
- 全局样式集中在 `workbench/browser/media/style.css`，按平台（`.mac`、`.windows`、`.linux`）与语言（`:lang(zh-Hans)` 等）切换字体族。
- 阴影、圆角等跨主题变量以 CSS 变量形式定义在 `.monaco-workbench` 上（如 `--vscode-shadow-sm/md/lg/xl`、`--vscode-cornerRadius-medium`），便于主题覆盖。

### 3.4 多宿主适配
- `isWeb`、`isIOS`、`isStandalone`、`isSafari` 等平台判断用于条件注入样式规则（如 web 模式下禁用滚动反弹、iOS 主屏启动页背景同步）。
- `domStylesheets.ts` 提供 `cloneGlobalStyleSheet`，确保 iframe/webview 中全局样式正确复制。

## 4. 约定与约束

- **样式文件必须通过 TS import 引入**：ESLint 本地插件 `code-import-patterns.ts` 强制 ESM 导入路径必须以 `.js` 或 `.css` 结尾，确保构建器能正确识别 CSS 依赖。
- **禁止在本地化字符串中使用主题图标语法**：`code-no-icons-in-localized-strings.ts` 阻止 `$(iconName)` 出现在 `localize()` 参数中，避免运行时无法解析。
- **颜色必须经 token 注册**：新增 UI 颜色需先通过 `registerColor` 声明 token，再由主题 JSON 赋值，禁止在 CSS 中硬编码十六进制颜色。
- **主题 JSON 使用 `include` 继承**：默认主题通过 `"include": "./dark_plus.json"` 等方式复用基础配色，仅覆盖差异化的 `colors`。
- **组件样式遵循 BEM-like 命名**：类名以 `monaco-*` 前缀（如 `.monaco-action-bar`、`.monaco-workbench`），避免污染全局命名空间。
- **平台/语言差异化通过 CSS 修饰类与伪类**：字体族、边框圆角、触摸行为等通过 `.mac`、`.windows`、`.linux` 修饰类及 `:lang(zh-Hans)` 等伪类区分。
- **阴影可通过配置关闭**：`.monaco-workbench.no-shadows` 类可将所有 `--vscode-shadow-*` 变量置零，配合 CSS 变量插值实现开关效果。

## 5. 与 Kodrix 定制的关系

本仓库作为 VS Code 上游发行版的分支，未引入 Tailwind、Styled Components 等第三方样式框架；所有前端样式仍沿用 VS Code 原生的 CSS + JSON 主题体系。Kodrix 的品牌定制主要通过 `product.json`、`patches/` 下的补丁（如 `00-ui-custom-font.patch`、`80-ui-disable-onboarding.json`）以及替换 `extensions/theme-defaults/themes/` 中的主题 JSON 来实现，而非重写样式架构。