---
kind: error_handling
name: Kodrix/VSCode 错误处理体系：统一异常类型、全局未捕获处理与结构化日志
category: error_handling
scope:
    - '**'
source_files:
    - src/vs/base/common/errors.ts
    - src/vs/base/common/assert.ts
    - src/vs/base/common/event.ts
    - src/vs/base/common/stream.ts
    - src/vs/base/common/webWorker.ts
    - src/bootstrap-fork.ts
    - src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts
    - src/vs/code/node/cliProcessMain.ts
    - src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts
    - src/vs/platform/log/common/log.ts
    - src/vs/platform/log/common/logService.ts
    - cli/src/log.rs
    - src/vs/platform/files/common/files.ts
    - src/vs/platform/extensionManagement/common/extensionManagement.ts
    - src/vs/platform/remote/common/remoteAuthorityResolver.ts
    - src/vs/platform/browserView/common/cdp/types.ts
---

## 1. 系统/方法概述

该仓库基于 VS Code 上游，采用 **分层错误处理** 架构：
- **核心异常类型**集中在 `src/vs/base/common/errors.ts`，提供 `CancellationError`、`ExpectedError`、`BugIndicatingError`、`ErrorNoTelemetry`、`PendingMigrationError`、`ReadonlyError`、`NotImplementedError`、`NotSupportedError` 等语义化错误类，以及 `isCancellationError`、`illegalArgument`、`illegalState`、`getErrorMessage` 等工具。
- **全局意外错误入口**通过 `ErrorHandler`（单例 `errorHandler`）暴露 `onUnexpectedError` / `onUnexpectedExternalError` / `setUnexpectedErrorHandler`，所有模块的“非预期”错误都经由此处上报，而非直接抛到进程顶层。
- **断言与 Bug 标记**在 `src/vs/base/common/assert.ts` 中实现：`assert` 抛出 `BugIndicatingError`，`softAssert` / `assertFn` 将断言失败转为 `onUnexpectedError(new BugIndicatingError(...))`，从而把“产品内部 bug”和“用户输入错误”区分开。
- **Promise 未处理拒绝与 uncaughtException** 在多个进程入口集中注册：`bootstrap-fork.ts`、`sharedProcessMain.ts`、`cliProcessMain.ts`、`parcelWatcher.ts` 等均使用 `process.on('uncaughtException', ...)` 与 `process.on('unhandledRejection', ...)` 统一转发到 `onUnexpectedError`，避免 Node.js 默认退出行为。
- **序列化/反序列化**：`transformErrorForSerialization` / `transformErrorFromSerialization` 支持跨进程传递 Error（含 `cause` 链与 `code`），并保留 `noTelemetry` 标记。
- **Rust CLI 侧**：`cli/src/log.rs` 定义 Level（Trace/Debug/Info/Warn/Error/Critical/Off）、`Logger`、`LogSink`（Stdio/File）、宏 `error!` / `info!` / `debug!` / `trace!` / `warning!`，并通过 `install_global_logger` 接入 Rust `log` crate；CLI 不依赖 JS 错误体系，但遵循相同分级理念。
- **日志子系统**：`src/vs/platform/log/common/log.ts` 定义 `LogLevel`、`ILogger`、`ILogService`、`AbstractLogger`、`ConsoleLogger`、`AdapterLogger`、`MultiplexLogger`、`NullLogger` 等，支持按资源/ID 创建 logger、动态调整级别、格式化 Error 为消息、将 console.* 转发到 log service。`LogService` 是 `Disposable` + `MultiplexLogger` 的组合。

## 2. 关键文件与包

- `src/vs/base/common/errors.ts` — 核心异常类型、取消错误、错误序列化、全局 `ErrorHandler`。
- `src/vs/base/common/assert.ts` — `assert` / `softAssert` / `assertFn` / `assertNever`。
- `src/vs/base/common/event.ts` — `ListenerLeakError`、`ListenerRefusalError`，并在事件监听器出错时调用 `onUnexpectedError`。
- `src/vs/base/common/stream.ts`、`webWorker.ts`、`dom.ts`、`markdownRenderer.ts`、`trustedTypes.ts` 等 — 在各基础设施层兜底 `.catch(onUnexpectedError)`。
- `src/bootstrap-fork.ts`、`src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts`、`src/vs/code/node/cliProcessMain.ts`、`src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts` — 进程级 `uncaughtException` / `unhandledRejection` 处理器。
- `src/vs/platform/log/common/log.ts`、`src/vs/platform/log/common/logService.ts` — 日志接口、抽象实现、控制台/适配器/多路复用 logger。
- `cli/src/log.rs` — Rust CLI 日志与级别体系。
- 各平台 `platform/*` 子模块中的领域错误类（如 `FileSystemProviderError`、`FileOperationError`、`ExtensionManagementError`、`RemoteAuthorityResolverError`、`CopilotApiError`、`CDPError` 族、`ProtocolError` 等）。

## 3. 架构与约定

1. **错误分类**
   - **业务可恢复错误**：返回 `Result`/`Promise.reject`，由调用方决定重试或降级。
   - **取消信号**：统一抛 `CancellationError`，并通过 `isCancellationError` 判断；`onUnexpectedError` 会忽略取消错误，避免噪音。
   - **期望内错误**：用 `ExpectedError`（带 `isExpected = true`）或 `ErrorNoTelemetry`（name=`CodeExpectedError`）包装，表示不应被当作遥测异常上报。
   - **产品内部 bug**：抛 `BugIndicatingError`，仅用于“代码逻辑不可能到达的路径”，配合 `assert` / `softAssert` 使用。
   - **参数/状态非法**：使用 `illegalArgument` / `illegalState` 工厂函数生成标准 `Error`。

2. **传播策略**
   - 异步链路普遍以 `.catch(onUnexpectedError)` 收尾，确保 Promise 拒绝不会静默丢失也不会触发进程崩溃。
   - 事件系统（`Event`）在 listener 抛错时调用 `onUnexpectedError`，防止单个 listener 破坏事件总线。
   - IPC、stream、DOM 等底层操作在 catch 分支统一走 `onUnexpectedError`，上层无需重复处理。

3. **跨进程/跨语言边界**
   - JS 侧通过 `SerializedError` 结构（`$isError`、`name`、`message`、`stack`、`noTelemetry`、`code`、`cause`）进行序列化传输。
   - Rust CLI 独立日志体系，不混用 JS Error；但同样采用分级（Trace→Critical）+ sink 模式，便于调试。

4. **日志与错误关联**
   - `ILogger.error` 接受 `string | Error`，若传入 Error 则自动提取 stack 输出。
   - `format` 会把 Error 通过 `toErrorMessage` 转成字符串，再 JSON 序列化对象字段。
   - 可通过 `registerDevConsoleLogForwarder` 把 `console.*` 转发到 log service，方便开发期定位问题。

## 4. 约定与约束

- **禁止随意 throw new Error**：应优先使用 `errors.ts` 提供的语义化错误类或工厂函数；仅在扩展/第三方库边界才允许裸 Error。
- **取消必须用 CancellationError**：任何可取消操作（网络请求、命令执行、watcher 更新）都应抛 `CancellationError`，以便上层统一识别。
- **断言失败不抛普通 Error**：`assert` 抛 `BugIndicatingError`，`softAssert` 走 `onUnexpectedError`，保证“bug”路径可被单独追踪。
- **不要吞掉未处理的 Promise 拒绝**：所有未显式 `.catch` 的 Promise 最终都会走到 `unhandledRejection` 处理器 → `onUnexpectedError`，因此不要在顶层 try/catch 里静默吞错。
- **遥测敏感错误用 ErrorNoTelemetry**：对已知预期但需要记录上下文的错误，用 `ErrorNoTelemetry.fromError` 包装，避免污染遥测指标。
- **Rust CLI 不使用 JS 错误体系**：CLI 通过 `log::Level` 与 `Logger.emit` 输出，错误通过返回值或 `panic!`（结合 `install_global_logger` 的日志输出）表达，与 JS 侧解耦。
- **日志级别严格受控**：`LogLevel` 枚举（Trace/Debug/Info/Warning/Error/Off）由 `AbstractLogger.checkLogLevel` 控制，所有 logger 实现必须遵循该过滤逻辑；`parseLogLevel` 只认 `trace/debug/info/warn/error/critical/off` 这些字符串。
- **领域错误按模块组织**：文件系统错误在 `platform/files`、扩展管理错误在 `platform/extensionManagement`、远程解析错误在 `platform/remote`、CDP 错误在 `platform/browserView` 等，每个模块定义自己的 `*Error extends Error` 子类，保持命名空间清晰。