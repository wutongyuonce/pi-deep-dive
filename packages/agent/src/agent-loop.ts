/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 *
 * === 文件总体调用链 ===
 *
 * 外部调用入口（公开导出）：
 *   Agent.prompt()            -> agentLoop()
 *   Agent.continue()          -> agentLoopContinue()
 *   AgentHarness.executeTurn() -> agentLoop()
 *
 * agentLoop()                -> runAgentLoop()        -> runLoop()
 * agentLoopContinue()        -> runAgentLoopContinue() -> runLoop()
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

/** Agent 事件接收器类型：异步或同步回调，用于接收 agent 生命周期中的所有事件。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 使用新的提示消息启动 Agent 循环。
 * 提示消息会被添加到上下文中，并为其发出相应事件。
 *
 * 谁调用我：
 * - 更底层场景可直接使用本函数
 * - 高层 `Agent.prompt()` / `AgentHarness.executeTurn()` 更常调用 `runAgentLoop()`
 *
 * 我调用谁：
 * - `runAgentLoop()` 负责真正执行循环
 * - `createAgentStream()` 把回调式 emit 包装成可遍历事件流
 *
 * 内部步骤：
 * 1. 创建 `EventStream` 供 UI/外层编排消费
 * 2. 异步启动 `runAgentLoop()`，每次 emit 事件推入 stream
 * 3. 循环结束后调用 `stream.end()` 传递最终消息列表
 * 4. 立即返回 stream（调用方可提前订阅）
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * 从当前上下文继续 Agent 循环，不添加新消息。
 * 用于重试场景——上下文中已有用户消息或工具结果。
 *
 * **重要：** 上下文中的最后一条消息必须能通过 `convertToLlm` 转换为 `user` 或 `toolResult` 消息。
 * 如果不能，LLM 提供商将拒绝请求。
 * 这里无法提前验证，因为 `convertToLlm` 仅在每个轮次开始时调用一次。
 *
 * 谁调用我：
 * - 直接使用低层流式 API 的应用
 * - 高层 `Agent.continue()` 更常调用 `runAgentLoopContinue()`
 *
 * 我调用谁：
 * - `runAgentLoopContinue()` 负责真正执行循环
 * - `createAgentStream()` 把回调式 emit 包装成可遍历事件流
 *
 * 内部步骤：
 * 1. 前置校验：context 非空，且最后一条不是 assistant 消息
 * 2. 创建 `EventStream` 供 UI/外层编排消费
 * 3. 异步启动 `runAgentLoopContinue()`，不往 context 追加新消息
 * 4. 循环结束后调用 `stream.end()` 传递最终消息列表
 * 5. 立即返回 stream
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * agentLoop 的真正实现：把新 prompt 消息加入 context，然后启动主循环。
 *
 * 谁调用我：
 * - `agentLoop()` 通过 EventStream 间接调用
 *
 * 我调用谁：
 * - `emit()` 发射 agent_start / turn_start / message_start / message_end 事件
 * - `runLoop()` 执行真正的 agent 循环
 *
 * 内部步骤：
 * 1. 将 prompts 拷贝到 newMessages，同时追加到 context.messages
 * 2. 发射 `agent_start` 事件标记整个 agent 运行开始
 * 3. 发射 `turn_start` 事件标记第一轮开始
 * 4. 为每条 prompt 消息发射 message_start/message_end 事件
 * 5. 调用 `runLoop()` 进入主循环
 * 6. 返回本次 run 产生的所有新消息
 */
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * agentLoopContinue 的真正实现：从当前 context 继续，不添加新消息。
 *
 * 谁调用我：
 * - `agentLoopContinue()` 通过 EventStream 间接调用
 *
 * 我调用谁：
 * - `emit()` 发射 agent_start / turn_start 事件
 * - `runLoop()` 执行真正的 agent 循环
 *
 * 内部步骤：
 * 1. 前置校验：context 非空且最后一条不是 assistant 消息
 * 2. newMessages 初始化为空数组（本次不产生新的 prompt 消息）
 * 3. 发射 `agent_start` / `turn_start` 事件
 * 4. 调用 `runLoop()` 进入主循环
 * 5. 返回本次 run 产生的所有新消息（仅 assistant 回复和 tool 结果）
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/** 把低层事件流封装成 `EventStream<AgentEvent, AgentMessage[]>`，供 UI 或外层编排消费。 */
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * agentLoop 和 agentLoopContinue 共享的主循环逻辑。
 *
 * 这是 `packages/agent` 的主控制流：
 * - 外层 while: 处理“本来要停，但 follow-up 又来了”的情况
 * - 内层 while: 处理 assistant 回复、tool batch、steering 注入
 *
 * 谁调用我：
 * - `runAgentLoop()`
 * - `runAgentLoopContinue()`
 *
 * 我调用谁：
 * - `streamAssistantResponse()`
 * - `executeToolCalls()`
 * - `config.prepareNextTurn()` / `config.getSteeringMessages()` / `config.getFollowUpMessages()`
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// 先看是否已经有 steering 消息排队。
	// 这让 agent 在发出第一轮请求前，就能把“用户中途插话”合并进 transcript。
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// 外层 while 负责“agent 本来该停，但又收到了 follow-up”的情况。
	while (true) {
		let hasMoreToolCalls = true;

		// 内层 while 处理一条完整工作链：
		// 注入 pending 消息 -> 请求 assistant -> 执行 tool calls -> 决定是否继续本轮。
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			// 第一轮的 turn_start 在 runAgentLoop 已经发过了，这里要跳过，只有后续的 turn 才发
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// pending 消息会先落入 transcript，再去请求 assistant。
			// 这样模型能在“最新上下文”上继续推理。
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// 请求一轮 assistant 回复；这个函数内部会把流式事件翻译成 AgentEvent。
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			// error / aborted 都视为本次 run 到此结束，不再继续进入 tool 或 follow-up。
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// assistant 最终消息里若包含 toolCall block，就进入工具执行阶段。
			// filter 从助手消息的 content 数组中，取出 type 为 "toolCall" 的内容块组成新数组。
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// executeToolCalls 会自行决定串行还是并行，并返回本批工具结果。
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				// terminate=true 表示“这批工具已经明确要求对话在此终止”。
				hasMoreToolCalls = !executedToolBatch.terminate;

				// toolResult 也是 transcript 的一部分，必须追加到 context/newMessages，
				// 否则下一轮 assistant 将看不到工具返回。
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			// ========================
			// 轮次后处理阶段：prepareNextTurn + shouldStopAfterTurn
			// 这两个钩子在 turn_end 之后、下一轮 LLM 请求之前执行。
			// ========================

			// prepareNextTurn：允许上层在每轮结束后"改写"下一轮的运行参数。
			// 典型用途：
			// - AgentHarness 用它来刷新 session 写入、重建 turn state（可能切换模型）
			// - Agent 用它来透传用户传入的 prepareNextTurn 回调
			// 返回 undefined 表示不做任何修改，继续用当前配置。
			const nextTurnContext = {
				message,                    // 本轮的助手回复
				toolResults,                // 本轮的工具执行结果
				context: currentContext,     // 当前上下文（已追加本轮消息）
				newMessages,                // 本次 runAgentLoop 累计的新消息
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				// 如果钩子返回了新上下文，替换当前上下文
				currentContext = nextTurnSnapshot.context ?? currentContext;
				// 如果钩子返回了新模型或思考级别，合并到 config 中
				// 注意：thinkingLevel 需要转换为 reasoning 格式（"off" → undefined，其他值透传）
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			// shouldStopAfterTurn：最终的停机判断。
			// 与 prepareNextTurn 不同，这个钩子不能修改任何状态，只能决定"停还是不停"。
			// 返回 true → 发出 agent_end 事件，结束整个循环。
			// 返回 false/undefined → 继续下一轮（检查 steering/follow-up 消息）。
			// 典型用途：上下文即将超出容量时优雅退出。
			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 在每一轮末尾再轮询一次 steering，允许用户在流式输出或工具执行期间插话。
			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// 走到这里表示：没有更多 toolCall，且也没有 pending steering。
		// 这时 agent“理论上可以结束”，但还要检查 follow-up 队列。
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// follow-up 被重新塞进 pending，让内层循环按“用户新增消息”同样的路径处理。
			pendingMessages = followUpMessages;
			continue;
		}

		// 没有 follow-up，说明本次 agent run 真的结束了。
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 从 LLM 流式获取助手响应。
 * 这里是 AgentMessage[] 被转换为 LLM 兼容的 Message[] 的地方。
 *
 * 关键调用链：
 * - `runLoop()` 调这里发起一轮模型请求
 * - 这里调用 `transformContext()` / `convertToLlm()` 完成消息层转换
 * - 再调用传入的 `streamFn`（默认是 pi-ai 的 `streamSimple()`）
 * - 最后把 `AssistantMessageEvent` 翻译成 `AgentEvent`
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// transformContext 运行在 AgentMessage 层，适合做摘要、裁剪、注入系统约束等高层变换。
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// convertToLlm 是真正的边界转换：
	// 到这里才把 agent 内部 transcript 转成 provider 可接受的 Message[]。
	const llmMessages = await config.convertToLlm(messages);

	// `Context` 是 pi-ai 统一抽象层使用的输入格式。
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// 每次请求前动态解析 apiKey，而不是在 Agent 构造时缓存。
	// 这样可以兼容短期令牌、OAuth 刷新或外部密钥轮换。
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// 这里调用的默认是 pi-ai 的 `streamSimple()`，返回 `AssistantMessageEventStream`。
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false; // 状态标志，用来追踪是否已经将 partial message 添加到了 context.messages 中，避免重复添加

	// 消费 provider 的统一流式事件，并把它们重新翻译成 AgentEvent。
	for await (const event of response) {
		switch (event.type) {
			case "start":
				// `start` 提供一个可增量修改的 assistant message 雏形。
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true; // ← 标记已添加
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					// provider 每给出一个新的 partial，我们都用它替换 context 末尾的占位消息。
					// 这样外层看到的 transcript 始终接近“当前最新状态”。
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				// 不直接信任 event 自带的局部结果，而是统一通过 `response.result()`
				// 取到 provider 归并后的最终 AssistantMessage。
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	// 某些 provider 可能在 `for await` 自然结束后才让 `result()` 可用；
	// 这里做一次兜底，保证总能拿到最终消息。
	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * 执行助手消息中的工具调用。
 *
 * 决策职责只有一件事：本批工具调用走串行还是并行。
 * 真正执行分别落到 `executeToolCallsSequential()` / `executeToolCallsParallel()`。
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");

	// 检查本次批次中是否有任何工具在定义时标记为 executionMode === "sequential"。
	// 这是单工具级别的覆盖——即使全局配置为并行，只要有一个工具要求串行，整个批次就降级为串行。
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);

	// 执行模式判断：全局串行 或 任一工具要求串行 → 走串行路径，否则走并行路径。
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

/**
 * 工具调用的执行结果汇总类型。
 *
 * 谁使用我：
 * - `executeToolCallsSequential()` / `executeToolCallsParallel()` 返回此类型
 * - `runLoop()` 消费 `messages` 和 `terminate` 字段
 *
 * 字段说明：
 * - `messages`: 本批工具产生的 `ToolResultMessage[]`，会追加到 context 和 newMessages
 * - `terminate`: 若为 true，表示本批所有工具都要求终止，不再继续执行后续工具轮次
 */
type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

/**
 * 串行执行路径：逐个处理工具调用，一个完成后再执行下一个。
 *
 * 适用场景：
 * - 全局配置 `config.toolExecution === "sequential"`
 * - 批次中某个工具声明了 `executionMode === "sequential"`（单工具覆盖）
 *
 * 链路：
 * `runLoop()` -> `executeToolCalls()` -> 本函数
 * 对每个 toolCall 依次执行：
 *   emit(tool_execution_start) -> prepareToolCall() -> [executePreparedToolCall() ->
 *   finalizeExecutedToolCall()] -> emitToolExecutionEnd() -> emitToolResultMessage()
 */
async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// 收集器：存储每个工具的最终结果（含原始 toolCall + 执行结果 + isError 标记）
	// 用于最后调用 shouldTerminateToolBatch() 判断是否终止整个批次
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	// 收集器：存储转换后的 ToolResultMessage，返回给上层添加到上下文供下次 LLM 调用
	const messages: ToolResultMessage[] = [];

	// 串行遍历每个工具调用，for...of + await 保序：一个工具完全结束后才开始下一个
	for (const toolCall of toolCalls) {
		// 【步骤 1】立即发送 tool_execution_start 运行时事件
		// 目的：UI 立即显示"哪个工具开始执行了"，即使后续 prepare 失败用户也能看到
		// 这是运行时事件，不进入上下文，仅用于 UI 消费
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,   // LLM 生成的工具调用唯一 ID（如 "call_abc123"）
			toolName: toolCall.name,   // 工具名称（如 "read_file"、"bash"）
			args: toolCall.arguments,  // 工具参数，已经是解析后的对象（非 JSON 字符串）
		});

		// 【步骤 2】准备阶段：查找工具定义、参数预处理、schema 校验、执行 before hook、检查 abort
		// 返回值 preparation 有两种 kind：
		//   "immediate" → 不需要真正执行，直接返回结果（工具不存在/参数无效/hook 阻断）
		//   "prepared"  → 准备完成，包含解析后的工具定义和参数，可进入 execute
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			// 【步骤 2a】immediate 分支——跳过 execute，直接组装最终结果
			// 典型场景：工具名在上下文中找不到、参数不合法、before hook 返回了阻断值
			finalized = {
				toolCall,                    // 保留原始 toolCall 信息（id、name、arguments）
				result: preparation.result,  // 准备阶段生成的结果（通常是错误提示文本）
				isError: preparation.isError, // 标记为错误结果
			};
		} else {
			// 【步骤 2b】prepared 分支——真正执行工具
			// executePreparedToolCall：调用工具的 execute 函数，拿到原始执行结果
			const executed = await executePreparedToolCall(preparation, signal, emit);
			// 【步骤 3】finalize 阶段：执行 after hook（可修改/增强结果），生成最终 FinalizedToolCallOutcome
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		// 【步骤 4】发送 tool_execution_end 运行时事件（不进入上下文，仅用于 UI 显示执行完成、耗时等）
		await emitToolExecutionEnd(finalized, emit);

		// 【步骤 5】将结果转为 ToolResultMessage 并通过 emit 发送
		// 与上面的 end 事件分开的原因：
		//   - tool_execution_end 是 UI 消费的运行时事件
		//   - ToolResultMessage 是 LLM 消费的 transcript 持久消息，会进入上下文
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);

		// 【步骤 6】将结果推入两个收集器
		finalizedCalls.push(finalized);    // 用于 shouldTerminateToolBatch 判断是否终止
		messages.push(toolResultMessage);  // 用于返回给上层添加到 context

		// 【步骤 7】检查 abort 信号——用户取消时立即跳出循环，不再执行后续工具
		// signal?.aborted 使用可选链：signal 可能是 undefined（未传入），安全访问
		if (signal?.aborted) {
			break;
		}
	}

	// 【返回】
	// messages: 所有工具的 ToolResultMessage 数组（追加到 context 和 newMessages，供下次 LLM 调用）
	// terminate: 是否应终止整个工具批次（由 shouldTerminateToolBatch 根据 finalizedCalls 判断）
	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

/**
 * 并行执行路径：先串行做 preflight，再并发执行允许并行的工具。
 *
 * 这样设计的原因：
 * - `prepareToolCall()` 里可能有校验、hook、阻断逻辑，适合按 assistant 输出顺序稳定执行
 * - 真正 `execute()` 时则尽量并行提高吞吐
 */
async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		// 即使准备走并行执行，也先按 assistant 原始顺序发 start 事件。
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		// 这里只是把“真正执行工具”的 thunk 暂存起来，后面统一 `Promise.all` 并发跑。
		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	// 保持结果数组顺序与原始 toolCalls 顺序一致，避免 UI / transcript 乱序。
	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

/**
 * prepareToolCall 的成功返回类型：工具已找到、参数已校验、before hook 已通过。
 *
 * 谁产生我：`prepareToolCall()` 在所有检查通过后返回
 * 谁消费我：`executePreparedToolCall()` 和 `finalizeExecutedToolCall()` 接收此类型
 *
 * 字段说明：
 * - `kind`: 标记为 "prepared"，与 ImmediateToolCallOutcome 做区分
 * - `toolCall`: 原始工具调用请求
 * - `tool`: 在 context 中找到的工具定义
 * - `args`: 经过 prepareArguments + validate 后的最终参数
 */
type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

/**
 * prepareToolCall 的"短路"返回类型：不需要真正执行工具。
 *
 * 触发场景：
 * - 工具未找到（tool === undefined）
 * - 参数校验失败（validateToolArguments 抛错）
 * - beforeToolCall hook 返回 block=true
 * - AbortSignal 已触发
 *
 * 谁产生我：`prepareToolCall()` 在各种错误/阻断路径中返回
 * 谁消费我：串行/并行路径直接将其转为 `FinalizedToolCallOutcome`
 */
type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

/**
 * 工具真正执行后的结果类型（execute 阶段产出）。
 *
 * 谁产生我：`executePreparedToolCall()` 在 tool.execute() 完成后返回
 * 谁消费我：`finalizeExecutedToolCall()` 接收此类型，再经过 afterToolCall hook 得到最终结果
 *
 * 与 FinalizedToolCallOutcome 的区别：
 * - 此类型不含 toolCall 字段（执行阶段不关心原始请求）
 * - FinalizedToolCallOutcome 是最终版本，包含 toolCall 且经过 afterToolCall 改写
 */
type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

/**
 * 工具执行的最终结果类型：包含原始 toolCall 引用，可用于构造 ToolResultMessage。
 *
 * 谁产生我：
 * - `finalizeExecutedToolCall()` 从 ExecutedToolCallOutcome 转换而来
 * - 串行/并行路径中 immediate 分支直接构造
 *
 * 谁消费我：
 * - `emitToolExecutionEnd()` 发射 tool_execution_end 事件
 * - `createToolResultMessage()` 构造标准 ToolResultMessage
 * - `shouldTerminateToolBatch()` 判断是否终止本轮工具批次
 */
type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

/**
 * 并行执行路径的中间类型：可以是已完成的结果，也可以是尚未执行的 thunk。
 *
 * 为什么需要这个类型：
 * - `executeToolCallsParallel()` 在 prepare 阶段按顺序处理每个 toolCall
 * - immediate 结果直接存为 FinalizedToolCallOutcome
 * - 需要真正执行的工具存为 async thunk，稍后通过 `Promise.all` 并发执行
 * - 最终通过 `typeof === "function"` 区分两者
 *
 * 谁产生我：`executeToolCallsParallel()` 的 prepare 循环
 * 谁消费我：`executeToolCallsParallel()` 内部的 `Promise.all` 展开
 */
type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/**
 * 判断本批工具调用是否全部要求终止对话。
 *
 * 谁调用我：
 * - `executeToolCallsSequential()`
 * - `executeToolCallsParallel()`
 *
 * 逻辑：
 * - 空批次（无 finalized 调用）返回 false，不影响后续流程
 * - 非空批次中，只有当每一个工具的 result.terminate 都为 true 时才返回 true
 * - 任一工具未设置 terminate，则本批不终止，内层循环继续下一轮 assistant 请求
 */
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

/**
 * 工具参数预处理：调用工具自定义的 prepareArguments 钩子。
 *
 * 谁调用我：
 * - `prepareToolCall()` 在查找工具定义之后、校验参数之前调用
 *
 * 我调用谁：
 * - `tool.prepareArguments()`（如果工具定义了此方法）
 *
 * 逻辑：
 * 1. 若工具未定义 prepareArguments，直接返回原始 toolCall
 * 2. 调用 prepareArguments，若返回值与原参数引用相同，也直接返回
 * 3. 否则构造新的 toolCall 对象，替换 arguments 字段
 *
 * 典型用途：工具可以用此钩子做参数归一化、默认值填充、敏感字段脱敏等轻量变换。
 */
function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

/**
 * 单个工具调用的 preflight 阶段。
 *
 * 谁调用我：
 * - `executeToolCallsSequential()`
 * - `executeToolCallsParallel()`
 *
 * 我调用谁：
 * - `prepareToolCallArguments()`
 * - `validateToolArguments()`
 * - `config.beforeToolCall()`
 *
 * 返回值要么是：
 * - `prepared`：允许后续真正执行
 * - `immediate`：直接生成错误结果或被阻断结果，不再执行工具
 */
async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	// 第一步：按名字在当前上下文里查找工具定义。
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		// 第二步：如果工具提供了 prepareArguments，就先做一次轻量预处理。
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		// 第三步：用 pi-ai 的统一校验器确保 toolCall 参数符合 schema。
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			// 第四步：执行 before hook，让上层有机会阻断、审计或改写行为。
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			// 第五步：全部通过后，才进入真正的工具执行阶段。
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/** 真正调用工具的 `execute()`，同时把工具侧的增量更新翻译成 `tool_execution_update` 事件。 */
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	// 工具 execute() 可以多次回调 partialResult；这些更新事件需要先缓存再统一 await，
	// 以免工具返回比 UI 订阅者处理得更快时出现“遗漏更新”。
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				// 这里把工具侧的 partialResult 翻译成统一的 `tool_execution_update` 事件。
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		// 等所有 update 事件都被订阅者处理后，再认为该工具真正完成。
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		// 即使工具抛错，也先等待已发出的增量更新处理完，再生成错误结果。
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/** 工具执行后置阶段：允许 `afterToolCall()` 改写结果、错误标记和 terminate 提示。 */
async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

/**
 * 统一构造错误工具结果，避免每条错误路径重复拼装内容。
 *
 * 谁调用我：
 * - `prepareToolCall()` 在工具未找到、参数校验失败、before hook 阻断、abort 等场景
 * - `executePreparedToolCall()` 在 tool.execute() 抛错时
 * - `finalizeExecutedToolCall()` 在 afterToolCall hook 抛错时
 *
 * 输出格式：固定为 `{ type: "text", text: message }` 的 content 数组，details 为空对象。
 */
function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

/**
 * 发射 tool_execution_end 事件，标记单个工具执行完成。
 *
 * 谁调用我：
 * - `executeToolCallsSequential()` 在每个工具执行完毕后
 * - `executeToolCallsParallel()` 在每个工具执行完毕后（含 immediate 和 thunk 展开后）
 *
 * 事件包含：toolCallId、toolName、result、isError。
 * 与 emitToolResultMessage 分开处理：前者是运行时事件（UI 监听），后者是 transcript 消息（prompt 可见）。
 */
async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

/**
 * 把最终工具执行结果封装成标准 `toolResult` transcript 消息。
 *
 * 谁调用我：
 * - `executeToolCallsSequential()` 在每个工具的 finalized 结果产出后
 * - `executeToolCallsParallel()` 在 Promise.all 展开后按序调用
 *
 * 我调用谁：无（纯数据转换）
 *
 * 产出的 ToolResultMessage 会被追加到：
 * - context.messages（供下一轮 assistant 看到工具返回）
 * - newMessages（供外层获取本次 run 的完整消息列表）
 *
 * 字段映射：
 * - role: 固定为 "toolResult"
 * - toolCallId/toolName: 来自 finalized.toolCall
 * - content/details/isError: 来自 finalized.result
 * - timestamp: 当前时间戳，用于排序和调试
 */
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

/**
 * 为 toolResult 消息发射 message_start/message_end 事件对。
 *
 * 谁调用我：
 * - `executeToolCallsSequential()` 在 createToolResultMessage 之后
 * - `executeToolCallsParallel()` 在 createToolResultMessage 之后
 *
 * 我调用谁：`emit()` 发射两个事件
 *
 * 为什么 toolResult 也用 message_start/message_end：
 * - toolResult 也是 transcript 的一部分，和 assistant/user 消息一样需要被 UI 感知
 * - 统一使用 message_start/message_end 事件对，便于 UI 层用同一套逻辑渲染所有消息类型
 */
async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
