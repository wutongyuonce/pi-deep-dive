# AgentHarness 生命周期

`AgentHarness` 是底层 agent 循环之上的编排层。它负责 session 持久化、运行时配置、资源解析、操作锁定和面向扩展的变更语义。

本文档描述当前方向和已实现的行为。部分扩展/session 门面细节是规划中的，会明确标注。

## 最终生命周期目标

Harness 监听器和 hook 应该能够闭包捕获 `AgentHarness` 实例，并在任何文档中标注为允许的事件中调用公共 harness API。这些调用不得破坏进行中的 turn 快照、重排持久化的 transcript 条目、丢失待写入数据、导致 settlement 死锁，或使 harness 处于错误的 phase。

预期规则：

- 结构性操作在 busy 时仍被拒绝
- 队列操作在文档标注的 turn 安全点被接受
- 运行时配置 setter 更新未来快照，不变更当前 provider 请求
- busy 期间的 session 写入被持久排队，按确定性顺序刷新
- getter 返回最新 harness 配置，而非进行中的快照
- 监听器/hook 当前没有门面；如果它们闭包捕获了原始 harness 并在活跃运行期间调用 `waitForIdle()` 等 settlement API，可能死锁。未来的门面应暴露 `runWhenIdle()` 代替。

`AssistantMessageStream` 已将 provider 传输流（如 SSE 或 websocket 读取）与下游事件消费解耦。因此 harness 可以 await 监听器、扩展 hook、持久化和 save-point 工作，而不会阻塞 provider 传输读取器或重新引入临时事件队列。生命周期代码应优先在 harness 边界使用显式 await 顺序，而非 fire-and-forget 的 hook/事件 settlement。

最终的生命周期加固应通过广泛的监听器/hook 重入测试套件来验证这些保证。

## 错误处理

当前的分层：

- 底层能力和辅助函数使用 `Result<TValue, TError>`，预期失败被封装且不得抛异常，如 `ExecutionEnv`、文件系统/shell 操作、shell 输出捕获、资源加载和 compaction 辅助函数
- 高层变更/编排 API（如 `Session` 和 `AgentHarness`）使用 reject/throw，而非返回可被忽略的裸 result
- 公共 `AgentHarness` 失败在实际可行时被规范化为 `AgentHarnessError`；子系统错误作为 `cause` 保留

Harness 事件观察已提交的状态。公共变更器在实际可行时，在提交前验证必需的输入和持久化，然后 await 通知。如果 hook 或订阅者在提交后失败，状态变更不会回滚，公共方法以 `AgentHarnessError` code `"hook"` reject。

## 状态模型

Harness 将状态分为四类。

### Harness 配置

Harness 配置是应用或扩展设置的最新运行时配置：

- 模型
- 推理级别
- 工具
- 活跃工具名
- 资源
- 流选项
- system prompt 或 system prompt 提供者

Getter 返回 harness 配置。它们不返回进行中的 provider 请求使用的快照。

Setter 立即更新 harness 配置，包括在 turn 进行中。变更影响下一个 turn 快照，而非当前运行的 provider 请求。

`setResources()` 接受具体资源，每次调用时发射 `resources_update`，携带当前和先前资源的浅拷贝。应用负责从磁盘或其他来源加载/重载资源，应使用新值调用 `setResources()`。

`getResources()` 返回浅拷贝的当前资源。它是实时配置读取，而非最后一个 turn 快照。

### Turn 快照

Turn 快照是用于一次 LLM turn 的具体状态。由 `createTurnState()` 创建，包含：

- 持久化的 session 消息
- 解析后的资源
- 解析后的 system prompt
- 模型
- 推理级别
- 所有工具
- 活跃工具
- 流选项
- 派生的 session id

静态选项值直接使用。System prompt 提供者回调每次 `createTurnState()` 调用时被调用一次。该 turn 的所有逻辑使用同一快照。

创建快照时资源数组被浅拷贝。各个 skill 和 prompt template 对象不会深拷贝。

创建快照时流选项被浅拷贝。`headers` 和 `metadata` 映射被浅拷贝；其值不会深拷贝。来自 `getApiKeyAndHeaders()` 的凭据在每次 provider 请求时解析，以便过期 token 可以刷新，但配置的流选项和派生的 session id 来自当前 turn 快照。

### Session

Session 仅包含持久化的条目。Session 读取返回持久化状态，不包含排队的写入。

Session 存储实现必须将 leaf 变更作为 `leaf` 条目持久化。`setLeafId()` 不是仅内存的游标更新；它追加一个持久条目，其 `targetId` 是活跃的树叶子节点或 `null` 表示根。重新打开存储必须从最新的影响 leaf 的持久条目重建当前 leaf。

### 待处理的 session 写入

在操作活跃期间请求的 session 写入被排队为待处理的 session 写入。待处理写入基于 session 条目形状，不含生成字段（`id`、`parentId`、`timestamp`）。

待处理的 session 写入总是被持久化。它们在 save point、操作 settlement 和失败清理时被刷新。

公共的 pending-writes/session 门面 API 已规划但尚未实现。

## 操作阶段

Harness 有明确的阶段：

```ts
type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
```

结构性操作要求 `phase === "idle"`，并在第一个 `await` 之前同步设置阶段：

- `prompt`
- `skill`
- `promptFromTemplate`
- `compact`
- `navigateTree`

在 harness 不 idle 时启动另一个结构性操作，以 `AgentHarnessError` code `"busy"` 拒绝。

以下操作在 turn 期间被允许（适当时）：

- `steer`
- `followUp`
- `nextTurn`
- `abort`
- 运行时配置 setter

Phase/settlement 语义仍是临时的，需要完整的生命周期审查。

## Turn 执行

`prompt`、`skill` 和 `promptFromTemplate` 遵循相同流程：

1. 断言 idle 并设置 phase 为 `"turn"`
2. 用 `createTurnState()` 创建 turn 快照
3. 从该快照派生调用文本
4. 用 `executeTurn()` 执行 turn

`skill` 和 `promptFromTemplate` 从传给 turn 的同一快照解析资源。它们不会单独解析资源。

`steer`、`followUp` 和 `nextTurn` 接受文本加可选图片，内部创建用户消息。`nextTurn` 消息在下次用户发起的 turn 中插入到新用户消息之前。

队列模式是实时的，非 turn 快照化的：

- `getSteeringMode()` / `setSteeringMode()`
- `getFollowUpMode()` / `setFollowUpMode()`

运行期间更改队列模式影响下次队列排空。队列排空发生在安全点。

## Save Point

Save point 发生在 assistant turn 及其 tool-result 消息完成之后。

在 save point，harness：

1. 在 agent 发射的消息之后刷新待处理的 session 写入
2. 如果底层循环可能继续，创建新的 turn 快照
3. 在下一个 provider 请求之前应用新的 context/model/thinking-level/stream-options/session-id 状态

这让在 turn 期间做出的模型、推理级别、工具、资源、流选项和 system prompt 变更能影响同一运行中的下一个 turn，同时绝不修改进行中的 provider 请求。因为 provider 传输读取已被 `AssistantMessageStream` 解耦，save-point 工作和 hook settlement 可以直接 await 以保持 transcript/session 排序确定性。循环回调不会在 save point 重建。

底层循环在 provider 边界将 harness `ThinkingLevel` 转换为 provider `reasoning`：

- `"off"` -> `undefined`
- 所有其他 thinking level 直接传递

除了刷新剩余的待处理 session 写入和清除操作阶段外，`agent_end` 不需要状态刷新。确切的 `settled` 事件时序仍在审查中。

如果 system prompt 回调在启动 `prompt`、`skill` 或 `promptFromTemplate` 时抛出，操作以 `AgentHarnessError` reject，harness 返回 idle。如果它从 `prepareNextTurn` 创建的 save-point 快照抛出，底层 agent 运行记录一条 assistant 错误消息。

## Hook 和事件

目标 hook 系统在 [hooks.md](./hooks.md) 中描述。

概述：

- `AgentHarness` 发射类型化的 hook 事件并消费类型化的结果
- 单一的 hooks 实现负责注册、清理、来源追踪和结果归约器
- 观察性和变更 hook 使用一个事件特定的 `on()` API；事件结果类型决定处理器是否可返回结果
- 产出结果的事件由类型化的归约器表归约；应用特定 hook 仅为应用特定的结果产出事件添加归约器
- Hook 注册来源追踪是注册上的伴生元数据。资源和工具来源追踪属于应用特定的具体值类型
- Hook 上下文应是门面的普通对象，而非原始内部对象或延迟绑定的 getter 迷宫

事件载荷描述正在发生的事。Harness getter 描述未来快照的最新配置。Hook 和 listener settlement 应尽可能按生命周期顺序 await；传输背压由 harness 之下的 `AssistantMessageStream` 处理，因此 harness 不需要单独的异步事件队列来保持 SSE 或 websocket 读取流动。

## 规划中的 session 门面

扩展最终应与 harness 作用域的 `HarnessSession` 门面交互，而非原始 session。门面应包装内部 session 并强制执行 harness pending-write 排序语义。一旦实现，hook 和事件监听器可以接收暴露完整 `AgentHarness` 加 session 门面的上下文，而无需直接访问无序的原始 session 写入。

规划的读取语义：

- 读取委托给持久化的 session 状态
- 读取不包含排队的待处理写入

规划的写入语义：

- idle：立即持久化
- busy：作为待处理 session 写入入队

规划的诊断 API 可能显式暴露待处理写入：

```ts
getPendingWrites(): readonly PendingSessionWrite[]
```

Agent 发射的消息在 `message_end` 时持久化以保持 transcript 排序。待处理的扩展/session 写入在 save point 这些消息之后刷新。

## 中止

中止在 turn 期间被允许。它中止底层运行并清除 steering/follow-up 队列。

中止不清除 `nextTurn` 消息。通过 `nextTurn()` 排队的消息在中止后存活，在下次用户发起的 turn 中插入到用户消息之前。

中止不丢弃待处理的 session 写入。如果达到，待处理写入在下一个 save point、`agent_end` 或操作失败清理时刷新。

中止屏障语义仍需审计。

## Compaction 和树导航

Compaction 和树导航是结构性 session 变更。

它们只在 idle 时被允许，不会被排队。它们操作持久化的 session 状态。下一个 prompt 创建新的 turn 快照。

分支总结生成是树导航操作的一部分。

自动 compaction 和重试决策点尚未在 `AgentHarness` 中实现。

## 测试组织

Harness 测试应按领域保持专注，而非增长为一个大而全的文件。

当前结构：

- `packages/agent/test/harness/agent-harness.test.ts`：核心生命周期和公共 API 行为
- `packages/agent/test/harness/agent-harness-stream.test.ts`：流选项和 provider hook 语义

理想的未来结构：

- `agent-harness-resources.test.ts`：资源快照/加载语义
- `agent-harness-tools.test.ts`：工具注册表 getter、活跃工具语义和更新事件
- `agent-harness-lifecycle.test.ts`：phase/save-point/settled/重入行为

使用 `pi-ai` 的 faux provider（`registerFauxProvider`、`fauxAssistantMessage`）进行确定性的 harness/provider 测试。Faux 响应工厂可以检查 `StreamOptions`、调用 `options.onPayload`，并返回脚本化的 assistant 消息，无需真实 provider API 或网络访问。

Harness 覆盖率配置独立于默认包测试运行：

```bash
npm run test:harness
npm run coverage:harness
```

`coverage:harness` 运行 `test/harness/**/*.test.ts`，报告 `src/harness/**/*.ts` 及其直接使用的非 harness 运行时文件（`src/agent.ts` 和 `src/agent-loop.ts`）的覆盖率到 `coverage/harness`。类型依赖（如 `src/types.ts`）不包含在内，因为它们没有有意义的运行时覆盖率。

## 实现待办

此列表跟踪将 `AgentHarness` 视为迁移就绪之前的剩余工作。活跃/规划项从最简单到最难排序。已完成项归档在底部。

### 1. 添加显式工具注册表读取/更新语义

状态：进行中

已完成：

- 添加了 `setTools(tools, activeToolNames?)`
- 添加了 `setActiveTools(toolNames)`
- 无效的活跃工具名以 `AgentHarnessError` 拒绝
- 通过 `AgentHarness<TSkill, TPromptTemplate, TTool>` 添加了通用应用工具形状
- 从核心类型导出了 `QueueMode`
- 添加了 `AgentHarnessOptions.steeringMode` 和 `followUpMode`
- 添加了实时 `getSteeringMode()` / `setSteeringMode()` 和 `getFollowUpMode()` / `setFollowUpMode()`

剩余：

- 添加 `getTools()` 语义
- 添加 `getActiveTools()` 语义
- 决定并实现工具更新可观测性事件
- 在运行时配置可观测性计划中包含仅活跃工具的更新

备注：

- 可观测性设计：[observability.md](./observability.md)

### 2. 设计每个 `AgentHarness` 的模型注册表

状态：规划中

已完成：

- 保留了当前 `setModel()` 行为

剩余：

- 决定应用如何提供模型注册表
- 决定 harness 存储具体 `Model` 对象、模型引用还是两者都存
- 针对注册表验证模型选择
- 定义活跃 turn 和 save point 期间的模型变更语义

### 3. 完整的 `AgentHarness` 生命周期/状态审查

状态：进行中

已完成：

- 移除了构造函数 `void syncFromTree()`、`syncFromTree()`、`liveOperationId` 和 `shell()`
- 添加了 `createTurnState()`、`applyTurnState()` 和 `executeTurn()`
- 用显式 `phase` 替代了布尔 idle 状态
- Save point 刷新 context、model、thinking level、流选项和 session 快照状态
- 待处理 session 写入使用不含生成字段的 session 条目形状
- 待处理 session 写入在 save point、settlement 和失败清理时刷新
- `steer`、`followUp` 和 `nextTurn` 从文本加可选图片创建用户消息
- `nextTurn` 消息插入到新用户 prompt 之前
- 结构性 compaction/tree 操作用 `finally` 恢复 phase
- 公共 harness 失败将子系统原因规范化为 `AgentHarnessError`
- 待处理 session 写入逐条刷新，失败时不丢弃
- 队列排空在队列更新通知失败时回滚
- `message_end` 持久化发生在订阅者通知之前
- `abort()` 在通知之前发出取消信号，仍通过通知错误等待 idle
- Idle 时的 model/thinking/tool 更新在提交内存状态前验证并持久化
- `setLeafId()` 持久化持久 `leaf` 条目，使树导航在存储重新打开后存活

剩余：

- 完成 phase/idle 语义
- 审计 `settled` 是否可能过早触发
- 使 `settled` 回调内的 session 写入具有确定性
- 审计 `agent_end` 附近的 follow-up 行为
- 实现自动 compaction 决策点
- 实现重试处理
- 验证 `before_agent_start` hook 语义与 coding-agent 的一致性
- 决定 `before_agent_start` 是否需要更多 turn 信息（如工具/工具片段）
- 文档化或更改 busy 时的运行时配置事件时序
- 审计 `abort()` 屏障语义

### 4. 实现通用 hook/事件扩展机制

状态：在 [hooks.md](./hooks.md) 中设计，未实现

已完成：

- 移除了 `AgentHarnessContext`
- Hook 只接收事件载荷
- `emitHook(event)` 从 `event.type` 派生 hook 类型
- Provider 请求/payload hook 有有序转换语义

剩余：

- 添加 `HookEvent`、`ResultOf`、带通用来源元数据的注册选项和单一 `AgentHarnessHooks` 实现
- 将结果链从 `AgentHarness` 移到归约器函数
- 类型检查基础 harness 归约器，使每个结果产出的 `AgentHarnessEvent` 都有归约器语义
- 使 `AgentHarness` 接受并暴露具体 hooks 实例，带构造器推断用于应用特定 hook
- 定义通过 hook 上下文暴露的初始 harness/context 门面
- 保持当前 provider hook 行为，包括流选项补丁删除语义
- 添加归约器语义的对等测试：转换链、补丁链、早期阻止/取消、清理、来源元数据和类型化的应用特定归约器覆盖

备注：

- Hook 设计：[hooks.md](./hooks.md)

### 5. 探索半持久 harness/session 恢复

状态：规划中

已完成：

- 编写了持久性设计：[durable-harness.md](./durable-harness.md)

剩余：

- 决定 session 是否拥有所有持久 harness 状态，或是否需要伴生存储来处理大型 blob
- 定义队列、待处理写入、操作、turn、provider 请求和工具调用的持久条目
- 定义应用提供的工具、模型、扩展、资源、hook 和认证提供者的恢复要求
- 定义未完成 agent turn、provider 请求、工具调用、compaction 和树导航的保守恢复策略
- 基于 session 条目的归约器恢复原型
- 决定中断的操作是追加用户可见消息还是仅内部操作条目

备注：

- Provider 流不可恢复；恢复应从持久边界重启或标记操作中断
- 未完成的工具调用不安全，除非工具声明幂等/重试安全

### 6. 最终生命周期加固套件

状态：规划中

已完成：

- 无

剩余：

- 添加跨相关事件的广泛监听器/hook 重入测试
- 测试底层生命周期事件和 harness 事件的运行时配置 setter
- 测试 model、thinking、resources、tools、active tools 和 stream options 的运行时配置可观测性
- 测试活跃 turn 和 save point 期间的资源/工具/model/thinking/stream-option 更新
- 测试来自监听器和 hook 的 session 写入，包括 `settled` 写入
- 测试来自 turn 事件、工具事件和 provider hook 的队列操作
- 测试 busy 时被拒绝的结构性操作
- 测试来自监听器/hook 的中止
- 测试活跃操作期间的 getter 行为
- 测试 agent 发射消息和待处理监听器写入的确定性排序
- 测试异步监听器调用 harness API 并 await 时无死锁
- 测试通过成功、provider 错误、hook 错误、中止、compaction 和树导航的 phase 清理

### 7. 后续 coding-agent 迁移计划

状态：规划中

已完成：

- 无

剩余：

- 将 coding-agent 资源映射到 sourced loader
- 保持应用层资源去重/来源追踪在 harness 外部
- 适配扩展加载到未来的 hook/session 门面
- 在核心外部保持 UI/session 行为
- 将 coding-agent 的 stream/auth/retry/header 行为迁移到 harness 流配置和 provider hook

---

## 已完成的实现待办

### 8. 从 `AgentHarness` 移除 `Agent` 依赖

状态：已完成

已完成：

- `AgentHarness` 直接调用 `runAgentLoop()`
- Harness 拥有运行生命周期、abort controller、队列排空、provider 流配置、事件归约、session 持久化、待处理写入刷新和 save-point 快照
- Harness 测试覆盖 prompt 构造、队列排空、中止行为、save-point 刷新、待处理写入排序、await listener settlement、工具 hook 和 provider 流包装

剩余：

- 无

备注：

- 更广泛的监听器/hook 重入覆盖在第 6 项中跟踪。

### 9. 完成精选 provider/流配置

状态：已完成

已完成：

- 添加了精选 `AgentHarnessOptions.streamOptions`、`getStreamOptions()` 和 `setStreamOptions()`
- 流选项、headers、metadata 和派生 session id 按 turn 快照化
- Harness 拥有的流包装器调用 `streamSimple()` 并保持生命周期拥有的 `signal` 和 `reasoning`
- `getApiKeyAndHeaders()` 在每次 provider 请求时解析凭据
- 实现了 `before_provider_request`、`before_provider_payload` 和 `after_provider_response` hook
- 流选项补丁支持显式字段删除和有序 hook 链
- `agent-harness-stream.test.ts` 覆盖转发、认证合并、hook 补丁/删除/链、payload hook 和 busy/save-point 快照行为

剩余：

- 无

### 10. 完成底层 `Result` 清理

状态：已完成

已完成：

- 添加了泛型 `Result<TValue, TError>` 加辅助函数
- 更新了 `ExecutionEnv` 和 `NodeExecutionEnv` 为文件系统/进程操作返回类型化 result
- 拆分了文件系统和 shell 能力
- 将 JSONL session 存储/repo 迁移到文件系统 pick 而非直接 Node 导入
- 添加了 `ExecutionEnv.appendFile()` 用于流式追加用例
- 更新了 skill 和 prompt-template loader 消费 `ExecutionEnv` result
- 更新了 shell 输出捕获返回 result 并使用 `ExecutionEnv`，包括通过 `appendFile()` 的完整输出溢出
- 从浏览器安全根导出中移除了 `NodeExecutionEnv`
- 将通用截断工具中的 `Buffer` 使用替换为运行时中立的 UTF-8 处理
- 将 compaction 和 branch-summary 辅助函数转换为类型化 result 返回
- 添加了 `readTextLines()` 使 JSONL 元数据加载只读取 header 行
- 从 Node 文件系统方法中移除了无意义的中止处理（取消无意义时）
- 将跨 session 边界的文件系统错误映射为类型化 `SessionError`
- 添加了类型化 branch-summary 错误和 cause 感知的公共 harness 错误规范化
- 资源 loader 为非 `not_found` 文件系统失败报告结构化诊断
- 扩展了 `NodeExecutionEnv` 测试覆盖文件操作、exec 错误、中止、回调、超时和 shell 输出溢出

剩余：

- 无

备注：

- 保持底层能力/辅助 API 在返回 `Result` 时不抛异常
- 保持 session 存储/repo/session API 抛类型化 `SessionError`
- 保持公共结构性 harness 失败规范化为 `AgentHarnessError`
- 保持 Node 特定 API 隔离在 `src/harness/env/nodejs.ts`、Node 支持的存储/session 实现或显式 Node 专用入口点下
- 随着 API 增加审计通用 harness 工具中的 Node 全局变量
- 审计包导出确保浏览器/通用导入不拉取 Node 专用模块
- 随着 API 演进持续扩展 `ExecutionEnv` 和 shell 输出契约测试
