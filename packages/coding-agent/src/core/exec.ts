/**
 * exec.ts - 通用 shell 命令执行工具
 *
 * 作用：提供执行外部 shell 命令的底层能力，支持超时和中止信号。
 * 定位：core 层的基础工具函数，被扩展系统（extensions）和自定义工具（custom tools）使用。
 *       与 bash-executor.ts 不同，本模块面向"单次命令执行"场景，不处理流式输出和截断。
 *
 * 提供的能力：
 * - ExecOptions：执行选项（中止信号、超时时间、工作目录）
 * - ExecResult：执行结果（stdout、stderr、退出码、是否被杀）
 * - execCommand()：执行命令并返回完整结果
 *
 * 调用关系：extensions 和 custom tools → execCommand() → Node.js child_process.spawn()
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * shell 命令执行选项。
 * 调用方：扩展系统中的 exec() API、自定义工具。
 */
export interface ExecOptions {
	/** 用于取消命令执行的中止信号 */
	signal?: AbortSignal;
	/** 超时时间（毫秒），超时后进程将被强制终止 */
	timeout?: number;
	/** 命令的工作目录 */
	cwd?: string;
}

/**
 * shell 命令执行结果。
 * 返回给调用方用于判断命令是否成功。
 */
export interface ExecResult {
	/** 标准输出内容 */
	stdout: string;
	/** 标准错误输出内容 */
	stderr: string;
	/** 进程退出码（被中止时可能为异常值） */
	code: number;
	/** 是否被信号或超时强制终止 */
	killed: boolean;
}

/**
 * 执行 shell 命令，返回 stdout/stderr/退出码。
 *
 * 内部步骤：
 * 1. 使用 spawn 创建子进程（shell: false，避免命令注入）
 * 2. 收集 stdout 和 stderr 的输出
 * 3. 如果提供了 AbortSignal，监听中止事件并终止进程
 * 4. 如果设置了超时，超时后终止进程
 * 5. 进程终止时先发 SIGTERM，5秒后如果仍在运行则发 SIGKILL
 * 6. 使用 waitForChildProcess 等待进程退出，避免被后代进程的继承 stdio 阻塞
 *
 * 定位：单次命令执行场景的底层封装。
 * 作用：统一 spawn、超时、中止和退出等待逻辑，避免上层重复处理细节。
 * 调用关系：被扩展系统、自定义工具以及其他需要非流式命令执行的模块调用。
 *
 * @param command 要执行的命令（如 "git"、"npm"）
 * @param args 命令参数数组
 * @param cwd 工作目录
 * @param options 可选的执行选项（中止信号、超时等）
 * @returns 执行结果，包含 stdout、stderr、退出码和是否被杀
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		// 以非 shell 方式启动，保持参数边界清晰，降低命令注入风险。
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// SIGTERM 无效时，5秒后强制 SIGKILL
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// 处理中止信号
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// 处理超时
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// 等待进程终止，避免被分离的后代进程持有的继承 stdio 句柄阻塞
		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
