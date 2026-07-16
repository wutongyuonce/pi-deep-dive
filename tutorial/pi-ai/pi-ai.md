# [pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai)

整个 pi monorepo **统一的 LLM API 层**，提供可组合的 provider 集合、自动认证解析、Token 与成本统计，以及简单的上下文持久化与会话中途切换模型能力。

本质是：**用一套统一的模型、消息、工具、流式事件协议，屏蔽掉不同 provider (OpenAI / Anthropic 等) 之间的协议差异。**这也是阅读源码时不失真的关键心法。

> 底层对接的协议： [OpenAI - Completions API](https://platform.openai.com/docs/api-reference/chat/create) 、较新的 [OpenAI - Responses API](https://platform.openai.com/docs/api-reference/responses) 、 [Anthropic - Messages API](https://docs.anthropic.com/en/api/messages) 等。注意这些是"被屏蔽"的底层协议，pi-ai 向上暴露的是统一接口。

也就是说，它对上暴露：

- `Models` 集合：运行时管理所有 provider，提供统一的流式/非流式函数 `stream()` / `complete()` / `streamSimple()` / `completeSimple()`
- 每个厂商的 provider 都有独立工厂，可通过子路径导入（如 `@earendil-works/pi-ai/providers/anthropic`），按需注册
- 统一的 `AssistantMessage` 返回消息、`AssistantMessageEventStream` 事件流、TypeBox 工具定义
- 统一的 usage / cost / abort / cache / reasoning / thinking level 抽象

而对下，它按两层分离关注点：

- **API 实现层**（`src/api/*.ts`）：跟具体 HTTP/SDK 打交道，构造 payload、处理 SSE、把增量事件翻译成统一协议
- **Provider 装配层**（`src/providers/*.ts`）：把某个厂商的模型目录 + 认证方式绑定到一套 API 引擎上；同一套引擎（如 `openai-completions`）可被 20+ 个 provider 复用

## 使用示例

你需要**先构建一个由多个 provider 组成的 `Models` 集合**，然后**通过它进行流式调用**。最快的方式是**注册所有内置 provider**；如果应用对 bundle 体积敏感，则应**只注册所需的厂商 provider**（见 [只注册](#特定)）。

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
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

## 整个包的分层图

`packages/ai/src` 可以分成五层：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         对外入口层                                         │
│                                                                         │
│  index.ts       主入口 — 纯类型/工具/核心运行时导出，无副作用                │
│  oauth.ts       OAuth 导出入口                                            │
│  cli.ts         CLI 命令 (npx login / list)                              │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│        第五层：models.ts — 统一 provider / models 运行时框架               │
│                                                                         │
│  ┌─ 文本聊天 ────────────────────┐  ┌─ 图片生成 ────────────────────┐   │
│  │ models.ts                    │  │ images-models.ts              │   │
│  │   createModels()             │  │   createImagesModels()        │   │
│  │   createProvider()           │  │   createImagesProvider()      │   │
│  │    每个请求:                  │  │ images-api-registry.ts        │   │
│  │    ① 解析 auth               │  │ images.ts                     │   │
│  │    ② 合并参数                 │  │   generateImages()            │   │
│  │    ③ 分发给 owning provider  │  │                               │   │
│  │   calculateCost()            │  │                               │   │
│  │   clampThinkingLevel()       │  │                               │   │
│  └──────────────────────────────┘  └───────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            第四层：providers/ — Provider 装配注册层                        │
│                                                                         │
│  all.ts       → builtinProviders() / builtinModels()                     │
│                 builtinImagesProviders() / builtinImagesModels()          │
│  faux.ts      → 测试 Mock Provider (createFauxCore)                      │
│                                                                         │
│  每个 provider 文件做的事：模型目录(.models.ts) + 认证配置 + API 引擎        │
│                                                  └─→ createProvider()    │
│                                                                         │
│  openai.ts           → openai-responses    │ anthropic.ts → anthropic-   │
│  openai-codex.ts     → openai-codex        │               messages      │
│  azure-openai*       → azure-openai        │ kimi-coding  → (同上)       │
│                          -responses        │ minimax      → (同上)       │
│  deepseek.ts         → openai-completions  │ minimax-cn   → (同上)       │
│  openrouter.ts       → openai-completions  │ vercel-ai-   → (同上)       │
│  groq.ts             → openai-completions  │   gateway                   │
│  xai.ts              → openai-completions  │ fireworks    → 多引擎混合   │
│  zai.ts              → openai-completions  │ github-      → 多引擎混合   │
│  together.ts         → openai-completions  │   copilot                 │ 
│  nvidia.ts           → openai-completions  │ opencode     → 多引擎混合   │
│  cerebras.ts         → openai-completions  │ opencode-go  → 多引擎混合   │
│  ...  共 36 个 provider (27 个用 openai-completions 引擎)                │
│                                                                         │
│  images/register-builtins.ts  → openrouter-images (图片)                 │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              第三层：api/ — API 懒加载协议层                                │
│                                                                         │
│  懒加载基座:    lazy.ts          lazyApi() / lazyStream() 核心            │
│               *.lazy.ts         各 API 模块的懒加载包装器                  │
│                                                                         │
│  协议实现:                                                               │
│    openai-completions.ts       OpenAI /v1/chat/completions              │
│    openai-responses.ts         OpenAI /v1/responses                     │
│    anthropic-messages.ts       Anthropic /v1/messages                   │
│                                                                         │
│  共享基座:                                                               │
│    openai-responses-shared.ts  Responses 系列共享：消息/工具转换、流处理    │
│    transform-messages.ts       跨模型消息转换：thinking 降级/ID 归一化等    │
│    google-shared.ts            Google 系列共享：Gemini/Vertex 消息转换     │
│    simple-options.ts           SimpleStreamOptions → ProviderStreamOptions│
│    openai-prompt-cache.ts      OpenAI 缓存 key 处理                       │
│    cloudflare.ts / github-copilot-headers.ts  平台专用头部                 │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        认证与基础设施层                                    │
│                                                                         │
│  ┌─ auth/ 认证子系统 ────────────────────────────────────────────────┐  │
│  │ types.ts          ProviderAuth / CredentialStore / AuthResult     │  │
│  │ resolve.ts        resolveProviderAuth() 统一认证解析               │  │
│  │                   (优先级: 显式覆盖 > 存储凭证 > 环境变量/ADC)       │  │
│  │ credential-store.ts  InMemoryCredentialStore (可注入持久化)         │  │
│  │ helpers.ts        envApiKeyAuth() / lazyOAuth()                   │  │
│  │ context.ts        defaultProviderAuthContext()                    │  │
│  │                                                                   │  │
│  │ OAuth 子系统 (utils/oauth/):                                       │  │
│  │ anthropic.ts / github-copilot.ts / openai-codex.ts                │  │
│  │ device-code.ts / pkce.ts / oauth-page.ts / load.ts                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ env-api-keys.ts 环境变量认证 ─────────────────────────────────────┐   │
│  │ findEnvKeys() / getEnvApiKey()  36 个 provider 的 env var 映射     │   │
│  │ Vertex ADC / AWS Bedrock 多凭证源检测                               │   │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ utils/ 工具层 ──────────────────────────────────────────────────┐   │
│  │ 流式引擎:    event-stream.ts   EventStream<T,R> 泛型 +            │   │
│  │              AssistantMessageEventStream (可迭代 + result())       │  │
│  │ 溢出检测:    overflow.ts       isContextOverflow()                 │   │
│  │              60+ 正则覆盖 20+ provider                             │   │
│  │ 重试:        retry.ts          isRetryableAssistantError()         │  │
│  │              30+ 瞬态错误模式                                       │  │
│  │ 校验:        validation.ts     validateToolCall()                  │  │
│  │ Token:       estimate.ts       estimateContextTokens()            │  │
│  │ 其他:        json-parse.ts / hash.ts / sanitize-unicode.ts /       │  │
│  │              abort-signals.ts / deferred-tools.ts 等               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  session-resources.ts  会话资源生命周期管理                                │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            第二层：模型信息生成层 (scripts/)                                 │
│                                                                         │
│  scripts/generate-models.ts        模型信息生成脚本 (构建时运行)            │
│    → 从 models.dev / OpenRouter / AI Gateway 等源拉取模型数据             │
│    → 补项目专属兼容元数据 (thinkingLevelMap / compat 等)                   │
│                                                                         │
│  scripts/generate-image-models.ts  图片模型生成脚本                        │
│                                                                         │
│  产物 (提交到 git):                                                       │
│    models.generated.ts       36 个 provider 的静态模型合集                 │
│    image-models.generated.ts 图片模型目录                                 │
│    providers/*.models.ts     各 provider 的独立模型定义                   │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              第一层：核心类型层 types.ts                                    │
│                                                                         │
│  全包核心类型定义 — 所有其他文件的基础                                      │
│                                                                         │
│  模型:      Model / ImagesModel / ModelCostRates / ModelThinkingLevel    │
│  协议:      Api / KnownApi / ImagesApi / ProviderStreams                 │
│  消息:      Message / AssistantMessage / ToolCall / ToolResultMessage    │
│  事件:      AssistantMessageEvent (start / text_* / thinking_* /        │
│             toolcall_* / done / error)                                  │
│  上下文:    Context / ImagesContext                                       │
│  工具:      Tool<TParameters>  TypeBox schema 绑定                       │
│  选项:      StreamOptions / SimpleStreamOptions / ProviderStreamOptions  │
└─────────────────────────────────────────────────────────────────────────┘
```

### `src/`

| 文件                      | 定位                 | 核心功能 / 关键导出                                          | 主要被谁调用                                               | 它主要调用谁                           |
| ------------------------- | -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------- |
| index.ts                  | 包公共入口           | 统一 re-export 类型、工具、auth、models 等无副作用模块       | `packages/agent`、`packages/coding-agent`、外部 npm 使用者 | `models.ts`、`types.ts`、`auth/`、`utils/` |
| types.ts                  | 核心协议文件         | `Model`、`Context`、`AssistantMessage`、`AssistantMessageEvent`、`StreamOptions` | 几乎所有源码文件                                           | 无运行时调用                           |
| models.ts                 | **运行时核心**         | `createModels()`、`createProvider()`、`Models`/`Provider` 接口、成本/thinking 工具 | `providers/all.ts`、各 provider 工厂、上层调用方     | `api/lazy.ts`、`auth/resolve.ts`   |
| images-models.ts          | 图片侧运行时核心       | `createImagesModels()`、`createImagesProvider()`                       | `providers/all.ts`、上层调用方                       | `images-api-registry.ts`           |
| images.ts                 | 图片生成统一入口       | `generateImages()`                                                    | 外部调用者                                          | `images-api-registry.ts`           |
| images-api-registry.ts    | 图片 provider 注册表 | `registerImagesApiProvider`、`getImagesApiProvider`          | `images.ts`、图片 provider 注册层                          | 包装图片 provider                      |
| image-models.ts           | 图片模型查询层       | `getImageModel`、`getImageModels`、`getImageProviders`       | 外部调用者                                                 | `image-models.generated.ts`            |
| models.generated.ts       | 生成产物             | 文本模型元信息常量 `MODELS`（35 个 provider 合集）              | `providers/all.ts`                                        | 无                                     |
| image-models.generated.ts | 生成产物             | 图片模型元信息常量 `IMAGE_MODELS`                            | `image-models.ts`                                          | 无                                     |
| env-api-keys.ts           | 认证发现层           | `findEnvKeys`、`getEnvApiKey`                                | provider、外部调用者                                       | Node/Bun 环境变量 / ADC / AWS 凭证 |
| session-resources.ts      | 会话资源清理注册表   | `registerSessionResourceCleanup`、`cleanupSessionResources`  | 需要维护 session 资源的 provider                           | cleanup 回调集合                   |
| oauth.ts                  | OAuth 导出入口       | re-export `utils/oauth/` 的全部 OAuth 能力（登录、刷新、凭据管理） | 需要 OAuth 登录的外部调用者                                | `utils/oauth/index.ts`                |

#### `auth/` 认证与凭证管理层

`auth/` 负责 provider 认证的解析和凭证存储，是 `models.ts` 中 `applyAuth()` 的底盘。

核心文件：



- resolve.ts — 统一解析：锁、过期检查、刷新、env fallback 全自动
- helpers.ts — envApiKeyAuth() 工厂（30+ provider 在用）
- credential-store.ts — 默认 InMemoryCredentialStore

| 文件                | 定位                   | 核心功能 / 关键导出                                | 主要被谁调用               |
| ------------------- | ---------------------- | -------------------------------------------------- | -------------------------- |
| types.ts            | 认证类型定义           | `CredentialStore`、`ApiKeyCredential`、`OAuthCredential`、`Credential`、`ApiKeyAuth`、`OAuthAuth`、`ProviderAuth` | `models.ts`、各 provider   |
| resolve.ts          | 认证解析核心           | `resolveProviderAuth()`、`ModelsError`             | `models.ts` 的 `applyAuth()` |
| credential-store.ts | 凭证存储               | `InMemoryCredentialStore`（默认内存实现）          | `models.ts`、外部登录流程  |
| context.ts          | 认证上下文             | `defaultProviderAuthContext()`（跨平台 env/fileExists） | `resolve.ts`               |
| helpers.ts          | 认证辅助工厂           | `envApiKeyAuth()`、`oauthAuth()` 等工厂函数        | 各 provider 定义           |

#### `providers/` Provider 装配层

**Provider 是"薄封装"**：每个文件拿一组模型目录 + 一套认证方式 + 一套 API 引擎，通过 `createProvider()` 装配成统一 Provider。同一套引擎可被多个 provider 复用。内置 provider 共 35 个。

| 文件                            | 定位                                   | 核心导出                 | 绑定的 API 引擎            |
| ------------------------------- | -------------------------------------- | ------------------------ | -------------------------- |
| all.ts                          | 所有内置 provider 的汇总装配           | `builtinModels()` 等     | 各 provider 工厂            |
| anthropic.ts                    | Anthropic（Claude 系列）provider 装配  | `anthropicProvider()`    | `anthropic-messages`       |
| openai.ts                       | OpenAI provider 装配                   | `openaiProvider()`       | `openai-responses`         |
| deepseek.ts                     | DeepSeek provider 装配                 | `deepseekProvider()`     | `openai-completions`       |
| google.ts / google-vertex.ts    | Google Gemini 系列                     | `googleProvider()` 等    | `google-generative-ai` / `google-vertex` |
| ...                             | kimi-coding / minimax 系列 / mistral / moonshotai 系列 / xai / xiaomi 系列 / zai 系列 等 | `xxxProvider()`          | 对应 API 引擎              |
| faux.ts                         | 测试 / Mock provider                   | `createFauxCore()`       | 自定义 fake 实现            |
| images/register-builtins.ts     | 内置图片 API provider 注册             | ---                      | `openrouter-images`        |
| openrouter-images.ts            | OpenRouter 图片生成 provider           | `openrouterImagesProvider()` | `openrouter-images`     |

> 关键洞察：`openai-completions.ts` 这一套 API 引擎驱动了 deepseek、openrouter、groq、xai、zai 等 20+ 个 provider，它们只换模型目录和 baseUrl。

#### `utils/`

`utils/` 是整个包最底层的基础设施层。其中最关键的是 event-stream.ts，它是整个流式协议的底座。它解释了为什么：

- provider 可以立刻返回一个流对象
- 调用者可以 `for await`
- 调用者又可以 `await result()`

| 文件                | 定位               | 核心功能 / 关键方法                          | 主要被谁调用                   |
| ------------------- | ------------------ | -------------------------------------------- | ------------------------------ |
| event-stream.ts     | 流式事件引擎       | `EventStream`、`AssistantMessageEventStream` | 所有文本 provider              |
| diagnostics.ts      | 诊断结构辅助       | `AssistantMessageDiagnostic` 及相关帮助方法  | provider、错误恢复逻辑         |
| headers.ts          | HTTP 头规范化      | `headersToRecord` 等                         | provider 的 `onResponse`       |
| json-parse.ts       | 流式 JSON 容错解析 | `parseStreamingJson`                         | tool call 流式参数解析         |
| hash.ts             | 短哈希工具         | `shortHash`                                  | tool call id 规范化、cache key |
| sanitize-unicode.ts | Unicode 清洗       | `sanitizeSurrogates`                         | 多数 provider                  |
| validation.ts       | 工具参数校验       | `validateToolCall` 等                        | 外部调用者、agent loop         |
| typebox-helpers.ts  | TypeBox 语法辅助   | `StringEnum` 等                              | 外部调用者、tool schema        |
| overflow.ts         | 上下文溢出辅助     | 溢出检测 / 相关错误处理                      | provider、上层逻辑             |
| retry.ts            | 可重试错误分类     | `isRetryableAssistantError`                  | agent loop 错误恢复            |
| estimate.ts         | 上下文用量估算     | `estimateContextTokens`、`estimateMessageTokens` | agent loop、上下文压缩逻辑    |
| error-body.ts       | 错误体标准化       | `normalizeProviderError`、`formatProviderError` | provider API 实现层            |
| abort-signals.ts    | AbortSignal 组合   | `combineAbortSignals`                        | provider stream 创建           |
| deferred-tools.ts   | 延迟工具加载       | `splitDeferredTools`                         | agent loop 运行时              |
| provider-env.ts     | Provider 环境解析  | `getProviderEnvValue`（含 Bun sandbox 兜底） | `node-http-proxy.ts`、auth 层  |
| node-http-proxy.ts  | HTTP 代理解析      | `resolveHttpProxyUrlForTarget`               | provider HTTP 请求层           |

typebox-helpers.ts 帮你写 schema， validation.ts 用 schema 校验参数。

##### `utils/oauth/` OAuth 登录与 Token 管理

处理 Anthropic、GitHub Copilot 等 OAuth 类型 provider 的登录、token 刷新和凭据存储。

| 文件              | 定位              | 核心导出                                        |
| ----------------- | ----------------- | ----------------------------------------------- |
| index.ts          | OAuth 模块入口    | re-export 全部 OAuth 能力                       |
| types.ts          | OAuth 类型定义    | `OAuthCredentials`、`OAuthProviderInterface` 等  |
| device-code.ts    | 设备码流程        | `startDeviceCodeFlow`                           |
| pkce.ts           | PKCE 辅助         | `generatePKCECodeVerifier`、`computePKCECodeChallenge` |
| load.ts           | 凭据加载/保存     | `loadOAuthCredentials`、`saveOAuthCredentials`   |
| oauth-page.ts     | OAuth 登录页面    | 浏览器端 OAuth 回调处理                         |
| anthropic.ts      | Anthropic OAuth   | `loginAnthropic`、`refreshAnthropicToken`       |
| github-copilot.ts | GitHub Copilot OAuth | `loginGitHubCopilot`、`refreshGitHubCopilotToken` |
| openai-codex.ts   | OpenAI Codex OAuth| 登录和 token 刷新                               |

### `scripts/` 

`scripts/` 不是运行时核心逻辑，但它对模型系统至关重要。

| 文件                     | 定位                   | 功能                                                 |
| ------------------------ | ---------------------- | ---------------------------------------------------- |
| generate-models.ts       | 文本模型元信息生成脚本 | 拉取 provider/model 数据，生成 `models.generated.ts` |
| generate-image-models.ts | 图片模型元信息生成脚本 | 生成 `image-models.generated.ts`                     |
| generate-test-image.ts   | 测试资源脚本           | 生成测试用图片资源                                   |

## 主调用链

generate-models.ts 先生成 anthropic.models.ts

 -> anthropic.ts 把它和 API 实现绑定成一个 Provider 

-> all.ts 把所有 provider 收集起来 

-> models.ts 在运行时按模型分发请求 

-> Anthropic 请求最终落到 api 层的 anthropic-messages.lazy.ts 和 anthropic-messages.ts

构建期：运行 generate-models.ts，生成 providers/anthropic.models.ts 等（anthropic.ts 把它和 API 实现绑定成一个 Provider）和 models.generated.ts

应用启动时：

- all.ts 调 builtinModels()
- builtinModels() 调 anthropicProvider()
- anthropic.ts 用 ANTHROPIC_MODELS + anthropicMessagesApi() 创建 provider
- models.ts / models.ts:L335-L393 把 provider 纳入统一运行时

请求执行时：

- Models.stream(model, context, options) 在 models.ts:L274-L285 找到 Anthropic provider
- provider 调 anthropicMessagesApi()
- anthropic-messages.lazy.ts 懒加载 anthropic-messages.ts
- anthropic-messages.ts 真正发请求并返回事件流

```
调用方
  -> builtinModels() / createModels()
  -> models.getModel(...)
  -> models.stream(...) / models.complete(...)
  -> Models.applyAuth()
  -> 找到 owning provider
  -> provider.stream(...)
  -> lazy API wrapper
  -> api/<protocol>.ts
  -> AssistantMessageEventStream
```

这里有三个关键转折点：

1. `Models` 先做 auth 解析和请求参数合并
2. `Provider` 再决定自己用哪套 API 实现
3. `api/*` 最终负责真正的协议请求和事件翻译

// 一个注册了全部内置 provider 的 Models 集合
const models = builtinModels();

// 在集合中同步查找模型
const model = models.getModel('openai', 'gpt-4o-mini')!;

### 文本流式请求主链

```
外部调用:
  models.stream(model, context, options)

运行时层 (models.ts):
  ModelsImpl.stream()
    -> requireProvider(model)        // 找到所属 provider
    -> applyAuth(model, options)      // 解析认证 + 合并参数
    -> provider.stream(model, ...)    // 分发给具体 provider

provider 层 (src/providers/*.ts):
  createProvider() 内封装的 stream
    -> apiFor(model)                  // 根据 model.api 找到 API 引擎
    -> dispatch → streams.stream()

API 懒加载层 (src/api/*.lazy.ts):
  lazyApi() / lazyStream()
    -> 首次请求时动态 import 真实 API 模块

API 实现层 (src/api/openai-responses.ts 等):
  -> createClient()
  -> buildParams()                    // 构造 HTTP payload
  -> SDK 发请求 → SSE 流
  -> processResponsesStream()         // SDK 事件 → AssistantMessageEvent

共享翻译层 (src/api/openai-responses-shared.ts 等):
  -> SDK 事件 → AssistantMessageEvent
  -> 最终组装 AssistantMessage

返回上游:
  AssistantMessageEventStream
    -> for await 消费增量
    -> result() 拿最终消息
```

### 非流式文本请求主链

```text
completeSimple()
  -> streamSimple()
  -> provider 流式实现
  -> await stream.result()
```

也就是说，`complete()` / `completeSimple()` 并不是另一套 provider 实现，而是**复用流式链路**，只是不消费中间事件。

### 图片生成主链

```
generateImages(model, context, options)
  -> src/images.ts
    -> resolveImagesApiProvider(model.api)
  -> src/images-api-registry.ts
    -> getImagesApiProvider(api)
  -> src/providers/images/register-builtins.ts
    -> 注册内置图片 API provider
  -> src/api/openrouter-images.ts  (图片 API 实现)
  -> AssistantImages
```

图片 API 和文本 API 结构是平行的，两者共享的是：

- 模型元信息设计
- options 设计
- usage/cost 设计
- 注册表模式

只是简化了：

- 不需要 `EventStream`
- 不需要 `AssistantMessageEvent`
- 不需要 tool call

## 阅读建议

1. 先读协议层
   - types.ts

2. 再读运行时核心层
   - models.ts（`Models`、`Provider` 接口 + `createModels`、`createProvider`）
   - api/lazy.ts（`lazyApi`、`lazyStream` 懒加载机制）

3. 再读流式基础设施
   - event-stream.ts

4. 精读一个 API 实现样板
   - api/openai-responses.ts
   - api/openai-responses-shared.ts

5. 然后看一个 provider 装配样板
   - providers/anthropic.ts
   - providers/openai.ts

6. 最后看总装配层
   - providers/all.ts（`builtinModels()` / `builtinProviders()`）

7. 横向看其它 API 和 provider 差异

## 一、核心类型层 `types.ts`

### 1、API / ImagesApi / Provider / ImagesProvider / Thinking推理级别相关 / 统一 options — 协议标识与请求配置

#### API 协议标识

```typescript
/**
 * 内置文本 provider 的 API 协议名。
 * 这些值对应注册表里的 key，也对应 `model.api` 字段。
 */
export type KnownApi = "openai-completions" | "openai-responses" | "anthropic-messages";

/**
 * API 协议的完整类型 = 内置值 + 任意自定义字符串。
 * 使用 `(string & {})` 技巧：保留自动补全能力，同时允许外部扩展方注册自己的 provider。
 */
export type Api = KnownApi | (string & {});

/** 内置图片生成 provider 的 API 协议名。 */
export type KnownImagesApi = "openrouter-images";

/** 图片 API 协议的完整类型，同样允许自定义扩展。 */
export type ImagesApi = KnownImagesApi | (string & {});
```

#### Provider 服务商标识

注意：这里的 Provider 是**服务商名称**，只是用来自动补全，不涉及代码实现。

```typescript
/** Provider 表示服务提供商（公司），而不是具体 API 协议。 */
export type KnownProvider = "anthropic" | "openai";
export type Provider = KnownProvider | string;

/** 内置图片生成服务商标识。 */
export type KnownImagesProvider = "openrouter";
export type ImagesProvider = KnownImagesProvider | string;

// 用在 Model 上
{
 provider: "deepseek",  // ← 只是一个名字，不包含任何实现
 api: "openai-completions",
}
```

api-registry.ts 中的 RegisteredApiProvider 才是**真正的 API 协议实现**，是一个包含实际 stream 函数的对象。

#### Thinking 推理级别

```typescript
/**
 * `pi-ai` 对外提供的统一推理档位。
 * provider 内部再通过 `thinkingLevelMap` 把这些档位映射成自己的具体字段。
 *
 * - "minimal"：最低推理开销
 * - "low" / "medium" / "high"：逐步增加推理深度
 * - "xhigh" / "max"：仅部分模型系列支持
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 包含 "off" 的完整推理级别。
 * "off" 表示关闭推理/思考功能。
 */
export type ModelThinkingLevel = "off" | ThinkingLevel;

/**
 * 推理级别映射表。
 * 把 pi-ai 的统一档位映射到 provider/model 特定的值。
 * - 缺少的 key 使用 provider 默认值
 * - null 标记该级别不被支持
 */
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

/** 各推理级别的 token 预算（仅适用于 token-based provider）。 */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}
```

#### 传输方式与缓存策略

```typescript
/**
 * 所有文本 provider 共享的基础缓存策略。
 * - "none"：不缓存
 * - "short"：短期缓存（默认）
 * - "long"：长期缓存
 */
export type CacheRetention = "none" | "short" | "long";

/**
 * 传输方式偏好。
 * 某些 provider 同时支持多种传输方式（如 SSE / WebSocket）。
 * 调用方可以表达偏好，具体 provider 决定是否支持。
 */
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
```

#### 统一请求选项

```typescript
/**
 * 所有文本 provider 共享的基础请求选项。
 *
 * 设计目标：
 * - 给 `stream()` / `complete()` 一套尽量统一的参数面
 * - 把 provider 特有参数留给各自的 `XxxOptions`（如 AnthropicOptions）
 *
 * 调用链：
 * - 上层应用 / agent 先构造 `StreamOptions`
 * - `stream.ts` 原样转给 provider
 * - provider 再把这些统一字段映射到 SDK / HTTP 请求参数
 */
export interface StreamOptions {
	/** 采样温度，控制输出随机性。 */
	temperature?: number;
	/** 最大输出 token 数。 */
	maxTokens?: number;
	/** 用于取消请求的 AbortSignal。 */
	signal?: AbortSignal;
	/** API 密钥，优先级高于环境变量。 */
	apiKey?: string;
	/** 传输方式偏好，不支持的 provider 会忽略此选项。 */
	transport?: Transport;
	/** Prompt 缓存保留策略，默认 "short"。 */
	cacheRetention?: CacheRetention;
	/**
	 * 可选的会话标识符，支持会话级缓存的 provider 可用于 prompt caching、
	 * 请求路由等。不支持的 provider 会忽略。
	 */
	sessionId?: string;
	/**
	 * 发送前检查或替换 payload 的回调。
	 * 返回 undefined 保持 payload 不变。
	 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/** 收到 HTTP 响应后、消费 body 流之前的回调。 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/** 自定义 HTTP headers，与 provider 默认值合并，可覆盖。 */
	headers?: Record<string, string>;
	/** HTTP 请求超时（毫秒）。例如 OpenAI / Anthropic SDK 默认 10 分钟。 */
	timeoutMs?: number;
	/** 客户端最大重试次数。例如 OpenAI / Anthropic SDK 默认 2 次。 */
	maxRetries?: number;
	/**
	 * 服务器请求长等待时的最大重试延迟（毫秒）。
	 * 如果服务器请求的延迟超过此值，立即失败并报错，让上层重试逻辑处理。
	 * 默认 60000（60 秒），设为 0 禁用上限。
	 */
	maxRetryDelayMs?: number;
	/**
	 * 可选的请求元数据。Provider 只提取自己理解的字段。
	 * 例如 Anthropic 使用 `user_id` 进行滥用追踪和限流。
	 */
	metadata?: Record<string, unknown>;
}

/**
 * Provider 级完整 options。
 * 在统一的 StreamOptions 基础上允许附加任意字段，给各 provider 自己扩展。
 */
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * 图片生成/编辑接口的统一 options。
 * 与文本版本结构基本对称，去掉了文本特有的字段（如 temperature、cacheRetention）。
 */
export interface ImagesOptions {
	signal?: AbortSignal;
	apiKey?: string;
	/** 发送前检查或替换 payload 的回调。 */
	onPayload?: (payload: unknown, model: ImagesModel<ImagesApi>) => unknown | undefined | Promise<unknown | undefined>;
	/** 收到 HTTP 响应后的回调。 */
	onResponse?: (response: ProviderResponse, model: ImagesModel<ImagesApi>) => void | Promise<void>;
	/** 自定义 HTTP headers。 */
	headers?: Record<string, string>;
	/** HTTP 请求超时（毫秒）。 */
	timeoutMs?: number;
	/** 客户端最大重试次数。 */
	maxRetries?: number;
	/** 最大重试延迟（毫秒）。 */
	maxRetryDelayMs?: number;
	/** 可选的请求元数据。 */
	metadata?: Record<string, unknown>;
}

/** Provider 级图片 options，在 ImagesOptions 基础上允许任意扩展字段。 */
export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

/**
 * 简化入口使用的统一 options。
 *
 * 与 `StreamOptions` 的区别：
 * - `StreamOptions` 更偏 provider 底层
 * - `SimpleStreamOptions` 更偏"上层统一抽象"，增加了 reasoning / thinkingBudgets
 *
 * `packages/agent` 和 `packages/coding-agent` 更常走这条参数面。
 */
export interface SimpleStreamOptions extends StreamOptions {
	/** 推理级别，provider 内部映射为具体字段。 */
	reasoning?: ThinkingLevel;
	/** 各推理级别的 token 预算（仅 token-based provider）。 */
	thinkingBudgets?: ThinkingBudgets;
}
```

* `StreamOptions`：所有文本 provider 共享的基础请求选项。
* `SimpleStreamOptions extends StreamOptions`：简化入口使用的统一 options，更偏"上层统一抽象"，增加了 reasoning / thinkingBudgets
* `ProviderStreamOptions = StreamOptions & Record<string, unknown>`：Provider 级完整 options，在统一的 StreamOptions 基础上允许附加任意字段，给各 provider 自己扩展

`onPayload` 和 `onResponse` 函数是一对：

* `onPayload` 在 provider 构造好请求体、发送给 API 之前 触发，让你可以拦截或修改请求参数。

  ```typescript
  const stream = streamSimple(model, context, {
    onPayload: (payload, model) => {
      // 场景 1：调试 —— 打印实际发给 API 的完整请求体
      console.log("Sending to", model.provider, JSON.stringify(payload, null, 2));
  
      // 场景 2：强制覆盖参数 —— 比如把 temperature 锁死为 0
      const p = payload as any;
      p.temperature = 0;
  
      // 返回修改后的 payload（或返回 undefined 表示不修改）
      return p;
    },
  });
  ```

* `onResponse` 在 provider 则是在收到 HTTP 响应后、开始读取 SSE 流之前触发。

  ```typescript
  const stream = streamSimple(model, context, {
    // onResponse 会在拿到 HTTP 响应头时立刻被调用
    onResponse: (response, model) => {
      // response 就是 ProviderResponse 类型：{ status, headers }
  
      // 场景 1：监控/日志 —— 记录每次请求的响应状态
      console.log(`[${model.provider}] HTTP ${response.status}`);
  
      // 场景 2：检测限流 —— OpenAI 返回 429 时 headers 里有 retry-after
      if (response.status === 429) {
        const retryAfter = response.headers["retry-after"];
        console.warn(`Rate limited, retry after ${retryAfter}s`);
      }
  
      // 场景 3：调试 —— 查看请求 ID 用于联系 API 支持
      const requestId = response.headers["x-request-id"];
      if (requestId) {
        console.log(`Request ID for support: ${requestId}`);
      }
    },
  });
  ```

  * `ProviderResponse` 是 `onResponse` 回调的参数类型。 

### 2、Message / Content / Tool / Usage — 会话数据结构

#### 三种 Message 消息类型（User/Assistant/ToolResult）

```typescript
/** 用户消息。 */
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** Unix 时间戳（毫秒）。 */
	timestamp: number;
}

/**
 * Assistant 的最终消息结构。
 *
 * 这是 `pi-ai` 最核心的数据对象之一：
 * - provider 在流式过程中逐步构造它
 * - `AssistantMessageEvent.partial` 指向的是它的"进行中版本"
 * - `done.message` / `error.error` 最终收敛到它
 * - `packages/agent` 的 transcript 里也会保存它
 */
export interface AssistantMessage {
    /** 固定值。与 `UserMessage`（`role: "user"`）和 `ToolResultMessage`（`role: "toolResult"`）一起构成三种消息类型，用于对话历史的类型区分。 */
	role: "assistant";
    /** 内容数组。一次响应可以包含多种类型的内容块：纯文本（`TextContent`）、思考过程（`ThinkingContent`）、工具调用（`ToolCall`）。数组的顺序对应模型输出的顺序。 */
	content: (TextContent | ThinkingContent | ToolCall)[];
	/** 使用的 API 协议名。 */
	api: Api;
	/** 服务提供商名。 */
	provider: Provider;
	/** 实际使用的模型名称。 */
	model: string;
	/** 实际响应的模型 ID（当与请求的 model 不同时出现）。 */
	responseModel?: string;
	/** Provider 特定的响应/消息标识符。 */
	responseId?: string;
	/** 经过脱敏的 provider/运行时诊断信息，用于故障和恢复分析。 */
	diagnostics?: AssistantMessageDiagnostic[];
	/** token 使用统计。 */
	usage: Usage;
	/** 停止原因。 */
	stopReason: StopReason;
	/** 错误消息（仅在 stopReason 为 "error" 或 "aborted" 时存在）。 */
	errorMessage?: string;
	/** Unix 时间戳（毫秒）。 */
	timestamp: number;
}

/**
 * 工具执行结果消息。
 * 供"工具 -> 模型"回灌上下文使用，告诉模型工具调用的结果。
 */
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	/** 对应的工具调用 ID。 */
	toolCallId: string;
	/** 工具名称。 */
	toolName: string;
	/** 结果内容，支持文本和图片。 */
	content: (TextContent | ImageContent)[];
	/** 任意结构化详情（供日志或 UI 使用）。 */
	details?: TDetails;
	/** 是否为错误结果。 */
	isError: boolean;
	/** Unix 时间戳（毫秒）。 */
	timestamp: number;
}
```

#### `content` 内容块

```typescript
/**
 * 文本签名 V1 格式。
 * 目前主要用于某些 provider（如 OpenAI Responses）的文本块元数据回放。
 */
export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

/**
 * 基础文本块。
 * assistant / user / tool result 的 content 中最常见的内容类型。
 */
export interface TextContent {
	type: "text";
	text: string;
	/**
	 * 文本签名，用于 OpenAI Responses 的消息元数据。
	 * 可以是旧版 id 字符串或 TextSignatureV1 JSON。
	 */
	textSignature?: string;
}

/**
 * 思考/推理块。
 * 这类块通常不会直接显示给终端用户，但在多 provider handoff 和上下文回放时很重要。
 */
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/** 思考签名，例如 OpenAI Responses 的 reasoning item ID。 */
	thinkingSignature?: string;
	/**
	 * 当为 true 时，思考内容被安全过滤器脱敏。
	 * 不透明的加密载荷存储在 `thinkingSignature` 中，
	 * 可以回传给 API 以保持多轮对话连续性。
	 */
	redacted?: boolean;
}

/**
 * 图片块，统一使用 base64 + MIME 类型。
 */
export interface ImageContent {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // 如 "image/jpeg"、"image/png"
}

/**
 * 统一工具调用块。
 *
 * 设计意义：
 * - 不同 provider 对 tool call 的原生表示不同（OpenAI、Anthropic 各有格式）
 * - `pi-ai` 统一把它们落成一个 `toolCall` 块，方便上层 agent 执行
 */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	/** Google 特有：不透明签名，用于复用思考上下文。 */
	thoughtSignature?: string;
}
```

#### `usage` 计费

```typescript
/**
 * 统一 usage / 计费结构。
 * provider 会把自己的 token 统计和价格规则转换成这里的结构。
 */
export interface Usage {
	/** 输入 token 数。 */
	input: number;
	/** 输出 token 数。 */
	output: number;
	/** 缓存读取 token 数。 */
	cacheRead: number;
	/** 缓存写入 token 数。 */
	cacheWrite: number;
	/** 总 token 数。 */
	totalTokens: number;
	/** 费用明细（单位：美元）。 */
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}
```

`Usage` 同时记录 token 数量和费用。`cacheRead` 和 `cacheWrite` 是 prompt caching 相关的统计 — 不是所有 provider 都支持，不支持的填 0。`cost` 嵌套对象把 token 数量按各 provider 的价格转换成了美元金额，让上层不需要知道定价细节。

#### `stopReason` 停止原因

```typescript
/**
 * 统一表达 assistant 响应是如何结束的。
 * - "stop"：正常结束
 * - "length"：达到最大 token 限制
 * - "toolUse"：请求工具调用
 * - "error"：发生错误
 * - "aborted"：被中止
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

#### `Tool` 工具定义

```typescript
/**
 * 工具定义：名字、描述、参数 schema。
 * `parameters` 使用 TypeBox schema，provider 会再把它翻译成各自的工具声明格式。
 */
export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}
```

#### `Context` 请求上下文

```typescript
/**
 * 文本模型请求上下文：system prompt + 历史消息 + 可用工具。
 * 这是传给 `stream()` / `streamSimple()` 的核心参数。
 */
export interface Context {
	/** 系统提示词。 */
	systemPrompt?: string;
	/** 历史消息列表。 */
	messages: Message[];
	/** 可用工具列表。 */
	tools?: Tool[];
}
```

#### 图片相关的会话数据结构

```typescript
/** 图片接口的输入内容类型。 */
export type ImagesInputContent = TextContent | ImageContent;
/** 图片接口的输出内容类型。 */
export type ImagesOutputContent = TextContent | ImageContent;

/**
 * 图片模型的输入上下文。
 * 比对话模型更简单，直接是一组输入块。
 */
export interface ImagesContext {
	input: ImagesInputContent[];
}

/** 图片接口的停止原因。 */
export type ImagesStopReason = "stop" | "error" | "aborted";

/**
 * 图片接口的最终返回结果。
 * 结构上与 AssistantMessage 对称，但更简单（没有 thinking、toolCall 等）。
 */
export interface AssistantImages {
	api: ImagesApi;
	provider: ImagesProvider;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	/** Unix 时间戳（毫秒）。 */
	timestamp: number;
}
```

### 3、EventStream 事件协议 — 流式事件的类型定义

```typescript
/** 重导出事件流类型。 */
export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

/** AssistantMessageEventStream 的事件协议。 */
export type AssistantMessageEvent = ...
```

### 4、OpenAI / Anthropic 兼容层配置 — provider 差异化的兼容选项

不同 provider 的 API 存在细微差异。这些 Compat 接口允许调用方覆盖基于 URL 的自动检测，为自定义 provider 指定兼容行为。

```typescript
/** OpenAI Completions API 兼容配置。 */
export interface OpenAICompletionsCompat {...}
/** OpenAI Responses API 兼容配置。 */
export interface OpenAIResponsesCompat {...}
/** Anthropic Messages API 兼容配置。 */
export interface AnthropicMessagesCompat {...}
```

### 5、Model / ImagesModel 统一模型元信息 — 模型的静态描述

```typescript
/** 统一模型元信息。 */
export interface Model<TApi extends Api> {
	/** 模型 ID，如 "gpt-4o"、"claude-3-opus-20240229"。 */
	id: string;
	/** 模型显示名称。 */
	name: string;
	/** 使用的 API 协议名。 */
	api: TApi;
	/** 服务提供商名。 */
	provider: Provider;
	/** API 基础 URL。 */
	baseUrl: string;
	/** 是否支持推理/思考功能。 */
	reasoning: boolean;
	/**
	 * 推理级别映射表。
	 * 把 pi-ai 的统一档位映射到 provider/model 特定的值。
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** 支持的输入类型（文本 / 图片）。 */
	input: ("text" | "image")[];
	/** 计费单价（美元/百万 token）。 */
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	/** 上下文窗口大小（token 数）。 */
	contextWindow: number;
	/** 最大输出 token 数。 */
	maxTokens: number;
	/** 默认 HTTP headers。 */
	headers?: Record<string, string>;
	/**
	 * 兼容层覆盖项。
	 * 根据 TApi 泛型自动推断为对应的 Compat 类型。
	 * 未设置时，provider 会基于 baseUrl 自动检测。
	 */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: never;
}

/**
 * 图片模型元信息。
 * 复用 Model 的大部分字段，去掉文本模型专属能力（reasoning、contextWindow、maxTokens、compat）。
 */
export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	/** 使用的图片 API 协议名。 */
	api: TApi;
	/** 图片服务提供商名。 */
	provider: ImagesProvider;
	/** 支持的输出类型（文本 / 图片）。 */
	output: ("text" | "image")[];
}
```

### 6、对外暴露的函数类型 — StreamFunction / ImagesFunction

```typescript
/**
 * 通用文本流式函数类型。
 *
 * 约定：
 * - 必须返回 AssistantMessageEventStream
 * - 一旦调用，请求/模型/运行时故障应编码到返回的流中，不应抛出
 * - 错误终止必须产生 stopReason 为 "error" 或 "aborted" 的 AssistantMessage，
 *   通过流协议发出
 */
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

/**
 * 图片生成函数类型。
 * 与 StreamFunction 对称，但返回 Promise（非流式）。
 */
export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;
```

和具体实现的关系可以这样理解：

```text
StreamFunction         = 函数类型（描述长相）
stream()               = 一个具体实现
streamSimple()         = 另一个具体实现
provider.stream()      = 更底层的具体实现
```

例如 `stream.ts` 里的：

- `stream(model, context, options?: ProviderStreamOptions): AssistantMessageEventStream`
- `streamSimple(model, context, options?: SimpleStreamOptions): AssistantMessageEventStream`

它们的签名都满足 `StreamFunction`，只是 `options` 的具体类型不同：

- `stream()` 更接近 `StreamFunction<TApi, ProviderStreamOptions>`
- `streamSimple()` 更接近 `StreamFunction<TApi, SimpleStreamOptions>`

所以这一层的价值主要有两个：

1. 给“可替换的流式函数”提供统一类型约束  
   比如上层要接收一个自定义 stream wrapper，就可以直接标成 `StreamFunction`

2. 把“函数长什么样”与“函数怎么实现”分开  
   这样 `stream()`、`streamSimple()`、mock 实现、带重试/日志的包装实现，都能共享同一套签名约束

## 二、模型信息生成层 `scripts/generate-models.ts` <a id="模型信息生成层"></a>

`generate-models.ts` 自动化脚本在 npm run build 时从各 provider 的 API 抓取最新数据并自动构建 `models.generated.ts`，包含 `MODELS`（所有的 `Model` 类）。

```ts
// packages/ai/package.json
{
  "build": "npm run generate-models && npm run generate-image-models && tsgo -p tsconfig.build.json",
}
```

```typescript
// scripts/generate-models.ts
#!/usr/bin/env tsx
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Api, KnownProvider, Model } from "../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
```

**流程：**

1. 从 models.dev 、 OpenRouter 、 Vercel AI Gateway 拉取支持 tool calling 的模型目录

   例子：

   - 从 models.dev 读到 anthropic -> claude-sonnet-4.6

   - 从 OpenRouter 读到 openai/gpt-5.4

   - 从 Vercel AI Gateway 读到一个带 tool-use tag 的模型

   这一步的目标不是立刻生成最终文件，而是先把“外部来源里有哪些可用模型”抓下来。

2. 将多来源、多 provider 模型统一转换为 pi-ai 的 Model 结构，并按协议映射到 anthropic-messages 、 openai-responses 、 openai-completions 等 API 类型

   例子：
   - models.dev 里的 Anthropic 模型
   - 转成：
     ```ts
     {
       id: "claude-sonnet-4.6",
       api: "anthropic-messages",
       provider: "anthropic",
       baseUrl: "https://api.anthropic.com"
     }
     ```

   这一步本质是在做“统一数据结构 + 确定调用协议”。

3. 对上游元数据做项目内修正、缺失模型补录、 thinking / compat 元数据推导，并派生 Azure OpenAI / OpenAI Codex 等目录

4. 清理旧的 provider catalog，生成新的 src/providers/*.models.ts 和聚合文件 src/models.generated.ts

   其中：
   - `src/providers/*.models.ts` 是 **按 provider 拆开的分目录**
   - `src/models.generated.ts` 是 **把所有 provider catalog 再聚合起来的总入口**

生成的文件长这样：

```typescript
// packages/ai/src/models.generated.ts

// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

import { ANTHROPIC_MODELS } from "./providers/anthropic.models.ts";
import { DEEPSEEK_MODELS } from "./providers/deepseek.models.ts";
import { OPENAI_MODELS } from "./providers/openai.models.ts";
import { OPENAI_CODEX_MODELS } from "./providers/openai-codex.models.ts";
import { XIAOMI_MODELS } from "./providers/xiaomi.models.ts";
import { XIAOMI_TOKEN_PLAN_CN_MODELS } from "./providers/xiaomi-token-plan-cn.models.ts";
import { ZAI_MODELS } from "./providers/zai.models.ts";
import { ZAI_CODING_CN_MODELS } from "./providers/zai-coding-cn.models.ts";
...

export const MODELS = {
	"anthropic": ANTHROPIC_MODELS,
	"deepseek": DEEPSEEK_MODELS,
	"openai": OPENAI_MODELS,
	"openai-codex": OPENAI_CODEX_MODELS,
	"xiaomi": XIAOMI_MODELS,
	"xiaomi-token-plan-cn": XIAOMI_TOKEN_PLAN_CN_MODELS,
	"zai": ZAI_MODELS,
	"zai-coding-cn": ZAI_CODING_CN_MODELS,
    ...
} as const;
```

关键设计：**`pi-ai` 的模型列表不是运行时从远端实时拉的，而是构建时生成到代码里的。**

* 得到了什么：
  * 离线可用 — pi 不需要网络连接就能显示模型列表。
  * 启动速度 — 不需要等待 API 响应。
* 放弃了什么：时效性 — 新模型发布后，用户需要等 pi 的下一个版本才能在内建目录中看到它。（但用户可以通过 `models.json` 立即使用新模型）

`MODELS` 的调用链：

```json
models.generated.ts (MODELS 常量)
       │
       │  import { MODELS }
       ▼
providers/all.ts
       │
       │  builtinModels()        → 调用 createModels() + 注册所有 builtin provider
       │  builtinProviders()     → 调用各 provider 工厂 + createProvider()
       │  getBuiltinModel()      → 直接从 MODELS 常量查找单个模型
       │  getBuiltinProviders()  → 返回 KnownProvider 列表
       │  getBuiltinModels()     → 从 MODELS 读取某 provider 的全部模型
       │
       ▼
models.ts (接口 + 工厂，不依赖 models.generated.ts)
       │
       │  createModels()         → new ModelsImpl (provider 运行时集合)
       │  createProvider()       → 拼装 Provider 实例
       │  calculateCost()        → 独立工具函数
       │  clampThinkingLevel()   → 独立工具函数
       │  getSupportedThinkingLevels()
       │  modelsAreEqual()       → 独立工具函数
       │  hasApi()               → 类型窄化 guard
       │
       ▼
index.ts
       │
       │  index.ts:   export * from "./models.ts"
       │
       ▼
上层调用方
```



## 三、认证与基础设施层

### 认证与凭证管理层 `auth/`

Provider 自带认证能力，不依赖外部。定义了 ProviderAuth（包含 ApiKeyAuth 和 OAuthAuth），以及统一的 resolveProviderAuth() 解析入口。





### 统一事件流机制 EventStream

见 [pi-ai-streaming-architecture.md](

## 四、API 懒加载协议层 `api/` 





### `anthropic-messages.lazy.ts` 懒加载入口

anthropic-messages.lazy.ts 很薄，只做一件事：懒加载 anthropic-messages.ts 。

意义是：provider 在注册时只保存一个懒加载入口，不会一上来就把所有 API 实现全部 import 进来。

配合 bundler 的代码分割，SDK 实现（如 `@anthropic-ai/sdk`、`openai`、`@google/genai` 等）会被放在懒加载 chunk 中，并在首次请求对应 API 的模型时再加载。

```ts
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const anthropicMessagesApi = (): ProviderStreams => lazyApi(() => import("./anthropic-messages.ts"));
```

### `anthropic-messages.ts` API 真实实现：决定实际怎么请求 Anthropic

真正发 Anthropic Messages 请求、组装 payload、处理 SSE 流、解析 tool/thinking/caching 的逻辑，都在 anthropic-messages.ts 。





## 四、provider 装配注册层 `providers/`

**provider** 是运行时单元：它拥有自己的模型目录、认证逻辑（API Key 解析、OAuth 流程）以及流式行为。

在内部，不同 provider 会复用 **API 实现**（即底层线协议）：Anthropic 模型使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 以及大多数其他 provider 共用 `openai-completions`。



### Provider 工厂：给某个 API 实现绑上一组模型目录 + 一套认证方式

`anthropic.ts` ：

```ts
baseUrl: "https://api.anthropic.com"
auth:   envApiKeyAuth("Anthropic API key", 
["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"])
models: ANTHROPIC_MODELS       // Claude 系列
api:    anthropicMessagesApi()  // 同一套引擎
```
`minimax.ts` ：

```ts
baseUrl: "https://api.minimax.io/anthropic"
auth:   envApiKeyAuth("MiniMax API key", 
["MINIMAX_API_KEY"])
models: MINIMAX_MODELS          // MiniMax 自己
的模型
api:    anthropicMessagesApi()  // 同一套引擎
```
`kimi-coding.ts`：

```ts
baseUrl: "https://api.kimi.com/coding"
auth:   envApiKeyAuth("Kimi API key", 
["KIMI_API_KEY"])
models: KIMI_CODING_MODELS      // Kimi 自己的模
型
api:    anthropicMessagesApi()  // 同一套引擎
```

**每个厂商的模型目录都有对应的工厂来装配 provider**，可通过子路径导入。如果应用只需要少量特定 provider，导入该厂商的 provider 即可：<a id="特定"></a>

> **npm 包的 subpath exports （子路径导出）**，由包作者在 package.json 中声明：
>
> ```json
> // package.json
> "exports": {
>     ".": {
>         "types": "./dist/index.d.ts",
>         "import": "./dist/index.js"
>     },
>     "./providers/*": {
>         "types": "./dist/providers/*.d.ts",
>         "import": "./dist/providers/*.js"
>     },
>     ...
> }
> ```
>
> 当你导入：
>
> ```json
> import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
> ```
>
> Node.js / bundler 会查 @earendil-works/pi-ai 这个包的 exports 映射，找到 "./providers/openrouter" 对应的实际文件 ./dist/providers/openrouter.js。

```ts
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
// ...支持列表中的每个 provider 都有对应模块

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

#### 具体实现

Provider 工厂导入对应厂商的模型目录和一个懒加载 API 包装器。

通过 `anthropicProvider()` 创建真正的 provider。

它做的事很像“装配”：

- 从 anthropic.models.ts 读出 ANTHROPIC_MODELS 数据
- 配置认证方式，既支持 ANTHROPIC_API_KEY ，也支持 OAuth
- 指定这个 provider 的 API 实现来自 anthropicMessagesApi()
- 最后调用 createProvider 变成统一 Provider

### `all.ts` 把所有内置 provider 汇总并注册到运行时

- all.ts 的 builtinProviders() 会依次调用 anthropicProvider() 、 openaiProvider() 、 deepseekProvider() 等函数，把所有内置 provider 建出来。
- builtinModels() 再调用 createModels() ，把这些 provider 一个个塞进 Models 集合。
- 对 Anthropic 来说，关系就是：
  - anthropicProvider() 先被纳入内置 provider 列表
  - builtinModels() 再把它注册进 ModelsImpl
  - 之后任何 Anthropic 模型请求都能通过 Models.stream() 找到它

```
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // 注册了全部内置 provider 的 Models 集合
```

这个子入口会导入所有模型目录和所有内置 provider 工厂，是一个更重但更显式的入口。`builtinModels()` 接收与 `createModels()` 相同的参数（`credentials`、`authContext`）；如果你想手动注册，也可以使用 `builtinProviders()` 获取 provider 数组。

## 五、`models.ts` 统一 provider / models 运行时框架

`pi-ai` 的核心运行时抽象之一，负责管理 provider 集合、模型目录、认证解析及请求分发。

- 定义了 Provider 接口，规定一个 provider 至少要有：
  - id/name/baseUrl/headers
  - auth
  - getModels()
  - stream() / streamSimple()
- 定义了 Models 接口，它不是单个 provider，而是“provider 集合”。
- ModelsImpl 负责运行时：并把每次请求路由给真正拥有该模型的 provider
  - 保存所有 provider
  - 查模型
  - 解析 auth
  - 在 stream() 时找到模型所属 provider 并把请求转发出去
- 提供 `createModels()` 创建可变运行时集合
- 提供 `createProvider()` 关键装配函数，anthropic.ts 这种 provider 文件最后就是靠它把“模型列表 + auth + api 实现”组装成标准 Provider
- 统一计算 token 成本与 thinking level 映射



调用链：createModels() → ModelsImpl → setProvider(createProvider(...)) → stream()/complete() → applyAuth() → Provider.stream()

### 图片侧运行时 `image-models.ts`

<img src="img/image-20260713203151898.png" alt="image-20260713203151898" style="zoom:50%;" />

接口设计完全一致：都是 provider 注册表 + getModels/getModel/refresh/getAuth + stream/generate 分发，只是图片侧返回 AssistantImages ，文字侧返回 AssistantMessageEventStream 。

## Provider 懒加载 → 注册表调度 → stream 公共 API

### `env-api-keys.ts` 提供 apikey

```typescript
env-api-keys.ts
│
├─ export getEnvApiKey(provider) → 获取 API 密钥值
├─ export findEnvKeys(provider)  → 获取已设置的环境变量名（诊断用）
│
├─ 被 3 个文本 provider、1 个图片 provider 调用（获取 API 密钥）
│
└─ 被 stream.ts 重导出：
    └─ export { getEnvApiKey } from "./env-api-keys.ts"
        └─ 上层可直接 import { getEnvApiKey } from "@earendil-works/pi-ai"
```

### `/Providers` 下的具体 provider 提供流函数

每个 Provider 提供 stream 和 streamSimple 两个方法。没有 complete、没有 embed、没有 tokenCount：

* stream 是给知道自己在做什么的调用者用的：接收完整的 StreamOptions（types.ts 中定义，包含 provider 特定选项），返回事件流。

* streamSimple 是给不关心 provider 差异的调用者用的：接收 SimpleStreamOptions，返回事件流。

### `providers/register-builtins.ts` — 实现每个 provider 的懒加载包装器

- 通过 `import("./xxx.ts")` 等导入各 provider 的 `XxxOptions`

- `loadXxxProviderModule()` 能够通过 import("./xxx.ts") 等懒加载各 provider 的导出对象中的 `streamXxx()` 和 `streamSimpleXxx()` 两个流函数，将他们包装成统一的懒加载 provider 模块 `XxxProviderModule`

  并定义了懒加载的 `XxxProviderModulePromise` 缓存确保每个 provider 模块只被加载一次

  ```typescript
  interface LazyProviderModule<
  	TApi extends Api,
  	TOptions extends StreamOptions,
  	TSimpleOptions extends SimpleStreamOptions,
  > {
  	stream: (model: Model<TApi>, context: Context, options?: TOptions) => AsyncIterable<AssistantMessageEvent>;
  	streamSimple: (
  		model: Model<TApi>,
  		context: Context,
  		options?: TSimpleOptions,
  	) => AsyncIterable<AssistantMessageEvent>;
  }
  
  interface AnthropicProviderModule {
  	streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions>;
  	streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions>;
  }
  
  interface OpenAICompletionsProviderModule {
  	streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions>;
  	streamSimpleOpenAICompletions: StreamFunction<"openai-completions", SimpleStreamOptions>;
  }
  
  interface OpenAIResponsesProviderModule {
  	streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions>;
  	streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions>;
  }
  ```

* `createLazyStream()` / `createLazySimpleStream()` 将 `loadXxxProviderModule()` 传入的各 provider 的 `LazyProviderModule` 包装成统一的 `StreamFunction<TApi, TOptions>` 懒加载流式函数 `streamXxx()` / `streamSimpleXxx`

  这个 StreamFunction 函数本质上是重新封装了一层 outer EventStream 事件流，然后调用 `forwardStream(outer, inner)` 与 inner EventStream 事件流桥接

  ```
  inner (openai-responses.ts 创建)     forwardStream      outer (register-builtins.ts 创建)
  ┌─────────────────────────┐         ┌──────────┐         ┌─────────────────────────┐
  │ HTTP 流事件 → pi 事件协议 │ ──push──▶│ for await│ ──push──▶│ 懒加载桥接，立即返回给调用方 │
  └─────────────────────────┘         └──────────┘         └─────────────────────────┘
  ```
  
  **注意区分 anthropic.ts 和 register-builtins.ts 中的 streamXxx**
  
  ```typescript
  // anthropic.ts 中的 streamAnthropic —— 真正的实现
  export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
      model, context, options
  ) => {
      const stream = new AssistantMessageEventStream();
      // 创建 Anthropic SDK client
      // 发起 API 请求
      // 处理 SSE 事件
      // 转换成统一的 AssistantMessageEvent
      // ...
      return stream;
  };
  
  // register-builtins.ts 中的 streamAnthropic —— 懒加载包装器
  export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
  // 内部逻辑：
  // 1. 创建一个空的 outer 事件流
  // 2. 异步 import("./anthropic.ts")
  // 3. 加载成功后，forwardStream(AssistantMessageEventStream, streamAnthropic) 把真正的 streamAnthropic 的事件转发到 AssistantMessageEventStream 事件流
  // 4. 加载失败则用 createLazyLoadErrorMessage() 创建错误消息并推送到事件流
  // 5. 立即返回事件流
  ```
  
  为什么这么做？
  
  ```
  场景：应用启动时，import 了 stream.ts
  
  如果不做懒加载：
  ├─ stream.ts 导入 register-builtins.ts
  ├─ register-builtins.ts 导入 anthropic.ts（加载 Anthropic SDK ~500ms）
  ├─ register-builtins.ts 导入 openai-completions.ts（加载 OpenAI SDK ~300ms）
  ├─ register-builtins.ts 导入 openai-responses.ts（加载 OpenAI SDK ~300ms）
  └─ 总启动时间：~1100ms 😱
  
  做了懒加载：
  ├─ stream.ts 导入 register-builtins.ts
  ├─ register-builtins.ts 只注册"空壳"函数（~0ms）
  └─ 总启动时间：~0ms ✅
  
  第一次调用 streamAnthropic 时：
  ├─ 加载 anthropic.ts（~500ms）
  ├─ 调用真正的 streamAnthropic
  └─ 后续调用直接复用缓存的模块
  ```
  

- stream.ts 导入 register-builtins.ts，自动触发 `registerBuiltInApiProviders()` 注册所有内置 provider 到全局注册表
- 导出 `resetApiProviders()` 供测试重置注册表（调用 api-registry.ts 中的 `clearApiProviders` 后重新注册）

### `api-registry.ts` API 注册表 — `stream.ts` 和 `register-builtins.ts` 中 provider 懒加载包装器之间的桥接层

整个注册表的 API 面只有五个函数：`registerApiProvider`（注册）、`getApiProvider`（查找单个）、`getApiProviders`（列出全部）、`unregisterApiProviders`（按 sourceId 批量注销）、`clearApiProviders`（清空，用于测试）。其中前四个是常用的。

```typescript
apiProviderRegistry = new Map<string, RegisteredApiProvider>()

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string; // ?表示可选
};

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	});
}

// 对外暴露的强类型 provider 接口
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

// 注册表内部存储的类型擦除后的 provider
interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}
```

register-builtins.ts 中的 `registerBuiltInApiProviders()` 调用了 api-registry.ts 中的 `registerApiProvider()`，

* 传入懒加载包装器 `streamXxx()` 和 `streamSimpleXxx()`，集合为**范型的 `ApiProvider`**（**对外暴露的强类型 provider 接口**）

* 再通过 `wrapStream()` / `wrapStreamSimple()` 做一层**精妙的封装**，先校验 `model.api !== api`，再封装泛型的懒加载包装器 `StreamFunction<TApi, TOptions>` 为非泛型的 `ApiStreamFunction`

  > 为什么需要**类型擦除**？
  >
  > 因为 `Map<string, RegisteredApiProvider>` 只能存一种类型。如果 Map 的 value 类型带泛型参数（比如 `ApiProvider<TApi, TOptions>`），每个 entry 的泛型参数不同。
  >
  > 解决方案是经典的**"入口检查 + 内部擦除"模式**：
  >
  > 1. **注册时**：泛型约束保证 provider 的 `stream` 函数类型与 `api` 一致
  > 2. **存储时**：`wrapStream` 把泛型函数包装为非泛型的 `ApiStreamFunction`
  > 3. **取出时**：`getApiProvider` 返回 `ApiProviderInternal`（非泛型），调用者拿到的函数签名丢失了 `TOptions` 信息
  > 4. **运行时**：`model.api !== api` 检查保证不会把 Anthropic 的 model 传给 OpenAI 的 stream 函数

* 将非范型的 `ApiStreamFunction` / `ApiStreamSimpleFunction` 集合为 `ApiProviderInternal`（注册表内部存储的类型擦除后的 provider）

* 最后将 (api, RegisteredApiProvider) 注册到全局注册表 `apiProviderRegistry`

  > `RegisteredApiProvider` 中的 `sourceId` 用于标记 provider 来源，方便按来源批量卸载。比如自定义 extension 注册了一批 provider。

  每个 API（协议） 对应一个 RegisteredApiProvider（协议实现）（Map 的特性：相同 key 会覆盖，后注册的覆盖先注册的）

### `stream.ts` — 薄到透明的公共 API 层

![image-20260603194454329](img/image-20260603194454329.png)

**提供对外统一流式入口 `stream(api)` / `streamSimple(api)`**

> `streamSimple()` 是上层真正常用的 API 面，因为这层把 reasoning / timeout / signal / headers / cache 这些参数统一好了。

* 他们都通过 `resolveApiProvider(api)` 从注册表中得到被封装了两层的 provider，从而调用具体 provider（anthropic.ts）中的 `streamXxx()` / `streamSimpleXxx()`

  ```typescript
  ┌─ 第二层封装：api-registry 的 `wrapStream()`
  │	└─ 非范型包装
  │   └─ 校验 model.api === api
  │
  ├─ 第一层封装：register-builtins 的懒加载包装器
  │   └─ `loadXxxProviderModule()` 异步加载 anthropic.ts
  │
  └─ 最下层：anthropic.ts 的真正实现 `streamXxx()`
          └─ 创建 SDK client、发起请求、处理流
  ```

非流式入口 `complete()` / `completeSimple()` 不是独立的实现 — 它们只是对 stream 版本调用 `.result()` 的语法糖。这就是为什么 `ApiProvider` 接口只需要两个方法而不是四个：**stream 是原语，complete 是派生**。

这个文件的存在证明了注册表设计的成功：98 行的 `api-registry.ts` 承担了全部复杂性，公共 API 层薄到几乎可以内联。对调用者来说，`stream(model, context, options)` 看起来就像在直接调用 provider，注册表完全隐形。

```typescript
streamSimple(model, context, options)          // stream.ts 入口
    │
    ├─ model.api = "anthropic-messages"
    │   └─ register-builtins.ts (懒加载)
    │       └─ anthropic.ts
    │           ├─ transform-messages.ts  ← 消息预处理
    │           ├─ simple-options.ts      ← 参数映射
    │           └─ @anthropic-ai/sdk      ← 真实 API 调用
    │
    ├─ model.api = "openai-completions"
    │   └─ register-builtins.ts (懒加载)
    │       └─ openai-completions.ts
    │           ├─ transform-messages.ts
    │           ├─ simple-options.ts
    │           ├─ openai-prompt-cache.ts
    │           └─ openai SDK
    │
    ├─ model.api = "openai-responses"
    │   └─ register-builtins.ts (懒加载)
    │       └─ openai-responses.ts
    │           ├─ openai-responses-shared.ts  ← 消息/工具转换 + 流处理
    │           ├─ simple-options.ts
    │           ├─ openai-prompt-cache.ts
    │           └─ openai SDK
    │
    └─ model.api = "faux:*" (测试)
        └─ faux.ts (直接注册，不走懒加载)
```

### 实战：添加一个新 api&provider 的完整步骤

添加 DeepSeek provider 不需要重写任何 API 实现，只需要使用 OpenAI 兼容的 API：

```
在 types.ts 的 KnownProvider 联合中加入 "deepseek"。这不是必须的（Provider = KnownProvider | string，任意字符串都合法），但加入后 IDE 会提供自动补全。
1. 在 generate-models.ts 中定义模型元信息（自动生成到 
models.generated.ts）
2. api 字段指向 "openai-completions"（复用已有的协议实
现）
3. provider 字段设为 "deepseek"（用于读取 API 密钥）
4. baseUrl 指向 DeepSeek 的 API 地址
5. compat 字段覆盖不兼容的行为
```

```typescript
// generate-models.ts
if (data.deepseek?.models) {
    for (const [modelId, model] of Object.entries(data.deepseek.models)) {
        const m = model as ModelsDevModel;
        if (m.tool_call !== true) continue;

        models.push({
            id: modelId,
            name: m.name || modelId,
            api: "openai-completions",
            provider: "deepseek",
            baseUrl: "https://api.deepseek.com/v1",
            reasoning: m.reasoning === true,
            input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
            cost: {
                input: m.cost?.input || 0,
                output: m.cost?.output || 0,
                cacheRead: m.cost?.cache_read || 0,
                cacheWrite: m.cost?.cache_write || 0,
            },
            contextWindow: m.limit?.context || 4096,
            maxTokens: m.limit?.output || 4096,
            compat: {
                supportsDeveloperRole: false,
            },
        });
    }
}
```

如果是一个新的 api 和 provider，则需要

1、协议层

- types.ts

你可能要改：

- `KnownApi`
- `KnownProvider`
- provider 专属 `XxxOptions`
- 兼容层配置接口

2、provider 实现层

新增：

- `src/providers/your-provider.ts`

至少要实现：

- `streamYourProvider()`
- `streamSimpleYourProvider()`

3、注册层

改：

- register-builtins.ts

你要补：

1. `loadYourProviderModule()`
2. `streamYourProvider` / `streamSimpleYourProvider`
3. `registerBuiltInApiProviders()` 中的注册逻辑

4、模型元信息层

改：

- generate-models.ts
- 生成后的 models.generated.ts

5、认证发现层

改：env-api-keys.ts

6、文档与测试

改：

- `README.md`
- `test/` 下相关测试

### 优点

**1. 无限扩展性**。任何人都可以在运行时注册新的 provider，不需要修改 pi-ai 的代码。Extension 可以在用户启动后动态加载 provider。

**2. Provider 和 Api 的解耦**。同一个 api 协议可以被多个 provider 复用。增加 Azure OpenAI 或 GitHub Copilot 不需要重写 OpenAI 的 api 实现。

**3. 极简的公共 API**。注册表只暴露 5 个函数。用户面对的 `stream.ts` 只有 4 个函数。新的 provider 开发者只需要实现 `stream` 和 `streamSimple` 两个方法。

**4. 启动零成本**。延迟加载确保了只有实际使用的 provider 模块才会被加载。10 个内建 provider 中，一次会话通常只加载 1-2 个。

**5. 复杂性集中**。整个 pi-ai 层的"设计复杂性"集中在 `api-registry.ts` 和 `register-builtins.ts` 中，`stream.ts` 是纯粹的委托。

## Context handoff 跨模型上下文交接

pi-ai 从设计之初就考虑到了不同提供商之间的上下文切换。由于每个提供商都有自己追踪工具调用和思维轨迹的方式，因此只能尽力而为。例如，如果在会话中途从 Anthropic 切换到 OpenAI，Anthropic 的 thinking 块会被降级为普通文本块（丢失 thinkingSignature）。

`Context` 可序列化，支持在不同提供商之间无缝传递对话上下文。

```typescript
import { getModel, complete, Context } from "@earendil-works/pi-ai";

// Start with Claude
const claude = getModel('anthropic', 'claude-sonnet-4-5');
const context: Context = {
  messages: []
};

context.messages.push({ role: 'user', content: 'What is 25 * 18?' });
const claudeResponse = await complete(claude, context, {
  reasoning: "high"
});
context.messages.push(claudeResponse);

// Switch to GPT - Claude's thinking will be downgraded to plain text
const gpt = getModel('openai', 'gpt-5.1-codex');
context.messages.push({ role: 'user', content: 'Is that correct?' });
const gptResponse = await complete(gpt, context);
context.messages.push(gptResponse);

// Serialize context to JSON (for storage, transfer, etc.)
const serialized = JSON.stringify(context);

// Later: deserialize and continue with any model
const restored: Context = JSON.parse(serialized);
restored.messages.push({ role: 'user', content: 'Summarize our conversation' });
const continuation = await complete(claude, restored);
```

**用户在 Claude 上聊了 50 轮，现在要切到 GPT — 历史消息怎么办？**

直觉上，LLM 消息就是"角色 + 文本"。但实际上，每家厂商的消息格式都携带了 provider 特有的元数据。

`transformMessages()` 函数解决了这些问题。它的策略可以概括为一句话：**尽可能保留，不能保留的安全降级，绝不让变换导致 API 调用失败。**

**跨模型转换发生的位置**：在 provider 内部 streamXxx 每次发 HTTP 请求之前调用 buildParams()->convertMessages()->transformMessages()

### 变换策略：同模型保持，跨模型降级

`transformMessages` 的核心判断逻辑围绕一个布尔值 `isSameModel`：

```typescript
// packages/ai/src/providers/transform-messages.ts
const isSameModel =
  assistantMsg.provider === model.provider &&
  assistantMsg.api === model.api &&
  assistantMsg.model === model.id;
```

这不是简单的"同 provider"判断 — 它要求 provider、api、model ID 三者完全一致。同一个 provider 的不同模型（比如 `claude-sonnet-4-6` 和 `claude-opus-4-6`）也被视为"不同模型"。

基于这个判断，变换策略如下：

```mermaid
flowchart TD
    Block[消息内容块] --> Type{块类型?}
    
    Type -->|thinking| ThinkCheck{isSameModel?}
    ThinkCheck -->|同模型| KeepThinking[保留原样\n含 signature]
    ThinkCheck -->|跨模型| RedactCheck{redacted?}
    RedactCheck -->|是| Drop[丢弃\n加密内容不可跨模型]
    RedactCheck -->|否| EmptyCheck{内容为空?}
    EmptyCheck -->|是| Drop2[丢弃]
    EmptyCheck -->|否| ConvertText[降级为 text 块\nthinking → text]
    
    Type -->|toolCall| TCCheck{isSameModel?}
    TCCheck -->|同模型| KeepTC[保留原样]
    TCCheck -->|跨模型| NormID[移除 thoughtSignature\n归一化 tool call ID]
    
    Type -->|text| TextCheck{isSameModel?}
    TextCheck -->|同模型| KeepText[保留原样\n含 textSignature]
    TextCheck -->|跨模型| StripSig[保留文本\n移除 signature]
    
    style Drop fill:#ffcdd2
    style Drop2 fill:#ffcdd2
    style ConvertText fill:#fff3e0
    style NormID fill:#fff3e0
    style KeepThinking fill:#c8e6c9
    style KeepTC fill:#c8e6c9
    style KeepText fill:#c8e6c9
```

### Thinking Block 变换：完整的决策树

Thinking block 是整个变换逻辑中最复杂的部分。这不是因为代码多，而是因为 thinking 块有多种形态，每种的处理策略不同。先看类型定义：

```typescript
// packages/ai/src/types.ts
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
```

一个 `ThinkingContent` 可以是以下几种情况：

1. **正常的思维内容** — `thinking` 有文本，没有 `redacted`，可能有 `thinkingSignature`
2. **被安全过滤的思维** — `redacted === true`，`thinkingSignature` 存储加密后的不透明载荷
3. **OpenAI 加密推理** — `thinking` 为空，但 `thinkingSignature` 存在（OpenAI 的 reasoning item ID）
4. **空思维块** — `thinking` 为空或纯空白，没有 signature

每种情况的处理逻辑完全不同。`transformMessages` 中的完整决策：

**第一层判断：`block.redacted`**。Redacted thinking 是安全过滤的产物。当 Anthropic 的安全系统认为某段思维内容不适合展示时，会将其替换为加密载荷，存储在 `thinkingSignature` 中。跨模型时，这段加密内容对目标模型来说就是乱码，所以直接丢弃（`return []`）。

**第二层判断：`isSameModel && block.thinkingSignature`**。这是专门处理 OpenAI 加密推理（encrypted reasoning）的分支。OpenAI 的 reasoning model（如 o1、o3）不会暴露推理文本，但会返回一个 reasoning item ID 作为 `thinkingSignature`。此时 `thinking` 字段为空字符串，但 `thinkingSignature` 存在。如果是同模型重放，这个 signature 必须保留 — 模型需要它来延续推理上下文。关键点在于：这个分支在 redacted 检查**之后**，所以它不会误处理 redacted blocks。

**第三层判断：空内容检查**。如果 `thinking` 为空或纯空白，且不是上面两种有 signature 的情况，那这个块就没有任何有用信息，直接丢弃。

**第四层：同模型保留，跨模型降级**。如果有实际的思维文本，同模型原样保留（包括 signature），跨模型则降级为普通 `text` 块 — 文本内容保留，但失去了"这是模型的内部推理"这层语义信息。

### Text Block 变换：看似简单的清洗

Text block 是最"普通"的内容类型，但即使是文本块，跨模型时也需要变换：

```typescript
if (block.type === "text") {
  if (isSameModel) return block;
  return {
    type: "text" as const,
    text: block.text,
  };
}
```

同模型时原样返回，跨模型时构造一个新的 `TextContent` 对象，只保留 `type` 和 `text` 两个字段。为什么不能直接 `return block`？因为 `TextContent` 类型上还有一个可选字段：

```typescript
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

`textSignature` 是 OpenAI Responses API 附加的元数据 — 可能是 legacy ID 字符串，也可能是 `TextSignatureV1` JSON（包含版本号、ID 和 phase 信息）。同模型时保留这些元数据有助于 API 重放的准确性；跨模型时，这些 provider 特有的元数据对目标模型毫无意义，甚至可能引起兼容性问题。

通过构造一个新对象而非修改原对象，代码保证了跨模型时 `textSignature` 被干净地剥离。这是一种典型的"白名单"策略：不是"检查并删除已知的无关字段"，而是"只复制已知需要的字段"。白名单策略更安全 — 如果未来 `TextContent` 增加了新的 provider 特有字段，白名单策略会自动将其排除在跨模型变换之外，无需修改变换代码。

### Tool Call ID 归一化：一个具体的例子

OpenAI Responses API 生成的 tool call ID 长这样：

```
fc_682e1b1b5c9081919ecae4e2b4f73f710cf7bd7c89b44df5|call_RJxMmhTWpikOz4UMgkJbopvl
```

450+ 字符，包含 `|` 字符。如果把这个 ID 原样传给 Anthropic，API 会拒绝 — Anthropic 要求 `^[a-zA-Z0-9_-]+$`，最多 64 字符。

`transformMessages` 通过 `normalizeToolCallId` 回调解决这个问题：

```typescript
if (!isSameModel && normalizeToolCallId) {
  const normalizedId = normalizeToolCallId(
    toolCall.id, model, assistantMsg
  );
  if (normalizedId !== toolCall.id) {
    toolCallIdMap.set(toolCall.id, normalizedId);
    normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
  }
}
```

注意 `toolCallIdMap` 的设计：当一个 tool call ID 被归一化后，映射关系被存储起来。后续遇到对应的 `toolResult` 消息时，它的 `toolCallId` 也会被同步更新：

```typescript
if (msg.role === "toolResult") {
  const normalizedId = toolCallIdMap.get(msg.toolCallId);
  if (normalizedId && normalizedId !== msg.toolCallId) {
    return { ...msg, toolCallId: normalizedId };
  }
}
```

tool call 和 tool result 的 ID 必须匹配，否则 API 会报错。归一化必须双向一致。

同样值得注意的是 `thoughtSignature` 的处理：Google 的 tool call 携带 `thoughtSignature` 用于思维链上下文复用，跨模型时这个字段被删除。这和 text block 的白名单策略不同 — tool call 由于有 `id`、`name`、`arguments` 等关键字段需要精确保留，这里用的是"黑名单"策略：显式删除已知的无关字段。

### 第二遍扫描：合成缺失的 Tool Result

`transformMessages` 做了两遍扫描。第一遍处理内容变换（thinking 降级、ID 归一化、text signature 清洗）。第二遍处理一个更隐蔽的问题：**孤立的 tool call**。

#### 孤立 tool call 是怎么产生的？

当 assistant 消息中有 tool call，但对应的 tool result 缺失时，API 会报错。这种"孤立"有几种成因：

1. **用户中途 abort 了 agent 循环** — assistant 发出了 tool call，但 tool 还没执行用户就按了 Ctrl+C
2. **tool 执行过程中发生了错误** — result 消息没有被正确记录
3. **用户在 tool call 和 tool result 之间切换了模型** — 新模型看到了前模型的 tool call，但没有对应的 result

#### 合成逻辑的完整代码

第二遍扫描的核心是一个状态机，追踪"当前有哪些待回复的 tool call"：

```typescript
const result: Message[] = [];
let pendingToolCalls: ToolCall[] = [];
let existingToolResultIds = new Set<string>();

for (let i = 0; i < transformed.length; i++) {
  const msg = transformed[i];

  if (msg.role === "assistant") {
    // If we have pending orphaned tool calls from a
    // previous assistant, insert synthetic results now
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!existingToolResultIds.has(tc.id)) {
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          } as ToolResultMessage);
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
```

注意这里的时序：当遇到一条新的 assistant 消息时，如果前一条 assistant 还有未回复的 tool call，在新 assistant **之前**插入合成的 tool result。这保证了消息序列始终满足 `assistant(tool_call) → toolResult → assistant` 的交替模式。

#### 错误/中止消息的跳过

紧接着合成逻辑之后，是对 error 和 aborted 消息的处理：

```typescript
// packages/ai/src/providers/transform-messages.ts:126-134

// Skip errored/aborted assistant messages entirely.
// These are incomplete turns that shouldn't be replayed:
// - May have partial content (reasoning without message,
//   incomplete tool calls)
// - Replaying them can cause API errors (e.g., OpenAI
//   "reasoning without following item")
// - The model should retry from the last valid state
const assistantMsg = msg as AssistantMessage;
if (assistantMsg.stopReason === "error"
  || assistantMsg.stopReason === "aborted") {
  continue;
}
```

被 `continue` 跳过的消息不会出现在最终结果中。源码注释精确地解释了原因：这些消息可能包含不完整的内容 — 比如 OpenAI 模型可能返回了 reasoning 但还没来得及生成后续内容就中断了，重放这样的消息会触发 "reasoning without following item" 错误。

#### 用户消息打断 Tool 流

第二遍扫描还处理一种特殊场景：**用户消息打断了 tool 流**。正常的 agent 循环是 `assistant(tool_call) → toolResult → assistant`，但用户可以在任何时候发送新消息。如果用户在 assistant 发出 tool call 后、tool result 返回前发送了新消息，tool call 就变成了孤立的：

```typescript
、} else if (msg.role === "user") {
  // User message interrupts tool flow - insert synthetic
  // results for orphaned calls
  if (pendingToolCalls.length > 0) {
    for (const tc of pendingToolCalls) {
      if (!existingToolResultIds.has(tc.id)) {
        result.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text",
                      text: "No result provided" }],
          isError: true,
          timestamp: Date.now(),
        } as ToolResultMessage);
      }
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  }
  result.push(msg);
}
```

这段代码和 assistant 消息触发的合成逻辑几乎一样 — 因为处理策略是相同的：在用户消息**之前**插入合成的 tool result，修复断裂的消息序列。`existingToolResultIds` 的检查保证了如果部分 tool call 已经有了真实的 result（比如 assistant 发了 3 个 tool call，2 个已经有 result，用户在第 3 个执行完之前发了消息），只为缺失的那些补充合成 result。

合成的 tool result 都标记为 `isError: true`，内容为 `"No result provided"`。这个设计有双重目的：一是满足 API 的格式要求（每个 tool call 必须有对应的 result），二是给模型一个信号 — 这个工具调用的结果是不可靠的，模型应该考虑重新调用或采取其他策略。

### 具体例子：从 Claude 到 GPT 的消息变换

以下是一个 3 消息对话在跨模型变换前后的对比。假设用户在 Claude（`claude-sonnet-4-6`）上进行了对话，现在要切换到 GPT（`gpt-4o`）。

**变换前**（Claude 原生消息）：

```json
[
  { "role": "user", "content": "查看 src/main.rs 的内容" },
  {
    "role": "assistant",
    "provider": "anthropic", "api": "messages",
    "model": "claude-sonnet-4-6",
    "content": [
      { "type": "thinking",
        "thinking": "用户要看文件内容，我用 read 工具",
        "thinkingSignature": "sig_abc123..." },
      { "type": "text",
        "text": "我来读取文件内容。",
        "textSignature": "{\"v\":1,\"id\":\"msg_01X...\",\"phase\":\"commentary\"}" },
      { "type": "toolCall",
        "id": "toolu_01ABC", "name": "read",
        "arguments": { "path": "src/main.rs" } }
    ],
    "stopReason": "toolUse"
  },
  {
    "role": "toolResult",
    "toolCallId": "toolu_01ABC",
    "toolName": "read",
    "content": [{ "type": "text", "text": "fn main() { ... }" }],
    "isError": false
  }
]
```

**变换后**（发送给 GPT 的消息）：

```json
[
  { "role": "user", "content": "查看 src/main.rs 的内容" },
  {
    "role": "assistant",
    "provider": "anthropic", "api": "messages",
    "model": "claude-sonnet-4-6",
    "content": [
      { "type": "text",
        "text": "用户要看文件内容，我用 read 工具" },
      { "type": "text",
        "text": "我来读取文件内容。" },
      { "type": "toolCall",
        "id": "toolu_01ABC", "name": "read",
        "arguments": { "path": "src/main.rs" } }
    ]
  },
  {
    "role": "toolResult",
    "toolCallId": "toolu_01ABC",
    "toolName": "read",
    "content": [{ "type": "text", "text": "fn main() { ... }" }],
    "isError": false
  }
]
```

变换产生了以下变化：

| 内容           | 变换前                         | 变换后         | 说明                                            |
| -------------- | ------------------------------ | -------------- | ----------------------------------------------- |
| Thinking block | `type: "thinking"` + signature | `type: "text"` | 降级为普通文本，signature 丢失                  |
| Text block     | 含 `textSignature`             | 无 signature   | 文本保留，元数据剥离                            |
| Tool call      | 原样                           | 原样           | Claude 的 ID 格式恰好符合大多数 provider 的要求 |
| Tool result    | 原样                           | 原样           | ID 未变，无需更新                               |
| User message   | 原样                           | 原样           | 用户消息从不变换                                |

**丢失了什么？**

- thinking 块从结构化思维降级为普通文本。GPT 不知道这段文字是前一个模型的内部推理 — 它看到的只是一段额外的 text block。这意味着 GPT 不会用自己的 reasoning 能力来"接着想"，而是把这段文字当作 assistant 说过的话来理解。
- `textSignature` 被剥离。如果后续再切回 Claude，这个 signature 已经不可恢复。
- `thinkingSignature` 被丢弃。Claude 的 thinking 连续性在切换到 GPT 的那一刻就中断了。

**保留了什么？**

- 所有的文本内容 — 思维内容虽然降级了，但文字本身没丢
- 完整的 tool call / tool result 对 — GPT 可以看到前模型调用了什么工具、得到了什么结果
- 对话的因果链 — 用户问了什么、模型做了什么、结果是什么，这条语义链完整保留

这就是"有损但安全"的核心含义：丢失的是 provider 特有的元数据和语义标注，保留的是对话的内容和因果关系。

### 白名单 vs 黑名单的一致性问题

值得注意的是，变换代码对不同块类型使用了不同的"清洗"策略：

- **Text blocks**：白名单 — 构造新对象，只包含 `type` 和 `text`
- **Tool calls**：黑名单 — 在原对象上显式删除 `thoughtSignature`

这种不一致是有原因的：text block 的字段少且稳定（`type`、`text`、`textSignature`），白名单实现简单且安全。Tool call 的字段多且关键（`id`、`name`、`arguments` 都不能丢），白名单实现需要枚举所有需要保留的字段，增加了维护负担和遗漏风险。但这种不一致也带来了未来的风险 — 如果 `ToolCall` 类型增加了新的 provider 特有字段，黑名单策略需要记得更新变换代码。

核心判断：**有损交接好过不能交接。** 丢失一些 thinking 细节，比"切换模型后对话完全中断"要好得多。
