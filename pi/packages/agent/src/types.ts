import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

// ============================================================================
// `agent` 类型中枢
// ============================================================================
//
// 文件定位：
// - 这是 `pi/packages/agent` 的类型中枢
// - Agent 循环、工具执行、事件流、UI 订阅以及上层包装都依赖这里定义的协议
//
// 本文件按 7 大分类组织：
// 1. 基础运行模式与配置枚举         —— 流式函数签名、执行模式、队列模式、思考级别
// 2. Message / Content 消息与内容    —— 自定义消息扩展、消息联合类型、工具调用内容块
// 3. Tool 工具定义与执行结果         —— 工具结果、更新回调、工具定义接口
// 4. Agent 运行时状态与上下文        —— 上下文快照、公开状态接口
// 5. AgentEvent 事件协议             —— Agent 向 UI 发出的生命周期事件
// 6. Agent 循环钩子结果与上下文      —— before/after tool hook、停止判断、轮次更新
// 7. AgentLoopConfig 循环配置        —— 底层循环主配置接口
// ============================================================================

// ============================================================================
// 第 1 组：基础运行模式与配置枚举
// ============================================================================

/**
 * Agent 循环使用的流式函数签名。
 *
 * 约定：
 * - 对请求/模型/运行时故障，不得抛出异常或返回 rejected promise
 * - 必须返回 `AssistantMessageEventStream`
 * - 故障必须通过协议事件编码到流中，并以 `stopReason: "error" | "aborted"`
 *   且带 `errorMessage` 的最终 `AssistantMessage` 收束
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 单条助手消息中多个工具调用的执行方式。
 *
 * - `"sequential"`：每个工具依次 prepare、execute、finalize
 * - `"parallel"`：先按顺序 prepare，允许并行的工具再并发执行
 *
 * 事件语义：
 * - `tool_execution_end` 按工具真实完成顺序发出
 * - 持久化的 `toolResult` transcript 消息稍后仍按 assistant 源顺序发出
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 队列排空策略：控制 steering / follow-up 队列在一个排空点注入多少消息。
 *
 * - `"all"`：一次取完所有排队消息
 * - `"one-at-a-time"`：一次只取最老的一条，其余留待后续排空点
 */
export type QueueMode = "all" | "one-at-a-time";

/**
 * 支持思考/推理的模型的思考级别。
 *
 * 说明：
 * - `"off"` 表示不请求 reasoning
 * - `"xhigh"` / `"max"` 仅被部分模型家族支持
 * - 具体支持情况应以 `@earendil-works/pi-ai` 的模型元数据为准
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ============================================================================
// 第 2 组：Message 消息
// ============================================================================

/** 助手消息中发出的单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * 可扩展的自定义应用消息接口。
 *
 * 应用可通过 declaration merging 扩展：
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
	// 默认为空，应用可通过声明合并扩展
}

/**
 * Agent 内部统一消息类型：LLM 标准消息 + 自定义应用消息的联合。
 *
 * 这样既能允许应用扩展自定义消息，又能保持与底层 provider 消息的兼容。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ============================================================================
// 第 3 组：Tool 工具定义与执行结果
// ============================================================================

/**
 * `beforeToolCall()` 的返回结果。
 *
 * 返回 `{ block: true }` 会阻止工具执行，循环改为发出错误 `toolResult`。
 * `reason` 会成为该错误结果里的文本内容；省略时使用默认提示。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * `afterToolCall()` 的部分覆盖结果。
 *
 * 合并语义按字段进行：
 * - `content`：若提供，则整体替换工具结果 content
 * - `details`：若提供，则整体替换 details
 * - `isError`：若提供，则替换错误标记
 * - `usage`: 若提供，则替换工具结果 usage
 * - `terminate`：若提供，则替换提前终止提示
 *
 * 说明：
 * - 省略字段会保留原始执行结果
 * - `content` / `details` / `usage` 不做深度合并
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/** 来自工具执行本身最终返回的用量信息（如果有的话）。该用量不会计入主 LLM 上下文（上下文窗口/计费）的统计范围。 */
	usage?: Usage;
	/**
	 * 提示 Agent 在当前工具批次后停止。
	 * 仅当批次内每个 finalized 结果都把它设为 true 时，才会真正提前终止。
	 */
	terminate?: boolean;
}

/** 传给 `beforeToolCall()` 的上下文。 */
export interface BeforeToolCallContext {
	/** 请求该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 中原始的 toolCall block。 */
	toolCall: AgentToolCall;
	/** 针对目标工具 schema 校验后的参数。 */
	args: unknown;
	/** 准备该工具调用时的当前 agent 上下文。 */
	context: AgentContext;
}

/** 传给 `afterToolCall()` 的上下文。 */
export interface AfterToolCallContext {
	/** 请求该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 中原始的 toolCall block。 */
	toolCall: AgentToolCall;
	/** 针对目标工具 schema 校验后的参数。 */
	args: unknown;
	/** 尚未应用 after hook 覆盖前的执行结果。 */
	result: AgentToolResult<any>;
	/** 该执行结果当前是否被视为错误。 */
	isError: boolean;
	/** finalize 当前工具调用时的 agent 上下文。 */
	context: AgentContext;
}

/**
 * 工具的最终或部分执行结果。
 *
 * 这既是工具最终返回值的形状，也是 `onUpdate` 增量推送的 payload 形状。
 */
export interface AgentToolResult<T> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 供日志或 UI 渲染使用的任意结构化详情。 */
	details: T;
	/** 来自工具执行本身最终返回的用量信息（如果有的话）。该用量不会计入主 LLM 上下文（上下文窗口/计费）的统计范围。 */
	usage?: Usage;
	/** 此结果新引入的工具名，表示这些工具从当前 transcript 点开始可用。 */
	addedToolNames?: string[];
	/**
	 * 提示 Agent 在当前工具批次后停止。
	 * 仅当批次内每个 finalized 结果都显式返回 true 时才会真正终止。
	 */
	terminate?: boolean;
}

/**
 * 工具用于推送增量执行结果的回调。
 *
 * 作用域仅限当前一次 `execute()` 调用；tool promise settle 后的回调会被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Agent 运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** 供 UI 展示的人类可读名称。 */
	label: string;
	/**
	 * 在 schema 校验前对原始 tool-call 参数做兼容性预处理。
	 * 返回值必须符合 `TParameters`。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** 执行工具调用；失败时应抛异常，而不是在 `content` 中自行编码错误。 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * 对单个工具的执行模式覆盖。
	 *
	 * - `"sequential"`：该工具必须与其他工具逐个执行
	 * - `"parallel"`：该工具允许与其他工具并发执行
	 *
	 * 省略时使用批次默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

// ============================================================================
// 第 4 组：Agent 运行时状态与上下文
// ============================================================================

/** 传给底层 agent loop 的上下文快照。 */
export interface AgentContext {
	/** 每轮请求都会附带的 system prompt。 */
	systemPrompt: string;
	/** 模型可见的 transcript。 */
	messages: AgentMessage[];
	/** 当前运行可用的工具集合。 */
	tools?: AgentTool<any>[];
}

/**
 * 对外暴露的 Agent 状态。
 *
 * 说明：
 * - `tools` / `messages` 使用 accessor，是为了允许实现方在赋值时复制数组
 * - 运行期字段（如 `isStreaming` / `streamingMessage`）对外只读
 */
export interface AgentState {
	/** 每次请求都会随同发送的 system prompt。 */
	systemPrompt: string;
	/** 当前及未来轮次默认使用的模型。 */
	model: Model<any>;
	/** 当前及未来轮次请求的思考级别。 */
	thinkingLevel: ThinkingLevel;
	/** 可用工具集合；赋新数组时会复制顶层数组。 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** 对话消息历史；赋新数组时会复制顶层数组。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * 当 Agent 正在处理 prompt 或 continuation 时为 true。
	 *
	 * 它会一直保持 true，直到 awaited 的 `agent_end` 监听器全部 settle。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应对应的 partial assistant message（若有）。 */
	readonly streamingMessage?: AgentMessage;
	/** 当前仍在执行中的工具调用 ID 集合。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或中止的 assistant 轮次错误消息。 */
	readonly errorMessage?: string;
}

// ============================================================================
// 第 5 组：AgentEvent 事件协议
// ============================================================================

/**
 * Agent 向 UI 或外部订阅者发出的事件协议。
 *
 * 生命周期层级：
 * 1. `agent_*`：一次 run 的开始与结束
 * 2. `turn_*`：一轮 assistant 回复及其工具结果
 * 3. `message_*`：user / assistant / toolResult 消息级事件
 * 4. `tool_execution_*`：工具执行过程事件
 *
 * 注意：
 * - `agent_end` 是事件流中的最后一个事件
 * - 但 awaited 的 `Agent.subscribe()` 监听器仍属于 run 结算的一部分
 * - 只有这些监听器完成后，agent 才真正变为空闲
 */
export type AgentEvent =
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 轮次生命周期：一次 assistant 回复 + 其工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期：user / assistant / toolResult 统一使用这一组事件
	| { type: "message_start"; message: AgentMessage }
	// 仅 assistant 流式阶段会持续发 message_update
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

// ============================================================================
// 第 6 组：Agent 循环钩子结果与上下文
// ============================================================================

/** 传给 `shouldStopAfterTurn()` 的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** 完成本轮的 assistant 消息。 */
	message: AssistantMessage;
	/** 已传给前置 `turn_end` 事件的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** assistant 消息和 toolResult 都已追加后的当前上下文。 */
	context: AgentContext;
	/**
	 * 若此刻退出，本次 loop 调用将返回的消息列表。
	 *
	 * - prompt run 包含本次新增的初始 prompt
	 * - continue run 不包含既有上下文消息
	 */
	newMessages: AgentMessage[];
}

/** 在开始下一轮 provider 请求前，可替换的运行时快照。 */
export interface AgentLoopTurnUpdate {
	/** 下一轮请求使用的上下文。 */
	context?: AgentContext;
	/** 下一轮请求使用的模型。 */
	model?: Model<any>;
	/** 下一轮请求使用的 thinking level。 */
	thinkingLevel?: ThinkingLevel;
}

/**
 * 传给 `prepareNextTurn()` 的上下文。
 *
 * 目前与 `ShouldStopAfterTurnContext` 等价，但单独命名能让语义更清晰，
 * 也为未来扩展 prepare-only 字段预留空间。
 */
export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

// ============================================================================
// 第 7 组：AgentLoopConfig 循环配置
// ============================================================================

/**
 * 底层 agent loop 的主配置接口。
 *
 * 它把模型请求参数、上下文转换、停止条件、队列注入和工具 hook
 * 统一收敛到一个纯配置对象中，便于 `Agent` 和 `AgentHarness` 复用。
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 在每次 LLM 请求前把 `AgentMessage[]` 转换为 provider 能理解的 `Message[]`。
	 *
	 * 要求：
	 * - 每条 `AgentMessage` 最终都应被转换成 provider 可理解的消息，或被显式过滤掉
	 * - 不得抛异常或拒绝；如有问题，请返回安全的 fallback 结果
	 *
	 * 典型用途：
	 * - 过滤 UI-only 消息
	 * - 把自定义消息映射成 user / assistant / toolResult
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 `convertToLlm()` 之前，对 AgentMessage 级别上下文做预处理。
	 *
	 * 适用场景：
	 * - 上下文窗口裁剪
	 * - 会话摘要
	 * - 从外部来源注入额外消息
	 *
	 * 约定：不得抛异常或拒绝；异常会直接打断低层循环的正常事件协议。
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 适合短期 token 的鉴权方式（调用方可在回调内自行实现过期检测与刷新）。
	 * 没有可用 key 时返回 `undefined`，此时回退到 config.apiKey 或 pi-ai 系统认证。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 在每轮完全结束并发出 `turn_end` 后调用。
	 *
	 * 若返回 true：
	 * - loop 会发出 `agent_end`
	 * - 跳过 steering / follow-up 轮询
	 * - 不再开启下一轮 provider 请求
	 *
	 * 适合“优雅停止”场景，例如上下文窗口即将用满。
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * 在 `turn_end` 之后、判断是否继续下一轮之前调用。
	 *
	 * 可返回新的：
	 * - `context`
	 * - `model`
	 * - `thinkingLevel`
	 *
	 * 返回 `undefined` 表示沿用当前运行快照。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 获取要在运行中途注入的 steering 消息。
	 *
	 * 调用时机：
	 * - 当前 assistant 轮次及其工具执行完成后
	 * - 若 `shouldStopAfterTurn()` 已要求退出，则不会再轮询
	 *
	 * 返回的消息会在下一轮 LLM 请求前先追加到 transcript。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 获取要在 Agent 本应停止后才处理的 follow-up 消息。
	 *
	 * 仅当：
	 * - 当前没有更多工具调用
	 * - 也没有待注入 steering
	 * 时才会轮询。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 本批工具调用的默认执行模式。
	 *
	 * - `"sequential"`：逐个执行工具
	 * - `"parallel"`：先顺序 preflight，再并发执行允许并行的工具
	 *
	 * 默认值：`"parallel"`
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 在工具真正执行前、参数校验通过后调用。
	 *
	 * 返回 `{ block: true }` 会阻止工具执行，loop 改发错误 `toolResult`。
	 * hook 会收到当前 run 的 abort signal，应自行按需响应。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 在工具执行完成后、发出 `tool_execution_end` / `toolResult` 前调用。
	 *
	 * 可覆盖：
	 * - `content`
	 * - `details`
	 * - `isError`
	 * - `usage`
	 * - `terminate`
	 *
	 * 省略字段保留原始结果；不做深度合并。
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}
