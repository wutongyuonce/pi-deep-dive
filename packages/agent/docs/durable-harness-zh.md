# 持久化 AgentHarness 与 session 设计

<!-- 从 jot zmnps2zu 同步。今后在此文件中编辑。 -->

持久化 AgentHarness / session 设计笔记。

## 框架

完全持久化的 `AgentHarness` 本身不太现实，因为重要依赖是由宿主应用提供的运行时 JS：

- 工具实现
- 模型/认证提供者
- 扩展和 hook 处理器
- 资源 loader
- system prompt 回调/修改器

实际目标是半持久化 harness：

- session 是持久的仅追加状态树
- harness 将其拥有的状态持久化到 session 条目中
- 宿主应用负责在恢复时重新创建兼容的不可持久化依赖
- 恢复从持久边界重启，而非从进行中的 provider 流

## Session 拥有持久状态

将 session 视为所有持久 agent 状态，而非仅仅是 transcript 历史。

现有 session 状态已包含 harness 状态：

- 模型变更
- 推理级别变更
- leaf 条目
- 标签
- compaction 和分支总结
- 自定义消息和自定义条目

这意味着继续使用单一持久 session 日志，而非添加 harness 伴生存储。伴生对于大型 blob 可能仍有用，但 session 条目应保持为事实来源引用。

## 恢复时应用必须提供什么

应用必须重新创建兼容的运行时依赖：

- 模型注册表/模型对象
- 工具注册表
- 扩展集、版本和排序
- 资源 loader
- system prompt 提供者/hook
- 认证提供者
- 应用特定 hook

Harness 可以在可用时验证稳定的 ID/版本/哈希，但它无法自行序列化这些依赖。

## Harness 应该持久化什么

最小可用的持久性条目：

- 排队的 steer/followUp/nextTurn 消息
- 与 turn 绑定的队列消费
- 活跃操作期间接受的待处理 session 写入
- 待处理写入应用状态
- 操作开始/完成/中断
- turn 开始/完成
- provider 请求开始/完成（如需恢复诊断）
- 工具调用开始/完成（如需安全工具恢复）

潜在条目：

```ts
type DurableHarnessEntry =
  | QueueEnqueuedEntry
  | QueueConsumedEntry
  | PendingWriteEnqueuedEntry
  | PendingWriteAppliedEntry
  | OperationStartedEntry
  | OperationFinishedEntry
  | OperationInterruptedEntry
  | TurnStartedEntry
  | TurnFinishedEntry
  | ProviderRequestStartedEntry
  | ProviderRequestFinishedEntry
  | ToolCallStartedEntry
  | ToolCallFinishedEntry;
```

每个被接受的变更必须在公共 API resolve 之前持久化。

## 恢复模型

启动时：

1. 宿主应用注册工具/模型/扩展/资源/认证/hook
2. Harness 打开 session
3. Harness 将 session 条目归约为：
   - 当前 leaf
   - 对话分支
   - harness 配置
   - 队列
   - 待处理写入
   - 活跃操作/turn/工具状态
4. Harness 验证所需的运行时依赖
5. Harness 协调未完成的操作状态

Provider 流不可恢复。恢复只能从持久边界重试或标记操作中断。

## 恢复策略

默认保守策略：

- 未完成的 agent turn：标记中断，保留持久队列/待处理写入，返回 idle
- 未完成的 provider 请求：标记中断；不自动重试
- 未完成的工具调用：追加中断/错误工具结果；仅在工具声明重试安全/幂等时重试
- 未完成的 compaction：如果没有 compaction 条目则重新运行
- 未完成的分支总结/树导航：如果安全则重新运行/应用缺失的总结或 leaf 条目

可选策略：

```ts
recovery: "mark_interrupted" | "retry_unfinished"
```

`retry_unfinished` 必须在非幂等工具调用周围有保护。

## 关键场景

### 队列

- `queue_enqueued` 之前崩溃：消息未被接受
- `queue_enqueued` 之后崩溃：消息被恢复
- 队列排空之后但在持久 turn 记录之前崩溃：丢失/重复风险
- 必需的不变量：已消费的队列 ID 必须在 `turn_started` 或等效条目中记录，才被视为已消费

### 待处理写入

- `pending_write_enqueued` 之前崩溃：写入未被接受
- 入队之后应用之前崩溃：恢复时应用
- 应用之后应用标记之前崩溃：确定性的目标条目 ID 让恢复检测条目已存在并标记为已应用

### Agent 循环 turn

- provider 请求之前崩溃：重试或标记中断
- provider 请求期间崩溃：默认标记中断
- provider 响应之后但在 assistant 消息持久化之前崩溃：响应丢失，除非 provider 结果被日志记录
- assistant 消息持久化之后崩溃：从持久消息恢复

### 工具调用

- 工具调用开始之后但在结果之前崩溃：外部副作用可能已经发生
- 默认恢复不应重新运行非幂等工具
- 工具调用需要稳定 ID 和重试安全元数据以支持自动恢复

### Compaction

- 总结生成之前崩溃：重新运行准备/总结
- 生成的总结之后但在 compaction 条目之前崩溃：除非总结被日志记录否则重新运行
- compaction 条目之后崩溃：操作完成；如缺失则追加完成标记

### 分支总结 / 树导航

- 总结之前崩溃：重新运行或标记中断
- 总结条目之后但在 leaf 条目之前崩溃：追加缺失的 leaf 条目
- leaf 条目之后崩溃：操作完成；如缺失则追加完成标记

## 最小可行探索

1. 添加持久队列条目
2. 添加带确定性目标 ID 的持久待处理写入条目
3. 添加操作开始/完成/中断条目
4. 添加带已消费队列 ID 的 turn 开始
5. 通过归约 session 日志恢复
6. 默认将未完成的 agent turn 标记为中断
7. 仅在无最终条目时重新运行未完成的 compaction/tree 操作
8. 除非工具元数据声明重试安全，否则不重试未完成的工具调用

## 开放问题

- 哪些 harness 配置条目应首先进入 session：工具、活跃工具、资源、流选项、system prompt 引用？
- 解析后的 system prompt 文本是否应按 turn 快照化用于审计/调试？
- 恢复时是否要求严格的依赖 ID/版本匹配？
- 应日志记录多少 provider 请求数据？
- 恢复时应追加用户可见的 assistant 中断消息还是仅内部操作条目？
- 存储是否应支持在恢复时截断最后的不完整 JSONL 行？
