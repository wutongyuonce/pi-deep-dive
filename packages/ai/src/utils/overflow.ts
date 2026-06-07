/**
 * 上下文溢出检测工具模块。
 *
 * 文件定位：
 * - 提供检测 LLM 请求是否因输入超出模型上下文窗口而失败的功能
 * - 各 provider 返回的溢出错误信息格式各异，本模块通过正则模式匹配统一检测
 * - 同时处理"静默溢出"场景（provider 不报错但实际截断了输入）
 *
 * 谁调用我：
 * - index.ts：通过桶导出向外部包暴露 isContextOverflow 和 getOverflowPatterns
 * - 外部包（packages/agent、packages/coding-agent）在收到错误响应后调用
 *   isContextOverflow() 判断是否为上下文溢出，以便决定是否触发自动压缩等恢复策略
 *
 * 调用链路：
 *   外部包收到 AssistantMessage
 *     -> isContextOverflow(message, contextWindow?)
 *       -> 检查 stopReason === "error" + 正则匹配 errorMessage
 *       -> 检查 stopReason === "stop" + usage.input > contextWindow（静默溢出）
 *       -> 检查 stopReason === "length" + output === 0 + input 填满窗口（截断溢出）
 */

import type { AssistantMessage } from "../types.ts";

/**
 * 各 provider 的上下文溢出错误消息正则模式列表。
 *
 * 每个模式对应一个或多个 provider 的典型错误消息格式。
 * 当 errorMessage 匹配其中任何一个模式时，认为是上下文溢出。
 *
 * 已覆盖的 provider（按模式注释）：
 * - Anthropic：prompt is too long / request_too_large
 * - Amazon Bedrock：input is too long for requested model
 * - OpenAI（Completions & Responses）：exceeds the context window
 * - LiteLLM 代理：exceeds maximum context length of N tokens
 * - Google Gemini：input token count exceeds the maximum
 * - xAI Grok：maximum prompt length is N
 * - Groq：reduce the length of the messages
 * - OpenRouter：maximum context length is N tokens
 * - OpenRouter/Poolside：Input length exceeds maximum allowed input length
 * - Together AI：input (N tokens) is longer than context length
 * - GitHub Copilot：exceeds the limit of N
 * - llama.cpp：exceeds the available context size
 * - LM Studio：greater than the context length
 * - MiniMax：context window exceeds limit
 * - Kimi For Coding：exceeded model token limit
 * - Mistral：too large for model with N maximum context length
 * - z.ai：model_context_window_exceeded
 * - Ollama：prompt too long; exceeded max context length
 * - Cerebras：400/413 status code (no body)
 * - 通用兜底：context_length_exceeded / too many tokens / token limit exceeded
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length of [\d,]+ tokens?/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

/**
 * 排除模式：匹配这些模式的错误消息不是上下文溢出（即使同时匹配 OVERFLOW_PATTERNS）。
 * 用于排除限流、服务不可用等非溢出场景。
 *
 * 典型场景：
 * - AWS Bedrock 的 ThrottlingException 会包含 "Too many tokens" 文本，
 *   会误匹配 /too many tokens/i，需要排除
 */
const NON_OVERFLOW_PATTERNS = [/^(Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];

/**
 * 检查 AssistantMessage 是否表示上下文溢出错误。
 *
 * 谁调用我：
 * - 外部包（packages/agent、packages/coding-agent）在收到错误响应后调用
 *
 * 我调用谁：无（纯模式匹配和数值比较）
 *
 * 检测三种场景：
 *
 * 场景 1：错误型溢出（最常见）
 * - stopReason === "error" 且 errorMessage 匹配溢出正则
 * - 先排除 NON_OVERFLOW_PATTERNS（如限流错误），再匹配 OVERFLOW_PATTERNS
 * - 覆盖 Anthropic、OpenAI、Google、xAI、Groq、OpenRouter 等大多数 provider
 *
 * 场景 2：静默溢出（z.ai 风格）
 * - stopReason === "stop"（看似成功）但 usage.input + cacheRead > contextWindow
 * - z.ai 不会报错，只是接受请求并截断输入
 *
 * 场景 3：截断溢出（Xiaomi MiMo 风格）
 * - stopReason === "length" 且 output === 0 且 input 填满上下文窗口
 * - 服务端将输入截断到刚好填满 contextWindow，没有空间生成输出
 * - 使用 0.99 阈值避免浮点精度问题
 *
 * @param message 要检查的 AssistantMessage
 * @param contextWindow 模型的上下文窗口大小（token 数），用于检测静默溢出
 * @returns true 如果消息表示上下文溢出
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// 场景 1：错误型溢出 —— 通过错误消息正则匹配
	if (message.stopReason === "error" && message.errorMessage) {
		// 先检查是否为非溢出错误（如限流）
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}

	// 场景 2：静默溢出 —— 输入 token 超过上下文窗口但 API 未报错
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// 场景 3：截断溢出 —— 输入被截断填满窗口，无输出空间
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		// 使用 0.99 阈值：某些 provider 的截断精度不完全等于 contextWindow
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * 获取溢出检测正则模式列表（用于测试）。
 *
 * 谁调用我：测试代码
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
