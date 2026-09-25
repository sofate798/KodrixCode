---
kind: design
name: 三扩展统一采用 VS Code NLS 机制实现国际化
source: session
category: adr
---

# 三扩展统一采用 VS Code NLS 机制实现国际化

_来源：92c4522 → b16b3f1 提交周期内记录的编码计划——内容为规划时意图，实现可能滞后或有出入。_

**状态：** accepted

## 背景
kodrix-agent-os、kodrix-local、kodrix-skills 三个扩展的用户界面文案（commands、configuration descriptions、views、webview）全部硬编码为中文，缺乏多语言支持；同时 TypeScript 源码中 ~210+ 处用户面字符串直接以字面量形式出现。

## 决策驱动
- VS Code 官方 i18n 标准兼容性
- 降低后续新增语言的翻译成本
- 保持 LLM 系统提示词中文不变以减少推理偏差

## 备选方案
- **使用 VS Code NLS（package.nls.json + l10n.t()）** — 优点：与 VS Code 生态一致、零运行时依赖、工具链自动校验 key 一致性
- **自建 i18n 框架或引入第三方库** _（已否决）_ — 优点：可定制性强；缺点：增加依赖和维护成本、与 VS Code 体验不一致

## 决策
为 kodrix-agent-os、kodrix-local、kodrix-skills 分别创建 package.nls.json 英文基线与 package.nls.zh-cn.json 中文翻译，将 package.json 中的用户面文案替换为 %key% 引用，并在 TS 源码中以 l10n.t() 包裹所有用户可见字符串；LLM 系统提示词保持中文不纳入国际化范围。

## 影响
新增语言只需维护对应 .nls.*.json 文件；未来新增命令/配置项必须遵循同样的 key 命名与包裹规范，否则 tsc --noEmit 与 NLS 验证会暴露遗漏。