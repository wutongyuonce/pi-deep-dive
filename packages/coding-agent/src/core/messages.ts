/**
 * 编码代理的自定义消息类型与转换器。
 *
 * 文件定位：coding-agent 的消息层，扩展了 pi-agent-core 的基础 AgentMessage 类型，
 * 定义了 bash 执行、自定义扩展消息、分支摘要、压缩摘要等编码代理专属消息类型。
 *
 * 提供：
 * - 4 种自定义消息类型接口（BashExecutionMessage / CustomMessage / BranchSummaryMessage / CompactionSummaryMessage）
 * - 通过声明合并（declaration merging）将自定义类型注入 AgentMessage 联合类型
 * - convertToLlm() 转换器，将所有消息类型映射为 LLM 兼容的 Message 格式
 *
 * 调用链路：
 * - 被 agent 核心调用（transformToLlm 选项），用于将对话历史发送给 LLM
 * - 被 compaction（压缩）模块调用，用于生成摘要时的消息转换
 * - 被自定义扩展和工具调用，注入自定义消息到对话中
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

/** 压缩摘要的前缀，用于将之前的对话历史替换为摘要 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

/** 压缩摘要的后缀 */
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/** 分支摘要的前缀，用于标识从某个分支返回时携带的摘要信息 */
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

/** 分支摘要的后缀 */
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Bash 命令执行消息类型，对应用户通过 ! 命令触发的 shell 执行。
 *
 * 被 bash 工具在执行命令后创建，经 convertToLlm() 转换后以 user 角色文本形式发送给 LLM。
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	/** 执行的命令字符串 */
	command: string;
	/** 命令的标准输出 */
	output: string;
	/** 退出码，未定义表示命令仍在运行 */
	exitCode: number | undefined;
	/** 命令是否被用户取消 */
	cancelled: boolean;
	/** 输出是否被截断（过长时） */
	truncated: boolean;
	/** 输出被截断时，完整输出文件的路径 */
	fullOutputPath?: string;
	timestamp: number;
	/** 为 true 时表示排除在 LLM 上下文之外（!! 前缀） */
	excludeFromContext?: boolean;
}

/**
 * 扩展注入的自定义消息类型，通过 sendMessage() 接口注入到对话中。
 * 扩展可以借此向 LLM 对话中插入带类型的自定义内容。
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	/** 自定义消息的类型标识符 */
	customType: string;
	/** 消息内容，支持纯文本或多模态内容数组 */
	content: string | (TextContent | ImageContent)[];
	/** 是否在 UI 中显示该消息 */
	display: boolean;
	/** 附加的结构化详情数据 */
	details?: T;
	timestamp: number;
}

/** 分支摘要消息，对话从某个分支返回时携带的摘要 */
export interface BranchSummaryMessage {
	role: "branchSummary";
	/** 分支摘要文本 */
	summary: string;
	/** 来源分支的标识符 */
	fromId: string;
	timestamp: number;
}

/** 压缩摘要消息，对话历史过长被压缩后生成的摘要 */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	/** 压缩后的摘要文本 */
	summary: string;
	/** 压缩前的 token 数量 */
	tokensBefore: number;
	timestamp: number;
}

// 通过声明合并扩展 AgentMessage 的自定义消息类型联合
// 使 TypeScript 能识别 role 为 "bashExecution" | "custom" | "branchSummary" | "compactionSummary" 的消息
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * 将 BashExecutionMessage 转换为 LLM 可读的文本格式。
 *
 * 内部步骤：
 * 1. 输出 "Ran `command`" 标题行
 * 2. 附上命令输出（放在代码块中），无输出时显示 "(no output)"
 * 3. 追加取消/错误退出码信息
 * 4. 如有截断，附加完整输出文件路径
 *
 * 被 convertToLlm() 在处理 bashExecution 类型消息时调用。
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

/**
 * 创建分支摘要消息。
 *
 * 定位：会话树导航返回主线时的消息工厂。
 * 作用：把持久化层中的分支摘要数据转成运行时 `AgentMessage` 结构。
 * 调用关系：被会话树、摘要恢复和消息装载流程调用。
 */
export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * 创建压缩摘要消息。
 *
 * 定位：压缩记录装载到运行时上下文时的工厂函数。
 * 作用：把 compaction 条目转换成统一的消息对象，供对话和导出流程复用。
 * 调用关系：被压缩历史恢复和消息转换流程调用。
 */
export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * 创建扩展自定义消息。
 *
 * 定位：扩展消息进入运行时消息流的标准入口。
 * 作用：把扩展侧 payload 标准化为 `AgentMessage` 兼容结构。
 * 调用关系：被扩展系统、会话恢复和消息持久化装载流程调用。
 */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * 将 AgentMessage（含自定义类型）转换为 LLM 兼容的 Message 数组。
 *
 * 调用者：
 * - Agent 的 transformToLlm 选项（用于 prompt 调用和排队消息）
 * - Compaction 的 generateSummary（用于摘要生成）
 * - 自定义扩展和工具
 *
 * 转换规则：
 * - bashExecution → user 消息（通过 bashExecutionToText 转为文本）
 * - custom → user 消息（字符串直接用，数组按原样）
 * - branchSummary → user 消息（包裹在 branch summary 标签中）
 * - compactionSummary → user 消息（包裹在 compaction summary 标签中）
 * - user / assistant / toolResult → 原样透传
 * - excludeFromContext 的 bashExecution → 跳过
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// 跳过排除在上下文之外的消息（!! 前缀）
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					// 统一把字符串包装成文本块，数组内容则按多模态原样透传。
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
