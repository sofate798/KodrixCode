---
name: one-click-deploy
description: >-
  One-click deploy for web apps. Use when deploying to Vercel, Netlify, GitHub Pages,
  or cloud platforms after the build completes.
---

# One-Click Deploy

Kodrix 一键部署 Skill。

## Supported targets

| 平台 | 命令 |
|------|------|
| Vercel | `npx vercel --prod` |
| Netlify | `npx netlify deploy --prod` |
| GitHub Pages | `npm run build` + gh-pages |
| Static | 上传 `dist/` 目录 |

## Workflow

1. 确认 `npm run build` 通过
2. 检查环境变量与 API Key
3. 执行部署命令
4. 返回部署 URL 并在 Simple Browser 验证

## Agent 提示

部署前请确认：
- 构建产物目录（dist / build）
- 环境变量已配置
- 无 secrets 泄露到仓库
