/**
 * @file RPC 客户端，用于编程方式访问 coding agent。
 *
 * @module rpc/rpc-client
 *
 * @description
 * **文件定位**：RPC 模式的客户端实现，提供类型化的编程接口来操控 agent 子进程。
 *
 * **在调用链中的位置**：
 * - 上游调用方：任何需要以编程方式驱动 agent 的消费者（测试、外部集成、扩展 UI 宿主等）。
 * - 下游依赖：`./jsonl.ts`（JSONL 序列化/反序列化）、`./rpc-types.ts`（协议类型定义）。
 * - 本模块作为子进程启动 `rpc-mode.ts` 中的 `runRpcMode()` 函数，通过 stdin/stdout 与之通信。
 *
 * **提供的能力**：
 * - `RpcClient` 类：封装了与 agent RPC 子进程的所有通信，提供完整会话生命周期管理。
 *   - 启动/停止子进程：`start()` / `stop()`
 *   - 消息发送：`prompt()` / `steer()` / `followUp()` / `abort()`
 *   - 状态和模型控制：`getState()` / `setModel()` / `cycleModel()`
 *   - 等待和事件收集：`waitForIdle()` / `collectEvents()` / `promptAndWait()`
 *   - 会话管理：`newSession()` / `switchSession()` / `fork()` / `clone()`
 *
 * **与其他文件的关系**：
 * - 导入 `./jsonl.ts` 的 `serializeJsonLine` 将命令序列化写入子进程 stdin。
 * - 导入 `./jsonl.ts` 的 `attachJsonlLineReader` 从子进程 stdout 读取 JSONL 响应。
 * - 导入 `./rpc-types.ts` 的类型定义，确保命令/响应的类型安全。
 *
 * **通信协议**：
 * - 客户端通过 stdin 发送 JSONL 格式的命令（`RpcCommand`）。
 * - 服务端通过 stdout 返回 JSONL 格式的响应（`RpcResponse`）和事件（`AgentEvent`）。
 * - 每个命令携带递增的 `id`（如 `req_1`、`req_2`），响应回传相同 `id` 以关联请求。
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 分布式 Omit 工具类型，适用于联合类型。
 *
 * 与普通 `Omit` 不同，`DistributiveOmit` 对联合类型的每个成员分别应用 `Omit`，
 * 结果仍然是联合类型，而非将联合类型展平为一个对象。
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** 从 RpcCommand 中移除 `id` 字段后的命令体类型，用于内部 `send()` 方法 */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

/**
 * RPC 客户端的配置选项。
 *
 * 用于指定 agent 子进程的启动参数，包括 CLI 路径、工作目录、环境变量、模型等。
 */
export interface RpcClientOptions {
	/** CLI 入口文件路径（默认搜索 dist/cli.js） */
	cliPath?: string;
	/** agent 的工作目录 */
	cwd?: string;
	/** 环境变量，会与当前进程环境变量合并（本对象中的值优先） */
	env?: Record<string, string>;
	/** 使用的 AI 提供商名称 */
	provider?: string;
	/** 使用的模型 ID */
	model?: string;
	/** 传递给 CLI 的额外命令行参数 */
	args?: string[];
}

/**
 * 模型信息描述接口。
 *
 * 由 `getAvailableModels()` 方法返回，描述一个可用的 AI 模型。
 */
export interface ModelInfo {
	/** 提供商名称（如 "openai"、"anthropic"） */
	provider: string;
	/** 模型 ID（如 "gpt-4o"、"claude-3-opus"） */
	id: string;
	/** 上下文窗口大小（token 数） */
	contextWindow: number;
	/** 是否支持推理/思考能力 */
	reasoning: boolean;
}

/**
 * RPC 事件监听器类型。
 *
 * 接收 `AgentEvent` 事件对象，用于监听 agent 的实时事件流。
 * 通过 `RpcClient.onEvent()` 注册。
 */
export type RpcEventListener = (event: AgentEvent) => void;

// ============================================================================
// RPC 客户端类
// ============================================================================

/**
 * RPC 客户端类，用于以编程方式访问 coding agent。
 *
 * 通过 `spawn` 启动 agent 的 RPC 模式子进程，然后通过 JSONL stdin/stdout 协议
 * 与子进程通信。所有操作都是异步的，支持请求-响应关联和事件流。
 *
 * **典型使用流程**：
 * 1. 创建实例：`const client = new RpcClient({ ... })`
 * 2. 启动子进程：`await client.start()`
 * 3. 发送命令：`await client.prompt("...")` / `await client.getState()` 等
 * 4. 监听事件：`client.onEvent((event) => { ... })`
 * 5. 等待完成：`await client.waitForIdle()`
 * 6. 停止：`await client.stop()`
 *
 * **调用关系**：
 * - 被外部消费者（测试、集成代码、扩展 UI 宿主）直接实例化和调用。
 * - 调用 `./jsonl.ts` 的 `serializeJsonLine()` 和 `attachJsonlLineReader()` 进行通信。
 * - 子进程运行 `rpc-mode.ts` 中的 `runRpcMode()` 函数。
 */
export class RpcClient {
	/** 子进程引用，启动前为 null，停止后重置为 null */
	private process: ChildProcess | null = null;
	/** 停止 stdout 读取的解除函数 */
	private stopReadingStdout: (() => void) | null = null;
	/** 事件监听器列表，通过 onEvent() 注册 */
	private eventListeners: RpcEventListener[] = [];
	/** 等待响应的待处理请求映射表，键为请求 id（如 "req_1"） */
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	/** 请求 ID 计数器，每次发送命令自增 */
	private requestId = 0;
	/** 子进程 stderr 输出的累积内容，用于错误诊断 */
	private stderr = "";
	/** 子进程退出时的错误对象，用于后续命令快速失败 */
	private exitError: Error | null = null;
	/** 客户端配置选项 */
	private options: RpcClientOptions;

	/**
	 * 创建 RPC 客户端实例。
	 *
	 * @param options - 配置选项，包括 CLI 路径、工作目录、环境变量、模型等
	 */
	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/**
	 * 启动 agent RPC 子进程。
	 *
	 * 通过 `spawn` 生成一个运行 `node <cliPath> --mode rpc` 的子进程，
	 * 设置 JSONL 读取器监听 stdout 输出，并注册 stderr/error/exit 处理器。
	 * 启动后等待 100ms 检查子进程是否立即退出。
	 *
	 * **被谁调用**：外部消费者在创建 `RpcClient` 实例后调用。
	 * **调用了谁**：`attachJsonlLineReader()`（设置 stdout 读取）。
	 *
	 * @throws 如果客户端已经启动过，抛出错误
	 * @throws 如果子进程在初始化期间退出，抛出错误
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		// 重置退出错误状态
		this.exitError = null;

		// 构建子进程命令行参数
		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		// 启动子进程，使用 pipe 模式的 stdin/stdout/stderr 以便程序化读写
		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		// 收集 stderr 输出用于调试诊断，同时转发到当前进程的 stderr
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		// 注册子进程退出处理器：设置退出错误并拒绝所有待处理请求
		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		// 注册子进程错误处理器（如进程启动失败）
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		// 注册 stdin 写入错误处理器
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// 为子进程 stdout 设置严格 JSONL 读取器，每收到一行交给 handleLine 处理
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		// 等待 100ms 让子进程完成初始化
		await new Promise((resolve) => setTimeout(resolve, 100));

		// 检查子进程是否在初始化期间就已退出
		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	/**
	 * 停止 agent RPC 子进程。
	 *
	 * 先移除 stdout 读取器，然后发送 SIGTERM 信号。如果子进程在 1 秒内未退出，
	 * 则发送 SIGKILL 强制终止。最后清理内部状态。
	 *
	 * **被谁调用**：外部消费者在使用完毕后调用。
	 * **调用了谁**：无。
	 *
	 * @returns Promise，在子进程退出后解决
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		// 移除 stdout 读取器
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		// 发送 SIGTERM 信号请求子进程优雅退出
		this.process.kill("SIGTERM");

		// 等待子进程退出，最多 1 秒后强制 SIGKILL
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		// 清理内部状态
		this.process = null;
		this.pendingRequests.clear();
	}

	/**
	 * 订阅 agent 事件流。
	 *
	 * 注册一个监听器，在 agent 发出事件（如流式消息、状态变化等）时被调用。
	 * 返回一个解除订阅的函数，调用后移除该监听器。
	 *
	 * **被谁调用**：外部消费者在需要监听实时事件时调用。
	 * **调用了谁**：无。
	 *
	 * @param listener - 事件监听器回调函数
	 * @returns 解除订阅函数，调用后移除该监听器
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * 获取子进程 stderr 累积输出内容。
	 *
	 * 用于调试和错误诊断，包含子进程启动以来的所有 stderr 输出。
	 *
	 * **被谁调用**：外部消费者在需要诊断问题时调用。
	 *
	 * @returns stderr 输出内容字符串
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// 命令方法
	// =========================================================================

	/**
	 * 向 agent 发送提示消息。
	 *
	 * 发送后立即返回，不会等待 agent 处理完成。使用 `onEvent()` 监听流式事件，
	 * 使用 `waitForIdle()` 等待处理完成。
	 *
	 * **被谁调用**：外部消费者在需要向 agent 提问时调用。
	 * **调用了谁**：`send()`（发送命令到子进程）。
	 *
	 * @param message - 提示消息文本
	 * @param images - 可选的图片内容数组
	 * @returns Promise，在命令发送成功后解决
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * 发送引导消息，在 agent 运行中途中断并注入新指令。
	 *
	 * 引导消息会排队等待，在 agent 当前处理完成后被处理。
	 *
	 * **被谁调用**：外部消费者在需要中途调整 agent 行为时调用。
	 * **调用了谁**：`send()`。
	 *
	 * @param message - 引导消息文本
	 * @param images - 可选的图片内容数组
	 * @returns Promise，在命令发送成功后解决
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * 发送后续消息，在 agent 完成当前任务后处理。
	 *
	 * 与 `steer()` 不同，后续消息在 agent 完全空闲后才被处理，不会中断当前操作。
	 *
	 * **被谁调用**：外部消费者在需要追加问题时调用。
	 * **调用了谁**：`send()`。
	 *
	 * @param message - 后续消息文本
	 * @param images - 可选的图片内容数组
	 * @returns Promise，在命令发送成功后解决
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * 中止当前正在执行的操作。
	 *
	 * **被谁调用**：外部消费者在需要紧急停止 agent 时调用。
	 * **调用了谁**：`send()`。
	 *
	 * @returns Promise，在命令发送成功后解决
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * 创建新会话，可选地关联父会话用于追踪来源。
	 *
	 * **被谁调用**：外部消费者在需要重新开始对话时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @param parentSession - 可选的父会话路径，用于会话来源追踪
	 * @returns 包含 `cancelled` 字段的对象，如果扩展取消了新会话则为 `true`
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * 获取当前会话的完整状态快照。
	 *
	 * 返回的 `RpcSessionState` 包含当前模型、思考级别、流式状态、会话标识等信息。
	 *
	 * **被谁调用**：外部消费者在需要查询会话状态时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 当前会话状态对象
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * 按提供商和 ID 设置模型。
	 *
	 * **被谁调用**：外部消费者在需要切换模型时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @param provider - 提供商名称（如 "openai"）
	 * @param modelId - 模型 ID（如 "gpt-4o"）
	 * @returns 包含设置后模型信息的对象
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * 切换到下一个可用模型。
	 *
	 * 循环遍历可用模型列表，如果已经是最后一个则回到第一个。
	 *
	 * **被谁调用**：外部消费者在需要快速切换模型时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 切换后的模型和思考级别信息，如果没有可用模型则返回 `null`
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * 获取所有可用模型列表。
	 *
	 * **被谁调用**：外部消费者在需要显示模型选择列表时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 可用模型信息数组
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * 设置思考级别。
	 *
	 * 控制 agent 的推理深度（如 none、low、medium、high）。
	 *
	 * **被谁调用**：外部消费者在需要调整推理深度时调用。
	 * **调用了谁**：`send()`。
	 *
	 * @param level - 目标思考级别
	 * @returns Promise，在命令发送成功后解决
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * 切换到下一个思考级别。
	 *
	 * **被谁调用**：外部消费者在需要快速切换思考级别时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 切换后的级别信息，如果没有可切换级别则返回 `null`
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * 设置引导模式。
	 *
	 * "all" 模式下所有引导消息同时处理；"one-at-a-time" 模式下逐条处理。
	 *
	 * **被谁调用**：外部消费者调用。
	 * **调用了谁**：`send()`。
	 *
	 * @param mode - 引导模式
	 * @returns Promise，在命令发送成功后解决
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * 设置后续消息模式。
	 *
	 * "all" 模式下所有后续消息同时处理；"one-at-a-time" 模式下逐条处理。
	 *
	 * **被谁调用**：外部消费者调用。
	 * **调用了谁**：`send()`。
	 *
	 * @param mode - 后续消息模式
	 * @returns Promise，在命令发送成功后解决
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * 执行上下文压缩，减少会话历史的 token 占用。
	 *
	 * 可选地提供自定义指令来指导压缩过程。
	 *
	 * **被谁调用**：外部消费者在会话过长需要压缩时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @param customInstructions - 可选的自定义压缩指令
	 * @returns 压缩结果对象
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * 启用或禁用自动上下文压缩。
	 *
	 * 启用后，当上下文接近模型限制时会自动触发压缩。
	 *
	 * **被谁调用**：外部消费者调用。
	 * **调用了谁**：`send()`。
	 *
	 * @param enabled - 是否启用自动压缩
	 * @returns Promise，在命令发送成功后解决
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * 启用或禁用自动重试。
	 *
	 * 启用后，当 API 调用失败时会自动重试。
	 *
	 * **被谁调用**：外部消费者调用。
	 * **调用了谁**：`send()`。
	 *
	 * @param enabled - 是否启用自动重试
	 * @returns Promise，在命令发送成功后解决
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * 中止正在进行的重试操作。
	 *
	 * **被谁调用**：外部消费者在需要取消正在进行的重试时调用。
	 * **调用了谁**：`send()`。
	 *
	 * @returns Promise，在命令发送成功后解决
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * 执行 bash 命令。
	 *
	 * 通过 agent 会话执行 bash 命令，返回执行结果。
	 *
	 * **被谁调用**：外部消费者在需要执行 shell 命令时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @param command - 要执行的 bash 命令
	 * @returns bash 执行结果对象
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * 中止正在运行的 bash 命令。
	 *
	 * **被谁调用**：外部消费者在需要终止长时间运行的 bash 命令时调用。
	 * **调用了谁**：`send()`。
	 *
	 * @returns Promise，在命令发送成功后解决
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * 获取会话统计信息（如 token 用量、成本等）。
	 *
	 * **被谁调用**：外部消费者在需要查看会话消耗时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 会话统计数据对象
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * 将会话导出为 HTML 文件。
	 *
	 * **被谁调用**：外部消费者在需要导出会话记录时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @param outputPath - 可选的输出文件路径
	 * @returns 包含导出文件路径的对象
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * 切换到不同的会话文件。
	 *
	 * **被谁调用**：外部消费者在需要切换到其他会话时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @param sessionPath - 目标会话文件路径
	 * @returns 包含 `cancelled` 字段的对象，如果扩展取消了切换则为 `true`
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * 从指定消息处分叉会话，创建一个新的分支。
	 *
	 * **被谁调用**：外部消费者在需要从历史消息创建新分支时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @param entryId - 分叉起点的消息 ID
	 * @returns 包含消息文本和取消状态的对象
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * 克隆当前活跃分支到新会话。
	 *
	 * **被谁调用**：外部消费者在需要复制当前会话时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 包含 `cancelled` 字段的对象，如果扩展取消了克隆则为 `true`
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * 获取可用于分叉的消息列表。
	 *
	 * 返回会话中所有用户消息，供客户端展示分叉点选择。
	 *
	 * **被谁调用**：外部消费者在需要显示分叉选项时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 包含 entryId 和消息文本的数组
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * 获取最后一条助手消息的文本内容。
	 *
	 * **被谁调用**：外部消费者在需要获取 agent 最新回复时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 最后一条助手消息的文本，如果没有则返回 `null`
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * 设置会话显示名称。
	 *
	 * **被谁调用**：外部消费者在需要给会话命名时调用。
	 * **调用了谁**：`send()`。
	 *
	 * @param name - 会话名称
	 * @returns Promise，在命令发送成功后解决
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * 获取会话中的所有消息。
	 *
	 * **被谁调用**：外部消费者在需要获取完整对话历史时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 消息对象数组
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * 获取可用命令列表（扩展命令、prompt 模板、技能）。
	 *
	 * **被谁调用**：外部消费者在需要显示命令补全列表时调用。
	 * **调用了谁**：`send()`、`getData()`。
	 *
	 * @returns 可用斜杠命令描述数组
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// 辅助方法
	// =========================================================================

	/**
	 * 等待 agent 变为空闲状态（无流式输出）。
	 *
	 * 监听事件流，当收到 `agent_end` 事件时解决 Promise。如果超过指定
	 * 超时时间仍未收到，则抛出超时错误。
	 *
	 * **被谁调用**：外部消费者在发送 prompt 后等待 agent 处理完成时调用。
	 * **调用了谁**：`onEvent()`。
	 *
	 * @param timeout - 超时时间（毫秒），默认 60000
	 * @returns Promise，在 agent 完成处理后解决
	 * @throws 超时后抛出错误
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			// 设置超时定时器
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			// 监听事件，等待 agent_end 事件
			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * 收集事件直到 agent 变为空闲状态。
	 *
	 * 与 `waitForIdle()` 类似，但会累积所有收到的事件并以数组形式返回。
	 *
	 * **被谁调用**：外部消费者在需要获取完整事件流时调用。
	 * **调用了谁**：`onEvent()`。
	 *
	 * @param timeout - 超时时间（毫秒），默认 60000
	 * @returns Promise，在 agent 完成处理后解决，值为事件数组
	 * @throws 超时后抛出错误
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		return new Promise((resolve, reject) => {
			const events: AgentEvent[] = [];
			// 设置超时定时器
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			// 监听事件，累积到数组中，直到收到 agent_end
			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * 发送提示并等待处理完成，返回所有事件。
	 *
	 * 这是 `prompt()` + `collectEvents()` 的便捷组合方法。
	 * 先注册事件收集器，再发送 prompt，最后等待 agent_end。
	 *
	 * **被谁调用**：外部消费者在需要一步完成"提问并等待回答"时调用。
	 * **调用了谁**：`collectEvents()`、`prompt()`。
	 *
	 * @param message - 提示消息文本
	 * @param images - 可选的图片内容数组
	 * @param timeout - 超时时间（毫秒），默认 60000
	 * @returns Promise，在 agent 完成处理后解决，值为事件数组
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		// 先注册事件收集器（必须在 prompt 之前，否则会丢失初始事件）
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// 内部方法
	// =========================================================================

	/**
	 * 处理从子进程 stdout 收到的一行 JSONL 数据。
	 *
	 * 解析 JSON 后判断数据类型：
	 * - 如果是响应（`type === "response"`）且有匹配的待处理请求 id，则解决对应的 Promise。
	 * - 否则视为事件，分发给所有注册的事件监听器。
	 *
	 * **被谁调用**：由 `attachJsonlLineReader()` 的回调触发。
	 * **调用了谁**：事件监听器（通过 `eventListeners` 数组）。
	 *
	 * @param line - JSONL 行内容（不含行终止符）
	 */
	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// 如果是响应且有匹配的待处理请求 id，解决对应的 Promise
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// 否则视为事件，分发给所有事件监听器
			for (const listener of this.eventListeners) {
				listener(data as AgentEvent);
			}
		} catch {
			// 忽略无法解析的非 JSON 行
		}
	}

	/**
	 * 创建子进程退出错误对象。
	 *
	 * 包含退出码、信号和 stderr 内容，用于调试诊断。
	 *
	 * **被谁调用**：`start()` 中的退出/错误处理器。
	 *
	 * @param code - 进程退出码
	 * @param signal - 终止信号
	 * @returns 格式化的错误对象
	 */
	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	/**
	 * 拒绝所有待处理的请求。
	 *
	 * 在子进程异常退出时调用，确保所有等待响应的 Promise 都会被 reject。
	 *
	 * **被谁调用**：`start()` 中的退出/错误处理器。
	 *
	 * @param error - 要传递给每个待处理请求的错误对象
	 */
	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	/**
	 * 向子进程发送 RPC 命令并等待响应。
	 *
	 * 核心发送方法。为命令分配自增 id，序列化为 JSONL 后写入子进程 stdin，
	 * 然后创建 Promise 等待匹配的响应。包含 30 秒超时保护。
	 *
	 * **调用流程**：
	 * 1. 检查子进程状态（是否已启动、是否已退出、stdin 是否可写）。
	 * 2. 生成递增的请求 id（`req_1`、`req_2`、...）。
	 * 3. 将命令序列化为 JSONL 并写入 stdin。
	 * 4. 注册待处理请求，等待 `handleLine()` 匹配响应。
	 * 5. 30 秒超时后自动 reject。
	 *
	 * **被谁调用**：所有公共命令方法（`prompt()`、`getState()` 等）。
	 * **调用了谁**：`serializeJsonLine()`（序列化命令）。
	 *
	 * @param command - 不含 id 的命令体
	 * @returns Promise，解析为对应的 RpcResponse
	 * @throws 如果客户端未启动、子进程已退出或 stdin 不可写
	 * @throws 30 秒超时后抛出错误
	 */
	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		// 检查子进程是否已启动
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		// 如果之前已记录退出错误，直接抛出（快速失败）
		if (this.exitError) {
			throw this.exitError;
		}
		// 检查子进程是否已退出
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		// 检查 stdin 是否可写
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}

		// 生成递增的请求 id
		const id = `req_${++this.requestId}`;
		// 将 id 注入命令体
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			// 30 秒超时保护，防止无限等待
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);

			// 注册待处理请求，等待 handleLine() 匹配响应
			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			try {
				// 将命令序列化为 JSONL 并写入子进程 stdin
				stdin.write(serializeJsonLine(fullCommand));
			} catch (error: unknown) {
				// 写入失败时清理待处理请求并 reject
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError);
			}
		});
	}

	/**
	 * 从成功的响应中提取 data 字段。
	 *
	 * 如果响应失败（`success === false`），则抛出包含错误信息的 Error。
	 * 如果响应成功，返回 `data` 字段并断言为类型 T。
	 *
	 * **被谁调用**：所有需要提取响应数据的公共命令方法。
	 *
	 * @typeParam T - 期望的 data 字段类型
	 * @param response - RPC 响应对象
	 * @returns 响应的 data 字段
	 * @throws 如果响应失败，抛出包含 error 信息的错误
	 */
	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// 类型断言：信任 response.data 与 T 匹配，因为每个公共方法都为其命令指定了正确的 T
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
