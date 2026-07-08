# 自定义模型

通过 `~/.pi/agent/models.json` 添加自定义提供商和模型（Ollama、vLLM、LM Studio、代理等）。

## 目录

- [最小示例](#minimal-example)
- [完整示例](#full-example)
- [Google AI Studio 示例](#google-ai-studio-example)
- [支持的 API](#supported-apis)
- [提供商配置](#provider-configuration)
- [模型配置](#model-configuration)
- [覆盖内置提供商](#overriding-built-in-providers)
- [按模型覆盖](#per-model-overrides)
- [Anthropic Messages 兼容性](#anthropic-messages-compatibility)
- [OpenAI 兼容性](#openai-compatibility)

## 最小示例

对于本地模型（Ollama、LM Studio、vLLM），每个模型只需 `id` 字段：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`apiKey` 是必填字段，但 Ollama 会忽略它，因此任何值都可以。

部分兼容 OpenAI 的服务器无法识别用于推理模型的 `developer` 角色。对于这类提供商，请将 `compat.supportsDeveloperRole` 设置为 `false`，这样 pi 会以 `system` 消息的形式发送系统提示。如果服务器也不支持 `reasoning_effort`，请同时将 `compat.supportsReasoningEffort` 设置为 `false`。

你可以在提供商级别设置 `compat` 以应用到所有模型，也可以在模型级别覆盖特定模型的设置。这通常适用于 Ollama、vLLM、SGLang 以及类似的 OpenAI 兼容服务器。

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

## 完整示例

当你需要特定值时，可以覆盖默认配置：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

该文件在你每次打开 `/model` 时都会重新加载。你可以在会话期间编辑它，无需重启。

## Google AI Studio 示例

使用 `google-generative-ai` 配合 `baseUrl` 来添加来自 Google AI Studio 的模型，包括自定义 Gemma 4 条目：

```json
{
  "providers": {
    "my-google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "GEMINI_API_KEY",
      "models": [
        {
          "id": "gemma-4-31b-it",
          "name": "Gemma 4 31B",
          "input": ["text", "image"],
          "contextWindow": 262144,
          "reasoning": true
        }
      ]
    }
  }
}
```

向 `google-generative-ai` API 类型添加自定义模型时，`baseUrl` 是必填字段。

## 支持的 API

| API | 说明 |
|-----|------|
| `openai-completions` | OpenAI Chat Completions（兼容性最广） |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

在提供商级别设置 `api`（所有模型的默认值），或在模型级别设置（覆盖特定模型）。

## 提供商配置

| 字段 | 说明 |
|------|------|
| `baseUrl` | API 端点 URL |
| `api` | API 类型（见上文） |
| `apiKey` | API 密钥（值解析方式见下文） |
| `headers` | 自定义请求头（值解析方式见下文） |
| `authHeader` | 设置为 `true` 时自动添加 `Authorization: Bearer <apiKey>` |
| `models` | 模型配置数组 |
| `modelOverrides` | 对当前提供商的内置模型进行按模型覆盖 |

### 值解析

`apiKey` 和 `headers` 字段支持三种格式：

- **Shell 命令：** `"!command"` 会执行命令并使用 stdout
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **环境变量：** 使用命名变量的值
  ```json
  "apiKey": "MY_API_KEY"
  ```
- **字面值：** 直接使用
  ```json
  "apiKey": "sk-..."
  ```

对于 `models.json`，shell 命令在请求时解析。Pi 有意不对任意命令应用内置的 TTL、过期重用或恢复逻辑。不同的命令需要不同的缓存和失败策略，pi 无法推断出合适的策略。

如果你的命令执行缓慢、成本高昂、有频率限制，或者希望在临时失败时继续使用之前的值，请将其封装在你自己的脚本或命令中，实现你想要的缓存或 TTL 行为。

`/model` 的可用性检查使用配置的认证状态，不会执行 shell 命令。

### 自定义请求头

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

## 模型配置

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | 是 | — | 模型标识符（传递给 API） |
| `name` | 否 | `id` | 人类可读的模型标签。用于匹配（`--model` 模式）以及显示在模型详情/状态文本中。 |
| `api` | 否 | 提供商的 `api` | 覆盖此模型的提供商 API |
| `reasoning` | 否 | `false` | 是否支持扩展思考 |
| `thinkingLevelMap` | 否 | 省略 | 将 pi 思考级别映射到提供商的值，并标记不支持的级别（见下文） |
| `input` | 否 | `["text"]` | 输入类型：`["text"]` 或 `["text", "image"]` |
| `contextWindow` | 否 | `128000` | 上下文窗口大小（token 数） |
| `maxTokens` | 否 | `16384` | 最大输出 token 数 |
| `cost` | 否 | 全零 | `{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}`（每百万 token） |
| `compat` | 否 | 提供商的 `compat` | 提供商兼容性覆盖。同时设置时与提供商级别的 `compat` 合并。 |

当前行为：
- `/model` 和 `--list-models` 按模型 `id` 列出条目。
- 配置的 `name` 用于模型匹配和详情/状态文本。

### 思考级别映射

在模型上使用 `thinkingLevelMap` 来描述模型特定的思考控制。键是 pi 的思考级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`。

值为三态：

| 值 | 含义 |
|------|--------|
| 省略 | 该级别受支持，使用提供商的默认映射 |
| 字符串 | 该级别受支持，此值会发送给提供商 |
| `null` | 该级别不受支持，会被隐藏/跳过/截断 |

示例：一个只支持关闭、高和最大推理的模型：

```json
{
  "id": "deepseek-v4-pro",
  "reasoning": true,
  "thinkingLevelMap": {
    "minimal": null,
    "low": null,
    "medium": null,
    "high": "high",
    "xhigh": "max"
  }
}
```

示例：一个无法关闭思考的模型：

```json
{
  "id": "always-thinking-model",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null
  }
}
```

迁移：旧配置中使用了 `compat.reasoningEffortMap` 的，应将该映射迁移到模型级别的 `thinkingLevelMap`。对于不应在 UI 中显示的级别，使用 `null`。

## 覆盖内置提供商

在不重新定义模型的情况下，将内置提供商通过代理转发：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

所有内置的 Anthropic 模型仍然可用。现有的 API 密钥认证继续有效。

要将自定义模型合并到内置提供商中，请包含 `models` 数组：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

合并语义：
- 内置模型会被保留。
- 自定义模型按 `id` 在该提供商内进行 upsert。
- 如果自定义模型的 `id` 与内置模型的 `id` 相同，则自定义模型会替换该内置模型。
- 如果自定义模型的 `id` 是新的，则会与内置模型一起添加。

## 按模型覆盖

使用 `modelOverrides` 自定义特定的内置模型，而无需替换提供商的完整模型列表。

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` 支持每个模型以下字段：`name`、`reasoning`、`input`、`cost`（部分）、`contextWindow`、`maxTokens`、`headers`、`compat`。

行为说明：
- `modelOverrides` 应用于内置提供商模型。
- 未知的模型 ID 会被忽略。
- 你可以将提供商级别的 `baseUrl`/`headers` 与 `modelOverrides` 结合使用。
- 如果提供商同时定义了 `models`，自定义模型会在内置覆盖之后合并。具有相同 `id` 的自定义模型会替换被覆盖的内置模型条目。

## Anthropic Messages 兼容性

对于使用 `api: "anthropic-messages"` 的提供商或代理，请使用 `compat` 来控制 Anthropic 特定的请求兼容性。

默认情况下，pi 会为每个工具发送 `eager_input_streaming: true`。如果代理或兼容 Anthropic 的后端拒绝该字段，请将 `supportsEagerToolInputStreaming` 设置为 `false`。Pi 将省略 `tools[].eager_input_streaming`，并在使用工具时发送旧版的 `fine-grained-tool-streaming-2025-05-14` beta 请求头。

部分 Anthropic 模型需要自适应思考（`thinking.type: "adaptive"` 加上 `output_config.effort`），而非旧版的基于预算的思考载荷。内置模型会自动设置此项。对于路由到这些模型的自定义提供商或别名，请将 `forceAdaptiveThinking` 设置为 `true`。

```json
{
  "providers": {
    "anthropic-proxy": {
      "baseUrl": "https://proxy.example.com",
      "api": "anthropic-messages",
      "apiKey": "ANTHROPIC_PROXY_KEY",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": true,
        "forceAdaptiveThinking": true
      },
      "models": [
        {
          "id": "claude-opus-4-7",
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `supportsEagerToolInputStreaming` | 提供商是否接受每个工具的 `eager_input_streaming`。默认值：`true`。设置为 `false` 可省略该字段，并在使用工具的请求中使用旧版的细粒度工具流式传输 beta 请求头。 |
| `supportsLongCacheRetention` | 当缓存保留策略为 `long` 时，提供商是否接受 Anthropic 的长时间缓存保留（`cache_control.ttl: "1h"`）。默认值：`true`。 |
| `sendSessionAffinityHeaders` | 启用缓存时，是否从会话 ID 发送 `x-session-affinity`。默认值：对于已知提供商自动检测。 |
| `supportsCacheControlOnTools` | 提供商是否接受在工具定义上使用 Anthropic 风格的 `cache_control` 标记。默认值：`true`。 |
| `forceAdaptiveThinking` | 是否为此模型发送自适应思考（`thinking.type: "adaptive"` 加上 `output_config.effort`）。内置的自适应模型会自动设置此项。默认值：`false`。 |

## OpenAI 兼容性

对于具有部分 OpenAI 兼容性的提供商，请使用 `compat` 字段。

- 提供商级别的 `compat` 应用于该提供商下的所有模型。
- 模型级别的 `compat` 会覆盖该模型的提供商级别值。

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `supportsStore` | 提供商是否支持 `store` 字段 |
| `supportsDeveloperRole` | 使用 `developer` 角色还是 `system` 角色 |
| `supportsReasoningEffort` | 是否支持 `reasoning_effort` 参数 |
| `supportsUsageInStreaming` | 是否支持 `stream_options: { include_usage: true }`（默认值：`true`） |
| `maxTokensField` | 使用 `max_completion_tokens` 还是 `max_tokens` |
| `requiresToolResultName` | 工具结果消息中是否包含 `name` |
| `requiresAssistantAfterToolResult` | 在工具结果之后、用户消息之前是否插入一条 assistant 消息 |
| `requiresThinkingAsText` | 是否将 thinking 块转换为纯文本 |
| `requiresReasoningContentOnAssistantMessages` | 启用推理时，是否在所有重放的 assistant 消息中包含空的 `reasoning_content` |
| `thinkingFormat` | 使用 `reasoning_effort`、`openrouter`、`deepseek`、`together`、`zai`、`qwen` 或 `qwen-chat-template` 思考参数 |
| `cacheControlFormat` | 是否在系统提示、最后一个工具定义和最后一条用户/assistant 文本内容上使用 Anthropic 风格的 `cache_control` 标记。目前仅支持 `anthropic`。 |
| `supportsStrictMode` | 工具定义中是否包含 `strict` 字段 |
| `supportsLongCacheRetention` | 当缓存保留策略为 `long` 时，提供商是否接受长时间缓存保留：OpenAI 提示缓存的 `prompt_cache_retention: "24h"`，或在 `cacheControlFormat` 为 `anthropic` 时的 `cache_control.ttl: "1h"`。默认值：`true`。 |
| `openRouterRouting` | OpenRouter 提供商路由偏好。此对象会按原样发送到 [OpenRouter API 请求](https://openrouter.ai/docs/guides/routing/provider-selection) 的 `provider` 字段中。 |
| `vercelGatewayRouting` | Vercel AI Gateway 路由配置，用于提供商选择（`only`、`order`） |

`openrouter` 使用 `reasoning: { effort }`。`together` 使用 `reasoning: { enabled }`，并且在启用 `supportsReasoningEffort` 时也会发送 `reasoning_effort`。`qwen` 使用顶层 `enable_thinking`。对于需要 `chat_template_kwargs.enable_thinking` 的本地 Qwen 兼容服务器，请使用 `qwen-chat-template`。

`cacheControlFormat: "anthropic"` 适用于那些通过文本内容和工具定义上的 `cache_control` 标记暴露 Anthropic 风格提示缓存的 OpenAI 兼容提供商。

示例：

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "allow_fallbacks": true,
              "require_parameters": false,
              "data_collection": "deny",
              "zdr": true,
              "enforce_distillable_text": false,
              "order": ["anthropic", "amazon-bedrock", "google-vertex"],
              "only": ["anthropic", "amazon-bedrock"],
              "ignore": ["gmicloud", "friendli"],
              "quantizations": ["fp16", "bf16"],
              "sort": {
                "by": "price",
                "partition": "model"
              },
              "max_price": {
                "prompt": 10,
                "completion": 20
              },
              "preferred_min_throughput": {
                "p50": 100,
                "p90": 50
              },
              "preferred_max_latency": {
                "p50": 1,
                "p90": 3,
                "p99": 5
              }
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway 示例：

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```
