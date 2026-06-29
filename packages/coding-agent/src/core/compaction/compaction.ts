/**
 * 上下文压缩核心逻辑。
 *
 * 作用/定位：当会话上下文接近模型窗口限制时，截断旧消息并生成摘要。
 * 提供：压缩准备（prepareCompaction）、压缩执行（compact）、摘要生成（generateSummary）、
 *       token 估算（estimateTokens/estimateContextTokens）、切割点检测（findCutPoint）等纯函数。
 *
 * 设计：纯函数用于压缩逻辑。会话管理器负责 I/O，压缩完成后重新加载会话。
 *
 * 调用链路：
 *   session-manager.prepareCompaction() → prepareCompaction()
 *   session-manager.performCompaction() → compact() → generateSummary()
 *     → generateTurnPrefixSummary()（切割轮次时）
 *
 * 被谁调用：session-manager、agent-session、扩展事件处理器
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../session-manager.ts";
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
// 文件操作跟踪
// ============================================================================

/** 存储在 CompactionEntry.details 中的文件跟踪详情 */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * 从消息和之前的压缩条目中提取文件操作。
 * 从上次压缩的 details 字段和当前消息中的工具调用中收集文件路径。
 *
 * 实现步骤：
 * 1. 如果存在前一次压缩，从其 details 中收集 readFiles 和 modifiedFiles
 * 2. 从本次消息列表的所有工具调用中提取文件操作
 *
 * 被谁调用：prepareCompaction()
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// 先继承前一次压缩已经记录下来的文件轨迹，保证多轮压缩可持续累积。
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook 字段保留用于会话文件兼容性
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// 再扫描本轮待压缩消息里的工具调用，补齐最新的文件读写信息。
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// 消息提取
// ============================================================================

/**
 * 从会话条目中提取 AgentMessage（如果该条目会产生消息）。
 * 不贡献 LLM 上下文的条目（如 thinking_level_change、model_change 等）返回 undefined。
 * 处理 6 种条目类型：message、custom_message、branch_summary、compaction 及其他。
 *
 * 被谁调用：prepareCompaction()、compact()
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** compact() 的结果 - SessionManager 在保存时添加 uuid/parentUuid */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** 扩展特定数据（如 ArtifactIndex、结构化压缩的版本标记） */
	details?: T;
}

// ============================================================================
// 类型定义
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

/**
 * 默认压缩设置：
 * - enabled: true — 启用上下文压缩
 * - reserveTokens: 16384 — 预留 token 空间给系统提示词和 LLM 响应
 * - keepRecentTokens: 20000 — 保留最近消息的 token 预算
 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// Token 计算
// ============================================================================

/**
 * 从 usage 中计算总上下文 token 数。
 * 优先使用原生 totalTokens 字段，降级为从各组件累加计算。
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 从助手消息中获取 usage（如果可用）。
 * 跳过中止和错误消息，因为它们没有有效的 usage 数据。
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * 从会话条目中查找最近的非中止助手消息的 usage。
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * 从消息列表估算上下文 token 总数。
 *
 * 实现逻辑：
 * 1. 从后往前查找最近的助手消息 usage
 * 2. 如果找到，usageTokens = 该 usage 的 total，trailingTokens 估算其后的消息
 * 3. 如果未找到，对所有消息调用 estimateTokens() 逐条估算
 *
 * 被谁调用：prepareCompaction()、session-manager
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		// 没有 usage 时只能逐条启发式估算整段上下文大小。
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	// 命中最近一次真实 usage 后，只需要补算其后的尾部消息。
	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * 根据上下文使用情况判断是否应触发压缩。
 * 规则：contextTokens > contextWindow - reserveTokens（预留空间）时触发。
 * 如果 settings.enabled 为 false 始终返回 false。
 *
 * 被谁调用：session-manager.prepareCompaction()
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// 切割点检测
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * 使用 chars/4 启发式估算单条消息的 token 数。
 * 这是一个保守估计（会高估 token 数）。
 * 根据不同角色（user/assistant/toolResult/bashExecution/branchSummary/compactionSummary）
 * 采用不同的估算方式。
 *
 * 被谁调用：findCutPoint()、estimateContextTokens()、prepareBranchEntries()、session-manager
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

/**
 * 查找有效的切割点：用户、助手、自定义或 bashExecution 消息的索引。
 *
 * 规则：
 * - 永远不在工具结果（toolResult）处切割（它们必须跟在工具调用之后）
 * - 在包含工具调用的助手消息处切割时，其工具结果会保留在后面
 * - BashExecutionMessage 被视为用户消息（用户发起的上下文）
 * - branch_summary 和 custom_message 也是有效切割点
 * - thinking_level_change、model_change、compaction 等非消息类型被跳过
 *
 * 被谁调用：findCutPoint()
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary 与 custom_message 会被视为“用户侧输入”，因此也能作为切割点。
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * 查找包含给定条目索引的轮次的起始用户消息（或 bashExecution）。
 * 如果在索引之前未找到轮次起始则返回 -1。
 * BashExecutionMessage 与用户消息一样被视为轮次边界。
 * branch_summary 和 custom_message 也是用户角色的消息，可开始一轮对话。
 *
 * 被谁调用：findCutPoint()、prepareCompaction()
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary 与 custom_message 都能作为一轮上下文的起点。
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * 在会话条目中查找切割点，保留约 keepRecentTokens 的内容。
 *
 * 算法：从最新消息向后遍历，累加估算的消息大小。
 * 当累加 >= keepRecentTokens 时停止，在该点切割。
 *
 * 可在用户或助手消息处切割（永远不在工具结果处）。在包含工具调用的
 * 助手消息处切割时，其工具结果跟在后面会被保留。
 *
 * 返回 CutPointResult：
 * - firstKeptEntryIndex：从此条目索引开始保留
 * - turnStartIndex：如果切割发生在轮次中间，则为该轮次的用户消息
 * - isSplitTurn：是否在轮次中间切割
 *
 * 仅考虑 startIndex 到 endIndex（不含）之间的条目。
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	// 先枚举候选切割点，后续只在这些安全位置上落刀。
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// 从尾部向前累积最近消息，直到达到“保留最近内容”的预算。
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // 默认：从第一条消息开始保留（不含头部）

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// 逐条估算消息体积，逼近 keepRecentTokens 阈值。
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// 一旦达到预算，就把切割点移动到当前位置之后最近的合法边界。
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// 切点前如果紧贴着非消息条目，也一并保留下来，避免元信息悬空。
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// 遇到压缩边界就停，不能跨过上一段压缩。
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// 消息边界本身就是自然分隔点，不再继续向前扩张。
			break;
		}
		// 将与切点紧邻的元数据条目一起纳入保留区。
		cutIndex--;
	}

	// 如果切到的不是用户起点，则进一步判断是否需要补“轮次前缀摘要”。
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// 摘要生成
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		// 仅在模型和当前设置都支持时才透传 reasoning 级别。
		options.reasoning = thinkingLevel;
	}
	return options;
}

async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	if (!streamFn) {
		// 无流式钩子时直接走简单完成接口。
		return completeSimple(model, context, options);
	}
	// 有流式钩子时委托外部流处理，再汇总最终结果。
	const stream = await streamFn(model, context, options);
	return stream.result();
}

/**
 * 使用 LLM 生成对话摘要。
 *
 * 如果提供了 previousSummary，使用更新提示词（UPDATE_SUMMARIZATION_PROMPT）进行迭代合并；
 * 否则使用初始提示词（SUMMARIZATION_PROMPT）生成新摘要。
 *
 * 实现步骤：
 * 1. 计算 maxToken（取 reserveTokens 的 80% 和模型 maxTokens 的较小值）
 * 2. 根据是否有 previousSummary 选择提示词
 * 3. 追加自定义指令（如果有）
 * 4. 将消息转换为 LLM 消息格式并序列化为纯文本（防止模型继续对话）
 * 5. 构建完整请求（包含 <conversation> 和可选的 <previous-summary> 标签）
 * 6. 调用 completeSimple 或 streamFn 生成摘要
 *
 * 被谁调用：compact()、session-manager
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// 先决定本次是“首轮摘要”还是“增量更新已有摘要”。
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// 先把自定义消息转成 LLM 兼容格式，再序列化成纯文本输入给摘要模型。
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// 用标签包住会话和旧摘要，给模型稳定的结构边界。
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel);

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		streamFn,
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return textContent;
}

// ============================================================================
// 压缩准备（供扩展使用）
// ============================================================================

/**
 * 压缩准备数据，由 prepareCompaction() 预计算后用于 compact()。
 */
export interface CompactionPreparation {
	/** 要保留的第一条条目的 UUID */
	firstKeptEntryId: string;
	/** 将被摘要并丢弃的消息 */
	messagesToSummarize: AgentMessage[];
	/** 如果切割发生在轮次中间，这些是轮次前缀消息 */
	turnPrefixMessages: AgentMessage[];
	/** 是否为轮次中间切割（切割点不是用户消息） */
	isSplitTurn: boolean;
	/** 压缩前的预估 token 数 */
	tokensBefore: number;
	/** 前一次压缩的摘要，用于迭代更新 */
	previousSummary?: string;
	/** 从 messagesToSummarize 中提取的文件操作 */
	fileOps: FileOperations;
	/** 来自 settings.jsonl 的压缩设置 */
	settings: CompactionSettings;
}

/**
 * 准备压缩所需的所有数据。
 *
 * 实现步骤：
 * 1. 检查最后一条是否为压缩条目（防止重复压缩）
 * 2. 查找上一次压缩的位置作为边界起点
 * 3. 计算当前消息的 token 总数
 * 4. 调用 findCutPoint() 找到切割点
 * 5. 提取需摘要的消息和轮次前缀消息
 * 6. 从消息和上次压缩中提取文件操作
 *
 * @returns CompactionPreparation 或 undefined（会话需要迁移或已是最新）
 *
 * 被谁调用：session-manager、扩展事件处理器
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		// 找到上一段压缩后，从它保留的第一条记录开始重新计算边界。
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	// 基于当前完整上下文估算 token，再决定本次压缩应从哪里截断。
	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// firstKeptEntryId 会写入压缩条目，供后续恢复边界和增量压缩复用。
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// 边界前的历史消息会被摘要后丢弃。
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// 如果切在一轮对话中间，还要额外保留这轮前缀用于补充说明。
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// 提前收集文件轨迹，后续摘要生成阶段只负责拼接结果。
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// 分裂轮次时，前缀消息里的工具调用也要计入文件轨迹。
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// 主压缩函数
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * 使用准备好的数据执行压缩并生成摘要。
 *
 * 如果是切割轮次（isSplitTurn），并行生成历史摘要和轮次前缀摘要，然后合并。
 * 否则仅生成历史摘要。
 * 最后将文件操作信息追加到摘要中。
 *
 * @param preparation - prepareCompaction() 预计算的准备数据
 * @param customInstructions - 可选的摘要自定义焦点
 *
 * @returns CompactionResult - SessionManager 在保存时添加 uuid/parentUuid
 *
 * 被谁调用：session-manager.performCompaction()、扩展事件处理器
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// 根据是否切开一轮对话，决定只生成历史摘要还是并行补一份前缀摘要。
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// 历史摘要和轮次前缀摘要彼此独立，可以并行缩短总耗时。
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
				streamFn,
			),
		]);
		// 将两段摘要拼成统一的压缩内容，供后续作为单条 compaction 记录使用。
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		// 未切开轮次时，只需要生成常规历史摘要。
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
		);
	}

	// 统一在摘要末尾补上文件读写列表，便于后续恢复工作上下文。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * 为轮次前缀生成摘要（当切割发生在轮次中间时）。
 * 使用 TURN_PREFIX_SUMMARIZATION_PROMPT 提示，token 预算更小（reserveTokens 的 50%）。
 *
 * 被谁调用：compact()
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // Smaller budget for turn prefix
	// 轮次前缀只承担“解释保留后缀”的作用，因此采用更小的 token 预算。
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
		streamFn,
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
