# AgentHarness hook 设计

<!-- 从 jot 3utlzkxy 同步。今后在此文件中编辑。 -->

最终设计。

## 核心模型

事件通过类型幻影（type-only phantom）携带其结果类型：

```ts
declare const HookResult: unique symbol;

interface HookEvent<TType extends string, TResult = void> {
	type: TType;
	readonly [HookResult]?: TResult;
}

type ResultOf<E> = E extends { readonly [HookResult]?: infer R } ? R : void;

type HookHandler<E, Ctx> = (
	event: E,
	ctx: Ctx,
	signal?: AbortSignal,
) => ResultOf<E> | void | Promise<ResultOf<E> | void>;

type HookObserver<E, Ctx> = (
	event: E,
	ctx: Ctx,
	signal?: AbortSignal,
) => void | Promise<void>;
```

示例：

```ts
interface ContextEvent extends HookEvent<"context", { messages?: AgentMessage[] }> {
	type: "context";
	messages: AgentMessage[];
}

interface ToolCallEvent extends HookEvent<"tool_call", { block?: boolean; reason?: string }> {
	type: "tool_call";
	toolName: string;
	input: Record<string, unknown>;
}

interface MessageEndEvent extends HookEvent<"message_end"> {
	type: "message_end";
	message: AgentMessage;
}
```

没有结果映射。没有规范表。事件类型自己定义自己的结果。

## Hooks 接口

```ts
interface AgentHarnessHooks<E extends HookEvent<string, unknown>, Ctx> {
	context: Ctx;

	setContext(ctx: Ctx): void;

	observe(handler: HookObserver<E, Ctx>): () => void;

	on<TType extends E["type"]>(
		type: TType,
		handler: HookHandler<Extract<E, { type: TType }>, Ctx>,
	): () => void;

	emit<TEvent extends E>(
		event: TEvent,
		signal?: AbortSignal,
	): Promise<ResultOf<TEvent> | undefined>;

	addCleanup(cleanup: () => void | Promise<void>): () => void;

	clear(): Promise<void>;
	dispose(): Promise<void>;
}
```

重要的职责分离：

- `observe()` 看到所有事件，只读，返回值被忽略
- `on(type, handler)` 参与该事件的语义
- `emit(event)` 是 `AgentHarness` 唯一调用的方法
- `clear()` 移除 observer/handler 并运行清理

## 默认实现内部

```ts
class DefaultAgentHarnessHooks<E extends HookEvent<string, unknown>, Ctx>
	implements AgentHarnessHooks<E, Ctx> {
	context: Ctx;

	private observers = new Set<HookObserver<E, Ctx>>();
	private handlers = new Map<string, Set<HookHandler<any, Ctx>>>();
	private cleanups = new Set<() => void | Promise<void>>();

	constructor(ctx: Ctx) {
		this.context = ctx;
	}

	setContext(ctx: Ctx): void {
		this.context = ctx;
	}

	observe(handler: HookObserver<E, Ctx>): () => void {
		this.observers.add(handler);
		return () => this.observers.delete(handler);
	}

	on(type, handler): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler);
		return () => handlers.delete(handler);
	}

	async emit(event, signal?) {
		for (const observer of this.observers) {
			await observer(event, this.context, signal);
		}

		switch (event.type) {
			case "context":
				return this.emitContext(event, signal);
			case "before_provider_request":
				return this.emitBeforeProviderRequest(event, signal);
			case "before_provider_payload":
				return this.emitBeforeProviderPayload(event, signal);
			case "before_agent_start":
				return this.emitBeforeAgentStart(event, signal);
			case "tool_call":
				return this.emitToolCall(event, signal);
			case "tool_result":
				return this.emitToolResult(event, signal);
			case "session_before_compact":
			case "session_before_tree":
				return this.emitFirstCancelOrLast(event, signal);
			default:
				await this.emitObservationHandlers(event, signal);
				return undefined;
		}
	}
}
```

实现内部的类型转换是可接受的，因为 `Map<string, ...>` 丢失了特异性。公共 API 保持类型化。

## 变更语义

### 观察

```ts
await hooks.emit({ type: "message_end", message }, signal);
```

Observer 运行。`message_end` handler 运行。除非该事件后来获得结果类型，否则返回值被忽略。

### Context 转换

Handler 按顺序运行。每个看到当前消息。

```ts
let current = event;

for (const handler of handlers("context")) {
	const result = await handler(current, ctx, signal);
	if (result?.messages) {
		current = { ...current, messages: result.messages };
	}
}

return current.messages === event.messages ? undefined : { messages: current.messages };
```

### Provider 请求 / payload

顺序转换。每个 handler 看到前一个的输出。

```ts
let current = event;

for (const handler of handlers("before_provider_payload")) {
	const result = await handler(current, ctx, signal);
	if (result !== undefined) {
		current = { ...current, payload: result.payload };
	}
}

return changed ? { payload: current.payload } : undefined;
```

### Before agent start

收集注入的消息，链接 system prompt。

```ts
let systemPrompt = event.systemPrompt;
const messages = [];

for (const handler of handlers("before_agent_start")) {
	const result = await handler({ ...event, systemPrompt }, ctx, signal);
	if (result?.messages) messages.push(...result.messages);
	if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
}

return messages.length || systemPrompt !== event.systemPrompt
	? { messages, systemPrompt }
	: undefined;
```

### Tool call

顺序执行，阻止时提前退出。

```ts
for (const handler of handlers("tool_call")) {
	const result = await handler(event, ctx, signal);
	if (result?.block) return result;
}
```

### Tool result

顺序补丁累积。每个 handler 看到当前已打补丁的结果。

```ts
let current = event;
let modified = false;

for (const handler of handlers("tool_result")) {
	const result = await handler(current, ctx, signal);
	if (!result) continue;

	current = {
		...current,
		content: result.content ?? current.content,
		details: result.details ?? current.details,
		isError: result.isError ?? current.isError,
	};

	modified = true;
}

return modified
	? { content: current.content, details: current.details, isError: current.isError }
	: undefined;
```

### Session-before 事件

顺序执行，取消时提前退出。

```ts
let last;

for (const handler of handlers(event.type)) {
	const result = await handler(event, ctx, signal);
	if (!result) continue;
	last = result;
	if (result.cancel) return result;
}

return last;
```

## Harness 使用

Harness 只做这件事：

```ts
await this.hooks.emit(event, signal);
```

或：

```ts
const result = await this.hooks.emit({ type: "context", messages }, signal);
return result?.messages ?? messages;
```

Harness 不存储 handler、不链接 listener、不知道扩展策略。

## 上下文

上下文是普通对象，不会每次 emit 时重建。

```ts
const hooks = new CodingAgentHooks({
	harness: harnessFacade,
	session: sessionFacade,
	ui: noUiFacade,
});
```

稍后：

```ts
hooks.setContext({
	...hooks.context,
	ui: tuiFacade,
});
```

对于动态状态，优先使用稳定的门面/方法而非 getter 迷宫：

```ts
interface CodingAgentHookContext {
	harness: HarnessFacade;
	session: SessionFacade;
	ui: UiFacade;
	models: ModelFacade;
}
```

每次运行的 `signal` 作为第三个 handler 参数传递。

## 扩展加载（后续）

扩展加载可以与 harness 并列并构造 hooks：

```ts
const hooks = await loadExtensions({
	paths,
	context,
	hooks: new CodingAgentHooks(context),
});
const harness = new AgentHarness({ ..., hooks });
```

loader 注册到 hooks：

```ts
hooks.on("context", handler);
hooks.on("tool_call", handler);
hooks.addCleanup(cleanup);
```

重载：

```ts
await hooks.clear();
const nextHooks = await loadExtensions(...);
harness.setHooks(nextHooks); // 如果支持，仅在 idle 时
```

## 打孔

### 1. 错误策略必须显式

现有的 coding-agent 捕获扩展错误、报告并继续。新的 hook 需要相同的策略，可能是：

```ts
errorMode: "continue" | "throw"
onError(error)
```

对于 coding-agent，默认应为 `"continue"`。

### 2. 来源元数据很重要

现有的 runner 知道哪个扩展产生了错误/资源/工具。普通的 `on()` 会丢失这些，除非添加注册元数据或作用域。

可能需要：

```ts
const scope = hooks.createScope({ sourceInfo });
scope.on("context", handler);
scope.addCleanup(...);
```

或 `on(type, handler, { sourceInfo })`。

### 3. 一些扩展能力是注册表，不是 hook

这些不被 `cover，应保持为 `CodingAgentHooks` 或扩展宿主上的注册表：

- 工具
- 命令
- 快捷键
- 标志
- 消息渲染器
- provider 注册
- OAuth 提供者
- 自定义模型提供者

这没问题。它们不属于 `AgentHarness`。

### 4. 现有 coding-agent 事件可以被表示

以下没有阻碍：

- `context`
- `before_provider_request`
- `after_provider_response`
- `before_agent_start`
- `message_end`
- `tool_call`
- `tool_result`
- `input`
- `user_bash`
- `resources_discover`
- `session_before_*`
- `session_*`
- model/thinking 选择事件
- agent/turn/message/tool 生命周期事件

它们成为 `CodingAgentHooks` 处理的额外事件类型。

### 5. 需要保留精确的旧行为

移植 coding-agent 时，特殊情况必须被复制：

- `input`：转换链，`handled` 短路
- `user_bash`：第一个有意义的结果获胜
- `message_end`：替换必须保持相同 role
- `before_agent_start`：`ctx.getSystemPrompt()` 必须反映当前链式 prompt
- `resources_discover`：聚合路径并保留扩展来源
- `tool_call`：参数变更对后续 handler 保持可见
- `tool_result`：后续 handler 看到先前的补丁

设计允许所有这些，但默认/coding hooks 实现必须编码这些行为。

### 6. `emit()` switch 可能遗漏自定义变更事件

如果子类添加了结果产出事件但忘记覆盖 `emit()`，它将表现为观察性的。测试应该能捕获这个。如果这变得容易出错，可以后续添加受保护的策略注册表，但最初不需要。

### 7. Observer 语义有意受限

Observer 看到原始发射的事件一次。它们不看到每次中间变更。如果需要最终转换状态，发射单独的最终事件或使用事件特定的 handler。

## 结论

此设计可以实现新的 coding-agent。它比现有 runner 更简单，保持 harness 干净，并在 `CodingAgentHooks` 添加来源感知作用域、注册表、清理和精确旧行为语义的同时保留重要的扩展能力。

--- 评论 ---

线程 hn2xk0tzhj 关于 "addCleanup(cleanup"
  [tmluyaub9v] Owner (2026-05-14T12:55:45.500Z): cleanup 应该可选地传递给 on/observe
