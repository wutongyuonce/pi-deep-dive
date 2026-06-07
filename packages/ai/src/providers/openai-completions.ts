/**
 * OpenAI Chat Completions API 的 provider 实现。
 *
 * 文件定位：
 * - 这是 pi-ai 的 "openai-completions" API 协议的具体 provider 实现
 * - 负责将统一的 Message/Context 模型转换为 OpenAI Chat Completions 格式，
 *   发起流式请求，并将 OpenAI 的 SSE chunk 翻译为 pi-ai 的统一事件协议
 *
 * 整体调用链（从上到下）：
 *
 *   stream.ts 的 stream()/streamSimple()
 *     -> resolveApiProvider("openai-completions")
 *       -> register-builtins.ts 的懒加载包装器
 *         -> 本文件的 streamOpenAICompletions() / streamSimpleOpenAICompletions()
 *           -> createClient()          创建 OpenAI SDK 客户端
 *           -> buildParams()           构建请求 payload
 *             -> convertMessages()     转换消息格式
 *             -> convertTools()        转换工具格式
 *           -> client.chat.completions.create()  发起真正的 HTTP 请求
 *           -> 遍历 SSE chunk 流，翻译为统一事件
 *
 * 谁会调用本文件的函数：
 * - register-builtins.ts 的 loadOpenAICompletionsProviderModule() 动态导入本模块
 * - register-builtins.ts 通过 createLazyStream/createLazySimpleStream 包装后
 *   注册到 api-registry.ts 的全局注册表
 * - stream.ts 通过注册表间接调用
 */

// ============================================================================
// 导入
// ============================================================================

// OpenAI 官方 SDK，用于创建客户端和发起 Chat Completions API 请求
import OpenAI from "openai";

// OpenAI SDK 的类型定义，用于流式 chunk、消息参数等的类型约束
import type {
	ChatCompletionAssistantMessageParam, // assistant 角色消息的参数类型
	ChatCompletionChunk, // 流式 chunk 的类型（包含 delta、finish_reason 等）
	ChatCompletionContentPart, // 内容块的联合类型（text | image_url）
	ChatCompletionContentPartImage, // 图片内容块类型
	ChatCompletionContentPartText, // 文本内容块类型
	ChatCompletionDeveloperMessageParam, // developer 角色消息参数（推理模型使用）
	ChatCompletionMessageParam, // 所有消息类型的联合类型
	ChatCompletionSystemMessageParam, // system 角色消息参数
	ChatCompletionToolMessageParam, // tool 结果消息参数
} from "openai/resources/chat/completions.js";

// 从环境变量获取 API key 的工具函数
// 调用链：streamOpenAICompletions() -> getEnvApiKey()
import { getEnvApiKey } from "../env-api-keys.ts";

// calculateCost：根据 token 用量计算费用，调用链：parseChunkUsage() -> calculateCost()
// clampThinkingLevel：将推理级别钳位到模型支持的范围，调用链：streamSimpleOpenAICompletions() -> clampThinkingLevel()
import { calculateCost, clampThinkingLevel } from "../models.ts";

// pi-ai 的核心类型定义
import type {
	AssistantMessage, // 最终的 assistant 消息结构体
	CacheRetention, // 缓存策略："short" | "long" | "none"
	Context, // 请求上下文（包含 systemPrompt、messages、tools）
	ImageContent, // 图片内容块
	Message, // 统一消息类型（user | assistant | toolResult）
	Model, // 模型配置（包含 provider、baseUrl、compat 等）
	OpenAICompletionsCompat, // OpenAI Completions 兼容性配置类型
	SimpleStreamOptions, // 简化入口的选项类型
	StopReason, // 停止原因类型
	StreamFunction, // 流式函数签名类型
	StreamOptions, // 完整参数的选项类型
	TextContent, // 文本内容块
	ThinkingContent, // 推理/思考内容块
	Tool, // 工具定义
	ToolCall, // 工具调用块
	ToolResultMessage, // 工具结果消息
} from "../types.ts";

// AssistantMessageEventStream：事件流类，用于实时推送 text_delta/toolcall_delta/done 等事件
// 调用链：streamOpenAICompletions() 创建实例并持续 push 事件
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

// 将 Headers 对象转为普通 Record，用于 onResponse 回调
import { headersToRecord } from "../utils/headers.ts";

// 解析流式 JSON（工具调用参数是分 chunk 到达的，需要增量解析）
// 调用链：streamOpenAICompletions 的 finishBlock() 和 toolcall_delta 处理 -> parseStreamingJson()
import { parseStreamingJson } from "../utils/json-parse.ts";

// 清理 Unicode 代理对字符，避免发送非法 UTF-16 到 API
// 调用链：convertMessages() -> sanitizeSurrogates()
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

// 将 session ID 钳位到 prompt cache key 的长度限制
// 调用链：buildParams() -> clampOpenAIPromptCacheKey()
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";

// 从 SimpleStreamOptions 提取基础选项（temperature、maxTokens、signal 等）
// 调用链：streamSimpleOpenAICompletions() -> buildBaseOptions()
import { buildBaseOptions } from "./simple-options.ts";

// 预处理消息：合并连续同角色消息、规范化 tool call ID 等
// 调用链：convertMessages() -> transformMessages()
import { transformMessages } from "./transform-messages.ts";

// ============================================================================
// 辅助函数：消息历史检测
// ============================================================================

/**
 * 检查对话消息中是否包含工具调用或工具结果。
 *
 * 谁调用我：buildParams()，在没有显式 tools 但消息历史里有工具使用记录时判断
 * 我调用谁：无（纯遍历检查）
 *
 * 为什么需要这个：
 * Anthropic（通过 LiteLLM/proxy 代理时）要求：如果消息中有 tool_calls 或 tool role，
 * 则必须同时传 tools 参数，否则 API 会报错。这个函数帮助 buildParams() 判断是否需要传空 tools[]。
 */
function hasToolHistory(messages: Message[]): boolean {
	// 遍历所有消息，只要发现一个 toolResult 或 assistant 的 toolCall 就返回 true
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

// ============================================================================
// 辅助函数：类型守卫（Type Guards）
// ============================================================================

/**
 * 类型守卫：判断内容块是否为文本块。
 * 谁调用我：convertMessages() 中过滤 assistant 消息的文本部分
 */
function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

/**
 * 类型守卫：判断内容块是否为推理/思考块。
 * 谁调用我：convertMessages() 中提取 assistant 消息的 thinking 部分
 */
function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

/**
 * 类型守卫：判断内容块是否为工具调用块。
 * 谁调用我：convertMessages() 中提取 assistant 消息的 tool_calls 部分
 */
function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

/**
 * 类型守卫：判断内容块是否为图片块。
 * 谁调用我：convertMessages() 中处理 tool result 里的图片
 */
function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * OpenAI Completions provider 的完整选项接口。
 * 继承自 StreamOptions（统一基础选项），增加了两个 OpenAI 特有字段：
 * - toolChoice：控制工具调用策略（auto/none/required/指定函数名）
 * - reasoningEffort：推理努力级别（影响推理 token 预算）
 *
 * 谁使用：streamOpenAICompletions() 的 options 参数
 */
export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

/** Anthropic 风格的缓存控制标记，用于 prompt caching。 */
interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

/**
 * 完全解析后的 OpenAI Completions 兼容性配置。
 * Required<> 确保所有字段都有默认值，方便后续代码直接读取而无需 undefined 检查。
 * cacheControlFormat 保留可选，因为不是所有 provider 都支持缓存控制。
 */
type ResolvedOpenAICompletionsCompat = Omit<Required<OpenAICompletionsCompat>, "cacheControlFormat"> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

/** developer 或 system 角色的消息参数类型。 */
type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

/** 带缓存控制标记的文本内容块。 */
type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

/** 带缓存控制标记的工具定义。 */
type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

// ============================================================================
// 辅助函数：缓存策略解析
// ============================================================================

/**
 * 解析缓存策略（CacheRetention）。
 *
 * 谁调用我：
 * - streamOpenAICompletions() 的步骤 3（解析缓存策略）
 * - buildParams() 的默认参数
 *
 * 我调用谁：无
 *
 * 解析优先级：
 * 1. 显式传入的 cacheRetention 参数
 * 2. 环境变量 PI_CACHE_RETENTION === "long"
 * 3. 默认 "short"
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

// ============================================================================
// 核心函数：完整参数流式入口
// ============================================================================

/**
 * OpenAI Chat Completions API 的完整参数流式入口函数。
 *
 * 调用链路：
 *   stream.ts -> resolveApiProvider("openai-completions")
 *     -> register-builtins.ts 的 createLazyStream 包装
 *       -> 本函数
 *
 * 谁调用我：
 * - register-builtins.ts 的懒加载包装器（首次调用时动态 import 本模块后调用）
 * - streamSimpleOpenAICompletions()（简化入口转调本函数）
 * - 测试代码可能直接调用
 *
 * 我调用谁：
 * - getEnvApiKey()            获取环境变量中的 API key
 * - getCompat()               获取模型的兼容性配置
 * - resolveCacheRetention()   解析缓存策略
 * - createClient()            创建 OpenAI SDK 客户端
 * - buildParams()             构建请求 payload
 * - options.onPayload()       请求前回调（可选）
 * - client.chat.completions.create()  发起真正的 HTTP 流式请求
 * - options.onResponse()      收到响应后回调（可选）
 * - parseChunkUsage()         解析 token 用量
 * - mapStopReason()           映射停止原因
 * - parseStreamingJson()      增量解析工具调用的 JSON 参数
 */
export const streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	// 1. 创建事件流并立即返回。
	// 调用方可以立即订阅事件，异步处理在下面的 IIFE 中进行。
	const stream = new AssistantMessageEventStream();

	// 2. 异步 IIFE：所有实际工作在这里进行，不阻塞返回。
	(async () => {
		// 3. 初始化输出消息骨架。
		// 这个 output 对象会在整个流式过程中被持续修改，逐步填充 content、usage 等字段。
		// 它同时也是每个事件的 partial 字段，让订阅者能实时看到"当前为止的完整消息"。
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
			// 4. 解析认证和兼容性配置。
			// apiKey 优先级：显式传入的 options.apiKey > 环境变量 > 空字符串
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			// 获取模型的兼容性配置（哪些 OpenAI 特性该模型支持/不支持）
			const compat = getCompat(model);
			// 解析缓存策略（short/long/none）
			const cacheRetention = resolveCacheRetention(options?.cacheRetention);
			// 只有在缓存策略不是 "none" 时才传 session ID 用于缓存亲和性
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

			// 5. 创建 OpenAI SDK 客户端。
			// 内部会设置 apiKey、baseURL、默认 headers（含 session 亲和性 headers）
			const client = createClient(model, context, apiKey, options?.headers, cacheSessionId, compat);

			// 6. 构建请求 payload（messages、tools、stream_options 等）。
			let params = buildParams(model, context, options, compat, cacheRetention);

			// 7. 调用 onPayload 回调，允许调用方在发送前修改 payload。
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}

			// 8. 构建请求选项（signal、timeout、重试次数）。
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};

			// 9. 发起流式 HTTP 请求。
			// .withResponse() 同时返回 SDK stream 和原始 HTTP response。
			const { data: openaiStream, response } = await client.chat.completions
				.create(params, requestOptions)
				.withResponse();

			// 10. 调用 onResponse 回调，让调用方知道响应状态。
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			// 11. 推送 "start" 事件，通知订阅者流式处理开始。
			stream.push({ type: "start", partial: output });

			// 12. 流式处理的内部类型和状态

			/**
			 * 流式工具调用块：在 ToolCall 基础上增加两个临时字段：
			 * - partialArgs：累积的 JSON 字符串片段（工具参数是分 chunk 到达的）
			 * - streamIndex：OpenAI 返回的 tool_call index（用于匹配后续 delta）
			 *
			 * 流结束后这两个字段会被 delete，不会出现在最终结果中。
			 */
			interface StreamingToolCallBlock extends ToolCall {
				partialArgs?: string;
				streamIndex?: number;
			}
			/** 流式处理中的内容块类型：文本 | 思考 | 工具调用。 */
			type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
			/** OpenAI delta 中单个工具调用的类型。 */
			type StreamingToolCallDelta = NonNullable<ChatCompletionChunk.Choice.Delta["tool_calls"]>[number];

			// 当前正在构建的文本块（一次只有一个活跃文本块）
			let textBlock: TextContent | null = null;
			// 当前正在构建的思考块（一次只有一个活跃思考块）
			let thinkingBlock: ThinkingContent | null = null;
			// 是否已收到 finish_reason（用于检测流是否正常结束）
			let hasFinishReason = false;
			// 工具调用块的索引映射：按 streamIndex 和 id 双重索引，方便后续 delta 匹配
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			// output.content 的引用，类型断言为流式块类型
			const blocks = output.content as StreamingBlock[];

			// 获取某个块在 content 数组中的索引位置（用于事件的 contentIndex 字段）
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);

			/**
			 * 完成（终结）一个内容块。
			 * 根据块类型推送对应的 *_end 事件，并做最终处理：
			 * - text：推送 text_end
			 * - thinking：推送 thinking_end
			 * - toolCall：解析累积的 partialArgs 为最终 JSON，删除临时字段，推送 toolcall_end
			 *
			 * 谁调用我：
			 * - 流结束后对所有 blocks 调用（"步骤 12：完成所有未终结的内容块"）
			 */
			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) {
					return;
				}
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					// 将增量累积的 JSON 字符串解析为最终对象
					block.arguments = parseStreamingJson(block.partialArgs);
					// 删除临时字段，确保 replay/retry 只携带解析后的 arguments
					delete block.partialArgs;
					delete block.streamIndex;
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output,
					});
				}
			};

			/**
			 * 确保当前有一个活跃的文本块，没有则创建。
			 * 谁调用我：处理 choice.delta.content 时（收到文本增量时）
			 * 我做了什么：如果 textBlock 为 null，创建新块并推送到 blocks，同时推送 text_start 事件。
			 */
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};

			/**
			 * 确保当前有一个活跃的思考块，没有则创建。
			 * 谁调用我：处理 reasoning_content/reasoning/reasoning_text 时（收到推理增量时）
			 * thinkingSignature 用于标识推理字段来源（如 "reasoning_content"）。
			 */
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature,
					};
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};

			/**
			 * 确保某个工具调用块已存在，没有则创建。
			 * 工具调用块通过 streamIndex 和 id 双重索引：
			 * - streamIndex：OpenAI 返回的 tool_call.index（同一次调用中唯一）
			 * - id：工具调用的唯一标识符（可能在后续 chunk 中才到达）
			 *
			 * 谁调用我：处理 choice.delta.tool_calls 时（收到工具调用增量时）
			 *
			 * 匹配逻辑：
			 * 1. 先按 streamIndex 查找（最快）
			 * 2. 找不到再按 id 查找
			 * 3. 都找不到则创建新块
			 */
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				if (!block) {
					// 创建新的工具调用块
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name: toolCall.function?.name || "",
						arguments: {},
						partialArgs: "", // 累积 JSON 字符串，最终由 parseStreamingJson 解析
						streamIndex,
					};
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				// 建立/更新索引映射（处理 streamIndex 后到或 id 后到的情况）
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				return block;
			};

			// 13. 遍历 SSE chunk 流

			/**
			 * 核心循环：逐个处理 OpenAI 返回的 ChatCompletionChunk。
			 *
			 * 每个 chunk 的结构：
			 * - id：请求标识符（所有 chunk 共享同一个 id）
			 * - model：实际使用的模型名（可能与请求的 model.id 不同）
			 * - usage：token 用量（部分 provider 在最后一个 chunk 返回）
			 * - choices[0].delta：增量内容（文本/推理/工具调用）
			 * - choices[0].finish_reason：停止原因（通常在最后一个 chunk）
			 */
			for await (const chunk of openaiStream) {
				if (!chunk || typeof chunk !== "object") continue;

				// 记录响应 ID（所有 chunk 共享，用 ||= 只取第一个）
				output.responseId ||= chunk.id;
				// 记录实际返回的模型名（可能与请求的不同，如 fallback 场景）
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				// 解析 token 用量（标准位置：chunk.usage）
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				// 取第一个 choice（Chat Completions API 通常只返回一个 choice）
				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				// 兼容处理：部分 provider 把 usage 放在 choice.usage 而不是标准的 chunk.usage
				if (!chunk.usage && (choice as any).usage) {
					output.usage = parseChunkUsage((choice as any).usage, model);
				}

				// 处理停止原因
				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					hasFinishReason = true;
				}

				// 处理增量内容（delta）
				if (choice.delta) {
					// --- 处理文本增量 ---
					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output,
						});
					}

					// --- 处理推理/思考增量 ---
					// 不同 provider 用不同的字段名返回推理内容：
					// - reasoning_content：llama.cpp
					// - reasoning：其他 OpenAI 兼容端点
					// - reasoning_text：某些特定端点
					// 只使用第一个非空字段，避免 chutes.ai 等同时返回多个字段导致重复
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const deltaFields = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | null = null;
					for (const field of reasoningFields) {
						const value = deltaFields[field];
						if (typeof value === "string" && value.length > 0) {
							foundReasoningField = field;
							break;
						}
					}

					if (foundReasoningField) {
						const delta = deltaFields[foundReasoningField];
						if (typeof delta === "string" && delta.length > 0) {
							const block = ensureThinkingBlock(foundReasoningField);
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					// --- 处理工具调用增量 ---
					if (choice?.delta?.tool_calls) {
						for (const toolCall of choice.delta.tool_calls) {
							const block = ensureToolCallBlock(toolCall);
							// 补充 id（有些 provider 的第一个 chunk 没有 id）
							if (!block.id && toolCall.id) {
								block.id = toolCall.id;
								toolCallBlocksById.set(toolCall.id, block);
							}
							// 补充函数名（第一个 chunk 可能只有 index，name 在后续 chunk 中）
							if (!block.name && toolCall.function?.name) {
								block.name = toolCall.function.name;
							}

							// 累积参数 JSON 片段并增量解析
							let delta = "";
							if (toolCall.function?.arguments) {
								delta = toolCall.function.arguments;
								block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
								// 增量解析：每收到一段 JSON 片段就尝试解析，
								// 这样在流式过程中就能得到当前"尽可能完整"的参数对象
								block.arguments = parseStreamingJson(block.partialArgs);
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					// --- 处理推理详情（encrypted reasoning signature）---
					// 某些端点（如 llama.cpp + gpt-oss）会返回 reasoning_details，
					// 包含加密的推理签名，用于后续请求时传递给模型。
					// 将其附加到对应的 toolCall 的 thoughtSignature 字段上。
					const reasoningDetails = (choice.delta as any).reasoning_details;
					if (reasoningDetails && Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
								const matchingToolCall = output.content.find(
									(b) => b.type === "toolCall" && b.id === detail.id,
								) as ToolCall | undefined;
								if (matchingToolCall) {
									matchingToolCall.thoughtSignature = JSON.stringify(detail);
								}
							}
						}
					}
				}
			}

			// 14. 流结束后的清理和验证

			// 完成所有未终结的内容块（推送 *_end 事件）
			for (const block of blocks) {
				finishBlock(block);
			}

			// 验证：请求是否被中止
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			// 验证：provider 是否返回了错误
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			// 验证：流是否正常结束（有些 provider 不返回 finish_reason）
			if (!hasFinishReason) {
				throw new Error("Stream ended without finish_reason");
			}

			// 15. 推送 "done" 事件，表示流式处理成功完成。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// 16. 错误处理：清理临时字段，推送错误事件

			// 清理所有内容块的临时字段（index、partialArgs、streamIndex）
			// 这些字段只在流式处理过程中有意义，不应出现在最终结果中
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { streamIndex?: number }).streamIndex;
			}

			// 设置错误状态
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			// 某些 provider 在 error.error.metadata.raw 中提供额外错误信息
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;

			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	// 17. 立即返回事件流（IIFE 在后台异步执行）
	return stream;
};

// ============================================================================
// 核心函数：简化参数流式入口
// ============================================================================

/**
 * OpenAI Chat Completions API 的简化参数流式入口函数。
 *
 * 调用链路：
 *   stream.ts 的 streamSimple()
 *     -> resolveApiProvider("openai-completions")
 *       -> register-builtins.ts 的 createLazySimpleStream 包装
 *         -> 本函数
 *
 * 谁调用我：
 * - register-builtins.ts 的懒加载包装器
 * - 外部 npm 使用者通过 streamSimple() 间接调用
 * - packages/agent 的默认 streamFn
 *
 * 我调用谁：
 * - getEnvApiKey()             获取环境变量中的 API key
 * - buildBaseOptions()         从 SimpleStreamOptions 提取基础选项
 * - clampThinkingLevel()       将推理级别钳位到模型支持的范围
 * - streamOpenAICompletions()  转调完整参数版本
 *
 * 设计意图：
 * - 把"provider 专属复杂参数"隐藏到 provider 内部
 * - 上层只需要传 reasoning / signal / apiKey 等简单参数
 * - 本函数负责把 SimpleStreamOptions 翻译为 OpenAICompletionsOptions
 */
export const streamSimpleOpenAICompletions: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// 步骤 1：获取 API 密钥（显式传入 > 环境变量），没有则抛错
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// 步骤 2：用 buildBaseOptions 提取通用基础选项
	// （temperature、maxTokens、signal、headers、onPayload 等）
	const base = buildBaseOptions(model, options, apiKey);

	// 步骤 3：将推理级别钳位到模型支持的范围。
	// clampThinkingLevel 会检查模型是否支持推理，以及该级别是否在模型支持列表中。
	// "off" 表示显式关闭推理，不传 reasoningEffort 即可。
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	// 步骤 4：提取 toolChoice（如果有）
	const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;

	// 步骤 5：组装 OpenAICompletionsOptions，转调完整参数版本
	return streamOpenAICompletions(model, context, {
		...base,
		reasoningEffort,
		toolChoice,
	} satisfies OpenAICompletionsOptions);
};

// ============================================================================
// 内部函数：创建 OpenAI SDK 客户端
// ============================================================================

/**
 * 创建并配置 OpenAI SDK 客户端实例。
 *
 * 谁调用我：streamOpenAICompletions() 的步骤 4
 * 我调用谁：new OpenAI()（OpenAI SDK 构造函数）
 *
 * 配置项：
 * - apiKey：认证密钥
 * - baseURL：API 端点（可以是 OpenAI 官方，也可以是兼容代理如 LiteLLM）
 * - dangerouslyAllowBrowser：允许在浏览器环境中使用（测试/演示场景）
 * - defaultHeaders：默认 HTTP headers，包含 session 亲和性 headers（如果启用）
 */
function createClient(
	model: Model<"openai-completions">,
	_context: Context,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
	// 如果没有传入 apiKey，尝试从环境变量 OPENAI_API_KEY 获取
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	// 以模型配置的 headers 为基础
	const headers = { ...model.headers };

	// 如果有 session ID 且模型支持 session 亲和性 headers，
	// 设置三个 headers 用于请求路由亲和性（确保同一 session 的请求路由到同一后端）
	if (sessionId && compat.sendSessionAffinityHeaders) {
		headers.session_id = sessionId;
		headers["x-client-request-id"] = sessionId;
		headers["x-session-affinity"] = sessionId;
	}

	// 合并调用方传入的 headers（优先级最高，可覆盖默认值）
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	const defaultHeaders = headers;

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});
}

// ============================================================================
// 内部函数：构建请求 payload
// ============================================================================

/**
 * 构建发给 OpenAI Chat Completions API 的完整请求 payload。
 *
 * 谁调用我：streamOpenAICompletions() 的步骤 5
 * 我调用谁：
 * - convertMessages()              转换消息格式（pi-ai Message -> OpenAI ChatCompletionMessageParam）
 * - getCompatCacheControl()        获取缓存控制标记
 * - convertTools()                 转换工具定义格式
 * - applyAnthropicCacheControl()   应用 Anthropic 风格的缓存控制
 * - clampOpenAIPromptCacheKey()    规范化 prompt cache key
 *
 * 构建步骤：
 * 1. 转换消息和工具格式
 * 2. 设置基础字段（model、messages、stream、prompt_cache_key 等）
 * 3. 按模型兼容性配置添加可选字段（stream_options、store、max_tokens 等）
 * 4. 添加工具定义和缓存控制标记
 * 5. 设置推理努力级别
 */
function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention),
) {
	// 步骤 1：转换消息格式（pi-ai 统一格式 -> OpenAI Chat Completions 格式）
	const messages = convertMessages(model, context, compat);
	// 步骤 2：获取缓存控制标记（仅当 cacheControlFormat === "anthropic" 时有值）
	const cacheControl = getCompatCacheControl(compat, cacheRetention);

	// 步骤 3：构建基础 payload
	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		// prompt_cache_key：用于 prompt caching 的键。
		// 对 OpenAI 官方 API 或支持长缓存的 provider，在非 "none" 策略下启用。
		prompt_cache_key:
			(model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
			(cacheRetention === "long" && compat.supportsLongCacheRetention)
				? clampOpenAIPromptCacheKey(options?.sessionId)
				: undefined,
		// 长缓存保留策略（24 小时）
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};

	// 步骤 4：按兼容性配置添加可选字段。

	// 请求在流式响应中返回 usage 统计（OpenAI 标准特性）
	if (compat.supportsUsageInStreaming !== false) {
		(params as any).stream_options = { include_usage: true };
	}

	// 禁用 OpenAI 的对话存储功能（我们自己管理历史）
	if (compat.supportsStore) {
		params.store = false;
	}

	// 设置最大输出 token 数。不同 provider 使用不同字段名：
	// - "max_tokens"：旧版 OpenAI、部分兼容端点
	// - "max_completion_tokens"：新版 OpenAI 标准
	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			(params as any).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	// 设置采样温度
	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	// 步骤 5：处理工具定义。
	if (context.tools && context.tools.length > 0) {
		// 有工具定义时，转换为 OpenAI 格式并添加到 payload
		params.tools = convertTools(context.tools, compat);
	} else if (hasToolHistory(context.messages)) {
		// 没有工具定义但消息历史中有工具使用记录（Anthropic proxy 兼容场景），
		// 传空数组以满足 API 要求
		params.tools = [];
	}

	// 步骤 6：应用 Anthropic 风格的缓存控制标记。
	// 在系统提示、最后一个工具定义、最后一段对话消息上添加 cache_control 标记，
	// 实现 prompt caching（避免每次都重新处理完整的系统提示和上下文）。
	if (cacheControl) {
		applyAnthropicCacheControl(messages, params.tools, cacheControl);
	}

	// 步骤 7：设置工具调用策略
	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	// 步骤 8：设置推理努力级别。
	// 仅当模型支持推理且 provider 支持 reasoning_effort 参数时生效。
	// thinkingLevelMap 允许模型将统一的级别名映射为 provider 特定的值。
	if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		// 没有显式指定推理级别时，使用模型的 "off" 值（如果有）来显式关闭推理
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			(params as any).reasoning_effort = offValue;
		}
	}

	return params;
}

// ============================================================================
// 内部函数：缓存控制相关
// ============================================================================

/**
 * 获取缓存控制标记。
 *
 * 谁调用我：buildParams() 的步骤 2
 * 我调用谁：无
 *
 * 仅当 provider 的 cacheControlFormat 为 "anthropic" 且缓存策略不是 "none" 时返回标记。
 * 长缓存模式下支持 TTL（1 小时）。
 */
function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}

	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

/**
 * 在消息和工具上应用 Anthropic 风格的缓存控制标记。
 *
 * 谁调用我：buildParams() 的步骤 6
 * 我调用谁：
 * - addCacheControlToSystemPrompt()            在系统提示上添加标记
 * - addCacheControlToLastTool()                在最后一个工具上添加标记
 * - addCacheControlToLastConversationMessage()  在最后一段对话消息上添加标记
 *
 * 缓存策略：在三个关键位置添加 cache_control 标记，
 * 使 Anthropic API 能够缓存系统提示、工具定义和最近的对话上下文。
 */
function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl);
}

/**
 * 在系统提示消息（system 或 developer 角色）上添加缓存控制标记。
 * 找到第一条 system/developer 消息并添加，然后返回（只标记第一条）。
 *
 * 谁调用我：applyAnthropicCacheControl()
 */
function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

/**
 * 在最后一段对话消息（user 或 assistant 角色）上添加缓存控制标记。
 * 从后向前遍历，找到第一条 user/assistant 消息并标记。
 *
 * 谁调用我：applyAnthropicCacheControl()
 */
function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

/**
 * 在最后一个工具定义上添加缓存控制标记。
 *
 * 谁调用我：applyAnthropicCacheControl()
 */
function addCacheControlToLastTool(
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

/**
 * 在指令消息（system/developer）上添加缓存控制标记。
 * 委托给 addCacheControlToTextContent()。
 *
 * 谁调用我：addCacheControlToSystemPrompt()
 */
function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

/**
 * 在对话消息（user/assistant）上添加缓存控制标记。
 * 委托给 addCacheControlToTextContent()。
 *
 * 谁调用我：addCacheControlToLastConversationMessage()
 */
function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

/**
 * 在消息的文本内容上添加缓存控制标记。
 *
 * 谁调用我：
 * - addCacheControlToInstructionMessage()
 * - addCacheControlToMessage()
 *
 * 处理逻辑：
 * - 如果 content 是字符串：将其转换为 [{type: "text", text, cache_control}] 格式
 * - 如果 content 是数组：从后向前找到最后一个 text 类型的 part 并添加标记
 * - 如果 content 为空字符串或非数组：返回 false（无法标记）
 */
function addCacheControlToTextContent(
	message:
		| ChatCompletionInstructionMessageParam
		| ChatCompletionAssistantMessageParam
		| Extract<ChatCompletionMessageParam, { role: "user" }>,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		// 将纯字符串 content 转为数组格式并添加缓存标记
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}

	if (!Array.isArray(content)) {
		return false;
	}

	// 从后向前找到最后一个 text 类型的 part 并添加缓存标记
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}

	return false;
}

// ============================================================================
// 核心函数：消息格式转换
// ============================================================================

/**
 * 将 pi-ai 的统一消息格式转换为 OpenAI Chat Completions API 的消息格式。
 *
 * 谁调用我：buildParams() 的步骤 1
 * 我调用谁：
 * - transformMessages()     预处理消息（合并连续同角色消息、规范化 tool call ID）
 * - sanitizeSurrogates()    清理 Unicode 代理对
 *
 * 转换规则：
 * - user 消息：字符串直接传，数组内容逐项转换（text -> text，image -> image_url）
 * - assistant 消息：提取文本、思考、工具调用，按 provider 兼容性决定格式
 * - toolResult 消息：转为 tool 角色消息，图片单独提取为后续 user 消息
 * - systemPrompt：根据模型是否支持 developer 角色选择 role
 *
 * 特殊处理：
 * - 某些 provider 不允许 tool result 后直接跟 user 消息，需插入合成 assistant 消息
 * - 某些 provider 要求 tool result 包含 name 字段
 * - 推理内容的格式取决于 compat.requiresThinkingAsText 和 compat.thinkingFormat
 */
export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	/**
	 * 规范化 tool call ID。
	 * 处理 OpenAI Responses API 返回的管道分隔 ID（格式：{call_id}|{id}）。
	 * 提取 call_id 部分，清理非法字符，截断到 40 字符（OpenAI 限制）。
	 */
	const normalizeToolCallId = (id: string): string => {
		if (id.includes("|")) {
			const [callId] = id.split("|");
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	// 步骤 1：预处理消息。
	// transformMessages 会合并连续同角色消息、规范化 tool call ID 等。
	const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));

	// 步骤 2：添加系统提示。
	// 推理模型（如 o1、o3）使用 "developer" 角色而非 "system"。
	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({ role: role, content: sanitizeSurrogates(context.systemPrompt) });
	}

	// 记录上一条消息的角色，用于检测是否需要插入合成 assistant 消息
	let lastRole: string | null = null;

	// 步骤 3：逐条处理消息
	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		// 兼容处理：某些 provider 不允许 user 消息紧跟在 tool result 之后，
		// 需要插入一条合成的 assistant 消息作为过渡
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "user") {
			// --- 处理 user 消息 ---
			if (typeof msg.content === "string") {
				// 纯文本 user 消息：直接传字符串
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else {
				// 多内容 user 消息：逐项转换（text -> text，image -> image_url base64 格式）
				const content: ChatCompletionContentPart[] = msg.content.map((item): ChatCompletionContentPart => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						} satisfies ChatCompletionContentPartText;
					} else {
						return {
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage;
					}
				});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// --- 处理 assistant 消息 ---
			// 某些 provider 不接受 null content，用空字符串代替
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			// 提取文本内容块（过滤空文本）
			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map(
					(block) =>
						({
							type: "text",
							text: sanitizeSurrogates(block.text),
						}) satisfies ChatCompletionContentPartText,
				);
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			// 提取非空思考/推理块
			const nonEmptyThinkingBlocks = msg.content
				.filter(isThinkingContentBlock)
				.filter((block) => block.thinking.trim().length > 0);

			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// 兼容模式：将思考块转为纯文本（不加标签，避免模型模仿）。
					// 用于不支持原生推理格式的 provider。
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
				} else {
					// 标准模式：assistant content 始终用纯字符串格式。
					// 注意：不能用 {type:"text", text:"..."} 数组格式，否则某些模型会
					// 在输出中镜像这种结构，导致递归嵌套。
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}

					// 将推理内容放在 signature 指定的字段名下
					// （用于 llama.cpp server + gpt-oss 等需要传递推理签名的场景）
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					if (signature && signature.length > 0) {
						(assistantMsg as any)[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
					}
				}
			} else if (assistantText.length > 0) {
				// 没有思考块，只有文本：使用纯字符串格式
				assistantMsg.content = assistantText;
			}

			// 处理工具调用
			const toolCalls = msg.content.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.arguments),
					},
				}));
				// 附加推理详情（encrypted reasoning signature）
				const reasoningDetails = toolCalls
					.filter((tc) => tc.thoughtSignature)
					.map((tc) => {
						try {
							return JSON.parse(tc.thoughtSignature!);
						} catch {
							return null;
						}
					})
					.filter(Boolean);
				if (reasoningDetails.length > 0) {
					(assistantMsg as any).reasoning_details = reasoningDetails;
				}
			}

			// 某些 provider 要求 assistant 消息必须有 reasoning_content 字段
			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				(assistantMsg as { reasoning_content?: string }).reasoning_content === undefined
			) {
				(assistantMsg as { reasoning_content?: string }).reasoning_content = "";
			}

			// 跳过既没有内容也没有工具调用的 assistant 消息。
			// 某些 provider 要求 "要么有 content 要么有 tool_calls，不能都没有"。
			// 这通常发生在 assistant 响应被中止、没产生任何内容的场景。
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			// --- 处理 tool result 消息 ---
			// OpenAI API 中工具结果使用 "tool" 角色。
			// 连续的 toolResult 消息会被批量处理（同一个循环内）。
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			// 批量处理连续的 toolResult 消息
			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// 提取文本结果
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");

				// 构建 tool 角色消息
				const hasText = textResult.length > 0;
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
					tool_call_id: toolMsg.toolCallId,
				};
				// 某些 provider 要求 tool result 包含 name 字段
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				// 提取图片（仅当模型支持图片输入时）
				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			// 跳过已处理的 toolResult 消息（外层循环的 i 会由 for 语句自增）
			i = j - 1;

			// 如果有图片，需要在 tool result 之后追加一条 user 消息来携带图片。
			// 因为 OpenAI 的 tool 角色消息不支持图片内容。
			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}
			continue;
		}

		lastRole = msg.role;
	}

	return params;
}

// ============================================================================
// 内部函数：工具定义格式转换
// ============================================================================

/**
 * 将 pi-ai 的工具定义转换为 OpenAI Chat Completions API 的工具格式。
 *
 * 谁调用我：buildParams() 的步骤 5
 * 我调用谁：无（纯映射转换）
 *
 * 注意：tool.parameters 已经是 JSON Schema 格式（由 TypeBox 生成），
 * 可以直接传递，不需要额外转换。
 * strict 字段仅在 provider 支持时添加（某些 provider 会拒绝未知字段）。
 */
function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as any,
			...(compat.supportsStrictMode !== false && { strict: false }),
		},
	}));
}

// ============================================================================
// 内部函数：token 用量解析
// ============================================================================

/**
 * 解析 OpenAI ChatCompletionChunk 中的 usage 字段，转为 pi-ai 的统一用量格式。
 *
 * 谁调用我：streamOpenAICompletions() 的 chunk 处理循环中（步骤 11）
 * 我调用谁：calculateCost()（根据 token 用量和模型定价计算费用）
 *
 * 字段映射：
 * - prompt_tokens：输入 token 总数
 * - prompt_cache_hit_tokens / prompt_tokens_details.cached_tokens：缓存命中（读取）token 数
 * - prompt_tokens_details.cache_write_tokens：缓存写入 token 数
 * - completion_tokens：输出 token 数（已包含推理 token）
 *
 * 计算规则：
 * - input = prompt_tokens - cacheRead - cacheWrite（纯新增输入 token）
 * - 遵循 OpenAI 文档语义：cached_tokens 是缓存读取，不要减去 write
 * - 避免对 spec-compliant provider 的用量少报
 */
function parseChunkUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	},
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// 根据模型定价计算费用（会修改 usage.cost 字段）
	calculateCost(model, usage);
	return usage;
}

// ============================================================================
// 内部函数：停止原因映射
// ============================================================================

/**
 * 将 OpenAI 的 finish_reason 映射为 pi-ai 的统一 StopReason。
 *
 * 谁调用我：streamOpenAICompletions() 的 chunk 处理循环中（步骤 11）
 * 我调用谁：无（纯映射）
 *
 * 映射规则：
 * - "stop" / "end"           -> "stop"（正常结束）
 * - "length"                 -> "length"（达到最大 token 限制）
 * - "function_call"/"tool_calls" -> "toolUse"（请求工具调用）
 * - "content_filter"         -> "error"（内容被过滤）
 * - "network_error"          -> "error"（网络错误）
 * - 其他未知值               -> "error"（兜底）
 */
function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

// ============================================================================
// 内部函数：兼容性配置
// ============================================================================

/**
 * 检测并返回标准 OpenAI Completions API 的默认兼容性配置。
 *
 * 谁调用我：getCompat()（作为 fallback 默认值）
 * 我调用谁：无（返回硬编码的默认配置）
 *
 * 这些默认值假设是标准的 OpenAI API 行为。
 * 各 provider 可以通过 model.compat 字段覆盖其中的任意选项。
 */
function detectCompat(_model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	return {
		supportsStore: true, // 支持 store 参数
		supportsDeveloperRole: true, // 支持 developer 角色
		supportsReasoningEffort: true, // 支持 reasoning_effort 参数
		supportsUsageInStreaming: true, // 支持在流式响应中返回 usage
		maxTokensField: "max_completion_tokens", // 使用 max_completion_tokens 字段名
		requiresToolResultName: false, // 不要求 tool result 包含 name
		requiresAssistantAfterToolResult: false, // 不要求 tool result 后有 assistant 消息
		requiresThinkingAsText: false, // 不要求将 thinking 转为纯文本
		requiresReasoningContentOnAssistantMessages: false, // 不要求 assistant 消息有 reasoning_content
		thinkingFormat: "openai", // 推理格式为 OpenAI 标准
		supportsStrictMode: true, // 支持 strict 模式
		cacheControlFormat: undefined, // 不使用 Anthropic 风格缓存控制
		sendSessionAffinityHeaders: false, // 不发送 session 亲和性 headers
		supportsLongCacheRetention: true, // 支持长缓存保留
	};
}

/**
 * 获取模型的完全解析兼容性配置。
 *
 * 谁调用我：
 * - streamOpenAICompletions() 的步骤 3
 * - buildParams() 的默认参数
 * - createClient() 的默认参数
 * - convertMessages() 通过 buildParams() 间接调用
 *
 * 我调用谁：detectCompat()（获取默认配置作为 fallback）
 *
 * 合并逻辑：
 * - 如果模型没有自定义 compat，直接返回默认配置
 * - 如果有，逐字段合并：model.compat 的值优先，undefined 时用默认值
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const detected = detectCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages:
			model.compat.requiresReasoningContentOnAssistantMessages ??
			detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
	};
}
