# pi-ai 与 pi-agent-core 源码阅读教程

这份文档不是 API 使用说明，而是一份面向“准备开发这两个模块”的源码阅读教程。

目标有三个：

1. 帮你先建立 **monorepo 里的分层认知**，知道 `pi-ai` 和 `pi-agent-core` 各自解决什么问题。
2. 帮你按 **渐进式路径** 阅读源码，而不是一上来就陷进 9000 行 provider 细节。
3. 帮你从“我要改功能 / 加 provider / 调 agent loop”这种 **开发者视角** 理解调用链。

如果你刚开始接触 TypeScript，建议先搭配阅读：

- [pi-ai-streaming-architecture.md](./pi-ai-streaming-architecture.md)

那篇文档已经把 `EventStream`、`AbortController`、`AsyncIterable` 等底层概念拆开讲过了。本文会继续往上走，重点看模块边界、控制流和开发入口。

---

## 1. 先建立全局地图

这个仓库是一个 monorepo。和本文最相关的 4 个包如下：

```text
pi-tui (终端渲染库)          ← 纯 UI / 渲染层
pi-ai  (统一 LLM API)       ← 模型、provider、流式事件、成本/usage

    ↓ pi-agent-core 依赖 pi-ai
pi-agent-core (agent 引擎)   ← agent loop、工具执行、事件分发、状态管理

    ↓ pi-coding-agent 依赖 pi-ai + pi-agent-core + pi-tui
pi-coding-agent (完整 CLI)   ← 会话、命令、工具、TUI、扩展系统
```

对源码阅读来说，最重要的结论是：

- `pi-ai` 解决的是：**“怎么统一调用不同 LLM provider，并把结果变成统一事件流”**
- `pi-agent-core` 解决的是：**“拿到统一事件流后，怎么驱动一个会执行工具的 agent loop”**
- `pi-coding-agent` 解决的是：**“怎么把 agent 做成真正可用的产品”**

所以如果你的目标是理解“agent 最底层怎么跑起来”，你应该先看：

1. `packages/ai`
2. `packages/agent`
3. 最后再把 `packages/coding-agent` 当成上层集成样例

---

## 2. 为什么要拆成两个库

很多项目会把“调 LLM”和“跑 agent”写在一起，但 `pi` 把它们分成了两个库：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`

这样拆有几个直接好处。

### 2.1 `pi-ai` 可以独立使用

如果你只是想写一个：

- 多 provider 聊天程序
- 流式文本生成器
- 支持工具调用但不需要完整 agent loop 的应用

那么只需要 `pi-ai` 就够了。

核心入口可以从这里开始看：

- [`packages/ai/src/index.ts`](../packages/ai/src/index.ts)
- [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)
- [`packages/ai/src/types.ts`](../packages/ai/src/types.ts)

### 2.2 `pi-agent-core` 不关心底层 provider 细节

`pi-agent-core` 不直接写 OpenAI / Anthropic / Gemini 的协议适配。它只要求：

- 给我一个 model
- 给我一个 stream function
- 给我一批 tools
- 给我一些 hook

然后它就能跑完整的 agent loop。

这意味着：

- 底层 provider 改动，大多数时候不需要改 agent loop
- agent loop 的测试可以大量使用 faux provider，而不需要真实联网
- 上层应用可以替换 `streamFn`，甚至接自己的模型后端

`pi-agent-core` 的核心入口可以从这里开始看：

- [`packages/agent/src/index.ts`](../packages/agent/src/index.ts)
- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)
- [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)
- [`packages/agent/src/types.ts`](../packages/agent/src/types.ts)

---

## 3. 你应该怎么读源码

不要按目录从上往下机械读。更有效的方式是：**按一条真实请求的调用链去读。**

建议按下面 4 轮阅读。

### 第一轮：只看公开入口和类型

目标：先知道“这个包从外面怎么用”，暂时不深挖内部实现。

`pi-ai` 先看：

- [`packages/ai/src/index.ts`](../packages/ai/src/index.ts)
- [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)
- [`packages/ai/src/models.ts`](../packages/ai/src/models.ts)
- [`packages/ai/src/types.ts`](../packages/ai/src/types.ts)

`pi-agent-core` 先看：

- [`packages/agent/src/index.ts`](../packages/agent/src/index.ts)
- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)
- [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)
- [`packages/agent/src/types.ts`](../packages/agent/src/types.ts)

读这一轮时，你只需要回答 4 个问题：

1. 入口函数有哪些？
2. 运行时的核心对象有哪些？
3. 事件类型有哪些？
4. 哪些是“统一抽象”，哪些是“provider / tool / hook 细节”？

### 第二轮：跟一条最短调用链

目标：从 `streamSimple()` / `runAgentLoop()` 跟到 provider 和工具执行。

建议按下面顺序：

1. `pi-ai`
   - [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)
   - [`packages/ai/src/api-registry.ts`](../packages/ai/src/api-registry.ts)
   - [`packages/ai/src/providers/register-builtins.ts`](../packages/ai/src/providers/register-builtins.ts)
   - [`packages/ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts)
   - 一个代表 provider，例如 [`packages/ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)
2. `pi-agent-core`
   - [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)
   - [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)

### 第三轮：只看“扩展点”

目标：如果你要开发这个模块，哪些函数最可能需要改。

`pi-ai` 的扩展点通常是：

- 新增 provider
- 改消息转换
- 改工具调用兼容
- 改 usage / cost 计算

`pi-agent-core` 的扩展点通常是：

- 改 tool call 调度
- 改 hook 时机
- 改 turn 边界
- 改 state 管理或队列策略

### 第四轮：最后再看测试

目标：确认你的理解和作者预期是否一致。

推荐测试入口：

- `pi-ai`
  - [`packages/ai/test/stream.test.ts`](../packages/ai/test/stream.test.ts)
  - [`packages/ai/test/abort.test.ts`](../packages/ai/test/abort.test.ts)
  - [`packages/ai/test/lazy-module-load.test.ts`](../packages/ai/test/lazy-module-load.test.ts)
- `pi-agent-core`
  - [`packages/agent/test/agent-loop.test.ts`](../packages/agent/test/agent-loop.test.ts)
  - [`packages/agent/test/agent.test.ts`](../packages/agent/test/agent.test.ts)
  - [`packages/agent/test/harness/agent-harness.test.ts`](../packages/agent/test/harness/agent-harness.test.ts)

---

## 4. 先理解 `pi-ai`：它不是 SDK，而是“统一 LLM 运行时”

### 4.1 `pi-ai` 的职责边界

`pi-ai` 负责的事情包括：

- 模型注册与查找
- provider 选择
- 统一流式事件协议
- 工具 schema 与参数校验
- thinking / tool call / image / usage / cost 统一抽象
- abort 透传
- provider 间上下文 handoff

它**不负责**：

- 完整 agent loop
- transcript 的长期状态管理
- queue / steering / follow-up
- UI

所以你可以把 `pi-ai` 理解为：

> 一个“多 provider + 多模态 + 工具调用 + 流式事件”的统一底座。

### 4.2 `pi-ai` 的核心分层

阅读源码时，可以把 `packages/ai/src` 分成 5 层：

```text
1. models / types
   定义模型、消息、工具、事件协议

2. stream entry
   入口函数：stream() / complete() / streamSimple()

3. registry
   根据 model.api 找 provider

4. providers
   各 provider 的协议适配与流式解析

5. utils
   event-stream、headers、validation、json parse 等基础设施
```

对应的核心源码：

- 类型层
  - [`packages/ai/src/types.ts`](../packages/ai/src/types.ts)
  - [`packages/ai/src/models.ts`](../packages/ai/src/models.ts)
- 入口层
  - [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)
- 注册层
  - [`packages/ai/src/api-registry.ts`](../packages/ai/src/api-registry.ts)
  - [`packages/ai/src/providers/register-builtins.ts`](../packages/ai/src/providers/register-builtins.ts)
- 核心运行时
  - [`packages/ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts)
- provider 样板
  - [`packages/ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)
  - [`packages/ai/src/providers/openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts)
  - [`packages/ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts)

---

## 5. `pi-ai` 的最短调用链

这一节只跟一条最常见的链路：

```typescript
const stream = streamSimple(model, context, options);
for await (const event of stream) {
  // 消费事件
}
const message = await stream.result();
```

### 5.1 第一步：入口 `stream.ts`

入口文件：

- [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)

你应该重点看这几个函数：

- `stream()`
- `complete()`
- `streamSimple()`
- `completeSimple()`

这层的作用非常单纯：

- 根据 `model.api` 找到 provider
- 调 provider 的 `stream()` 或 `streamSimple()`
- 非流式版本其实也是复用流式版本，再等待 `result()`

这意味着：

- **真正复杂的逻辑不在入口层**
- 入口层最重要的设计价值是“稳定 API 面”和“统一调度点”

如果你以后要给 `pi-ai` 加 tracing、全局审计、统一 options 逻辑，这一层往往是第一落点。

### 5.2 第二步：注册表 `api-registry.ts`

核心文件：

- [`packages/ai/src/api-registry.ts`](../packages/ai/src/api-registry.ts)

它解决的问题是：

> “同样都是 `stream(model, context)`，到底要调哪个 provider 实现？”

这里做了三件事：

1. provider 注册
2. provider 查询
3. 用 `wrapStream()` 做一次统一签名和运行时校验

所以当你想新增 provider 时，真正的接入点不是 `stream.ts`，而是：

1. 写 provider 实现
2. 在 `register-builtins.ts` 里注册

### 5.3 第三步：内置 provider 注册与懒加载

核心文件：

- [`packages/ai/src/providers/register-builtins.ts`](../packages/ai/src/providers/register-builtins.ts)

这一层很重要，因为它体现了 `pi-ai` 的一个很实际的工程判断：

> provider 很多，但不应该在应用启动时把所有 provider 都立即 import 进来。

所以它做了懒加载包装：

- 外层先返回一个 `AssistantMessageEventStream`
- 真正 provider 模块异步 import
- 内层 provider 流开始工作后，再把事件转发到外层流

你可以把它理解为：

```text
调用方
  -> streamSimple()
  -> registry 取到 lazy provider
  -> lazy provider 先 new 一个 outer stream
  -> import 真正 provider 模块
  -> provider.streamSimple(...)
  -> forward inner stream -> outer stream
```

这是一个非常典型的“API 立即返回，内部懒初始化”的设计。

对开发者来说，这里有两个重要启发：

1. 如果你加新 provider，最好遵守这套懒加载模式
2. 如果你排查“为什么 stream 已经返回了但 provider 还没真正开始跑”，这里就是入口

### 5.4 第四步：统一事件流引擎 `event-stream.ts`

核心文件：

- [`packages/ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts)

这部分在 [pi-ai-streaming-architecture.md](./pi-ai-streaming-architecture.md) 里已经详细讲过，这里只从开发视角总结。

你要记住的不是语法，而是它解决了两个工程问题：

1. **provider 和消费者的速度不同步**
2. **调用方既想实时消费事件，又想在结束时拿最终结果**

所以 `EventStream<T, R>` 提供了两个接口面：

- `for await ... of stream`
- `await stream.result()`

以及三个核心状态：

- `queue`
- `waiting`
- `finalResultPromise`

如果你未来要改 `pi-ai` 的流式协议，请优先问自己：

- 这个改动属于 provider 层，还是 event-stream 层？
- 它是新增事件，还是改最终结果？
- 它需要影响 `result()` 吗？

很多新手第一次读到 provider 文件时会头大，其实真正需要先吃透的是这一层。

### 5.5 第五步：provider 内部如何把 SDK 事件转成统一事件

推荐阅读代表文件：

- [`packages/ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)

原因不是它最简单，而是它最能代表 `pi-ai` 的实际复杂度：

- 要处理 SDK client
- 要处理 payload build
- 要处理 onPayload / onResponse hook
- 要处理 stream 事件转换
- 要处理 usage / cost
- 要处理 abort / error / partial results

你读 provider 时，不要被具体字段淹没。先只抓主骨架：

```text
1. new AssistantMessageEventStream()
2. 创建 provider client
3. 构造 payload
4. 发起流式请求
5. 发 start 事件
6. 把 provider 原生事件翻译成统一事件
7. 成功 -> done
8. 失败/中止 -> error
9. end()
```

provider 文件之间虽然细节不同，但主骨架大体一致。

所以阅读策略应该是：

1. 精读 1 个代表 provider
2. 横向扫 2~3 个其它 provider，只看差异点

差异点通常集中在：

- message 转换方式
- tool call 编码方式
- thinking 支持方式
- 图片 / 多模态字段
- usage / cache / pricing 计算

---

## 6. 如果你要开发 `pi-ai`，最常改哪里

### 场景 1：加一个新的 provider

最推荐的切入路径：

1. 看已有 provider 样板
   - [`packages/ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)
   - [`packages/ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts)
2. 在 `types.ts` 确认需要的 `Api` / `Model` / event 类型
3. 写新 provider 文件
4. 在 [`packages/ai/src/providers/register-builtins.ts`](../packages/ai/src/providers/register-builtins.ts) 注册
5. 加测试

实现时最关键的是保持这 3 个不变量：

1. 对外必须返回 `AssistantMessageEventStream`
2. 成功必须收敛成 `done`
3. 失败和中止必须收敛成 `error`

### 场景 2：改工具调用协议

先看：

- [`packages/ai/src/types.ts`](../packages/ai/src/types.ts)
- [`packages/ai/src/providers/transform-messages.ts`](../packages/ai/src/providers/transform-messages.ts)
- 各 provider 自己的 tool 处理逻辑

这类改动最容易踩坑，因为 provider 之间 tool call 的表现差异很大。建议先确认改动影响的是：

- 输入给模型的 tool schema
- 模型返回的 tool call block
- tool result 回灌格式

三者中的哪一段

### 场景 3：改 usage / cost / cache 行为

先看：

- 各 provider 文件里的 usage / pricing 代码
- `models.generated.ts` 中的模型元信息
- 相关测试，如 `openai-*cache*`、`total-tokens.test.ts`

这部分经常是“看起来小，回归面很大”的区域。

---

## 7. 再理解 `pi-agent-core`：它是 agent loop，不是完整产品

### 7.1 `pi-agent-core` 的职责边界

`pi-agent-core` 负责：

- agent loop
- transcript 驱动
- tool 调用的准备、执行、结束
- 事件协议
- 基础状态管理
- queue（steering / follow-up）
- `Agent` 封装
- `AgentHarness` 高层集成能力

它不负责：

- 终端 UI
- shell / read / edit / grep 这类具体工具实现
- 会话产品化能力的全部细节

可以把它理解为：

> 一个“会调用工具、会发事件、会维护状态”的通用 agent 引擎。

### 7.2 `packages/agent` 内部怎么分层

阅读时可以先把目录分成 4 块：

```text
1. agent-loop.ts
   低层、无状态（相对）的主循环

2. agent.ts
   有状态封装，负责 transcript、订阅、队列、abort

3. harness/
   更高层的会话/资源/skills/prompt templates/session 集成

4. types.ts
   AgentMessage、AgentEvent、hooks、tool context 等协议定义
```

如果你的目标是先掌握最核心的 agent 思想，请先只看：

- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)
- [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)

`harness/` 先放到第二阶段。

---

## 8. `pi-agent-core` 的最短调用链

这一节只跟最核心的一条链：

```typescript
const agent = new Agent(...)
await agent.prompt("帮我做一件事")
```

### 8.1 `Agent` 是高层有状态壳层

核心文件：

- [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)

读这个文件时，建议先记住一句话：

> `Agent` 的价值不是“重新实现 loop”，而是“把 loop 变成一个更容易用的运行时对象”。

它做的事情包括：

- 保存当前 transcript
- 维护 `isStreaming`、`streamingMessage`、`pendingToolCalls`
- 提供 `prompt()`、`continue()`、`abort()`、`waitForIdle()`
- 维护 steering / follow-up 队列
- 把低层 `AgentEvent` 先归并进自身状态，再广播给订阅者

如果你只想理解“最原始的 agent loop 怎么跑”，可以先跳过 `Agent`，直接看 `runAgentLoop()`。

如果你想理解“为什么业务层更喜欢用 `Agent` 而不是直接调 loop”，那就必须看这个文件。

### 8.2 真正的核心在 `agent-loop.ts`

核心文件：

- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)

这就是整个 `pi-agent-core` 的心脏。

建议重点看这些函数：

- `runAgentLoop()`
- `runAgentLoopContinue()`
- `runLoop()`
- `streamAssistantResponse()`
- `executeToolCalls()`
- `prepareToolCall()`
- `executePreparedToolCall()`
- `finalizeExecutedToolCall()`

### 8.3 一轮最小调用链

按执行顺序看，最短调用链是：

```text
Agent.prompt()
  -> runPromptMessages()
  -> runWithLifecycle()
  -> runAgentLoop()
  -> runLoop()
  -> streamAssistantResponse()
  -> streamFn(...)   // 默认是 pi-ai 的 streamSimple()
  -> for await provider events
  -> message_end
  -> 检查 tool calls
  -> 若有工具则执行
  -> turn_end
  -> 决定是否继续下一轮
```

这条链路已经足够让你理解整个 agent 是怎么动起来的。

---

## 9. `runLoop()` 是真正的 agent 脑干

核心文件：

- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)

这个函数最值得你精读，因为它定义了 agent 的“生命节奏”。

从源码角度看，它在做 5 件事：

1. 取出 pending steering
2. 请求一轮 assistant 回复
3. 如果 assistant 返回 tool calls，就执行工具
4. 结束一轮 turn，并允许 `prepareNextTurn()` 改写上下文或模型
5. 如果没有更多工作，则检查 follow-up；否则继续

它为什么有两层 `while`？

- **内层 while**：处理“本轮 agent 还没结束”的情况
  - 还有 tool calls
  - 还有 steering 要注入
- **外层 while**：处理“agent 本来该结束，但又来了 follow-up”的情况

这是一个很漂亮的结构，因为它把两种“继续”的语义拆开了：

- turn 内继续
- turn 间继续

如果以后你要改：

- 最大步数
- 自动停机条件
- 多轮策略
- queue 语义

大概率都得从这里下手。

详细代码注释已经直接补在源码里，建议你打开：

- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)

按函数内注释顺着读。

---

## 10. `streamAssistantResponse()` 是 `pi-agent-core` 和 `pi-ai` 的连接点

这是整个系统里最有代表性的桥接函数。

核心文件：

- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)

它做的事情不是“简单请求模型”，而是完成 4 层转换：

### 第 1 层：Agent transcript -> LLM messages

先跑：

- `transformContext()`
- `convertToLlm()`

这里体现了一个重要边界：

- agent 内部 transcript 是 `AgentMessage[]`
- provider 真正接收的是 `Message[]`

所以：

> `pi-agent-core` 维护的是 agent 语义，`pi-ai` 维护的是 provider 语义。

### 第 2 层：Agent config -> pi-ai stream options

这个函数会把：

- model
- apiKey
- signal
- reasoning
- sessionId

等参数传给 `streamFn`

默认的 `streamFn` 就是 `pi-ai` 的 `streamSimple()`

### 第 3 层：AssistantMessageEvent -> AgentEvent

provider 流里出来的是：

- `text_delta`
- `thinking_delta`
- `toolcall_delta`
- `done`
- `error`

但 agent / UI 更关心的是：

- `message_start`
- `message_update`
- `message_end`

所以这个函数做了协议转换。

### 第 4 层：partial message -> transcript 最终消息

流式阶段，context 里会暂时放一个 `partialMessage` 占位。

最后再用 `response.result()` 返回的最终 `AssistantMessage` 替换它。

这一步非常关键，因为它保证了：

- UI 可以实时看到增量
- transcript 最终只保留稳定消息

---

## 11. 工具执行链路怎么读

很多人读 agent 源码时最容易迷路的地方就是 tool call。

推荐你不要一口气读完所有工具执行函数，而是记住它其实分成 4 个阶段。

### 阶段 1：决定串行还是并行

函数：

- `executeToolCalls()`

它只做路由，不做真正执行。

判断依据：

- 全局 `config.toolExecution`
- 某些工具是否声明 `executionMode === "sequential"`

### 阶段 2：preflight

函数：

- `prepareToolCall()`

这是最容易低估的阶段。它做的其实很多：

- 找工具
- 参数预处理
- schema 校验
- `beforeToolCall()` hook
- abort 检查

如果这个阶段失败，就会直接返回 `immediate` 结果，而不是进入真正执行。

这是一种很好的工程分层，因为它把：

- “能不能执行”
- “真正执行”

明确拆开了。

### 阶段 3：真正执行

函数：

- `executePreparedToolCall()`

这里会真正调用：

- `tool.execute(...)`

并把工具侧的 partial update 转成：

- `tool_execution_update`

所以这层既是“执行器”，也是“事件翻译器”。

### 阶段 4：后处理

函数：

- `finalizeExecutedToolCall()`

这里会调用：

- `afterToolCall()`

允许上层再改：

- `content`
- `details`
- `terminate`
- `isError`

这让 agent loop 本身保持稳定，但又允许业务层插入丰富策略。

---

## 12. `Agent` 为什么还存在

如果已经有 `runAgentLoop()`，为什么还需要 `Agent` 类？

因为 `runAgentLoop()` 更像“纯引擎”，而 `Agent` 是“带运行时状态的壳”。

你可以从 3 个角度理解它。

### 12.1 它提供运行时状态

例如：

- `state.messages`
- `state.isStreaming`
- `state.streamingMessage`
- `state.pendingToolCalls`
- `state.errorMessage`

这让 UI 或业务层不必自己再维护一套镜像状态。

### 12.2 它管理生命周期

关键函数：

- `runWithLifecycle()`
- `finishRun()`
- `handleRunFailure()`

这层统一处理：

- active run
- abort controller
- waitForIdle promise
- 异常兜底

所以 `Agent` 很像一个“状态机壳”。

### 12.3 它提供更自然的业务 API

例如：

- `prompt()`
- `continue()`
- `steer()`
- `followUp()`
- `abort()`
- `subscribe()`

这些 API 比“直接调用低层 loop + 手写 emit + 手写 state reduce”容易太多。

所以如果你在业务代码里使用 `pi-agent-core`，通常第一选择是 `Agent`，不是直接碰 `runLoop()`。

---

## 13. `AgentHarness` 在整个体系里是什么位置

如果你继续往 `packages/agent/src/harness` 读，会发现它又是一个更高层。

核心文件：

- [`packages/agent/src/harness/agent-harness.ts`](../packages/agent/src/harness/agent-harness.ts)

它在 `Agent` 之上又加了一层“产品化编排”：

- session
- skills
- prompt templates
- resource loading
- compaction
- branch navigation
- hook system

阅读建议是：

- 第一阶段先不要看 harness
- 等你看懂 `agent-loop.ts` + `agent.ts` 后，再看 harness

否则很容易把“agent 基础机制”和“产品层集成逻辑”混在一起。

---

## 14. `coding-agent` 是怎么把 `pi-ai` 和 `pi-agent-core` 接起来的

前面我们一直在看两个“库”：

- `pi-ai`
- `pi-agent-core`

但你实际运行的 `pi` 命令，并不是直接在调用这两个库的某个裸函数。

真正把它们接起来的是：

- `packages/coding-agent`

它做的事可以概括成一句话：

> 用 `coding-agent` 自己的 **session / settings / extensions / tools / modes**，把 `pi-agent-core` 的 `Agent` 包起来，再把底层模型请求通过 `pi-ai` 的 `streamSimple()` 发出去，最后把事件交给 TUI 或 print/RPC 模式消费。

### 14.1 先看一张接线图

```text
CLI main()
  -> createAgentSessionServices()
  -> createAgentSessionFromServices()
  -> createAgentSession()
  -> new Agent(...)                       // 来自 pi-agent-core
       └─ streamFn(...) => streamSimple() // 来自 pi-ai
  -> new AgentSession(...)               // coding-agent 自己的高层会话壳
  -> new AgentSessionRuntime(...)        // 支持切 session / fork / resume
  -> InteractiveMode / PrintMode / RpcMode
       └─ session.subscribe(...)
            └─ 把 AgentSessionEvent 渲染到 UI / stdout / RPC
```

这一段链路是你理解 `coding-agent` 的关键。它说明：

- `pi-ai` 提供“统一 LLM 流”
- `pi-agent-core` 提供“agent loop”
- `coding-agent` 提供“会话、产品能力、UI、扩展系统”

### 14.2 入口：`main.ts` 只负责组装运行时

建议先看：

- [`packages/coding-agent/src/main.ts`](../packages/coding-agent/src/main.ts)

很多人第一次打开 `main.ts` 会被它吓到，因为这个文件非常长。但阅读时你不要把它当“核心算法文件”，它其实更像：

> CLI 启动器 + 运行时装配器

你只需要先抓这几个关键步骤：

1. 解析 CLI 参数
2. 创建 / 打开 `SessionManager`
3. 创建运行时 services
4. 创建 `AgentSessionRuntime`
5. 根据模式进入 `InteractiveMode` / `PrintMode` / `RpcMode`

其中最重要的不是 UI 初始化，而是这几行调用链：

- `createAgentSessionServices(...)`
- `createAgentSessionFromServices(...)`
- `createAgentSessionRuntime(...)`

也就是说，`main.ts` 本身并不直接 new `Agent`，它把这件事委托给 SDK / runtime 层。

### 14.3 真正的“接线点”在 `core/sdk.ts`

如果你只允许自己精读一个 `coding-agent` 文件，我建议先读：

- [`packages/coding-agent/src/core/sdk.ts`](../packages/coding-agent/src/core/sdk.ts)

因为这里才是真正把两个库接起来的地方。

这一层做了 4 件非常关键的事。

#### 第一件事：创建 `Agent`

在 [`sdk.ts`](../packages/coding-agent/src/core/sdk.ts) 里，最终会执行：

```typescript
agent = new Agent({
  initialState: { ... },
  convertToLlm: convertToLlmWithBlockImages,
  streamFn: async (model, context, options) => { ... },
  onPayload: async (...) => { ... },
  onResponse: async (...) => { ... },
  transformContext: async (...) => { ... },
  ...
});
```

这里的 `Agent` 来自：

- [`@earendil-works/pi-agent-core`](../packages/agent/src/agent.ts)

也就是说，`coding-agent` 并没有重新实现一个 agent loop，而是直接把 `pi-agent-core` 的 `Agent` 当底层引擎。

#### 第二件事：把 `streamFn` 接到 `pi-ai`

最关键的一行是：

```typescript
return streamSimple(model, context, { ... });
```

这里的 `streamSimple` 来自：

- [`@earendil-works/pi-ai`](../packages/ai/src/stream.ts)

这就形成了最核心的桥接：

```text
Agent.runLoop()
  -> streamAssistantResponse()
  -> config.streamFn(...)
  -> coding-agent 在 sdk.ts 里提供的 streamFn
  -> pi-ai.streamSimple(...)
  -> provider
```

这意味着 `coding-agent` 并不是简单调用默认 `streamSimple`，而是**先包了一层自己的 streamFn**，在这一层里附加：

- 从 `ModelRegistry` 动态获取 `apiKey` / `headers`
- 从 `SettingsManager` 获取 retry / timeout / transport
- 给 OpenRouter / OpenCode / Cloudflare 之类 provider 加 attribution headers
- 透传 `sessionId`

所以从架构角度看，这一层是：

> `coding-agent` 对 `pi-ai` 的“产品化适配层”

#### 第三件事：把 `Agent` 包成 `AgentSession`

在创建完 `Agent` 后，`sdk.ts` 会进一步创建：

- [`packages/coding-agent/src/core/agent-session.ts`](../packages/coding-agent/src/core/agent-session.ts)

也就是：

```typescript
const session = new AgentSession({
  agent,
  sessionManager,
  settingsManager,
  resourceLoader,
  modelRegistry,
  ...
});
```

这一步非常重要，因为从这里开始，`coding-agent` 就不再直接暴露裸 `Agent` 了，而是暴露一个更高层的“会话对象”。

### 14.4 `AgentSession`：把 agent 变成真正可用的会话

建议精读：

- [`packages/coding-agent/src/core/agent-session.ts`](../packages/coding-agent/src/core/agent-session.ts)

这个类可以理解为：

> `coding-agent` 自己的 `AgentHarness`

它和 `pi-agent-core` 的 `Agent` 相比，多出来很多产品能力：

- session 持久化
- slash command / skill / prompt template 扩展
- 自动 compaction
- 自动 retry
- model cycling
- thinking level 持久化
- bash 执行记录
- extension runner 事件桥接
- queue UI 状态维护

换句话说：

- `Agent` 解决“一个 agent run 怎么跑”
- `AgentSession` 解决“一个产品里的 agent 会话怎么活着”

#### `AgentSession` 是怎么接住 `Agent` 事件的

在构造函数里，它会做这件事：

```typescript
this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
```

也就是把 `pi-agent-core` 的低层 `AgentEvent` 接过来，统一交给 `_handleAgentEvent()`。

然后 `_handleAgentEvent()` 会继续做三件事：

1. 转发给 extensions
2. 转发给自己的 session 监听者
3. 做 session 持久化、自动重试、自动 compaction 等附加逻辑

所以这里又是一层桥：

```text
pi-agent-core.AgentEvent
  -> AgentSession._handleAgentEvent()
  -> extension events
  -> AgentSessionEvent
  -> SessionManager append / retry / compaction / queue update
```

这也是为什么在 `coding-agent` 里，上层 UI 不会直接订阅 `Agent`，而是订阅 `AgentSession`。

#### `AgentSession.prompt()` 做了什么额外工作

如果你想知道“为什么 `coding-agent` 发一个消息之前会做这么多事”，重点看：

- `AgentSession.prompt()`

它在真正调用 `this.agent.prompt(...)` 之前，会做很多 `coding-agent` 自己才关心的事情：

- 扩展命令拦截
- input hook
- skill 展开
- prompt template 展开
- streaming 时决定走 `steer` 还是 `followUp`
- 检查当前 model 和 auth
- 必要时先做 compaction
- 注入扩展生成的 custom messages
- 覆盖本轮 system prompt

然后最终才会走到：

```typescript
await this._runAgentPrompt(messages)
```

而 `_runAgentPrompt()` 内部才真正调用：

```typescript
await this.agent.prompt(messages)
```

所以从调用链上看：

```text
InteractiveMode
  -> session.prompt(...)
  -> AgentSession.prompt()
  -> _runAgentPrompt()
  -> Agent.prompt()
  -> runAgentLoop()
  -> streamFn()
  -> pi-ai.streamSimple()
```

这条链就是 `coding-agent` 把两个底层库接起来的最核心路径。

### 14.5 `AgentSessionRuntime`：让 session 可以被替换

再往上还有一层：

- [`packages/coding-agent/src/core/agent-session-runtime.ts`](../packages/coding-agent/src/core/agent-session-runtime.ts)

你可以把它理解为：

> 当前运行中的 session 容器

为什么还需要这一层？

因为 `coding-agent` 不是只跑一个固定 session，它支持：

- `/new`
- `/resume`
- `/fork`
- `/import`
- `/switch`

这些操作都会“替换当前 session”。

所以 `AgentSessionRuntime` 的职责不是跑 loop，而是：

- 持有当前 `session`
- 持有当前 `services`
- 在切 session 时 teardown 旧 runtime，再创建并 apply 新 runtime

这层和 `pi-agent-core` 没有直接算法耦合，但它是产品化必需的外壳。

### 14.6 最后一层：模式层消费 `AgentSessionEvent`

如果你想知道 UI 是怎么接上来的，看：

- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive/interactive-mode.ts)

你重点只需要看两件事：

#### 1. 订阅 session

```typescript
this.unsubscribe = this.session.subscribe(async (event) => {
  await this.handleEvent(event);
});
```

说明 interactive mode 并不直接和 `Agent` 对接，而是订阅 `AgentSessionEvent`。

#### 2. 把事件渲染成 UI

在 `handleEvent()` 里，它会根据事件类型做不同处理：

- `agent_start` -> 开启工作状态
- `queue_update` -> 刷新排队中的消息显示
- `message_start` -> 创建用户/assistant/custom 对应组件
- `message_update` -> 增量刷新 streaming assistant 组件
- `tool_execution_*` -> 渲染工具执行组件

所以模式层的角色是：

> 事件消费者，而不是控制流所有者

这点非常关键，因为它说明 `coding-agent` 保持了一个很健康的分层：

- 控制流在 `pi-agent-core`
- provider 在 `pi-ai`
- 会话与产品能力在 `AgentSession`
- 渲染与交互在 mode / TUI

### 14.7 把整条链再串一遍

现在可以把从 CLI 到模型，再回到 UI 的完整路径串起来了：

```text
main.ts
  -> createAgentSessionRuntime(...)
  -> createAgentSessionFromServices(...)
  -> createAgentSession()                         // core/sdk.ts
      -> new Agent(...)                          // pi-agent-core
          -> streamFn(...) => streamSimple(...)  // pi-ai
      -> new AgentSession(...)
  -> new InteractiveMode(runtime)
      -> session.subscribe(handleEvent)
      -> session.prompt(...)
          -> agent.prompt(...)
              -> runAgentLoop()
                  -> streamAssistantResponse()
                      -> streamFn()
                          -> pi-ai.streamSimple()
                              -> provider
                              -> AssistantMessageEventStream
                  -> AgentEvent
          -> AgentSession._handleAgentEvent()
              -> session persistence / extensions / retry / compaction
              -> AgentSessionEvent
      -> InteractiveMode.handleEvent()
          -> TUI 渲染
```

如果你能把这张图在脑子里复述出来，说明你已经真正理解了 `coding-agent` 是怎么把 `pi-ai` 和 `pi-agent-core` 接起来的。

### 14.8 开发时，应该从哪一层下手

如果你要改 `coding-agent` 对底层库的接法，建议按下面分工判断：

#### 改“模型请求前后”的行为

先看：

- [`packages/coding-agent/src/core/sdk.ts`](../packages/coding-agent/src/core/sdk.ts)

典型场景：

- 修改默认 retry / timeout
- 注入统一 headers
- 增加 provider request hooks
- 替换 `streamFn`

#### 改“消息发送前后的会话逻辑”

先看：

- [`packages/coding-agent/src/core/agent-session.ts`](../packages/coding-agent/src/core/agent-session.ts)

典型场景：

- 改 prompt 前预处理
- 改 session 持久化
- 改 auto retry / auto compaction
- 改队列显示状态

#### 改“切换 session / fork / resume”

先看：

- [`packages/coding-agent/src/core/agent-session-runtime.ts`](../packages/coding-agent/src/core/agent-session-runtime.ts)

#### 改“UI 怎么响应事件”

先看：

- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive/interactive-mode.ts)

---

## 15. 开发这两个模块时，建议怎么下手

这一节不再讲“它是什么”，而是讲“你真的要改代码时怎么切入”。

### 14.1 如果你要改 `pi-ai`

先问自己改动属于哪类：

1. 新 provider
2. provider 行为兼容
3. 统一事件协议
4. 模型元信息
5. auth / headers
6. 工具调用 / thinking / image

推荐路径：

```text
先改 provider 或 util
  -> 再看是否要改 types.ts
  -> 再看是否要改 stream.ts / registry
  -> 最后补测试
```

不要反过来从入口乱改。

### 14.2 如果你要改 `pi-agent-core`

先问自己改动属于哪类：

1. loop 节奏改动
2. tool 执行改动
3. hook 行为改动
4. state / queue 改动
5. harness 集成改动

推荐路径：

```text
loop / tool / turn 相关
  -> 先看 agent-loop.ts

state / subscribe / abort 相关
  -> 先看 agent.ts

session / skill / template / compaction 相关
  -> 再看 harness/
```

### 14.3 如果你只想“调通一个最小改动”

最小有效阅读路径是：

1. `pi-ai`
   - `stream.ts`
   - `event-stream.ts`
   - 一个 provider
2. `pi-agent-core`
   - `agent-loop.ts`
   - `agent.ts`

很多改动其实根本不需要先读完整个 monorepo。

---

## 16. 建议你这样配合阅读“源码 + 注释”

因为核心文件里我已经补了较详细的中文注释，你现在最适合的阅读方式不是只盯着这篇文档，而是：

### 路线 A：先读文档，再读核心源码

顺序：

1. 本文
2. [pi-ai-streaming-architecture.md](./pi-ai-streaming-architecture.md)
3. [`packages/ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts)
4. [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)
5. [`packages/ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)
6. [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)
7. [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)

### 路线 B：跟一条调用链边读边跳

顺序：

1. `Agent.prompt()`
2. `runPromptMessages()`
3. `runWithLifecycle()`
4. `runAgentLoop()`
5. `runLoop()`
6. `streamAssistantResponse()`
7. `streamSimple()`
8. `api-registry.ts`
9. `register-builtins.ts`
10. 某个 provider
11. `EventStream`
12. 再回到 `executeToolCalls()`

这条路线最适合你已经大致知道 agent 是什么，但想真正跟一次控制流。

---

## 17. 一个最重要的阅读心法

读这个仓库时，最容易犯的错误是：

> 看到 provider 很多、hooks 很多、tests 很多，就以为整个系统“非常分散”。

其实它的骨架非常稳定。

你只需要牢牢记住这两个中心句：

### 对 `pi-ai`

> `pi-ai` 的本质是：**把不同 provider 的请求/响应，统一翻译成同一种流式事件协议和同一种最终 `AssistantMessage`。**

### 对 `pi-agent-core`

> `pi-agent-core` 的本质是：**围绕一条 assistant 消息，执行“请求模型 -> 产出消息 -> 执行工具 -> 继续下一轮”的循环，并把过程全部事件化。**

只要你抓住这两个中心句，再大的文件都不会完全失焦。

---

## 18. 最后的源码索引

如果你只保留一张清单，建议保留下面这张。

### `pi-ai` 必看文件

- 入口
  - [`packages/ai/src/index.ts`](../packages/ai/src/index.ts)
  - [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)
- 类型与模型
  - [`packages/ai/src/types.ts`](../packages/ai/src/types.ts)
  - [`packages/ai/src/models.ts`](../packages/ai/src/models.ts)
- 核心运行时
  - [`packages/ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts)
  - [`packages/ai/src/api-registry.ts`](../packages/ai/src/api-registry.ts)
  - [`packages/ai/src/providers/register-builtins.ts`](../packages/ai/src/providers/register-builtins.ts)
- 代表 provider
  - [`packages/ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)
  - [`packages/ai/src/providers/openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts)
  - [`packages/ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts)

### `pi-agent-core` 必看文件

- 入口与核心类型
  - [`packages/agent/src/index.ts`](../packages/agent/src/index.ts)
  - [`packages/agent/src/types.ts`](../packages/agent/src/types.ts)
- 主循环
  - [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)
- 有状态封装
  - [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)
- 高层集成
  - [`packages/agent/src/harness/agent-harness.ts`](../packages/agent/src/harness/agent-harness.ts)

### `coding-agent` 里“接线”相关必看文件

- CLI 与 runtime 装配
  - [`packages/coding-agent/src/main.ts`](../packages/coding-agent/src/main.ts)
- 核心桥接
  - [`packages/coding-agent/src/core/sdk.ts`](../packages/coding-agent/src/core/sdk.ts)
- 会话壳层
  - [`packages/coding-agent/src/core/agent-session.ts`](../packages/coding-agent/src/core/agent-session.ts)
- session runtime
  - [`packages/coding-agent/src/core/agent-session-runtime.ts`](../packages/coding-agent/src/core/agent-session-runtime.ts)
- 交互模式
  - [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive/interactive-mode.ts)

### 测试入口

- [`packages/ai/test/stream.test.ts`](../packages/ai/test/stream.test.ts)
- [`packages/ai/test/abort.test.ts`](../packages/ai/test/abort.test.ts)
- [`packages/agent/test/agent-loop.test.ts`](../packages/agent/test/agent-loop.test.ts)
- [`packages/agent/test/agent.test.ts`](../packages/agent/test/agent.test.ts)

---

## 19. 一句话总结

如果你是从“开发者要改模块”的角度读这两个包，那么最正确的顺序不是：

> 先把所有源码都扫一遍

而是：

> 先抓住边界，再跟一条真实调用链，然后只在你要改的那一层深挖。

对这两个包来说，最值得先吃透的只有 6 个文件：

- [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)
- [`packages/ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts)
- [`packages/ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)
- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)
- [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)
- [`packages/agent/src/harness/agent-harness.ts`](../packages/agent/src/harness/agent-harness.ts)

先把这 6 个文件读明白，再去看剩余 provider 和 harness 子模块，你会轻松很多。
