import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.ts";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

/**
 * `openai-responses` provider 的实现文件。
 *
 * 文件定位：
 * - 这是 `pi-ai` 里一个很有代表性的 provider 实现
 * - 它展示了统一入口调度链进入 provider 之后，如何落到官方 SDK
 *
 * 在整体调用链中的位置：
 * - `stream.ts` 根据 `model.api` 找到 provider
 * - `api-registry.ts` 返回这里注册的 stream 函数
 * - `register-builtins.ts` 通过懒加载包装器首次动态 import 本文件
 * - 本文件创建 SDK client、构造 payload、消费 SDK 流、翻译统一事件
 * - 上游如 `packages/agent` 再消费这些 `AssistantMessageEvent`
 *
 * 阅读方法：
 * - 先看 `streamOpenAIResponses()` 的主流程
 * - 再看 `createClient()` 和 `buildParams()` 分别吸收了哪些 provider 差异
 * - 最后看 `applyServiceTierPricing()` 和 `formatOpenAIResponsesError()` 这类 helper
 */
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai"]);

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 解析缓存保留策略。
 *
 * 调用链：streamOpenAIResponses() → 本函数；buildParams() → 本函数
 * 调用了谁：无
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	// 如果调用方显式传入，直接使用
	if (cacheRetention) {
		return cacheRetention;
	}
	// 否则检查环境变量（向后兼容）
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	// 都没有则默认 "short"
	return "short";
}

/**
 * 从 model.compat 补齐 provider 兼容性开关。
 *
 * 调用链：createClient() → 本函数；buildParams() → 本函数
 * 调用了谁：无
 *
 * 作用：把 model.compat 中可能为 undefined 的字段补齐为默认值，
 * 避免调用方每次都写 `model.compat?.sendSessionIdHeader ?? true`。
 */
function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

/**
 * 根据兼容性配置和缓存策略，决定 prompt cache retention 值。
 *
 * 调用链：buildParams() → 本函数
 * 调用了谁：无
 */
function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	// 只有 cacheRetention === "long" 且模型支持长期缓存时，才返回 "24h"
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

/**
 * 统一把 SDK / 非 Error 对象格式化成可直接放进 AssistantMessage.errorMessage 的字符串。
 *
 * 调用链：streamOpenAIResponses() catch 块 → 本函数
 * 调用了谁：无
 */
function formatOpenAIResponsesError(error: unknown): string {
	// 如果是 Error 实例，提取 status code（如有）拼入错误消息
	if (error instanceof Error) {
		const status = (error as Error & { status?: unknown }).status;
		const statusCode = typeof status === "number" ? status : undefined;
		if (statusCode !== undefined) {
			return `OpenAI API error (${statusCode}): ${error.message}`;
		}
		return error.message;
	}
	// 如果不是 Error，尝试 JSON.stringify
	try {
		return JSON.stringify(error);
	} catch {
		// JSON.stringify 失败则用 String() 兜底
		return String(error);
	}
}

// =============================================================================
// OpenAI Responses 专属选项
// =============================================================================

/**
 * OpenAI Responses API 的 provider 专属选项。
 *
 * 继承自 StreamOptions（统一基础选项），增加了 Responses API 特有的字段。
 * 只有调用 streamOpenAIResponses() 时才能传这些选项；
 * 调用 streamSimpleOpenAIResponses() 时只能用 SimpleStreamOptions。
 */
export interface OpenAIResponsesOptions extends StreamOptions {
	/** 推理努力级别，映射为 OpenAI 的 reasoning.effort 参数。 */
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	/** 推理摘要模式，映射为 OpenAI 的 reasoning.summary 参数。 */
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	/** 服务层级，影响定价倍率（flex = 0.5x，priority = 2x）。 */
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

// =============================================================================
// 主入口函数
// =============================================================================

/**
 * OpenAI Responses API 的完整参数流式入口。
 *
 * 调用链：
 * - stream.ts → resolveApiProvider() → getApiProvider() → 本函数
 * - 或 register-builtins.ts 的懒加载包装器 → 本函数
 *
 * 调用了谁：
 * - getEnvApiKey()、resolveCacheRetention()、createClient()、buildParams()
 * - processResponsesStream()（openai-responses-shared.ts）
 * - formatOpenAIResponsesError()、applyServiceTierPricing()
 * - headersToRecord()（utils/headers.ts）
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	// 创建空的事件流，立即返回给调用方
	const stream = new AssistantMessageEventStream();

	// 异步处理（IIFE），不阻塞返回
	(async () => {
		// 初始化 output：一个空的 AssistantMessage，用于在流式过程中累积状态
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
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
			// 步骤 1：解析认证和缓存策略
			// apiKey 优先级：显式传入 > 环境变量 > 空字符串
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const cacheRetention = resolveCacheRetention(options?.cacheRetention);
			// 缓存为 "none" 时不需要 sessionId
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

			// 步骤 2：创建 OpenAI SDK client
			// 吸收了认证、headers、session 等 provider 差异
			const client = createClient(model, context, apiKey, options?.headers, cacheSessionId);

			// 步骤 3：构建请求 payload
			// 内部调用 convertResponsesMessages() 和 convertResponsesTools()
			let params = buildParams(model, context, options);
			// onPayload 钩子：允许调用方在发送前检查或修改 payload
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}

			// 步骤 4：组装请求选项（signal 透传给 fetch 以支持中止）
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};

			// 步骤 5：发起 SDK 流式请求
			// .withResponse() 同时返回响应体流和 HTTP 响应对象
			const { data: openaiStream, response } = await client.responses.create(params, requestOptions).withResponse();
			// onResponse 钩子：把响应头回抛给调用方（用于诊断/日志）
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			// 推送 start 事件，通知消费者流已开始
			stream.push({ type: "start", partial: output });

			// 步骤 6：事件协议转换
			// 这是真正的核心：OpenAI SDK 的流事件 → pi 的 AssistantMessageEvent
			// 内部会逐步更新 output（content、usage、stopReason）
			await processResponsesStream(openaiStream, output, stream, model, {
				serviceTier: options?.serviceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			// 步骤 7：最终检查
			// 如果 signal 被中止，抛出异常进入 catch
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			// 如果流处理过程中设置了错误 stopReason，也抛出异常
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			// 步骤 8：成功收口
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// 错误处理：清理流式过程中的临时字段
			for (const block of output.content) {
				delete (block as { index?: number }).index; // 流式索引
				delete (block as { partialJson?: string }).partialJson; // 流式 JSON 缓冲
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatOpenAIResponsesError(error);
			// 失败也走协议内事件（不直接 throw），保证消费者能统一处理
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 简化入口：把统一的 SimpleStreamOptions 映射为 OpenAI Responses 专属参数。
 *
 * 调用链：
 * - stream.ts 的 streamSimple() → resolveApiProvider() → 本函数
 * - 或 register-builtins.ts 的懒加载包装器 → 本函数
 *
 * 调用了谁：
 * - getEnvApiKey()、buildBaseOptions()（simple-options.ts）
 * - clampThinkingLevel()（models.ts）
 * - streamOpenAIResponses()：转调完整参数版本
 */
export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// 步骤 1：获取 API 密钥（显式 > 环境变量），没有则报错
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// 步骤 2：用 buildBaseOptions 提取统一参数
	const base = buildBaseOptions(model, options, apiKey);
	// 步骤 3：把推理级别钳位到模型支持的范围
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	// "off" 表示关闭推理，不需要传 reasoningEffort
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	// 步骤 4：组装 OpenAIResponsesOptions，转调完整参数版本
	return streamOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

// =============================================================================
// SDK Client 和 Payload 构建
// =============================================================================

/**
 * 创建 OpenAI SDK client 实例。
 *
 * 调用链：streamOpenAIResponses() 步骤 2 → 本函数
 * 调用了谁：getCompat()（获取兼容性配置）
 *
 * 吸收的差异：
 * - 认证来源：显式 apiKey → 环境变量 OPENAI_API_KEY → 报错
 * - session 相关 headers（session_id、x-client-request-id）
 * - 调用方传入的自定义 headers（优先级最高，可覆盖默认值）
 */
function createClient(
	model: Model<"openai-responses">,
	_context: Context,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
) {
	// 步骤 1：解析 apiKey（显式 > 环境变量 > 报错）
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	// 步骤 2：获取兼容性配置
	const compat = getCompat(model);
	// 步骤 3：复制 model.headers 作为基础 headers
	const headers = { ...model.headers };

	// 步骤 4：如果有 sessionId，根据兼容性配置添加 session 相关 header
	if (sessionId) {
		if (compat.sendSessionIdHeader) {
			headers.session_id = sessionId;
		}
		headers["x-client-request-id"] = sessionId;
	}

	// 步骤 5：合并调用方的自定义 headers（覆盖默认值）
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	const defaultHeaders = headers;

	// 步骤 6：创建 OpenAI SDK 实例
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});
}

/**
 * 构建最终发给 OpenAI Responses API 的 payload。
 *
 * 调用链：streamOpenAIResponses() 步骤 3 → 本函数
 * 调用了谁：
 * - convertResponsesMessages()、convertResponsesTools()（openai-responses-shared.ts）
 * - resolveCacheRetention()、getCompat()、getPromptCacheRetention()
 * - clampOpenAIPromptCacheKey()（openai-prompt-cache.ts）
 */
function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions) {
	// 步骤 1：转换消息格式
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS);

	// 步骤 2：解析缓存策略和兼容性配置
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const compat = getCompat(model);

	// 步骤 3：构建基础 payload
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		store: false,
	};

	// 步骤 4：按需添加可选字段
	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}
	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}
	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	// 步骤 5：如果有工具，转换工具格式
	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}

	// 步骤 6：如果模型支持推理，配置 reasoning 参数
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			// 有显式推理配置：使用 thinkingLevelMap 映射 effort
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			// 请求加密的推理内容，用于多轮对话回放
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			// 没有显式配置但模型支持关闭推理：使用 thinkingLevelMap 中的 off 值
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		// thinkingLevelMap?.off === null 时：模型不支持关闭推理，不设置 reasoning 参数
	}

	return params;
}

// =============================================================================
// 定价计算
// =============================================================================

/**
 * 获取 service tier 的定价倍率。
 *
 * 调用链：applyServiceTierPricing() → getServiceTierCostMultiplier()
 * 调用了谁：无
 *
 * 倍率规则：
 * - "flex"：0.5x（半价，延迟更高）
 * - "priority"：2x 或 2.5x（gpt-5.5 为 2.5x）
 * - 默认：1x（标准价格）
 */
function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

/**
 * 在统一 usage/cost 结构上叠加 OpenAI service tier 的倍率。
 *
 * 调用链：streamOpenAIResponses() → processResponsesStream() 回调 → 本函数
 * 调用了谁：getServiceTierCostMultiplier()
 */
function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	// 步骤 1：获取倍率
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	// 步骤 2：如果倍率为 1，直接返回（不修改）
	if (multiplier === 1) return;

	// 步骤 3：把所有费用字段乘以倍率
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
