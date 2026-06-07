<!-- 从 jot qe0ikdqs 同步。今后在此文件中编辑。 -->

# Pi 可观测性设计笔记

## 目标

使 `packages/ai` 和 `packages/agent`/harness 可观测，而不依赖 OpenTelemetry、Sentry 或任何 APM 厂商。

Pi 应该发射稳定的、结构化的生命周期事件。外部监听器可以将这些事件转换为 OTel span、Sentry span、日志、指标或自定义遥测。

## 心智模型

一个 trace 是一棵因果工作树，例如一个用户 turn。

一个 span 是该树中的一个计时操作。它通常由 ID 表示，而非对象指针：

```ts
interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error";
}
```

示例树：

```text
traceId=t1 spanId=s1 parent=-  name=pi.agent.prompt
traceId=t1 spanId=s2 parent=s1 name=pi.agent.turn
traceId=t1 spanId=s3 parent=s2 name=pi.ai.provider.request
traceId=t1 spanId=s4 parent=s2 name=pi.agent.tool_call
traceId=t1 spanId=s5 parent=s4 name=pi.session.append_entry
```

## 异步上下文

JavaScript 只有一个事件循环，但多个异步链可以交错。单一全局 `currentContext` 在并发下会崩溃。

`AsyncLocalStorage` 是 Node 为异步延续提供的 `ThreadLocal` 等价物。它让并发操作保持各自独立的当前上下文：

```ts
await Promise.all([
  runWithPiContext({ userId: "alice" }, () => harness.prompt("A")),
  runWithPiContext({ userId: "bob" }, () => harness.prompt("B")),
]);
```

深层代码可以读取活跃异步链的正确当前上下文。

Pi 必须在 Node、Bun、浏览器、worker 和其他 JS 运行时中运行，因此 ALS 不能作为核心抽象。它应该是一个运行时适配器。

## 核心设计

Pi 拥有一个小型的运行时无关的可观测性抽象：

```ts
export interface PiObservabilityContext {
  traceId?: string;
  currentSpanId?: string;
  userContext?: Record<string, unknown>;
}

export interface PiObservabilityEvent {
  type: "start" | "end" | "error" | "event";
  name: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  timestamp: number;
  durationMs?: number;
  context?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  error?: { name: string; message: string };
}

export interface PiObservability {
  getContext(): PiObservabilityContext | undefined;
  runWithContext<T>(context: PiObservabilityContext, fn: () => T): T;
  emit(event: PiObservabilityEvent): void;
  hasSubscribers(): boolean;
}
```

公共 API：

```ts
export function configurePiObservability(observability: PiObservability): void;
export function subscribePiObservability(listener: (event: PiObservabilityEvent) => void): () => void;
export function runWithPiContext<T>(userContext: Record<string, unknown>, fn: () => T): T;
export function traceOperation<T>(name: string, payload: Record<string, unknown>, fn: () => T): T;
```

`traceOperation()`：

1. 读取当前上下文
2. 如果缺失则创建 `traceId`
3. 创建新的 `spanId`
4. 使用当前 span 作为 `parentSpanId`
5. 发射 `start`
6. 在子上下文中运行回调
7. 发射 `end` 或 `error`
8. 错误时重新抛出

伪代码：

```ts
function traceOperation<T>(name: string, payload: Record<string, unknown>, fn: () => T): T {
  const parent = getContext();
  const traceId = parent?.traceId ?? createId();
  const spanId = createId();
  const parentSpanId = parent?.currentSpanId;

  const child = { ...parent, traceId, currentSpanId: spanId };

  emit({ type: "start", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: parent?.userContext, payload });

  return runWithContext(child, () => {
    try {
      const result = fn();
      // Promise 感知实现在 settlement 后发射 end/error。
      emit({ type: "end", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: child.userContext, payload });
      return result;
    } catch (error) {
      emit({ type: "error", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: child.userContext, payload, error: serializeError(error) });
      throw error;
    }
  });
}
```

## 运行时适配器

核心包不应导入 Node 专用 API。

可能的实现：

- Node 适配器：用 `AsyncLocalStorage` 做上下文，可选 `diagnostics_channel` 发布
- 浏览器/workers 后备：本地订阅者集合和有限/手动的上下文传播
- Bun/Deno 适配器：使用运行时特定的异步上下文（如可用）

对于 Node，诊断通道可以用作被动事件总线：

```ts
import { channel } from "diagnostics_channel";
channel("pi.observability").publish(event);
```

订阅者可以创建 OTel/Sentry span，无需 monkey-patch pi。

## Pi 发射什么

Pi 发射发生了什么。它不直接创建 OTel/Sentry span。

初始最小事件名：

```text
pi.agent.prompt
pi.agent.skill
pi.agent.prompt_template
pi.agent.compaction
pi.agent.branch_navigation
pi.agent.session.append_entry
pi.ai.provider.request
```

每个操作发射：

```text
start
end
error
```

后续添加：

```text
pi.agent.turn
pi.agent.tool_call
pi.agent.queue_update
pi.ai.provider.retry
pi.ai.provider.first_token
pi.ai.provider.usage
pi.session.read
pi.session.write
```

## 最小埋点

### packages/agent

包装：

- `AgentHarness.prompt()`
- `AgentHarness.skill()`
- `AgentHarness.promptFromTemplate()`
- `AgentHarness.compact()`
- `AgentHarness.navigateTree()`
- `Session.appendTypedEntry()` 或存储追加门面

示例：

```ts
return traceOperation(
  "pi.agent.prompt",
  {
    sessionId: turnState.sessionId,
    provider: turnState.model.provider,
    model: turnState.model.id,
    promptLength: text.length,
    imageCount: options?.images?.length ?? 0,
  },
  () => this.executeTurn(turnState, text, options),
);
```

Session 写入：

```ts
return traceOperation(
  "pi.agent.session.append_entry",
  { entryType: entry.type },
  async () => {
    await this.unwrap(this.storage.appendEntry(entry));
    return entry.id;
  },
);
```

### packages/ai

包装常见的 provider 边界：

- `streamSimple()`
- `completeSimple()`

示例：

```ts
return traceOperation(
  "pi.ai.provider.request",
  {
    api: model.api,
    provider: model.provider,
    model: model.id,
    sessionId: options.sessionId,
    reasoning: options.reasoning,
  },
  () => actualStreamSimple(model, context, options),
);
```

end/error 载荷可以包含安全的元数据：

- stop reason
- 状态码
- 重试次数
- 输入/输出/总 token 数
- 总费用
- 中止/超时标志

## 安全与脱敏

默认载荷必须安全。

默认安全：

- provider
- 模型
- API 标识符
- session id
- 条目类型
- 工具名
- 状态码
- stop reason
- token 计数
- 费用
- 持续时间

默认不安全：

- prompt
- 补全
- 工具参数
- 工具结果
- shell 输出
- 文件内容
- provider 请求载荷
- provider 响应体
- API 密钥
- headers

内容捕获可以后续通过显式脱敏 hook 选择启用。

## Listener 行为

可观测性绝不能影响 pi 的执行。

订阅者错误应被吞掉或隔离。Harness hook 是控制平面，可能影响执行；可观测性订阅者是被动的，绝不能影响。

## 用户上下文

用户可以将任意上下文与 turn 关联：

```ts
await runWithPiContext(
  {
    userId: "u123",
    orgId: "acme",
    region: "eu",
  },
  () => harness.prompt("fix this"),
);
```

该异步链内发射的每个事件都包含上下文：

```ts
{
  type: "start",
  name: "pi.ai.provider.request",
  traceId: "t1",
  spanId: "s3",
  parentSpanId: "s1",
  context: {
    userId: "u123",
    orgId: "acme",
    region: "eu",
  },
  payload: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
}
```

OTel 适配器可以将其映射为 span 属性。Sentry 适配器可以将其映射为 Sentry context/span。自定义用户可以记录 JSON。

## 包计划

最小初始包：

```text
packages/observability
  运行时无关的 context + traceOperation + subscribe
```

然后：

```text
packages/ai
  发射 pi.ai.* 事件

packages/agent
  发射 pi.agent.* / pi.session.* 事件
```

可选后续：

```text
packages/observability-node
  AsyncLocalStorage + diagnostics_channel 桥接

packages/otel
  订阅 pi 事件并创建 OpenTelemetry span
```

## 论点

Pi 定义稳定的、安全的事件契约。适配器定义事件去向。

这使 ai/harness 可观测，而不将核心包绑定到 OTel、Sentry、Node 专用 API 或 monkey-patching。
