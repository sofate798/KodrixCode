---
kind: external_dependency
name: Kodrix 扩展市场与下载源：Open VSX Registry
slug: open-vsx-registry
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
source_files:
    - product.json
---

### 身份
Kodrix 的扩展市场后端为 Eclipse Foundation 的 Open VSX Registry（`https://open-vsx.org/vscode/gallery`），而非 Visual Studio Marketplace。

### 在本仓库的作用
`product.json` 中 `extensionsGallery.serviceUrl / itemUrl / latestUrlTemplate / resourceUrlTemplate / extensionUrlTemplate` 全部指向 open-vsx.org，`linkProtectionTrustedDomains` 仅放行该域名；`builtInExtensionsEnabledWithAutoUpdates` 中的 `GitHub.copilot-chat` 即通过此通道拉取更新。

### 集成方式
- 扩展安装/更新走 Open VSX REST API（gallery + unpkg 资源模板）
- 受控列表 `extension-control/extensions.json` 托管在 `EclipseFdn/publish-extensions` 仓库
- 构建脚本 `scripts/sync-marketplace-catalog.mjs` 同步 marketplace catalog

### 稳定约束
- 扩展分发策略与 VSCodium 一致（README 明确说明以本地/Open VSX 配置为准）
- 某些上游扩展或市场条款可能限制其仅用于官方 Visual Studio Code，需留意许可证差异

验证 exact API/params 对照 Open VSX 官方文档。