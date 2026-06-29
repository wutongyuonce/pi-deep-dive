/**
 * 会话树导航时的分支摘要生成。
 *
 * 作用/定位：当用户导航到会话树中的不同位置时，生成离开分支的摘要，防止上下文丢失。
 * 提供：条目收集（collectEntriesForBranchSummary）、条目准备（prepareBranchEntries）、
 *       摘要生成（generateBranchSummary）。
 *
 * 调用链路：
 *   session-manager.navigateTree() → generateBranchSummary()
 *     → collectEntriesForBranchSummary() — 收集离开分支的条目
 *     → prepareBranchEntries() — 准备摘要消息和文件操作
 *     → completeSimple() — 调用 LLM 生成摘要
 *
 * 被谁调用：session-manager、agent-session
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { estimateTokens } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// 类型定义
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** 存储在 BranchSummaryEntry.details 中的文件跟踪详情 */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** 提取用于摘要的消息（按时间顺序） */
	messages: AgentMessage[];
	/** 从工具调用中提取的文件操作 */
	fileOps: FileOperations;
	/** 消息的总预估 token 数 */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** 要摘要的条目（按时间顺序） */
	entries: SessionEntry[];
	/** 新旧位置之间的公共祖先（如果有） */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** 用于摘要的模型 */
	model: Model<any>;
	/** 模型的 API key */
	apiKey: string;
	/** 模型请求的头部 */
	headers?: Record<string, string>;
	/** 取消操作的中止信号 */
	signal: AbortSignal;
	/** 摘要的自定义指令 */
	customInstructions?: string;
	/** 如果为 true，customInstructions 替代默认提示词而非追加 */
	replaceInstructions?: boolean;
	/** 为提示词和 LLM 响应预留的 token（默认 16384） */
	reserveTokens?: number;
}

// ============================================================================
// 条目收集
// ============================================================================

/**
 * 收集从一个位置导航到另一个位置时需要摘要的条目。
 *
 * 从 oldLeafId 回溯到与 targetId 的公共祖先，沿途收集条目。
 * 不在压缩边界处停止 - 那些条目也包含在内，其摘要成为上下文。
 *
 * @param session - 会话管理器（只读访问）
 * @param oldLeafId - 当前位置（导航起点）
 * @param targetId - 目标位置（导航终点）
 * @returns 需要摘要的条目和公共祖先
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// 没有旧位置时，说明不存在“离开中的分支”，无需生成摘要。
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// 先分别取出旧叶子和目标节点的路径，用于查找最深公共祖先。
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath 按 root-first 排列，因此倒序扫描即可命中“最深”的公共祖先。
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// 从旧叶子向上回溯，只收集离开分支上的条目。
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// 回溯得到的是倒序结果，这里翻转回时间正序再交给摘要流程。
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// 条目到消息的转换
// ============================================================================

/**
 * 从会话条目中提取 AgentMessage。
 * 与 compaction.ts 中的 getMessageFromEntry 类似，但跳过 toolResult 消息
 * （上下文已在助手的 tool_call 中）且包含 compression 摘要。
 *
 * 被谁调用：prepareBranchEntries()
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// toolResult 已经由前面的 assistant toolCall 提供上下文，这里直接跳过。
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// 这些条目不参与摘要上下文拼接。
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * 在 token 预算内准备待摘要的条目。
 *
 * 实现步骤：
 * 1. 第一轮：从所有条目中收集文件操作（即使超出 token 预算也收集，确保累积跟踪）
 * 2. 第二轮：从最新到最旧遍历，将消息加入列表直到达到 token 预算
 *    如果是摘要条目（compaction/branch_summary），即使在预算边缘也尽量保留
 *
 * 文件操作来源：
 * - 助手消息中的工具调用
 * - 已有 branch_summary 条目的 details 字段（用于累积跟踪）
 *
 * @param entries - 按时间顺序排列的条目
 * @param tokenBudget - 最大 token 数（0 表示无限制）
 *
 * 被谁调用：generateBranchSummary()
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// 第一轮先吃全量条目里的文件操作，确保即使消息被预算裁掉，文件轨迹也不会丢。
	// 这里只复用 pi 自己生成的 branch_summary，避免把扩展私有摘要混进来。
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// 修改文件统一计入 modified 语义，后续会做去重和列表归并。
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// 第二轮从新到旧装入消息，尽量把最近上下文留给摘要模型。
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// 助手消息里的工具调用也可能携带文件路径，需要一并累积。
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// 在放入消息前先检查预算，避免超出模型可承受的上下文大小。
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 摘要条目价值更高；如果预算还留有余量，优先保住它。
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// 命中预算上限后立即停止，避免再引入更旧的上下文。
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// 摘要生成
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 生成被放弃分支条目的摘要。
 *
 * 实现步骤：
 * 1. 计算 token 预算（contextWindow - reserveTokens）
 * 2. 调用 prepareBranchEntries() 在预算内准备条目
 * 3. 将消息转换为 LLM 兼容格式并序列化为纯文本
 * 4. 构建请求提示词（支持自定义指令替换或追加）
 * 5. 调用 LLM 的 completeSimple() 生成摘要
 * 6. 检查中止/错误状态
 * 7. 将文件操作信息追加到摘要中
 *
 * @param entries - 需要摘要的会话条目（按时间顺序）
 * @param options - 生成选项
 *
 * 被谁调用：session-manager.navigateTree()
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const { model, apiKey, headers, signal, customInstructions, replaceInstructions, reserveTokens = 16384 } = options;

	// 先扣掉提示词和回复预留空间，剩余部分才可用于装载待摘要消息。
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// 先转换成 LLM 兼容消息，再序列化成纯文本，避免模型把输入当成待继续的对话。
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// 根据“替换”或“追加”模式组装最终指令。
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// 调用摘要模型生成分支总结正文。
	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ apiKey, headers, signal, maxTokens: 2048 },
	);

	// 显式区分中止和错误，交给上层决定是否落盘摘要条目。
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	// 先补上固定前导语，说明这是“离开分支”的摘要。
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// 最后把文件读写轨迹附在摘要末尾，方便后续恢复工作现场。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};
}
