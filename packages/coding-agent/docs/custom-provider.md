# 自定义提供商

扩展可以通过 `pi.registerProvider()` 注册自定义模型提供商。这可以实现：

- **代理** - 通过企业代理或 API 网关路由请求
- **自定义端点** - 使用自托管或私有模型部署
- **自定义 API** - 为非标准 LLM API 实现流式传输

## 示例扩展

请参阅以下完整的提供商示例：

- [`examples/extensions/custom-provider-anthropic/`](../examples/extensions/custom-provider-anthropic/)
- [`examples/extensions/custom-provider-gitlab-duo/`](../examples/extensions/custom-provider-gitlab-duo/)

## 目录

- [示例扩展](#example-extensions)
- [快速参考](#quick-reference)
- [覆盖现有提供商](#override-existing-provider)
- [注册新提供商](#register-new-provider)
- [注销提供商](#unregister-provider)
- [自定义流式 API](#custom-streaming-api)
- [上下文溢出错误](#context-overflow-errors)
- [测试你的实现](#testing-your-implementation)
- [配置参考](#config-reference)
- [模型定义参考](#model-definition-reference)

## 快速参考

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 覆盖现有提供商的 baseUrl
  pi.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com"
  });

  // 注册带有模型的新提供商
  pi.registerProvider("my-provider", {
    name: "My Provider",
    baseUrl: "https://api.example.com",
    apiKey: "MY_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "my-model",
        name: "My Model",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ]
  });
}
```

扩展工厂函数也可以是 `async` 的。对于动态模型发现，请在工厂函数中获取并注册模型，而不是在 `session_start` 中。Pi 会在启动继续之前等待工厂函数完成，因此提供商在交互式启动时和 `pi --list-models` 中都是可用的。

## 覆盖现有提供商

最简单的用例：将现有提供商通过代理重定向。

```typescript
// 所有 Anthropic 请求现在都通过你的代理
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// 为 OpenAI 请求添加自定义请求头
pi.registerProvider("openai", {
  headers: {
    "X-Custom-Header": "value"
  }
});

// 同时设置 baseUrl 和 headers
pi.registerProvider("google", {
  baseUrl: "https://ai-gateway.corp.com/google",
  headers: {
    "X-Corp-Auth": "CORP_AUTH_TOKEN"  // 环境变量或字面值
  }
});
```

当只提供 `baseUrl` 和/或 `headers`（不提供 `models`）时，该提供商的所有现有模型都会保留，并使用新的端点。

## 注册新提供商

要添加一个全新的提供商，请指定 `models` 以及必需的配置。

如果模型列表来自远程端点，请使用异步扩展工厂：

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

这样会在启动完成前注册获取到的模型。

```typescript
pi.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "MY_LLM_API_KEY",  // 环境变量名或字面值
  api: "openai-completions",  // 使用的流式 API
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,        // 支持扩展思考
      input: ["text", "image"],
      cost: {
        input: 3.0,           // 美元/百万 token
        output: 15.0,
        cacheRead: 0.3,
        cacheWrite: 3.75
      },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});
```

当提供了 `models` 时，它会**替换**该提供商的所有现有模型。

## 注销提供商

使用 `pi.unregisterProvider(name)` 移除之前通过 `pi.registerProvider(name, ...)` 注册的提供商：

```typescript
// 注册
pi.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "MY_LLM_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// 之后，移除它
pi.unregisterProvider("my-llm");
```

注销会移除该提供商的动态模型、API 密钥回退和自定义流处理器注册。任何被覆盖的内置模型或提供商行为都会被恢复。

在初始扩展加载阶段之后进行的调用会立即生效，因此无需 `/reload`。

### API 类型

`api` 字段决定使用哪种流式实现：

| API | 用途 |
|-----|------|
| `anthropic-messages` | Anthropic Claude API 及其兼容实现 |
| `openai-completions` | OpenAI Chat Completions API 及其兼容实现 |
| `openai-responses` | OpenAI Responses API |

大多数兼容 OpenAI 的提供商都可以使用 `openai-completions`。对于模型特定的思考级别，使用模型级别的 `thinkingLevelMap`；对于提供商的特殊行为，使用 `compat`：

```typescript
models: [{
  id: "custom-model",
  // ...
  reasoning: true,
  thinkingLevelMap: {              // 将 pi 级别映射到提供商的值；null 表示隐藏不支持的级别
    minimal: null,
    low: null,
    medium: null,
    high: "default",
    xhigh: "max"
  },
  compat: {
    supportsDeveloperRole: false,   // 使用 "system" 而非 "developer"
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",   // 而非 "max_completion_tokens"
    requiresToolResultName: true,   // 工具结果需要 name 字段
    thinkingFormat: "qwen",        // 顶层 enable_thinking: true
    cacheControlFormat: "anthropic" // Anthropic 风格的 cache_control 标记
  }
}]
```

使用 `openrouter` 来实现 OpenRouter 风格的 `reasoning: { effort }` 控制。使用 `together` 来实现 Together 风格的 `reasoning: { enabled }` 控制；启用 `supportsReasoningEffort` 时，还会发送 `reasoning_effort`。对于本地 Qwen 兼容服务器，请使用 `qwen-chat-template`，它会读取 `chat_template_kwargs.enable_thinking`。
使用 `cacheControlFormat: "anthropic"` 适用于那些在系统提示、最后一个工具定义和最后一条用户/assistant 文本内容上通过 `cache_control` 暴露 Anthropic 风格提示缓存的 OpenAI 兼容提供商。

对于使用 `api: "anthropic-messages"` 的 Anthropic 兼容提供商，如果上游模型需要自适应思考（`thinking.type: "adaptive"` 加上 `output_config.effort`），请在模型或提供商上设置 `compat.forceAdaptiveThinking: true`。内置的自适应 Claude 模型会自动设置此项。

### 认证请求头

如果你的提供商期望 `Authorization: Bearer <key>` 但不使用标准 API，请设置 `authHeader: true`：

```typescript
pi.registerProvider("custom-api", {
  baseUrl: "https://api.example.com",
  apiKey: "MY_API_KEY",
  authHeader: true,  // 添加 Authorization: Bearer 请求头
  api: "openai-completions",
  models: [...]
});
```

## 自定义流式 API

对于非标准 API 的提供商，请实现 `streamSimple`。在编写自己的实现之前，请先研究现有的提供商实现：

**参考实现：**
- [anthropic.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/providers/anthropic.ts) - Anthropic Messages API
- [openai-completions.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/providers/openai-completions.ts) - OpenAI Chat Completions
- [openai-responses.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/providers/openai-responses.ts) - OpenAI Responses API

### 流模式

所有提供商都遵循相同的模式：

```typescript
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

function streamMyProvider(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    // 初始化输出消息
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // 推送开始事件
      stream.push({ type: "start", partial: output });

      // 发起 API 请求并处理响应...
      // 在内容到达时推送内容事件...

      // 推送完成事件
      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
```

### 事件类型

通过 `stream.push()` 按以下顺序推送事件：

1. `{ type: "start", partial: output }` - 流开始

2. 内容事件（可重复，每个块使用 `contentIndex` 跟踪）：
   - `{ type: "text_start", contentIndex, partial }` - 文本块开始
   - `{ type: "text_delta", contentIndex, delta, partial }` - 文本片段
   - `{ type: "text_end", contentIndex, content, partial }` - 文本块结束
   - `{ type: "thinking_start", contentIndex, partial }` - 思考块开始
   - `{ type: "thinking_delta", contentIndex, delta, partial }` - 思考片段
   - `{ type: "thinking_end", contentIndex, content, partial }` - 思考块结束
   - `{ type: "toolcall_start", contentIndex, partial }` - 工具调用开始
   - `{ type: "toolcall_delta", contentIndex, delta, partial }` - 工具调用 JSON 片段
   - `{ type: "toolcall_end", contentIndex, toolCall, partial }` - 工具调用结束

3. `{ type: "done", reason, message }` 或 `{ type: "error", reason, error }` - 流结束

每个事件中的 `partial` 字段包含当前的 `AssistantMessage` 状态。在接收数据时更新 `output.content`，然后将 `output` 作为 `partial` 传入。

### 内容块

在内容到达时将其添加到 `output.content`：

```typescript
// 文本块
output.content.push({ type: "text", text: "" });
stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });

// 文本到达时
const block = output.content[contentIndex];
if (block.type === "text") {
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

// 块完成时
stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
```

### 工具调用

工具调用需要累积 JSON 并解析：

```typescript
// 开始工具调用
output.content.push({
  type: "toolCall",
  id: toolCallId,
  name: toolName,
  arguments: {}
});
stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });

// 累积 JSON
let partialJson = "";
partialJson += jsonDelta;
try {
  block.arguments = JSON.parse(partialJson);
} catch {}
stream.push({ type: "toolcall_delta", contentIndex, delta: jsonDelta, partial: output });

// 完成
stream.push({
  type: "toolcall_end",
  contentIndex,
  toolCall: { type: "toolCall", id, name, arguments: block.arguments },
  partial: output
});
```

### 用量与成本

从 API 响应中更新用量并计算成本：

```typescript
output.usage.input = response.usage.input_tokens;
output.usage.output = response.usage.output_tokens;
output.usage.cacheRead = response.usage.cache_read_tokens ?? 0;
output.usage.cacheWrite = response.usage.cache_write_tokens ?? 0;
output.usage.totalTokens = output.usage.input + output.usage.output +
                           output.usage.cacheRead + output.usage.cacheWrite;
calculateCost(model, output.usage);
```

### 上下文溢出错误

当请求超过模型的上下文窗口时，pi 可以通过压缩对话并重试来自动恢复。这种恢复仅在 pi 将失败识别为溢出时才会触发。

检测在最终的 assistant 消息上运行：

- `stopReason === "error"`
- `errorMessage` 匹配 pi 已知的溢出模式之一（参见 [`packages/ai/src/utils/overflow.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/utils/overflow.ts)）

如果你的提供商返回的溢出错误消息 pi 无法识别，请在注册该提供商的同一个扩展中规范化该错误。使用 `message_end` 处理器重写 assistant 消息，使其 `errorMessage` 以 pi 能识别的短语开头。通用的回退值 `context_length_exceeded` 是最安全的选择。

```typescript
const MY_PROVIDER_OVERFLOW_PATTERN = /your provider's overflow phrase/i;

export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-provider", { /* ... */ });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (
      message.provider !== "my-provider" &&
      ctx.model?.provider !== "my-provider"
    )
      return;

    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) return;
    if (!MY_PROVIDER_OVERFLOW_PATTERN.test(errorMessage)) return;

    return {
      message: {
        ...message,
        errorMessage: `context_length_exceeded: ${errorMessage}`,
      },
    };
  });
}
```

`message_end` 在 pi 跟踪 assistant 消息以进行自动压缩之前运行，因此重写后的 `errorMessage` 才是 pi 检查的内容。有了这个机制，pi 将：

1. 从 `errorMessage` 检测到溢出。
2. 从实时上下文中丢弃失败的 assistant 消息。
3. 执行压缩。
4. 重试请求一次。

请仔细保护重写逻辑：

- 将其限定在你的提供商范围内（`message.provider` 和 `ctx.model?.provider`），这样其他提供商的无关错误不会被触及。
- 匹配提供商特定的模式，而不是 pi 的通用溢出模式。重写速率限制或限流错误（`rate limit`、`too many requests`）会错误地触发压缩，而不是 pi 正常的带退避重试路径。
- 当 `errorMessage` 已经包含 `context_length_exceeded` 时跳过处理，以便处理器是幂等的。

### 注册

注册你的流函数：

```typescript
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "MY_API_KEY",
  api: "my-custom-api",
  models: [...],
  streamSimple: streamMyProvider
});
```

## 测试你的实现

针对与内置提供商相同的测试套件来测试你的提供商。从 [packages/ai/test/](https://github.com/earendil-works/pi-mono/tree/main/packages/ai/test) 复制并适配以下测试文件：

| 测试 | 目的 |
|------|------|
| `stream.test.ts` | 基本流式传输、文本输出 |
| `tokens.test.ts` | Token 计数和用量 |
| `abort.test.ts` | AbortSignal 处理 |
| `empty.test.ts` | 空/最小响应 |
| `context-overflow.test.ts` | 上下文窗口限制 |
| `image-limits.test.ts` | 图像输入处理 |
| `unicode-surrogate.test.ts` | Unicode 边界情况 |
| `tool-call-without-result.test.ts` | 工具调用边界情况 |
| `image-tool-result.test.ts` | 工具结果中的图像 |
| `total-tokens.test.ts` | 总 token 计算 |
| `cross-provider-handoff.test.ts` | 提供商之间的上下文交接 |

使用你的提供商/模型对运行测试以验证兼容性。

## 配置参考

```typescript
interface ProviderConfig {
  /** 提供商在 UI（如 /login）中的显示名称。 */
  name?: string;

  /** API 端点 URL。定义模型时必填。 */
  baseUrl?: string;

  /** API 密钥或环境变量名。定义模型时必填。 */
  apiKey?: string;

  /** 流式传输的 API 类型。在定义模型时，提供商或模型级别必填。 */
  api?: Api;

  /** 非标准 API 的自定义流式实现。 */
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ) => AssistantMessageEventStream;

  /** 请求中包含的自定义请求头。值可以是环境变量名。 */
  headers?: Record<string, string>;

  /** 如果为 true，则添加 Authorization: Bearer 请求头，值为解析后的 API 密钥。 */
  authHeader?: boolean;

  /** 要注册的模型。如果提供，将替换该提供商的所有现有模型。 */
  models?: ProviderModelConfig[];
};
```

## 模型定义参考

```typescript
interface ProviderModelConfig {
  /** 模型 ID（例如 "claude-sonnet-4-20250514"）。 */
  id: string;

  /** 显示名称（例如 "Claude 4 Sonnet"）。 */
  name: string;

  /** 此特定模型的 API 类型覆盖。 */
  api?: Api;

  /** 此特定模型的 API 端点 URL 覆盖。 */
  baseUrl?: string;

  /** 模型是否支持扩展思考。 */
  reasoning: boolean;

  /** 将 pi 思考级别映射到提供商/模型特定的值；null 表示不支持该级别。 */
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;

  /** 支持的输入类型。 */
  input: ("text" | "image")[];

  /** 每百万 token 的成本（用于用量跟踪）。 */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };

  /** 最大上下文窗口大小（token 数）。 */
  contextWindow: number;

  /** 最大输出 token 数。 */
  maxTokens: number;

  /** 此特定模型的自定义请求头。 */
  headers?: Record<string, string>;

  /** 所选 API 的兼容性设置。 */
  compat?: {
    // openai-completions
    supportsStore?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    requiresToolResultName?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    requiresThinkingAsText?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
    thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "qwen-chat-template";
    cacheControlFormat?: "anthropic";

    // anthropic-messages
    supportsEagerToolInputStreaming?: boolean;
    supportsLongCacheRetention?: boolean;
    sendSessionAffinityHeaders?: boolean;
    supportsCacheControlOnTools?: boolean;
    forceAdaptiveThinking?: boolean;
  };
}
```

`openrouter` 发送 `reasoning: { effort }`。`deepseek` 在启用时发送 `thinking: { type: "enabled" | "disabled" }` 和 `reasoning_effort`。`together` 发送 `reasoning: { enabled }`，并且在启用 `supportsReasoningEffort` 时也会发送 `reasoning_effort`。`qwen` 用于 DashScope 风格的顶层 `enable_thinking`。对于需要 `chat_template_kwargs.enable_thinking` 的本地 Qwen 兼容服务器，请使用 `qwen-chat-template`。
`cacheControlFormat: "anthropic"` 将 Anthropic 风格的 `cache_control` 标记应用于系统提示、最后一个工具定义以及最后一条用户/assistant 文本内容。
