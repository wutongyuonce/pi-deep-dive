/**
 * `pi/packages/agent` 的公共入口文件。
 *
 * 定位：
 * - 这是 `@earendil-works/pi-agent-core` 在 `pi/` 子树下的稳定包入口
 * - 外部调用方通常 `import { Agent, runAgentLoop } from "@earendil-works/pi-agent-core"`
 *   时，都会先经过这里
 *
 * 谁会 import 我：
 * - `pi/packages/coding-agent` 及其上层产品集成
 * - 仓库外部把 `pi-agent-core` 当作独立 agent 引擎使用的调用方
 *
 * 我在整个体系中的作用：
 * - 聚合低层核心引擎（`agent.ts` / `agent-loop.ts`）
 * - 暴露高层 harness、会话存储、skills、prompt templates、compaction
 * - 统一导出 proxy 工具和基础类型，避免调用方了解内部目录结构
 *
 * 与旧版相比：
 * - 这里新增导出了 `jsonl-storage.ts` / `memory-storage.ts`
 * - 其余分组仍保持“核心引擎 + harness + proxy + types”的总入口职责
 */
// Core Agent
export { uuidv7 } from "@earendil-works/pi-ai";
export * from "./agent.ts";
// Loop functions
export * from "./agent-loop.ts";
// 高层 harness：在纯 Agent 之上增加 session、skills、prompt templates、
// hooks、compaction、tree navigation 等产品化能力。
export * from "./harness/agent-harness.ts";
// 分支总结与 compaction 算法：给长会话管理和树导航使用。
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareBranchEntries,
} from "./harness/compaction/branch-summarization.ts";
export {
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./harness/compaction/compaction.ts";
// harness 相关的消息、prompt template、session repo / storage、skills、system prompt。
export * from "./harness/messages.ts";
export * from "./harness/prompt-templates.ts";
export * from "./harness/session/jsonl-repo.ts";
export * from "./harness/session/jsonl-storage.ts";
export * from "./harness/session/memory-repo.ts";
export * from "./harness/session/memory-storage.ts";
export * from "./harness/session/repo-utils.ts";
export * from "./harness/session/session.ts";
export * from "./harness/skills.ts";
export * from "./harness/system-prompt.ts";
// Harness
export * from "./harness/types.ts";
export * from "./harness/utils/shell-output.ts";
export * from "./harness/utils/truncate.ts";
// Proxy utilities
export * from "./proxy.ts";
// Stream defaults
export { setDefaultStreamFn } from "./stream-fn.ts";
// Types
export * from "./types.ts";
