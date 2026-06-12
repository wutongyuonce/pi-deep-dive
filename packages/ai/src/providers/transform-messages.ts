import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * 跨提供商消息变换：在消息发给 LLM API 之前做兼容性预处理。
 *
 * 两个核心职责：
 * 1. 跨模型降级 —— thinking 块、signature、tool call ID 等 provider 特有元数据的安全降级
 * 2. 孤儿工具调用补全 —— 为没有对应 toolResult 的 toolCall 合成空结果，避免 API 报错
 *
 * 工具调用 ID 归一化说明：
 * OpenAI Responses API 生成的 ID 长达 450+ 字符且含 `|` 等特殊字符；
 * Anthropic API 要求 ID 匹配 ^[a-zA-Z0-9_-]+$（最长 64 字符）。
 * `normalizeToolCallId` 回调由各 provider 自行实现以满足各自的约束。
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// 原始工具调用 ID → 归一化 ID 的映射表。
	// 第一遍处理 assistant 消息时填充，第二遍处理 toolResult 消息时用来同步更新 toolCallId。
	const toolCallIdMap = new Map<string, string>();

	// 先把不支持的图片降级为纯文本（如 Anthropic 不支持某些图片格式）。
	const imageAwareMessages = downgradeUnsupportedImages(messages, model);

	// ========================
	// 第一遍：逐消息变换
	// 处理：图片降级、thinking 块跨模型降级、tool call ID 归一化
	// ========================
	const transformed = imageAwareMessages.map((msg) => {
		// user 消息原样透传
		if (msg.role === "user") {
			return msg;
		}

		// toolResult 消息：如果对应的 toolCall ID 已被归一化，同步更新 toolCallId
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// assistant 消息：需要逐内容块变换
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			// 判断是否与目标模型完全一致（provider + api + model ID 三者都相同）
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// 被编辑过的 thinking 是不透明的加密内容，仅对原模型有效，跨模型必须丢弃
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// 同模型：保留带 signature 的 thinking 块（回放时需要），即使思考文本为空（OpenAI 加密推理）
					if (isSameModel && block.thinkingSignature) return block;
					// 空 thinking 块直接跳过
					if (!block.thinking || block.thinking.trim() === "") return [];
					// 同模型：保留原样
					if (isSameModel) return block;
					// 跨模型：降级为普通 text 块
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					// 同模型保留原样（含 textSignature），跨模型去掉 signature 只保留文本
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					// 跨模型：移除 thoughtSignature（provider 特有元数据，不可跨模型）
					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					// 跨模型：归一化 tool call ID（如截断长度、移除非法字符）
					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// ========================
	// 第二遍：孤儿工具调用补全
	// 如果 assistant 消息中的 toolCall 没有对应的 toolResult，合成一个空结果。
	// 这是必要的，因为大多数 API 要求每个 toolCall 必须有对应的 toolResult。
	// ========================
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	// 将未匹配到 toolResult 的 toolCall 补上合成的错误结果
	const insertSyntheticToolResults = () => {
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
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// 遇到新的 assistant 消息时，先为上一轮的孤儿 toolCall 补结果
			insertSyntheticToolResults();

			// 跳过 error/aborted 的 assistant 消息——它们是不完整的轮次，不应被回放：
			// - 可能有部分内容（只有推理没有正文、未完成的工具调用）
			// - 回放会导致 API 报错（如 OpenAI 的 "reasoning without following item"）
			// - 模型应该从上一个有效状态重试
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// 记录本轮的 toolCall，等待后续匹配 toolResult
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			// 记录已存在的 toolResult ID，用于后续判断哪些 toolCall 是孤儿
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// user 消息打断了 tool 流程，为之前的孤儿 toolCall 补结果
			insertSyntheticToolResults();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// 对话结束时如果还有未解决的 toolCall，补上合成结果
	insertSyntheticToolResults();

	return result;
}
