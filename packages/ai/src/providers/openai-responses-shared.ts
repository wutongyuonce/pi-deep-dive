import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * OpenAI Responses provider 的“共享转换层”。
 *
 * 文件定位：
 * - `openai-responses.ts` 负责创建 client、build payload、发请求、统一收口
 * - 本文件负责把 `pi-ai` 的统一协议和 OpenAI Responses 的原生协议互相翻译
 *
 * 换句话说，这里解决的是两类转换：
 * 1. 请求前：`Context` / `Tool[]` -> OpenAI Responses input / tools
 * 2. 响应中：OpenAI SDK stream events -> `AssistantMessageEvent`
 *
 * 为什么拆成 shared：
 * - 保持 `openai-responses.ts` 主流程清晰
 * - 让“消息转换”和“流式事件翻译”集中在一处，便于测试和复用
 * - 以后如果还有其它 OpenAI Responses 兼容 provider，也可以复用这套逻辑
 */

// =============================================================================
// Utilities
// =============================================================================

// 把 OpenAI message id 编码成 `pi-ai` 文本块上的统一签名。
// 后续多轮对话回放时，provider 可以用它把历史 assistant 文本重新变回 OpenAI 的 message item。
function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

// 解析上面存回文本块里的签名。
// 兼容两种格式：
// 1. 新版 JSON 格式：包含版本号和 phase
// 2. 旧版纯字符串：只有 id
function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
}

// =============================================================================
// Message conversion
// =============================================================================

/**
 * 把 `pi-ai` 的统一 `Context` 转成 OpenAI Responses API 的 `input` 数组。
 *
 * 谁调用我：
 * - `openai-responses.ts` 里的 `buildParams()`
 *
 * 我调用谁：
 * - `transformMessages()`：先做 provider 无关的消息标准化/兼容性转换
 *
 * 这是请求方向最重要的转换器之一，因为它要处理：
 * - system/developer prompt
 * - user 文本 / 图片输入
 * - assistant 历史文本 / thinking / tool call 回放
 * - tool result 回灌
 * - 跨 provider / 跨模型回放时的 id 兼容
 */
export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];

	// OpenAI Responses 对某些 ID 的字符集和长度有限制，这里先统一做正规化。
	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	// 当 tool call 来自“不同 provider / 不同 API”的历史消息时，原始 itemId 可能不满足
	// OpenAI Responses 的约束。这里用短哈希重新生成一个稳定但安全的 id。
	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	// 规范化 tool call id。
	//
	// 背景：
	// - `pi-ai` 内部的 toolCall.id 通常是 `call_id|item_id`
	// - 但不同 provider 对 item id 的要求不同
	// - OpenAI Responses 还要求 item id 以 `fc_` 开头
	//
	// 所以这里统一做三件事：
	// 1. 清理非法字符
	// 2. 对跨 provider 的 item id 做哈希化
	// 3. 确保 OpenAI 需要的 `fc_` 前缀存在
	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	// 在真正翻译成 OpenAI input 之前，先经过统一的消息变换层。
	// 这一步会处理跨 provider handoff、thinking 转换、tool result 排布等共性问题。
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		// 对 reasoning 模型，OpenAI Responses 更偏好用 `developer` 角色承载系统提示。
		const role = model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			// 用户消息：
			// - 纯字符串 -> 单个 input_text
			// - 结构化 content -> 逐块映射成 input_text / input_image
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// assistant 历史消息：
			// OpenAI Responses 的回放不是“一个 assistant message 对象”这么简单，
			// 而是由 reasoning item / message item / function_call item 组成的 item 列表。
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					// thinking 块优先走 signature 回放。
					// 这样可以把原 provider 返回的 reasoning item 原样放回上下文，保持多轮连续性。
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}

					// 文本块会被翻译成 OpenAI 的 message item。
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					// 工具调用块会被翻译成 function_call item。
					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			// tool result 回灌：
			// - 如果结果里有图片且目标模型支持图片输入，就构造成多模态 output
			// - 否则退化成纯文本输出
			const textResult = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];

				if (hasText) {
					contentParts.push({
						type: "input_text",
						text: sanitizeSurrogates(textResult),
					});
				}

				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}

				output = contentParts;
			} else {
				output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			}

			messages.push({
				type: "function_call_output",
				call_id: callId,
				output,
			});
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	// TypeBox 产生的 schema 已经是 JSON Schema 形态，这里主要做字段名适配。
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as any, // TypeBox already generates JSON Schema
		strict,
	}));
}

// =============================================================================
// Stream processing
// =============================================================================

/**
 * 消费 OpenAI SDK 的 Responses 流，并把它翻译成 `pi-ai` 的统一事件协议。
 *
 * 谁调用我：
 * - `openai-responses.ts` 的 `streamOpenAIResponses()`
 *
 * 我修改什么：
 * - 持续修改传入的 `output`，把它从“空 assistant message 骨架”逐步构造成最终消息
 * - 持续向 `stream` 推送 `thinking_delta` / `text_delta` / `toolcall_delta` / `done` 前的增量事件
 *
 * 为什么 `output` 和 `stream` 都要传进来：
 * - `output` 是最终结果容器
 * - `stream` 是实时事件通道
 * - 两者始终指向同一份“进行中的 assistant 响应”
 */
export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	// currentItem = 当前正在处理的 OpenAI 原生 item
	// currentBlock = `output.content` 中与之对应的统一内容块
	let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			// 请求创建时先拿到 response id，方便后续调试或多轮串联。
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			const item = event.item;
			if (item.type === "reasoning") {
				// 新增一个 reasoning item -> 新建统一的 thinking 块并发 thinking_start。
				currentItem = item;
				currentBlock = { type: "thinking", thinking: "" };
				output.content.push(currentBlock);
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "message") {
				// 新增一个 assistant 文本 item -> 新建 text 块并发 text_start。
				currentItem = item;
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "function_call") {
				// 新增一个工具调用 item -> 新建 toolCall 块。
				// `partialJson` 是流式拼 JSON 参数时的临时缓存，只用于流式阶段。
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			// OpenAI 会把 reasoning summary 拆成若干 part，这里先把 part 挂到原生 item 上。
			if (currentItem && currentItem.type === "reasoning") {
				currentItem.summary = currentItem.summary || [];
				currentItem.summary.push(event.part);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					// summary 文本一边追加到最终 thinking，一边发增量事件给上层 UI / agent。
					currentBlock.thinking += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					// 不同 summary part 之间补两个换行，保持可读性。
					currentBlock.thinking += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				// 有些模型返回完整 reasoning text，而不只是 summary，这里同样映射到 thinking_delta。
				currentBlock.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			if (currentItem?.type === "message") {
				currentItem.content = currentItem.content || [];
				// Filter out ReasoningText, only accept output_text and refusal
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					currentItem.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				if (!currentItem.content || currentItem.content.length === 0) {
					continue;
				}
				const lastPart = currentItem.content[currentItem.content.length - 1];
				if (lastPart?.type === "output_text") {
					// 常规文本增量 -> text_delta。
					currentBlock.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				if (!currentItem.content || currentItem.content.length === 0) {
					continue;
				}
				const lastPart = currentItem.content[currentItem.content.length - 1];
				if (lastPart?.type === "refusal") {
					// refusal 也统一走 text_delta，让上层不需要区分两套展示逻辑。
					currentBlock.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				// 工具调用参数是流式 JSON。
				// 这里边收增量边做“尽力而为”的局部 JSON 解析，方便 UI 预览和 agent 提前感知参数形状。
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				const previousPartialJson = currentBlock.partialJson;
				currentBlock.partialJson = event.arguments;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);

				// 某些情况下 done 事件会携带比此前更多的完整参数，这里补发缺失 delta。
				if (event.arguments.startsWith(previousPartialJson)) {
					const delta = event.arguments.slice(previousPartialJson.length);
					if (delta.length > 0) {
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta,
							partial: output,
						});
					}
				}
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;

			if (item.type === "reasoning" && currentBlock?.type === "thinking") {
				// reasoning item 收尾：
				// - 优先使用 summary 文本
				// - 否则退回完整 content 文本
				// - 并把整个原生 reasoning item 序列化进 thinkingSignature，供多轮回放
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				currentBlock.thinking = summaryText || contentText || currentBlock.thinking;
				currentBlock.thinkingSignature = JSON.stringify(item);
				stream.push({
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.thinking,
					partial: output,
				});
				currentBlock = null;
			} else if (item.type === "message" && currentBlock?.type === "text") {
				// message item 收尾：
				// - 用最终 item 内容覆盖当前文本
				// - 保存 textSignature，供历史回放时复原 OpenAI item id
				currentBlock.text = item.content.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("");
				currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial: output,
				});
				currentBlock = null;
			} else if (item.type === "function_call") {
				// function call 收尾：
				// - 最终解析完整 arguments
				// - 去掉流式阶段才需要的 `partialJson`
				// - 发 toolcall_end
				const args =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? parseStreamingJson(currentBlock.partialJson)
						: parseStreamingJson(item.arguments || "{}");

				let toolCall: ToolCall;
				if (currentBlock?.type === "toolCall") {
					// Finalize in-place and strip the scratch buffer so replay only
					// carries parsed arguments.
					currentBlock.arguments = args;
					delete (currentBlock as { partialJson?: string }).partialJson;
					toolCall = currentBlock;
				} else {
					toolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: args,
					};
				}

				currentBlock = null;
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
			}
		} else if (event.type === "response.completed") {
			// 整个响应完成，开始填最终 usage / stopReason。
			const response = event.response;
			if (response?.id) {
				output.responseId = response.id;
			}
			if (response?.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
					input: (response.usage.input_tokens || 0) - cachedTokens,
					output: response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}

			// 先按模型基础价格计算 usage.cost。
			calculateCost(model, output.usage);
			if (options?.applyServiceTierPricing) {
				// 再根据 service tier 做 provider 级价格修正。
				const serviceTier = options.resolveServiceTier
					? options.resolveServiceTier(response?.service_tier, options.serviceTier)
					: (response?.service_tier ?? options.serviceTier);
				options.applyServiceTierPricing(output.usage, serviceTier);
			}

			// 把 OpenAI 原生 status 翻译成统一 stopReason。
			output.stopReason = mapStopReason(response?.status);
			if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
				// 对 `pi-ai` 来说，只要最终内容里含有工具调用，就应把结束原因标成 `toolUse`，
				// 这样上层 agent 才知道下一步该去执行工具，而不是把它当普通文本完成。
				output.stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			// SDK 层错误直接抛出，交给上层 provider 统一转成协议内 `error` 事件。
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			// OpenAI Responses 的失败信息有时在 `response.error`，有时在 `incomplete_details`。
			// 这里先统一整理成可读错误字符串，再交给上层收口。
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
}

// 把 OpenAI Responses 的状态映射到 `pi-ai` 统一 stopReason。
// 注意：这里不单独返回 `toolUse`，因为是否进入 toolUse 还要结合最终 content 里有没有 toolCall 块。
function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
