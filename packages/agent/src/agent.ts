import {
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type Transport,
} from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	QueueMode,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

// =============================================================================
// 内部工具函数和常量
// =============================================================================

/**
 * 默认的 convertToLlm：只保留 LLM 能理解的三种消息角色。
 *
 * 调用链：Agent.constructor → 作为 this.convertToLlm 的默认值
 * 被调用：agent-loop.ts 每次 LLM 请求前调用 convertToLlm(messages)
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

/** 空的 usage 对象，用于错误/中止场景下填充 AssistantMessage。 */
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 默认模型占位符，Agent 未设置模型时使用。 */
const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

// =============================================================================
// 内部可变状态类型
// =============================================================================

/**
 * Agent 的内部可变状态。
 *
 * 与公开的 AgentState 接口的区别：
 * - AgentState 的 isStreaming / streamingMessage / pendingToolCalls / errorMessage 是 readonly
 * - MutableAgentState 这些字段是可写的，供 Agent 内部方法修改
 */
type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

/**
 * 创建 MutableAgentState 实例。
 *
 * 调用链：Agent.constructor → 本函数
 *
 * 使用 getter/setter 实现 tools 和 messages 的"赋值时拷贝"语义：
 * - 外部赋值 state.tools = newTools 时，内部存储的是 newTools 的副本
 * - 避免外部持有内部数组的引用导致意外修改
 */
function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice(); // 赋值时拷贝
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice(); // 赋值时拷贝
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

// =============================================================================
// Agent 构造选项
// =============================================================================

/** Agent 构造函数的选项。 */
export interface AgentOptions {
	/** 初始状态（系统提示、模型、工具、历史消息等）。 */
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	/** 将 AgentMessage[] 转换为 LLM 兼容的 Message[]。 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** 在 convertToLlm 之前对上下文做变换（如裁剪旧消息）。 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** 流式函数，默认使用 pi-ai 的 streamSimple。 */
	streamFn?: StreamFn;
	/** 动态获取 API 密钥。 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** 发送前检查/替换 payload 的回调。 */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** 收到 HTTP 响应后的回调。 */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** 工具执行前的拦截钩子（可阻止执行）。 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/** 工具执行后的拦截钩子（可覆盖结果）。 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** 轮次结束后准备下一轮的钩子（可替换上下文/模型）。 */
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** steering 消息的队列模式。 */
	steeringMode?: QueueMode;
	/** follow-up 消息的队列模式。 */
	followUpMode?: QueueMode;
	/** 会话标识符，传给 provider 用于缓存。 */
	sessionId?: string;
	/** 各推理级别的 token 预算。 */
	thinkingBudgets?: ThinkingBudgets;
	/** 传输方式偏好。 */
	transport?: Transport;
	/** 最大重试延迟（毫秒）。 */
	maxRetryDelayMs?: number;
	/** 工具执行模式（顺序 / 并行）。 */
	toolExecution?: ToolExecutionMode;
}

// =============================================================================
// 消息队列
// =============================================================================

/**
 * 轻量队列：Agent 用它分别管理 steering 和 follow-up 两类待注入消息。
 *
 * 调用链：
 * - Agent.constructor 创建两个实例（steeringQueue、followUpQueue）
 * - Agent.steer() / Agent.followUp() 调用 enqueue()
 * - createLoopConfig() 中的 getSteeringMessages / getFollowUpMessages 调用 drain()
 *
 * drain() 的行为取决于 mode：
 * - "all"：一次性取出所有消息
 * - "one-at-a-time"：每次只取最老的一条
 */
class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	/** 入队一条消息。 */
	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	/** 队列是否非空。 */
	hasItems(): boolean {
		return this.messages.length > 0;
	}

	/**
	 * 出队：根据 mode 取出消息。
	 * - "all"：取出全部并清空
	 * - "one-at-a-time"：取出最老的一条
	 */
	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		const first = this.messages[0];
		if (!first) {
			return [];
		}
		this.messages = this.messages.slice(1);
		return [first];
	}

	/** 清空队列。 */
	clear(): void {
		this.messages = [];
	}
}

// =============================================================================
// ActiveRun 类型
// =============================================================================

/**
 * 一次 run 的生命周期元数据。
 *
 * - promise：waitForIdle() 返回的 Promise，finishRun() 时 resolve
 * - resolve：手动 resolve promise 的函数
 * - abortController：本次 run 的 AbortController，agent.abort() 调用它的 abort()
 */
type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

// =============================================================================
// Agent 类
// =============================================================================

/**
 * 对低层 `runAgentLoop*()` 的有状态封装。
 *
 * 核心职责：
 * - 持有 transcript / model / tools / thinkingLevel 等运行态
 * - 把回调式低层 loop 包装成更易用的 `prompt()` / `continue()` / `abort()` API
 * - 维护 steer / follow-up 队列
 * - 把低层 AgentEvent 先归并进内部 state，再分发给订阅者
 *
 * 外部调用方：
 * - packages/coding-agent：创建 Agent 实例，调用 prompt() / continue() / abort()
 * - packages/agent 测试：直接实例化 Agent 进行单元测试
 */
export class Agent {
	// ---- 内部状态 ----
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	private activeRun?: ActiveRun;

	// ---- 公开配置（可运行时修改） ----
	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFn: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** 会话标识符，传给 provider 用于缓存感知后端。 */
	public sessionId?: string;
	/** 各推理级别的 token 预算。 */
	public thinkingBudgets?: ThinkingBudgets;
	/** 传输方式偏好。 */
	public transport: Transport;
	/** 最大重试延迟（毫秒）。 */
	public maxRetryDelayMs?: number;
	/** 工具执行策略。 */
	public toolExecution: ToolExecutionMode;

	// =========================================================================
	// 构造函数
	// =========================================================================

	/**
	 * 构造时只做状态和依赖注入，不启动任何异步流程。
	 *
	 * 调用方：应用层 `new Agent(options)`
	 *
	 * 步骤：
	 * 1. 创建可变状态（createMutableAgentState）
	 * 2. 注入所有可选的 hook 和配置
	 * 3. 创建 steering 和 follow-up 两个消息队列
	 */
	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.streamFn = options.streamFn ?? streamSimple;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.prepareNextTurn = options.prepareNextTurn;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.toolExecution = options.toolExecution ?? "parallel";
	}

	// =========================================================================
	// 事件订阅
	// =========================================================================

	/**
	 * 订阅 Agent 生命周期事件。
	 *
	 * 调用方：UI 层、日志层、测试代码
	 *
	 * 返回值：取消订阅的函数
	 *
	 * 监听器按注册顺序串行 await，包含在当前 run 的结算中。
	 * `agent_end` 是最后一次事件，但 Agent 在所有 agent_end 监听器 settle 后才算空闲。
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// =========================================================================
	// 状态访问
	// =========================================================================

	/**
	 * 当前 Agent 状态（只读视图）。
	 *
	 * 调用方：UI 层读取 isStreaming、messages、tools 等
	 */
	get state(): AgentState {
		return this._state;
	}

	// =========================================================================
	// 队列模式控制
	// =========================================================================

	/** steering 消息的队列模式。 */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}
	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** follow-up 消息的队列模式。 */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}
	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	// =========================================================================
	// 消息队列操作
	// =========================================================================

	/**
	 * 入队一条 steering 消息：在当前助手轮次结束后注入。
	 *
	 * 调用方：UI 层、外部中断逻辑
	 * 内部调用：steeringQueue.enqueue()
	 */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/**
	 * 入队一条 follow-up 消息：在 Agent 本应停止时注入。
	 *
	 * 调用方：UI 层、外部追加逻辑
	 * 内部调用：followUpQueue.enqueue()
	 */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** 清空 steering 队列。 */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** 清空 follow-up 队列。 */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** 清空所有队列。 */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** 是否有待处理的队列消息。 */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	// =========================================================================
	// Abort 控制
	// =========================================================================

	/**
	 * 当前 run 的 AbortSignal（只读）。
	 *
	 * 调用方：prepareNextTurn 等钩子通过闭包访问
	 */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/**
	 * 中止当前 run。
	 *
	 * 调用方：UI 层的"取消"按钮
	 * 内部调用：activeRun.abortController.abort()
	 * 效果：signal.aborted 变为 true，所有检查点都会响应
	 */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * 等待当前 run 及所有事件监听器完成。
	 *
	 * 调用方：测试代码、需要同步等待的场景
	 * 返回：activeRun.promise，finishRun() 时 resolve
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	// =========================================================================
	// 重置
	// =========================================================================

	/**
	 * 清空 transcript、运行态和队列。
	 *
	 * 调用方：测试代码、需要完全重置的场景
	 * 注意：不会取消正在进行的 run，需要先 abort()
	 */
	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	// =========================================================================
	// 公开 API：prompt / continue
	// =========================================================================

	/**
	 * 发起一次新的 prompt。
	 *
	 * 调用方：UI 层、coding-agent
	 * 调用链：prompt() → normalizePromptInput() → runPromptMessages() → runWithLifecycle() → runAgentLoop()
	 *
	 * @param input 字符串、单条消息或消息数组
	 * @param images 可选的图片内容（仅当 input 是字符串时生效）
	 */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/**
	 * 从当前 transcript 继续运行（不添加新消息）。
	 *
	 * 调用方：UI 层、coding-agent
	 * 调用链：continue() → runContinuation() → runWithLifecycle() → runAgentLoopContinue()
	 *
	 * 前提：最后一条消息必须是 user 或 toolResult 角色。
	 * 如果最后一条是 assistant，会尝试从队列中取出消息走 prompt 流程。
	 */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			// 最后一条是 assistant，直接 continue 会违反低层 loop 的要求。
			// 优先尝试从队列取出消息，走 prompt 流程。
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	// =========================================================================
	// 私有方法：输入归一化
	// =========================================================================

	/**
	 * 把三种 prompt 输入形式统一归一化成 AgentMessage[]。
	 *
	 * 调用链：prompt() → 本函数
	 *
	 * 支持的输入：
	 * - string：包装为 UserMessage
	 * - AgentMessage：包装为单元素数组
	 * - AgentMessage[]：直接返回
	 */
	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	// =========================================================================
	// 私有方法：run 启动
	// =========================================================================

	/**
	 * 新开一轮带 prompt 的 agent run。
	 *
	 * 调用链：prompt() → normalizePromptInput() → 本函数 → runWithLifecycle() → runAgentLoop()
	 *
	 * 步骤：
	 * 1. 通过 runWithLifecycle 包装生命周期
	 * 2. 创建上下文快照（避免低层 loop 持有可变 state）
	 * 3. 创建 loop 配置（映射所有 hook 和队列）
	 * 4. 调用低层 runAgentLoop
	 */
	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	/**
	 * continuation 版本，基于当前 transcript 直接续跑。
	 *
	 * 调用链：continue() → 本函数 → runWithLifecycle() → runAgentLoopContinue()
	 *
	 * 与 runPromptMessages 的区别：不追加新 prompt，只用当前 context 续跑。
	 */
	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	// =========================================================================
	// 私有方法：上下文和配置
	// =========================================================================

	/**
	 * 为本次 run 生成上下文快照。
	 *
	 * 调用链：runPromptMessages() / runContinuation() → 本函数
	 *
	 * 为什么需要快照：
	 * - 低层 loop 应该拿到一份独立的副本
	 * - 避免低层 loop 持有 Agent 可变 state 的引用
	 * - 保证并发安全（虽然目前 JS 是单线程，但异步交错可能导致问题）
	 */
	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	/**
	 * 组装低层 AgentLoopConfig。
	 *
	 * 调用链：runPromptMessages() / runContinuation() → 本函数
	 *
	 * 调用了谁：
	 * - this.steeringQueue.drain() → getSteeringMessages 回调
	 * - this.followUpQueue.drain() → getFollowUpMessages 回调
	 * - this._state.model / thinkingLevel → 映射为 config 字段
	 * - this.convertToLlm / transformContext / beforeToolCall 等 → 注入 config
	 *
	 * 核心作用：把 Agent 上的状态和 hook 全部映射成低层 loop 能理解的纯配置对象。
	 */
	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			// prepareNextTurn 通过闭包把当前 run 的 signal 透传进去
			prepareNextTurn: this.prepareNextTurn ? async () => await this.prepareNextTurn?.(this.signal) : undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				// continue 时先把队列手动取出了，跳过首次 poll 避免重复消费
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	// =========================================================================
	// 私有方法：生命周期管理
	// =========================================================================

	/**
	 * 生命周期壳层：保证一次 run 的 activeRun / abort / settle 行为一致。
	 *
	 * 调用链：runPromptMessages() / runContinuation() → 本函数
	 * 调用了谁：executor（即 runAgentLoop / runAgentLoopContinue）
	 *
	 * 步骤：
	 * 1. 检查是否已有 activeRun（不允许并发）
	 * 2. 创建 AbortController 和 promise
	 * 3. 设置 activeRun（waitForIdle() 依赖它）
	 * 4. 初始化运行态（isStreaming = true）
	 * 5. 执行 executor（低层 loop）
	 * 6. 如果 executor 抛异常，补发失败事件
	 * 7. finally 中调用 finishRun() 清理状态
	 */
	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		// 每次 run 都生成独立的 abortController，abort 粒度绑定到当前 run
		const abortController = new AbortController();
		// waitForIdle() 依赖这个 promise
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		// 初始化运行态
		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			// 低层 loop 未按协议发出失败事件时，补发最小失败事件
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	/**
	 * 当低层 loop 抛出异常且没能走正常事件协议时，补发一组失败事件。
	 *
	 * 调用链：runWithLifecycle() catch 块 → 本函数
	 * 调用了谁：this.processEvents()（广播事件给订阅者）
	 *
	 * 步骤：
	 * 1. 构造一个 stopReason 为 "aborted" 或 "error" 的 AssistantMessage
	 * 2. 按顺序发出 message_start → message_end → turn_end → agent_end
	 */
	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	/**
	 * 清理一次 run 的运行态。
	 *
	 * 调用链：runWithLifecycle() finally 块 → 本函数
	 *
	 * 步骤：
	 * 1. isStreaming = false
	 * 2. 清空 streamingMessage 和 pendingToolCalls
	 * 3. resolve activeRun.promise（唤醒 waitForIdle() 的等待者）
	 * 4. 清除 activeRun（允许下一次 run）
	 *
	 * 注意：transcript（messages）不会在这里回滚。
	 */
	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	// =========================================================================
	// 私有方法：事件处理
	// =========================================================================

	/**
	 * 事件归并 + 广播：Agent 与低层 agent-loop.ts 的汇合点。
	 *
	 * 调用链：
	 * - runPromptMessages() / runContinuation() 中作为回调传给 runAgentLoop()
	 * - runAgentLoop*() 推送事件到这里
	 *
	 * 调用了谁：this.listeners（所有订阅者）
	 *
	 * 步骤：
	 * 1. 根据事件类型更新内部 state（streamingMessage、messages、pendingToolCalls、errorMessage）
	 * 2. 获取当前 run 的 AbortSignal
	 * 3. 按注册顺序串行 await 每个 listener
	 *
	 * 事件类型与 state 更新的对应关系：
	 * - message_start → streamingMessage = message（开始流式生成）
	 * - message_update → streamingMessage = message（增量更新）
	 * - message_end → streamingMessage = undefined, messages.push(message)（提交到 transcript）
	 * - tool_execution_start → pendingToolCalls.add(id)
	 * - tool_execution_end → pendingToolCalls.delete(id)
	 * - turn_end → errorMessage（如有）
	 * - agent_end → streamingMessage = undefined
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				// 只有 message_end 才提交到 transcript，避免 partial 污染历史
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				// 不可变替换 Set，方便外层状态观察
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				// errorMessage 在 turn 末尾稳定写入，避免流式中途闪烁
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		// 获取当前 run 的 signal，传给订阅者
		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		// 订阅者按注册顺序串行 await，保证外部副作用顺序与 AgentEvent 顺序一致
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
