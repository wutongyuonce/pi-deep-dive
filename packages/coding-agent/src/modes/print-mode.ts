/**
 * 打印模式（单次执行模式）
 *
 * 文件定位：`modes/` 目录下三种运行模式之一，负责单次 prompt 执行后输出结果并退出。
 *
 * 在调用链中的位置：
 * - 被 `../main.ts` 中的 `main()` 函数在 `appMode === "print"` 或 `appMode === "json"` 时调用
 * - 调用了 `AgentSessionRuntime`（来自 `../core/agent-session-runtime.ts`）管理会话生命周期
 * - 调用了 `writeRawStdout` / `flushRawStdout`（来自 `../core/output-guard.ts`）进行原始 stdout 输出
 * - 调用了 `killTrackedDetachedChildren`（来自 `../utils/shell.ts`）清理子进程
 *
 * 提供的能力：
 * - 文本模式（`pi -p "prompt"`）：发送 prompt，输出最终 assistant 回复的纯文本内容
 * - JSON 模式（`pi --mode json "prompt"`）：发送 prompt，以 JSON 事件流格式输出全部事件
 *
 * 与其他文件的关系：
 * - 与 `interactive-mode.ts` 和 `rpc/rpc-mode.ts` 并列为三种运行模式
 * - 通过 `index.ts` 桶导出 `runPrintMode` 和 `PrintModeOptions`
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * 打印模式的配置选项。
 *
 * 由 `../main.ts` 中的 `main()` 函数根据 CLI 参数构造，
 * 传递给 `runPrintMode()` 使用。
 */
export interface PrintModeOptions {
	/** 输出模式：`"text"` 仅输出最终回复文本，`"json"` 输出全部事件的 JSON 流 */
	mode: "text" | "json";
	/** 在 initialMessage 之后追加发送的额外消息数组（对应 CLI 位置参数） */
	messages?: string[];
	/** 第一条要发送的消息（可能包含 `@file` 引用的文件内容） */
	initialMessage?: string;
	/** 附加到初始消息的图片内容数组 */
	initialImages?: ImageContent[];
}

/**
 * 以打印模式（单次执行）运行 agent。
 *
 * 执行流程：注册信号处理器 -> 绑定扩展 -> 发送 prompt -> 输出结果 -> 清理退出。
 *
 * 被 `../main.ts` 中的 `main()` 在非交互、非 RPC 模式下调用。
 * 调用了 `AgentSessionRuntime.dispose()` 销毁会话，
 * 调用了 `AgentSession.prompt()` 发送消息，
 * 调用了 `writeRawStdout()` / `flushRawStdout()` 进行输出。
 *
 * @param runtimeHost - 会话运行时宿主，封装了当前 AgentSession 及其服务
 * @param options     - 打印模式的配置选项
 * @returns 进程退出码，0 表示成功，1 表示出错
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	// 当前活跃的 session 引用，会随会话重建而更新
	let session = runtimeHost.session;
	// 事件订阅的取消函数，会话重建时先取消旧订阅再建立新订阅
	let unsubscribe: (() => void) | undefined;
	// 防止重复 dispose 的标志
	let disposed = false;
	// 信号处理器清理函数列表，用于 finally 阶段移除监听
	const signalCleanupHandlers: Array<() => void> = [];

	/**
	 * 安全销毁运行时：取消事件订阅并销毁 AgentSessionRuntime。
	 * 通过 disposed 标志保证只执行一次。
	 */
	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	/**
	 * 注册操作系统信号处理器，确保进程收到终止信号时能优雅清理。
	 * - SIGTERM：通用终止信号
	 * - SIGHUP：终端挂断信号（仅非 Windows 平台）
	 *
	 * 收到信号后先清理子进程，再销毁运行时，最后以对应退出码退出。
	 */
	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// 清理所有已跟踪的后台子进程
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					// SIGHUP 退出码 129，SIGTERM 退出码 143（遵循 Unix 惯例：128 + 信号编号）
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			// 记录清理函数以便后续移除监听器
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	// 注册信号处理器
	registerSignalHandlers();

	// 设置会话重绑定回调，当运行时内部重建 session 时会触发
	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	/**
	 * 重绑定 session：将扩展和事件监听器绑定到当前活跃的 session 上。
	 * 当 AgentSessionRuntime 内部发生会话重建（如 /new、/fork）时被调用。
	 *
	 * 调用了 `session.bindExtensions()` 注册扩展命令上下文和错误监听，
	 * 调用了 `session.subscribe()` 订阅 agent 事件。
	 */
	const rebindSession = async (): Promise<void> => {
		// 获取最新的 session 引用（运行时可能已重建了会话）
		session = runtimeHost.session;
		// 绑定扩展：注册命令上下文操作和错误处理器
		await session.bindExtensions({
			commandContextActions: {
				// 等待 agent 空闲
				waitForIdle: () => session.agent.waitForIdle(),
				// 创建新会话
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				// 分叉（fork）会话：从指定位置创建分支
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				// 导航会话树：跳转到指定条目
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				// 切换到另一个会话文件
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				// 重新加载当前会话
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		// 取消旧的事件订阅（如果存在）
		unsubscribe?.();
		// 订阅 session 事件：JSON 模式下将所有事件序列化写入 stdout
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});
	};

	try {
		// JSON 模式：先输出会话头信息（包含会话 ID 等元数据）
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		// 执行首次扩展绑定和事件订阅
		await rebindSession();

		// 发送初始消息（包含可能的图片附件）
		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		// 依次发送后续追加的消息
		for (const message of messages) {
			await session.prompt(message);
		}

		// 文本模式：提取最终 assistant 回复并输出纯文本内容
		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				// 处理错误或中止的情况：输出错误信息并设置退出码为 1
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					// 正常完成：输出所有文本类型的内容块
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		// 捕获未预期的异常，输出错误信息并返回退出码 1
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		// 移除所有信号处理器监听
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		// 销毁运行时，释放会话资源
		await disposeRuntime();
		// 确保所有待写入的 stdout 数据都被刷出
		await flushRawStdout();
	}
}
