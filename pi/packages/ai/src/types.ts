/**
 * `pi-ai` 的统一类型定义。
 *
 * 文件定位：
 * - 这是整个 `packages/ai` 的基础类型层
 * - provider、api、models、compat、images 等模块都会依赖这里的公共协议
 *
 * 主要内容：
 * - API / provider / model 的标识类型
 * - 流式请求参数与事件协议
 * - 消息内容块、工具调用、图片生成等统一数据结构
 * - 各类 provider 兼容配置与成本模型
 */

import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { PiMessagesOptions } from "./api/pi-messages.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

// ============================================================================
// API / Provider 标识类型
// ============================================================================

/**
 * 已知 API 的字符串标识联合类型。
 *
 * 定位：统一系统中所有内置 API 的资源标识命名空间。
 * 用于 model 描述、provider 分发和 API 选项映射的类型收窄。
 */
export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

// API 标识类型。`KnownApi` 联合类型的超集，允许通过 `string & {}` 扩展自定义 API。
export type Api = KnownApi | (string & {});

/** 已知图片 API 的字符串标识联合类型。 */
export type KnownImagesApi = "openrouter-images";

// 图片 API 标识类型。`KnownImagesApi` 的超集，允许自定义图片 API 标识。
export type ImagesApi = KnownImagesApi | (string & {});

// 内置 provider 的字符串标识联合类型。
export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "radius"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";

// Provider 标识类型。`KnownProvider` 的超集，允许自定义 provider ID。
export type ProviderId = KnownProvider | string;

/** 已知图片 provider 的字符串标识联合类型。 */
export type KnownImagesProvider = "openrouter";

/** 图片 provider 标识类型，允许自定义图片 provider ID。 */
export type ImagesProviderId = KnownImagesProvider | string;

/** 推理/思考档位。 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 模型级思考档位，在 `ThinkingLevel` 基础上增加 `off`（关闭思考）。 */
export type ModelThinkingLevel = "off" | ThinkingLevel;

/** 思考档位到 provider 特定值的映射表。`null` 表示该档位不支持，缺少 key 则使用 provider 默认值。 */
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

/**
 * Chat Template 关键字参数值的联合类型。
 *
 * 定位：用于配置 `chat_template_kwargs` 中每个 key 的值，
 * 支持静态值或 `$var` 占位符（运行时由系统注入 thinking 状态）。
 */
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort";
			omitWhenOff?: boolean;
	  };

/** 各推理档位对应的 token 预算，仅适用于基于 token 的 thinking provider。 */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// ============================================================================
// 通用请求选项
// ============================================================================

/**
 * 提示缓存保留策略。
 * - "none": 不缓存本次请求的上下文
 * - "short": 短期缓存（provider 默认行为，通常 5 分钟）
 * - "long": 长期缓存（如 Anthropic 1h TTL 或 OpenAI 24h）
 */
export type CacheRetention = "none" | "short" | "long";

/**
 * 流式传输协议。
 *
 * 定位：控制 provider 与客户端之间的数据传输方式。
 * - "sse": Server-Sent Events，标准的 HTTP 流式传输
 * - "websocket": WebSocket 连接
 * - "websocket-cached": 带缓存优化的 WebSocket 连接
 * - "auto": 由 provider 自动选择
 */
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** provider 级环境变量覆写，优先级高于 `process.env`。 */
export type ProviderEnv = Record<string, string>;

/** provider 级 HTTP 请求头覆写。`null` 值表示抑制该名称的默认请求头。 */
export type ProviderHeaders = Record<string, string | null>;

/** session affinity 头格式：`openai` 使用 session ID 查询参数，`openai-nosession` 不传 session，`openrouter` 使用 OpenRouter 风格的头。 */
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

/** provider HTTP 响应的统一结构，包含 HTTP 状态码和响应头。 */
export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/**
 * 流式请求的通用选项。
 * 包含温度、token 限制、缓存、超时、重试、自定义请求头等跨 provider 的通用配置。
 * 各 provider 实现按需读取，不支持的字段会被静默忽略。
 */
export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * 首选传输协议，适用于支持多种传输方式的 provider。
	 * 不支持此选项的 provider 将忽略它。
	 */
	transport?: Transport;
	/**
	 * 提示缓存保留策略偏好。provider 将其映射到自身支持的缓存值。
	 * 默认："short"。
	 */
	cacheRetention?: CacheRetention;
	/**
	 * 可选的会话标识符，适用于支持基于会话缓存的 provider。
	 * provider 可据此启用提示缓存、请求路由或其他会话感知特性。
	 * 不支持的 provider 将忽略此字段。
	 */
	sessionId?: string;
	/**
	 * 可选回调，在发送前检查或替换 provider 请求负载。
	 * 返回 `undefined` 表示保持负载不变。
	 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * 可选回调，在 HTTP 响应到达后、body 流被消费前触发。
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * 可选的自定义 HTTP 请求头。
	 * 与 provider 默认请求头合并，调用方值覆盖默认值。
	 * 在 AWS Bedrock 上，这些请求头通过 Smithy `build` 步骤中间件注入，
	 * 因此会被 SigV4 签名覆盖；保留头（`x-amz-*`、`authorization`、`host`）
	 * 会被静默忽略以保护 SigV4 / bearer 认证。
	 * `null` 值表示抑制同名 provider/API 默认请求头。
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP 请求超时，毫秒。适用于支持此配置的 provider/SDK。
	 * 例如，OpenAI 和 Anthropic SDK 客户端默认超时为 10 分钟。
	 */
	timeoutMs?: number;
	/**
	 * WebSocket 连接超时，毫秒。适用于支持 WebSocket 传输的 provider。
	 * 此超时仅覆盖连接/打开握手阶段；连接建立后的流空闲超时使用 `timeoutMs`。
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * 最大重试次数，适用于支持客户端重试的 provider/SDK。
	 * 例如，OpenAI 和 Anthropic SDK 客户端默认重试 2 次。
	 */
	maxRetries?: number;
	/**
	 * 当服务器要求长时间等待时，允许的最大重试等待延迟（毫秒）。
	 * 如果服务器请求的延迟超过此值，请求立即失败并返回包含请求延迟的错误信息，
	 * 允许上层重试逻辑在用户可见的情况下处理。
	 * 默认：60000（60 秒）。设为 0 表示不设上限。
	 */
	maxRetryDelayMs?: number;
	/**
	 * 可选的元数据，随 API 请求发送。
	 * provider 提取自己理解的字段，忽略其余部分。
	 * 例如，Anthropic 使用 `user_id` 进行滥用追踪和速率限制。
	 */
	metadata?: Record<string, unknown>;
	/**
	 * provider 级环境变量。这些值在 provider 配置（如区域设置、端点占位符、
	 * 代理变量）方面优先于 `process.env`。
	 */
	env?: ProviderEnv;
}

/** provider 直传选项：在基础流式参数上允许附加 provider 自定义字段。 */
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * 已知 API 到其完整参数类型的映射表。
 * 作用：让 `Provider.stream()` 在已知 API 场景下获得精确的 options 类型。
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"pi-messages": PiMessagesOptions;
}

/** 某个 API 的完整流式参数类型；未知 API 则回退到通用形态。 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * API 实现模块的统一运行时契约。
 *
 * 约定：
 * - `src/api/*` 下的模块都导出 `stream` 与 `streamSimple`
 * - provider 工厂、懒加载包装器、compat 分发层都按这个接口持有它们
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/** 图片 API 实现模块的统一运行时契约。 */
export interface ProviderImages {
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * 图片生成请求的通用选项。
 * 包含信号、认证、缓存、超时、重试、自定义请求头等跨 provider 的通用配置。
 */
export interface ImagesOptions {
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * provider 级环境变量。这些值在 provider 配置（如端点占位符、代理变量）
	 * 方面优先于 `process.env`。
	 */
	env?: ProviderEnv;
	/**
	 * 可选回调，在发送前检查或替换 provider 请求负载。
	 * 返回 `undefined` 表示保持负载不变。
	 */
	onPayload?: (payload: unknown, model: ImagesModel<ImagesApi>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * 可选回调，在 HTTP 响应到达后触发。
	 */
	onResponse?: (response: ProviderResponse, model: ImagesModel<ImagesApi>) => void | Promise<void>;
	/**
	 * 可选的自定义 HTTP 请求头。
	 * 与 provider 默认请求头合并，可覆盖默认值。
	 * `null` 值表示抑制同名 provider/API 默认请求头。
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP 请求超时，毫秒。适用于支持此配置的 provider/SDK。
	 */
	timeoutMs?: number;
	/**
	 * 最大重试次数，适用于支持客户端重试的 provider/SDK。
	 */
	maxRetries?: number;
	/**
	 * 当服务器要求长时间等待时，允许的最大重试等待延迟（毫秒）。
	 * 如果服务器请求的延迟超过此值，请求立即失败并返回包含请求延迟的错误信息，
	 * 允许上层重试逻辑在用户可见的情况下处理。
	 * 默认：60000（60 秒）。设为 0 表示不设上限。
	 */
	maxRetryDelayMs?: number;
	/**
	 * 可选的元数据，随 API 请求发送。
	 * provider 提取自己理解的字段，忽略其余部分。
	 */
	metadata?: Record<string, unknown>;
}

/** 图片 provider 的扩展选项形态。 */
export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

/**
 * 简化入口的统一参数：在通用选项上增加 reasoning 档位。
 * `streamSimple()` / `completeSimple()` 的参数载体。
 */
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** 各档位的自定义 token 预算（仅适用于基于 token 的 provider）。 */
	thinkingBudgets?: ThinkingBudgets;
}

/**
 * 带泛型 options 的统一流式函数签名。
 *
 * 约定：
 * - 必须返回 `AssistantMessageEventStream`
 * - 运行时错误应尽量编码进返回的 stream，而不是直接抛出
 * - 错误终止时应产出带 `stopReason` / `errorMessage` 的 assistant message
 */
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

/**
 * 带泛型 options 的图片生成函数签名。
 * 返回 `Promise<AssistantImages>`，错误应编码进返回结构而非直接抛出。
 */
export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

// ============================================================================
// 消息内容块与消息结构
// ============================================================================

/**
 * 文本签名 v1 结构。
 * 定位：用于关联文本块的元数据签名，支持区分评论阶段和最终回答阶段。
 */
export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

/**
 * 文本内容块。
 * 定位：消息中最基础的内容单元，承载纯文本及其签名元数据。
 */
export interface TextContent {
	type: "text";
	text: string;
	/** 文本签名，例如 OpenAI responses 的消息元数据（旧式 ID 字符串或 TextSignatureV1 JSON）。 */
	textSignature?: string;
}

/**
 * 思考内容块。
 * 定位：承载模型的推理/思考过程内容，在流式输出中可区分展示。
 */
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/** 思考签名，例如 OpenAI responses 的 reasoning item ID。 */
	thinkingSignature?: string;
	/**
	 * 当为 `true` 时，表示思考内容被安全过滤器遮蔽。
	 * 加密的遮蔽负载存储在 `thinkingSignature` 中，以便传回 API 维持多轮对话连续性。
	 */
	redacted?: boolean;
}

/**
 * 图片内容块。
 * 定位：消息中承载 base64 编码图片数据的内容单元。
 */
export interface ImageContent {
	type: "image";
	/** base64 编码的图片数据。 */
	data: string;
	/** MIME 类型，例如 "image/jpeg"、"image/png"。 */
	mimeType: string;
}

/**
 * 工具调用内容块。
 * 定位：表示模型发起的一次工具调用，包含工具名、参数和调用 ID。
 * 由 provider 从流式输出中解析并填充。
 */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	/** Google 特定：用于复用思考上下文的不透明签名。 */
	thoughtSignature?: string;
}

/**
 * token 用量统计。
 * 定位：统一记录每次请求的 token 消耗和费用。
 * 各 provider 按各自支持的粒度填充相应字段。
 */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** `cacheWrite` 中按 1h 保留时长写入的子集。仅 Anthropic 报告此拆分。 */
	cacheWrite1h?: number;
	/**
	 * 推理/思考 token 数（provider 上报时）。
	 * 这是 `output` 的子集：`output` 已经包含这些 token。
	 * 支持推理分解的 provider 设为一个数字（可能为 0）；不支持的 provider 保持 `undefined`。
	 */
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/**
 * 流式/非流式响应的终止原因。
 *
 * - "stop": 正常完成
 * - "length": 因 token 限制截断
 * - "toolUse": 因等待工具调用结果而暂停
 * - "error": 异常终止
 * - "aborted": 被主动取消
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * 用户消息结构。
 * 定位：对话中 user 角色的消息载体，支持纯文本或图文混合内容。
 */
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** Unix 时间戳（毫秒）。 */
	timestamp: number;
}

/**
 * assistant 消息结构。
 * 定位：模型响应的完整载体，包含文本、思考、工具调用等混合内容块，
 * 以及 usage、stop reason 等元数据。
 */
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	/** 当实际响应的 model 与请求的 `model` 不同时的具体值（例如 OpenRouter `auto` → `anthropic/...`）。 */
	responseModel?: string;
	/** provider 特定的响应/消息标识符（当上游 API 暴露时）。 */
	responseId?: string;
	/** 被遮蔽的 provider/运行时诊断信息，用于故障和恢复场景。 */
	diagnostics?: AssistantMessageDiagnostic[];
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	/** Unix 时间戳（毫秒）。 */
	timestamp: number;
}

/**
 * 工具结果消息结构。
 * 定位：工具调用返回结果后插入对话的消息，承载工具执行结果。
 * 支持文本和图片内容，以及延迟工具加载元数据。
 */
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	/** 支持文本和图片内容。 */
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	/**
	 * 此结果返回后新增可用的工具名称列表（来自 `Context.tools`）。
	 * 支持原生延迟工具加载的 provider 将此作为加载点；
	 * 其他 provider 忽略此字段，正常使用 `Context.tools`。
	 */
	addedToolNames?: string[];
	isError: boolean;
	/** Unix 时间戳（毫秒）。 */
	timestamp: number;
}

/** 对话消息联合类型。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 图片输入内容块类型。 */
export type ImagesInputContent = TextContent | ImageContent;
/** 图片输出内容块类型。 */
export type ImagesOutputContent = TextContent | ImageContent;

/** 图片生成上下文，包含输入内容块列表。 */
export interface ImagesContext {
	input: ImagesInputContent[];
}

/** 图片生成终止原因。 */
export type ImagesStopReason = "stop" | "error" | "aborted";

/**
 * 图片生成结果。
 * 定位：图片 API 返回的统一结果结构，包含输出内容、元数据和错误信息。
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

import type { TSchema } from "typebox";

/**
 * 工具定义结构。
 * 定位：声明 agent 可用的工具，包含名称、描述和参数 schema。
 * 参数使用 TypeBox schema 进行类型校验。
 */
export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

/**
 * 对话上下文。包含系统提示、历史消息和可用工具集。
 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/**
 * AssistantMessageEventStream 的事件协议。
 *
 * 定位：定义流式响应中每个事件的类型、数据结构和生命周期。
 *
 * 流事件生命周期：
 *   1. `start` — 流开始，附带初始化的 partial assistant message
 *   2. `text_start / text_delta / text_end` — 文本块的三阶段事件
 *   3. `thinking_start / thinking_delta / thinking_end` — 思考块的三阶段事件
 *   4. `toolcall_start / toolcall_delta / toolcall_end` — 工具调用的三阶段事件
 *   5. 终止事件：
 *      - `done` — 成功终止，携带最终 AssistantMessage
 *      - `error` — 异常终止，携带 stopReason 为 "error" 或 "aborted" 的错误消息
 *
 * 流应先发出 `start`，然后发出部分更新，最后以以下两者之一终止：
 * - `done` 携带最终成功的 AssistantMessage，或
 * - `error` 携带最终 AssistantMessage，其 stopReason 为 "error" 或 "aborted"，
 *   以及 errorMessage。
 */
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

/**
 * OpenAI Completions 兼容 API 的兼容性设置。
 *
 * 定位：覆盖基于 URL 的自动检测，为自定义 provider 提供细粒度的行为开关。
 * 当 provider 的 API 行为与标准 OpenAI 有差异时，通过此配置告知系统。
 */
export interface OpenAICompletionsCompat {
	/** provider 是否支持 `store` 字段。默认：从 URL 自动检测。 */
	supportsStore?: boolean;
	/** provider 是否支持 `developer` 角色（相对于 `system`）。默认：从 URL 自动检测。 */
	supportsDeveloperRole?: boolean;
	/** provider 是否支持 `reasoning_effort`。默认：从 URL 自动检测。 */
	supportsReasoningEffort?: boolean;
	/** provider 是否支持 `stream_options: { include_usage: true }` 以在流式响应中获取 token 用量。默认：true。 */
	supportsUsageInStreaming?: boolean;
	/** 用于 max tokens 的字段名。默认：从 URL 自动检测。 */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** 工具结果是否需要 `name` 字段。默认：从 URL 自动检测。 */
	requiresToolResultName?: boolean;
	/** 工具结果后的 user 消息是否需要中间夹一条 assistant 消息。默认：从 URL 自动检测。 */
	requiresAssistantAfterToolResult?: boolean;
	/** 思考块是否需要以 `<thinking>` 分隔符转为文本块。默认：从 URL 自动检测。 */
	requiresThinkingAsText?: boolean;
	/** 启用 reasoning 时，所有回放的 assistant 消息是否必须包含空的 `reasoning_content` 字段。默认：从 URL 自动检测。 */
	requiresReasoningContentOnAssistantMessages?: boolean;
	/**
	 * reasoning/thinking 参数的格式。
	 * - "openai": 使用 `reasoning_effort`
	 * - "openrouter": 使用 `reasoning: { effort }`
	 * - "deepseek": 使用 `thinking: { type }`，支持时附加 `reasoning_effort`
	 * - "together": 使用 `reasoning: { enabled }`，支持时附加 `reasoning_effort`
	 * - "zai": 使用 `thinking: { type }`
	 * - "qwen": 使用顶层 `enable_thinking: boolean`
	 * - "qwen-chat-template": 使用 `chat_template_kwargs.enable_thinking` 和 `preserve_thinking`
	 * - "chat-template": 使用可配置的 `chat_template_kwargs`
	 * - "string-thinking": 使用顶层 `thinking: string`
	 * - "ant-ling": 仅在映射 effort 非 null 时使用 `reasoning: { effort }`
	 * 默认："openai"。
	 */
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
	/**
	 * 当 `thinkingFormat` 为 `chat-template` 时，作为 `chat_template_kwargs` 发送的关键字参数。
	 * 使用 `{ "$var": "thinking.enabled" }` 或 `{ "$var": "thinking.effort" }` 让系统控制 thinking 值。
	 */
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	/** OpenRouter 兼容的路由偏好，作为 `provider` 请求字段发送。 */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway 路由偏好。仅在 baseUrl 指向 Vercel AI Gateway 时使用。 */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** z.ai 是否支持顶层 `tool_stream: true` 以流式传输工具调用增量。默认：false。 */
	zaiToolStream?: boolean;
	/** provider 是否支持工具定义中的 `strict` 字段。默认：true。 */
	supportsStrictMode?: boolean;
	/**
	 * 提示缓存的 cache control 约定。
	 * "anthropic" 表示对系统提示、最后一个工具定义以及最后一个 user/assistant 文本内容
	 * 应用 Anthropic 风格的 `cache_control` 标记。
	 */
	cacheControlFormat?: "anthropic";
	/** Whether to send session-affinity data from `options.sessionId`. Default: false. */
	sendSessionAffinityHeaders?: boolean;
	/** Session-affinity header format: `openai` sends `session_id`, `x-client-request-id`, and `x-session-affinity`; `openai-nosession` sends `x-client-request-id` and `x-session-affinity`; `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param, which is governed by cache retention. Default: auto-detected. */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** provider 是否支持长提示缓存保留（`prompt_cache_retention: "24h"` 或 Anthropic 风格 `cache_control.ttl: "1h"`，取决于格式）。默认：true。 */
	supportsLongCacheRetention?: boolean;
}

/**
 * OpenAI Responses API 的兼容性设置。
 *
 * 定位：为使用 OpenAI Responses 协议的自定义 provider 提供行为微调开关。
 */
export interface OpenAIResponsesCompat {
	/** provider 是否支持 `developer` 角色（相对于 `system`）。默认：true。 */
	supportsDeveloperRole?: boolean;
	/** Session-affinity header format: `openai` sends `session_id` and `x-client-request-id`; `openai-nosession` sends `x-client-request-id`; `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param, which is governed by cache retention. Default: auto-detected. */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** provider 是否支持 `prompt_cache_retention: "24h"`。默认：true。 */
	supportsLongCacheRetention?: boolean;
	/** 模型是否支持客户端执行的延迟工具搜索。默认：false。 */
	supportsToolSearch?: boolean;
}

/**
 * Anthropic Messages 兼容 API 的兼容性设置。
 *
 * 定位：为使用 Anthropic Messages 协议的自定义 provider 提供行为微调开关。
 */
export interface AnthropicMessagesCompat {
	/**
	 * provider 是否接受按工具的 `eager_input_streaming`。
	 * 当为 `false` 时，Anthropic provider 省略 `tools[].eager_input_streaming`，
	 * 并对带工具的请求发送旧版 `fine-grained-tool-streaming-2025-05-14` beta 头。
	 * 默认：true。
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** provider 是否支持 Anthropic 长缓存保留（`cache_control.ttl: "1h"`）。默认：true。 */
	supportsLongCacheRetention?: boolean;
	/**
	 * 启用缓存时，是否从 `options.sessionId` 发送 `x-session-affinity` 请求头。
	 * Fireworks 等 provider 使用会话亲和性进行提示缓存路由（请求发往同一副本
	 * 可最大化缓存命中率），因此需要启用此项。
	 * 默认：false。
	 */
	sendSessionAffinityHeaders?: boolean;
	/**
	 * provider 是否支持在工具定义上使用 Anthropic 风格的 `cache_control` 标记。
	 * 当为 `false` 时，从工具参数中省略 `cache_control`。
	 * 某些 Anthropic 兼容 provider（如 Fireworks）不支持工具上的此字段，可能拒绝或忽略它。
	 * 默认：true。
	 */
	supportsCacheControlOnTools?: boolean;
	/**
	 * 模型是否接受 Anthropic 的 `temperature` 请求字段。
	 * Claude Opus 4.7+ 拒绝非默认的 temperature 值。
	 * 默认：true。
	 */
	supportsTemperature?: boolean;
	/**
	 * 是否强制使用自适应 thinking（`thinking.type: "adaptive"` 加
	 * `output_config.effort`），无论模型 ID 如何。需要自适应 thinking 的内置模型
	 * 在生成元数据中设置此项。自定义 Anthropic 兼容 provider 可对上游要求
	 * 自适应格式的任何模型设为 `true`。设为 `false` 可在覆盖内置模型时选择退出。
	 * 默认：false。
	 */
	forceAdaptiveThinking?: boolean;
	/** 是否将空的 thinking 签名重放为 `signature: ""` 而非将 thinking 转为文本。默认：false。 */
	allowEmptySignature?: boolean;
	/**
	 * provider 是否支持通过工具结果中的 `tool_reference` 块加载延迟工具。
	 * 默认：对 Anthropic 第一方模型（除 Haiku 和早于 Claude 4.5 的模型外）为 true；
	 * 其他 provider 为 false。
	 */
	supportsToolReferences?: boolean;
}

/**
 * OpenRouter provider 路由偏好。
 *
 * 定位：控制 OpenRouter 将请求路由到哪些上游 provider。
 * 作为 `provider` 字段发送到 OpenRouter API 请求体中。
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface OpenRouterRouting {
	/** 是否允许备用 provider 处理请求。默认：true。 */
	allow_fallbacks?: boolean;
	/** 是否过滤 provider，仅保留支持请求中所有参数的那些。默认：false。 */
	require_parameters?: boolean;
	/** 数据收集设置。"allow"（默认）：允许可能存储/训练数据的 provider。"deny"：仅使用不收集用户数据的 provider。 */
	data_collection?: "deny" | "allow";
	/** 是否限制路由仅到 ZDR（Zero Data Retention，零数据保留）端点。 */
	zdr?: boolean;
	/** 是否限制路由仅到允许文本蒸馏的模型。 */
	enforce_distillable_text?: boolean;
	/** 按顺序尝试的 provider 名称/slug 列表，不可用时回退到下一个。 */
	order?: string[];
	/** 此请求独占允许的 provider 名称/slug 列表。 */
	only?: string[];
	/** 此请求要跳过的 provider 名称/slug 列表。 */
	ignore?: string[];
	/** 按量化级别过滤 provider 的列表（例如 ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]）。 */
	quantizations?: string[];
	/** 排序策略。可以是字符串（例如 "price"、"throughput"、"latency"）或带 `by` 和 `partition` 的对象。 */
	sort?:
		| string
		| {
				/** 排序指标："price"（价格）、"throughput"（吞吐量）、"latency"（延迟）。 */
				by?: string;
				/** 分区策略："model"（默认）或 "none"。 */
				partition?: string | null;
		  };
	/** 每百万 token 的最高价格（USD）。 */
	max_price?: {
		/** 每百万 prompt token 价格。 */
		prompt?: number | string;
		/** 每百万 completion token 价格。 */
		completion?: number | string;
		/** 每张图片价格。 */
		image?: number | string;
		/** 每音频单位价格。 */
		audio?: number | string;
		/** 每次请求价格。 */
		request?: number | string;
	};
	/** 首选最低吞吐量（tokens/秒）。可以是数字（应用于 p50）或带百分位特定阈值的对象。 */
	preferred_min_throughput?:
		| number
		| {
				/** 第 50 百分位的最低 tokens/秒。 */
				p50?: number;
				/** 第 75 百分位的最低 tokens/秒。 */
				p75?: number;
				/** 第 90 百分位的最低 tokens/秒。 */
				p90?: number;
				/** 第 99 百分位的最低 tokens/秒。 */
				p99?: number;
		  };
	/** 首选最大延迟（秒）。可以是数字（应用于 p50）或带百分位特定阈值的对象。 */
	preferred_max_latency?:
		| number
		| {
				/** 第 50 百分位的最大延迟（秒）。 */
				p50?: number;
				/** 第 75 百分位的最大延迟（秒）。 */
				p75?: number;
				/** 第 90 百分位的最大延迟（秒）。 */
				p90?: number;
				/** 第 99 百分位的最大延迟（秒）。 */
				p99?: number;
		  };
}

/**
 * Vercel AI Gateway 路由偏好。
 * 定位：控制 Vercel AI Gateway 将请求路由到哪些上游 provider。
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** 此请求独占使用的 provider slug 列表（例如 ["bedrock", "anthropic"]）。 */
	only?: string[];
	/** 按顺序尝试的 provider slug 列表（例如 ["anthropic", "openai"]）。 */
	order?: string[];
}

/**
 * 模型成本费率。
 * 定位：定义每百万 token 的输入、输出和缓存成本。
 * 所有价格字段单位均为美元/百万 tokens。
 */
export interface ModelCostRates {
	/** 美元/百万 tokens。 */
	input: number;
	/** 美元/百万 tokens。 */
	output: number;
	/** 美元/百万 tokens。 */
	cacheRead: number;
	/** 美元/百万 tokens。 */
	cacheWrite: number;
}

/**
 * 成本阶梯结构。
 * 定位：基于输入 token 量的分段定价，在基础费率上叠加。
 * 当请求总输入量超过指定阈值时，适用该阶梯费率。
 */
export interface ModelCostTier extends ModelCostRates {
	/** 当请求总输入用量超过此 token 数时，使用该阶梯费率。 */
	inputTokensAbove: number;
}

/**
 * 模型完整成本模型。
 * 定位：包含基础费率和可选的分段定价阶梯。
 * 最高的匹配输入阈值会应用于整个请求。
 */
export interface ModelCost extends ModelCostRates {
	/** 请求级分段定价阶梯。匹配到的最高输入阈值应用于整个请求。 */
	tiers?: ModelCostTier[];
}

// ============================================================================
// 模型与兼容配置
// ============================================================================

/**
 * 统一模型系统中的模型描述结构。包含 API 绑定、provider、成本、能力等元数据。
 * 泛型 `TApi` 约束该模型所属的 API 类型，并收窄 `compat` 字段的类型。
 */
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	/**
	 * 将 pi thinking 档位映射到 provider/模型特定值。
	 * 缺失的 key 使用 provider 默认值。`null` 标记该档位不受支持。
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** OpenAI 兼容 API 的兼容性覆盖。未设置时从 baseUrl 自动检测。 */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: never;
}

/**
 * 图片模型描述结构。
 * 定位：继承自 `Model`，但针对图片生成场景去除了 reasoning、contextWindow、maxTokens 等文本限定字段，
 * 并替换为图片特定的 provider 标识和输出类型声明。
 */
export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	api: TApi;
	provider: ImagesProviderId;
	output: ("text" | "image")[];
}
