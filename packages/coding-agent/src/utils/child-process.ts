/**
 * 跨平台子进程管理工具
 *
 * 提供跨平台的子进程创建和管理功能。
 * Windows 平台使用 cross-spawn 库（解决路径、shell 内置命令等兼容性问题），
 * Unix 平台使用 node:child_process 原生模块。
 *
 * 核心功能 waitForChildProcess 解决了 Windows 上守护进程继承 stdio 管道句柄
 * 导致 `close` 事件永远不触发的挂起问题。
 *
 * 调用方：bash 工具、包管理器、工具下载模块等。
 */

import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

/** exit 事件后等待 stdio 关闭的宽限时间（毫秒） */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * 创建子进程（异步）。
 *
 * Windows 平台使用 cross-spawn，Unix 平台使用 node:child_process 的 spawn。
 *
 * @param command - 要执行的命令
 * @param args - 命令参数数组
 * @param options - spawn 选项（stdio 配置等）
 * @returns 子进程对象
 */
export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

/**
 * 创建子进程（同步）。
 *
 * Windows 平台使用 cross-spawn.sync，Unix 平台使用 node:child_process 的 spawnSync。
 *
 * @param command - 要执行的命令
 * @param args - 命令参数数组
 * @param options - 同步 spawn 选项
 * @returns 同步执行结果，包含 stdout、stderr、状态码等
 */
export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

/**
 * 等待子进程终止，避免因继承的 stdio 句柄而挂起。
 *
 * 在 Windows 上，守护进程化的子进程可能继承了 stdout/stderr 管道句柄。
 * 这种情况下子进程会发出 `exit` 事件，但 `close` 事件可能永远不会触发
 * （即使原始进程已经退出）。此函数在 stdio 结束后短暂等待，
 * 然后强制停止追踪继承的句柄。
 *
 * @param child - 要等待的子进程对象
 * @returns Promise，解析为子进程的退出码（null 表示因信号终止）
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		// 状态追踪标志
		let settled = false;   // 是否已最终确定结果
		let exited = false;    // 是否已收到 exit 事件
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;  // 如果 stdout 为 null 则视为已结束
		let stderrEnded = child.stderr === null;

		/** 清理所有事件监听器和定时器 */
		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		/** 最终确定结果：清理资源并 resolve */
		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		/** 在 exit 事件后检查是否可以立即 finalize（stdio 均已结束时） */
		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		/** 子进程退出事件处理 */
		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			// 设置宽限定时器：如果 stdio 在宽限时间内未结束则强制 finalize
			if (!settled) {
				postExitTimer = setTimeout(() => finalize(code), EXIT_STDIO_GRACE_MS);
			}
		};

		/** 子进程 close 事件处理（所有 stdio 流均已关闭） */
		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
