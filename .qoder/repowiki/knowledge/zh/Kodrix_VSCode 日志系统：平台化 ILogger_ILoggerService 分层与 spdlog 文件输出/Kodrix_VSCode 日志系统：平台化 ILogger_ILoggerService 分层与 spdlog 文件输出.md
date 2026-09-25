---
kind: logging_system
name: Kodrix/VSCode 日志系统：平台化 ILogger/ILoggerService 分层与 spdlog 文件输出
category: logging_system
scope:
    - '**'
source_files:
    - src/vs/platform/log/common/log.ts
    - src/vs/platform/log/common/logService.ts
    - src/vs/platform/log/node/loggerService.ts
    - src/vs/platform/log/node/spdlogLog.ts
    - src/vs/platform/log/electron-main/loggerService.ts
    - src/vs/platform/log/browser/log.ts
    - src/vs/code/electron-main/main.ts
---

## 1. 使用的系统与框架

Kodrix 发行版直接沿用 VS Code 上游的日志子系统，位于 `src/vs/platform/log/`。核心由 TypeScript 抽象层 + Node.js 端原生 `@vscode/spdlog` 绑定组成，并在 Electron main、Node（remote）、Browser 三个运行环境分别提供实现。

- 抽象接口定义在 `src/vs/platform/log/common/log.ts`，暴露 `LogLevel` 枚举、`ILogger` / `ILogService` / `ILoggerService` 装饰器、`AbstractLogger` / `AbstractMessageLogger` / `AbstractLoggerService` 基类以及 `ConsoleMainLogger`、`ConsoleLogger`、`AdapterLogger`、`MultiplexLogger`、`NullLogger`、`NullLogService` 等内置 sink。
- Node 端实际落盘通过 `src/vs/platform/log/node/spdlogLog.ts` 中的 `SpdLogLogger` 调用 `@vscode/spdlog` 的异步旋转日志（rotating logger）。
- Electron main 进程通过 `src/vs/platform/log/electron-main/loggerService.ts` 的 `LoggerMainService` 对 `LoggerService` 做窗口级过滤，并配合 IPC (`logIpc.ts`) 把日志事件广播给渲染进程。
- Browser 端在 `src/vs/platform/log/browser/log.ts` 中提供 `ConsoleLogInAutomationLogger`，将日志转发到自动化宿主（如 Playwright）的 `codeAutomationLog`。

## 2. 关键文件

- `src/vs/platform/log/common/log.ts` — 所有公共类型、`LogLevel`、`format`、`canLog`、`getLogLevel`、`parseLogLevel`、`LogLevelToString`、`CONTEXT_LOG_LEVEL` 上下文键、`AbstractLogger` / `AbstractMessageLogger` / `AbstractLoggerService`、内置 Logger 实现。
- `src/vs/platform/log/common/logService.ts` — `LogService`，用 `MultiplexLogger` 组合 primary + other loggers，是工作区代码最常注入的 `ILogService`。
- `src/vs/platform/log/node/loggerService.ts` — `LoggerService.doCreateLogger` 返回 `SpdLogLogger`。
- `src/vs/platform/log/node/spdlogLog.ts` — 基于 `@vscode/spdlog` 的旋转日志实现，默认每文件 30MB、最多 6 个轮转文件；格式模式为 `%Y-%m-%d %H:%M:%S.%e [%l] %v`。
- `src/vs/platform/log/electron-main/loggerService.ts` — `LoggerMainService`，按 windowId 过滤日志资源变更事件，并提供 `getGlobalLoggers()`。
- `src/vs/platform/log/electron-main/logIpc.ts` — 主进程与渲染进程之间的日志事件通道。
- `src/vs/platform/log/browser/log.ts` — Web 环境下获取日志内容（IndexedDB/fileService）及自动化日志适配器。
- `src/vs/code/electron-main/main.ts` — 应用启动时构造 `LoggerMainService` → `BufferLogger` → `ConsoleMainLogger` → `LogService` 的链，并注册到 DI 容器。

## 3. 架构与约定

### 3.1 分层结构

```
common/log.ts (抽象 + 内置 sink)
├── node/loggerService.ts (创建 SpdLogLogger)
│   └── node/spdlogLog.ts (@vscode/spdlog 旋转文件)
├── electron-main/loggerService.ts (按 windowId 过滤 + IPC)
└── browser/log.ts (Web/自动化适配)
```

- `ILogger` 是所有 sink 的统一契约（trace/debug/info/warn/error/flush），`AbstractLogger` 负责级别过滤与 `onDidChangeLogLevel` 事件，`AbstractMessageLogger` 统一格式化 message+args。
- `ILoggerService` 管理多个命名/URI 标识的 logger，支持按 resource 或 id 创建、设置独立 level、visibility、when 条件、extensionId、group 等元数据。
- `LogService` 是面向业务代码的单一入口，内部用 `MultiplexLogger` 把主 sink 和附加 sink（如 console）合并。

### 3.2 级别策略

`LogLevel` 枚举顺序即优先级：

| 值 | 含义 | CLI 字符串 |
|---|---|---|
| Off | 关闭 | off |
| Trace | 最详细 | trace |
| Debug | 调试 | debug |
| Info | 默认 | info |
| Warning | 警告 | warn |
| Error | 错误 | error / critical |

- `DEFAULT_LOG_LEVEL = LogLevel.Info`。
- `getLogLevel(environmentService)` 优先取 `environmentService.verbose` → `Trace`，否则解析 `environmentService.logLevel` 字符串，最后回退到 `Info`。
- `parseLogLevel` 额外接受 `critical` 并映射为 `Error`。
- `canLog(loggerLevel, messageLevel)` 仅在 `loggerLevel !== Off && loggerLevel <= messageLevel` 时放行。

### 3.3 输出格式

- Node 端 `SpdLogLogger` 使用 spdlog pattern `%Y-%m-%d %H:%M:%S.%e [%l] %v`，其中 `%e` 是毫秒精度时间戳，`%l` 是级别名，`%v` 是格式化后的消息。
- Electron main 控制台 sink `ConsoleMainLogger` 前缀 `[main ${now()}]`，非 Windows 下带 ANSI 颜色。
- `format(args)` 会把 `Error` 对象转为 `toErrorMessage` 字符串，其他 object 尝试 `JSON.stringify`，其余原样拼接。

### 3.4 文件轮转

`SpdLogLogger` 根据 `rotating` 标志决定文件数：
- rotating=true：filecount=6，filesize=(30/6) MB ≈ 5MB/文件。
- rotating=false：filecount=1，filesize=30MB。
- 可通过 `ILoggerOptions.donotRotate` 禁用轮转，`donotUseFormatters` 清空 spdlog formatter。

### 3.5 多运行环境装配

Electron main 启动链（`src/vs/code/electron-main/main.ts`）：
1. 从 `environmentMainService` 读取 `getLogLevel()`。
2. 创建 `LoggerMainService(logLevel, logsHome)`。
3. 创建 `BufferLogger` 缓冲早期日志。
4. 创建 `ConsoleMainLogger` 作为控制台 sink。
5. 组装 `new LogService(bufferLogger, [new ConsoleMainLogger(...)])` 并注入 `ILogService`。

## 4. 约定与约束

- **消费方只依赖 `ILogService`**：业务模块通过 `@ILogService` 装饰器注入，不直接访问 spdlog 或文件路径。
- **日志级别必须来自 `LogLevel` 枚举**：`canLog` 与 switch 分支覆盖全部枚举值，未知值抛错（`Invalid log level`）。
- **CLI 参数名固定**：`--verbose` 强制 Trace，`--log-level <string>` 通过 `parseLogLevel` 解析，支持 trace/debug/info/warn/error/critical/off。
- **日志目录由 `IEnvironmentService.logsHome` 决定**：`AbstractLoggerService.toResource` 将 id 规范化后拼接到 `logsHome` 下生成 `.log` 文件。
- **每个 logger 可独立配置**：`ILoggerOptions` 支持 `id`、`name`、`donotRotate`、`donotUseFormatters`、`logLevel: 'always' | LogLevel`、`hidden`、`when`、`extensionId`、`group`。
- **浏览器环境不写磁盘**：browser 侧仅提供 `getLogs(fileService, environmentService)` 递归收集日志树供 CI 持久化。
- **开发期 console 转发**：`registerDevConsoleLogForwarder` 可把 `console.debug/info/warn/error/log` 转发到 `ILogService`，但 `isDevConsoleLogForwardingEnabled` 默认 false，且注释明确“done weirdly so that a lint warning prevents you from pushing this”。
- **ContextKey 集成**：`CONTEXT_LOG_LEVEL` 暴露当前全局 log level 给 UI 状态机。
- **测试桩**：`NullLogger` / `NullLogService` / `NullLoggerService` 用于单元测试，不产生任何输出。