---
kind: design
name: 三扩展测试统一采用独立 mocha 运行器并接入 npm run test
source: session
category: adr
---

# 三扩展测试统一采用独立 mocha 运行器并接入 npm run test

_来源：92c4522 → b16b3f1 提交周期内记录的编码计划——内容为规划时意图，实现可能滞后或有出入。_

**状态：** accepted

## 背景
三个 kodrix 扩展已有测试目录但未被集成到构建/CI 流程中，缺少统一的测试入口和脚本，导致测试无法被常规命令触发。

## 决策驱动
- 与 VS Code git 扩展一致的测试模式便于复用
- 每个扩展独立运行避免耦合
- 通过 package.json 的 npm run test 提供统一入口

## 备选方案
- **各扩展独立 mocha 运行器 + npm run test** — 优点：隔离性好、可单独调试、与 VS Code 官方扩展模式一致
- **单一共享测试套件聚合运行** _（已否决）_ — 优点：集中管理；缺点：扩展间耦合、失败定位困难、启动开销大

## 决策
为每个扩展创建独立的测试入口文件和基础用例，覆盖关键路径（codebase 参与者、检查点回滚、ACP 流式、BYOK 注册、Skill 安装/卸载等），并在各自 package.json 中添加 npm run test 脚本调用 mocha 运行器。

## 影响
新增功能需配套同目录测试；CI 可通过遍历 extensions 目录逐个执行 npm run test 实现全量回归。