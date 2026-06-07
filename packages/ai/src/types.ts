import type { TSchema } from "typebox";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

// ============================================================================
// `pi-ai` 核心协议文件
// ============================================================================
//
// 文件定位：
// - 这是整个 `packages/ai` 的"类型中枢"
// - `stream.ts`、`api-registry.ts`、各个 provider、`packages/agent`、`packages/coding-agent`
//   都会直接或间接依赖这里定义的协议
//
// 本文件按 6 大分类组织：
// 1. API / Provider / Thinking / 统一 options  —— 协议标识与请求配置
// 2. Message / Content / Tool / Usage           —— 会话数据结构
// 3. EventStream 事件协议                        —— 流式事件的类型定义
// 4. OpenAI / Anthropic 兼容层配置               —— provider 差异化的兼容选项
// 5. Model / ImagesModel 元信息                  —— 模型的静态描述
// 6. 对外暴露的函数类型                          —— StreamFunction / ImagesFunction
//
// 调用链视角：
// - 上层调用 `streamSimple(model, context, options)`
// - `model` / `context` / `options` 的类型来自这里
// - provider 返回 `AssistantMessageEventStream`
// - 流里逐条发 `AssistantMessageEvent`
// - 结束时收敛成 `AssistantMessage`
// ============================================================================

// ============================================================================
// 第 1 组：API / Provider / Thinking / 统一 options
// ============================================================================
//
// 这组类型定义了：
// - API 协议标识（如 "openai-responses"、"anthropic-messages"）
// - Provider 服务商标识（如 "openai"、"anthropic"）
// - Thinking 推理级别与 token 预算
// - 统一的请求选项（StreamOptions / SimpleStreamOptions）
// - 传输方式、缓存策略等配置枚举

// ---------------------------------------------------------------------------
// 1.1 API 协议标识
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1.2 Provider 服务商标识
// ---------------------------------------------------------------------------

/** Provider 表示服务提供商（公司），而不是具体 API 协议。 */
export type KnownProvider = "anthropic" | "openai";
export type Provider = KnownProvider | string;

/** 内置图片生成服务商标识。 */
export type KnownImagesProvider = "openrouter";
export type ImagesProvider = KnownImagesProvider | string;

// ---------------------------------------------------------------------------
// 1.3 Thinking 推理级别
// ---------------------------------------------------------------------------

/**
 * `pi-ai` 对外提供的统一推理档位。
 * provider 内部再通过 `thinkingLevelMap` 把这些档位映射成自己的具体字段。
 *
 * - "minimal"：最低推理开销
 * - "low" / "medium" / "high"：逐步增加推理深度
 * - "xhigh"：仅部分模型系列支持
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

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

// ---------------------------------------------------------------------------
// 1.4 传输方式与缓存策略
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1.5 统一请求选项
// ---------------------------------------------------------------------------

/** 统一的响应元信息，供 `onResponse()` 这类 hook 使用。 */
export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

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

// ============================================================================
// 第 2 组：Message / Content / Tool / Usage（会话数据结构）
// ============================================================================
//
// 这组类型定义了对话中的所有数据结构：
// - Content 内容块：TextContent、ThinkingContent、ImageContent、ToolCall
// - Usage 计费：token 统计与费用
// - StopReason：响应结束原因
// - Message 消息：UserMessage、AssistantMessage、ToolResultMessage
// - Tool 工具定义：名字、描述、参数 schema
// - Context 请求上下文：system prompt + 消息 + 工具

// ---------------------------------------------------------------------------
// 2.1 Content 内容块
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 2.2 Usage 计费
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 2.3 StopReason 停止原因
// ---------------------------------------------------------------------------

/**
 * 统一表达 assistant 响应是如何结束的。
 * - "stop"：正常结束
 * - "length"：达到最大 token 限制
 * - "toolUse"：请求工具调用
 * - "error"：发生错误
 * - "aborted"：被中止
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// ---------------------------------------------------------------------------
// 2.4 Message 消息类型
// ---------------------------------------------------------------------------

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
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	/** 使用的 API 协议名。 */
	api: Api;
	/** 服务提供商名。 */
	provider: Provider;
	/** 请求的模型 ID。 */
	model: string;
	/** 实际响应的模型 ID（当与请求的 model 不同时出现）。 */
	responseModel?: string;
	/** Provider 特定的响应/消息标识符。 */
	responseId?: string;
	/** 经过脱敏的 provider/运行时诊断信息，用于故障和恢复分析。 */
	diagnostics?: AssistantMessageDiagnostic[];
	/** Token 使用量与费用。 */
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

/**
 * 统一消息联合类型。
 * 一个上下文里的消息只会是这三种之一：用户消息、助手消息、工具结果消息。
 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// 2.5 Tool 工具定义
// ---------------------------------------------------------------------------

/**
 * 工具定义：名字、描述、参数 schema。
 * `parameters` 使用 TypeBox schema，provider 会再把它翻译成各自的工具声明格式。
 */
export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

// ---------------------------------------------------------------------------
// 2.6 Context 请求上下文
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 2.7 图片相关的会话数据结构
// ---------------------------------------------------------------------------

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

// ============================================================================
// 第 3 组：EventStream 事件协议
// ============================================================================
//
// 定义了 AssistantMessageEventStream 中流动的事件类型。
//
// 流的生命周期：
// 1. `start`：流开始，携带初始 partial
// 2. `text_start` / `text_delta` / `text_end`：文本块的逐步生成
// 3. `thinking_start` / `thinking_delta` / `thinking_end`：思考块的逐步生成
// 4. `toolcall_start` / `toolcall_delta` / `toolcall_end`：工具调用块的逐步生成
// 5. `done`：成功结束，携带最终 AssistantMessage
// 6. `error`：异常结束，携带带错误信息的 AssistantMessage
//
// 每个事件都携带 `partial` 字段，指向当前"进行中"的 AssistantMessage 快照。

/** 重导出事件流类型。 */
export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

/**
 * AssistantMessageEventStream 的事件协议。
 *
 * 流应该：
 * - 在任何 partial 更新之前发出 `start`
 * - 用 `done`（成功）或 `error`（失败）终止
 */
export type AssistantMessageEvent =
	// 流开始
	| { type: "start"; partial: AssistantMessage }
	// 文本块事件
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	// 思考块事件
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	// 工具调用块事件
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	// 成功结束
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	// 异常结束
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

// ============================================================================
// 第 4 组：OpenAI / Anthropic 兼容层配置
// ============================================================================
//
// 不同 provider 的 API 存在细微差异。这些 Compat 接口允许调用方覆盖基于 URL 的自动检测，为自定义 provider 指定兼容行为。
//
// 使用场景：
// - 自建 OpenAI 兼容 API（如 vLLM、Ollama）
// - Anthropic 兼容的第三方服务
// - 需要覆盖默认行为的特殊部署

/**
 * OpenAI Completions API 兼容配置。
 * 用于覆盖基于 URL 的自动检测，适用于自定义 OpenAI 兼容 provider。
 */
export interface OpenAICompletionsCompat {
	/** 是否支持 `store` 字段。默认：基于 URL 自动检测。 */
	supportsStore?: boolean;
	/** 是否支持 `developer` 角色（而非 `system`）。默认：基于 URL 自动检测。 */
	supportsDeveloperRole?: boolean;
	/** 是否支持 `reasoning_effort`。默认：基于 URL 自动检测。 */
	supportsReasoningEffort?: boolean;
	/** 是否支持 `stream_options: { include_usage: true }` 以获取流式 token 用量。默认：true。 */
	supportsUsageInStreaming?: boolean;
	/** 使用哪个字段设置最大 token 数。默认：基于 URL 自动检测。 */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** 工具结果是否需要 `name` 字段。默认：基于 URL 自动检测。 */
	requiresToolResultName?: boolean;
	/** 工具结果后的用户消息是否需要中间的助手消息。默认：基于 URL 自动检测。 */
	requiresAssistantAfterToolResult?: boolean;
	/** 思考块是否必须转换为带 `<thinking>` 分隔符的文本块。默认：基于 URL 自动检测。 */
	requiresThinkingAsText?: boolean;
	/** 启用推理时，所有回放的助手消息是否必须包含空的 reasoning_content 字段。默认：基于 URL 自动检测。 */
	requiresReasoningContentOnAssistantMessages?: boolean;
	/** 推理/思考参数格式。"openai" 使用 reasoning_effort。默认："openai"。 */
	thinkingFormat?: "openai";
	/** 是否支持工具定义中的 `strict` 字段。默认：true。 */
	supportsStrictMode?: boolean;
	/**
	 * Prompt 缓存控制格式。
	 * "anthropic"：在系统提示、最后一个工具定义、最后一个用户/助手文本内容上
	 * 应用 Anthropic 风格的 `cache_control` 标记。
	 */
	cacheControlFormat?: "anthropic";
	/** 启用缓存时是否发送会话亲和性 headers。默认：false。 */
	sendSessionAffinityHeaders?: boolean;
	/** 是否支持长期 prompt 缓存保留。默认：true。 */
	supportsLongCacheRetention?: boolean;
}

/** OpenAI Responses API 兼容配置。 */
export interface OpenAIResponsesCompat {
	/** 启用缓存时是否发送 OpenAI `session_id` header。默认：true。 */
	sendSessionIdHeader?: boolean;
	/** 是否支持 `prompt_cache_retention: "24h"`。默认：true。 */
	supportsLongCacheRetention?: boolean;
}

/** Anthropic Messages API 兼容配置。 */
export interface AnthropicMessagesCompat {
	/**
	 * 是否支持逐工具的 `eager_input_streaming`。
	 * 设为 false 时，Anthropic provider 会省略 `tools[].eager_input_streaming`
	 * 并发送旧版 `fine-grained-tool-streaming-2025-05-14` beta header。
	 * 默认：true。
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** 是否支持 Anthropic 长期缓存保留（`cache_control.ttl: "1h"`）。默认：true。 */
	supportsLongCacheRetention?: boolean;
	/** 启用缓存时是否发送 `x-session-affinity` header。默认：false。 */
	sendSessionAffinityHeaders?: boolean;
	/**
	 * 是否支持工具定义上的 Anthropic 风格 `cache_control` 标记。
	 * 设为 false 时，工具参数中省略 `cache_control`。
	 * 默认：true。
	 */
	supportsCacheControlOnTools?: boolean;
	/**
	 * 是否强制自适应思考（`thinking.type: "adaptive"` + `output_config.effort`），
	 * 无论模型 ID 是什么。
	 *
	 * 内置需要自适应思考的模型会在生成的元数据中设置此项。
	 * 自定义 Anthropic 兼容 provider 可以为上游需要自适应格式的模型设置为 `true`。
	 * 设为 `false` 可以在被覆盖的内置模型上禁用。
	 * 默认：false。
	 */
	forceAdaptiveThinking?: boolean;
}

// ============================================================================
// 第 5 组：Model / ImagesModel 元信息
// ============================================================================
//
// 定义了模型的静态描述信息。
// 调用链里几乎每一层都会读它：
// - `stream.ts` 读 `model.api` 来路由到正确的 provider
// - provider 读 `model.baseUrl` / `model.provider` / `model.compat` 来构造请求
// - 计费逻辑读 `model.cost`
// - 思考控制读 `model.reasoning` / `model.thinkingLevelMap`

/**
 * 统一模型元信息。
 *
 * 告诉 `pi-ai` 一个模型"是什么"，包括：
 * - 请求应该走哪个 api
 * - 属于哪个 provider
 * - 基础 URL 和默认 headers
 * - 是否支持 reasoning
 * - 计费单价
 * - 上下文窗口与最大输出
 * - 兼容层覆盖项
 */
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

// ============================================================================
// 第 6 组：对外暴露的函数类型
// ============================================================================
//
// 定义了 `pi-ai` 对外暴露的核心函数签名。
// 这些类型被 `stream.ts`、`api-registry.ts`、各个 provider 广泛使用。

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
