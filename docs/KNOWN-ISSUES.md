# 已知问题与限制

本文如实列出当前对**外部用户**有实际影响的限制。按影响面排序；每条注明判断依据，便于自查。修复进展见 [CHANGELOG.md](../CHANGELOG.md) 与仓库 issue。

## 1. 无自动更新（有版本提示，但需手动下载安装）

`product.json` 未配置 `updateUrl`，编辑器**内置**的"检查更新"仍处于禁用状态——这是刻意选择：在没有自建更新服务的前提下，宁可没有更新通道，也不要指向错误的发布源。

作为替代，Kodrix 提供 **`Kodrix: 检查 Kodrix 更新`**（命令面板搜索 `kodrix.checkForUpdates`）：它只读取 GitHub Releases 清单，发现新版本时提示并给出"查看发行说明 / 下载安装包"入口，不发送任何设备或账号信息。相关设置为 `kodrix.updateCheck.enabled`（默认开）、`.intervalHours`（默认 24）、`.feedUrl`、`.includePrerelease`。

因此**下载与校验安装包的责任仍在用户侧**：请只从维护者公布的地址获取，并用发布页附带的 `SHA256SUMS.txt` 校验。自建分发时把 `feedUrl` 改成你自己的清单地址即可。

## 2. 安装包无代码签名

Windows 首次运行安装程序会触发 SmartScreen 警告（"Windows 已保护你的电脑 → 更多信息 → 仍要应用"）。这是分发可信度问题而非功能缺陷，但请确认安装包来源后再绕过警告。

签名管线已就绪但**尚未启用**：构建脚本会在检测到 `WINSIGN_PFX_BASE64` / `WINSIGN_PFX_PASSWORD` 时用 `signtool` 签名并加时间戳、随后强制 `verify /pa`；未配置证书时明确产出"未签名"包并在日志中告警。也就是说，这一条会在维护者购买并配置证书后自动消失；在此之前请始终配合第 1 条的校验和使用。

## 2.1 内置 Copilot 不随扩展市场自动更新

`builtInExtensionsEnabledWithAutoUpdates` 已清空。原因：本产品扩展市场源为 Open VSX（第 6 条），若允许内置的 `GitHub.copilot-chat` 从该源自动更新，则**任何在该源上占用同名发布者/扩展名的人都能向本机推送更新**。代价是 Copilot 版本随 Kodrix 版本一起固定，升级 Copilot 需要升级整个产品。

## 3. GitHub Copilot 账号登录不受支持

本 fork 的 `urlProtocol`（`kodrix`）不在微软受支持客户端名单内，`extensions/github-authentication/src/common/env.ts:10` 将 `isSupportedClient` 硬编码为 `false`（与 VSCodium 同做法）。登录 GitHub 扩展时只走**设备码（Device Code）或 PAT** 流程，浏览器回调式登录不可用。日常使用建议直接走 BYOK（"Kodrix: AI Provider Management"），不依赖 Copilot 账号。

## 4. Gemini 原生接口依赖 Copilot BYOK 通道

Kodrix 的模型注册经由 Copilot 扩展的 BYOK / custom endpoint 机制。Gemini 原生 API 路径同样受该通道可用性约束，微软调整 BYOK 政策或接口时可能受影响。如遇异常先用连接测试定位，并在设置中改走 OpenAI 兼容端点（如 OpenRouter）作为替代。

## 5. 本地 FIM 补全默认端点时效性存疑

`kodrix.tabCompletion.enabled` 默认关闭。开启且 `mode` 为 `fim` 时，默认请求 `https://api.deepseek.com/beta/fim/completions`（`extensions/kodrix-agent-os/src/shared/constants.ts` 的 `FIM_DEFAULT_ENDPOINT`）——"beta" 端点的存续不由 Kodrix 控制，可能已下线。

本轮已把这条路径从"写死且静默降级"改为可控可观测：

- `kodrix.tabCompletion.fimEndpoint` 可指向任意自建 FIM 服务（置空回退默认值）。
- `kodrix.tabCompletion.fimEnabled`（默认 `true`）可整体关闭 FIM 专线，只走模型通道。
- 失败不再被吞：失败原因与 HTTP 状态进 Kodrix 输出日志，并记入补全统计的 FIM 诊断（失败次数 / 跳过次数 / 最近一次状态与端点）；命中率按**实际产出通道**归因，不会把降级结果混计入 FIM。
- 端点返回 4xx（非 429）时本次会话内熔断该端点，不再逐次按键重试；5xx 与网络错误不熔断。

如果你只需要稳定体验，把 `kodrix.tabCompletion.fimEnabled` 设为 `false`，或直接把 `mode` 设为非 `fim`，改依赖 Copilot Inline 补全。

## 6. 扩展市场源为 Open VSX

`product.json` 的 `extensionsGallery` 指向 `https://open-vsx.org`。部分微软发布者或仅授权微软市场的扩展（如官方 Copilot 之外的专有扩展、Remote 系列的部分组件）可能无法安装或版本滞后。可在设置 `extensionsGallery` 层面了解限制，或从 Open VSX 寻找同类替代。

## 7. 迁移 / 导入的边界（非缺陷，请注意）

- 从 Cursor 导入**不迁移**其模型 API Key、对话历史与快捷键，需重新配置（见 [MIGRATION.md](../MIGRATION.md)）。
- Cursormini / 旧 Kodrix 的 `model_routes` 迁移会**直接写入**对应的 `chat.*` 模型设置项；若你在 Kodrix 中已手工配过路由，迁移可能覆盖，建议迁移后再核对一次。

## 隐私基线（供对照）

- 遥测默认关闭：`product.json` 无 `enableTelemetry` / `aiKey` 字段，不存在默认的运行时数据上报。
- 无崩溃上报端点。
- 出错时"复制脱敏诊断信息"仅包含版本号、平台与错误类型，不含密钥、工作区路径或对话内容。
- 云端模型的请求会发送到你选择的供应商服务器，调用可能产生费用——各供应商预设保存时会明确提示。
