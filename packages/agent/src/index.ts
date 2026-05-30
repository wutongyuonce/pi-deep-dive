/**
 * `packages/agent` 的公共入口文件。
 *
 * 定位：
 * - 这是 `@earendil-works/pi-agent-core` 的默认包入口
 * - 外部调用方通常 `import { Agent, runAgentLoop } from "@earendil-works/pi-agent-core"`
 *   时，都会先经过这里
 *
 * 谁会 import 我：
 * - `packages/coding-agent`：用这里暴露的 `Agent` / `AgentHarness` / compaction 能力搭建产品层会话
 * - 仓库外部的 npm 使用者：把 `pi-agent-core` 当成独立 agent 引擎使用
 *
 * 我在整个体系中的作用：
 * - 把低层核心引擎（`agent.ts` / `agent-loop.ts`）
 * - 和高层 harness 能力（session、skills、prompt templates、compaction）
 *   聚合到一个稳定入口，避免调用方了解内部目录结构
 *
 * 阅读建议：
 * - 想理解最小 agent loop：先看 `agent-loop.ts` 和 `agent.ts`
 * - 想理解高层集成：再看 `harness/agent-harness.ts`
 */
// Core Agent
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
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./harness/compaction/compaction.ts";

// harness 相关的消息、prompt template、session repo、skills、system prompt。
export * from "./harness/messages.ts";
export * from "./harness/prompt-templates.ts";
export * from "./harness/session/jsonl-repo.ts";
export * from "./harness/session/memory-repo.ts";
export * from "./harness/session/repo-utils.ts";
export * from "./harness/session/session.ts";
export { uuidv7 } from "./harness/session/uuid.ts";
export * from "./harness/skills.ts";
export * from "./harness/system-prompt.ts";
// Harness
export * from "./harness/types.ts";
export * from "./harness/utils/shell-output.ts";
export * from "./harness/utils/truncate.ts";

// Proxy utilities
export * from "./proxy.ts";
// Types
export * from "./types.ts";
