# @earendil-works/pi-ai

统一的 LLM API，提供可组合的 provider 集合、自动认证解析、Token 与成本统计，以及简单的上下文持久化与会话中途切换模型能力。

**说明**：该库只包含支持工具调用（function calling）的模型，因为这是 Agent 工作流的核心能力。

## 目录

- [支持的 Provider](#supported-providers)
- [安装](#installation)
- [快速开始](#quick-start)
- [Providers 与 Models](#providers-and-models)
  - [Provider 工厂](#provider-factories)
  - [所有内置 Provider](#all-built-in-providers)
  - [查询模型](#querying-models)
  - [静态目录读取](#static-catalog-reads)
  - [动态 Provider](#dynamic-providers)
- [认证](#auth)
  - [认证解析方式](#how-auth-resolves)
  - [凭证存储](#credential-store)
  - [环境变量](#environment-variables)
- [工具](#tools)
  - [定义工具](#defining-tools)
  - [处理工具调用](#handling-tool-calls)
  - [带部分 JSON 的流式工具调用](#streaming-tool-calls-with-partial-json)
  - [校验工具参数](#validating-tool-arguments)
  - [完整事件参考](#complete-event-reference)
- [图片输入](#image-input)
- [图片生成](#image-generation)
- [Thinking/Reasoning](#thinkingreasoning)
  - [统一接口](#unified-interface-streamsimplecompletesimple)
  - [Provider 专属选项](#provider-specific-options-streamcomplete)
  - [流式输出 Thinking 内容](#streaming-thinking-content)
- [停止原因](#stop-reasons)
- [错误处理](#error-handling)
  - [中止请求](#aborting-requests)
  - [中止后继续](#continuing-after-abort)
  - [调试 Provider Payload](#debugging-provider-payloads)
- [自定义 Provider](#custom-providers)
  - [createProvider()](#createprovider)
  - [直接调用 API 实现](#calling-api-implementations-directly)
  - [OpenAI 兼容性设置](#openai-compatibility-settings)
- [用于测试的 Faux Provider](#faux-provider-for-tests)
- [跨 Provider 切换](#cross-provider-handoffs)
- [上下文序列化](#context-serialization)
- [浏览器使用](#browser-usage)
- [打包与 Tree Shaking](#bundling-and-tree-shaking)
- [OAuth Providers](#oauth-providers)
  - [Vertex AI](#vertex-ai)
  - [CLI 登录](#cli-login)
  - [编程式 OAuth](#programmatic-oauth)
- [从旧全局 API 迁移](#migrating-from-the-old-global-api)
- [开发](#development)
- [许可证](#license)

<a id="supported-providers"></a>

## 支持的 Provider

- **OpenAI**
- **Ant Ling**
- **Azure OpenAI (Responses)**
- **OpenAI Codex**（需要 ChatGPT Plus/Pro 订阅，并通过 OAuth 登录，详见下文）
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic**
- **Google**
- **Vertex AI**（通过 Vertex AI 使用 Gemini）
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **ZAI Coding Plan (Global)**（另有独立的中国区 Provider）
- **MiniMax**（另有独立的中国区 Provider）
- **Together AI**
- **Hugging Face**
- **Moonshot AI**（另有独立的中国区 Provider）
- **GitHub Copilot**（需要 OAuth，详见下文）
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks**（使用兼容 OpenAI 与 Anthropic 的 API）
- **Kimi For Coding**（Moonshot AI 订阅端点，使用兼容 Anthropic 的 API）
- **Xiaomi MiMo**（默认使用 API 计费端点，并为 `cn` / `ams` / `sgp` 区域提供独立的 Token Plan Provider）
- **任意兼容 OpenAI 的 API**：Ollama、vLLM、LM Studio 等

<a id="installation"></a>

## 安装

```bash
npm install @earendil-works/pi-ai
```

`@earendil-works/pi-ai` 会重新导出 TypeBox 的这些导出：`Type`、`Static` 和 `TSchema`。

<a id="quick-start"></a>

## 快速开始

你需要先构建一个由多个 provider 组成的 `Models` 集合，然后通过它进行流式调用。最快的方式是注册所有内置 provider；如果应用对 bundle 体积敏感，则应只注册所需的单个 provider（见 [Provider 工厂](#provider-factories) 和 [打包与 Tree Shaking](#bundling-and-tree-shaking)）。

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
// 加了 type 前缀是类型导入，只在编译时的类型检查阶段使用；不加就是一般的值导入，会在运行时实际存在
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

// 一个注册了全部内置 provider 的 Models 集合
const models = builtinModels();

// 在集合中同步查找模型
const model = models.getModel('openai', 'gpt-4o-mini')!;

// 使用 TypeBox schema 定义工具，获得类型安全和参数校验
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// 构建对话上下文（易于序列化，也便于在模型之间传递）
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// 方式 1：使用完整事件类型进行流式处理
// 认证通过 provider 自动解析（这里会从环境变量读取 OPENAI_API_KEY）
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // 工具参数正在以流的方式增量传输
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// 流结束后拿到最终消息，并将其加入上下文
const finalMessage = await s.result();
context.messages.push(finalMessage);

// 如有工具调用，则执行工具
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // 将工具结果加入上下文（支持文本和图片）
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// 如果有工具调用，则继续对话
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// 方式 2：不使用流，直接获取完整响应
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

后续各段示例默认你已经像上面这样准备好了一个 `models` 集合，并注册了相关 provider。

<a id="providers-and-models"></a>

## Providers 与 Models

**provider** 是运行时单元：它拥有自己的模型目录、认证逻辑（API Key 解析、OAuth 流程）以及流式行为。`Models` 集合负责保存这些 provider，并把每次请求路由给真正拥有该模型的 provider。

在内部，不同 provider 会复用 **API 实现**（即底层线协议）：Anthropic 模型使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 以及大多数其他 provider 共用 `openai-completions`。像 GitHub Copilot、OpenCode Zen 这类混合 API 的 provider，会按模型分别分发到不同 API。

<a id="provider-factories"></a>

### Provider 工厂

如果应用只需要少量特定 provider，则每个内置 provider 都提供一个独立工厂，可通过子路径导入，只拉入该 provider 的模型目录：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
// ...支持列表中的每个 provider 都有对应模块

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

Provider 工厂只会导入自己的模型目录和一个懒加载 API 包装器，不会导入其他 provider。配合 bundler 的代码分割，SDK 实现（如 `@anthropic-ai/sdk`、`openai`、`@google/genai` 等）会被放在懒加载 chunk 中，并在首次请求对应 API 的模型时再加载。

<a id="all-built-in-providers"></a>

### 所有内置 Provider

如果应用希望直接拥有全部内置 provider（如快速开始示例）：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // 注册了全部内置 provider 的 Models 集合
```

这个入口会导入所有模型目录和所有内置 provider 工厂，是一个更重但更显式的入口。`builtinModels()` 接收与 `createModels()` 相同的参数（`credentials`、`authContext`）；如果你想手动注册，也可以使用 `builtinProviders()` 获取 provider 数组。

<a id="querying-models"></a>

### 查询模型

读取操作是同步的，返回的是当前已知的最新列表：

```typescript
const providers = models.getProviders();           // 已注册的 Provider 对象
const provider = models.getProvider('anthropic');  // 单个 provider

const all = models.getModels();                    // 所有 provider 的全部模型
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

动态列出的模型类型为 `Model<Api>`。如果你需要 API 专属选项的类型提示，可以使用 `hasApi()` 做类型收窄：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> —— stream 选项具备完整类型
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

<a id="static-catalog-reads"></a>

### 静态目录读取

如果你在做工具链开发，希望直接读取生成好的内置模型目录并保留完整字面量类型（provider 和 model ID 支持自动补全），且不依赖 `Models` 集合：

```typescript
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // 类型为 Model<'openai-responses'>
const providers = getBuiltinProviders();
const anthropic = getBuiltinModels('anthropic');
```

<a id="dynamic-providers"></a>

### 动态 Provider

有些 provider 的模型列表是动态的（例如 llama.cpp 服务、实时 OpenRouter 列表）。读取仍然是同步的，但刷新是显式的异步操作：

```typescript
// getModels() 返回最后一次已知列表（首次 refresh 前通常为空）
await models.refresh('llamacpp');        // 拉取单个 provider 的模型列表；失败会 reject
await models.refresh();                  // 并发刷新全部 provider，尽力而为
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置 provider 对 `refresh()` 是 no-op。如何构建动态 provider，见 [createProvider()](#createprovider)。

<a id="auth"></a>

## 认证

每个 provider 都拥有自己的认证逻辑：包括 API Key 如何解析（存储凭证、环境变量、AWS profile 或 gcloud ADC 等环境来源），以及在支持时的 OAuth 登录/刷新流程。

<a id="how-auth-resolves"></a>

### 认证解析方式

当你调用 `models.stream()` 时，集合会通过对应 provider 解析认证信息，并将其合并进请求中。显式传入的单次请求参数永远优先：

```typescript
// 由 provider 自动解析认证信息（环境变量、存储凭证、OAuth Token）
await models.complete(model, context);

// 显式传入的 key 优先级高于 provider 自动解析的任何值
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

你也可以不发请求，仅检查认证解析结果，这对状态 UI 很有用：

```typescript
const auth = await models.getAuth(model);
if (auth) {
  console.log(`configured via ${auth.source}`); // 例如 "ANTHROPIC_API_KEY"、"OAuth"、"stored credential"
} else {
  console.log('not configured');
}
```

如果 provider 尚未配置，`getAuth()` 会返回 `undefined`；如果确实发生故障，则会抛出 `ModelsError`。例如：

- `"oauth"`：token 刷新失败，但凭证会保留以便重新登录
- `"auth"`：API Key 解析失败或凭证存储失败

请求路径也会以相同方式暴露这些错误，表现为流式错误事件。

<a id="credential-store"></a>

### 凭证存储

存储凭证（交互式输入的 API Key、OAuth Token）保存在 `CredentialStore` 中，每个 provider 对应一个带类型标签的凭证。pi-ai 默认提供内存版存储；应用通常会注入持久化实现：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() 也接受同样的选项：
// const models = builtinModels({ credentials: myFileBackedStore });
```

接口很小：`read(providerId)`、`modify(providerId, fn)`（唯一写入口，串行化的读改写）和 `delete(providerId)`。OAuth Token 刷新在 `modify` 中执行，因此并发请求或多进程不会重复刷新同一个已轮换的 token。已存储凭证会“拥有”该 provider：只有在没有存储凭证时才会查询环境变量；刷新失败后也不会静默回退到环境变量中的 key。

API Key 类型的凭证与 pi 的 `auth.json` 使用相同判别字段，并且可以携带 provider 级环境/配置值：

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

<a id="environment-variables"></a>

### 环境变量

内置 provider 会解析以下环境变量（Node.js 环境；在浏览器中请显式传入 `apiKey`）：

| Provider | 环境变量 |
|----------|----------|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（例如 `https://{resource}.ai.azure.com`）或 `AZURE_OPENAI_RESOURCE_NAME`。支持 `*.openai.azure.com`、`*.cognitiveservices.azure.com` 和 `*.ai.azure.com`；根端点会自动规范化为 `/openai/v1`。可选：`AZURE_OPENAI_API_VERSION`（默认 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。 |
| Anthropic | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` 或 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）+ `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (Global) | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (China) | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Xiaomi MiMo（API 计费） | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan（中国区） | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan（阿姆斯特丹） | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan（新加坡） | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

Amazon Bedrock 会解析环境中的 AWS 凭证（`AWS_PROFILE`、访问密钥对、`AWS_BEARER_TOKEN_BEDROCK`、ECS task role、web identity token）。Vertex AI 会解析显式 API Key，或基于 gcloud Application Default Credentials 再结合 project/location。

<a id="tools"></a>

## 工具

工具使 LLM 能够与外部系统交互。该库使用 TypeBox Schema 来定义工具，以实现类型安全，并利用 TypeBox 自带的校验器和值转换工具完成自动校验。TypeBox Schema 可以作为普通 JSON 进行序列化和反序列化，因此非常适合分布式系统。

<a id="defining-tools"></a>

### 定义工具

```typescript
import { Type, type Tool, StringEnum } from '@earendil-works/pi-ai';

// 使用 TypeBox 定义工具参数
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// 注意：为兼容 Google API，请使用 StringEnum 辅助函数而不是 Type.Enum
// Type.Enum 会生成 anyOf/const 结构，而 Google 不支持这种格式

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

<a id="handling-tool-calls"></a>

### 处理工具调用

工具结果使用内容块表示，既可以包含文本，也可以包含图片：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// 检查响应中的工具调用
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // 使用参数执行工具
    // 参数校验见“校验工具参数”一节
    const result = await executeWeatherApi(block.arguments);

    // 将文本工具结果加入上下文
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// 工具结果也可以包含图片（适用于支持视觉的模型）
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

<a id="streaming-tool-calls-with-partial-json"></a>

### 带部分 JSON 的流式工具调用

在流式输出过程中，工具调用参数会随着数据到达而被渐进式解析。这使得你在完整参数尚未接收完成之前，就能做实时 UI 更新：

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments 中包含当前已尽力解析出的部分 JSON
    // 因此可以做渐进式 UI 更新
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // 必须防御式编程：参数可能尚未完整
      // 例如：在内容尚未完整时，也可以先显示正在写入的文件路径
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // content 可能仍是部分内容，甚至还不存在
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // 到这里 toolCall.arguments 已完整（但尚未校验）
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**关于部分工具参数的重要说明：**

- 在 `toolcall_delta` 事件中，`arguments` 是对部分 JSON 的尽力解析结果
- 字段可能缺失或不完整，使用前务必检查是否存在
- 字符串值可能在单词中途被截断
- 数组可能不完整
- 嵌套对象可能只填充了一部分
- `arguments` 至少会是空对象 `{}`，不会是 `undefined`
- Google provider 不支持函数调用的流式传输，因此你只会收到一个带完整参数的 `toolcall_delta` 事件

<a id="validating-tool-arguments"></a>

### 校验工具参数

如果你自己实现工具执行循环，建议在把参数传给工具前使用 `validateToolCall` 做校验：

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // 根据工具 schema 校验参数（参数无效时会抛错）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ...将工具结果写回上下文
    } catch (error) {
      // 校验失败：把错误作为工具结果返回，让模型有机会重试
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

<a id="complete-event-reference"></a>

### 完整事件参考

生成 assistant 消息时，流中可能发出的全部事件如下：

| 事件类型 | 说明 | 关键属性 |
|----------|------|----------|
| `start` | 流开始 | `partial`：assistant 消息初始结构 |
| `text_start` | 文本块开始 | `contentIndex`：内容数组中的位置 |
| `text_delta` | 收到文本增量 | `delta`：新增文本，`contentIndex`：位置 |
| `text_end` | 文本块完成 | `content`：完整文本，`contentIndex`：位置 |
| `thinking_start` | thinking 块开始 | `contentIndex`：内容数组中的位置 |
| `thinking_delta` | 收到 thinking 增量 | `delta`：新增文本，`contentIndex`：位置 |
| `thinking_end` | thinking 块完成 | `content`：完整 thinking 内容，`contentIndex`：位置 |
| `toolcall_start` | 工具调用开始 | `contentIndex`：内容数组中的位置 |
| `toolcall_delta` | 工具参数流式到达 | `delta`：JSON 片段，`partial.content[contentIndex].arguments`：部分解析参数 |
| `toolcall_end` | 工具调用完成 | `toolCall`：完整工具调用，含 `id`、`name`、`arguments` |
| `done` | 流完成 | `reason`：停止原因（`"stop"`、`"length"`、`"toolUse"`），`message`：最终 assistant 消息 |
| `error` | 出现错误 | `reason`：错误类型（`"error"` 或 `"aborted"`），`error`：包含部分内容的 `AssistantMessage` |

不同内容块的流事件**不保证连续出现**。Provider 可能在同一个上游 chunk 中同时发出文本、thinking 和工具调用增量，而 pi 也可能将对应事件交错抛出，例如：`text_start`、`text_delta`、`toolcall_start`、`text_delta`、`toolcall_delta`。消费方必须使用 `contentIndex` 来关联各个块，不能假设某个块的 `*_start` / `*_delta` / `*_end` 序列在中间不会被其他块打断。

<a id="image-input"></a>

## 图片输入

支持视觉能力的模型可以处理图片。你可以通过模型的 `input` 属性判断是否支持图片；如果把图片传给不支持视觉的模型，图片会被静默忽略。

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// 检查模型是否支持图片
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

<a id="image-generation"></a>

## 图片生成

图片生成使用与文本/聊天不同的一套 API 表面，但设计理念相似：`ImagesModels` 集合保存 `ImagesProvider`，读取操作是同步的，认证通过所属 provider 自动解析。图片生成是一次性 API：调用 `generateImages()` 会等待 provider 返回最终 `AssistantImages` 结果，因此**不要**使用聊天/流式 API 来做图片生成。

### 基础图片生成

```typescript
import { builtinImagesModels } from '@earendil-works/pi-ai/providers/all';

// 注册全部内置图片生成 provider；接受与 createModels() 相同的选项
const imagesModels = builtinImagesModels();

const model = imagesModels.getModel('openrouter', 'google/gemini-2.5-flash-image')!;

// 认证通过 provider 自动解析（这里读取 OPENROUTER_API_KEY）；显式 apiKey 仍优先
const result = await imagesModels.generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32));
  }
}
```

与聊天侧类似，你也可以按部件构建集合：`createImagesModels({ credentials?, authContext? })`、来自 `@earendil-works/pi-ai/providers/openrouter-images` 的 `openrouterImagesProvider()` 工厂，以及 `createImagesProvider({ id, auth, models, refreshModels?, api })` 用于自定义图片 provider（动态模型列表对应 `imagesModels.refresh(provider?)`）。失败不会 reject，而是返回一个 `stopReason: "error"` 的 `AssistantImages`。集合上的 `getAuth(model)` 与聊天侧行为完全一致。

旧的全局 API（`getImageModel()` / `getImageModels()` / `getImageProviders()` / `generateImages()`）仍可通过 [compat 入口](#migrating-from-the-old-global-api) 使用：

```typescript
import { getImageModel, generateImages } from '@earendil-works/pi-ai/compat';

const model = getImageModel('openrouter', 'google/gemini-2.5-flash-image');
const result = await generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
}, {
  apiKey: process.env.OPENROUTER_API_KEY
});
```

有些模型还支持图片输入：

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await imagesModels.generateImages(model, {
  input: [
    { type: 'text', text: 'Create a variation of this image with a blue background.' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

可以通过模型元数据检查能力：

```typescript
console.log(model.input);   // ['text', 'image']
console.log(model.output);  // ['image'] 或 ['image', 'text']
```

### 说明与限制

- 图片模型使用 `ImagesModels` 集合，聊天模型使用 `Models` 集合；两者是分离的表面
- 请使用 `generateImages()`，不要使用聊天/流式 API
- 图片生成模型不参与工具调用
- 输出位于 `AssistantImages.output`，可同时包含 base64 编码的 `ImageContent` 和 `TextContent`
- 有些模型只返回图片，有些会同时返回图片和文本。请检查 `model.output`
- 有些模型支持图片输入，有些仅支持文生图。请检查 `model.input`
- 与流式 API 一样，图片生成也支持 `apiKey`、`signal`、`headers`、`onPayload`、`onResponse` 等选项，结果也可能带有 `stopReason`、`responseId` 和 `usage`
- 如果你希望模型在对话中分析图片或调用工具，请使用支持图片输入的常规聊天模型
- 当前只有一个 provider 支持图片生成：OpenRouter

<a id="thinkingreasoning"></a>

## Thinking/Reasoning

许多模型支持 thinking/reasoning 能力，可以显式展示内部思考过程。你可以通过模型的 `reasoning` 属性判断是否支持；如果给不支持 reasoning 的模型传入相关选项，这些选项会被静默忽略。

<a id="unified-interface-streamsimplecompletesimple"></a>

### 统一接口（streamSimple/completeSimple）

```typescript
// 多个 provider 的很多模型都支持 thinking/reasoning
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// 或 models.getModel('openai', 'gpt-5-mini');
// 或 models.getModel('google', 'gemini-2.5-flash');
// 或 models.getModel('xai', 'grok-code-fast-1');

// 检查模型是否支持 reasoning
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// 使用简化后的 reasoning 选项
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// 访问 thinking 和文本块
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

`xhigh` 和 `max` 是模型专属、显式启用的等级。可通过 `getSupportedThinkingLevels(model)` 判断某个具体模型是否支持这两个级别，例如 GPT-5.6 可能同时支持二者。

<a id="provider-specific-options-streamcomplete"></a>

### Provider 专属选项（stream/complete）

`models.stream()` / `complete()` 接受所属 API 的完整选项集合。若模型是动态查得的，使用 `hasApi()` 可把它收窄到具体 API，以获得完整类型提示：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI Reasoning（o1、o3、gpt-5）
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // 仅 OpenAI Responses API 支持
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // 可选 token 上限
  });
}

// Google Gemini Thinking
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 表示动态，0 表示关闭
    }
  });
}
```

<a id="streaming-thinking-content"></a>

### 流式输出 Thinking 内容

流式模式下，thinking 内容通过专门的事件传递：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // 流式输出 thinking 内容
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

<a id="stop-reasons"></a>

## 停止原因

每个 `AssistantMessage` 都包含 `stopReason` 字段，用于说明本次生成为何结束：

- `"stop"`：正常结束，模型已完成响应
- `"length"`：输出达到最大 token 限制
- `"toolUse"`：模型正在调用工具，并期待你回传工具结果
- `"error"`：生成过程中发生错误
- `"aborted"`：请求被 abort signal 取消

`AssistantMessage` 还可能带有 `responseId`，表示 provider 上游响应或消息 ID（如果底层 API 暴露了该值）。不要假设所有 provider 都一定会提供它。

<a id="error-handling"></a>

## 错误处理

流式函数在请求失败时不会直接抛错离开调用栈：当请求以错误结束时（包括 abort 和工具参数校验错误），流式 API 会先发出错误事件，最终消息也会带上错误详情：

```typescript
// 流式处理中
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason 只会是 "error" 或 "aborted"
    // event.error 是携带部分内容的 AssistantMessage
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// 最终消息也会带上错误细节
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content 包含错误前已经收到的部分内容
  // message.usage 包含部分 token 和成本统计
}
```

认证失败（如未配置 key、OAuth 刷新失败、未知 provider）也会以同样方式暴露：即作为流式错误，并且 `stopReason: "error"`。

<a id="aborting-requests"></a>

### 中止请求

你可以通过 abort signal 取消进行中的请求。被中止的请求其 `stopReason === 'aborted'`：

```typescript
const controller = new AbortController();

// 2 秒后中止
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason 用于区分 "error" 与 "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// 获取结果（如果被中止，可能只包含部分内容）
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

<a id="continuing-after-abort"></a>

### 中止后继续

被中止的消息可以继续加入对话上下文，并在后续请求中接着生成：

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// 第一次请求在 2 秒后中止
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// 将部分响应加入上下文
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// 继续对话
const continuation = await models.complete(model, context);
```

<a id="debugging-provider-payloads"></a>

### 调试 Provider Payload

你可以通过 `onPayload` 回调检查发给 provider 的请求 payload，这对调试请求格式问题或 provider 校验错误很有用。

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

该回调适用于 `stream`、`complete`、`streamSimple` 和 `completeSimple`。

<a id="custom-providers"></a>

## 自定义 Provider

<a id="createprovider"></a>

### createProvider()

`createProvider()` 用几个组成部分来构建 provider：身份信息、认证逻辑、模型列表和 API 实现。适用于本地推理服务、代理层或任何兼容 OpenAI / Anthropic 的端点：

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // 每个 provider 都必须声明 auth；无 key 的本地服务可以解析为空认证对象
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

如果 provider 需要真正的 API Key，可用 `envApiKeyAuth(displayName, envVars)` 获得标准行为（优先读取存储凭证，其次读取第一个已设置的环境变量）：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

混合 API 的 provider 可以传入一个以 `model.api` 为 key 的 map；每个模型会自动派发到相应 API 实现：

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

动态模型列表通过 `refreshModels` 提供；在第一次 `models.refresh()` 前，该 provider 的模型列表为空：

```typescript
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  refreshModels: async () => fetchModelsFromServer('http://localhost:8080'),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
await models.refresh('llamacpp');
```

自定义模型还可以携带 `headers`（例如位于 bot 检测后的代理）和 `compat` 标记，详见 [OpenAI 兼容性设置](#openai-compatibility-settings)。

有些兼容 OpenAI 的服务不支持 reasoning-capable 模型使用的 `developer` 角色。对于这类 provider，请设置 `compat.supportsDeveloperRole = false`，让 system prompt 以 `system` 消息发送。如果服务同样不支持 `reasoning_effort`，还应把 `compat.supportsReasoningEffort` 设为 `false`。这类情况常见于 Ollama、vLLM、SGLang 等兼容 OpenAI 的服务。

可以使用模型级 `thinkingLevelMap` 描述模型专属的 thinking 控制。key 是 pi 的 thinking 等级（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。`high` 及以下的标准等级若缺失，则使用 provider 默认值；`xhigh` 与 `max` 为显式 opt-in，必须有非 `null` 映射项才支持。字符串值会原样发送给 provider，`null` 表示该等级不受支持，map 也可以跳过某些等级。

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

<a id="calling-api-implementations-directly"></a>

### 直接调用 API 实现

这些 API 实现也可以单独导入。每个模块都只导出 `stream` 和 `streamSimple`，并携带该 API 的完整选项类型。直接调用会绕过 provider 认证，因此你需要显式传入 `apiKey`：

```typescript
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, context, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

内置 API 实现位于 `./api/<api-id>`：

| API id | 选项类型 |
|--------|----------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

导入某个实现模块会立即加载其 SDK。供 provider 工厂使用的 `./api/<id>.lazy` 包装器，会在运行时或 bundler 支持动态导入分块时，将该加载延迟到首次请求。旧版本中的原始 API 子路径（如 `./anthropic`、`./google`、`./mistral`、`./openai-completions` 等）已经移除，请改用 `@earendil-works/pi-ai/api/<api-id>`。

<a id="openai-compatibility-settings"></a>

### OpenAI 兼容性设置

许多 provider 都以略有差异的方式实现了 `openai-completions` API。默认情况下，库会根据 `baseUrl` 自动检测少数已知兼容 provider 的兼容性设置（例如 Cerebras、xAI、Chutes、DeepSeek、NVIDIA NIM、Together AI、zAi、OpenCode、Cloudflare Workers AI 等）。对于自定义代理或未知端点，可以通过 `compat` 字段覆盖这些设置。对于 `openai-responses` 模型，`compat` 字段支持 Responses 专属标记。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // 是否支持 `store` 字段（默认 true）
  supportsDeveloperRole?: boolean;   // 是否支持 `developer` 角色而非 `system`（默认 true）
  supportsReasoningEffort?: boolean; // 是否支持 `reasoning_effort`（默认 true）
  supportsUsageInStreaming?: boolean; // 是否支持 `stream_options: { include_usage: true }`（默认 true）
  supportsStrictMode?: boolean;      // 是否支持工具定义中的 `strict`（默认 true）
  sendSessionAffinityHeaders?: boolean; // 启用缓存时，是否从 `sessionId` 发送 `session_id`、`x-client-request-id` 和 `x-session-affinity`（默认 false）
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // 使用哪个字段名（默认 max_completion_tokens）
  requiresToolResultName?: boolean;  // 工具结果是否必须带 `name` 字段（默认 false）
  requiresAssistantAfterToolResult?: boolean; // 工具结果后是否必须紧跟 assistant 消息（默认 false）
  requiresThinkingAsText?: boolean;  // 是否必须把 thinking 块转换成文本（默认 false）
  requiresReasoningContentOnAssistantMessages?: boolean; // 开启 reasoning 时，是否要求所有回放的 assistant 消息都带空的 reasoning_content（默认对 DeepSeek 自动检测）
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // reasoning 参数格式
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort'; omitWhenOff?: boolean }>; // chat_template_kwargs 的值；可用 $var 引入 pi 控制的 thinking 值
  cacheControlFormat?: 'anthropic';  // Anthropic 风格的 cache_control，作用于 system prompt、最后一个工具、最后一个 user/assistant 文本块
  openRouterRouting?: OpenRouterRouting; // OpenRouter 路由偏好（默认 {})
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway 路由偏好（默认 {})
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // 是否支持 `developer` 角色而非 `system`（默认 true）
  sendSessionIdHeader?: boolean;     // 启用缓存时是否从 `sessionId` 发送 `session_id`（默认 true）
  supportsLongCacheRetention?: boolean; // 是否支持 `prompt_cache_retention: "24h"`（默认 true）
}
```

如果未设置 `compat`，库会回退到基于 URL 的自动检测。若只部分设置，未指定的字段仍会继承自动检测出的默认值。这对以下场景很有用：

- **LiteLLM 代理**：可能不支持 `store` 字段
- **自定义推理服务**：可能使用非标准字段名
- **自托管端点**：可能支持不同的功能集

<a id="faux-provider-for-tests"></a>

## 用于测试的 Faux Provider

`fauxProvider()` 会构建一个内存中的 provider，可用脚本化响应来做测试和演示：

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // 可选
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// 可选：使用多个 faux 模型测试模型切换
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

说明：

- 响应会按请求开始顺序从队列中消费
- 如果队列为空，faux provider 会返回一个 assistant 错误消息，`errorMessage: "No more faux responses queued"`
- 使用 `faux.setResponses([...])` 可替换剩余队列，使用 `faux.appendResponses([...])` 可追加响应
- `faux.models` 暴露全部 faux 模型；`faux.getModel()` 返回第一个，`faux.getModel(id)` 返回指定模型
- 使用 `fauxAssistantMessage(...)` 构造脚本化 assistant 响应；`fauxText(...)`、`fauxThinking(...)` 和 `fauxToolCall(...)` 可帮助你构造内容块，而无需手动填写底层字段
- usage 粗略按 4 个字符约等于 1 个 token 估算。当传入 `sessionId` 且 `cacheRetention` 不为 `"none"` 时，会自动模拟 prompt cache 读写
- 工具参数会通过 `toolcall_delta` 增量流式发出
- 默认情况下，每个流式 chunk 都在独立微任务中发出。设置 `tokensPerSecond` 可按实时速率节流
- 这个句柄的预期用途是一条确定性的脚本化流程。如果你需要独立并发流程，请创建多个具有不同 `provider` id 的 faux provider

<a id="cross-provider-handoffs"></a>

## 跨 Provider 切换

该库支持在同一段对话中无缝切换不同的 LLM provider。你可以在对话中途更换模型，同时保留上下文，包括 thinking 块、工具调用以及工具结果。

当来自某个 provider 的消息被发送给另一个 provider 时，库会自动做兼容性转换：

- **用户消息与工具结果消息**：保持不变
- **来自同一 provider / API 的 assistant 消息**：原样保留
- **来自不同 provider 的 assistant 消息**：其 thinking 块会被转换为带 `<thinking>` 标签的文本
- **工具调用与普通文本**：原样保留

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// 先用 Claude
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// 切到 GPT-5 —— 它会把 Claude 的 thinking 视为带 <thinking> 标签的文本
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// 切到 Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: 'What was the original question?', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

所有 provider 都能处理来自其他 provider 的消息，包括文本、工具调用与工具结果（也包括图片）、thinking 块（会转换成带标签的文本）以及包含部分内容的已中止消息。这使得工作流可以非常灵活：先用快模型，再切到强模型做复杂推理，或在某个 provider 不可用时无缝切换。

<a id="context-serialization"></a>

## 上下文序列化

`Context` 对象可以直接用标准 JSON 方法进行序列化和反序列化，因此非常适合做对话持久化、聊天记录实现，或跨服务传递上下文：

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// 序列化整个上下文
const serialized = JSON.stringify(context);

// 保存到数据库、localStorage、文件等
localStorage.setItem('conversation', serialized);

// 之后：反序列化并继续对话
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// 可切换到任意模型继续
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

模型本身也是可序列化的普通数据，不带函数或实现，因此如果你想把“这个对话当前使用的是哪个模型”也持久化下来，直接 `JSON.stringify` 即可。

> **说明**：如果上下文中包含图片（如图片输入章节中的 base64 形式），它们也会一起被序列化。

<a id="browser-usage"></a>

## 浏览器使用

该库支持浏览器环境。核心入口和 provider 工厂都没有副作用，打包也足够干净。浏览器中无法使用环境变量，因此请显式传入 API Key，或者注入一个 `CredentialStore`（例如基于 localStorage 的实现），让 provider 从存储凭证中解析认证：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **安全警告**：在前端代码中暴露 API Key 是危险的，任何人都可以提取并滥用它。此方式只适合内部工具或 Demo。生产环境请使用后端代理来保护 API Key。

浏览器兼容性说明：

- Amazon Bedrock（`bedrock-converse-stream`）不支持浏览器环境。它仍可能出现在模型列表里，但运行时调用会失败
- OAuth 登录流程仅支持 Node。相关代码通过 bundler-opaque 的懒加载导入隐藏，因此注册 OAuth-capable provider 不会把 Node-only 代码打进浏览器 bundle，只有真正登录时才会加载
- 如果你的 Web 应用需要 Bedrock 或基于 OAuth 的认证，请使用服务端代理或后端服务

<a id="bundling-and-tree-shaking"></a>

## 打包与 Tree Shaking

若希望 bundle 更小，请只导入需要的 provider：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

规则如下：

- `@earendil-works/pi-ai` 是核心入口，不会导入内置模型目录、provider 工厂或 SDK 实现
- `@earendil-works/pi-ai/providers/<provider>` 只导入该 provider 的模型目录和懒加载 API 包装器
- `@earendil-works/pi-ai/providers/all` 会导入全部内置 provider 工厂和全部目录，仅在你确实需要全量内置集合时使用
- 启用代码分割时，各 provider SDK 会留在懒加载 chunk 中，并在首次请求时加载
- 不启用代码分割时，bundler 会把所有可达的懒加载 API 实现折叠进单个 bundle。单 provider bundle 只包含该 provider 的 SDK；`providers/all` 则会包含所有静态可见的 SDK。Bedrock 是例外：其 AWS SDK 实现通过 bundler-opaque 的 Node-only 导入加载
- 直接导入 `@earendil-works/pi-ai/api/<api-id>` 会立即加载该 API 实现及其 SDK

在新的打包型应用中，应避免使用 `@earendil-works/pi-ai/compat`，因为它保留了旧全局 API，并会导入完整的内置目录表面。

对于单文件 Node ESM bundle，一些 SDK 依赖内部仍可能使用动态 CommonJS `require()`。如果你看到类似 `Dynamic require of "child_process" is not supported` 的错误，请为 bundle 添加 Node `require` shim。例如使用 esbuild：

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

这只适用于 Node bundle，并不是浏览器或 Cloudflare Workers 的兼容方案。

Bedrock 是 Node-only。注册方式与其他 provider 相同：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

在常规 Node 包使用和支持代码分割的 bundle 中，Bedrock 会懒加载 AWS SDK 实现。如果你需要一个包含 Bedrock 支持的独立单文件 bundle，则要显式注册实现模块：

```typescript
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';

setBedrockProviderModule(bedrockProviderModule);
```

这样做会把 AWS SDK 一并打入 bundle。如果不做这个显式覆盖，Bedrock 的运行时不透明导入会要求包内的 Bedrock 实现文件在运行时可用。

### Provider 级环境变量覆盖

你可以在 stream 选项中传入 `env`，以便把 provider 配置限定在单次请求范围内。`env` 中的值会优先于进程环境变量，用于 provider 认证及配置，例如 Cloudflare account ID、Azure OpenAI 设置、Vertex project/location、Bedrock 设置、`PI_CACHE_RETENTION` 和 `HTTP_PROXY` / `HTTPS_PROXY`。

```typescript
const models = builtinModels();
const model = models.getModel('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6')!;

const response = await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: '...',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
});
```

这适用于以下场景：同一个进程里每次请求需要不同 provider 配置，或你不希望环境变量无意间泄露到 provider 调用中。

<a id="oauth-providers"></a>

## OAuth Providers

有些 provider 支持使用 OAuth 而不是静态 API Key：

- **Anthropic**（Claude Pro/Max 订阅）
- **OpenAI Codex**（ChatGPT Plus/Pro 订阅，可访问 GPT-5.x Codex 模型）
- **GitHub Copilot**（Copilot 订阅）

这些 provider 都会在 `provider.auth.oauth` 上挂一个 `OAuthAuth`，包含三个操作：

- `login(callbacks)`：执行交互式登录流程并返回凭证
- `refresh(credential)`：使用 refresh token 刷新凭证
- `toAuth(credential)`：从凭证派生出请求认证信息（例如 GitHub Copilot 的按账户 base URL 就在这里解析）

刷新是自动进行的：`models.getAuth()` 和请求路径都会在凭证存储锁内刷新已过期 token，因此并发请求或多进程不会重复刷新同一 token。

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // 持久化 CredentialStore
models.setProvider(anthropicProvider());

// 登录：通过 prompt()/notify() 回调驱动流程，并持久化凭证
const provider = models.getProvider('anthropic')!;
const credential = await provider.auth.oauth!.login({
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code 提示会与本地回调服务器竞争；当服务器先成功时，p.signal 会中止该提示
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
    if (event.type === 'device_code') console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});
await myStore.modify('anthropic', async () => credential);

// 之后请求会自动解析并刷新 token
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// 退出登录
await myStore.delete('anthropic');
```

<a id="vertex-ai"></a>

### Vertex AI

Vertex AI 模型既支持 Google Cloud API Key，也支持 Application Default Credentials（ADC）：

- **API Key**：设置 `GOOGLE_CLOUD_API_KEY`，或在调用选项中传入 `apiKey`
- **本地开发（ADC）**：运行 `gcloud auth application-default login`
- **CI/生产环境（ADC）**：设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向 service account JSON key 文件

使用 ADC 时，还需要设置 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）和 `GOOGLE_CLOUD_LOCATION`。你也可以在调用选项中传 `project` / `location`。如果使用 `GOOGLE_CLOUD_API_KEY`，则不要求 `project` 和 `location`。

```bash
# 本地开发（使用你的用户凭证）
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI / 生产环境（service account key 文件）
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

官方文档：[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

<a id="cli-login"></a>

### CLI 登录

最快的认证方式如下：

```bash
npx @earendil-works/pi-ai login              # 交互式选择 provider 并登录
npx @earendil-works/pi-ai login anthropic    # 登录指定 provider
npx @earendil-works/pi-ai list               # 列出可用 provider
```

凭证会保存到当前目录下的 `auth.json`。

<a id="programmatic-oauth"></a>

### 编程式 OAuth

旧版 OAuth 流程函数仍可通过 `@earendil-works/pi-ai/oauth` 入口使用（`loginAnthropic`、`loginOpenAICodex`、`loginGitHubCopilot`、`refreshOAuthToken`、`getOAuthApiKey`）；不过那种方式下，凭证存储要由调用方自己负责。新代码应优先使用上面展示的 provider 持有式 `OAuthAuth`，因为它能与 credential store 协作，并自动获得加锁刷新能力。

Provider 说明：

**OpenAI Codex**：需要 ChatGPT Plus 或 Pro 订阅，可访问 GPT-5.x Codex 模型，拥有更长上下文窗口和 reasoning 能力。当在 stream 选项中传入 `sessionId` 时，库会自动处理基于会话的 prompt caching。你可以在 stream 选项中设置 `transport` 为 `"sse"`、`"websocket"` 或 `"auto"`，以选择 Codex Responses 的传输方式。当使用 WebSocket 且提供了 `sessionId` 时，连接会按 session 复用，并在 5 分钟无活动后过期。

**Azure OpenAI (Responses)**：只使用 Responses API。设置 `AZURE_OPENAI_API_KEY`，并提供 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME`。`AZURE_OPENAI_BASE_URL` 同时支持 `https://<resource>.openai.azure.com` 和 `https://<resource>.cognitiveservices.azure.com`；根端点会自动规范化为 `.../openai/v1`。如果需要，可用 `AZURE_OPENAI_API_VERSION`（默认 `v1`）覆盖 API 版本。默认情况下 deployment name 会被当作 model ID；若要覆盖，请使用 `azureDeploymentName` 或 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`，其格式为逗号分隔的 `model-id=deployment` 对（例如 `gpt-4o-mini=my-deployment,gpt-4o=prod`）。旧式基于 deployment URL 的方式被有意不支持。

**GitHub Copilot**：如果你遇到 “The requested model is not supported” 错误，请在 VS Code 中手动启用该模型：打开 Copilot Chat，点击模型选择器，选中带警告图标的模型，然后点击 “Enable”。

<a id="migrating-from-the-old-global-api"></a>

## 从旧全局 API 迁移

旧版本暴露的是一套全局 API：`stream()` / `complete()` 根据 `model.api` 通过全局注册表分发；同步的 `getModel()` / `getModels()` / `getProviders()` 用于读取目录；再加上 `registerApiProvider()`、`getEnvApiKey()` 以及各 API 的懒加载 stream 函数。这套表面仍完整保留在 **compat 入口** 中：

```typescript
// 旧写法
import { getModel, complete } from '@earendil-works/pi-ai';

// 新写法（行为完全一致，只改导入路径）
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

Compat 是根入口的严格超集，因此你可以直接把同一个文件的导入路径整体替换过去。它将在未来版本中移除；建议迁移到 `createModels()` + provider 工厂模式：

| 旧方式 | 新方式 |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')`，或从 `providers/all` 使用 `getBuiltinModel()` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()`，或使用 `getBuiltin*` |
| `stream(model, ctx, opts)`（注入环境变量 key） | `models.stream(model, ctx, opts)`（由 provider 自动解析认证） |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model)` |
| `streamAnthropic(model, ctx, opts)` | 从 `@earendil-works/pi-ai/api/anthropic-messages` 直接导入 `stream`，或通过 provider 集合调用 |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |

<a id="development"></a>

## 开发

### 添加新 Provider

新增一个 LLM provider 需要同时修改多个文件。整体分层结构是：API 实现位于 `src/api/`，provider 工厂位于 `src/providers/`，生成的目录文件位于 `src/providers/<id>.models.ts`。下面的检查清单涵盖了所需步骤：

#### 1. 核心类型（`src/types.ts`）

- 若是全新 API，需要把 API 标识加入 `KnownApi`（例如 `"bedrock-converse-stream"`）
- 将 provider 名加入 `KnownProvider`（例如 `"amazon-bedrock"`）
- 把选项类型加入 `ApiOptionsMap`

#### 2. API 实现（`src/api/<api-id>.ts`，仅当新增 API 时）

创建新的 API 实现文件（例如 `bedrock-converse-stream.ts`），它必须精确导出 `stream` 和 `streamSimple`，并包含：

- 一个继承 `StreamOptions` 的选项接口（例如 `BedrockOptions`）
- 将 `Context` 转换为 provider 格式的消息转换函数
- 如果 provider 支持工具，则实现工具转换
- 将 provider 响应解析为标准事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）

同时添加一个懒加载包装器 `src/api/<api-id>.lazy.ts`（通过 `lazyApi()` 暴露 `<name>Api()`），这样 provider 就可以引用实现而不直接导入 SDK。还需要在 `src/index.ts` 中补充必要的根级 `export type`，以便继续从 `@earendil-works/pi-ai` 导出。

#### 3. 模型生成（`scripts/generate-models.ts`、`scripts/generate-image-models.ts`）

- 添加从 provider 数据源（例如 models.dev API）抓取并解析模型的逻辑
- 在 `scripts/generate-models.ts` 中把支持聊天/工具调用的模型数据映射到标准 `Model` 接口；重新生成后会更新 `src/providers/<id>.models.ts` 及聚合文件
- 在 `scripts/generate-image-models.ts` 中把图片生成模型映射到标准 `ImagesModel` 接口
- 处理 provider 专属细节（价格格式、能力标记、模型 ID 转换等）

#### 4. Provider 工厂（`src/providers/<id>.ts`）

- 用 `createProvider()` 把目录、认证和懒加载 API 包装器接起来
- 认证方式：标准 key provider 用 `envApiKeyAuth`；环境凭证（如 AWS、Google Vertex）用自定义 `ApiKeyAuth`；有 OAuth 时使用 `lazyOAuth`
- 在 `src/providers/all.ts` 中注册该工厂
- 如果是新 API：还要在 `src/compat.ts` 的内置列表中注册，并在 `package.json` 中添加包子路径导出

#### 5. 测试（`test/`）

创建或更新测试文件，覆盖新 provider：

- `stream.test.ts`：基础流式输出与工具调用
- `tokens.test.ts`：token 使用量统计
- `abort.test.ts`：请求取消
- `empty.test.ts`：空消息处理
- `context-overflow.test.ts`：上下文长度超限错误
- `image-limits.test.ts`：图片支持（如适用）
- `unicode-surrogate.test.ts`：Unicode 处理
- `tool-call-without-result.test.ts`：无结果的孤立工具调用
- `image-tool-result.test.ts`：工具结果中的图片
- `total-tokens.test.ts`：token 统计准确性
- `cross-provider-handoff.test.ts`：跨 provider 上下文回放
- `providers.test.ts`：provider 列表与认证解析

对于 `cross-provider-handoff.test.ts`，至少要加入一组 provider/model 组合。如果该 provider 暴露多个模型家族（例如同时有 GPT 和 Claude），则每个家族至少加入一组。

若 provider 认证方式特殊（例如 AWS、Google Vertex），请创建类似 `bedrock-utils.ts` 的工具文件，用于凭证探测辅助逻辑。

#### 6. Coding Agent 集成（`../coding-agent/`）

更新 `src/core/model-resolver.ts`：

- 在 `DEFAULT_MODELS` 中为该 provider 增加默认 model ID

更新 `src/cli/args.ts`：

- 在帮助文本中补充环境变量说明

更新 `README.md`：

- 在 providers 章节中加入该 provider 的说明与配置方法

#### 7. 文档

更新 `packages/ai/README.md`：

- 将该 provider 加入 Supported Providers
- 记录所有 provider 专属选项和认证要求
- 在 Environment Variables 章节加入对应环境变量

#### 8. Changelog

在 `packages/ai/CHANGELOG.md` 的 `## [Unreleased]` 下添加条目：

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

<a id="license"></a>

## 许可证

MIT
