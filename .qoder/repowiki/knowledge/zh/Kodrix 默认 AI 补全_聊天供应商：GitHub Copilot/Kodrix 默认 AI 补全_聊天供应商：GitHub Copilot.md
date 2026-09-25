---
kind: external_dependency
name: Kodrix 默认 AI 补全/聊天供应商：GitHub Copilot
slug: github-copilot
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
source_files:
    - product.json
---

### 身份
Kodrix 将 GitHub Copilot（`GitHub.copilot`）作为默认 inline 补全提供者，`GitHub.copilot-chat` 作为默认 Chat 面板提供方；二者均被标记为内置扩展并启用自动更新。

### 在本仓库的作用
- `defaultChatAgent` 指定 `extensionId=GitHub.copilot`、`chatExtensionId=GitHub.copilot-chat`
- `extensionEnabledApiProposals` 为 copilot-chat 开放大量提案能力（`embeddings`、`chatProvider`、`languageModelSystem`、`mcpServerDefinitions`、`toolInvocationApproveCombination` 等）
- `trustedExtensionAuthAccess` 授权 copilot-chat/copilot 使用 `github` / `github-enterprise` 认证
- 产品级 URL 指向 GitHub Copilot 官方文档/隐私/计划页面

### 认证协议
- 默认 provider 为 `github`，企业模式为 `github-enterprise`（`providerUriSetting=github-enterprise.uri`）
- 同时支持 Google、Apple、Microsoft 作为可选 provider
- scopes 包含 `read:user`、`user:email`、`repo`、`workflow` 等
- 配额/许可校验走 `api.github.com/copilot_internal/*` 端点（entitlement/signup/token/managed_settings/mcp_registry）

### 稳定约束
- 基线提示中明确「模型路由」支持多供应商预设（13 个）与 BYOK，但 Copilot 是默认值
- 扩展层 `kodrix-local` 提供模型供应商选择 UI，覆盖 product.json 默认值

验证 exact API/params 对照 GitHub Copilot 官方文档。