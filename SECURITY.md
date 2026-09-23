# 安全策略

## 支持的版本

| 版本 | 是否支持 |
|------|----------|
| 1.x  | :white_check_mark: |

## 报告漏洞

**请勿**就安全漏洞开设公开的 GitHub Issue。

报告渠道：

- **Telegram私信**：https://t.me/KodrixCode?direct（优先）
- **GitHub Security Advisory**：若仓库已开启，可通过 Security Advisories 表单提交

若Telegram私信无法送达，请仅使用 GitHub Security Advisories，**不要**在公开 Issue 中粘贴利用细节。

### 报告请包含

1. 漏洞的清晰描述
2. 复现步骤
3. 受影响组件 / 版本
4. 潜在影响
5. 建议缓解措施（如有）

### 响应时限

| 阶段 | 目标 |
|------|------|
| 初步确认收到 | 48 小时内 |
| 确认与严重度评估 | 5 个工作日内 |
| Critical 补丁发布 | 7 天内 |
| High 补丁发布 | 14 天内 |
| 公开披露 | 补丁发布之后 |

### 范围

- Kodrix IDE（Electron 壳、基于 VS Code / VSCodium 的分支）
- Kodrix 扩展（`kodrix-local`、`kodrix-skills`、`kodrix-agent-os`）
- 本仓库的构建与 CI/CD 代码

Kodrix 特有面（非穷尽）：

- **BYOK / API Key** — 须走扩展 `SecretStorage`（`providerSecrets`），不得写入 `settings.json` 或提交进仓库
- **配置迁移** — `migrateConfig` / Cursor 导入（路径须落在用户主目录内；勿轻率覆盖用户密钥）
- **MCP** — `User/mcp.json` 与 MCP 服务器进程拉起
- **Agent OS 工具** — 代码库索引、ACP、检查点、命令执行 / Crew 等

### 不在范围

- 上游 VS Code — 请向 [Microsoft Security Response Center](https://msrc.microsoft.com) 报告
- 第三方 npm 依赖 — 使用 npm audit / 上游渠道
- 需物理接触或社会工程才能成立的问题

## 贡献者安全实践

1. 永不提交密钥 — 使用 SecretStorage 或环境变量
2. 优先 `child_process.spawn` + 参数数组 — 禁止拼接 shell 字符串
3. 校验路径，防目录穿越（尤其迁移 / Skill 安装 / MCP）
4. 网络请求与进程 stdout/stderr 须有超时与大小上限
5. 仔细审查 `product.json` — 其中配置了外部端点
6. 合并前运行 `npm audit` — PR 的 **security** job 对 **critical** 会失败拦截；**high** 可能仅告警不拦截
