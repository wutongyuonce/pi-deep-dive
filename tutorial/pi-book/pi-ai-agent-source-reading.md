
## 1. 为什么要拆成两个库

很多项目会把“调 LLM”和“跑 agent”写在一起，但 `pi` 把它们分成了两个库：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`

这样拆有几个直接好处。

### 1.1 `pi-ai` 可以独立使用

如果你只是想写一个：

- 多 provider 聊天程序
- 流式文本生成器
- 支持工具调用但不需要完整 agent loop 的应用

那么只需要 `pi-ai` 就够了。

核心入口可以从这里开始看：

- [`packages/ai/src/index.ts`](../packages/ai/src/index.ts)
- [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts)
- [`packages/ai/src/types.ts`](../packages/ai/src/types.ts)

### 1.2 `pi-agent-core` 不关心底层 provider 细节

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

## 2. 再理解 `pi-agent-core`：它是 agent loop，不是完整产品

### 2.1 `pi-agent-core` 的职责边界

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

### 2.2 `packages/agent` 内部怎么分层

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

## 3. `pi-agent-core` 的最短调用链

这一节只跟最核心的一条链：

```typescript
const agent = new Agent(...)
await agent.prompt("帮我做一件事")
```

### 3.1 `Agent` 是高层有状态壳层

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

### 3.2 真正的核心在 `agent-loop.ts`

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

### 3.3 一轮最小调用链

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

## 4. `runLoop()` 是真正的 agent 脑干

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

## 5. `streamAssistantResponse()` 是 `pi-agent-core` 和 `pi-ai` 的连接点

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

## 6. 工具执行链路怎么读

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

## 7. `Agent` 为什么还存在

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

## 8. `AgentHarness` 在整个体系里是什么位置

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

## 9. `coding-agent` 是怎么把 `pi-ai` 和 `pi-agent-core` 接起来的

前面我们一直在看两个“库”：

- `pi-ai`
- `pi-agent-core`

但你实际运行的 `pi` 命令，并不是直接在调用这两个库的某个裸函数。

真正把它们接起来的是：

- `packages/coding-agent`

它做的事可以概括成一句话：

> 用 `coding-agent` 自己的 **session / settings / extensions / tools / modes**，把 `pi-agent-core` 的 `Agent` 包起来，再把底层模型请求通过 `pi-ai` 的 `streamSimple()` 发出去，最后把事件交给 TUI 或 print/RPC 模式消费。

### 9.1 先看一张接线图

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

### 9.2 入口：`main.ts` 只负责组装运行时

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

### 9.3 真正的“接线点”在 `core/sdk.ts`

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

### 9.4 `AgentSession`：把 agent 变成真正可用的会话

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

### 9.5 `AgentSessionRuntime`：让 session 可以被替换

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

### 9.6 最后一层：模式层消费 `AgentSessionEvent`

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

### 9.7 把整条链再串一遍

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

### 9.8 开发时，应该从哪一层下手

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
