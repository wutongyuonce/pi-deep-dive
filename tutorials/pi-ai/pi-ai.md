# [pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai)

整个 pi monorepo **统一的 LLM API 层**，提供可组合的 provider 集合、自动认证解析、Token 与成本统计，以及简单的上下文持久化与会话中途切换模型能力。

本质是：**用一套统一的模型、消息、工具、流式事件协议，屏蔽掉不同 llm 的协议差异。**这也是阅读源码时不失真的关键心法。

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

`packages/ai/src` 可以按“公共入口、运行时装配、协议实现、认证/基础设施、类型与生成目录”来阅读。这里的“层”描述依赖方向，不代表所有文件都严格位于单一目录：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         对外入口层                                         │
│                                                                         │
│  index.ts       主入口 — 无 provider catalog、API registry、OAuth 实现副作用 │
│  oauth.ts       OAuth 子路径入口                                         │
│  cli.ts         CLI 命令                                                  │
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
│  provider 数量与模型目录随生成数据演进                                       │
│  openai.ts           → openai-responses    │ anthropic.ts → anthropic-   │
│  openai-codex.ts     → openai-codex        │               messages      │
│  deepseek.ts         → openai-completions  │ kimi-coding  → (同上)       │
│  xai.ts              → openai-completions  │ fireworks    → 多引擎混合   │
│  zai.ts              → openai-completions  │ github-      → 多引擎混合   │
│  together.ts         → openai-completions  │   copilot                 │ 
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
│  ┌─ auth/ 认证系统 ────────────────────────────────────────────────┐  │
│  │ types.ts          ProviderAuth / CredentialStore / AuthResult     │  │
│  │ resolve.ts        resolveProviderAuth() 统一认证解析               │  │
│  │                   (优先级: 显式覆盖 > 存储凭证 > 环境变量/ADC)       │  │
│  │ credential-store.ts  InMemoryCredentialStore (可注入持久化)         │  │
│  │ helpers.ts        envApiKeyAuth() / lazyOAuth()                   │  │
│  │ context.ts        defaultProviderAuthContext()                    │  │
│  │                                                                   │  │
│  │ OAuth 子系统 (auth/oauth/):                                        │  │
│  │ anthropic.ts / github-copilot.ts / openai-codex.ts                │  │
│  │ device-code.ts / pkce.ts / oauth-page.ts / load.ts                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ env-api-keys.ts 环境变量认证 ─────────────────────────────────────┐   │
│  │ findEnvKeys() / getEnvApiKey()  内置 provider 的 env var 映射      │   │
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
│    models.generated.ts       内置 provider 的静态模型合集                  │
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
| models.ts                 | **运行时核心**         | `createModels()`、`createProvider()`、`Models`/`Provider` 接口、认证、动态目录、成本/thinking 工具 | `providers/all.ts`、各 provider 工厂、上层调用方 | `api/lazy.ts`、`auth/resolve.ts` |
| images-models.ts          | 图片侧运行时核心       | `createImagesModels()`、`createImagesProvider()`                       | `providers/all.ts`、上层调用方                       | `images-api-registry.ts`           |
| images.ts                 | 图片生成统一入口       | `generateImages()`                                                    | 外部调用者                                          | `images-api-registry.ts`           |
| images-api-registry.ts    | 图片 provider 注册表 | `registerImagesApiProvider`、`getImagesApiProvider`          | `images.ts`、图片 provider 注册层                          | 包装图片 provider                      |
| image-models.ts           | 图片模型查询层       | `getImageModel`、`getImageModels`、`getImageProviders`       | 外部调用者                                                 | `image-models.generated.ts`            |
| models.generated.ts       | 生成产物             | 文本模型元信息常量 `MODELS`（内置 provider 的静态目录）         | `providers/all.ts`                                        | 无                                     |
| image-models.generated.ts | 生成产物             | 图片模型元信息常量 `IMAGE_MODELS`                            | `image-models.ts`                                          | 无                                     |
| session-resources.ts      | 会话资源清理注册表   | `registerSessionResourceCleanup`、`cleanupSessionResources`  | 需要维护 session 资源的 provider                           | cleanup 回调集合                   |
| oauth.ts                  | OAuth 导出入口       | re-export `utils/oauth/` 的全部 OAuth 能力（登录、刷新、凭据管理） | 需要 OAuth 登录的外部调用者                                | `utils/oauth/index.ts`                |

#### `auth/` 认证与凭证管理层

`auth/` 负责 provider 认证的解析和凭证存储，是 `models.ts` 中 `applyAuth()` 的底盘。

核心文件：

| 文件                | 定位                   | 核心功能 / 关键导出                                | 主要被谁调用               |
| ------------------- | ---------------------- | -------------------------------------------------- | -------------------------- |
| types.ts            | 认证类型定义           | `CredentialStore`、`ApiKeyCredential`、`OAuthCredential`、`Credential`、`ApiKeyAuth`、`OAuthAuth`、`ProviderAuth` | `models.ts`、各 provider   |
| resolve.ts          | 认证解析核心           | `resolveProviderAuth()`（统一解析：锁、过期检查、刷新、env fallback 全自动）、`ModelsError` | `models.ts` 的 `applyAuth()` |
| credential-store.ts | 凭证存储               | `InMemoryCredentialStore`（默认内存实现）          | `models.ts`、外部登录流程  |
| context.ts          | 认证上下文             | `defaultProviderAuthContext()`（跨平台 env/fileExists） | `resolve.ts`               |
| helpers.ts          | 认证辅助工厂           | `envApiKeyAuth()`、`oauthAuth()` 等工厂函数        | 各 provider 定义           |

#### `providers/` Provider 装配层

**Provider 是"薄封装"**：每个文件拿一组模型目录 + 一套认证方式 + 一套 API 引擎，通过 `createProvider()` 装配成统一 Provider。同一套引擎可被多个 provider 复用。

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

1、构建期：生成、编译、打包静态代码和目录。

```ts
npm run generate-models
	-> 运行 scripts/generate-models.ts
	-> 生成 providers/anthropic.models.ts 等各个按厂商分类的模型目录
	-> 汇总成 models.generated.ts 目录
```

2、运行期：应用启动后创建并注册 `Models`、Provider 等内存对象，models.ts 把 provider 纳入统一运行时。

```ts
builtinModels() // all.ts
	-> createModels() 创建 ModelsImpl// models.ts
	-> builtinProviders() // all.ts
		-> anthropicProvider() 组装 ANTHROPIC_MODELS 模型目录、anthropicMessagesApi() API 实现 // anthropic.ts
		-> openaiProvider() // openai.ts
		-> ...
	-> models.setProvider(...) // models.ts
```

* 上层应用可自行逐个注册所需 provider：

  ```ts
  import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
  import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
  import { createModels } from "@earendil-works/pi-ai";
  
  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  ...
  ```

  或使用 all.ts 提供的 `builtinModels()` 注册全部内置 provider：

  ```ts
  import { builtinModels } from '@earendil-works/pi-ai/providers/all';
  const models = builtinModels();
  ```

  ```ts
  export function builtinModels(options?: CreateModelsOptions): MutableModels {
  	const models = createModels(options);
  	for (const provider of builtinProviders()) {
  		models.setProvider(provider);
  	}
  	return models;
  }
  
  export function builtinProviders(): Provider[] {
  	return [
  		anthropicProvider(),
  		openaiProvider(),
          ...
      ];
  }
  ```

* 两种方式本质都是执行 `anthropic.ts` 等工厂函数 `anthropicProvider()`，把“已生成的 Anthropic 模型目录 + 认证策略 + API 实现”组装为内存中的 `Provider`，并 `setProvider()` 注册至 `models`。

  ```ts
  export function anthropicProvider(): Provider<"anthropic-messages"> {
  	return createProvider({
  		id: "anthropic",
  		name: "Anthropic",
  		baseUrl: "https://api.anthropic.com",
  		auth: {
  			// ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY
  			apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]),
  			oauth: lazyOAuth({ name: "Anthropic (Claude Pro/Max)", load: loadAnthropicOAuth }),
  		}, // 认证策略
  		models: Object.values(ANTHROPIC_MODELS), // 模型目录
  		api: anthropicMessagesApi(), // API 实现
  	});
  }
  ```

3、请求执行时：某次具体 models.ts `stream()` 调用真正发出模型请求。

`models.stream()` 用第一层 `lazyStream()` 延迟认证；`createProvider()` 将模型请求路由到 `openAIResponsesApi()`；`openAIResponsesApi()` 用第二层 `lazyStream()` 延迟加载真实 OpenAI Responses 实现；最后由 `openai-responses.ts` 发起网络请求并产生事件流。

可以，把它看成一条“把异步准备工作藏进统一事件流”的流水线。

先纠正一个小点：`models.stream()` 最终调用的是 `provider.stream()`；只有 `models.streamSimple()` 才会调用 `provider.streamSimple()`。两条链结构相同。

````
```mermaid
flowchart LR
  A["models.stream()"] --> B["lazyStream()<br/>认证包装"]
  B --> C["requireProvider()"]
  B --> D["applyAuth()"]
  B --> E["provider.stream()"]
  E --> F["createProvider() 的 dispatch()"]
  F --> G["api: openAIResponsesApi()"]
  G --> H["lazyApi() / lazyStream()<br/>模块加载包装"]
  H --> I["动态 import openai-responses.ts"]
  I --> J["真实 OpenAI 请求与事件转换"]
```
````

1. **`models.stream(model, context, options)`**
   入口在 [models.ts (line 506)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/models.ts:506)。它立即调用第一层 `lazyStream()` 并返回一个空的 `AssistantMessageEventStream` 给调用者。

2. **第一层 `lazyStream()` 包装认证准备**
   后台异步执行：

   - `requireProvider(model)`：按 `model.provider` 找到已注册的 OpenAI Provider；找不到则失败。
   - `applyAuth(model, options)`：解析 API Key / OAuth 等认证，合并认证 headers 与请求 headers，应用 `transformHeaders`，必要时用认证返回的 `baseUrl` 覆盖模型地址。
   - `provider.stream(requestModel, context, requestOptions)`：认证完成后才把规范化后的请求交给 Provider。

   这一层的意义是：认证可能异步，但调用方不用等待。认证失败会变成流中的 `error` 事件。

3. **`createProvider()` 封装 Provider 的路由能力**
   OpenAI Provider 创建时，传入：

   ```
   api: openAIResponsesApi()
   ```

   [createProvider() (line 577)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/models.ts:577) 把它封装为 Provider 的 `stream()` 实现。请求到达后，它用 `model.api` 找对应的协议实现；OpenAI 的模型是 `api: "openai-responses"`，因此取到刚才传入的 `openAIResponsesApi()` 结果。

4. **`openAIResponsesApi()` 提供的其实是第二层懒包装**
   [openai-responses.lazy.ts (line 4)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/api/openai-responses.lazy.ts:4)：

   ```
   lazyApi(() => import("./openai-responses.ts"))
   ```

   `lazyApi()` 返回的 `stream()` 又调用一次 `lazyStream()`。这次不是为认证，而是为了异步加载真实协议模块 `openai-responses.ts`。

5. **真实模块加载与请求执行**
   第二层 `lazyStream()` 在后台执行：

   ```
   const implementation = await import("./openai-responses.ts");
   return implementation.stream(model, context, options);
   ```

   然后 [openai-responses.ts (line 96)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/api/openai-responses.ts:96) 创建 OpenAI SDK client，调用 `client.responses.create(...)`，并将 OpenAI 原始流转为 pi 的统一事件流。

6. **两层流最终被串起来**
   第二层将真实请求流的事件转发给第一层；第一层再转发给用户最初拿到的流。用户看到的始终是一条 `AssistantMessageEventStream`，不会感知中间发生了认证等待、动态模块加载和 Provider 分发。



-> Anthropic 请求最终落到 api 层的 anthropic-messages.lazy.ts 和 anthropic-messages.ts

```ts
Models.stream(model, context, options)
  -> requireProvider(model)
  -> Models.applyAuth()（认证、baseUrl、headers、env 合并）
	-> 找到 owning provider
    -> provider.stream(...)
-> api/anthropic-messages.lazy.ts 懒加载 anthropic-messages.ts
	-> lazy.ts

-> api/anthropic-messages.ts 真正发请求并返回事件流
provider 调 anthropicMessagesApi()

```

```ts
export const openAIResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-responses.ts"));
```



```ts
const model = models.getModel('openai', 'gpt-4o-mini')!;
const s = models.stream(model, context);
const response = await models.complete(model, context);
```

```ts
streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
    return lazyStream(model, async () => {
        const provider = this.requireProvider(model);
        const { requestModel, requestOptions } = await this.applyAuth(model, options);
        return provider.streamSimple(requestModel, context, requestOptions as SimpleStreamOptions);
    });
}
```



这里有四个关键转折点：

1. `Models` 先做 auth 解析和请求参数合并。
2. `transformHeaders` 只属于 `Models`：它在 auth headers、`model.headers` 和显式 `options.headers` 合并后执行，随后会被移除，provider 不会收到这个回调。
3. `lazyStream` 保持“先返回流”的契约；认证、懒加载或 provider 初始化失败会收束成 `error` 事件，而不是让调用点同步抛出。
4. `Provider` 决定 API 实现，`api/*` 负责实际协议请求和事件翻译。



`openAIResponsesApi` 本身不发请求。它的唯一职责，是把真实实现 `openai-responses.ts` 包装成一个“按需加载的 `ProviderStreams`”。

核心代码在 [openai-responses.lazy.ts (line 4)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/api/openai-responses.lazy.ts:4)：

```
export const openAIResponsesApi = (): ProviderStreams =>
  lazyApi(() => import("./openai-responses.ts"));
```

这里最重要的是：`import("./openai-responses.ts")` 被放进了函数里。调用 `openAIResponsesApi()` 时，**不会**加载 `openai-responses.ts`，只是创建了一个 loader 闭包。真实模块以及其中静态引入的 `openai` SDK，等第一次真正流式调用时才加载。

**它如何被挂到 Provider 上**

[providers/openai.ts (line 6)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/providers/openai.ts:6) 创建 OpenAI Provider：

```
return createProvider({
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  auth: { apiKey: envApiKeyAuth(...) },
  models: Object.values(OPENAI_MODELS),
  api: openAIResponsesApi(),
});
```

因此可理解为：

````
```mermaid
flowchart LR
  A["openaiProvider()"] --> B["openAIResponsesApi()"]
  B --> C["lazyApi(() => import('./openai-responses.ts'))"]
  C --> D["ProviderStreams<br/>stream / streamSimple"]
  D --> E["createProvider()"]
  E --> F["Models 中注册的 openai Provider"]
```
````

`createProvider()` 不关心 OpenAI Responses 的具体请求格式；它只保存一个统一的 `ProviderStreams` 接口，并在请求时将模型转发给其中的 `stream()` 或 `streamSimple()`。

**一次 `models.stream()` 的完整调用链**

以 `models.stream(openaiModel, context, options)` 为例：

````mermaid
sequenceDiagram
  participant U as 调用方
  participant M as ModelsImpl.stream
  participant P as OpenAI Provider
  participant L as lazyApi / lazyStream
  participant R as openai-responses.ts
  participant O as OpenAI Responses API

  U->>M: stream(model, context, options)
  M-->>U: 立即返回外层事件流
  M->>M: 异步解析认证、合并 headers
  M->>P: provider.stream(...)
  P->>L: lazyApi.stream(...)
  L-->>M: 立即返回内层事件流
  L->>R: 动态 import openai-responses.ts
  R->>O: client.responses.create(...).withResponse()
  O-->>R: 上游 SSE/事件流
  R-->>L: 标准 AssistantMessageEvent 流
  L-->>M: 转发事件
  M-->>U: 转发同一套事件
````

这里实际存在**两层 `lazyStream()`**：

1. [models.ts (line 512)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/models.ts:512) 的外层
   负责异步认证：读取 API Key、OAuth/认证信息、合并认证头与请求头、应用 `transformHeaders`，再调用 Provider。
2. [lazy.ts (line 119)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/api/lazy.ts:119) 的内层
   负责异步动态导入 `openai-responses.ts`，然后调用其真正的 `stream()`。

两层的目的相同：**API 仍然同步返回 `AssistantMessageEventStream`，但准备工作可以异步进行。** 调用方不必等待认证或模块加载完成，直接就可以 `for await` 消费流。

**`lazyApi()` 到底做了什么**

[lazy.ts (line 119)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/api/lazy.ts:119) 将 loader 转成统一接口：

```
export function lazyApi(load): ProviderStreams {
  return {
    stream: (model, context, options) =>
      lazyStream(model, async () => (await load()).stream(model, context, options)),
    streamSimple: (model, context, options) =>
      lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
  };
}
```

所以第一次调用 `provider.stream()` 时才发生：

```
await import("./openai-responses.ts")
```

导入完成后，取模块导出的 `stream`：

```
(await load()).stream(model, context, options)
```

而后续请求虽然还会执行 `load()`，但运行时的 ES Module 缓存会复用已经加载的模块；这里没有自己维护一个 `Promise` 缓存，依赖宿主模块系统的缓存与并发去重能力。

**真实请求在哪里发生**

在 [openai-responses.ts (line 96)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/api/openai-responses.ts:96) 的真实 `stream()` 中：

1. 根据已解析的 `apiKey`、headers、`baseUrl` 创建 `OpenAI` SDK client。
2. 将 `Context`、工具、推理参数等组装为 Responses API 请求参数。
3. 调用：

```
client.responses.create(params, requestOptions).withResponse()
```

1. 用 `processResponsesStream()` 把 OpenAI 原始事件转换成 pi 统一的 `AssistantMessageEvent`。
2. 输出 `start`、文本/工具调用增量事件、`done` 或 `error`。

`streamSimple()` 则在 [openai-responses.ts (line 174)](/Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/pi/packages/ai/src/api/openai-responses.ts:174) 先把跨 Provider 的简化参数转换为 OpenAI Responses 专用参数，随后仍复用同一个 `stream()`。它不是另一套网络实现。

**错误语义也被统一了**

认证失败、动态 `import()` 失败、Provider 缺少对应 API 实现，均不会在调用 `models.stream()` 的那个同步瞬间直接 `throw`。`lazyStream()` 会把它们转换为终止性的 `error` 事件，并关闭流。这样调用方只需按统一流协议处理失败，无需分别处理“请求前异步失败”和“请求中失败”。

一句话总结：`openai-responses.lazy.ts` 是 Provider 与重量级协议实现之间的延迟边界；它让 Provider 可以在启动时完成注册，而只有真正请求 OpenAI Responses 模型时，才加载 SDK 实现、创建 client、发出网络请求。

### 文本流式请求主链

```
外部调用:
  models.stream(model, context, options)

运行时层 (models.ts):
  ModelsImpl.stream()
    -> lazyStream(...)                // 立即返回外层事件流
    -> requireProvider(model)        // 找到所属 provider
    -> applyAuth(model, options)      // 解析认证 + 合并 baseUrl / headers / env
       -> auth.headers + model.headers + options.headers
       -> options.transformHeaders?() // 仅 Models 消费的最后一层 headers 变换
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
  -> 协议事件 → AssistantMessageEvent

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

图片 API 和文本 API 结构是平行的。`ImagesModels.generateImages()` 同样会先解析认证并合并请求选项；直接调用 `generateImages()` 则只按 `ImagesApi` 注册表分派。两者共享的是：

- 模型元信息设计
- options 设计
- usage/cost 设计
- 注册表模式

图片侧相对文本侧简化了：

- 不需要 `EventStream`
- 不需要 `AssistantMessageEvent`
- 不需要 tool call

## 阅读建议

1. 先读协议层
   - `types.ts`：消息、事件、模型与 options 的边界

2. 再读运行时核心层
   - `models.ts`：`Models`、`Provider`、认证合并、动态模型刷新与 provider 分派
   - `api/lazy.ts`：`lazyApi`、`lazyStream` 如何把异步初始化转换为事件流错误

3. 再读流式基础设施
   - `utils/event-stream.ts`

4. 精读一个 API 实现样板
   - `api/openai-responses.ts`
   - `api/openai-responses-shared.ts`

5. 然后看一个 provider 装配样板
   - `providers/anthropic.ts`
   - `providers/openai.ts`

6. 最后看总装配层
   - `providers/all.ts`（`builtinModels()` / `builtinProviders()`）

7. 需要图片时再读 `images-models.ts`、`images.ts` 与 `images-api-registry.ts`；最后横向比较其他 API/provider 的差异。

## 一、核心类型层 `types.ts`

### 1、API / ImagesApi / ProviderId / ImagesProviderId / Thinking 推理级别 / 统一 options — 协议标识与请求配置

#### API 协议标识

```typescript
/** 内置文本 provider 的 API 协议名。 */
export type KnownApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  ...
/** API 协议的完整类型 = 内置值 + 任意自定义字符串。 */
export type Api = KnownApi | (string & {}); // 允许外部扩展方注册自己的 provider

/** 内置图片生成 provider 的 API 协议名。 */
export type KnownImagesApi = "openrouter-images";

/** 图片 API 协议的完整类型，同样允许自定义扩展。 */
export type ImagesApi = KnownImagesApi | (string & {});
```

#### Provider 服务商标识

注意：`KnownProvider` 是服务商名称的内置字符串联合，`ProviderId = KnownProvider | string` 允许自定义 provider；它们不涉及请求实现。

```typescript
/** 内置文本 provider 标识。Provider 表示服务商，不是具体 API 协议。 */
export type KnownProvider =
	| "anthropic"
	| "openai"
	| "deepseek"
	...
export type ProviderId = KnownProvider | string;

/** 内置图片生成服务商标识。 */
export type KnownImagesProvider = "openrouter";
export type ImagesProviderId = KnownImagesProvider | string;
```

这里的 `provider` 只是模型所属服务商 ID；真正的请求实现由 `ProviderStreams` 承载，并由 provider 工厂直接持有。图片侧则使用独立的 `images-api-registry.ts` 按 `ImagesApi` 注册和查找实现。

#### Thinking 推理级别

```typescript
/** `pi-ai` 对外提供的统一推理档位。 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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

/** `chat_template_kwargs` 的值；`$var` 由运行时注入当前 thinking 状态。 */
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort";
			/** thinking 关闭时是否省略该参数。 */
			omitWhenOff?: boolean;
	  };
```

#### 传输方式与缓存策略

都是给具体 `api/*.ts` 实现消费的通用配置或字段类型。

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

/** provider 级环境变量覆写，优先级高于 `process.env`。 */
export type ProviderEnv = Record<string, string>;

/** provider 级 HTTP 请求头覆写；`null` 表示抑制同名默认头。 */
export type ProviderHeaders = Record<string, string | null>;

/** session-affinity 头的传递格式。 */
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

/** `onResponse` 接收的统一 HTTP 响应信息。 */
export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}
```

#### 统一请求选项

* `StreamOptions`：所有文本 provider 共享的基础请求选项。
* `SimpleStreamOptions extends StreamOptions`：简化入口使用的统一 options，更偏"上层统一抽象"，增加了 reasoning / thinkingBudgets。
* `ProviderStreamOptions = StreamOptions & Record<string, unknown>`：Provider 级完整 options，在统一的 StreamOptions 基础上允许附加任意字段，给各 provider 自己扩展。

```typescript
/**
 * 所有文本 provider 共享的基础请求选项。
 *
 * 设计目标：
 * - 给 `stream()` / `streamSimple()` 一套尽量统一的参数面
 * - 把 provider 特有参数留给各自的 `XxxOptions`（如 AnthropicOptions）
 *
 * 调用链：
 * - 上层应用 / agent 先构造 `StreamOptions`
 * - `Models` 在认证与选项合并后转给 provider
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
	/** 自定义 HTTP headers；值为 null 时可抑制同名默认 header。 */
	headers?: ProviderHeaders;
	/** HTTP 请求超时（毫秒）。例如 OpenAI / Anthropic SDK 默认 10 分钟。 */
	timeoutMs?: number;
	/** 支持 WebSocket 的 provider 的连接握手超时（毫秒）。 */
	websocketConnectTimeoutMs?: number;
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
	/** 仅对当前 provider 生效的环境变量覆盖，优先于 process.env。 */
	env?: ProviderEnv;
}

/** Provider 级完整 options。在统一的 StreamOptions 基础上允许附加任意字段，给各 provider 自己扩展。 */
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
	/** 自定义 HTTP headers；值为 null 时可抑制默认 header。 */
	headers?: ProviderHeaders;
	/** HTTP 请求超时（毫秒）。 */
	timeoutMs?: number;
	/** 客户端最大重试次数。 */
	maxRetries?: number;
	/** 最大重试延迟（毫秒）。 */
	maxRetryDelayMs?: number;
	/** 可选的请求元数据。 */
	metadata?: Record<string, unknown>;
	/** 仅对当前 provider 生效的环境变量覆盖。 */
	env?: ProviderEnv;
}

/** Provider 级完整图片 options。在 ImagesOptions 基础上允许任意扩展字段。 */
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

当前实现还通过 `ApiOptionsMap` 和条件类型 `ApiStreamOptions<TApi>` 保留已知协议的专属 options：例如 `Model<"anthropic-messages">` 传给 `Models.stream()` 时能得到 `AnthropicOptions`，自定义 API 字符串则安全地回退为通用 options。

```typescript
/** 每个内置文本协议所对应的完整 options 类型。 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	...
}

export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;
```

`onPayload` 和 `onResponse` 是一对回调函数：

* `onPayload` 在 provider 构造好请求体、发送给 API 之前 触发，让你可以拦截或修改请求参数。

  `payload` 就是 **pi-ai 已经把 `model + context + options` 翻译成某个上游 API 所需请求体之后的对象**。它不是统一固定结构，而是随 `model.api` 改变。它主要用于：

  1. 观察最终实际发出的请求体；
  2. 注入某个 provider 支持、但 `StreamOptions` 未统一建模的字段；
  3. 临时修正或删除请求体字段。

  ```ts
  Context / StreamOptions
    ↓
  provider 的 buildParams() / buildRequestBody()
    ↓
  payload            ← onPayload 在这里拿到它
    ↓
  SDK / HTTP 请求发送
  ```

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

  `response` 则是响应头对象。
  
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

`StreamFunction` 的错误契约也值得单独记住：一旦函数已被调用，请求、模型或运行时错误应通过返回的 `AssistantMessageEventStream` 表达，最终消息使用 `stopReason: "error" | "aborted"` 并携带 `errorMessage`。这使 `Agent` 等上层始终可以按同一套事件协议处理成功、失败和取消。

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
 */
export interface AssistantMessage {
    /** 固定值。与 `UserMessage`（`role: "user"`）和 `ToolResultMessage`（`role: "toolResult"`）一起构成三种消息类型，用于对话历史的类型区分。 */
	role: "assistant";
    /** 内容数组。一次响应可以包含多种类型的内容块：纯文本（`TextContent`）、思考过程（`ThinkingContent`）、工具调用（`ToolCall`）。数组的顺序对应模型输出的顺序。 */
	content: (TextContent | ThinkingContent | ToolCall)[];
	/** 使用的 API 协议名。 */
	api: Api;
	/** 服务提供商名。 */
	provider: ProviderId;
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

/** 工具执行结果消息。 */
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
	/** 工具自身的用量；不计入主 LLM 上下文统计。 */
	usage?: Usage;
	/** 从当前 transcript 位置起变为可用的延迟加载工具名称。 */
	addedToolNames?: string[];
	/** 是否为错误结果。 */
	isError: boolean;
	/** Unix 时间戳（毫秒）。 */
	timestamp: number;
}
```

#### `content` 内容块

```typescript
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

/** 图片块，统一使用 base64 + MIME 类型。 */
export interface ImageContent {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // 如 "image/jpeg"、"image/png"
}

/** 统一工具调用块。 */
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
	/** cacheWrite 中采用 1 小时保留期的子集（目前仅 Anthropic 可报告）。 */
	cacheWrite1h?: number;
	/** 推理 token 数；它是 output 的子集，不是额外输出。 */
	reasoning?: number;
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

在实现自己的工具执行循环时，使用 `validateToolCall`（来自 utils/validation.ts）在将参数传递给工具前进行验证：

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
	provider: ImagesProviderId;
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
/** AssistantMessageEventStream 的事件协议。 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
```

完整事件联合包含 `start`、文本/思考/工具调用的 `*_start`、`*_delta`、`*_end`，以及终结事件 `done` / `error`。所有增量事件携带同一个正在拼装的 `partial` 消息；`done` 携带成功的 `message`，`error` 携带 `stopReason` 为 `error` 或 `aborted` 的最终消息。`AssistantMessageEventStream` 同时支持 `for await` 和 `result()`，后者返回终结消息。

### 4、OpenAI / Anthropic 兼容层配置 — provider 差异化的兼容选项

不同 provider 的 API 存在细微差异。这些 Compat 接口允许调用方覆盖基于 URL 的自动检测，为自定义 provider 指定兼容行为。

```typescript
/** OpenAI Completions API 兼容配置。未设定字段由 URL 自动检测或使用默认值。 */
export interface OpenAICompletionsCompat {
	supportsStore?: boolean;
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	supportsUsageInStreaming?: boolean;
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	requiresToolResultName?: boolean;
	requiresAssistantAfterToolResult?: boolean;
	requiresThinkingAsText?: boolean;
	requiresReasoningContentOnAssistantMessages?: boolean;
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling";
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	openRouterRouting?: OpenRouterRouting;
	vercelGatewayRouting?: VercelGatewayRouting;
	zaiToolStream?: boolean;
	supportsStrictMode?: boolean;
	cacheControlFormat?: "anthropic";
	sendSessionAffinityHeaders?: boolean;
	sessionAffinityFormat?: SessionAffinityFormat;
	supportsLongCacheRetention?: boolean;
}

/** OpenAI Responses API 兼容配置。 */
export interface OpenAIResponsesCompat {
	supportsDeveloperRole?: boolean;
	sessionAffinityFormat?: SessionAffinityFormat;
	supportsLongCacheRetention?: boolean;
	supportsToolSearch?: boolean;
}

/** Anthropic Messages API 兼容配置。 */
export interface AnthropicMessagesCompat {
	supportsEagerToolInputStreaming?: boolean;
	supportsLongCacheRetention?: boolean;
	sendSessionAffinityHeaders?: boolean;
	supportsCacheControlOnTools?: boolean;
	supportsTemperature?: boolean;
	forceAdaptiveThinking?: boolean;
	allowEmptySignature?: boolean;
	supportsToolReferences?: boolean;
}
```

`OpenAICompletionsCompat` 的各开关分别控制 `store`、`developer` 角色、`reasoning_effort`、流式 usage、最大 token 字段、工具回放消息和 thinking 编码等协议差异。`thinkingFormat` 决定具体请求字段；当它为 `chat-template` 时，`chatTemplateKwargs` 用上节的 `$var` 占位符构造 `chat_template_kwargs`。`sessionAffinityFormat` 仅控制会话亲和请求头，不改变由 `cacheRetention` 控制的缓存 body 参数。

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
	provider: ProviderId;
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
	cost: ModelCost; // 费率外还可带按输入量切换的 tiers
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
		: TApi extends "openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: never;
}

/**
 * 图片模型元信息。
 * 复用 Model 的大部分字段，去掉文本模型专属能力（reasoning、contextWindow、maxTokens、compat）。
 * 因此仍继承 id、name、baseUrl、thinkingLevelMap、input、cost、headers。
 */
export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	/** 使用的图片 API 协议名。 */
	api: TApi;
	/** 图片服务提供商名。 */
	provider: ImagesProviderId;
	/** 支持的输出类型（文本 / 图片）。 */
	output: ("text" | "image")[];
}
```

### 6、函数类型与 API 实现契约 — StreamFunction / ImagesFunction / ProviderStreams / ProviderImages

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

/** 文本 API 实现模块的运行时契约。 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/** 图片 API 实现模块的运行时契约。 */
export interface ProviderImages {
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}
```

`StreamFunction` 与 `ImagesFunction` 描述单个可调用函数的形状；`ProviderStreams` 与 `ProviderImages` 则描述一个 API 实现模块必须提供的整组能力。文本协议实现必须提供 `stream()`、`streamSimple()`，图片协议实现提供 `generateImages()`。provider 工厂既可以保存单个实现，也可以保存按 `model.api` 键控的实现表，以支持 GitHub Copilot、OpenCode 等混合协议 provider。

和具体实现的关系可以这样理解：

```text
StreamFunction         = 函数类型（描述长相）
stream()               = 一个具体实现
streamSimple()         = 另一个具体实现
provider.stream()      = 更底层的具体实现
```

例如 `ProviderStreams`、具体 `api/*.ts` 模块与 `Models` 集合都提供同形的 `stream()` / `streamSimple()`：

- `stream(model, context, options?: ApiStreamOptions<TApi>)`
- `streamSimple(model, context, options?: SimpleStreamOptions)`

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

每个 provider 都拥有自己的认证：API 密钥如何解析（存储的凭据、环境变量、环境来源如 AWS 配置文件或 gcloud ADC），以及在支持的情况下，OAuth 登录/刷新流程。

#### 认证解析流程

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

#### 转换请求头

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

#### 凭据存储

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

#### 环境变量

内置 provider 解析以下环境变量（Node.js；浏览器中请显式传入 `apiKey`）：



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



### Provider 工厂函数：给某个 API 实现绑上一组模型目录 + 一套认证方式

Provider 工厂函数导入其模型目录和懒加载 API 包装器，不会导入其他 provider。配合打包器的代码分割功能，SDK 实现（`@anthropic-ai/sdk`、`openai`、`@google/genai` 等）将保持在懒加载分块中，在首次请求该 API 的模型时才加载。

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



### 动态 Provider

Provider 可以拥有动态模型列表（如 llama.cpp 服务器、实时的 OpenRouter 列表）。读取保持同步；获取是显式的异步操作：

```typescript
// getModels() 返回最新已知列表（首次刷新前为空）
await models.refresh('llamacpp');        // 获取一个 provider 的列表；失败则拒绝
await models.refresh();                  // 并发刷新所有 provider，尽力模式
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置 provider 的 `refresh()` 是无操作的。构建动态 provider 参见 [createProvider()](#createprovider)。



#### 具体实现

Provider 工厂导入对应厂商的模型目录和一个懒加载 API 包装器。

通过 `anthropicProvider()` 创建真正的 provider。

它做的事很像“装配”：

- 从 anthropic.models.ts 读出 ANTHROPIC_MODELS 数据
- 配置认证方式，既支持 ANTHROPIC_API_KEY ，也支持 OAuth
- 指定这个 provider 的 API 实现来自 anthropicMessagesApi()
- 最后调用 createProvider 变成统一 Provider



每个 provider 绑定认证策略、模型目录以及一个或按 `model.api` 分派的多个 `ProviderStreams` 实现。

> 大多数内置 provider 使用构建期生成的静态模型目录，不过构建 provider 时也可以不提供静态目录，而是通过 `refreshModels()` 获得模型，即动态 provider。

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





`createProvider()` 的 `api` 参数支持两种形状：

```
api: ProviderStreams
```

表示这个 provider 的所有模型都走同一套协议实现。比如 Anthropic：

```
api: anthropicMessagesApi()
```

无论是 Claude Sonnet 还是 Opus，`model.api` 都是 `"anthropic-messages"`，都使用同一个 `ProviderStreams`，其中包含 `stream()` 和 `streamSimple()`。

另一种是映射表：

```
api: {
  "openai-responses": openaiResponsesApi(),
  "openai-completions": openaiCompletionsApi(),
}
```

表示同一个 provider 下的不同模型，可能要走不同的上游协议。运行时 `createProvider()` 会根据当前模型的 `model.api` 选择：

```
const streams = api[model.api];
return streams.stream(model, context, options);
```

这正是“按 `model.api` 分派多个 `ProviderStreams` 实现”的意思。

它适合混合协议的 provider：同一个登录方式、同一组服务商配置下，有些模型走 OpenAI Responses API，另一些走 OpenAI Completions、Anthropic Messages 或别的协议。这样 provider 层继续统一管理认证和模型目录，协议差异只留在 API 分派处。



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

### 

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
