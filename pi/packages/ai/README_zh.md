# @earendil-works/pi-ai

统一的 LLM API，支持多 provider 集合、自动认证解析、token 与费用追踪，以及简单的上下文持久化和会话中途模型切换。

**注意**：本库仅包含支持工具调用（函数调用）的模型，这对 agent 工作流至关重要。

## 目录

- [支持的 Provider](#支持的-provider)
- [安装](#安装)
- [快速开始](#快速开始)
- [Provider 与模型](#provider-与模型)
  - [Provider 工厂函数](#provider-工厂函数)
  - [所有内置 Provider](#所有内置-provider)
  - [查询模型](#查询模型)
  - [静态目录读取](#静态目录读取)
  - [动态 Provider](#动态-provider)
- [认证](#认证)
  - [认证解析流程](#认证解析流程)
  - [转换请求头](#转换请求头)
  - [凭据存储](#凭据存储)
  - [环境变量](#环境变量)
- [工具](#工具)
  - [定义工具](#定义工具)
  - [处理工具调用](#处理工具调用)
  - [通过部分 JSON 流式传输工具调用](#通过部分-json-流式传输工具调用)
  - [验证工具参数](#验证工具参数)
  - [完整事件参考](#完整事件参考)
- [图片输入](#图片输入)
- [图片生成](#图片生成)
- [思考/推理](#思考推理)
  - [统一接口（streamSimple/completeSimple）](#统一接口streamsimplecompletesimple)
  - [Provider 专属选项（stream/complete）](#provider-专属选项streamcomplete)
  - [流式传输思考内容](#流式传输思考内容)
- [停止原因](#停止原因)
- [错误处理](#错误处理)
  - [中止请求](#中止请求)
  - [中止后继续](#中止后继续)
  - [调试 Provider 负载](#调试-provider-负载)
- [自定义 Provider](#自定义-provider)
  - [createProvider()](#createprovider)
  - [直接调用 API 实现](#直接调用-api-实现)
  - [OpenAI 兼容性设置](#openai-兼容性设置)
- [Faux Provider（测试用）](#faux-provider测试用)
- [跨 Provider 切换](#跨-provider-切换)
- [上下文序列化](#上下文序列化)
- [浏览器使用](#浏览器使用)
- [打包与 Tree Shaking](#打包与-tree-shaking)
- [OAuth Provider](#oauth-provider)
  - [Vertex AI](#vertex-ai)
  - [CLI 登录](#cli-登录)
  - [编程式 OAuth](#编程式-oauth)
- [从旧版全局 API 迁移](#从旧版全局-api-迁移)
- [开发](#开发)
- [许可证](#许可证)

## 支持的 Provider

- **OpenAI**
- **Ant Ling**
- **Azure OpenAI（Responses）**
- **OpenAI Codex**（需要 ChatGPT Plus/Pro 订阅，需 OAuth，见下文）
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
- **ZAI Coding Plan（全球）**（另有中国区 provider）
- **MiniMax**（另有中国区 provider）
- **Together AI**
- **Hugging Face**
- **Moonshot AI**（另有中国区 provider）
- **GitHub Copilot**（需要 OAuth，见下文）
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks**（使用 OpenAI 和 Anthropic 兼容 API）
- **Kimi For Coding**（Moonshot AI 订阅端点，使用 Anthropic 兼容 API）
- **Xiaomi MiMo**（默认 API 计费端点，另有 `cn`/`ams`/`sgp` 区域的 Token Plan provider）
- **任意 OpenAI 兼容 API**：Ollama、vLLM、LM Studio 等

## 安装

```bash
npm install @earendil-works/pi-ai
```

TypeBox 导出从 `@earendil-works/pi-ai` 重新导出：`Type`、`Static` 和 `TSchema`。

## 快速开始

构建一个 `Models` 集合（包含多个 provider），然后对其进行流式请求。最快的开始方式是注册所有内置 provider；关注打包体积的应用则单独注册所需的 provider（参见 [Provider 工厂函数](#provider-工厂函数) 和 [打包与 Tree Shaking](#打包与-tree-shaking)）。

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

// 包含所有内置 provider 的 Models 集合
const models = builtinModels();

// 同步查找集合中的模型
const model = models.getModel('openai', 'gpt-4o-mini')!;

// 使用 TypeBox schema 定义工具，保证类型安全和验证
const tools: Tool[] = [{
  name: 'get_time',
  description: '获取当前时间',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: '可选时区（例如 America/New_York）' }))
  })
}];

// 构建对话上下文（易于序列化，可在不同模型间传递）
const context: Context = {
  systemPrompt: '你是一个乐于助人的助手。',
  messages: [{ role: 'user', content: '现在几点了？', timestamp: Date.now() }],
  tools
};

// 方式 1：流式传输，包含所有事件类型。
// 认证通过 provider 解析（此处从环境变量 OPENAI_API_KEY 获取）。
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`开始使用 ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[文本开始]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[文本结束]');
      break;
    case 'thinking_start':
      console.log('[模型正在思考...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[思考完成]');
      break;
    case 'toolcall_start':
      console.log(`\n[工具调用开始：索引 ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // 部分工具参数正在流式传输
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[正在流式传输 ${partialCall.name} 的参数]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\n工具调用：${event.toolCall.name}`);
      console.log(`参数：${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\n完成：${event.reason}`);
      break;
    case 'error':
      console.error(`错误：${event.error.errorMessage}`);
      break;
  }
}

// 流结束后获取最终消息，添加到上下文中
const finalMessage = await s.result();
context.messages.push(finalMessage);

// 处理工具调用（如果有）
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('zh-CN', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : '未知工具';

  // 将工具结果添加到上下文中（支持文本和图片）
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// 如果存在工具调用，继续对话
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('工具执行后：', continuation.content);
}

console.log(`总 token 数：输入 ${finalMessage.usage.input}，输出 ${finalMessage.usage.output}`);
console.log(`费用：$${finalMessage.usage.cost.total.toFixed(4)}`);

// 方式 2：获取完整响应（不流式传输）
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`工具：${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

本文档其余部分的代码片段假设你已按上述方式设置好 `models` 集合（已注册相关 provider）。

## Provider 与模型

**Provider** 是运行时单元：它拥有自己的模型目录、认证（API 密钥解析、OAuth 流程）以及流行为。`Models` 集合持有 provider，并将每个请求路由到拥有该模型的 provider。

Provider 内部共享 **API 实现**（通信协议）：Anthropic 模型使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 等大多数使用 `openai-completions`。混合 API 的 provider（如 GitHub Copilot、OpenCode Zen）则按模型分发。

### Provider 工厂函数

对于只需要特定 provider 的应用，每个内置 provider 都有一个工厂函数作为子路径导入，仅拉取该 provider 的目录：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
// ...支持的 Provider 列表中每个模块对应一个

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

Provider 工厂函数导入其模型目录和懒加载 API 包装器，不会导入其他 provider。配合打包器的代码分割功能，SDK 实现（`@anthropic-ai/sdk`、`openai`、`@google/genai` 等）将保持在懒加载分块中，在首次请求该 API 的模型时才加载。

### 所有内置 Provider

对于需要所有 provider 的应用（如快速开始示例中所示）：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // 包含所有内置 provider 的 Models 集合
```

这会导入所有目录和每个内置 provider 工厂函数。这是重量级的显式入口点。`builtinModels()` 接受与 `createModels()` 相同的选项（`credentials`、`authContext`）；`builtinProviders()` 返回 provider 数组，如果你想在自己的集合上注册它们。

### 查询模型

读取是同步的，返回最新已知列表：

```typescript
const providers = models.getProviders();           // 已注册的 Provider 对象
const provider = models.getProvider('anthropic');  // 单个 provider

const all = models.getModels();                    // 所有 provider 的所有模型
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  上下文窗口: ${m.contextWindow} tokens`);
  console.log(`  视觉: ${m.input.includes('image')}`);
  console.log(`  推理: ${m.reasoning}`);
}
```

动态列出的模型类型为 `Model<Api>`。需要 API 特定选项类型时，使用 `hasApi()` 守卫进行类型窄化：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> — 流选项类型完整
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### 静态目录读取

对于需要生成的内置目录及完整字面量类型推断的工具（provider 和模型 ID 自动补全），可独立于集合使用：

```typescript
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // 类型为 Model<'openai-responses'>
const providers = getBuiltinProviders();
const anthropic = getBuiltinModels('anthropic');
```

### 动态 Provider

Provider 可以拥有动态模型列表（如 llama.cpp 服务器、实时的 OpenRouter 列表）。读取保持同步；获取是显式的异步操作：

```typescript
// getModels() 返回最新已知列表（首次刷新前为空）
await models.refresh('llamacpp');        // 获取一个 provider 的列表；失败则拒绝
await models.refresh();                  // 并发刷新所有 provider，尽力模式
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置 provider 的 `refresh()` 是无操作的。构建动态 provider 参见 [createProvider()](#createprovider)。

## 认证

每个 provider 都拥有自己的认证：API 密钥如何解析（存储的凭据、环境变量、环境来源如 AWS 配置文件或 gcloud ADC），以及在支持的情况下，OAuth 登录/刷新流程。

### 认证解析流程

当你调用 `models.stream()` 时，集合通过所属 provider 解析认证并将其合并到请求中。显式的单次请求值始终优先：

```typescript
// 通过 provider 解析（环境变量、存储的凭据、OAuth token）：
await models.complete(model, context);

// 显式密钥优先于 provider 解析的任何内容：
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

可以在不发起请求的情况下检查解析结果。传入 provider ID 获取 provider 级别认证，或传入 model 以包含其静态 `model.headers`：

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`通过 ${modelAuth.source} 配置`); // 例如 "ANTHROPIC_API_KEY"、"OAuth"、"stored credential"
  console.log(modelAuth.auth.headers);              // Provider 认证头 + model.headers
} else {
  console.log('未配置');
}
```

两种重载都会解析凭据，在必要时刷新过期的 OAuth，并可能返回认证派生的 `apiKey`、`headers` 或 `baseUrl`。对于未配置的 provider，`getAuth()` 返回 `undefined`；当出现实际故障时则抛出 `ModelsError`（`"oauth"`：token 刷新失败，凭据保留以重新登录；`"auth"`：密钥解析或凭据存储失败）。请求路径将相同的故障作为流错误抛出。

### 转换请求头

`Models.stream()`、`complete()`、`streamSimple()` 和 `completeSimple()` 接受一个 Models 独有的 `transformHeaders` 选项。它在 provider 认证、`model.headers` 和显式 `options.headers` 合并之后、provider 分发之前运行一次：

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

顺序如下：

```text
provider 认证头 -> model.headers -> 显式 options.headers -> transformHeaders -> Provider.stream*()
```

头部名称大小写不敏感地合并。显式头覆盖认证/模型头，transform 拥有最终控制权；返回 `null` 表示头会抑制支持删除的低层默认值。

`transformHeaders` 属于 `Models`，不属于 `Provider`。`Models` 实现必须在调用 `Provider.stream*()` 之前消耗并移除它。Provider 实现继续接收普通的 `ApiStreamOptions` 或 `SimpleStreamOptions`，绝不自行处理 transform。应使用此选项，而不是在 `stream*()` 之前调用 `getAuth(model)`（后者会导致双重解析请求认证）。

### 凭据存储

存储的凭据（交互式输入的 API 密钥、OAuth token）存放在 `CredentialStore` 中——每个 provider 一个带类型标记的凭据。pi-ai 默认提供一个内存实现；应用可注入持久化存储：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() 接受相同选项：
// const models = builtinModels({ credentials: myFileBackedStore });
```

接口很小：`read(providerId)`、返回非敏感 `{ providerId, type }` 元数据的 `list()`、`modify(providerId, fn)`（唯一的写入路径——序列化的读-改-写）、以及 `delete(providerId)`。枚举操作不得解析密钥或执行已配置的密钥命令。OAuth token 刷新在 `modify` 内运行，因此并发请求和进程无法双重刷新已轮换的 token。存储的凭据 *拥有* 其 provider：仅在没有存储内容时才查询环境变量，刷新失败不会静默回退到环境变量密钥。

API 密钥凭据使用与 pi 的 `auth.json` 相同的鉴别器，并可携带 provider 级别的环境/配置值：

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

### 环境变量

内置 provider 解析以下环境变量（Node.js；浏览器中请显式传入 `apiKey`）：

| Provider | 环境变量 |
|----------|---------|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（例如 `https://{resource}.ai.azure.com`）或 `AZURE_OPENAI_RESOURCE_NAME`。支持 `*.openai.azure.com`、`*.cognitiveservices.azure.com` 和 `*.ai.azure.com`；根端点自动规范化为 `/openai/v1`。可选：`AZURE_OPENAI_API_VERSION`（默认 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。 |
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
| ZAI Coding Plan（全球） | `ZAI_API_KEY` |
| ZAI Coding Plan（中国） | `ZAI_CODING_CN_API_KEY` |
| MiniMax（全球） | `MINIMAX_API_KEY` |
| MiniMax（中国） | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI（中国） | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Xiaomi MiMo（API 计费） | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan（中国） | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan（阿姆斯特丹） | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan（新加坡） | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

Amazon Bedrock 解析环境 AWS 凭据（`AWS_PROFILE`、访问密钥对、`AWS_BEARER_TOKEN_BEDROCK`、ECS 任务角色、Web 身份 token）；其 provider 自有登录流程支持 bearer token、AWS 配置文件和现有的凭据链。Vertex AI 解析显式密钥或 gcloud 应用程序默认凭据加上 project/location，具有 provider 自有登录流程用于 API 密钥、ADC 和服务账号文件。

## 工具

工具使 LLM 能够与外部系统交互。本库使用 TypeBox schema 进行类型安全的工具定义，并通过 TypeBox 内置验证器和值转换工具自动验证。TypeBox schema 可序列化为纯 JSON 并反序列化，非常适合分布式系统。

### 定义工具

```typescript
import { Type, type Tool, StringEnum } from '@earendil-works/pi-ai';

// 使用 TypeBox 定义工具参数
const weatherTool: Tool = {
  name: 'get_weather',
  description: '获取某地当前天气',
  parameters: Type.Object({
    location: Type.String({ description: '城市名称或坐标' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// 注意：为兼容 Google API，请使用 StringEnum 辅助工具而非 Type.Enum
// Type.Enum 生成的 anyOf/const 模式不被 Google 支持

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: '安排会议',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### 处理工具调用

工具结果使用内容块，可包含文本和图片：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: '伦敦天气怎么样？', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// 检查响应中的工具调用
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // 使用参数执行你的工具
    // 验证请参见"验证工具参数"部分
    const result = await executeWeatherApi(block.arguments);

    // 添加带文本内容的工具结果
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
    { type: 'text', text: '生成的温度趋势图表' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### 通过部分 JSON 流式传输工具调用

流式传输期间，工具调用参数会随着数据到达逐步解析。这允许在完整参数可用之前进行实时 UI 更新：

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments 包含流式传输期间部分解析的 JSON
    // 这允许进行渐进式 UI 更新
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // 防御性编程：参数可能不完整
      // 示例：在内容完成之前就显示正在写入的文件路径
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`正在写入：${toolCall.arguments.path}`);

        // 内容可能不完整或缺失
        if (toolCall.arguments.content) {
          console.log(`内容预览：${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // 此处 toolCall.arguments 是完整的（但尚未验证）
    const toolCall = event.toolCall;
    console.log(`工具完成：${toolCall.name}`, toolCall.arguments);
  }
}
```

**关于部分工具参数的重要说明：**
- 在 `toolcall_delta` 事件期间，`arguments` 包含对部分 JSON 的最佳尝试解析
- 字段可能缺失或不完整——使用前始终检查是否存在
- 字符串值可能被截断
- 数组可能不完整
- 嵌套对象可能部分填充
- 至少，`arguments` 会是一个空对象 `{}`，绝非 `undefined`
- Google provider 不支持函数调用流式传输。你将收到一个包含完整参数的单个 `toolcall_delta` 事件

### 验证工具参数

在实现自己的工具执行循环时，使用 `validateToolCall` 在将参数传递给工具前进行验证：

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // 根据工具的 schema 验证参数（无效参数会抛出错误）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... 将工具结果添加到上下文中
    } catch (error) {
      // 验证失败——将错误作为工具结果返回，让模型可以重试
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

### 完整事件参考

助手消息生成期间发出的所有流式事件：

| 事件类型 | 描述 | 关键属性 |
|----------|------|---------|
| `start` | 流开始 | `partial`：初始助手消息结构 |
| `text_start` | 文本块开始 | `contentIndex`：在内容数组中的位置 |
| `text_delta` | 收到文本片段 | `delta`：新文本，`contentIndex`：位置 |
| `text_end` | 文本块完成 | `content`：完整文本，`contentIndex`：位置 |
| `thinking_start` | 思考块开始 | `contentIndex`：在内容数组中的位置 |
| `thinking_delta` | 收到思考片段 | `delta`：新文本，`contentIndex`：位置 |
| `thinking_end` | 思考块完成 | `content`：完整思考，`contentIndex`：位置 |
| `toolcall_start` | 工具调用开始 | `contentIndex`：在内容数组中的位置 |
| `toolcall_delta` | 工具参数流式传输 | `delta`：JSON 片段，`partial.content[contentIndex].arguments`：部分解析的参数 |
| `toolcall_end` | 工具调用完成 | `toolCall`：完整验证的工具调用，包含 `id`、`name`、`arguments` |
| `done` | 流完成 | `reason`：停止原因（"stop"、"length"、"toolUse"），`message`：最终助手消息 |
| `error` | 发生错误 | `reason`：错误类型（"error" 或 "aborted"），`error`：带部分内容的 AssistantMessage |

不同内容块的流事件不保证是连续的。Provider 可能在同一个上游分块中交错发出文本、思考和工具调用的 delta，pi 也可能对应地交错呈现事件，例如 `text_start`、`text_delta`、`toolcall_start`、`text_delta`、`toolcall_delta`。使用者必须使用 `contentIndex` 将每个 delta/end 事件与其块关联起来，并且不得假设某个块的 `*_start`/`*_delta`/`*_end` 序列不会被其他块的事件打断。

## 图片输入

支持视觉的模型可以处理图片。你可以通过 `input` 属性检查模型是否支持图片。如果向非视觉模型传入图片，它们将被静默忽略。

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// 检查模型是否支持图片
if (model.input.includes('image')) {
  console.log('模型支持视觉');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '这张图片里有什么？' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// 访问响应
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## 图片生成

图片生成使用与文本/对话生成分离的 API 表面，镜像了对话端的设计：`ImagesModels` 集合持有 `ImagesProvider`，读取是同步的，认证通过所属 provider 解析。图片生成是一次性 API：`generateImages()` 等待 provider 响应并返回最终的 `AssistantImages` 结果——不要使用对话/流 API 进行图片生成。

### 基本图片生成

```typescript
import { builtinImagesModels } from '@earendil-works/pi-ai/providers/all';

// 所有内置图片生成 provider；接受与 createModels() 相同的选项
const imagesModels = builtinImagesModels();

const model = imagesModels.getModel('openrouter', 'google/gemini-2.5-flash-image')!;

// 认证通过 provider 解析（此处为 OPENROUTER_API_KEY）；显式 apiKey 优先
const result = await imagesModels.generateImages(model, {
  input: [{ type: 'text', text: '在纯白背景上生成一个红色圆形。' }]
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

与对话端类似，你可以从部分构建集合：`createImagesModels({ credentials?, authContext? })`、来自 `@earendil-works/pi-ai/providers/openrouter-images` 的 `openrouterImagesProvider()` 工厂函数，以及用于自定义图片 provider 的 `createImagesProvider({ id, auth, models, refreshModels?, api })`（配合 `imagesModels.refresh(provider?)` 支持动态列表）。故障不会抛出——它们返回 `stopReason: "error"` 的 `AssistantImages`。集合的 provider 级别 `getAuth(providerId)` 与对话端完全相同。

旧版全局 API（`getImageModel()` / `getImageModels()` / `getImageProviders()` / `generateImages()`）仍在 [compat 入口点](#从旧版全局-api-迁移)上可用：

```typescript
import { getImageModel, generateImages } from '@earendil-works/pi-ai/compat';

const model = getImageModel('openrouter', 'google/gemini-2.5-flash-image');
const result = await generateImages(model, {
  input: [{ type: 'text', text: '在纯白背景上生成一个红色圆形。' }]
}, {
  apiKey: process.env.OPENROUTER_API_KEY
});
```

某些模型也支持图片输入：

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await imagesModels.generateImages(model, {
  input: [
    { type: 'text', text: '将此图片变体，将背景改为蓝色。' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

检查模型元数据中的能力：

```typescript
console.log(model.input);   // ['text', 'image']
console.log(model.output);  // ['image'] 或 ['image', 'text']
```

### 注意事项与限制

- 图片模型存在于 `ImagesModels` 集合中，对话模型存在于 `Models` 集合中；两者是分离的。
- 使用 `generateImages()`，不要使用对话/流 API。
- 图片生成模型不参与工具调用。
- 输出在 `AssistantImages.output` 中返回，可包含 base64 编码的 `ImageContent` 块和 `TextContent` 块。
- 某些模型仅返回图片，其他返回图片加文本。请检查 `model.output`。
- 某些模型接受图片输入，其他仅为文本到图片。请检查 `model.input`。
- 与流式 API 类似，图片生成支持 `apiKey`、`signal`、`headers`、`onPayload` 和 `onResponse` 等选项，结果可能包含 `stopReason`、`responseId` 和 `usage`。
- 如果你想在对话中让模型分析图片或调用工具，请使用支持图片输入的模型搭配常规对话 API。
- 目前，图片生成仅通过一个 provider（OpenRouter）可用。

## 思考/推理

许多模型支持思考/推理能力，可以展示其内部思考过程。你可以通过 `reasoning` 属性检查模型是否支持推理。如果向非推理模型传入推理选项，它们将被静默忽略。

### 统一接口（streamSimple/completeSimple）

```typescript
// 许多跨 provider 的模型支持思考/推理
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// 或 models.getModel('openai', 'gpt-5-mini');
// 或 models.getModel('google', 'gemini-2.5-flash');
// 或 models.getModel('xai', 'grok-4.5');

// 检查模型是否支持推理
if (model.reasoning) {
  console.log('模型支持推理/思考');
}

// 使用简化的推理选项
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: '解方程：2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// 访问思考和文本块
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('思考：', block.thinking);
  } else if (block.type === 'text') {
    console.log('回答：', block.text);
  }
}
```

`xhigh` 和 `max` 是模型特定的可选级别。使用 `getSupportedThinkingLevels(model)` 确定具体模型是否暴露出任一级别；诸如 GPT-5.6 之类的模型可能两者都暴露。

### Provider 专属选项（stream/complete）

`models.stream()`/`complete()` 接受所属 API 的完整选项集。使用 `hasApi()` 将动态查找的模型窄化到其 API 以获得完整选项类型：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI 推理（o1、o3、gpt-5）
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // 仅 OpenAI Responses API
  });
}

// Anthropic 思考
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // 可选的 token 限制
  });
}

// Google Gemini 思考
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 表示动态，0 表示禁用
    }
  });
}
```

### 流式传输思考内容

流式传输时，思考内容通过特定事件传递：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[模型开始思考]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // 流式传输思考内容
      break;
    case 'thinking_end':
      console.log('\n[思考完成]');
      break;
  }
}
```

## 停止原因

每个 `AssistantMessage` 都包含一个 `stopReason` 字段，指示生成是如何结束的：

- `"stop"` - 正常完成，模型已完成其响应
- `"length"` - 输出达到最大 token 限制
- `"toolUse"` - 模型正在调用工具并期望工具结果
- `"error"` - 生成期间发生错误
- `"aborted"` - 通过中止信号取消了请求

`AssistantMessage` 还可能包含 `responseId`，这是底层 API 暴露的 provider 特定的上游响应或消息标识符。不要假设它在所有 provider 中始终存在。

## 错误处理

请求故障不会从流函数中抛出：当请求以错误结束（包括中止和工具调用验证错误）时，流式 API 会发出 error 事件，最终消息携带详细信息：

```typescript
// 流式传输中
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason 为 "error" 或 "aborted"
    // event.error 是带有部分内容的 AssistantMessage
    console.error(`错误 (${event.reason})：`, event.error.errorMessage);
    console.log('部分内容：', event.error.content);
  }
}

// 最终消息将包含错误详情
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('请求失败：', message.errorMessage);
  // message.content 包含错误前收到的部分内容
  // message.usage 包含部分 token 计数和费用
}
```

认证故障（无密钥配置、OAuth 刷新失败、未知 provider）以相同方式呈现：作为 `stopReason: "error"` 的流错误。

### 中止请求

中止信号允许你取消进行中的请求。已中止请求的 `stopReason === 'aborted'`：

```typescript
const controller = new AbortController();

// 2 秒后中止
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: '写一个长故事', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason 告诉你它是 "error" 还是 "aborted"
    console.log(`${event.reason === 'aborted' ? '已中止' : '错误'}：`, event.error.errorMessage);
  }
}

// 获取结果（如果已中止可能为部分结果）
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('请求已中止：', response.errorMessage);
  console.log('收到的部分内容：', response.content);
  console.log('已使用 token：', response.usage);
}
```

### 中止后继续

已中止的消息可以添加到对话上下文中，并在后续请求中继续：

```typescript
const context = {
  messages: [
    { role: 'user', content: '详细解释量子计算', timestamp: Date.now() }
  ]
};

// 第一次请求 2 秒后被中止
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// 将部分响应添加到上下文中
context.messages.push(partial);
context.messages.push({ role: 'user', content: '请继续', timestamp: Date.now() });

// 继续对话
const continuation = await models.complete(model, context);
```

### 调试 Provider 负载

使用 `onPayload` 回调检查发送给 provider 的请求负载。这对调试请求格式化问题或 provider 验证错误非常有用。

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider 负载：', JSON.stringify(payload, null, 2));
  }
});
```

该回调由 `stream`、`complete`、`streamSimple` 和 `completeSimple` 支持。

## 自定义 Provider

### createProvider()

`createProvider()` 从组成部分构建 provider：标识、认证、模型列表和 API 实现。可用于本地推理服务器、代理或任何 OpenAI/Anthropic 兼容端点：

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
  // 每个 provider 声明认证；无密钥本地服务器解析为已配置无密钥
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

对于有真实密钥的 provider，`envApiKeyAuth(displayName, envVars)` 提供标准行为（存储的凭据优先，然后是第一个已设置的环境变量）：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

混合 API 的 provider 传入按 `model.api` 为键的映射；每个模型分发到其 API 的实现：

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* api 为 'anthropic-messages' 或 'openai-responses' 的模型 */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

Provider 级别的端点或请求转换属于 provider 的 API 实现：包装你作为 `api` 传入的 `ProviderStreams`，使每条请求在分发前经过转换。Cloudflare provider 通过这种方式从解析的 provider 环境中物化账户/网关端点占位符：

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

动态模型列表使用 `fetchModels`。`Models.refresh()` 刷新每个已配置的动态 provider，传入其有效的 API 密钥或已刷新的 OAuth 凭据。`ModelsStore` 持久化动态目录；两个 store 都默认使用内存实现。

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:8080', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('刷新已取消');
for (const [provider, error] of result.errors) console.error(provider, error);
```

使用 `models.refresh({ allowNetwork: false })` 在没有网络访问的情况下恢复持久化目录，或 `models.refresh({ force: true })` 绕过 provider 新鲜度检查。模型读取保持同步，返回最新恢复或刷新的列表。

自定义模型可携带 `headers`（例如有机器人检测的代理后面）和 `compat` 标志。`Models.getAuth(model)` 包含这些模型头，流方法在显式请求头和 `transformHeaders` 之前合并它们。参见 [OpenAI 兼容性设置](#openai-兼容性设置)。

某些 OpenAI 兼容服务器不理解用于推理能力模型的 `developer` 角色。对于这些 provider，将 `compat.supportsDeveloperRole` 设为 `false`，以便系统提示作为 `system` 消息发送。如果服务器也不支持 `reasoning_effort`，将 `compat.supportsReasoningEffort` 也设为 `false`。这通常适用于 Ollama、vLLM、SGLang 和类似的 OpenAI 兼容服务器。

使用模型级 `thinkingLevelMap` 描述模型特定的思考控制。键为 pi 思考级别（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。缺失的标准级别（到 `high` 为止）使用 provider 默认值；`xhigh` 和 `max` 是可选的，需要非空映射条目。字符串值发送给 provider，`null` 表示该级别不受支持，映射可以跳过级别。

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

### 直接调用 API 实现

API 实现可以独立导入。每个模块精确导出 `stream` 和 `streamSimple`，具有该 API 的完整选项类型。直接调用绕过 provider 认证——需显式传入 `apiKey`：

```typescript
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, context, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

内置 API 实现在 `./api/<api-id>` 下：

| API ID | 选项类型 |
|--------|---------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

导入实现模块会加载其 SDK。`./api/<id>.lazy` 包装器（由 provider 工厂使用）将该加载推迟到首次请求，前提是运行时或打包器支持动态 import 分块。旧版本的传统原始 API 子路径（`./anthropic`、`./google`、`./mistral`、`./openai-completions` 等）已被移除；请使用 `@earendil-works/pi-ai/api/<api-id>`。

### OpenAI 兼容性设置

`openai-completions` API 被许多 provider 实现，存在细微差异。默认情况下，库会基于 `baseUrl` 为一小组已知的 OpenAI 兼容 provider（Cerebras、xAI、Chutes、DeepSeek、NVIDIA NIM、Together AI、zAi、OpenCode、Cloudflare Workers AI 等）自动检测兼容性设置。对于自定义代理或未知端点，你可以通过 `compat` 字段覆盖这些设置。对于 `openai-responses` 模型，compat 字段支持 Responses 特定的标志。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // provider 是否支持 `store` 字段（默认：true）
  supportsDeveloperRole?: boolean;   // provider 是否支持 `developer` 角色而非 `system`（默认：true）
  supportsReasoningEffort?: boolean; // provider 是否支持 `reasoning_effort`（默认：true）
  supportsUsageInStreaming?: boolean; // provider 是否支持 `stream_options: { include_usage: true }`（默认：true）
  supportsStrictMode?: boolean;      // provider 是否支持工具定义中的 `strict`（默认：true）
  sendSessionAffinityHeaders?: boolean; // 发送 `sessionId` 的会话亲和性数据（默认：false）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // 会话亲和性格式：'openai' 使用 `prompt_cache_key`、`session_id`、`x-client-request-id` 和 `x-session-affinity`；'openai-nosession' 使用 `prompt_cache_key`、`x-client-request-id` 和 `x-session-affinity`；'openrouter' 使用 `x-session-id`（默认：自动检测）
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // 使用哪个字段名称（默认：max_completion_tokens）
  requiresToolResultName?: boolean;  // 工具结果是否需要 `name` 字段（默认：false）
  requiresAssistantAfterToolResult?: boolean; // 工具结果后是否必须跟随助手消息（默认：false）
  requiresThinkingAsText?: boolean;  // 思考块是否必须转换为文本（默认：false）
  requiresReasoningContentOnAssistantMessages?: boolean; // 启用推理时，所有重放的助手消息是否必须包含空的 reasoning_content（默认：针对 DeepSeek 自动检测）
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // 推理参数格式：'openai' 使用 reasoning_effort，'openrouter' 使用 reasoning: { effort }，'deepseek' 使用 thinking: { type } 并在支持时加上 reasoning_effort，'together' 使用 reasoning: { enabled } 并在支持时加上 reasoning_effort，'zai' 使用 thinking: { type }，'qwen' 使用 enable_thinking，'chat-template' 使用可配置的 chat_template_kwargs，'qwen-chat-template' 使用 chat_template_kwargs.enable_thinking 和 preserve_thinking，'string-thinking' 使用顶层的 thinking，'ant-ling' 仅对已映射的 effort 使用 reasoning: { effort }（默认：openai）
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort'; omitWhenOff?: boolean }>; // chat_template_kwargs 值；使用 $var 表示 pi 控制的思考值
  cacheControlFormat?: 'anthropic';  // 在系统提示、最后一条工具调用以及最后一条用户/助手文本内容上的 Anthropic 风格 cache_control
  openRouterRouting?: OpenRouterRouting; // OpenRouter 路由偏好（默认：{}）
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway 路由偏好（默认：{}）
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // provider 是否支持 `developer` 角色而非 `system`（默认：true）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // 会话亲和性头部格式：'openai' 发送 `session_id` 和 `x-client-request-id`；'openai-nosession' 发送 `x-client-request-id`；'openrouter' 发送 `x-session-id`。不影响 `prompt_cache_key` body 参数（默认：自动检测）
  supportsLongCacheRetention?: boolean; // provider 是否支持 `prompt_cache_retention: "24h"`（默认：true）
}
```

如果未设置 `compat`，库会回退到基于 URL 的检测。如果 `compat` 部分设置，未指定的字段使用检测到的默认值。这对以下情况很有用：

- **LiteLLM 代理**：可能不支持 `store` 字段
- **自定义推理服务器**：可能使用非标准字段名称
- **自托管端点**：可能具有不同的功能支持

## Faux Provider（测试用）

`fauxProvider()` 构建一个带有脚本化响应的内存 provider，用于测试和演示：

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
  messages: [{ role: 'user', content: '总结 package.json 然后调用 echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('需要先检查包元数据。'),
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
  content: [{ type: 'text', text: '这里是 package.json 的内容' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('现在我可以总结工具输出了。'),
    fauxText('这是总结。')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// 可选：多个 faux 模型，用于模型切换测试
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

注意事项：
- 响应按请求开始顺序从队列中消费。
- 如果队列为空，faux provider 返回一个带有 `errorMessage: "No more faux responses queued"` 的助手错误消息。
- 使用 `faux.setResponses([...])` 替换剩余的队列，使用 `faux.appendResponses([...])` 添加更多响应。
- `faux.models` 暴露所有 faux 模型。`faux.getModel()` 返回第一个，`faux.getModel(id)` 返回特定的一个。
- 使用 `fauxAssistantMessage(...)` 构建脚本化的助手回复。使用 `fauxText(...)`、`fauxThinking(...)` 和 `fauxToolCall(...)` 构建内容块，无需手动填充底层字段。
- 用量按大约 1 token 对应 4 个字符估算。当 `sessionId` 存在且 `cacheRetention` 不为 `"none"` 时，提示缓存读写会自动模拟。
- 工具调用参数通过 `toolcall_delta` 分块逐步流式传输。
- 默认情况下，每个流式分块在独立的微任务中发出。设置 `tokensPerSecond` 可按实时速度调整分块发送。
- 预期用途是每个句柄一个确定性脚本流程。如果需要独立的并发流程，请创建具有不同 `provider` ID 的独立 faux provider。

## 跨 Provider 切换

本库支持在同一对话中无缝切换不同 LLM provider。这允许你在对话中途切换模型，同时保留上下文，包括思考块、工具调用和工具结果。

当来自一个 provider 的消息发送到另一个 provider 时，库会自动转换它们以实现兼容：

- **用户和工具结果消息** 原样传递
- **来自相同 provider/API 的助手消息** 原样保留
- **来自不同 provider 的助手消息** 其思考块会被转换为带 `<thinking>` 标签的文本
- **工具调用和普通文本** 原样保留

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

// 从 Claude 开始
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: '25 * 18 等于多少？', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// 切换到 GPT-5——它将看到 Claude 的思考内容作为 <thinking> 标记的文本
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: '那个计算正确吗？', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// 切换到 Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: '原始问题是什么？', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

所有 provider 都可以处理来自其他 provider 的消息——文本、工具调用及其结果（包括图片）、思考块（转换为标记文本），以及带有部分内容的已中止消息。这支持灵活的工作流：从快速模型开始，切换到能力更强的模型进行复杂推理，或在 provider 中断时保持连续性。

## 上下文序列化

`Context` 对象可以使用标准 JSON 方法轻松序列化和反序列化，使得持久化对话、实现聊天历史记录或在不同服务之间传输上下文变得简单：

```typescript
const context: Context = {
  systemPrompt: '你是一个乐于助人的助手。',
  messages: [
    { role: 'user', content: '什么是 TypeScript？', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// 序列化整个上下文
const serialized = JSON.stringify(context);

// 保存到数据库、localStorage、文件等
localStorage.setItem('conversation', serialized);

// 稍后：反序列化并继续对话
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: '告诉我更多关于它的类型系统的信息', timestamp: Date.now() });

// 使用任何模型继续
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

模型也是普通的可序列化数据——没有附加函数或实现——因此持久化"此对话使用的是哪个模型"只需一个 `JSON.stringify`。

> **注意**：如果上下文包含图片（如图片输入部分所示以 base64 编码），这些也将被序列化。

## 浏览器使用

本库支持浏览器环境。核心入口点和 provider 工厂函数没有副作用，可以干净地打包。浏览器中不可用环境变量，因此请显式传入 API 密钥——或注入 `CredentialStore`（例如基于 localStorage），让 provider 认证从存储的凭据中解析：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: '你好！', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **安全警告**：在前端代码中暴露 API 密钥是危险的。任何人都可以获取和滥用你的密钥。仅对内部工具或演示使用此方法。对于生产环境应用，请使用后端代理来保护你的 API 密钥。

浏览器兼容性说明：

- Amazon Bedrock（`bedrock-converse-stream`）在浏览器环境中不受支持。它仍可出现在模型列表中；调用在运行时会失败。
- OAuth 登录流程仅支持 Node。它们通过打包器不透明的导入进行懒加载，因此注册支持 OAuth 的 provider 不会将仅 Node 的代码拉入浏览器打包——只有实际登录时才会。
- 如果你在 Web 应用中需要 Bedrock 或基于 OAuth 的认证，请使用服务器端代理或后端服务。

## 打包与 Tree Shaking

为了获得更小的打包体积，仅导入所需的 provider：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

规则：

- `@earendil-works/pi-ai` 是核心入口点，不导入内置目录、provider 工厂函数或 SDK 实现。
- `@earendil-works/pi-ai/providers/<provider>` 仅导入该 provider 的目录和懒加载 API 包装器。
- `@earendil-works/pi-ai/providers/all` 导入所有内置 provider 工厂函数和所有目录。仅当你需要完整的内置集合时才使用它。
- 配合代码分割，provider SDK 保持在懒加载分块中，在首次请求时加载。
- 不配合代码分割时，打包器将可到达的懒加载 API 实现合并到单一打包中。单 provider 打包仅包含该 provider 的 SDK；`providers/all` 包含所有静态可见的 SDK。Bedrock 是例外：其 AWS SDK 实现通过打包器不透明的仅 Node 导入加载。
- 直接导入 `@earendil-works/pi-ai/api/<api-id>` 会立即加载该 API 实现及其 SDK。

对于新的打包应用，避免使用 `@earendil-works/pi-ai/compat`；它保留了旧的全局 API 并导入了完整的内置目录表面。

对于单文件 Node ESM 打包，某些 SDK 依赖可能内部仍使用动态 CommonJS `require()`。如果你看到诸如 `Dynamic require of "child_process" is not supported` 的错误，请为打包添加 Node `require` 垫片。使用 esbuild 时：

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

这仅适用于 Node 打包；不是浏览器或 Cloudflare Workers 的解决方法。

Bedrock 仅支持 Node。像添加其他 provider 一样添加它：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

在正常的 Node 包使用和代码分割打包中，Bedrock 懒加载其 AWS SDK 实现。对于必须包含 Bedrock 支持的独立单文件打包，请显式注册实现模块：

```typescript
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';

setBedrockProviderModule(bedrockProviderModule);
```

这种显式覆盖会打包 AWS SDK。没有它，Bedrock 的不透明运行时导入期望在运行时能访问该包的 Bedrock 实现文件。

### Provider 级别的环境覆盖

在流选项中传入 `env`，将 provider 配置限定在单次请求范围内。`env` 中的值在 provider 认证和配置（如 Cloudflare 账户 ID、Azure OpenAI 设置、Vertex project/location、Bedrock 设置、`PI_CACHE_RETENTION` 和 `HTTP_PROXY`/`HTTPS_PROXY`）中优先于进程环境变量。

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

当一个进程需要针对不同请求使用不同的 provider 设置，或者当环境变量不应泄漏到 provider 调用中时，使用此功能。

## OAuth Provider

以下 provider 支持 OAuth 认证而非静态 API 密钥：

- **Anthropic**（Claude Pro/Max 订阅）
- **OpenAI Codex**（ChatGPT Plus/Pro 订阅，可访问 GPT-5.x Codex 模型）
- **GitHub Copilot**（Copilot 订阅）

这些 provider 在 `provider.auth.oauth` 上携带一个 `OAuthAuth`，包含三个操作：`login(interaction)` 使用 provider 中立的 `AuthInteraction.prompt()`/`notify()` 协议并返回凭据，`refresh(credential)` 交换刷新 token，`toAuth(credential)` 派生请求认证（GitHub Copilot 的按账户 base URL 由此获取）。刷新是自动的：`models.getAuth(providerId)` 和请求路径在凭据存储锁下刷新过期的 token，因此并发请求和进程无法双重刷新。

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // 持久化 CredentialStore
models.setProvider(anthropicProvider());

// 登录：Models 驱动流程并持久化凭据
await models.login('anthropic', 'oauth', {
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code 提示会竞争本地回调服务器；p.signal 在服务器胜出时中止它们
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? '更多信息'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`打开: ${event.url}`);
    if (event.type === 'device_code') console.log(`代码: ${event.userCode} 于 ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// 此后，请求自动解析并刷新 token
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// 登出
await models.logout('anthropic');
```

### Vertex AI

Vertex AI 模型支持 Google Cloud API 密钥或应用程序默认凭据（ADC）。其 provider 自有的 API 密钥登录流程可以配置任一方式：

- **API 密钥**：设置 `GOOGLE_CLOUD_API_KEY` 或在调用选项中传入 `apiKey`。
- **本地开发（ADC）**：运行 `gcloud auth application-default login`
- **CI/生产环境（ADC）**：将 `GOOGLE_APPLICATION_CREDENTIALS` 设置为指向服务账号 JSON 密钥文件

使用 ADC 时，还需设置 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）和 `GOOGLE_CLOUD_LOCATION`。你也可以在调用选项中传入 `project`/`location`。使用 `GOOGLE_CLOUD_API_KEY` 时，`project` 和 `location` 不是必需的。

```bash
# 本地（使用用户凭据）
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/生产环境（服务账号密钥文件）
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

官方文档：[应用程序默认凭据](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI 登录

最快的认证方式：

```bash
npx @earendil-works/pi-ai login              # 交互式 provider 选择
npx @earendil-works/pi-ai login anthropic    # 登录到特定 provider
npx @earendil-works/pi-ai list               # 列出可用 provider
```

凭据保存到当前目录的 `auth.json`。

### 编程式 OAuth

内置的登录和刷新流程是私有 provider 实现。使用 provider 自有的 `OAuthAuth`，它与 `CredentialStore` 组合，并通过 `Models` 获得锁定的自动刷新。`@earendil-works/pi-ai/oauth` 入口点仅保留 coding-agent 扩展 OAuth 兼容性所需的类型声明。

Provider 说明：

**OpenAI Codex**：需要 ChatGPT Plus 或 Pro 订阅。可访问具有扩展上下文窗口和推理能力的 GPT-5.x Codex 模型。在流选项中提供 `sessionId` 时，库会自动处理基于会话的提示缓存。你可以在流选项中设置 `transport` 为 `"sse"`、`"websocket"` 或 `"auto"` 来选择 Codex Responses 传输方式。使用 WebSocket 并带有 `sessionId` 时，连接按会话复用，在 5 分钟不活跃后过期。

**Azure OpenAI（Responses）**：仅使用 Responses API。设置 `AZURE_OPENAI_API_KEY` 以及 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME`。`AZURE_OPENAI_BASE_URL` 同时支持 `https://<resource>.openai.azure.com` 和 `https://<resource>.cognitiveservices.azure.com`；根端点自动规范化为 `.../openai/v1`。使用 `AZURE_OPENAI_API_VERSION`（默认 `v1`）按需覆盖 API 版本。部署名称默认视为模型 ID，可通过 `azureDeploymentName` 或 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 覆盖，使用逗号分隔的 `model-id=deployment` 对（例如 `gpt-4o-mini=my-deployment,gpt-4o=prod`）。基于部署名称的传统 URL 有意不支持。

**GitHub Copilot**：如果收到 "The requested model is not supported" 错误，请在 VS Code 中手动启用模型：打开 Copilot Chat，点击模型选择器，选择模型（警告图标），然后点击 "Enable"。

## 从旧版全局 API 迁移

旧版本暴露了一个全局 API：根据 `model.api` 分发请求的 `stream()`/`complete()`，通过全局注册表操作的同步 `getModel()`/`getModels()`/`getProviders()` 目录读取，`registerApiProvider()`，`getEnvApiKey()`，以及每个 API 的懒加载流函数。这些接口在 **compat 入口点**上保持不变：

```typescript
// 之前
import { getModel, complete } from '@earendil-works/pi-ai';

// 之后（行为完全一致，仅导入路径变化）
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

Compat 是根入口点的严格超集，因此文件可以批量更换导入路径。它将在未来的版本中移除；请迁移到 `createModels()` + provider 工厂函数：

| 旧版 | 新版 |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` 或来自 `providers/all` 的 `getBuiltinModel()` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` 或 `getBuiltin*` |
| `stream(model, ctx, opts)`（环境密钥注入） | `models.stream(model, ctx, opts)`（provider 认证解析） |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | 来自 `@earendil-works/pi-ai/api/anthropic-messages` 的 `stream`，或集合中的 provider |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |

## 开发

### 添加新的 Provider

添加新的 LLM provider 需要跨多个文件进行更改。分层布局：API 实现在 `src/api/` 中，provider 工厂函数在 `src/providers/` 中，生成的目录在 `src/providers/<id>.models.ts` 中。此检查清单涵盖了所有必要步骤：

#### 1. 核心类型（`src/types.ts`）

- 如果是新的 API，将 API 标识符添加到 `KnownApi`（例如 `"bedrock-converse-stream"`）
- 将 provider 名称添加到 `KnownProvider`（例如 `"amazon-bedrock"`）
- 将选项类型添加到 `ApiOptionsMap`

#### 2. API 实现（`src/api/<api-id>.ts`，仅适用于新 API）

创建一个新的 API 实现文件（例如 `bedrock-converse-stream.ts`），精确导出 `stream` 和 `streamSimple`，以及：

- 一个扩展 `StreamOptions` 的选项接口（例如 `BedrockOptions`）
- 将 `Context` 转换为 provider 格式的消息转换函数
- 如果 provider 支持工具，需进行工具转换
- 响应解析，以发出标准化事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）

添加一个懒加载包装器 `src/api/<api-id>.lazy.ts`（通过 `lazyApi()` 的 `<name>Api()`），使 provider 可以引用实现而无需导入其 SDK。在 `src/index.ts` 中添加任何应通过 `@earendil-works/pi-ai` 保持可用的根级 `export type` 重新导出。

#### 3. 模型生成（`scripts/generate-models.ts`、`scripts/generate-image-models.ts`）

- 添加从 provider 源（例如 models.dev API）获取和解析模型的逻辑
- 通过 `scripts/generate-models.ts` 将对话/工具能力 provider 模型数据映射到标准化的 `Model` 接口；重新生成会发出 `src/providers/<id>.models.ts` 和聚合器
- 通过 `scripts/generate-image-models.ts` 将图片生成 provider 模型数据映射到标准化的 `ImagesModel` 接口
- 处理 provider 特定的差异（定价格式、能力标志、模型 ID 转换）

#### 4. Provider 工厂函数（`src/providers/<id>.ts`）

- `createProvider()` 连接目录 + 认证 + 懒加载 API 包装器
- 认证：标准密钥 provider 使用 `envApiKeyAuth`，环境认证（AWS 配置文件、ADC）使用自定义 `ApiKeyAuth`，存在 OAuth 流程时使用 `lazyOAuth`
- 在 `src/providers/all.ts` 中注册工厂函数
- 如果是新 API：在 `src/compat.ts` 的内置列表中注册，并在 `package.json` 中添加包的子路径导出

#### 5. 测试（`test/`）

创建或更新测试文件以覆盖新的 provider：

- `stream.test.ts` - 基本流式传输和工具使用
- `tokens.test.ts` - Token 用量报告
- `abort.test.ts` - 请求取消
- `empty.test.ts` - 空消息处理
- `context-overflow.test.ts` - 上下文限制错误
- `image-limits.test.ts` - 图片支持（如适用）
- `unicode-surrogate.test.ts` - Unicode 处理
- `tool-call-without-result.test.ts` - 孤立工具调用
- `image-tool-result.test.ts` - 工具结果中的图片
- `total-tokens.test.ts` - Token 计数准确性
- `cross-provider-handoff.test.ts` - 跨 provider 上下文重放
- `providers.test.ts` - Provider 列表和认证解析

对于 `cross-provider-handoff.test.ts`，至少添加一个 provider/模型对。如果 provider 暴露多个模型系列（例如 GPT 和 Claude），每个系列至少添加一对。

对于具有非标准认证的 provider（AWS、Google Vertex），创建一个辅助工具，如 `bedrock-utils.ts`，包含凭据检测辅助函数。

#### 6. Coding Agent 集成（`../coding-agent/`）

更新 `src/core/model-resolver.ts`：

- 在 `DEFAULT_MODELS` 中添加 provider 的默认模型 ID

更新 `src/cli/args.ts`：

- 在帮助文本中添加环境变量文档

更新 `README.md`：

- 将 provider 添加到 provider 部分，附上设置说明

#### 7. 文档

更新 `packages/ai/README.md`：

- 添加到支持的 Provider 表格
- 记录任何 provider 特定的选项或认证要求
- 将环境变量添加到环境变量部分

#### 8. 更新日志

在 `packages/ai/CHANGELOG.md` 的 `## [Unreleased]` 下添加条目：

```markdown
### Added
- 添加了对 [Provider Name] provider 的支持 ([#PR](link) by [@author](link))
```

## 许可证

MIT