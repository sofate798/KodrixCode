# Learning Engine 学习引擎

<cite>
**本文引用的文件**   
- [learningEngine.ts](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts)
- [semanticMemory.ts](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts)
- [learningRetrieval.ts](file://extensions/kodrix-agent-os/src/learning/learningRetrieval.ts)
- [sessionIndex.ts](file://extensions/kodrix-agent-os/src/learning/sessionIndex.ts)
- [paths.ts](file://extensions/kodrix-agent-os/src/paths.ts)
- [learning-dashboard.html](file://extensions/kodrix-agent-os/resources/learning-dashboard.html)
- [contextIntelligence.ts](file://extensions/kodrix-agent-os/src/context/contextIntelligence.ts)
- [ideaFlow.ts](file://extensions/kodrix-agent-os/src/experience/ideaFlow.ts)
- [projectMemory.ts](file://extensions/kodrix-agent-os/src/memory/projectMemory.ts)
- [specWorkbench.ts](file://extensions/kodrix-agent-os/src/spec/specWorkbench.ts)
- [specWorkflow.ts](file://extensions/kodrix-agent-os/src/spec/specWorkflow.ts)
- [repoWiki.ts](file://extensions/kodrix-agent-os/src/wiki/repoWiki.ts)
- [项目非常有必要新实现的核心功能总报告.md](file://docs/项目非常有必要新实现的核心功能总报告.md)
</cite>

## 更新摘要
**变更内容**
- 学习引擎采用 async/await 模式提升性能，避免阻塞主线程
- 语义索引操作改为异步执行，防止影响用户体验
- 学习仪表板新增编辑和删除功能，支持交互式知识管理
- 优化了索引重建和缓存机制，提升整体性能

## 目录
1. [引言](#引言)
2. [项目结构定位](#项目结构定位)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [关键流程与算法详解](#关键流程与算法详解)
6. [学习仪表盘与可视化](#学习仪表盘与可视化)
7. [数据存储结构与索引优化](#数据存储结构与索引优化)
8. [依赖关系分析](#依赖关系分析)
9. [性能与可扩展性](#性能与可扩展性)
10. [高级配置与调优](#高级配置与调优)
11. [故障排查指南](#故障排查指南)
12. [结论](#结论)

## 引言
Learning Engine 是 Kodrix 的"越用越聪明"学习系统，负责沉淀项目知识、自动分类、语义检索、权重衰减、指令同步以及学习仪表盘展示。它通过记录学习条目、构建本地向量索引、结合时间衰减进行相似检索，并将近期学习结果注入 Agent 指令，从而让后续对话和代码生成更贴合项目上下文。

根据仓库中的规划文档，Learning Engine 当前已闭环 TF-IDF 本地向量、余弦检索、时间衰减、自动分类、学习仪表盘与 Instructions 同步；下一步目标是升级为真实 embeddings 并增强交互式仪表盘能力。

**章节来源**
- [项目非常有必要新实现的核心功能总报告.md:21-44](file://docs/项目非常有必要新实现的核心功能总报告.md#L21-L44)

## 项目结构定位
Learning Engine 位于 `extensions/kodrix-agent-os/src/learning` 目录下，核心由以下模块组成：
- learningEngine：学习入口、日志持久化、Instructions 同步、仪表盘面板、统计摘要。
- learningRetrieval：启发式分类规则，用于 inferLearningCategory。
- semanticMemory：TF-IDF 向量化、余弦相似度、时间衰减、索引重建与统计。
- sessionIndex：会话学习统计索引，供仪表盘展示处理进度与洞察数量。

```mermaid
graph TB
LE["learningEngine.ts<br/>记录学习、仪表盘、统计"] --> LR["learningRetrieval.ts<br/>启发式分类"]
LE --> SM["semanticMemory.ts<br/>向量索引、语义检索、时间衰减"]
LE --> SI["sessionIndex.ts<br/>会话学习统计"]
CI["contextIntelligence.ts"] --> LE
IF["ideaFlow.ts"] --> LE
PM["projectMemory.ts"] --> LE
SW["specWorkbench.ts"] --> LE
SFW["specWorkflow.ts"] --> LE
RW["repoWiki.ts"] --> LE
```

**图表来源**
- [learningEngine.ts:1-432](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L1-L432)
- [learningRetrieval.ts:1-31](file://extensions/kodrix-agent-os/src/learning/learningRetrieval.ts#L1-L31)
- [semanticMemory.ts:1-379](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L1-L379)
- [sessionIndex.ts:1-63](file://extensions/kodrix-agent-os/src/learning/sessionIndex.ts#L1-L63)

**章节来源**
- [learningEngine.ts:1-432](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L1-L432)
- [learningRetrieval.ts:1-31](file://extensions/kodrix-agent-os/src/learning/learningRetrieval.ts#L1-L31)
- [semanticMemory.ts:1-379](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L1-L379)
- [sessionIndex.ts:1-63](file://extensions/kodrix-agent-os/src/learning/sessionIndex.ts#L1-L63)

## 核心组件
- 学习条目模型：包含 id、timestamp、source、category、content。
- 学习来源类型：manual、capture、session、wiki、spec、auto。
- 知识类别：architecture、convention、pattern、pitfall、preference、other。
- 学习日志：JSON Lines 格式，按行追加，超限后原子压缩保留最新 200 条。
- 语义索引：固定维度（128）的 TF-IDF 向量 + 余弦相似度，支持时间衰减。
- 会话索引：记录每个会话的处理数、洞察数等统计。
- 仪表盘：Webview 面板，展示学习条目、统计、本周新增、Memory 计数、语义向量数等。

**章节来源**
- [learningEngine.ts:27-36](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L27-L36)
- [learningEngine.ts:66-96](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L66-L96)
- [semanticMemory.ts:24-34](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L24-L34)
- [sessionIndex.ts:11-22](file://extensions/kodrix-agent-os/src/learning/sessionIndex.ts#L11-L22)

## 架构总览
Learning Engine 的整体数据流如下：
- 外部调用 recordLearning 写入学习日志。
- 同时构建语义向量索引（异步）。
- 限流同步 Instructions 文件，将近期学习注入 Agent 指令。
- 仪表盘读取日志、语义统计与会话统计，渲染可视化面板。
- 语义检索使用 TF-IDF 向量与时间衰减计算综合得分。

```mermaid
sequenceDiagram
participant Caller as "调用方"
participant LE as "learningEngine.recordLearning"
participant Log as "学习日志(JSONL)"
participant SM as "semanticMemory.indexLearningEntry"
participant Instr as "syncProjectInstructionsFile"
participant Panel as "showLearningDashboard"
Caller->>LE : recordLearning(content, options)
LE->>Log : appendLearningLog(entry)
LE->>SM : indexLearningEntry(entry) (异步)
LE->>Instr : scheduleSyncInstructions()
Panel->>Panel : pushLearningDashboard()
Panel-->>Caller : 仪表盘数据(entries, stats)
```

**图表来源**
- [learningEngine.ts:98-126](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L98-L126)
- [learningEngine.ts:128-157](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L128-L157)
- [learningEngine.ts:234-337](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L234-L337)
- [semanticMemory.ts:183-212](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L183-L212)

**章节来源**
- [learningEngine.ts:98-126](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L98-L126)
- [learningEngine.ts:234-337](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L234-L337)
- [semanticMemory.ts:183-212](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L183-L212)

## 关键流程与算法详解

### recordLearning 函数实现原理
recordLearning 是学习引擎的主入口，负责：
- 检查功能开关（kodrix.features.learning）。
- 生成唯一 id 与时间戳。
- 若未指定 category，则调用 inferLearningCategory 智能分类。
- 追加学习日志。
- 构建语义向量索引（异步，不阻塞写入）。
- 限流同步 Instructions 文件。
- 通知上下文变更并发布事件。

**更新** 现在使用 `void indexLearningEntry(entry)` 异步调用，避免阻塞主线程，提升响应性能。

```mermaid
flowchart TD
Start(["recordLearning 入口"]) --> CheckEnabled{"功能开启？"}
CheckEnabled --> |否| ReturnDisabled["返回禁用占位条目"]
CheckEnabled --> |是| BuildEntry["构造 LearningEntry<br/>id/timestamp/source/category/content"]
BuildEntry --> InferCat{"是否提供 category？"}
InferCat --> |否| Infer["inferLearningCategory(content)"]
InferCat --> |是| UseProvided["使用传入 category"]
Infer --> AppendLog["appendLearningLog(entry)"]
UseProvided --> AppendLog
AppendLog --> IndexVec["indexLearningEntry(entry) (异步)"]
IndexVec --> ScheduleSync["scheduleSyncInstructions()"]
ScheduleSync --> NotifyCtx["notifyContextChanged()"]
NotifyCtx --> EmitEvent["emitKodrixEvent('learning.recorded')"]
EmitEvent --> End(["返回 entry"])
```

**图表来源**
- [learningEngine.ts:98-126](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L98-L126)
- [learningRetrieval.ts:12-30](file://extensions/kodrix-agent-os/src/learning/learningRetrieval.ts#L12-L30)

**章节来源**
- [learningEngine.ts:98-126](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L98-L126)

### inferLearningCategory 智能分类算法
inferLearningCategory 基于正则匹配对内容进行启发式分类：
- architecture：架构、模块、分层、微服务、monorepo、设计模式等关键词。
- convention：命名、约定、规范、lint、eslint、prettier、风格等关键词。
- pitfall：陷阱、注意、avoid、don't、别用、坑、bug、issue、错误等关键词。
- preference：偏好、prefer、喜欢、习惯、favorite、default 等关键词。
- pattern：模式、pattern、repository、factory、singleton、hook、middleware、adapter 等关键词。
- other：默认类别。

该分类减少手动选择类别的摩擦，提升用户体验。

**章节来源**
- [learningRetrieval.ts:12-30](file://extensions/kodrix-agent-os/src/learning/learningRetrieval.ts#L12-L30)

### knowledgeScore 评分系统与 weightDecay 权重衰减策略
在语义检索中，score 由两部分组成：
- 相似度 sim：query 向量与 entry 向量的余弦相似度。
- 新鲜度 decay：基于时间的半衰期衰减，半衰期为 30 天。

综合得分公式为：
- score = sim * (0.7 + 0.3 * decay)

这意味着：
- 70% 取决于语义相似度。
- 30% 取决于时间新鲜度，越新的条目权重越高。
- 过滤阈值 > 0.05，避免低相关结果污染。

```mermaid
flowchart TD
Q["查询文本"] --> EncodeQ["encodeVector(query)"]
E["学习条目集合"] --> EncodeE["encodeVector(entry.content)"]
EncodeQ --> Cosine["cosineSimilarity(queryVec, entryVec)"]
EncodeE --> Cosine
Cosine --> Age["计算 age = now - timestamp"]
Age --> Decay["decay = 0.5^(age / halfLife)"]
Decay --> Score["score = sim * (0.7 + 0.3 * decay)"]
Score --> Filter{"score > 0.05 ?"}
Filter --> |是| Keep["加入候选集"]
Filter --> |否| Drop["丢弃"]
Keep --> Sort["按 score 降序排序"]
Sort --> TopK["取前 K 条"]
```

**图表来源**
- [semanticMemory.ts:225-275](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L225-L275)

**章节来源**
- [semanticMemory.ts:225-275](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L225-L275)

## 学习仪表盘与可视化
学习仪表盘通过 Webview 面板展示：
- 学习条目列表（entries）。
- 统计信息：totalEntries、sessionProcessed、semanticVectors、thisWeek、memoryCount。
- 交互命令：ready、refresh、capture、edit、delete。

**更新** 新增了编辑和删除功能，用户可以直接在仪表盘中修改或删除学习条目。

仪表盘数据来源：
- readLearningLog：读取学习日志。
- getLearningStats：统计总数与类别分布。
- getSemanticStats：语义向量统计。
- getSessionLearningStats：会话学习统计。
- readMemoryContent：Memory 计数。

```mermaid
sequenceDiagram
participant User as "用户"
participant Panel as "Learning Dashboard Webview"
participant LE as "learningEngine.pushLearningDashboard"
participant Log as "readLearningLog"
participant Stats as "getLearningStats"
participant Sem as "getSemanticStats"
participant Sess as "getSessionLearningStats"
participant Mem as "readMemoryContent"
User->>Panel : 打开仪表盘
Panel->>LE : postMessage('ready' | 'refresh' | 'edit' | 'delete')
LE->>Log : 读取学习条目
LE->>Stats : 获取统计
LE->>Sem : 获取语义统计
LE->>Sess : 获取会话统计
LE->>Mem : 获取 Memory 计数
LE-->>Panel : postMessage({type : 'dashboard', entries, stats})
```

**图表来源**
- [learningEngine.ts:234-337](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L234-L337)
- [learning-dashboard.html:394-614](file://extensions/kodrix-agent-os/resources/learning-dashboard.html#L394-L614)

**章节来源**
- [learningEngine.ts:234-337](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L234-L337)
- [learning-dashboard.html:394-614](file://extensions/kodrix-agent-os/resources/learning-dashboard.html#L394-L614)

### 仪表盘编辑和删除功能
**新增功能** 学习仪表表现在支持交互式编辑和删除学习条目：

- **编辑功能**：用户可以点击编辑按钮，直接修改学习条目的内容，保存后会自动重建索引并同步到 Instructions。
- **删除功能**：用户可以确认删除特定的学习条目，删除后会清理相关索引并刷新显示。
- **实时反馈**：所有操作都会立即反映在界面上，并提供相应的日志记录。

```mermaid
flowchart TD
EditClick["点击编辑按钮"] --> EditMode["进入编辑模式<br/>显示文本框"]
DeleteClick["点击删除按钮"] --> Confirm["确认删除对话框"]
EditMode --> SaveEdit["保存编辑"]
Confirm --> DeleteEntry["删除条目"]
SaveEdit --> UpdateLog["更新学习日志"]
DeleteEntry --> UpdateLog
UpdateLog --> RebuildIndex["重建索引"]
RebuildIndex --> RefreshUI["刷新界面"]
RefreshUI --> Complete["完成操作"]
```

**图表来源**
- [learningEngine.ts:286-291](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L286-L291)
- [learningEngine.ts:348-410](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L348-L410)
- [learning-dashboard.html:492-559](file://extensions/kodrix-agent-os/resources/learning-dashboard.html#L492-L559)

**章节来源**
- [learningEngine.ts:286-291](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L286-L291)
- [learningEngine.ts:348-410](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L348-L410)
- [learning-dashboard.html:492-559](file://extensions/kodrix-agent-os/resources/learning-dashboard.html#L492-L559)

## 数据存储结构与索引优化
- 学习日志：JSON Lines 格式，每行一个 LearningEntry。
- 语义索引：learning.vectors.json，存储 version、dim、entries（entryId → float32 vector）、updatedAt。
- 会话索引：sessions.json（路径由 getSessionIndexPath 提供），存储 SessionIndexEntry 数组。
- 缓存机制：语义记忆模块维护 EntryCache，基于 mtime 失效，避免重复读盘。
- 原子写入：atomicWriteFileSync 保证写入安全。
- 索引清理：saveIndex 会清理不在学习日志中的旧条目。

**更新** 现在所有索引操作都采用异步模式，避免阻塞主线程，提升整体性能。

```mermaid
erDiagram
LEARNING_ENTRY {
string id PK
string timestamp
string source
string category
string content
}
VECTOR_INDEX {
number version
number dim
map entries
string updatedAt
}
SESSION_INDEX_ENTRY {
string sessionId PK
string processedAt
number insightCount
number userMessages
string summary
}
LEARNING_ENTRY ||--o{ VECTOR_INDEX : "entryId -> vector"
SESSION_INDEX_ENTRY ||--|| SESSION_INDEX : "多个条目组成索引"
```

**图表来源**
- [learningEngine.ts:30-36](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L30-L36)
- [semanticMemory.ts:29-34](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L29-L34)
- [sessionIndex.ts:11-17](file://extensions/kodrix-agent-os/src/learning/sessionIndex.ts#L11-L17)

**章节来源**
- [learningEngine.ts:66-96](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L66-L96)
- [semanticMemory.ts:24-81](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L24-L81)
- [sessionIndex.ts:24-48](file://extensions/kodrix-agent-os/src/learning/sessionIndex.ts#L24-L48)

## 依赖关系分析
Learning Engine 被多个扩展模块调用，形成稳定的依赖关系：
- contextIntelligence：生成 Repo Wiki 时可触发 recordLearning。
- ideaFlow：经验流中记录学习条目。
- projectMemory：项目 Memory 捕获时调用 recordLearning。
- specWorkbench/specWorkflow：Spec 创建时记录架构类学习。
- repoWiki：Repo Wiki 更新时记录学习。

```mermaid
graph TB
CI["contextIntelligence.ts"] --> LE["learningEngine.ts"]
IF["ideaFlow.ts"] --> LE
PM["projectMemory.ts"] --> LE
SW["specWorkbench.ts"] --> LE
SFW["specWorkflow.ts"] --> LE
RW["repoWiki.ts"] --> LE
```

**图表来源**
- [contextIntelligence.ts:195](file://extensions/kodrix-agent-os/src/context/contextIntelligence.ts#L195)
- [ideaFlow.ts:902-907](file://extensions/kodrix-agent-os/src/experience/ideaFlow.ts#L902-L907)
- [projectMemory.ts:44-45](file://extensions/kodrix-agent-os/src/memory/projectMemory.ts#L44-L45)
- [specWorkbench.ts:81](file://extensions/kodrix-agent-os/src/spec/specWorkbench.ts#L81)
- [specWorkflow.ts:36](file://extensions/kodrix-agent-os/src/spec/specWorkflow.ts#L36)
- [repoWiki.ts:285-286](file://extensions/kodrix-agent-os/src/wiki/repoWiki.ts#L285-L286)

**章节来源**
- [contextIntelligence.ts:195](file://extensions/kodrix-agent-os/src/context/contextIntelligence.ts#L195)
- [ideaFlow.ts:902-907](file://extensions/kodrix-agent-os/src/experience/ideaFlow.ts#L902-L907)
- [projectMemory.ts:44-45](file://extensions/kodrix-agent-os/src/memory/projectMemory.ts#L44-L45)
- [specWorkbench.ts:81](file://extensions/kodrix-agent-os/src/spec/specWorkbench.ts#L81)
- [specWorkflow.ts:36](file://extensions/kodrix-agent-os/src/spec/specWorkflow.ts#L36)
- [repoWiki.ts:285-286](file://extensions/kodrix-agent-os/src/wiki/repoWiki.ts#L285-L286)

## 性能与可扩展性
- 向量维度固定为 128，降低内存占用与计算成本。
- 使用缓存 EntryCache 避免频繁读盘。
- 原子写入 atomicWriteFileSync 保证数据安全。
- 索引重建 rebuildIndex 批量处理所有学习条目。
- 仪表盘延迟初始化，避免阻塞扩展启动。
- **更新** 采用 async/await 模式，所有耗时操作都异步执行，不阻塞主线程。
- **更新** 语义索引操作改为异步，使用 `void indexLearningEntry(entry)` 避免等待。
- 未来可替换为真实 embeddings（本地 transformer 或 Copilot embeddings API），提升语义理解精度。

**章节来源**
- [semanticMemory.ts:24-34](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L24-L34)
- [semanticMemory.ts:87-128](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L87-L128)
- [semanticMemory.ts:215-236](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L215-L236)
- [learningEngine.ts:340-359](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L340-L359)
- [learningEngine.ts:121](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L121)
- [项目非常有必要新实现的核心功能总报告.md:38-44](file://docs/项目非常有必要新实现的核心功能总报告.md#L38-L44)

## 高级配置与调优
- 功能开关：
  - kodrix.features.learning：控制 Learning Engine 是否启用。
  - kodrix.features.semanticMemory：控制语义索引是否构建。
- 分类规则：
  - 可通过修改 inferLearningCategory 的正则表达式自定义分类规则。
- 检索参数：
  - searchSimilar 的 topK 控制返回条数。
  - halfLife 控制时间衰减速度（默认 30 天）。
  - score 阈值 0.05 控制过滤强度。
- 仪表盘：
  - 可通过 Webview 消息接口扩展交互命令。
  - 可调整 maxEntries 与 maxChars 控制摘要长度。
- **更新** 异步配置：
  - 所有索引操作现在都是异步的，可以通过 Promise 链处理完成状态。
  - 支持错误处理和超时机制。

**章节来源**
- [learningEngine.ts:102-103](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L102-L103)
- [semanticMemory.ts:133-134](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L133-L134)
- [semanticMemory.ts:225-275](file://extensions/kodrix-agent-os/src/learning/semanticMemory.ts#L225-L275)
- [learningRetrieval.ts:12-30](file://extensions/kodrix-agent-os/src/learning/learningRetrieval.ts#L12-L30)

## 故障排查指南
- 仪表盘 HTML 资源加载失败：
  - 回退到纯文本文档显示基础统计。
- 语义索引尚未构建：
  - 启动时延迟重建索引，避免阻塞扩展激活。
- 学习日志损坏：
  - 解析失败时跳过坏行，保证其他条目正常读取。
- 功能关闭：
  - recordLearning 返回禁用占位条目，不影响调用方逻辑。
- **更新** 异步操作问题：
  - 如果异步索引操作失败，不会影响主流程继续执行。
  - 错误会被记录到日志中，便于后续排查。
- **更新** 编辑删除功能问题：
  - 编辑失败时会保持原内容不变。
  - 删除操作有确认对话框，防止误删。

**章节来源**
- [learningEngine.ts:270-277](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L270-L277)
- [learningEngine.ts:348-359](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L348-L359)
- [learningEngine.ts:74-81](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L74-L81)
- [learningEngine.ts:102-111](file://extensions/kodrix-agent-os/src/learning/learningEngine.ts#L102-L111)

## 结论
Learning Engine 通过结构化学习日志、启发式分类、TF-IDF 向量与时间衰减的语义检索，实现了项目知识的自动沉淀与智能检索。其仪表盘提供了直观的可视化能力，帮助开发者监控学习行为与效果。

**更新亮点**：
- **性能优化**：全面采用 async/await 模式，所有耗时操作异步执行，显著提升响应性能。
- **用户体验**：学习仪表板新增编辑和删除功能，支持交互式知识管理。
- **稳定性提升**：异步操作确保即使索引构建失败也不会影响主流程。

未来升级至真实 embeddings 将进一步增强语义理解精度，而交互式仪表盘将提升用户操作体验。