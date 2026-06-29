/**
 * 上下文压缩与分支摘要的共享工具函数。
 *
 * 作用/定位：提供压缩和分支摘要模块共用的底层工具。
 * 提供：文件操作跟踪、消息序列化、摘要系统提示词。
 *
 * 主要功能：
 * - 文件操作跟踪：从工具调用中提取读/写/编辑的文件路径
 * - 消息序列化：将 LLM 消息转为纯文本摘要格式
 * - 摘要系统提示词：摘要生成时使用的系统角色设定
 *
 * 被谁调用：compaction.ts、branch-summarization.ts
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

// ============================================================================
// 文件操作跟踪
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	// 为三类文件操作分别初始化独立集合，后续统一累积并去重。
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * 从助手消息中的工具调用提取文件操作。
 * 仅处理 assistant 角色消息中的 toolCall 块，提取 read/write/edit 工具的文件路径。
 *
 * 被谁调用：compaction.ts 的 extractFileOperations()、branch-summarization.ts 的 prepareBranchEntries()
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	// 逐块扫描助手消息，只处理结构化 toolCall 块。
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		// 按工具名把路径归入对应集合，供后续摘要统一输出。
		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * 从文件操作计算最终文件列表。
 * 返回 readFiles（仅读取未修改的文件）和 modifiedFiles（修改过的文件，含编辑和写入）。
 *
 * 去重规则：被修改的文件即使也被读取，也只出现在 modifiedFiles 中。
 *
 * 被谁调用：compaction.ts 的 compact()、branch-summarization.ts 的 generateBranchSummary()
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	// 先合并所有修改类操作，再把纯读取文件从中剔除，避免重复出现在两个列表里。
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * 将文件操作格式化为 XML 标签（<read-files> / <modified-files>），用于追加到摘要输出。
 * 若两个列表都为空，返回空字符串。
 *
 * 被谁调用：compaction.ts 的 compact()、branch-summarization.ts 的 generateBranchSummary()
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		// 读取文件单独输出，方便后续模型区分“看过”与“改过”。
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// 消息序列化
// ============================================================================

/** 序列化摘要中工具结果的最大字符数。 */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * 将文本截断到最大字符长度，用于摘要生成。
 * 保留开头部分并追加截断标记。
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	// 超出预算时仅保留前缀，并显式标注被裁掉的字符数。
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * 将 LLM 消息序列化为纯文本，用于摘要生成。
 * 防止模型将其视为需要继续的对话（而非继续对话的指令）。
 * 需先调用 convertToLlm() 处理自定义消息类型（bashExecution、compactionSummary 等）。
 *
 * 序列化格式：
 * - [User]: 用户消息文本
 * - [Assistant thinking]: 助手思考内容
 * - [Assistant]: 助手回复文本
 * - [Assistant tool calls]: 工具调用列表
 * - [Tool result]: 工具结果（截断到 TOOL_RESULT_MAX_CHARS）
 *
 * 工具结果会被截断（最多 2000 字符）以控制摘要请求的 token 预算。
 *
 * 被谁调用：compaction.ts 的 generateSummary()、branch-summarization.ts 的 generateBranchSummary()
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			// 用户消息统一折叠为纯文本，避免把结构化块原样交给摘要模型。
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			// 按文本、思考、工具调用三类拆分助手输出，便于摘要模型理解结构。
			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			// 工具结果可能很长，写入摘要前先裁剪到预算内。
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// 摘要系统提示词
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
