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
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
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
			// Skip tool results - context is in assistant's tool call
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// These don't contribute to conversation content
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

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// Modified files go into both edited and written for proper deduplication
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// Second pass: walk from newest to oldest, adding messages until token budget
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// Extract file ops from assistant messages (tool calls)
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// Check budget before adding
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// If this is a summary entry, try to fit it anyway as it's important context
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// Stop - we've hit the budget
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

	// Token budget = context window minus reserved space for prompt + response
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// Transform to LLM-compatible messages, then serialize to text
	// Serialization prevents the model from treating it as a conversation to continue
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// Build prompt
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

	// Call LLM for summarization
	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ apiKey, headers, signal, maxTokens: 2048 },
	);

	// Check if aborted or errored
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

	// Prepend preamble to provide context about the branch summary
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};
}
