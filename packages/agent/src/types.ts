import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

// ============================================================================
// `agent` 类型中枢
// ============================================================================
//
// 文件定位：
// - 这是 `packages/agent` 的"类型中枢"
// - Agent 循环、工具执行、事件流、UI 订阅都依赖这里定义的协议
//
// 本文件按 7 大分类组织：
// 1. 基础运行模式与配置枚举         —— 流式函数签名、执行模式、队列模式、思考级别
// 2. Message / Content 消息与内容    —— 自定义消息扩展、消息联合类型、工具调用内容块
// 3. Tool 工具定义与执行结果         —— 工具结果、更新回调、工具定义接口
// 4. Agent 运行时状态与上下文        —— 上下文快照、公开状态接口
// 5. AgentEvent 事件协议             —— Agent 为 UI 发出的生命周期事件
// 6. Agent 循环钩子结果与上下文      —— before/after 工具调用钩子、停止判断、轮次更新
// 7. AgentLoopConfig 循环配置        —— 循环主配置接口
// ============================================================================

// ============================================================================
// 第 1 组：基础运行模式与配置枚举
// ============================================================================
//
// 这组类型定义了：
// - Agent 循环使用的流式函数签名
// - 工具调用的执行方式（顺序 / 并发）
// - 队列排空策略
// - 支持推理模型的思考级别档位

/**
 * Agent 循环使用的流式函数。
 *
 * 约定：
 * - 对于请求/模型/运行时故障，不得抛出异常或返回被拒绝的 Promise。
 * - 必须返回 AssistantMessageEventStream。
 * - 故障必须通过协议事件编码到返回的流中，并以 stopReason 为 "error" 或 "aborted"
 *   且带有 errorMessage 的 AssistantMessage 作为最终结果。
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * 单条助手消息中工具调用的执行方式配置。
 *
 * - "sequential"：每个工具调用按顺序准备、执行并完成，然后再开始下一个。
 * - "parallel"：工具调用按顺序准备，然后允许的工具并发执行。
 *   每个工具完成后按工具完成顺序发出 `tool_execution_end`，
 *   而工具结果消息稍后按助手源顺序发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 控制当 Agent 循环到达队列排空点时注入多少条排队的用户消息。
 *
 * - "all"：在该点排空并注入所有排队消息。
 * - "one-at-a-time"：仅排空并注入最老的一条排队消息，其余留待后续排空点处理。
 */
export type QueueMode = "all" | "one-at-a-time";

/**
 * 支持思考/推理的模型的思考级别。
 * 注意："xhigh" 仅被部分模型系列支持。使用 @earendil-works/pi-ai 中的模型思考级别元数据
 * 来检测具体模型的支持情况。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ============================================================================
// 第 2 组：Message / Content 消息与内容
// ============================================================================
//
// 这组类型定义了：
// - 可扩展的自定义应用消息接口（通过声明合并扩展）
// - Agent 消息联合类型（LLM 标准消息 + 自定义消息）
// - 助手消息中的工具调用内容块提取类型

/**
 * 可扩展的自定义应用消息接口。
 * 应用可通过声明合并进行扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空 - 应用通过声明合并扩展
}

/**
 * AgentMessage：LLM 消息 + 自定义消息的联合类型。
 * 此抽象允许应用添加自定义消息类型，同时保持
 * 类型安全性和与基础 LLM 消息的兼容性。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/** 助手消息中发出的单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

// ============================================================================
// 第 3 组：Tool 工具定义与执行结果
// ============================================================================
//
// 这组类型定义了：
// - 工具执行产生的结果结构
// - 流式更新部分结果的回调类型
// - Agent 运行时的完整工具定义接口（含执行、参数适配、执行模式覆盖）

/** 工具产生的最终或部分结果。 */
export interface AgentToolResult<T> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 用于日志或 UI 渲染的任意结构化详情。 */
	details: T;
	/**
	 * 提示 Agent 应在当前工具批次后停止。
	 * 仅当批次中每个已完成的工具结果都将此项设为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/** 工具用于流式传输部分执行更新的回调。 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Agent 运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** 用于 UI 显示的人类可读标签。 */
	label: string;
	/**
	 * 在 schema 验证之前用于原始工具调用参数的可选兼容性适配。
	 * 必须返回与 `TParameters` 匹配的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** 执行工具调用。失败时抛出异常，而不是在 `content` 中编码错误。 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * 每个工具的执行模式覆盖。
	 * - "sequential"：此工具必须与其他工具调用逐一执行。
	 * - "parallel"：此工具可以与其他工具调用并发执行。
	 *
	 * 如果省略，使用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

// ============================================================================
// 第 4 组：Agent 运行时状态与上下文
// ============================================================================
//
// 这组类型定义了：
// - 传递给底层 Agent 循环的上下文快照（system prompt + 消息 + 工具）
// - Agent 对外暴露的公开状态接口（模型、工具、消息、流式状态）

/** 传递给底层 Agent 循环的上下文快照。 */
export interface AgentContext {
	/** 随请求包含的系统提示。 */
	systemPrompt: string;
	/** 模型可见的对话记录。 */
	messages: AgentMessage[];
	/** 本次运行可用的工具。 */
	tools?: AgentTool<any>[];
}

/**
 * 公开的 Agent 状态。
 *
 * `tools` 和 `messages` 使用访问器属性，以便实现在存储之前复制赋值的数组。
 */
export interface AgentState {
	/** 随每次模型请求发送的系统提示。 */
	systemPrompt: string;
	/** 用于后续轮次的活跃模型。 */
	model: Model<any>;
	/** 后续轮次请求的推理级别。 */
	thinkingLevel: ThinkingLevel;
	/** 可用工具。赋新数组会复制顶层数组。 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** 对话记录。赋新数组会复制顶层数组。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * 当 Agent 正在处理提示或继续时为 true。
	 *
	 * 在等待的 `agent_end` 监听器完成之前一直保持 true。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应的部分助手消息（如有）。 */
	readonly streamingMessage?: AgentMessage;
	/** 当前正在执行的工具调用 ID。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或中止的助手轮次的错误消息（如有）。 */
	readonly errorMessage?: string;
}

// ============================================================================
// 第 5 组：AgentEvent 事件协议
// ============================================================================
//
// Agent 为 UI 订阅者发出的生命周期事件。
//
// 事件生命周期：
// 1. agent_start / agent_end  —— Agent 运行级别
// 2. turn_start / turn_end    —— 单次助手响应 + 工具调用/结果
// 3. message_start / message_update / message_end  —— 消息级别
// 4. tool_execution_start / tool_execution_update / tool_execution_end  —— 工具执行级别

/**
 * Agent 为 UI 更新发出的事件。
 *
 * `agent_end` 是某次运行发出的最后一个事件，但等待的 `Agent.subscribe()` 中
 * 对该事件的监听器仍属于运行结算的一部分。Agent 仅在这些监听器完成后才变为空闲。
 */
export type AgentEvent =
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 轮次生命周期 - 一个轮次包含一次助手响应及其工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期 - 为用户、助手和工具结果消息发出
	| { type: "message_start"; message: AgentMessage }
	// 仅在流式传输期间为助手消息发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

// ============================================================================
// 第 6 组：Agent 循环钩子结果与上下文
// ============================================================================
//
// 这组类型定义了 AgentLoopConfig 中各钩子函数的参数和返回值：
// - beforeToolCall / afterToolCall 的结果与上下文
// - shouldStopAfterTurn 的上下文
// - prepareNextTurn 的上下文与返回的轮次更新

// ---------------------------------------------------------------------------
// 6.1 工具调用钩子结果
// ---------------------------------------------------------------------------

/**
 * `beforeToolCall` 返回的结果。
 *
 * 返回 `{ block: true }` 将阻止工具执行。循环会发出一个错误工具结果。
 * `reason` 成为该错误结果中显示的文本。如果省略，将使用默认的阻止消息。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * `afterToolCall` 返回的部分覆盖。
 *
 * 合并语义为逐字段处理：
 * - `content`：如果提供，则完全替换工具结果的 content 数组
 * - `details`：如果提供，则完全替换工具结果的 details 值
 * - `isError`：如果提供，则替换工具结果的错误标志
 * - `terminate`：如果提供，则替换提前终止提示
 *
 * 省略的字段保留原始执行的工具结果值。
 * `content` 和 `details` 不会进行深度合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * 提示 Agent 应在当前工具批次后停止。
	 * 仅当批次中每个已完成的工具结果都将此项设为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

// ---------------------------------------------------------------------------
// 6.2 工具调用钩子上下文
// ---------------------------------------------------------------------------

/** 传递给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 请求工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 针对目标工具 schema 已验证的工具参数。 */
	args: unknown;
	/** 工具调用准备时的当前 Agent 上下文。 */
	context: AgentContext;
}

/** 传递给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 请求工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 针对目标工具 schema 已验证的工具参数。 */
	args: unknown;
	/** 应用 `afterToolCall` 覆盖前的已执行工具结果。 */
	result: AgentToolResult<any>;
	/** 已执行的工具结果当前是否被当作错误处理。 */
	isError: boolean;
	/** 工具调用完成时的当前 Agent 上下文。 */
	context: AgentContext;
}

// ---------------------------------------------------------------------------
// 6.3 轮次停止判断与轮次更新
// ---------------------------------------------------------------------------

/** 传递给 `shouldStopAfterTurn` 的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** 完成该轮次的助手消息。 */
	message: AssistantMessage;
	/** 传递给前置 `turn_end` 事件的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** 该轮次的助手消息和工具结果追加后的当前 Agent 上下文。 */
	context: AgentContext;
	/** 如果此时退出，该循环调用将返回的消息。提示运行包含初始提示消息；继续运行不包含已有的上下文消息。 */
	newMessages: AgentMessage[];
}

/** 在 Agent 循环开始另一个提供商请求之前使用的替换运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次提供商请求的上下文。 */
	context?: AgentContext;
	/** 下一次提供商请求的模型。 */
	model?: Model<any>;
	/** 下一次提供商请求的思考级别。 */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

// ============================================================================
// 第 7 组：AgentLoopConfig 循环配置
// ============================================================================
//
// Agent 循环的主配置接口，包含：
// - 模型、消息转换、上下文变换
// - API 密钥解析
// - 轮次停止、轮次准备、引导消息、后续消息等生命周期钩子
// - 工具执行模式与工具调用钩子

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 在每次 LLM 调用之前将 AgentMessage[] 转换为 LLM 兼容的 Message[]。
	 *
	 * 每个 AgentMessage 必须被转换为 LLM 能理解的 UserMessage、AssistantMessage 或 ToolResultMessage。
	 * 无法转换的 AgentMessage（例如仅限 UI 的通知、状态消息）应被过滤掉。
	 *
	 * 约定：不得抛出异常或拒绝。请返回安全的回退值。
	 * 抛出异常会中断底层 Agent 循环，不会产生正常的事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 将自定义消息转换为用户消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤掉仅限 UI 的消息
	 *     return [];
	 *   }
	 *   // 透传标准 LLM 消息
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 `convertToLlm` 之前对上下文应用的可选转换。
	 *
	 * 适用于在 AgentMessage 级别操作的场景：
	 * - 上下文窗口管理（裁剪旧消息）
	 * - 从外部来源注入上下文
	 *
	 * 约定：不得抛出异常或拒绝。请返回原始消息或其他安全的回退值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 为每次 LLM 调用动态解析 API 密钥。
	 *
	 * 适用于短期 OAuth 令牌（例如 GitHub Copilot），这些令牌可能在长时间工具执行阶段期间过期。
	 *
	 * 约定：不得抛出异常或拒绝。没有可用密钥时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 在每个轮次完全完成并发出 `turn_end` 之后调用。
	 *
	 * 如果返回 true，循环发出 `agent_end` 并在轮询引导或后续队列之前退出，
	 * 不会启动另一次 LLM 调用。当前助手响应和所有工具执行正常完成。
	 *
	 * 用于在当前轮次之后请求优雅停止，例如在上下文即将超出容量之前。
	 *
	 * 约定：不得抛出异常或拒绝。抛出异常会中断底层 Agent 循环，不会产生正常的事件序列。
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * 在 `turn_end` 之后、循环决定是否启动另一个提供商请求之前调用。
	 * 返回替换的上下文/模型/思考状态以影响本次运行的下一轮次。
	 * 返回 undefined 以继续使用当前的上下文/配置。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回在运行中注入对话的引导消息。
	 *
	 * 在当前助手轮次完成工具调用执行后调用，除非 `shouldStopAfterTurn` 先退出。
	 * 如果返回消息，它们将在下一次 LLM 调用之前添加到上下文中。
	 * 当前助手消息的工具调用不会被跳过。
	 *
	 * 用于在 Agent 工作期间"引导"其方向。
	 *
	 * 约定：不得抛出异常或拒绝。没有可用引导消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回在 Agent 本应停止后处理的后续消息。
	 *
	 * 当 Agent 没有更多的工具调用且没有引导消息时调用。
	 * 如果返回消息，它们会被添加到上下文中，Agent 继续执行下一轮次。
	 *
	 * 用于应等待 Agent 完成后再处理的后续消息。
	 *
	 * 约定：不得抛出异常或拒绝。没有可用后续消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 工具执行模式。
	 * - "sequential"：逐个执行工具调用
	 * - "parallel"：按顺序预检工具调用，然后并发执行允许的工具；
	 *   每个工具完成后按工具完成顺序发出 `tool_execution_end`，
	 *   然后按助手源顺序发出工具结果消息
	 *
	 * 默认值："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 在工具执行之前、参数验证之后调用。
	 *
	 * 返回 `{ block: true }` 以阻止执行。循环会发出一个错误工具结果。
	 * 该钩子接收 Agent 中止信号，有责任遵守该信号。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 在工具执行完成之后、`tool_execution_end` 和工具结果消息事件发出之前调用。
	 *
	 * 返回 `AfterToolCallResult` 以覆盖已执行工具结果的部分内容：
	 * - `content` 替换完整的 content 数组
	 * - `details` 替换完整的 details 载荷
	 * - `isError` 替换错误标志
	 * - `terminate` 替换提前终止提示
	 *
	 * 省略的字段保留原始值。不进行深度合并。
	 * 该钩子接收 Agent 中止信号，有责任遵守该信号。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}
