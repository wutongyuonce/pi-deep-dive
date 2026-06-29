/**
 * 标准输出守护模块
 *
 * 文件定位：coding-agent 的 stdout 保护层。
 *
 * 核心职责：
 * - 在需要保护 stdout 结构化输出的模式下接管 `process.stdout.write`
 * - 把意外的普通 stdout 输出改道到 stderr，避免污染协议流或最终结果
 * - 提供 `writeRawStdout()` / `flushRawStdout()`，让调用方仍可安全直写真实 stdout
 * - 通过 Promise 链串行化原始写入，避免并发写入打乱输出顺序
 *
 * 典型调用链：
 *   `main.ts` / `rpc-mode.ts` -> `takeOverStdout()` -> 业务逻辑通过 `writeRawStdout()` 输出真实结果
 */

/** stdout 接管状态 */
interface StdoutTakeoverState {
	/** 原始 stdout.write 的绑定引用（绕过重定向用） */
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	/** 原始 stderr.write 的绑定引用 */
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	/** 接管前的原始 process.stdout.write */
	originalStdoutWrite: typeof process.stdout.write;
}

/** 当前 stdout 接管状态，undefined 表示未接管 */
let stdoutTakeoverState: StdoutTakeoverState | undefined;

/** 写入重试延迟（毫秒），用于 ENOBUFS/EAGAIN/EWOULDBLOCK 错误恢复 */
const RAW_STDOUT_RETRY_DELAY_MS = 10;

/** 串行化写入链尾部 Promise */
let rawStdoutWriteTail: Promise<void> = Promise.resolve();

/**
 * 返回真实 stdout 的底层写入函数。
 *
 * 定位：模块内部的原始输出访问口。
 *
 * 被谁调用：
 * - `writeRawStdoutChunk()`
 *
 * 作用：
 * - 在 stdout 已接管时返回接管前保存的原始写入函数
 * - 在 stdout 未接管时直接返回当前的 `process.stdout.write`
 */
function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

/**
 * 把文本异步写入真实 stdout，并处理可恢复的背压错误。
 *
 * 定位：模块内部的底层原始写入器。
 *
 * 被谁调用：
 * - `writeRawStdout()`
 * - `flushRawStdout()`
 *
 * 调用了谁：
 * - `getRawStdoutWrite()`
 * - `setTimeout()`
 *
 * @param text 要写入真实 stdout 的文本
 */
async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			// 每次循环只尝试一次真实写入，成功后立刻结束。
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			// 可恢复的背压错误等待一个极短时间后再重试。
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

/**
 * 接管进程 stdout，把普通 stdout 输出统一改道到 stderr。
 *
 * 定位：stdout 保护机制的入口函数。
 *
 * 被谁调用：
 * - `main.ts` 在非交互模式下调用
 * - `rpc-mode.ts` 在 RPC 协议启动时调用
 *
 * 作用：
 * - 防止第三方库或意外的 `console.log` 污染 stdout 上的文本结果、JSON 事件流或 RPC 协议流
 * - 保留一条可由 `writeRawStdout()` 使用的真实 stdout 写入通道
 *
 * 说明：
 * - 本函数是幂等的；若 stdout 已处于接管状态，会直接返回
 */
export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	// 先保存 stdout/stderr 的原始写入函数，供恢复和绕过重定向时使用。
	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

/**
 * 恢复 stdout 的原始写入行为。
 *
 * 定位：stdout 接管的对称恢复入口。
 *
 * 被谁调用：
 * - 各模式的退出或清理流程
 *
 * 作用：
 * - 撤销 `takeOverStdout()` 对 `process.stdout.write` 的替换
 * - 清空模块内保存的接管状态
 */
export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	// 使用接管时保存的原始实现原样恢复。
	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

/**
 * 判断 stdout 当前是否已被接管。
 *
 * 定位：模块对外暴露的状态查询函数。
 *
 * 被谁调用：
 * - 需要根据输出环境调整行为的模块
 *
 * @returns 若 stdout 当前处于接管状态则返回 `true`
 */
export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

/**
 * 按顺序写入真实 stdout，绕过 stdout 接管。
 *
 * 定位：模块对外暴露的原始输出入口。
 *
 * 被谁调用：
 * - 需要保留真实 stdout 输出的模式实现
 * - 转发子进程输出或结构化协议输出的调用点
 *
 * 调用了谁：
 * - `writeRawStdoutChunk()`
 *
 * @param text 要写入真实 stdout 的文本；空字符串会被忽略
 */
export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	// 把写入任务挂到 Promise 链尾部，保证并发调用仍按顺序落盘。
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

/**
 * 等待原始 stdout 写入队列完全排空。
 *
 * 定位：模块内部的写入队列同步点。
 *
 * 被谁调用：
 * - `flushRawStdout()`
 *
 * 作用：
 * - 等待当前队尾完成
 * - 若等待期间又追加了新的写入任务，则继续等待直到队列稳定清空
 */
export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		// 捕获当前队尾并等待；若期间队尾未变化，说明队列已经稳定清空。
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

/**
 * 刷新真实 stdout，确保已排队内容全部落地。
 *
 * 定位：模块对外暴露的刷新入口。
 *
 * 被谁调用：
 * - 退出前需要确保输出已全部可见的收尾流程
 *
 * 调用了谁：
 * - `waitForRawStdoutBackpressure()`
 * - `writeRawStdoutChunk()`
 */
export async function flushRawStdout(): Promise<void> {
	// 先确保用户态队列清空，再通过空块推进内核态刷新。
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
