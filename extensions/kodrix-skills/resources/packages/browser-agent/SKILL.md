---
name: browser-agent
description: >-
  Browser Agent for UI verification. Use when testing web apps, verifying frontend
  changes, taking screenshots, or validating pages in Simple Browser / Playwright MCP.
---

# Browser Agent

Qoder / Trae 风格浏览器 Agent Skill。

## When to use

- 构建完成后验证 UI
- 前端功能回归测试
- 检查 localhost 预览页面

## Workflow

1. 启动 dev server（`npm run dev` 等）
2. 打开 Simple Browser：执行 `simpleBrowser.show`（或命令面板搜索 "Simple Browser"）
3. 描述期望行为，Agent 结合终端与浏览器验证

## MCP 集成

若已配置 Playwright MCP，优先使用 MCP 工具进行截图与 DOM 检查。

## Commands

- `simpleBrowser.show`（打开 Simple Browser 预览）
- 预览 URL 通常为 `http://localhost:5173`（Vite）或模板 `run_port`
