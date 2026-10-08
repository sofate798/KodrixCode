# 更新日志

本文件记录 Kodrix Code 面向用户的显著变更。

> 说明：仓库当前**尚未发布任何正式版本**（无 git tag、无 Release），因此首个条目为"未发布"。版本号 `v0.1.0` 仅为计划占位，正式发布时以 Release 页面与安装包内版本为准。条目按 `Keep a Changelog` 风格从 git 提交历史（2026-09-21 初始导入至今）提炼。

## [未发布] — v0.1.0 计划中

### 本轮变更（2026-10-04，使用者上手闭环）

**新增**

- **发布版本检查**：命令 `kodrix.checkForUpdates`（"Kodrix: Check for Updates"）读取 GitHub Releases 清单并提示新版本，提供"查看发行说明 / 下载安装包"入口；设置 `kodrix.updateCheck.enabled`、`.intervalHours`、`.feedUrl`、`.includePrerelease`。只拉清单、不发设备或账号信息，可整体关闭或改指向自建分发源。
- **FIM 专线可控可观测**：新增 `kodrix.tabCompletion.fimEnabled`（默认开）与生效中的 `kodrix.tabCompletion.fimEndpoint`；补全统计新增 FIM 诊断（失败 / 跳过 / 最近一次状态与端点），命中率按**实际产出通道**归因。
- **发布工程**：CI 新增 `windows-installer` 作业，产出带 `SHA256SUMS.txt` 的 `KodrixSetup-<version>-win32-x64.exe`；签名改为可配置的 `signtool` 路径（无证书时干净降级并显式告警）；发布包真正内置简体中文语言包（`scripts/apply-release-zh-langpack.mjs`，实测命中 21153/21184 条）；SBOM 改为离线生成。
- **仓库契约门禁**：`.github/workflows/_shared/` 下 4 个免依赖检查（import 入库、声明命令↔注册站点、贡献点与提案一致性、真 Electron 最小冒烟），已接入 PR 门禁与 nightly。
- **用户文档**：新增 [MIGRATION.md](MIGRATION.md)、[docs/AI个人开发者上手与使用说明.md](docs/AI个人开发者上手与使用说明.md)、[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) 与本更新日志；README 改为"使用者 / 贡献者"双入口；issue 模板补充使用问题与功能请求（含隐私提醒）。

**修复**

- **新克隆无法编译**：`skillInstall.ts` 引用的 `zipValidation.ts` 及其他 38 个未跟踪源文件（含生产代码与测试）此前从未 `git add`；本机自测全绿但仓库缺文件。已一并入库，并由 import 契约检查持久防护（经变异测试验证可报红）。
- **供应商注册谎报成功**：BYOK 镜像注册失败时界面仍提示"已应用"。现按 Kodrix 直连 / Copilot BYOK 两条通道分别如实播报，主路径不再被 Copilot 就绪等待阻塞，Gemini（仅 BYOK 可用）给出进度与真实失败。
- **未安装 Copilot 时空等超时**：就绪等待区分"扩展不存在"与"存在未激活"，不存在时短宽限期后快速失败。
- **注册失败后无修复入口**：`reapplyStoredProvider` 此前全仓零调用，现已接入供应商面板"设为当前供应商"，使激活可自愈重试镜像。
- **错误提示不可行动**：Chat 请求与连接测试统一错误分类（DNS / 连接拒绝 / 证书 / 超时 / 取消分离，401/402/404/429/5xx 各给下一步），cause 链完整透出；面板未预期异常不再直出英文堆栈前缀。
- **首屏文案与首启向导矛盾**：核心 Chat 入口原文案为"免费借助 Copilot 使用 AI 功能"，与向导"不需要登录 GitHub"冲突。已将三处文案改为如实标注 Copilot 为可选通道，并**同步修改中英文**（仅改英文会残留旧中文译法）。
- **9 个"能调不生效"的设置项**：并发数、Agent 最大迭代、检查点自动采集、看板已完成过滤、wiki/hooks/acp/propertyTests/contextIntelligence 开关，以及 `kodrix.hasWorkspace` 上下文键（缺失会导致 Checkpoints 视图永不显示）—— 全部接线。
- **FIM 失败静默降级**：失败不再被吞（日志含 HTTP 状态与端点），4xx（非 429）时本会话内熔断坏端点，避免每次按键都打已知失效的接口。
- **内置 Copilot 的扩展源风险**：`builtInExtensionsEnabledWithAutoUpdates` 清空，避免 Open VSX 上同名发布者向本机推送更新；代价是 Copilot 版本随产品版本固定。
- **仓库脏物**：`__review_diff1~5.txt`、`__diff_stat.txt` 此前被误提交，已解除跟踪（磁盘文件保留）并补 `.gitignore`。

### 新增

- **BYOK 模型供应商体系**：命令面板 "Kodrix: AI Provider Management"（`kodrix.openProviderWorkbench`），内置 13 家供应商预设（Ollama / llama.cpp / LM Studio / DeepSeek / OpenAI / Anthropic / Gemini / OpenRouter / 硅基流动 / 智谱 / 通义千问 / 自定义 / 自定义本地），支持连接测试与多模型路由。
- **配置迁移与导入**：首次启动自动从 `~/.cursormini` / `~/.kodrix` 迁移供应商、模型路由、MCP、Plugins（"Kodrix: Migrate Configuration"）；从 Cursor 导入 Rules / MCP / Skills（"Kodrix: Import from Cursor"）。详见 [MIGRATION.md](MIGRATION.md)。
- **首启向导**：Welcome Webview 向导（环境扫描 + Cursor 导入预览 + 快速入口）。
- **Agent OS 能力集**（`kodrix-agent-os` 扩展）：Spec 工作台、Agent 看板、项目记忆/知识沉淀、Smart Router、Crew 多 Agent 编排、Idea Flow、Vibe Coding、Repo Wiki、Checkpoint 回滚、终端 AI、会话线程等，均可从命令面板以 "Kodrix: …" 前缀检索。
- **@Codebase 代码库问答**：聊天参与者 `@codebase`、"Kodrix: Codebase Q&A"（`kodrix.codebase.search`）、语义索引构建与管理（含增量/自动建索引设置）。
- **Skill 市场**（`kodrix-skills` 扩展）：卡片式 Webview 市场，支持目录浏览、GitHub / URL 安装、导入 `~/.cursor/skills`；仓库内置 `marketplace/packages` 示例。
- **Cursor 风格快捷键**：`Ctrl+K` 内联编辑、`Ctrl+L` Chat、`Ctrl+I` Agent、`Ctrl+Shift+A` Agents 窗口等。
- **本地 Tab/FIM 补全（实验，默认关闭）**：设置 `kodrix.tabCompletion.enabled` 开启，采纳率统计命令可自查。
- **中文界面**：官方 zh-cn 语言包注入；品牌图标 / 标题栏全套 Kodrix 化。

### 修复

- 安全：集成 SecretStorage 存储供应商 API Key（不落盘 `settings.json`）；修复多项安全风险与工程质量问题；迁移路径穿越防护（`KODRIX_CONFIG_DIR` 限定主目录内）。
- 检查点系统全面迁移为异步 I/O；同步嵌入提供商的错误处理修复。
- 构建：修复构建脚本类型安全与符号链接创建问题；移除 parcel watcher 等冗余依赖；CI 三平台构建与 nightly 修复、npm install 失败自动输出诊断日志。
- Cursor 方向：@codebase 参与者声明、nls 本地化、Remote Tunnels 配置等修复。

### 已知问题

见 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)。主要包括：无自动更新通道、安装包无代码签名、GitHub Copilot 登录仅支持设备码 / PAT、本地 FIM 依赖 DeepSeek beta 端点、扩展市场源为 Open VSX。

---

## 版本策略（计划）

- 基线跟随 VS Code **1.128.0**；上游合并记录见提交历史。
- 发布节奏、渠道与验收标准见 [docs/个人开发者首次使用与发布验收.md](docs/个人开发者首次使用与发布验收.md)。
