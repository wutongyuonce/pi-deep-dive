/**
 * @file RPC 模式的实现 -- 无头操作模式，通过 JSON stdin/stdout 协议通信。
 *
 * @module rpc/rpc-mode
 *
 * @description
 * **文件定位**：RPC 模式的主入口模块，实现了 agent 的无头（headless）操作模式。
 *
 * **在调用链中的位置**：
 * - 上游调用方：`../cli.ts` 在 `mode="rpc"` 时调用 `runRpcMode()` 函数。
 * - 下游依赖：`./jsonl.ts`（JSONL 序列化）、`./rpc-types.ts`（类型定义）、`../../core/agent-session-runtime.ts`（会话运行时）。
 *
 * **提供的能力**：
 * - `runRpcMode()`：RPC 模式的主入口函数，启动 JSONL stdin/stdout 命令循环。
 * - `handleCommand()`：命令分发处理函数，处理各种命令类型（prompt、steer、abort、get_state 等）。
 * - `createExtensionUIContext()`：创建扩展 UI 上下文，将 UI 交互请求通过 RPC 协议转发给客户端。
 *
 * **与其他文件的关系**：
 * - 导入 `./jsonl.ts` 的 `serializeJsonLine` 和 `attachJsonlLineReader` 进行 JSONL 读写。
 * - 导入 `./rpc-types.ts` 的类型定义，确保协议一致性。
 * - 导入 `../../core/output-guard.ts` 进行 stdout 输出保护和背压控制。
 * - 被 `rpc-client.ts` 作为子进程启动，通过 stdin/stdout 与之通信。
 *
 * **协议说明**：
 * - 命令：JSON 对象，包含 `type` 字段和可选的 `id` 字段（用于请求-响应关联）。
 * - 响应：JSON 对象，包含 `type: "response"`、`command`、`success` 和可选的 `data`/`error`。
 * - 事件：`AgentSessionEvent` 对象，在发生时实时流式输出。
 * - 扩展 UI：扩展 UI 请求通过 stdout 发出，客户端通过 `extension_ui_response` 回复。
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

// 重新导出类型，供消费者直接从本模块导入
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * 以 RPC 模式运行 agent。
 *
 * 监听 stdin 上的 JSON 命令，将事件和响应输出到 stdout。
 * 此函数永远不会返回（返回类型为 `Promise<never>`），通过保持 Promise 不解决来维持进程运行。
 *
 * **被谁调用**：`../cli.ts` 在检测到 `mode="rpc"` 命令行参数时调用。
 *
 * **调用了谁**：
 * - `takeOverStdout()` / `writeRawStdout()`：接管 stdout 输出。
 * - `attachJsonlLineReader()`：附加 JSONL 读取器到 stdin。
 * - `handleCommand()`：处理每个收到的命令。
 * - `createExtensionUIContext()`：创建扩展 UI 上下文。
 * - `rebindSession()`：绑定/重新绑定会话。
 * - `registerSignalHandlers()`：注册信号处理器。
 * - `shutdown()`：优雅关闭。
 *
 * @param runtimeHost - agent 会话运行时宿主，提供会话管理和生命周期控制
 * @returns 永不解决的 Promise，保持进程存活
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	// 接管 stdout，防止扩展或第三方库意外写入非 JSON 内容
	takeOverStdout();
	// 获取当前会话实例
	let session = runtimeHost.session;
	// 会话事件订阅的解除函数
	let unsubscribe: (() => void) | undefined;
	// 背压监控订阅的解除函数
	let unsubscribeBackpressure: (() => void) | undefined;

	/** 输出辅助函数：将对象序列化为 JSONL 并写入 stdout */
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	/**
	 * 构造成功响应。
	 * @param id - 请求命令的 id，用于关联请求和响应
	 * @param command - 对应的命令类型
	 * @param data - 可选的响应数据
	 * @returns 成功的 RpcResponse 对象
	 */
	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// 等待响应的扩展 UI 请求映射表，键为请求 id
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// 关闭请求标志和关闭状态
	let shutdownRequested = false;
	let shuttingDown = false;
	// 信号处理器清理函数列表，用于优雅关闭时移除监听器
	const signalCleanupHandlers: Array<() => void> = [];

	/**
	 * 创建带有信号/超时支持的对话框 Promise。
	 *
	 * 通用的对话框辅助函数，用于 select、confirm、input 等需要用户交互的方法。
	 * 生成唯一的请求 id，通过 RPC 协议发送 UI 请求，并等待客户端响应。
	 * 支持 AbortSignal 取消和超时自动返回默认值。
	 *
	 * **被谁调用**：`createExtensionUIContext()` 中的 `select()`、`confirm()`、`input()` 方法。
	 * **调用了谁**：`output()`（发送 UI 请求到客户端）。
	 *
	 * @typeParam T - 返回值类型
	 * @param opts - 对话框选项，包含 signal 和 timeout
	 * @param defaultValue - 取消或超时时返回的默认值
	 * @param request - 要发送的 UI 请求体（不含 type 和 id）
	 * @param parseResponse - 从 RpcExtensionUIResponse 中解析出 T 类型值的函数
	 * @returns Promise，解析为用户输入的值或默认值
	 */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * 创建 RPC 模式的扩展 UI 上下文。
	 *
	 * 返回一个 `ExtensionUIContext` 实现，将所有 UI 交互通过 RPC 协议
	 * 转发给客户端处理。在 RPC 模式下，扩展无法直接访问终端 UI，
	 * 因此所有 UI 操作（select、confirm、input、notify 等）都通过
	 * stdout 发送请求，由客户端负责渲染和响应。
	 *
	 * 不支持的操作（如 TUI 专属功能）会静默忽略或返回空值。
	 *
	 * **被谁调用**：`rebindSession()` 中在绑定扩展时调用。
	 * **调用了谁**：`createDialogPromise()`（处理需要响应的对话框）、`output()`（发送通知等）。
	 *
	 * @returns RPC 模式的扩展 UI 上下文对象
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		/** 单选列表：通过 RPC 请求客户端显示选项列表，等待用户选择 */
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		/** 确认对话框：通过 RPC 请求客户端显示确认框，等待用户确认或取消 */
		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		/** 文本输入：通过 RPC 请求客户端显示输入框，等待用户输入 */
		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		/** 通知消息：发送后即忘，不需要响应 */
		notify(message: string, type?: "info" | "warning" | "error"): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		/** 终端原始输入：RPC 模式不支持，返回空解除函数 */
		onTerminalInput(): () => void {
			return () => {};
		},

		/** 设置状态栏文本：发送后即忘 */
		setStatus(key: string, text: string | undefined): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		/** 设置工作指示消息：RPC 模式不支持，需要 TUI 加载器访问 */
		setWorkingMessage(_message?: string): void {},

		/** 设置工作指示可见性：RPC 模式不支持，需要 TUI 加载器访问 */
		setWorkingVisible(_visible: boolean): void {},

		/** 设置工作指示器自定义选项：RPC 模式不支持，需要 TUI 加载器访问 */
		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {},

		/** 设置隐藏思考标签：RPC 模式不支持，需要 TUI 消息渲染访问 */
		setHiddenThinkingLabel(_label?: string): void {},

		/**
		 * 设置小部件内容。
		 *
		 * RPC 模式仅支持字符串数组内容，不支持工厂函数（组件）。
		 * 只有当 content 为 undefined 或字符串数组时才发送请求。
		 */
		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// 组件工厂函数在 RPC 模式下不支持，需要 TUI 访问
		},

		/** 自定义页脚：RPC 模式不支持，需要 TUI 访问 */
		setFooter(_factory: unknown): void {},

		/** 自定义页头：RPC 模式不支持，需要 TUI 访问 */
		setHeader(_factory: unknown): void {},

		/** 设置终端标题：发送后即忘 */
		setTitle(title: string): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		/** 自定义 UI：RPC 模式不支持 */
		async custom() {
			return undefined as never;
		},

		/** 粘贴到编辑器：回退到 setEditorText */
		pasteToEditor(text: string): void {
			this.setEditorText(text);
		},

		/** 设置编辑器文本：发送后即忘 */
		setEditorText(text: string): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		/**
		 * 获取编辑器文本。
		 * 同步方法无法等待 RPC 响应，返回空字符串。
		 * 客户端应在本地追踪编辑器状态。
		 */
		getEditorText(): string {
			return "";
		},

		/**
		 * 打开编辑器。
		 * 通过 RPC 协议请求客户端打开编辑器，等待用户完成编辑后返回结果。
		 */
		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		/** 自动补全提供者组合：RPC 模式不支持 */
		addAutocompleteProvider(): void {},

		/** 自定义编辑器组件：RPC 模式不支持 */
		setEditorComponent(): void {},

		/** 获取自定义编辑器组件：RPC 模式不支持，返回 undefined */
		getEditorComponent() {
			return undefined;
		},

		/** 获取当前主题 */
		get theme() {
			return theme;
		},

		/** 获取所有主题：RPC 模式不支持，返回空数组 */
		getAllThemes() {
			return [];
		},

		/** 获取指定主题：RPC 模式不支持，返回 undefined */
		getTheme(_name: string) {
			return undefined;
		},

		/** 切换主题：RPC 模式不支持 */
		setTheme(_theme: string | Theme) {
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		/** 获取工具展开状态：RPC 模式不支持（无 TUI），返回 false */
		getToolsExpanded() {
			return false;
		},

		/** 设置工具展开状态：RPC 模式不支持（无 TUI） */
		setToolsExpanded(_expanded: boolean) {},
	});

	/**
	 * 注册会话重绑定回调。
	 * 当 runtimeHost 需要切换会话时（如 newSession、switchSession、fork），会调用此回调。
	 */
	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	/**
	 * 重新绑定会话。
	 *
	 * 获取当前会话实例，绑定扩展 UI 上下文和命令上下文操作，
	 * 然后订阅会话事件（通过 stdout 输出）和背压监控。
	 * 在会话切换（new_session、switch_session、fork、clone）后调用。
	 *
	 * **被谁调用**：`runRpcMode()` 初始绑定时、`handleCommand()` 中的会话管理命令、
	 *   `runtimeHost.setRebindSession()` 回调。
	 * **调用了谁**：`createExtensionUIContext()`、`session.bindExtensions()`、`session.subscribe()`、
	 *   `output()`、`waitForRawStdoutBackpressure()`。
	 *
	 * @returns Promise，在绑定完成后解决
	 */
	const rebindSession = async (): Promise<void> => {
		// 获取最新的会话实例
		session = runtimeHost.session;
		// 绑定扩展，提供 UI 上下文和命令上下文操作
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			commandContextActions: {
				/** 等待当前 agent 处理完成 */
				waitForIdle: () => session.agent.waitForIdle(),
				/** 创建新会话 */
				newSession: async (options) => runtimeHost.newSession(options),
				/** 从指定消息处分叉 */
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				/** 导航到消息树的指定节点 */
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				/** 切换到不同的会话文件 */
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				/** 重新加载当前会话 */
				reload: async () => {
					await session.reload();
				},
			},
			/** 扩展请求关闭时设置关闭标志 */
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			/** 扩展错误时输出错误信息 */
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		// 取消旧的事件订阅（如果存在）
		unsubscribe?.();
		unsubscribeBackpressure?.();
		// 订阅会话事件，通过 stdout 实时输出
		unsubscribe = session.subscribe((event) => {
			output(event);
		});
		// 订阅背压监控，当 stdout 缓冲区满时等待刷新
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	/**
	 * 注册信号处理器。
	 *
	 * 监听 SIGTERM 和 SIGHUP（非 Windows），收到信号后先终止已跟踪的
	 * 子进程，然后执行优雅关闭。
	 *
	 * **被谁调用**：`runRpcMode()` 初始化阶段。
	 * **调用了谁**：`killTrackedDetachedChildren()`、`shutdown()`。
	 */
	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// 终止所有已跟踪的分离子进程
				killTrackedDetachedChildren();
				// SIGHUP 退出码 129，SIGTERM 退出码 143
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	/**
	 * 命令分发处理函数。
	 *
	 * 根据命令的 `type` 字段分发到对应的处理逻辑。支持的命令类型包括：
	 * - 提示类：prompt、steer、follow_up、abort、new_session
	 * - 状态类：get_state
	 * - 模型类：set_model、cycle_model、get_available_models
	 * - 思考类：set_thinking_level、cycle_thinking_level
	 * - 队列模式类：set_steering_mode、set_follow_up_mode
	 * - 压缩类：compact、set_auto_compaction
	 * - 重试类：set_auto_retry、abort_retry
	 * - Bash 类：bash、abort_bash
	 * - 会话类：get_session_stats、export_html、switch_session、fork、clone 等
	 * - 消息类：get_messages
	 * - 命令类：get_commands
	 *
	 * **被谁调用**：`handleInputLine()` 在解析完 JSON 后调用。
	 * **调用了谁**：`session` 的各种方法（如 `prompt()`、`steer()`、`getState()` 等）、
	 *   `runtimeHost` 的方法（如 `newSession()`、`switchSession()`、`fork()`）、
	 *   `success()` / `error()` 辅助函数。
	 *
	 * @param command - 解析后的 RPC 命令对象
	 * @returns Promise，解析为响应对象；对于异步命令（如 prompt）返回 undefined
	 */
	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// 提示类命令
			// =================================================================

			case "prompt": {
				// 立即开始 prompt 处理，但权威响应只在 preflight 成功后发出。
				// 排队和立即处理的 prompt 也计为成功。
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// 状态查询
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// 模型管理
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// 思考级别
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// 队列模式
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// 上下文压缩
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// 重试控制
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash 命令
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// 会话管理
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// 消息查询
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// 可用命令查询（可通过 prompt 调用的扩展命令、模板、技能）
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				// 收集扩展注册的命令
				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				// 收集 prompt 模板
				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				// 收集技能（名称前缀 "skill:"）
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			// 未知命令类型
			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * 检查是否请求了关闭，如果是则执行关闭。
	 * 在每次命令处理完成后、等待下一个命令之前调用。
	 */
	let detachInput = () => {};

	/**
	 * 执行优雅关闭。
	 *
	 * 移除信号处理器、取消事件订阅、释放 runtimeHost 资源、
	 * 移除 stdin 读取器、暂停 stdin，最后刷新 stdout 缓冲区并退出进程。
	 * 如果已在关闭中，直接退出。
	 *
	 * **被谁调用**：信号处理器（SIGTERM/SIGHUP）、`checkShutdownRequested()`、
	 *   `onInputEnd()`（stdin 关闭时）。
	 * **调用了谁**：`runtimeHost.dispose()`、`flushRawStdout()`、`process.exit()`。
	 *
	 * @param exitCode - 退出码，默认 0
	 * @param signal - 触发关闭的信号，用于决定是否刷新 stdout
	 * @returns 永不解决的 Promise（process.exit 会终止进程）
	 */
	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		// 移除所有信号处理器
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		// 取消事件订阅
		unsubscribe?.();
		unsubscribeBackpressure?.();
		// 释放 runtimeHost 资源（关闭会话等）
		await runtimeHost.dispose();
		// 移除 stdin 读取器
		detachInput();
		// 暂停 stdin
		process.stdin.pause();
		// SIGTERM 时不刷新 stdout（进程可能已被强制终止）
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	/**
	 * 检查是否请求了关闭，如果是则执行关闭。
	 * 在处理每个命令后调用，确保扩展请求的关闭能被及时响应。
	 */
	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	/**
	 * 处理从 stdin 收到的一行输入。
	 *
	 * 解析 JSON 后判断消息类型：
	 * - 如果是扩展 UI 响应（`extension_ui_response`），匹配对应的待处理请求并解决。
	 * - 否则视为 RPC 命令，交给 `handleCommand()` 处理。
	 *
	 * 解析失败时输出错误响应。命令处理异常时也输出错误响应。
	 * 每次处理后检查关闭请求。
	 *
	 * **被谁调用**：`attachJsonlLineReader()` 的回调。
	 * **调用了谁**：`handleCommand()`、`output()`、`checkShutdownRequested()`、
	 *   `waitForRawStdoutBackpressure()`。
	 *
	 * @param line - JSONL 行内容（不含行终止符）
	 */
	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			// JSON 解析失败，输出错误响应
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// 处理扩展 UI 响应：匹配待处理的扩展请求
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		// 视为 RPC 命令，交给 handleCommand 处理
		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			// 命令处理完成后检查是否需要关闭
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			// 命令处理异常，输出错误响应
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	/** stdin 结束时执行关闭（客户端断开连接） */
	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	// 附加 JSONL 读取器到 stdin，开始接收命令
	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// 保持进程存活：永不解决的 Promise
	return new Promise(() => {});
}
