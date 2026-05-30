# `packages/ai` 源码分层解析

这份文档的目标不是教你“怎么调用 `pi-ai`”，而是帮你从**开发者和维护者**的视角，系统地理解 `packages/ai` 这个模块：

- 它在整个 monorepo 里的定位是什么
- 它的代码是如何分层的
- 每个源码文件负责什么
- 从一次真实请求出发，代码会按什么链路运行
- 如果你以后要给 `pi-ai` 加 provider、改协议、改模型元信息，应该从哪一层下手

如果你已经读过这些文件的中文注释，这份文档会更容易吸收：

- [stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/stream.ts)
- [api-registry.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/api-registry.ts)
- [register-builtins.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/register-builtins.ts)
- [openai-responses.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses.ts)
- [openai-responses-shared.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses-shared.ts)
- [types.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/types.ts)

---

## 1. `packages/ai` 在整个项目里的定位

`packages/ai` 是整个 `pi` monorepo 的 **统一 LLM API 层**。

它解决的问题不是“做一个 CLI”或者“做一个 agent loop”，而是更底层的：

> 用一套统一的模型、消息、工具、流式事件协议，屏蔽掉 OpenAI / Anthropic / OpenRouter 之间的协议差异。

也就是说，它对上暴露的是：

- 统一模型查询接口
- 统一的 `stream()` / `complete()` / `streamSimple()` / `completeSimple()`
- 统一的 `AssistantMessage`
- 统一的 `AssistantMessageEventStream`
- 统一的工具 schema / tool call / tool result 协议
- 统一的 usage / cost / abort / cache / reasoning 抽象

而对下，它要做的是：

- 跟不同 provider 的 SDK / HTTP API 打交道
- 构造每家自己的 payload
- 把每家的增量流式事件翻译回统一协议
- 兼容跨 provider 的上下文 handoff

如果用一句话概括：

> `packages/ai` 是 `pi` 里“模型层 + provider 层 + 协议翻译层”的合集。

---

## 2. 整个包的分层图

如果从底层往上层看，`packages/ai/src` 可以分成 6 层：

```text
6. 对外入口层
   index.ts / stream.ts / images.ts

5. provider 适配层
   providers/*.ts / providers/images/*.ts

4. 注册表与模型元信息层
   api-registry.ts / images-api-registry.ts / models.ts / image-models.ts
   env-api-keys.ts / session-resources.ts

3. 核心协议层
   types.ts

2. 共享基础设施层
   utils/event-stream.ts / validation.ts / json-parse.ts / headers.ts / ...

1. 生成与数据输入层
   models.generated.ts / image-models.generated.ts
   scripts/generate-models.ts / scripts/generate-image-models.ts
```

最重要的理解是：

- **底层层级越低，越不关心具体业务，只关心通用基础设施**
- **越往上，越接近“调用者眼中的 API”和“provider 协议细节”**

---

## 4. 先看 3 条主调用链

在读文件表之前，先把运行方式建立起来。

### 4.1 文本流式请求主链

最常见的一条链是：

```text
外部调用:
  streamSimple(model, context, options)

入口层:
  src/stream.ts
    -> resolveApiProvider(model.api)

注册表层:
  src/api-registry.ts
    -> getApiProvider(api)

内置 provider 注册层:
  src/providers/register-builtins.ts
    -> 返回懒加载包装器
    -> 第一次请求时动态 import 真实 provider

provider 层:
  src/providers/openai-responses.ts
    -> createClient()
    -> buildParams()
    -> OpenAI SDK 发请求
    -> processResponsesStream()

共享翻译层:
  src/providers/openai-responses-shared.ts
    -> SDK 事件 -> AssistantMessageEvent
    -> 最终组装 AssistantMessage

返回上游:
  AssistantMessageEventStream
    -> for await 消费增量
    -> result() 拿最终消息
```

### 4.2 非流式文本请求主链

```text
completeSimple()
  -> streamSimple()
  -> provider 流式实现
  -> await stream.result()
```

也就是说，`complete()` / `completeSimple()` 并不是另一套 provider 实现，而是**复用流式链路**，只是不消费中间事件。

### 4.3 图片生成主链

```text
generateImages(model, context, options)
  -> src/images.ts
  -> src/images-api-registry.ts
  -> src/providers/images/register-builtins.ts
  -> src/providers/images/openrouter.ts
  -> OpenAI SDK Chat Completions 兼容接口
  -> AssistantImages
```

图片 API 和文本 API 是分开的，两者共享的是：

- 模型元信息设计
- options 设计
- usage/cost 设计
- 注册表模式

---

## 5. 顶层目录怎么读

`packages/ai` 顶层大致可以分成这几块：

| 路径 | 作用 |
|---|---|
| `src/` | 运行时代码，核心关注点 |
| `scripts/` | 生成模型元信息、测试资源 |
| `test/` | provider 行为、兼容性、回归测试 |
| `README.md` | 面向库使用者的说明 |
| `package.json` | 包导出、构建脚本、依赖 |

推荐阅读顺序：

1. `src/`
2. `scripts/`
3. `test/`
4. `README.md`

---

## 6. `src/` 顶层文件总览

这一节先看 `src/` 根目录文件，不进入 `providers/` 和 `utils/`。

### 6.1 顶层文件地图

| 文件 | 定位 | 核心功能 / 关键导出 | 主要被谁调用 | 它主要调用谁 |
|---|---|---|---|---|
| [index.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/index.ts) | 包公共入口 | 统一 re-export 所有公共 API | `packages/agent`、`packages/coding-agent`、外部 npm 使用者 | 各子模块 |
| [types.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/types.ts) | 核心协议文件 | `Model`、`Context`、`AssistantMessage`、`AssistantMessageEvent`、`StreamOptions` | 几乎所有源码文件 | 无运行时调用 |
| [stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/stream.ts) | 文本入口调度层 | `stream`、`complete`、`streamSimple`、`completeSimple` | 外部调用者、`packages/agent` | `api-registry.ts` |
| [images.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/images.ts) | 图片入口调度层 | `generateImages` | 外部调用者 | `images-api-registry.ts` |
| [api-registry.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/api-registry.ts) | 文本 provider 注册表 | `registerApiProvider`、`getApiProvider` | `stream.ts`、`providers/register-builtins.ts` | 包装已注册 provider |
| [images-api-registry.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/images-api-registry.ts) | 图片 provider 注册表 | `registerImagesApiProvider`、`getImagesApiProvider` | `images.ts`、图片 provider 注册层 | 包装图片 provider |
| [models.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/models.ts) | 文本模型注册表 | `getModel`、`getModels`、`getProviders`、`calculateCost`、`clampThinkingLevel` | 外部调用者、provider、agent | `models.generated.ts` |
| [image-models.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/image-models.ts) | 图片模型注册表 | `getImageModel`、`getImageModels`、`getImageProviders` | 外部调用者 | `image-models.generated.ts` |
| [models.generated.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/models.generated.ts) | 生成产物 | 文本模型元信息常量 `MODELS` | `models.ts` | 无 |
| [image-models.generated.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/image-models.generated.ts) | 生成产物 | 图片模型元信息常量 `IMAGE_MODELS` | `image-models.ts` | 无 |
| [env-api-keys.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/env-api-keys.ts) | 认证发现层 | `findEnvKeys`、`getEnvApiKey` | provider、外部调用者 | Node/Bun 环境变量 / ADC / AWS 凭证来源 |
| [session-resources.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/session-resources.ts) | 会话资源清理注册表 | `registerSessionResourceCleanup`、`cleanupSessionResources` | 需要维护 session 资源的 provider | cleanup 回调集合 |

### 6.2 这一层怎么理解

这一层可以再分成 4 个角色：

1. **公共入口**
   - `index.ts`

2. **调度层**
   - `stream.ts`
   - `images.ts`
   - `api-registry.ts`
   - `images-api-registry.ts`

3. **元信息层**
   - `models.ts`
   - `image-models.ts`
   - `models.generated.ts`
   - `image-models.generated.ts`
   - `env-api-keys.ts`

4. **协议与会话辅助**
   - `types.ts`
   - `session-resources.ts`

---

## 7. `providers/` 目录总览

`providers/` 是这个包最“厚”的一层。

这里的每个文件都在做一件类似的事情：

> 把 `pi-ai` 的统一消息 / 工具 / 事件协议，翻译成某家 provider 的请求与响应协议。

### 7.1 provider 文件地图

| 文件 | 定位 | 核心功能 / 关键方法 | 主要被谁调用 | 它主要调用谁 |
|---|---|---|---|---|
| [register-builtins.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/register-builtins.ts) | 内置文本 provider 注册层 | `registerBuiltInApiProviders`、`resetApiProviders`、懒加载包装器 | `stream.ts` 通过副作用导入 | `api-registry.ts`、各 provider 动态 import |
| [openai-responses.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses.ts) | OpenAI Responses 主实现 | `streamOpenAIResponses`、`streamSimpleOpenAIResponses`、`createClient`、`buildParams` | `register-builtins.ts` | OpenAI SDK、`openai-responses-shared.ts` |
| [openai-responses-shared.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses-shared.ts) | OpenAI Responses 共享翻译层 | `convertResponsesMessages`、`convertResponsesTools`、`processResponsesStream` | `openai-responses.ts` | `transform-messages.ts`、`json-parse.ts` |
| [openai-completions.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-completions.ts) | OpenAI Chat Completions 兼容实现 | `streamOpenAICompletions`、`streamSimpleOpenAICompletions` | `register-builtins.ts` | OpenAI SDK、若干兼容 helper |
| [anthropic.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/anthropic.ts) | Anthropic Messages 实现 | `streamAnthropic`、`streamSimpleAnthropic` | `register-builtins.ts` | Anthropic SDK |
| [openai-prompt-cache.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-prompt-cache.ts) | OpenAI prompt cache helper | cache key 规范化 | OpenAI provider | sessionId 等 |
| [simple-options.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/simple-options.ts) | `streamSimple()` 统一参数桥 | `buildBaseOptions`、`adjustMaxTokensForThinking` | 各 provider 的 `streamSimple*` | `types.ts` |
| [transform-messages.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/transform-messages.ts) | 跨 provider 上下文转换层 | `transformMessages` | 多个 provider 的 buildParams 阶段 | 统一消息协议 |
| [faux.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/faux.ts) | 测试 / 演示 provider | `registerFauxProvider`、`fauxAssistantMessage`、`fauxText` 等 | 测试、演示代码 | `api-registry.ts` |

### 7.2 provider 层内部还有 3 类角色

虽然 provider 文件很多，但它们其实是 3 种角色。

#### 1. 真正发请求的 provider

例如：

- `openai-responses.ts`
- `openai-completions.ts`
- `anthropic.ts`

它们负责：

- 认证
- SDK client
- payload
- SDK / HTTP 流式请求
- 事件翻译
- done / error 收口

#### 2. provider 共享 helper

例如：

- `openai-responses-shared.ts`
- `simple-options.ts`
- `transform-messages.ts`
- `openai-prompt-cache.ts`

它们负责把“公共复杂度”从主 provider 文件里剥出来。

#### 3. provider 注册 / 测试支撑

例如：

- `register-builtins.ts`
- `faux.ts`

---

## 8. `providers/images/` 目录总览

目前图片生成这条链相对简单，只有 OpenRouter 这一套内置实现。

| 文件 | 定位 | 核心功能 | 主要被谁调用 | 它主要调用谁 |
|---|---|---|---|---|
| [register-builtins.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/images/register-builtins.ts) | 图片 provider 注册层 | `registerBuiltInImagesApiProviders`、懒加载包装 | `images.ts` 通过副作用导入 | `images-api-registry.ts` |
| [openrouter.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/images/openrouter.ts) | OpenRouter 图片实现 | `generateImagesOpenRouter`、`buildParams`、`parseUsage` | 图片 provider 注册层 | OpenAI SDK Chat Completions 兼容接口 |

图片 API 和文本 API 的结构是平行的，只是简化了：

- 不需要 `EventStream`
- 不需要 `AssistantMessageEvent`
- 不需要 tool call

---

## 9. `utils/` 目录总览

`utils/` 是整个包最底层的基础设施层。

特点是：

- 它们通常**不直接知道某个 provider 是谁**
- 更偏通用逻辑或协议辅助
- provider 层大量依赖它们

### 9.1 `utils/` 文件地图

| 文件 | 定位 | 核心功能 / 关键方法 | 主要被谁调用 |
|---|---|---|---|
| [event-stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/event-stream.ts) | 流式事件引擎 | `EventStream`、`AssistantMessageEventStream` | 所有文本 provider |
| [diagnostics.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/diagnostics.ts) | 诊断结构辅助 | `AssistantMessageDiagnostic` 及相关帮助方法 | provider、错误恢复逻辑 |
| [headers.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/headers.ts) | HTTP 头规范化 | `headersToRecord` 等 | provider 的 `onResponse` |
| [json-parse.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/json-parse.ts) | 流式 JSON 容错解析 | `parseStreamingJson` | tool call 流式参数解析 |
| [hash.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/hash.ts) | 短哈希工具 | `shortHash` | tool call id 规范化、cache key |
| [sanitize-unicode.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/sanitize-unicode.ts) | Unicode 清洗 | `sanitizeSurrogates` | 多数 provider |
| [validation.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/validation.ts) | 工具参数校验 | `validateToolCall` 等 | 外部调用者、agent loop |
| [typebox-helpers.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/typebox-helpers.ts) | TypeBox 语法辅助 | `StringEnum` 等 | 外部调用者、tool schema |
| [overflow.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/overflow.ts) | 上下文溢出辅助 | 溢出检测 / 相关错误处理 | provider、上层逻辑 |
| [node-http-proxy.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/node-http-proxy.ts) | 代理请求支持 | Node 侧 HTTP/HTTPS proxy | 需要代理的 provider |

### 9.2 这一层最关键的是谁

如果只选一个最值得精读的基础设施文件，就是：

- [event-stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/event-stream.ts)

它解释了为什么：

- provider 可以立刻返回一个流对象
- 调用者可以 `for await`
- 调用者又可以 `await result()`

它是整个流式协议的底座。

---

## 10. `scripts/` 目录总览

`scripts/` 不是运行时核心逻辑，但它对模型系统至关重要。

| 文件 | 定位 | 功能 |
|---|---|---|
| [generate-models.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/scripts/generate-models.ts) | 文本模型元信息生成脚本 | 拉取 provider/model 数据，生成 `models.generated.ts` |
| [generate-image-models.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/scripts/generate-image-models.ts) | 图片模型元信息生成脚本 | 生成 `image-models.generated.ts` |
| [generate-test-image.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/scripts/generate-test-image.ts) | 测试资源脚本 | 生成测试用图片资源 |

这几份脚本解释了一个关键事实：

> `pi-ai` 的模型列表不是运行时从远端实时拉的，而是构建时生成到代码里的。

这就是为什么：

- `getModel()` 查询很快
- IDE 可以获得强类型提示
- 模型元信息可以直接参与 cost / compat / reasoning 逻辑

---

## 11. `test/` 目录怎么帮助你读源码

`test/` 不只是验证代码是否正确，它也是最好的“行为索引”。

### 11.1 测试目录透露出的关注点

从测试文件名就能看出这个包重点保证哪些能力：

- `abort.test.ts`
  - 中断请求
- `cross-provider-handoff.test.ts`
  - 跨 provider 上下文交接
- `openai-responses-*`
  - OpenAI Responses 的细节兼容
- `tool-call-without-result.test.ts`
  - 工具调用回放的边界情况
- `image-tool-result.test.ts`
  - 工具结果中的图片
- `lazy-module-load.test.ts`
  - provider 懒加载
- `validation.test.ts`
  - 工具参数校验

### 11.2 推荐按主题读测试

| 想理解什么 | 推荐先看哪些测试 |
|---|---|
| 流式主链 | `stream.test.ts`、`abort.test.ts` |
| OpenAI Responses | `openai-responses-*` |
| OpenAI Completions 兼容层 | `openai-completions-*` |
| 跨 provider handoff | `cross-provider-handoff.test.ts` |
| 工具与图片 | `image-tool-result.test.ts`、`tool-call-without-result.test.ts` |
| 模型 / 认证发现 | `env-api-keys.test.ts` |

---

## 12. 从底层到上层，最推荐的源码阅读顺序

如果你想真正理解这个包，我建议按下面顺序读，而不是按文件名随便跳。

### 第一阶段：先建立协议与入口认知

1. [types.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/types.ts)
2. [index.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/index.ts)
3. [stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/stream.ts)
4. [images.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/images.ts)

目标：

- 知道对外有哪些 API
- 知道 `Model` / `Context` / `AssistantMessage` / `AssistantMessageEvent` 的关系

### 第二阶段：读注册表与模型元信息

1. [api-registry.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/api-registry.ts)
2. [images-api-registry.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/images-api-registry.ts)
3. [models.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/models.ts)
4. [image-models.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/image-models.ts)
5. [env-api-keys.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/env-api-keys.ts)

目标：

- 知道 provider 是如何被查到的
- 知道模型元信息从哪里来
- 知道 API key 是怎么被发现的

### 第三阶段：读流式底座

1. [event-stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/event-stream.ts)
2. [json-parse.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/json-parse.ts)
3. [validation.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/validation.ts)

目标：

- 理解为什么可以边流边拿 partial message
- 理解 tool call 参数为什么能流式部分解析

### 第四阶段：只精读一个代表 provider

建议选择：

1. [register-builtins.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/register-builtins.ts)
2. [openai-responses.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses.ts)
3. [openai-responses-shared.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses-shared.ts)
4. [transform-messages.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/transform-messages.ts)
5. [simple-options.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/simple-options.ts)

目标：

- 看清 provider 的真实运行方式
- 理解消息转换、工具转换、SDK 事件翻译

### 第五阶段：横向扫其它 provider

建议顺序：

1. [openai-completions.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-completions.ts)
2. [anthropic.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/anthropic.ts)

目标：

- 找差异点，而不是重复细读

横向看时重点比较：

- 请求 payload 差异
- 工具 schema 差异
- tool call 流格式差异
- thinking / reasoning 差异
- 认证差异

---

## 13. 如果你要新增一个 provider，真正会改哪些地方

从源码结构上看，一次新增 provider 至少会影响下面几层：

### 13.1 协议层

- [types.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/types.ts)

你可能要改：

- `KnownApi`
- `KnownProvider`
- provider 专属 `XxxOptions`
- 兼容层配置接口

### 13.2 provider 实现层

新增：

- `src/providers/your-provider.ts`

至少要实现：

- `streamYourProvider()`
- `streamSimpleYourProvider()`

### 13.3 注册层

改：

- [register-builtins.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/register-builtins.ts)

你要补：

1. `loadYourProviderModule()`
2. `streamYourProvider` / `streamSimpleYourProvider`
3. `registerBuiltInApiProviders()` 中的注册逻辑

### 13.4 模型元信息层

改：

- [generate-models.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/scripts/generate-models.ts)
- 生成后的 [models.generated.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/models.generated.ts)

### 13.5 认证发现层

改：

- [env-api-keys.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/env-api-keys.ts)

### 13.6 文档与测试

改：

- `README.md`
- `test/` 下相关测试

---

## 14. 如果你要改某类能力，应该去哪里

这一节最适合真正开发时查。

| 要改什么 | 优先看哪里 |
|---|---|
| 统一入口调度 | [stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/stream.ts) |
| provider 注册 / 覆盖 / 懒加载 | [api-registry.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/api-registry.ts)、[register-builtins.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/register-builtins.ts) |
| 流式事件机制 | [event-stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/event-stream.ts) |
| OpenAI Responses | [openai-responses.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses.ts)、[openai-responses-shared.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses-shared.ts) |
| OpenAI Completions 兼容层 | [openai-completions.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-completions.ts) |
| thinking / tool call 跨 provider 回放 | [transform-messages.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/transform-messages.ts) |
| `streamSimple()` 参数桥 | [simple-options.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/simple-options.ts) |
| 模型发现 / 价格 / thinking level | [models.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/models.ts) |
| API key / 凭证发现 | [env-api-keys.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/env-api-keys.ts) |
| 图片生成链 | [images.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/images.ts)、[providers/images/openrouter.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/images/openrouter.ts) |

---

## 15. 这份包最值得记住的 5 个设计点

### 1. 模型信息是构建时生成的，不是运行时查询的

好处：

- 查询快
- 类型强
- 可以直接参与 cost / compat / reasoning 决策

### 2. 所有文本 provider 都必须收敛到统一事件协议

也就是：

- `start`
- `text_*`
- `thinking_*`
- `toolcall_*`
- `done`
- `error`

这样 `packages/agent` 才不需要知道底层是 OpenAI 还是 Anthropic。

### 3. `complete()` 本质上也是走流式链路

这让：

- 流式 / 非流式语义保持一致
- provider 不需要维护两套实现

### 4. `streamSimple()` 是上层真正常用的 API 面

`packages/agent` 和 `packages/coding-agent` 更常依赖的是：

- `streamSimple()`
- `completeSimple()`

因为这层把 reasoning / timeout / signal / headers / cache 这些参数统一好了。

### 5. provider 不是孤立文件，而是“主文件 + 共享 helper + 注册层”

以 OpenAI Responses 为例，真正的实现不是单个文件，而是：

- [register-builtins.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/register-builtins.ts)
- [openai-responses.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses.ts)
- [openai-responses-shared.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses-shared.ts)
- [transform-messages.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/transform-messages.ts)
- [simple-options.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/simple-options.ts)

---

## 16. 最后的阅读建议

如果你想真正“吃透” `packages/ai`，不要试图一次性读完所有 provider 文件。

正确方式是：

1. 先读协议层
   - [types.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/types.ts)

2. 再读入口调度层
   - [stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/stream.ts)
   - [api-registry.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/api-registry.ts)
   - [register-builtins.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/register-builtins.ts)

3. 再读流式基础设施
   - [event-stream.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/utils/event-stream.ts)

4. 精读一个 provider 样板
   - [openai-responses.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses.ts)
   - [openai-responses-shared.ts](file:///Users/a/Desktop/OH-WorkSpace/ALL/我的Github项目/pi/packages/ai/src/providers/openai-responses-shared.ts)

5. 最后横向看其它 provider 差异

这样你看到的就不再是一堆零散文件，而是一套非常清晰的层级系统：

> 类型协议 -> 入口调度 -> 注册表 -> provider 适配 -> SDK/HTTP -> 统一事件 -> 最终消息

这就是 `packages/ai` 最核心的代码结构。
