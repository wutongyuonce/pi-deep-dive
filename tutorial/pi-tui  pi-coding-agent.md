## [pi-tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui)

一个极简的终端 UI 框架，具有差异化渲染、同步输出以实现（几乎）无闪烁的更新，以及具有自动完成和 Markdown 渲染功能的编辑器等组件。



## [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

将所有内容（包括会话管理、自定义工具、主题和项目上下文文件）连接在一起的实际 CLI。

- Runs on Windows, Linux, and macOS (or anything with a Node.js runtime and a terminal)
  可在 Windows、Linux 和 macOS 上运行（或任何具有 Node.js 运行时和终端的操作系统）
- Multi-provider support with mid-session model switching
  支持多提供商，并可在会话期间切换模式。
- Session management with continue, resume, and branching
  会话管理，包括继续、恢复和分支
- Project context files (AGENTS.md) loaded hierarchically from global to project-specific
  项目上下文文件（AGENTS.md）按层级结构从全局到项目特定加载。
- Slash commands for common operations
  常用操作的斜杠命令
- Custom slash commands as markdown templates with argument support
  支持带参数的自定义斜杠命令作为 Markdown 模板
- API key authentication for Claude Pro/Max subscriptions
  Claude Pro/Max 订阅的 API 密钥身份验证
- Custom model and provider configuration via JSON
  通过 JSON 配置自定义模型和提供程序
- Customizable themes with live reload
  可自定义主题，支持实时重载
- Editor with fuzzy file search, path completion, drag & drop, and multi-line paste
  编辑器具备模糊文件搜索、路径自动补全、拖放和多行粘贴功能
- Message queuing while the agent is working
  代理工作时消息排队
- Image support for vision-capable models
  支持具备视觉功能的模型的图像支持
- HTML export of sessions
  会话的 HTML 导出
- Headless operation via JSON streaming and RPC mode
  通过 JSON 流和 RPC 模式进行无头操作
- Full cost and token tracking
  完整成本和代币追踪

## coding-agent 如何把 pi-ai 和 pi-agent-core 接起来

前面我们一直在看两个"库"：`pi-ai` 和 `pi-agent-core`。但你实际运行的 `pi` 命令，并不是直接在调用这两个库的某个裸函数。真正把它们接起来的是 `packages/coding-agent`。

它做的事可以概括成一句话：

> 用 `coding-agent` 自己的 **session / settings / extensions / tools / modes**，把 `pi-agent-core` 的 `Agent`（或 `AgentHarness`）包起来，再把底层模型请求通过 `pi-ai` 的 `streamSimple()` 发出去，最后把事件交给 TUI 或 print/RPC 模式消费。

### 接线全图

```text
CLI main()
  -> createAgentSessionServices()
  -> createAgentSessionFromServices()
  -> createAgentSession()
      -> new Agent(...)                          // 来自 pi-agent-core
           └─ streamFn(...) => streamSimple(...)  // 来自 pi-ai
      -> new AgentSession(...)                   // coding-agent 自己的高层会话壳
  -> new AgentSessionRuntime(...)                // 支持切 session / fork / resume
  -> InteractiveMode / PrintMode / RpcMode
       └─ session.subscribe(...)
            └─ 把 AgentSessionEvent 渲染到 UI / stdout / RPC
```

### 第一步：sdk.ts 创建 Agent 并包装 streamFn

如果你只允许自己精读一个 `coding-agent` 文件，先读 `core/sdk.ts`。这里才是真正把两个库接起来的地方。

```typescript
// core/sdk.ts（简化）
agent = new Agent({
  initialState: { ... },
  convertToLlm: convertToLlmWithBlockImages,
  streamFn: async (model, context, options) => {
    // 从 ModelRegistry 动态获取 apiKey / headers
    // 从 SettingsManager 获取 retry / timeout / transport
    // 给 OpenRouter 等 provider 加 attribution headers
    // 透传 sessionId
    return streamSimple(model, context, { ... });
  },
  transformContext: async (...) => { ... },
  beforeToolCall: async (...) => { ... },
  afterToolCall: async (...) => { ... },
  ...
});
```

注意 `streamFn` 不是直接用 `streamSimple`，而是**包了一层**。这一层是 `coding-agent` 对 `pi-ai` 的"产品化适配层"——附加 apiKey、headers、retry 策略、provider 特定的 attribution headers。

### 第二步：AgentSession 接住 Agent 事件

创建完 Agent 后，sdk.ts 进一步创建 `AgentSession`：

```typescript
const session = new AgentSession({ agent, sessionManager, settingsManager, ... });
```

`AgentSession` 在构造函数里订阅 Agent 事件：

```typescript
this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
```

`_handleAgentEvent()` 做三件事：

1. 转发给 extensions
2. 转发给自己的 session 监听者
3. 做 session 持久化、自动重试、自动 compaction

```text
pi-agent-core.AgentEvent
  -> AgentSession._handleAgentEvent()
  -> extension events
  -> AgentSessionEvent
  -> SessionManager append / retry / compaction / queue update
```

### 第三步：AgentSessionRuntime 管理 session 切换

`coding-agent` 不是只跑一个固定 session，它支持 `/new`、`/resume`、`/fork`、`/import`、`/switch`。`AgentSessionRuntime` 的职责是持有当前 session，在切 session 时 teardown 旧 runtime，再创建并 apply 新 runtime。

### 第四步：模式层消费事件渲染 UI

InteractiveMode 不直接和 Agent 对接，而是订阅 `AgentSessionEvent`：

```typescript
this.unsubscribe = this.session.subscribe(async (event) => {
  await this.handleEvent(event);
});
```

在 `handleEvent()` 里根据事件类型做不同处理：

- `agent_start` -> 开启工作状态
- `queue_update` -> 刷新排队中的消息显示
- `message_start` -> 创建用户/assistant/custom 对应组件
- `message_update` -> 增量刷新 streaming assistant 组件
- `tool_execution_*` -> 渲染工具执行组件

模式层的角色是**事件消费者，而不是控制流所有者**。这保证了一个很健康的分层：

- 控制流在 `pi-agent-core`
- provider 在 `pi-ai`
- 会话与产品能力在 `AgentSession`
- 渲染与交互在 mode / TUI

### 完整路径

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

### 开发时应该从哪一层下手

| 你要改什么             | 先看哪个文件                            |
| ---------------------- | --------------------------------------- |
| 模型请求前后的行为     | `core/sdk.ts`                           |
| 消息发送前后的会话逻辑 | `core/agent-session.ts`                 |
| 切换 session / fork    | `core/agent-session-runtime.ts`         |
| UI 怎么响应事件        | `modes/interactive/interactive-mode.ts` |
