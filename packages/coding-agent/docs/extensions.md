> pi 可以创建扩展。让 pi 为你的用例构建一个。

# 扩展

扩展是 TypeScript 模块，用于扩展 pi 的行为。它们可以订阅生命周期事件、注册 LLM 可调用的自定义工具、添加命令等。

> **放置位置以便 /reload：** 将扩展放在 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（项目本地）以实现自动发现。仅用于快速测试时使用 `pi -e ./path.ts`。在自动发现位置的扩展可以通过 `/reload` 热重载。

**关键能力：**
- **自定义工具** - 通过 `pi.registerTool()` 注册 LLM 可以调用的工具
- **事件拦截** - 阻止或修改工具调用、注入上下文、自定义压缩
- **用户交互** - 通过 `ctx.ui` 提示用户（选择、确认、输入、通知）
- **自定义 UI 组件** - 通过 `ctx.ui.custom()` 实现带有键盘输入的完整 TUI 组件，用于复杂交互
- **自定义命令** - 通过 `pi.registerCommand()` 注册类似 `/mycommand` 的命令
- **会话持久化** - 通过 `pi.appendEntry()` 存储在重启后仍然保留的状态
- **自定义渲染** - 控制工具调用/结果和消息在 TUI 中的显示方式

**示例用例：**
- 权限门控（在 `rm -rf`、`sudo` 等操作前确认）
- Git 检查点（每轮 stash，分支时恢复）
- 路径保护（阻止写入 `.env`、`node_modules/`）
- 自定义压缩（按你的方式总结对话）
- 对话摘要（参见 `summarize.ts` 示例）
- 交互式工具（问题、向导、自定义对话框）
- 有状态工具（待办列表、连接池）
- 外部集成（文件监听器、webhooks、CI 触发器）
- 等待时的游戏（参见 `snake.ts` 示例）

参见 [examples/extensions/](../examples/extensions/) 获取可运行的实现。

## 目录

- [快速开始](#快速开始)
- [扩展位置](#扩展位置)
- [可用导入](#可用导入)
- [编写扩展](#编写扩展)
  - [扩展风格](#扩展风格)
- [事件](#事件)
  - [生命周期概述](#生命周期概述)
  - [资源事件](#资源事件)
  - [会话事件](#会话事件)
  - [代理事件](#代理事件)
  - [模型事件](#模型事件)
  - [工具事件](#工具事件)
- [ExtensionContext](#extensioncontext)
- [ExtensionCommandContext](#extensioncommandcontext)
- [ExtensionAPI 方法](#extensionapi-方法)
- [状态管理](#状态管理)
- [自定义工具](#自定义工具)
- [自定义 UI](#自定义-ui)
- [错误处理](#错误处理)
- [模式行为](#模式行为)
- [示例参考](#示例参考)

## 快速开始

创建 `~/.pi/agent/extensions/my-extension.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 响应事件
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("扩展已加载！", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("危险操作！", "允许执行 rm -rf 吗？");
      if (!ok) return { block: true, reason: "用户已阻止" };
    }
  });

  // 注册自定义工具
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "按名称问候某人",
    parameters: Type.Object({
      name: Type.String({ description: "要问候的名称" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `你好，${params.name}！` }],
        details: {},
      };
    },
  });

  // 注册命令
  pi.registerCommand("hello", {
    description: "问好",
    handler: async (args, ctx) => {
      ctx.ui.notify(`你好 ${args || "世界"}！`, "info");
    },
  });
}
```

使用 `--extension`（或 `-e`）标志测试：

```bash
pi -e ./my-extension.ts
```

## 扩展位置

> **安全提示：** 扩展以你的完整系统权限运行，可以执行任意代码。仅从你信任的来源安装。

扩展从以下位置自动发现：

| 位置 | 范围 |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | 全局（所有项目） |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录） |
| `.pi/extensions/*.ts` | 项目本地 |
| `.pi/extensions/*/index.ts` | 项目本地（子目录） |

通过 `settings.json` 添加额外路径：

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

要通过 npm 或 git 以 pi 包的形式分享扩展，请参阅 [packages.md](zh/packages.md)。

## 可用导入

| 包 | 用途 |
|---------|---------|
| `@earendil-works/pi-coding-agent` | 扩展类型（`ExtensionAPI`、`ExtensionContext`、事件） |
| `typebox` | 工具参数的模式定义 |
| `@earendil-works/pi-ai` | AI 工具函数（用于 Google 兼容枚举的 `StringEnum`） |
| `@earendil-works/pi-tui` | 用于自定义渲染的 TUI 组件 |

npm 依赖同样可用。在扩展旁边（或父目录中）添加 `package.json`，运行 `npm install`，从 `node_modules/` 的导入会自动解析。

对于通过 `pi install`（npm 或 git）安装的分布式 pi 包，运行时依赖必须放在 `dependencies` 中。包安装默认使用生产安装（`npm install --omit=dev`），因此 `devDependencies` 在运行时不可用；当配置了 `npmCommand` 时，git 包使用普通 `install` 以兼容包装器。

Node.js 内置模块（`node:fs`、`node:path` 等）同样可用。

## 编写扩展

扩展导出一个默认的工厂函数，该函数接收 `ExtensionAPI`。工厂函数可以是同步或异步的：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 订阅事件
  pi.on("event_name", async (event, ctx) => {
    // ctx.ui 用于用户交互
    const ok = await ctx.ui.confirm("标题", "你确定吗？");
    ctx.ui.notify("完成！", "info");
    ctx.ui.setStatus("my-ext", "处理中...");  // 底部状态
    ctx.ui.setWidget("my-ext", ["第1行", "第2行"]);  // 编辑器上方的小部件（默认）
  });

  // 注册工具、命令、快捷键、标志
  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
}
```

扩展通过 [jiti](https://github.com/unjs/jiti) 加载，因此 TypeScript 无需编译即可工作。

如果工厂函数返回 `Promise`，pi 会在继续启动之前等待它。这意味着异步初始化会在 `session_start`、`resources_discover` 以及通过 `pi.registerProvider()` 排队的提供者注册刷新之前完成。

### 异步工厂函数

对一次性启动工作（如获取远程配置或动态发现可用模型）使用异步工厂。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

这种模式使获取的模型在正常启动期间和 `pi --list-models` 中都可用。

### 扩展风格

**单个文件** - 最简单，适用于小型扩展：

```
~/.pi/agent/extensions/
└── my-extension.ts
```

**带 index.ts 的目录** - 适用于多文件扩展：

```
~/.pi/agent/extensions/
└── my-extension/
    ├── index.ts        # 入口点（导出默认函数）
    ├── tools.ts        # 辅助模块
    └── utils.ts        # 辅助模块
```

**带有依赖的包** - 适用于需要 npm 包的扩展：

```
~/.pi/agent/extensions/
└── my-extension/
    ├── package.json    # 声明依赖和入口点
    ├── package-lock.json
    ├── node_modules/   # npm install 之后
    └── src/
        └── index.ts
```

```json
// package.json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0",
    "chalk": "^5.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

在扩展目录中运行 `npm install`，然后从 `node_modules/` 的导入会自动生效。

## 事件

### 生命周期概述

```
pi 启动
  │
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
用户发送提示 ─────────────────────────────────────────┐
  │                                                        │
  ├─► （先检查扩展命令，如果找到则绕过）                      │
  ├─► input（可以拦截、转换或处理）                            │
  ├─► （如果未处理，进行 skill/模板扩展）                      │
  ├─► before_agent_start（可以注入消息、修改系统提示）        │
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── 轮次（LLM 调用工具时重复） ───┐                   │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context（可以修改消息）                     │       │
  │   ├─► before_provider_request（可以检查或替换负载）│       │
  │   ├─► after_provider_response（状态 + 头部，流消费前）   │
  │   │                                            │       │
  │   │   LLM 响应，可能调用工具：                    │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call（可以阻止）                │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result（可以修改）              │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  └─► agent_end                                            │
                                                           │
用户发送另一个提示 ◄────────────────────────────────────────┘

/new（新会话）或 /resume（切换会话）
  ├─► session_before_switch（可以取消）
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume", previousSessionFile? }
  └─► resources_discover { reason: "startup" }

/fork 或 /clone
  ├─► session_before_fork（可以取消）
  ├─► session_shutdown
  ├─► session_start { reason: "fork", previousSessionFile }
  └─► resources_discover { reason: "startup" }

/compact 或自动压缩
  ├─► session_before_compact（可以取消或自定义）
  └─► session_compact

/tree 导航
  ├─► session_before_tree（可以取消或自定义）
  └─► session_tree

/model 或 Ctrl+P（模型选择/切换）
  ├─► thinking_level_select（如果模型更改/限制了思维层级）
  └─► model_select

思维层级变更（设置、快捷键、pi.setThinkingLevel()）
  └─► thinking_level_select

退出（Ctrl+C、Ctrl+D、SIGHUP、SIGTERM）
  └─► session_shutdown
```

### 资源事件

#### resources_discover

在 `session_start` 之后触发，以便扩展可以贡献额外的 skill、prompt 和主题路径。启动路径使用 `reason: "startup"`。重新加载使用 `reason: "reload"`。

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  // event.cwd - 当前工作目录
  // event.reason - "startup" | "reload"
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

### 会话事件

有关会话存储内部机制和 SessionManager API，请参阅[会话格式](zh/session-format.md)。

#### session_start

在会话启动、加载或重新加载时触发。

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile - 在 "new"、"resume" 和 "fork" 时存在
  ctx.ui.notify(`会话：${ctx.sessionManager.getSessionFile() ?? "临时"}`, "info");
});
```

#### session_before_switch

在开始新会话（`/new`）或切换会话（`/resume`）之前触发。

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" 或 "resume"
  // event.targetSessionFile - 要切换到的会话（仅 "resume"）

  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("清除？", "删除所有消息？");
    if (!ok) return { cancel: true };
  }
});
```

切换或新会话操作成功后，pi 会为旧扩展实例发出 `session_shutdown`，为新会话重新加载并重新绑定扩展，然后发出带有 `reason: "new" | "resume"` 和 `previousSessionFile` 的 `session_start`。在 `session_shutdown` 中执行清理工作，然后在 `session_start` 中重建任何内存中的状态。

#### session_before_fork

在通过 `/fork` 分支或通过 `/clone` 克隆时触发。

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId - 所选记录的 ID
  // event.position - 对于 /fork 为 "before"，对于 /clone 为 "at"
  return { cancel: true }; // 取消分支/克隆
  // 或者
  return { skipConversationRestore: true }; // 保留用于将来的对话恢复控制
});
```

分支或克隆成功后，pi 会为旧扩展实例发出 `session_shutdown`，为新会话重新加载并重新绑定扩展，然后发出带有 `reason: "fork"` 和 `previousSessionFile` 的 `session_start`。在 `session_shutdown` 中执行清理工作，然后在 `session_start` 中重建任何内存中的状态。

#### session_before_compact / session_compact

在压缩时触发。有关详细信息，请参阅 [compaction.md](zh/compaction.md)。

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // 取消：
  return { cancel: true };

  // 自定义摘要：
  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});

pi.on("session_compact", async (event, ctx) => {
  // event.compactionEntry - 保存的压缩记录
  // event.fromExtension - 是否由扩展提供
});
```

#### session_before_tree / session_tree

在 `/tree` 导航时触发。有关树形导航概念，请参阅[会话](zh/sessions.md)。

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;
  return { cancel: true };
  // 或者提供自定义摘要：
  return { summary: { summary: "...", details: {} } };
});

pi.on("session_tree", async (event, ctx) => {
  // event.newLeafId, oldLeafId, summaryEntry, fromExtension
});
```

#### session_shutdown

在扩展运行时被拆除之前触发。

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - 会话替换流程的目标会话
  // 清理、保存状态等
});
```

### 代理事件

#### before_agent_start

在用户提交提示后、代理循环开始前触发。可以注入消息和/或修改系统提示。

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt - 用户的提示文本
  // event.images - 附加的图片（如果有）
  // event.systemPrompt - 当前为此处理器链接的系统提示
  //   （包括之前 before_agent_start 处理器的更改）
  // event.systemPromptOptions - 用于构建系统提示的结构化选项
  //   .customPrompt - 任何自定义系统提示（来自 --system-prompt、SYSTEM.md 或自定义模板）
  //   .selectedTools - 当前在提示中激活的工具
  //   .toolSnippets - 每个工具的一行描述
  //   .promptGuidelines - 自定义指南条目
  //   .appendSystemPrompt - 来自 --append-system-prompt 标志的文本
  //   .cwd - 工作目录
  //   .contextFiles - AGENTS.md 文件和其他已加载的上下文文件
  //   .skills - 已加载的 skill

  return {
    // 注入持久化消息（存储在会话中，发送给 LLM）
    message: {
      customType: "my-extension",
      content: "LLM 的额外上下文",
      display: true,
    },
    // 替换本轮的系统提示（跨扩展链接）
    systemPrompt: event.systemPrompt + "\n\n本轮额外指令...",
  };
});
```

`systemPromptOptions` 字段让扩展可以访问 Pi 用于构建系统提示的相同结构化数据。这使你能够检查 Pi 已加载的内容——自定义提示、指南、工具片段、上下文文件、skill——而无需重新发现资源或重新解析标志。当你的扩展需要对系统提示进行深入、知情的修改，同时尊重用户提供的配置时，可以使用它。

在 `before_agent_start` 内部，`event.systemPrompt` 和 `ctx.getSystemPrompt()` 都反映当前处理器的链接系统提示。后面的 `before_agent_start` 处理器仍然可以再次修改它。

#### agent_start / agent_end

每个用户提示触发一次。

```typescript
pi.on("agent_start", async (_event, ctx) => {});

pi.on("agent_end", async (event, ctx) => {
  // event.messages - 来自此提示的消息
});
```

#### turn_start / turn_end

每轮触发一次（一次 LLM 响应 + 工具调用）。

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### message_start / message_update / message_end

为消息生命周期更新触发。

- `message_start` 和 `message_end` 为用户、助手和 toolResult 消息触发。
- `message_update` 为助手流式更新触发。
- `message_end` 处理器可以返回 `{ message }` 来替换最终消息。替换必须保持相同的 `role`。

```typescript
pi.on("message_start", async (event, ctx) => {
  // event.message
});

pi.on("message_update", async (event, ctx) => {
  // event.message
  // event.assistantMessageEvent（逐 token 流事件）
});

pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;

  return {
    message: {
      ...event.message,
      usage: {
        ...event.message.usage,
        cost: {
          ...event.message.usage.cost,
          total: 0.123,
        },
      },
    },
  };
});
```

#### tool_execution_start / tool_execution_update / tool_execution_end

为工具执行生命周期更新触发。

在并行工具模式下：
- `tool_execution_start` 在预检阶段按助手源顺序发出
- `tool_execution_update` 事件可能在不同工具之间交错
- `tool_execution_end` 在每个工具完成后按工具完成顺序发出
- 最终的 `toolResult` 消息事件仍然稍后按助手源顺序发出

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

pi.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### context

在每次 LLM 调用之前触发。以非破坏性方式修改消息。有关消息类型，请参阅[会话格式](zh/session-format.md)。

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages - 深拷贝，可以安全修改
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### before_provider_request

在构建好提供者特定负载之后、请求发送之前触发。处理器按扩展加载顺序运行。返回 `undefined` 保持负载不变。返回任何其他值将替换后续处理器和实际请求的负载。

此钩子可以重写提供者级别的系统指令或完全移除它们。这些负载级别的更改不会反映在 `ctx.getSystemPrompt()` 中，后者报告的是 Pi 的系统提示字符串，而非最终序列化的提供者负载。

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // 可选：替换负载
  // return { ...event.payload, temperature: 0 };
});
```

这主要用于调试提供者序列化和缓存行为。

#### after_provider_response

在收到 HTTP 响应之后、消耗其流式内容之前触发。处理器按扩展加载顺序运行。

```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status - HTTP 状态码
  // event.headers - 规范化的响应头
  if (event.status === 429) {
    console.log("请求频率受限", event.headers["retry-after"]);
  }
});
```

头部可用性取决于提供者和传输方式。抽象 HTTP 响应的提供者可能不会暴露头部。

### 模型事件

#### model_select

当模型通过 `/model` 命令、模型切换（`Ctrl+P`）或会话恢复更改时触发。

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model - 新选择的模型
  // event.previousModel - 先前的模型（首次选择时为 undefined）
  // event.source - "set" | "cycle" | "restore"

  const prev = event.previousModel
    ? `${event.previousModel.provider}/${event.previousModel.id}`
    : "none";
  const next = `${event.model.provider}/${event.model.id}`;

  ctx.ui.notify(`模型已更改 (${event.source})：${prev} -> ${next}`, "info");
});
```

当活动模型更改时，使用此事件更新 UI 元素（状态栏、页脚）或执行特定于模型的初始化。

#### thinking_level_select

当思维层级更改时触发。此事件仅用于通知；处理器返回值被忽略。

```typescript
pi.on("thinking_level_select", async (event, ctx) => {
  // event.level - 新选择的思维层级
  // event.previousLevel - 先前的思维层级

  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

当 `pi.setThinkingLevel()`、模型更改或内置思维层级控件更改活动思维层级时，使用此事件更新扩展 UI。

### 工具事件

#### tool_call

在 `tool_execution_start` 之后、工具执行之前触发。**可以阻止。** 使用 `isToolCallEventType` 来缩小范围并获取类型化输入。

在 `tool_call` 运行之前，pi 会等待先前发出的代理事件通过 `AgentSession` 排空。这意味着 `ctx.sessionManager` 通过当前的助手工具调用消息保持最新。

在默认的并行工具执行模式下，来自同一助手消息的同级工具调用会按顺序预检，然后并发执行。`tool_call` 不保证能在 `ctx.sessionManager` 中看到来自同一助手消息的同级工具结果。

`event.input` 是可变的。就地修改它以在执行前修补工具参数。

行为保证：
- 对 `event.input` 的修改会影响实际的工具执行
- 后面的 `tool_call` 处理器会看到前面处理器所做的修改
- 修改后不会重新进行验证
- `tool_call` 的返回值仅通过 `{ block: true, reason?: string }` 控制是否阻止

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // event.toolName - "bash", "read", "write", "edit" 等
  // event.toolCallId
  // event.input - 工具参数（可变）

  // 内置工具：不需要类型参数
  if (isToolCallEventType("bash", event)) {
    // event.input 为 { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "危险命令" };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input 为 { path: string; offset?: number; limit?: number }
    console.log(`读取：${event.input.path}`);
  }
});
```

#### 类型化自定义工具输入

自定义工具应导出其输入类型：

```typescript
// my-extension.ts
export type MyToolInput = Static<typeof myToolSchema>;
```

使用带有显式类型参数的 `isToolCallEventType`：

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { MyToolInput } from "my-extension";

pi.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action;  // 类型化
  }
});
```

#### tool_result

在工具执行完成之后、`tool_execution_end` 以及最终工具结果消息事件发出之前触发。**可以修改结果。**

在并行工具模式下，`tool_result` 和 `tool_execution_end` 可能按工具完成顺序交错，而最终的 `toolResult` 消息事件仍稍后按助手源顺序发出。

`tool_result` 处理器像中间件一样链式工作：
- 处理器按扩展加载顺序运行
- 每个处理器在看到前一个处理器更改后的最新结果
- 处理器可以返回部分补丁（`content`、`details` 或 `isError`）；省略的字段保持当前值

使用 `ctx.signal` 在处理器内部进行嵌套的异步工作。这让 Esc 可以取消模型调用、`fetch()` 以及扩展启动的其他可中止操作。

```typescript
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError

  if (isBashToolResult(event)) {
    // event.details 类型为 BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,
  });

  // 修改结果：
  return { content: [...], details: {...}, isError: false };
});
```

### 用户 Bash 事件

#### user_bash

当用户执行 `!` 或 `!!` 命令时触发。**可以拦截。**

```typescript
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

pi.on("user_bash", (event, ctx) => {
  // event.command - bash 命令
  // event.excludeFromContext - 如果使用 !! 前缀则为 true
  // event.cwd - 工作目录

  // 选项 1：提供自定义操作（例如 SSH）
  return { operations: remoteBashOps };

  // 选项 2：包装 pi 的内置本地 bash 后端
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      }
    }
  };

  // 选项 3：完全替换 - 直接返回结果
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

### 输入事件

#### input

当接收到用户输入时触发，在扩展命令检查之后、skill 和模板扩展之前。事件看到的是原始输入文本，因此 `/skill:foo` 和 `/template` 尚未被扩展。

**处理顺序：**
1. 先检查扩展命令（`/cmd`）——如果找到，处理器运行并跳过 input 事件
2. `input` 事件触发——可以拦截、转换或处理
3. 如果未处理：skill 命令（`/skill:name`）扩展为 skill 内容
4. 如果未处理：提示模板（`/template`）扩展为模板内容
5. 代理处理开始（`before_agent_start` 等）

```typescript
pi.on("input", async (event, ctx) => {
  // event.text - 原始输入（在 skill/模板扩展之前）
  // event.images - 附加的图片（如果有）
  // event.source - "interactive"（键入）、"rpc"（API）或 "extension"（通过 sendUserMessage）

  // 转换：在扩展之前重写输入
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `简洁回答：${event.text.slice(7)}` };

  // 处理：无需 LLM 即可响应（扩展显示自己的反馈）
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  // 按来源路由：跳过扩展注入的消息的处理
  if (event.source === "extension") return { action: "continue" };

  // 在扩展之前拦截 skill 命令
  if (event.text.startsWith("/skill:")) {
    // 可以转换、阻止或让其通过
  }

  return { action: "continue" };  // 默认：传递到扩展
});
```

**结果：**
- `continue` - 原样传递（如果处理器不返回任何内容，则为默认）
- `transform` - 修改文本/图片，然后继续到扩展
- `handled` - 完全跳过代理（第一个返回此值的处理器生效）

转换在处理器之间链式工作。参见 [input-transform.ts](../examples/extensions/input-transform.ts)。

## ExtensionContext

所有处理器都接收 `ctx: ExtensionContext`。

### ctx.ui

用于用户交互的 UI 方法。有关完整详情，请参阅[自定义 UI](#自定义-ui)。

### ctx.hasUI

在打印模式（`-p`）和 JSON 模式下为 `false`。在交互式和 RPC 模式下为 `true`。在 RPC 模式下，对话框方法（`select`、`confirm`、`input`、`editor`）通过扩展 UI 子协议工作，即发即弃方法（`notify`、`setStatus`、`setWidget`、`setTitle`、`setEditorText`）向客户端发出请求。某些特定于 TUI 的方法是空操作或返回默认值（参见 [rpc.md](zh/rpc.md#extension-ui-protocol)）。

### ctx.cwd

当前工作目录。

### ctx.sessionManager

对会话状态的只读访问。有关完整的 SessionManager API 和记录类型，请参阅[会话格式](zh/session-format.md)。

对于 `tool_call`，此状态在处理器运行之前通过当前助手消息同步。在并行工具执行模式下，仍不保证包含来自同一助手消息的同级工具结果。

```typescript
ctx.sessionManager.getEntries()       // 所有记录
ctx.sessionManager.getBranch()        // 当前分支
ctx.sessionManager.getLeafId()        // 当前叶子记录 ID
```

### ctx.modelRegistry / ctx.model

访问模型和 API 密钥。

### ctx.signal

当前代理中止信号，当没有代理轮次活动时为 `undefined`。

用于扩展处理器启动的可中止嵌套工作，例如：
- `fetch(..., { signal: ctx.signal })`
- 接受 `signal` 的模型调用
- 接受 `AbortSignal` 的文件或进程工具

`ctx.signal` 通常在活动轮次事件期间定义，例如 `tool_call`、`tool_result`、`message_update` 和 `turn_end`。在空闲或非轮次上下文中（例如会话事件、扩展命令以及在 pi 空闲时触发的快捷键），它通常为 `undefined`。

```typescript
pi.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

控制流辅助方法。

### ctx.shutdown()

请求优雅关闭 pi。

- **交互模式：** 延迟到代理变为空闲（处理完所有排队的引导和后续消息后）。
- **RPC 模式：** 延迟到下一个空闲状态（完成当前命令响应后，等待下一个命令时）。
- **打印模式：** 空操作。进程在所有提示处理完成后自动退出。

在退出前向所有扩展发出 `session_shutdown` 事件。在所有上下文中可用（事件处理器、工具、命令、快捷键）。

```typescript
pi.on("tool_call", (event, ctx) => {
  if (isFatal(event.input)) {
    ctx.shutdown();
  }
});
```

### ctx.getContextUsage()

返回活动模型的当前上下文使用情况。在可用时使用最后一次助手的用量数据，然后为后续消息估算 token。

```typescript
const usage = ctx.getContextUsage();
if (usage && usage.tokens > 100_000) {
  // ...
}
```

### ctx.compact()

触发压缩而不等待完成。使用 `onComplete` 和 `onError` 进行后续操作。

```typescript
ctx.compact({
  customInstructions: "关注最近的更改",
  onComplete: (result) => {
    ctx.ui.notify("压缩完成", "info");
  },
  onError: (error) => {
    ctx.ui.notify(`压缩失败：${error.message}`, "error");
  },
});
```

### ctx.getSystemPrompt()

返回 Pi 当前的系统提示字符串。

- 在 `before_agent_start` 期间，这反映当前轮次迄今为止的链接系统提示更改。
- 不包括后续的 `context` 消息修改。
- 不包括 `before_provider_request` 负载重写。
- 如果稍后加载的扩展在你的扩展之后运行，它们仍然可以更改最终发送的内容。

```typescript
pi.on("before_agent_start", (event, ctx) => {
  const prompt = ctx.getSystemPrompt();
  console.log(`系统提示长度：${prompt.length}`);
});
```

## ExtensionCommandContext

命令处理器接收 `ExtensionCommandContext`，它扩展了 `ExtensionContext` 并添加了会话控制方法。这些仅在命令中可用，因为如果在事件处理器中调用可能会导致死锁。

### ctx.waitForIdle()

等待代理完成流式输出：

```typescript
pi.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // 代理现在空闲，可以安全修改会话
  },
});
```

### ctx.newSession(options?)

创建新会话：

```typescript
const parentSession = ctx.sessionManager.getSessionFile();
const kickoff = "在替换会话中继续";

const result = await ctx.newSession({
  parentSession,
  setup: async (sm) => {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "来自之前会话的上下文..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (ctx) => {
    // 此处仅使用替换会话的 ctx。
    await ctx.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // 扩展取消了新会话
}
```

选项：
- `parentSession`：要在新会话头部中记录的父会话文件
- `setup`：在 `withSession` 运行之前修改新会话的 `SessionManager`
- `withSession`：针对新的替换会话上下文运行切换后工作。不要使用捕获的旧 `pi` / 命令 `ctx`；请参阅[会话替换生命周期和陷阱](#会话替换生命周期和陷阱)。

### ctx.fork(entryId, options?)

从特定记录分支，创建新会话文件：

```typescript
const result = await ctx.fork("entry-id-123", {
  withSession: async (ctx) => {
    // 此处仅使用替换会话的 ctx。
    ctx.ui.notify("现在在分支会话中", "info");
  },
});
if (result.cancelled) {
  // 扩展取消了分支
}

const cloneResult = await ctx.fork("entry-id-456", { position: "at" });
if (cloneResult.cancelled) {
  // 扩展取消了克隆
}
```

选项：
- `position`：`"before"`（默认）在所选用户消息之前分支，将该提示放入编辑器
- `position`：`"at"` 复制经过所选记录的活动路径，而不恢复编辑器文本
- `withSession`：针对新的替换会话上下文运行切换后工作。不要使用捕获的旧 `pi` / 命令 `ctx`；请参阅[会话替换生命周期和陷阱](#会话替换生命周期和陷阱)。

### ctx.navigateTree(targetId, options?)

导航到会话树中的不同点：

```typescript
const result = await ctx.navigateTree("entry-id-456", {
  summarize: true,
  customInstructions: "关注错误处理变更",
  replaceInstructions: false, // true = 完全替换默认提示
  label: "review-checkpoint",
});
```

选项：
- `summarize`：是否生成被放弃分支的摘要
- `customInstructions`：摘要器的自定义指令
- `replaceInstructions`：如果为 true，`customInstructions` 替换默认提示而不是追加
- `label`：要附加到分支摘要记录（或不进行摘要时附加到目标记录）的标签

### ctx.switchSession(sessionPath, options?)

切换到不同的会话文件：

```typescript
const result = await ctx.switchSession("/path/to/session.jsonl", {
  withSession: async (ctx) => {
    await ctx.sendUserMessage("在替换会话中恢复工作");
  },
});
if (result.cancelled) {
  // 扩展通过 session_before_switch 取消了切换
}
```

选项：
- `withSession`：针对新的替换会话上下文运行切换后工作。不要使用捕获的旧 `pi` / 命令 `ctx`；请参阅[会话替换生命周期和陷阱](#会话替换生命周期和陷阱)。

要发现可用会话，使用静态方法 `SessionManager.list()` 或 `SessionManager.listAll()`：

```typescript
import { SessionManager } from "@earendil-works/pi-coding-agent";

pi.registerCommand("switch", {
  description: "切换到另一个会话",
  handler: async (args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) return;
    const choice = await ctx.ui.select(
      "选择会话：",
      sessions.map(s => s.file),
    );
    if (choice) {
      await ctx.switchSession(choice, {
        withSession: async (ctx) => {
          ctx.ui.notify("已切换会话", "info");
        },
      });
    }
  },
});
```

### 会话替换生命周期和陷阱

`withSession` 接收一个全新的 `ReplacedSessionContext`，它通过绑定到替换会话的异步 `sendMessage()` 和 `sendUserMessage()` 辅助方法扩展了 `ExtensionCommandContext`。

生命周期和陷阱：
- `withSession` 仅在旧会话发出 `session_shutdown`、旧运行时已拆除、替换会话已重新绑定并且新的扩展实例已接收 `session_start` 之后运行。
- 回调仍在原始闭包中执行，而非在新的扩展实例内部。这意味着在 `withSession` 开始之前，你的旧扩展实例可能已经运行了其关闭清理。
- 捕获的旧 `pi` / 旧命令 `ctx` 中与会话绑定的对象在替换后已过期，如果使用将会抛出异常。仅使用传递给 `withSession` 的 `ctx` 进行会话绑定工作。
- 先前提取的原始对象仍由你负责。例如，如果你在替换前捕获了 `const sm = ctx.sessionManager`，`sm` 仍然是旧的 `SessionManager` 对象。替换后不要重复使用它。
- `withSession` 中的代码应假设任何被你的 `session_shutdown` 处理器失效的状态已经消失。仅捕获能在关闭时被干净保留的纯数据，例如字符串、ID 和序列化配置。

安全模式：

```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const kickoff = "从替换会话继续";
    await ctx.newSession({
      withSession: async (ctx) => {
        await ctx.sendUserMessage(kickoff);
      },
    });
  },
});
```

不安全模式：

```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const oldSessionManager = ctx.sessionManager;
    await ctx.newSession({
      withSession: async (_ctx) => {
        // 过期的旧对象：不要这样做
        oldSessionManager.getSessionFile();
        pi.sendUserMessage("错误");
      },
    });
  },
});
```

### ctx.reload()

执行与 `/reload` 相同的重新加载流程。

```typescript
pi.registerCommand("reload-runtime", {
  description: "重新加载扩展、技能、提示和主题",
  handler: async (_args, ctx) => {
    await ctx.reload();
    return;
  },
});
```

重要行为：
- `await ctx.reload()` 为当前扩展运行时发出 `session_shutdown`
- 然后重新加载资源并发出带有 `reason: "reload"` 的 `session_start` 和带有 `reason: "reload"` 的 `resources_discover`
- 当前正在运行的命令处理器仍在旧调用帧中继续执行
- `await ctx.reload()` 之后的代码仍从重新加载前的版本运行
- `await ctx.reload()` 之后的代码不能假定旧的进程内扩展状态仍然有效
- 在处理器返回后，未来的命令/事件/工具调用将使用新的扩展版本

为了可预测的行为，将重新加载视为该处理器的终止点（`await ctx.reload(); return;`）。

工具运行时使用 `ExtensionContext`，因此它们不能直接调用 `ctx.reload()`。使用命令作为重新加载入口点，然后公开一个将该命令作为后续用户消息排队的工具。

LLM 可用于触发重新加载的示例工具：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-runtime", {
    description: "重新加载扩展、技能、提示和主题",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "重新加载扩展、技能、提示和主题",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "已将 /reload-runtime 排队为后续命令。" }],
      };
    },
  });
}
```

## ExtensionAPI 方法

### pi.on(event, handler)

订阅事件。有关事件类型和返回值，请参阅[事件](#事件)。

### pi.registerTool(definition)

注册 LLM 可调用的自定义工具。有关完整详情，请参阅[自定义工具](#自定义工具)。

`pi.registerTool()` 在扩展加载期间和启动后都可以使用。你可以在 `session_start`、命令处理器或其他事件处理器内部调用它。新工具会在同一会话中立即刷新，因此它们会出现在 `pi.getAllTools()` 中，LLM 无需 `/reload` 即可调用它们。

使用 `pi.setActiveTools()` 在运行时启用或禁用工具（包括动态添加的工具）。

使用 `promptSnippet` 让自定义工具在 `Available tools` 中拥有一行条目；使用 `promptGuidelines` 在工具激活时追加特定于工具的条目到默认的 `Guidelines` 部分。

**重要：** `promptGuidelines` 条目被平坦地追加到 `Guidelines` 部分，没有工具名称前缀。每条指南必须指明其引用的工具——避免使用"使用此工具当..."，因为 LLM 无法判断"此"指的是哪个工具。请使用"当...时，使用 my_tool"。

请参阅 [dynamic-tools.ts](../examples/extensions/dynamic-tools.ts) 获取完整示例。

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "此工具的功能",
  promptSnippet: "根据动作总结或转换文本",
  promptGuidelines: ["当用户要求总结先前生成的文本时，使用 my_tool。"],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // 可选的兼容性垫片。在模式验证之前运行。
    // 返回当前模式形状，例如将遗留字段折叠到现代参数对象中。
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 流式进度
    onUpdate?.({ content: [{ type: "text", text: "工作中..." }] });

    return {
      content: [{ type: "text", text: "完成" }],
      details: { result: "..." },
    };
  },

  // 可选：自定义渲染
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

### pi.sendMessage(message, options?)

将会话注入自定义消息。

```typescript
pi.sendMessage({
  customType: "my-extension",
  content: "消息文本",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

**选项：**
- `deliverAs` - 传递模式：
  - `"steer"`（默认）- 在流式输出时排队。在当前助手轮次执行完其工具调用后、下一次 LLM 调用前传递。
  - `"followUp"` - 等待代理完成。仅在代理没有更多工具调用时传递。
  - `"nextTurn"` - 为下一个用户提示排队。不中断或触发任何操作。
- `triggerTurn: true` - 如果代理空闲，立即触发 LLM 响应。仅适用于 `"steer"` 和 `"followUp"` 模式（对 `"nextTurn"` 忽略）。

### pi.sendUserMessage(content, options?)

向代理发送用户消息。与 `sendMessage()` 发送自定义消息不同，此方法发送的是实际的用户消息，看起来就像用户键入的一样。始终触发一轮对话。

```typescript
// 简单文本消息
pi.sendUserMessage("2+2 等于多少？");

// 带内容数组（文本 + 图片）
pi.sendUserMessage([
  { type: "text", text: "描述这张图片：" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// 流式输出期间 - 必须指定传递模式
pi.sendUserMessage("关注错误处理", { deliverAs: "steer" });
pi.sendUserMessage("然后总结", { deliverAs: "followUp" });
```

**选项：**
- `deliverAs` - 当代理正在流式输出时必须指定：
  - `"steer"` - 排队消息，在当前助手轮次完成其工具调用后传递
  - `"followUp"` - 等待代理完成所有工具

当不在流式输出时，消息立即发送并触发新轮次。在流式输出时未指定 `deliverAs` 会抛出错误。

参见 [send-user-message.ts](../examples/extensions/send-user-message.ts) 获取完整示例。

### pi.appendEntry(customType, data?)

持久化扩展状态（不参与 LLM 上下文）。

```typescript
pi.appendEntry("my-state", { count: 42 });

// 在重新加载时恢复
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // 从 entry.data 重建
    }
  }
});
```

### pi.setSessionName(name)

设置会话显示名称（在会话选择器中显示，而非第一条消息）。

```typescript
pi.setSessionName("重构认证模块");
```

### pi.getSessionName()

获取当前会话名称（如果已设置）。

```typescript
const name = pi.getSessionName();
if (name) {
  console.log(`会话：${name}`);
}
```

### pi.setLabel(entryId, label)

设置或清除记录上的标签。标签是用户定义的标记，用于书签和导航（在 `/tree` 选择器中显示）。

```typescript
// 设置标签
pi.setLabel(entryId, "checkpoint-before-refactor");

// 清除标签
pi.setLabel(entryId, undefined);

// 通过 sessionManager 读取标签
const label = ctx.sessionManager.getLabel(entryId);
```

标签在会话中持久化，并在重启后保留。使用它们标记对话树中的重要点（轮次、检查点）。

### pi.registerCommand(name, options)

注册命令。

如果多个扩展注册了相同的命令名称，pi 会保留所有扩展，并按加载顺序分配数字调用后缀，例如 `/review:1` 和 `/review:2`。

```typescript
pi.registerCommand("stats", {
  description: "显示会话统计信息",
  handler: async (args, ctx) => {
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} 条记录`, "info");
  }
});
```

可选：为 `/command ...` 添加参数自动补全：

```typescript
import type { AutocompleteItem } from "@earendil-works/pi-tui";

pi.registerCommand("deploy", {
  description: "部署到某个环境",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"];
    const items = envs.map((e) => ({ value: e, label: e }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`部署中：${args}`, "info");
  },
});
```

### pi.getCommands()

获取当前会话中可通过 `prompt` 调用的斜杠命令。包括扩展命令、提示模板和 skill 命令。列表与 RPC `get_commands` 的排序一致：扩展优先，然后是模板，最后是 skill。

```typescript
const commands = pi.getCommands();
const bySource = commands.filter((command) => command.source === "extension");
const userScoped = commands.filter((command) => command.sourceInfo.scope === "user");
```

每条记录的形状如下：

```typescript
{
  name: string; // 可调用的命令名称，不带前导斜杠。可能带有后缀，例如 "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}
```

使用 `sourceInfo` 作为规范的来源字段。不要从命令名称或临时的路径解析推断所有权。

内置的交互式命令（如 `/model` 和 `/settings`）不包含在此列表中。它们仅在交互模式下处理，如果通过 `prompt` 发送则不会执行。

### pi.registerMessageRenderer(customType, renderer)

为具有你的 `customType` 的消息注册自定义 TUI 渲染器。请参阅[自定义 UI](#自定义-ui)。

### pi.registerShortcut(shortcut, options)

注册键盘快捷键。有关快捷键格式和内置快捷键绑定，请参阅 [keybindings.md](zh/keybindings.md)。

```typescript
pi.registerShortcut("ctrl+shift+p", {
  description: "切换计划模式",
  handler: async (ctx) => {
    ctx.ui.notify("已切换！");
  },
});
```

### pi.registerFlag(name, options)

注册 CLI 标志。

```typescript
pi.registerFlag("plan", {
  description: "以计划模式启动",
  type: "boolean",
  default: false,
});

// 检查值
if (pi.getFlag("plan")) {
  // 计划模式已启用
}
```

### pi.exec(command, args, options?)

执行 shell 命令。

```typescript
const result = await pi.exec("git", ["status"], { signal, timeout: 5000 });
// result.stdout, result.stderr, result.code, result.killed
```

### pi.getActiveTools() / pi.getAllTools() / pi.setActiveTools(names)

管理活动工具。这对内置工具和动态注册的工具都适用。

```typescript
const active = pi.getActiveTools();
const all = pi.getAllTools();
// [{
//   name: "read",
//   description: "读取文件内容...",
//   parameters: ..., 
//   sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" }
// }, ...]
const names = all.map(t => t.name);
const builtinTools = all.filter((t) => t.sourceInfo.source === "builtin");
const extensionTools = all.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk");
pi.setActiveTools(["read", "bash"]); // 切换到只读
```

`pi.getAllTools()` 返回 `name`、`description`、`parameters` 和 `sourceInfo`。

典型的 `sourceInfo.source` 值：
- `builtin` 用于内置工具
- `sdk` 用于通过 `createAgentSession({ customTools })` 传递的工具
- 扩展注册的工具使用扩展源元数据

### pi.setModel(model)

设置当前模型。如果没有适用于该模型的 API 密钥，则返回 `false`。有关配置自定义模型，请参阅 [models.md](zh/models.md)。

```typescript
const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify("此模型没有可用的 API 密钥", "error");
  }
}
```

### pi.getThinkingLevel() / pi.setThinkingLevel(level)

获取或设置思维层级。层级会被限制在模型能力范围内（非推理模型始终使用 "off"）。更改会发出 `thinking_level_select`。

```typescript
const current = pi.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
pi.setThinkingLevel("high");
```

### pi.events

用于扩展之间通信的共享事件总线：

```typescript
pi.events.on("my:event", (data) => { ... });
pi.events.emit("my:event", { ... });
```

### pi.registerProvider(name, config)

动态注册或覆盖模型提供者。适用于代理、自定义端点或团队范围的模型配置。

在扩展工厂函数期间进行的调用会被排队，并在运行器初始化后应用。之后进行的调用——例如来自用户设置流程后的命令处理器——会立即生效，无需 `/reload`。

如果你需要从远程端点发现模型，建议使用异步扩展工厂而不是将 fetch 延迟到 `session_start`。Pi 会在启动继续之前等待工厂，因此注册的模型立即可用，包括对 `pi --list-models`。

```typescript
// 使用自定义模型注册新提供者
pi.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "PROXY_API_KEY",  // 环境变量名或字面量
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// 覆盖现有提供者的 baseUrl（保留所有模型）
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});
```

**配置选项：**
- `name` - 在 UI（如 `/login`）中显示的提供者名称。
- `baseUrl` - API 端点 URL。在定义模型时必需。
- `apiKey` - API 密钥或环境变量名称。在定义模型时必需。
- `api` - API 类型：`"anthropic-messages"`、`"openai-completions"`、`"openai-responses"` 等。
- `headers` - 包含在请求中的自定义头部。
- `authHeader` - 如果为 true，自动添加 `Authorization: Bearer` 头部。
- `models` - 模型定义数组。如果提供，将替换该提供者的所有现有模型。模型定义可以设置 `baseUrl` 以覆盖该模型的提供者端点。
- `streamSimple` - 用于非标准 API 的自定义流式实现。

请参阅 [custom-provider.md](zh/custom-provider.md) 了解高级主题：自定义流式 API、模型定义参考。

### pi.unregisterProvider(name)

移除先前注册的提供者及其模型。被该提供者覆盖的内置模型会被恢复。如果该提供者未被注册，则无效果。

与 `registerProvider` 一样，在初始加载阶段之后调用时会立即生效，因此不需要 `/reload`。

```typescript
pi.registerCommand("my-setup-teardown", {
  description: "移除自定义代理提供者",
  handler: async (_args, _ctx) => {
    pi.unregisterProvider("my-proxy");
  },
});
```

## 状态管理

有状态的扩展应将其状态存储在工具结果 `details` 中，以实现正确的分支支持：

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // 从会话重建状态
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("新项目");
      return {
        content: [{ type: "text", text: "已添加" }],
        details: { items: [...items] },  // 存储以便重建
      };
    },
  });
}
```

## 自定义工具

通过 `pi.registerTool()` 注册 LLM 可调用的工具。工具会出现在系统提示中，并且可以拥有自定义渲染。

使用 `promptSnippet` 在默认系统提示的 `Available tools` 部分中创建简短的单行条目。如果省略，自定义工具将被排除在该部分之外。

使用 `promptGuidelines` 向默认系统提示的 `Guidelines` 部分添加工具特定的条目。这些条目仅在工具处于活动状态时包含（例如，在 `pi.setActiveTools([...])` 之后）。

**重要：** `promptGuidelines` 条目被平坦地追加到 `Guidelines` 部分，没有工具名称前缀或分组。每条指南必须指明其引用的工具——避免使用"使用此工具当..."，因为 LLM 无法判断"此"指的是哪个工具。请使用"当...时，使用 my_tool"。

注意：某些模型比较笨，会在工具路径参数中包含 @ 前缀。内置工具在解析路径之前会去除前导 @。如果你的自定义工具接受路径，也要规范化前导 @。

如果你的自定义工具修改了文件，请使用 `withFileMutationQueue()`，使其与内置的 `edit` 和 `write` 参与相同的按文件队列。这很重要，因为工具调用默认并行运行。没有队列，两个工具可能会读取相同的旧文件内容，计算不同的更新，然后后写入的那一个会覆盖另一个。

示例失败情况：你的自定义工具编辑 `foo.ts`，同时内置的 `edit` 在同一助手轮次中也更改了 `foo.ts`。如果你的工具未参与队列，两者都可能读取原始的 `foo.ts`，应用单独的更改，然后其中一个更改会丢失。

将真实的目标文件路径传递给 `withFileMutationQueue()`，而不是原始用户参数。首先将其解析为绝对路径，相对于 `ctx.cwd` 或你的工具的工作目录。对于现有文件，辅助方法通过 `realpath()` 进行规范化，因此同一文件的符号链接别名共享一个队列。对于新文件，它会回退到解析后的绝对路径，因为还没有可以 `realpath()` 的内容。

将整个变更窗口排队到该目标路径上。这包括读取-修改-写入的逻辑，而不仅仅是最终的写入。

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");

    return {
      content: [{ type: "text", text: `已更新 ${params.path}` }],
      details: {},
    };
  });
}
```

### 工具定义

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "此工具的功能（向 LLM 展示）",
  promptSnippet: "列出或添加项目待办列表中的项",
  promptGuidelines: [
    "当用户请求任务列表时，使用 my_tool 进行待办规划，而不是直接编辑文件。"
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // 使用 StringEnum 确保 Google 兼容性
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { action?: string; oldAction?: string };
    if (typeof input.oldAction === "string" && input.action === undefined) {
      return { ...input, action: input.oldAction };
    }
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 检查是否取消
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "已取消" }] };
    }

    // 流式进度更新
    onUpdate?.({
      content: [{ type: "text", text: "工作中..." }],
      details: { progress: 50 },
    });

    // 通过 pi.exec 运行命令（从扩展闭包捕获）
    const result = await pi.exec("some-command", [], { signal });

    // 返回结果
    return {
      content: [{ type: "text", text: "完成" }],  // 发送给 LLM
      details: { data: result },                   // 用于渲染和状态
      // 可选：当批次中每个已完成的工具结果都返回 terminate: true 时停止
      terminate: true,
    };
  },

  // 可选：自定义渲染
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

**发出错误信号：** 要将工具执行标记为失败（在结果上设置 `isError: true` 并报告给 LLM），从 `execute` 中抛出错误。返回一个值永远不会设置错误标志，无论返回对象中包含什么属性。

**提前终止：** 从 `execute()` 返回 `terminate: true` 以提示当前工具批次后应跳过自动后续 LLM 调用。仅当该批次中每个已完成的工具结果都是终止性的时，此设置才生效。参见 [examples/extensions/structured-output.ts](../examples/extensions/structured-output.ts) 获取最小示例，其中代理以最终的结构化输出工具调用结束。

```typescript
// 正确：抛出错误以发出错误信号
async execute(toolCallId, params) {
  if (!isValid(params.input)) {
    throw new Error(`无效输入：${params.input}`);
  }
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

**重要：** 对于字符串枚举，使用 `@earendil-works/pi-ai` 中的 `StringEnum`。`Type.Union`/`Type.Literal` 与 Google 的 API 不兼容。

**参数准备：** `prepareArguments(args)` 是可选的。如果定义，它在模式验证和 `execute()` 之前运行。用于在 pi 恢复旧会话时模拟旧的已接受的输入形状，这些旧会话中存储的工具调用参数不再匹配当前模式。返回希望根据 `parameters` 进行验证的对象。保持公开的模式严格。不要仅仅为了让旧的恢复会话继续工作而向 `parameters` 添加已弃用的兼容性字段。

示例：旧会话可能包含带有顶层 `oldText` 和 `newText` 的 `edit` 工具调用，而当前模式只接受 `edits: [{ oldText, newText }]`。

```typescript
pi.registerTool({
  name: "edit",
  label: "Edit",
  description: "使用精确文本替换编辑单个文件",
  parameters: Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }),
    ),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;

    const input = args as {
      path?: string;
      edits?: Array<{ oldText: string; newText: string }>;
      oldText?: unknown;
      newText?: unknown;
    };

    if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
      return args;
    }

    return {
      ...input,
      edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
    };
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // params 现在匹配当前模式
    return {
      content: [{ type: "text", text: `正在应用 ${params.edits.length} 个编辑块` }],
      details: {},
    };
  },
});
```

### 覆盖内置工具

扩展可以通过注册同名的工具来覆盖内置工具（`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`）。交互模式会在发生这种情况时显示警告。

```bash
# 扩展的 read 工具替换内置的 read
pi -e ./tool-override.ts
```

或者，使用 `--no-builtin-tools` 在不使用任何内置工具的情况下启动，同时保持扩展工具启用：
```bash
# 没有内置工具，只有扩展工具
pi --no-builtin-tools -e ./my-extension.ts
```

请参阅 [examples/extensions/tool-override.ts](../examples/extensions/tool-override.ts) 获取覆盖 `read` 并添加日志和访问控制的完整示例。

**渲染：** 内置渲染器的继承按槽位解析。执行覆盖和渲染覆盖是独立的。如果你的覆盖省略了 `renderCall`，则使用内置的 `renderCall`。如果你的覆盖省略了 `renderResult`，则使用内置的 `renderResult`。如果你的覆盖两者都省略，则自动使用内置渲染器（语法高亮、差异显示等）。这让你可以在不重新实现 UI 的情况下包装内置工具以进行日志记录或访问控制。

**提示元数据：** `promptSnippet` 和 `promptGuidelines` 不会从内置工具继承。如果你的覆盖应保留这些提示指令，请显式地在覆盖上定义它们。

**你的实现必须匹配精确的结果形状**，包括 `details` 类型。UI 和会话逻辑依赖这些形状进行渲染和状态跟踪。

内置工具实现：
- [read.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/read.ts) - `ReadToolDetails`
- [bash.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/bash.ts) - `BashToolDetails`
- [edit.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts)
- [write.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/write.ts)
- [grep.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/grep.ts) - `GrepToolDetails`
- [find.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/find.ts) - `FindToolDetails`
- [ls.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/ls.ts) - `LsToolDetails`

### 远程执行

内置工具支持可插拔操作以委托给远程系统（SSH、容器等）：

```typescript
import { createReadTool, createBashTool, type ReadOperations } from "@earendil-works/pi-coding-agent";

// 使用自定义操作创建工具
const remoteRead = createReadTool(cwd, {
  operations: {
    readFile: (path) => sshExec(remote, `cat ${path}`),
    access: (path) => sshExec(remote, `test -r ${path}`).then(() => {}),
  }
});

// 注册，在执行时检查标志
pi.registerTool({
  ...remoteRead,
  async execute(id, params, signal, onUpdate, _ctx) {
    const ssh = getSshConfig();
    if (ssh) {
      const tool = createReadTool(cwd, { operations: createRemoteOps(ssh) });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

**操作接口：** `ReadOperations`、`WriteOperations`、`EditOperations`、`BashOperations`、`LsOperations`、`GrepOperations`、`FindOperations`

对于 `user_bash`，扩展可以通过 `createLocalBashOperations()` 重用 pi 的本地 shell 后端，而无需重新实现本地进程生成、shell 解析和进程树终止。

bash 工具还支持一个 spawn 钩子，用于在执行前调整命令、cwd 或环境：

```typescript
import { createBashTool } from "@earendil-works/pi-coding-agent";

const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

请参阅 [examples/extensions/ssh.ts](../examples/extensions/ssh.ts) 获取带有 `--ssh` 标志的完整 SSH 示例。

### 输出截断

**工具必须截断其输出**，以避免淹没 LLM 上下文。大型输出可能导致：
- 上下文溢出错误（提示过长）
- 压缩失败
- 模型性能下降

内置限制为 **50KB**（约 10k token）和 **2000 行**，以先达到者为准。使用导出的截断工具函数：

```typescript
import {
  truncateHead,      // 保留前 N 行/字节（适用于文件读取、搜索结果）
  truncateTail,      // 保留后 N 行/字节（适用于日志、命令输出）
  truncateLine,      // 将单行截断至 maxBytes 并添加省略号
  formatSize,        // 人类可读的大小（例如 "50KB"、"1.5MB"）
  DEFAULT_MAX_BYTES, // 50KB
  DEFAULT_MAX_LINES, // 2000
} from "@earendil-works/pi-coding-agent";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await runCommand();

  // 应用截断
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    // 将完整输出写入临时文件
    const tempFile = writeTempFile(output);

    // 告知 LLM 在哪里找到完整输出
    result += `\n\n[输出已截断：${truncation.outputLines}/${truncation.totalLines} 行`;
    result += ` (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)})。`;
    result += ` 完整输出已保存至：${tempFile}]`;
  }

  return { content: [{ type: "text", text: result }] };
}
```

**关键点：**
- 对于开头重要的内容（搜索结果、文件读取），使用 `truncateHead`
- 对于结尾重要的内容（日志、命令输出），使用 `truncateTail`
- 当输出被截断时，始终告知 LLM 并在哪里找到完整版本
- 在工具描述中记录截断限制

请参阅 [examples/extensions/truncated-tool.ts](../examples/extensions/truncated-tool.ts) 获取包装 `rg`（ripgrep）并带有正确截断的完整示例。

### 多个工具

一个扩展可以注册多个共享状态的工具：

```typescript
export default function (pi: ExtensionAPI) {
  let connection = null;

  pi.registerTool({ name: "db_connect", ... });
  pi.registerTool({ name: "db_query", ... });
  pi.registerTool({ name: "db_close", ... });

  pi.on("session_shutdown", async () => {
    connection?.close();
  });
}
```

### 自定义渲染

工具可以提供 `renderCall` 和 `renderResult` 用于自定义 TUI 显示。有关完整组件 API，请参阅 [tui.md](zh/tui.md)；有关工具行如何组合，请参阅 [tool-execution.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts)。

默认情况下，工具输出被包裹在一个处理内边距和背景的 `Box` 中。定义的 `renderCall` 或 `renderResult` 必须返回一个 `Component`。如果某个槽位的渲染器未定义，`tool-execution.ts` 会使用该槽位的后备渲染。

当工具应渲染自己的外壳而不是使用默认的 `Box` 时，设置 `renderShell: "self"`。这对于需要完全控制边框或背景行为的工具很有用，例如必须在工具稳定后保持视觉稳定的大型预览。

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "自定义外壳示例",
  parameters: Type.Object({}),
  renderShell: "self",
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
  renderCall(args, theme, context) {
    return new Text(theme.fg("accent", "my custom shell"), 0, 0);
  },
});
```

`renderCall` 和 `renderResult` 各自接收一个 `context` 对象，包含：
- `args` - 当前工具调用参数
- `state` - 跨 `renderCall` 和 `renderResult` 共享的行本地状态
- `lastComponent` - 如果有的话，该槽位先前返回的组件
- `invalidate()` - 请求重新渲染此工具行
- `toolCallId`、`cwd`、`executionStarted`、`argsComplete`、`isPartial`、`expanded`、`showImages`、`isError`

使用 `context.state` 进行跨槽位共享状态。当你希望跨渲染重用和修改同一组件实例时，将槽位本地缓存保留在返回的组件实例上。

#### renderCall

渲染工具调用或头部：

```typescript
import { Text } from "@earendil-works/pi-tui";

renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  let content = theme.fg("toolTitle", theme.bold("my_tool "));
  content += theme.fg("muted", args.action);
  if (args.text) {
    content += " " + theme.fg("dim", `"${args.text}"`);
  }
  text.setText(content);
  return text;
}
```

#### renderResult

渲染工具结果或输出：

```typescript
renderResult(result, { expanded, isPartial }, theme, context) {
  if (isPartial) {
    return new Text(theme.fg("warning", "处理中..."), 0, 0);
  }

  if (result.details?.error) {
    return new Text(theme.fg("error", `错误：${result.details.error}`), 0, 0);
  }

  let text = theme.fg("success", "✓ 完成");
  if (expanded && result.details?.items) {
    for (const item of result.details.items) {
      text += "\n  " + theme.fg("dim", item);
    }
  }
  return new Text(text, 0, 0);
}
```

如果某个槽位有意没有可见内容，返回一个空的 `Component`，例如空的 `Container`。

#### 快捷键提示

使用 `keyHint()` 显示尊重活动快捷键配置的快捷键提示：

```typescript
import { keyHint } from "@earendil-works/pi-coding-agent";

renderResult(result, { expanded }, theme, context) {
  let text = theme.fg("success", "✓ 完成");
  if (!expanded) {
    text += ` (${keyHint("app.tools.expand", "展开")})`;
  }
  return new Text(text, 0, 0);
}
```

可用函数：
- `keyHint(keybinding, description)` - 格式化已配置的快捷键 ID，例如 `"app.tools.expand"` 或 `"tui.select.confirm"`
- `keyText(keybinding)` - 返回快捷键 ID 的原始已配置按键文本
- `rawKeyHint(key, description)` - 格式化原始按键字符串

使用带命名空间的快捷键 ID：
- 编码代理 ID 使用 `app.*` 命名空间，例如 `app.tools.expand`、`app.editor.external`、`app.session.rename`
- 共享 TUI ID 使用 `tui.*` 命名空间，例如 `tui.select.confirm`、`tui.select.cancel`、`tui.input.tab`

有关快捷键 ID 和默认值的完整列表，请参阅 [keybindings.md](zh/keybindings.md)。`keybindings.json` 使用相同的命名空间 ID。

自定义编辑器和 `ctx.ui.custom()` 组件接收 `keybindings: KeybindingsManager` 作为注入参数。它们应直接使用该注入的管理器，而不是调用 `getKeybindings()` 或 `setKeybindings()`。

#### 最佳实践

- 使用带内边距 `(0, 0)` 的 `Text`。默认的 Box 负责处理内边距。
- 对多行内容使用 `\n`。
- 处理 `isPartial` 以支持流式进度。
- 支持 `expanded` 以按需显示详情。
- 保持默认视图紧凑。
- 在 `renderResult` 中读取 `context.args`，而不是将参数复制到 `context.state` 中。
- 仅在需要跨调用和结果槽位共享数据时使用 `context.state`。
- 当同一组件实例可以在原地更新时，重用 `context.lastComponent`。
- 仅当默认的盒式外壳碍事时使用 `renderShell: "self"`。在自外壳模式下，工具负责自己的边框、内边距和背景。

#### 后备

如果某个槽位的渲染器未定义或抛出异常：
- `renderCall`：显示工具名称
- `renderResult`：显示来自 `content` 的原始文本

## 自定义 UI

扩展可以通过 `ctx.ui` 方法与用户交互，并自定义消息/工具的渲染方式。

**有关自定义组件，请参阅 [tui.md](zh/tui.md)**，其中包含可直接复制使用的模式：
- 选择对话框（SelectList）
- 带取消的异步操作（BorderedLoader）
- 设置开关（SettingsList）
- 状态指示器（setStatus）
- 流式输出期间的工作消息、可见性和指示器（`setWorkingMessage`、`setWorkingVisible`、`setWorkingIndicator`）
- 编辑器上方/下方的小部件（setWidget）
- 在内置斜杠/路径补全之上叠加的自动补全提供者（addAutocompleteProvider）
- 自定义页脚（setFooter）

### 对话框

```typescript
// 从选项中选择
const choice = await ctx.ui.select("选择一个：", ["A", "B", "C"]);

// 确认对话框
const ok = await ctx.ui.confirm("删除？", "此操作无法撤销");

// 文本输入
const name = await ctx.ui.input("名称：", "占位文本");

// 多行编辑器
const text = await ctx.ui.editor("编辑：", "预填文本");

// 通知（非阻塞）
ctx.ui.notify("完成！", "info");  // "info" | "warning" | "error"
```

#### 带倒计时的定时对话框

对话框支持 `timeout` 选项，可自动关闭并显示实时倒计时：

```typescript
// 对话框显示 "标题 (5s)" → "标题 (4s)" → ... → 在 0 时自动关闭
const confirmed = await ctx.ui.confirm(
  "定时确认",
  "此对话框将在 5 秒后自动取消。确认吗？",
  { timeout: 5000 }
);

if (confirmed) {
  // 用户已确认
} else {
  // 用户取消或超时
}
```

**超时时的返回值：**
- `select()` 返回 `undefined`
- `confirm()` 返回 `false`
- `input()` 返回 `undefined`

#### 使用 AbortSignal 手动关闭

为了更精细的控制（例如区分超时和用户取消），使用 `AbortSignal`：

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

const confirmed = await ctx.ui.confirm(
  "定时确认",
  "此对话框将在 5 秒后自动取消。确认吗？",
  { signal: controller.signal }
);

clearTimeout(timeoutId);

if (confirmed) {
  // 用户已确认
} else if (controller.signal.aborted) {
  // 对话框超时
} else {
  // 用户取消（按 Escape 或选择 "否"）
}
```

请参阅 [examples/extensions/timed-confirm.ts](../examples/extensions/timed-confirm.ts) 获取完整示例。

### 小部件、状态和页脚

```typescript
// 底部状态（持久化，直到清除）
ctx.ui.setStatus("my-ext", "处理中...");
ctx.ui.setStatus("my-ext", undefined);  // 清除

// 工作加载器（流式输出期间显示）
ctx.ui.setWorkingMessage("正在深入思考...");
ctx.ui.setWorkingMessage();  // 恢复默认
ctx.ui.setWorkingVisible(false);  // 完全隐藏内置工作加载行
ctx.ui.setWorkingVisible(true);   // 显示内置工作加载行

// 工作指示器（流式输出期间显示）
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });  // 静态圆点
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});
ctx.ui.setWorkingIndicator({ frames: [] });  // 隐藏指示器
ctx.ui.setWorkingIndicator();  // 恢复默认旋转指示器

// 编辑器上方的小部件（默认）
ctx.ui.setWidget("my-widget", ["第1行", "第2行"]);
// 编辑器下方的小部件
ctx.ui.setWidget("my-widget", ["第1行", "第2行"], { placement: "belowEditor" });
ctx.ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "自定义"), 0, 0));
ctx.ui.setWidget("my-widget", undefined);  // 清除

// 自定义页脚（完全替换内置页脚）
ctx.ui.setFooter((tui, theme) => ({
  render(width) { return [theme.fg("dim", "自定义页脚")]; },
  invalidate() {},
}));
ctx.ui.setFooter(undefined);  // 恢复内置页脚

// 终端标题
ctx.ui.setTitle("pi - my-project");

// 编辑器文本
ctx.ui.setEditorText("预填文本");
const current = ctx.ui.getEditorText();

// 粘贴到编辑器（触发粘贴处理，包括大内容折叠）
ctx.ui.pasteToEditor("粘贴的内容");

// 在内置提供者之上叠加自定义自动补全行为
ctx.ui.addAutocompleteProvider((current) => ({
  async getSuggestions(lines, line, col, options) {
    const beforeCursor = (lines[line] ?? "").slice(0, col);
    const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
    if (!match) {
      return current.getSuggestions(lines, line, col, options);
    }

    return {
      prefix: `#${match[1] ?? ""}`,
      items: [{ value: "#2983", label: "#2983", description: "用于自动补全的扩展 API" }],
    };
  },
  applyCompletion(lines, line, col, item, prefix) {
    return current.applyCompletion(lines, line, col, item, prefix);
  },
  shouldTriggerFileCompletion(lines, line, col) {
    return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
  },
}));

// 工具输出展开状态
const wasExpanded = ctx.ui.getToolsExpanded();
ctx.ui.setToolsExpanded(true);
ctx.ui.setToolsExpanded(wasExpanded);

// 自定义编辑器（vim 模式、emacs 模式等）
ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
const currentEditor = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new WrappedEditor(tui, theme, keybindings, currentEditor?.(tui, theme, keybindings))
);
ctx.ui.setEditorComponent(undefined);  // 恢复默认编辑器

// 主题管理（有关创建主题，请参阅 themes.md）
const themes = ctx.ui.getAllThemes();  // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = ctx.ui.getTheme("light");  // 加载而不切换
const result = ctx.ui.setTheme("light");  // 按名称切换
if (!result.success) {
  ctx.ui.notify(`失败：${result.error}`, "error");
}
ctx.ui.setTheme(lightTheme!);  // 或者按 Theme 对象切换
ctx.ui.theme.fg("accent", "样式化文本");  // 访问当前主题
```

自定义工作指示器帧按原样渲染。如果需要颜色，请自行添加到帧字符串中，例如使用 `ctx.ui.theme.fg(...)`。

### 自动补全提供者

使用 `ctx.ui.addAutocompleteProvider()` 在内置斜杠命令和路径提供者之上叠加自定义自动补全逻辑。

典型模式：

- 检查光标前的文本
- 当你的扩展特定语法匹配时返回你自己的建议
- 否则委托给 `current.getSuggestions(...)`
- 除非需要自定义插入行为，否则委托 `applyCompletion(...)`

```typescript
pi.on("session_start", (_event, ctx) => {
  ctx.ui.addAutocompleteProvider((current) => ({
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        prefix: `#${match[1] ?? ""}`,
        items: [
          { value: "#2983", label: "#2983", description: "用于注册自定义 @ 自动补全提供者的扩展 API" },
          { value: "#2753", label: "#2753", description: "重新加载过期的资源设置" },
        ],
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  }));
});
```

请参阅 [github-issue-autocomplete.ts](../examples/extensions/github-issue-autocomplete.ts) 获取完整示例，该示例使用 `gh issue list` 预加载最新的开源 GitHub 问题并在本地过滤以实现快速的 `#...` 补全。它需要 GitHub CLI（`gh`）和 GitHub 仓库检出。

### 自定义组件

对于复杂的 UI，使用 `ctx.ui.custom()`。这会临时用你的组件替换编辑器，直到调用 `done()`：

```typescript
import { Text, Component } from "@earendil-works/pi-tui";

const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  const text = new Text("按 Enter 确认，按 Escape 取消", 1, 1);

  text.onKey = (key) => {
    if (key === "return") done(true);
    if (key === "escape") done(false);
    return true;
  };

  return text;
});

if (result) {
  // 用户按了 Enter
}
```

回调接收：
- `tui` - TUI 实例（用于屏幕尺寸、焦点管理）
- `theme` - 用于样式的当前主题
- `keybindings` - 应用程序快捷键管理器（用于检查快捷键）
- `done(value)` - 调用以关闭组件并返回值

请参阅 [tui.md](zh/tui.md) 获取完整的组件 API。

#### 叠加模式（实验性）

传递 `{ overlay: true }` 将组件渲染为浮动模态框，显示在现有内容之上，不清除屏幕：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  { overlay: true }
);
```

对于高级定位（锚点、边距、百分比、响应式可见性），传递 `overlayOptions`。使用 `onHandle` 以编程方式控制可见性：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  {
    overlay: true,
    overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
    onHandle: (handle) => { /* handle.setHidden(true/false) */ }
  }
);
```

请参阅 [tui.md](zh/tui.md) 获取完整的 `OverlayOptions` API，以及 [overlay-qa-tests.ts](../examples/extensions/overlay-qa-tests.ts) 获取示例。

### 自定义编辑器

将主输入编辑器替换为自定义实现（vim 模式、emacs 模式等）：

```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape") && this.mode === "insert") {
      this.mode = "normal";
      return;
    }
    if (this.mode === "normal" && data === "i") {
      this.mode = "insert";
      return;
    }
    super.handleInput(data);  // 应用程序快捷键 + 文本编辑
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((_tui, theme, keybindings) =>
      new VimEditor(theme, keybindings)
    );
  });
}
```

**关键点：**
- 继承 `CustomEditor`（而非基础 `Editor`）以获得应用程序快捷键（escape 中止、ctrl+d、模型切换）
- 对于你不处理的按键，调用 `super.handleInput(data)`
- 工厂函数接收来自应用程序的 `theme` 和 `keybindings`
- 在 `setEditorComponent()` 之前使用 `ctx.ui.getEditorComponent()` 来包装先前配置的自定义编辑器
- 传递 `undefined` 以恢复默认：`ctx.ui.setEditorComponent(undefined)`

要与另一个已替换编辑器的扩展组合，在设置你的之前捕获先前的工厂：

```typescript
const previous = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(tui, theme, keybindings, { base: previous?.(tui, theme, keybindings) })
);
```

请参阅 [tui.md](zh/tui.md) 中的模式 7 获取带有模式指示器的完整示例。

### 消息渲染

为具有你的 `customType` 的消息注册自定义渲染器：

```typescript
import { Text } from "@earendil-works/pi-tui";

pi.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }

  return new Text(text, 0, 0);
});
```

消息通过 `pi.sendMessage()` 发送：

```typescript
pi.sendMessage({
  customType: "my-extension",  // 与 registerMessageRenderer 匹配
  content: "状态更新",
  display: true,               // 在 TUI 中显示
  details: { ... },            // 在渲染器中可用
});
```

### 主题颜色

所有渲染函数都接收一个 `theme` 对象。有关创建自定义主题和完整调色板，请参阅 [themes.md](zh/themes.md)。

```typescript
// 前景色
theme.fg("toolTitle", text)   // 工具名称
theme.fg("accent", text)      // 高亮
theme.fg("success", text)     // 成功（绿色）
theme.fg("error", text)       // 错误（红色）
theme.fg("warning", text)     // 警告（黄色）
theme.fg("muted", text)       // 次要文本
theme.fg("dim", text)         // 第三级文本

// 文本样式
theme.bold(text)
theme.italic(text)
theme.strikethrough(text)
```

在自定义工具渲染器中进行语法高亮：

```typescript
import { highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";

// 使用显式语言高亮代码
const highlighted = highlightCode("const x = 1;", "typescript", theme);

// 从文件路径自动检测语言
const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlighted = highlightCode(code, lang, theme);
```

## 错误处理

- 扩展错误会被记录，代理继续运行
- `tool_call` 错误会阻止工具（故障安全）
- 工具 `execute` 错误必须通过抛出异常来发出信号；抛出的错误会被捕获，以 `isError: true` 报告给 LLM，执行继续

## 模式行为

| 模式 | UI 方法 | 说明 |
|------|-----------|-------|
| 交互模式 | 完整 TUI | 正常操作 |
| RPC（`--mode rpc`） | JSON 协议 | 主机处理 UI，参见 [rpc.md](zh/rpc.md) |
| JSON（`--mode json`） | 空操作 | 事件流输出到 stdout，参见 [json.md](zh/json.md) |
| 打印（`-p`） | 空操作 | 扩展运行但不能提示 |

在非交互模式下，使用 UI 方法前请检查 `ctx.hasUI`。

## 示例参考

所有示例位于 [examples/extensions/](../examples/extensions/)。

| 示例 | 描述 | 关键 API |
|---------|-------------|----------|
| **工具** |||
| `hello.ts` | 最小工具注册 | `registerTool` |
| `question.ts` | 带用户交互的工具 | `registerTool`、`ui.select` |
| `questionnaire.ts` | 多步向导工具 | `registerTool`、`ui.custom` |
| `todo.ts` | 带持久化的有状态工具 | `registerTool`、`appendEntry`、`renderResult`、会话事件 |
| `dynamic-tools.ts` | 启动后和命令期间注册工具 | `registerTool`、`session_start`、`registerCommand` |
| `structured-output.ts` | 带有 `terminate: true` 的最终结构化输出工具 | `registerTool`、终止性工具结果 |
| `truncated-tool.ts` | 输出截断示例 | `registerTool`、`truncateHead` |
| `tool-override.ts` | 覆盖内置的 read 工具 | `registerTool`（与内置同名） |
| **命令** |||
| `pirate.ts` | 每轮修改系统提示 | `registerCommand`、`before_agent_start` |
| `summarize.ts` | 对话摘要命令 | `registerCommand`、`ui.custom` |
| `handoff.ts` | 跨提供者模型交接 | `registerCommand`、`ui.editor`、`ui.custom` |
| `qna.ts` | 带自定义 UI 的问答 | `registerCommand`、`ui.custom`、`setEditorText` |
| `send-user-message.ts` | 注入用户消息 | `registerCommand`、`sendUserMessage` |
| `reload-runtime.ts` | 重新加载命令和 LLM 工具交接 | `registerCommand`、`ctx.reload()`、`sendUserMessage` |
| `shutdown-command.ts` | 优雅关闭命令 | `registerCommand`、`shutdown()` |
| **事件与门控** |||
| `permission-gate.ts` | 阻止危险命令 | `on("tool_call")`、`ui.confirm` |
| `protected-paths.ts` | 阻止写入特定路径 | `on("tool_call")` |
| `confirm-destructive.ts` | 确认会话更改 | `on("session_before_switch")`、`on("session_before_fork")` |
| `dirty-repo-guard.ts` | 在 git 仓库脏时警告 | `on("session_before_*")`、`exec` |
| `input-transform.ts` | 转换用户输入 | `on("input")` |
| `model-status.ts` | 响应模型更改 | `on("model_select")`、`setStatus` |
| `provider-payload.ts` | 检查负载和提供者响应头 | `on("before_provider_request")`、`on("after_provider_response")` |
| `system-prompt-header.ts` | 显示系统提示信息 | `on("agent_start")`、`getSystemPrompt` |
| `claude-rules.ts` | 从文件加载规则 | `on("session_start")`、`on("before_agent_start")` |
| `prompt-customizer.ts` | 使用 `systemPromptOptions` 添加上下文感知的工具指导 | `on("before_agent_start")`、`BuildSystemPromptOptions` |
| `file-trigger.ts` | 文件监听器触发消息 | `sendMessage` |
| **压缩与会话** |||
| `custom-compaction.ts` | 自定义压缩摘要 | `on("session_before_compact")` |
| `trigger-compact.ts` | 手动触发压缩 | `compact()` |
| `git-checkpoint.ts` | 在轮次时 git stash | `on("turn_start")`、`on("session_before_fork")`、`exec` |
| `auto-commit-on-exit.ts` | 关闭时自动提交 | `on("session_shutdown")`、`exec` |
| **UI 组件** |||
| `status-line.ts` | 页脚状态指示器 | `setStatus`、会话事件 |
| `working-indicator.ts` | 自定义流式工作指示器 | `setWorkingIndicator`、`registerCommand` |
| `github-issue-autocomplete.ts` | 通过预加载 `gh issue list` 的最新开放问题，在内置自动补全之上添加 `#1234` 问题补全 | `addAutocompleteProvider`、`on("session_start")`、`exec` |
| `custom-footer.ts` | 完全替换页脚 | `registerCommand`、`setFooter` |
| `custom-header.ts` | 替换启动头部 | `on("session_start")`、`setHeader` |
| `modal-editor.ts` | Vim 风格模态编辑器 | `setEditorComponent`、`CustomEditor` |
| `rainbow-editor.ts` | 自定义编辑器样式 | `setEditorComponent` |
| `widget-placement.ts` | 编辑器上方/下方的小部件 | `setWidget` |
| `overlay-test.ts` | 叠加组件 | 带叠加选项的 `ui.custom` |
| `overlay-qa-tests.ts` | 全面的叠加测试 | `ui.custom`、所有叠加选项 |
| `notify.ts` | 简单通知 | `ui.notify` |
| `timed-confirm.ts` | 带超时的对话框 | 带 timeout/signal 的 `ui.confirm` |
| `mac-system-theme.ts` | 自动切换主题 | `setTheme`、`exec` |
| **复杂扩展** |||
| `plan-mode/` | 完整计划模式实现 | 所有事件类型、`registerCommand`、`registerShortcut`、`registerFlag`、`setStatus`、`setWidget`、`sendMessage`、`setActiveTools` |
| `preset.ts` | 可保存的预设（模型、工具、思维） | `registerCommand`、`registerShortcut`、`registerFlag`、`setModel`、`setActiveTools`、`setThinkingLevel`、`appendEntry` |
| `tools.ts` | 开关工具 UI | `registerCommand`、`setActiveTools`、`SettingsList`、会话事件 |
| **远程与沙箱** |||
| `ssh.ts` | SSH 远程执行 | `registerFlag`、`on("user_bash")`、`on("before_agent_start")`、工具操作 |
| `interactive-shell.ts` | 持久化 shell 会话 | `on("user_bash")` |
| `sandbox/` | 沙箱化工具执行 | 工具操作 |
| `subagent/` | 生成子代理 | `registerTool`、`exec` |
| **游戏** |||
| `snake.ts` | 贪吃蛇游戏 | `registerCommand`、`ui.custom`、键盘处理 |
| `space-invaders.ts` | 太空侵略者游戏 | `registerCommand`、`ui.custom` |
| `doom-overlay/` | 叠加中的 Doom | 带叠加的 `ui.custom` |
| **提供者** |||
| `custom-provider-anthropic/` | 自定义 Anthropic 代理 | `registerProvider` |
| `custom-provider-gitlab-duo/` | GitLab Duo 集成 | `registerProvider` |
| **消息与通信** |||
| `message-renderer.ts` | 自定义消息渲染 | `registerMessageRenderer`、`sendMessage` |
| `event-bus.ts` | 扩展间事件 | `pi.events` |
| **会话元数据** |||
| `session-name.ts` | 为选择器命名会话 | `setSessionName`、`getSessionName` |
| `bookmark.ts` | 为 /tree 添加书签记录 | `setLabel` |
| **杂项** |||
| `inline-bash.ts` | 工具调用中的内联 bash | `on("tool_call")` |
| `bash-spawn-hook.ts` | 在执行前调整 bash 命令、cwd 和环境 | `createBashTool`、`spawnHook` |
| `with-deps/` | 带 npm 依赖的扩展 | 带有 `package.json` 的包结构 |