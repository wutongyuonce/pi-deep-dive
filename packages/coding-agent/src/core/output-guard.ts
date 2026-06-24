/**
 * 标准输出守护模块
 *
 * 在 TUI 交互模式下，将 process.stdout 的所有输出重定向到 stderr，
 * 防止第三方库或意外的 console.log 调用破坏 TUI 渲染。
 *
 * 同时提供 writeRawStdout() 通道，允许需要直接写入原始 stdout 的场景
 *（如子进程输出流）绕过重定向。所有写入通过 Promise 链串行化，避免并发写入冲突。
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
 * 获取原始 stdout.write 函数
 * 如果 stdout 已被接管，返回保存的原始引用；否则返回当前的 process.stdout.write
 */
function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

/**
 * 向原始 stdout 写入一个文本块
 * 遇到缓冲区满（ENOBUFS/EAGAIN/EWOULDBLOCK）时自动重试
 * @param text 要写入的文本
 */
async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
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
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

/**
 * 接管 stdout：将 process.stdout.write 重定向到 stderr
 * 调用后，所有写入 stdout 的内容都会输出到 stderr，
 * 但可通过 writeRawStdout() 仍然写入真正的 stdout。
 * 幂等操作，多次调用仅生效一次。
 */
export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

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
 * 恢复 stdout：将 process.stdout.write 恢复为接管前的原始实现
 */
export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

/**
 * 检查 stdout 是否已被接管
 * @returns 如果 stdout 当前处于接管状态则返回 true
 */
export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

/**
 * 向原始 stdout 写入文本（绕过重定向）
 * 写入通过 Promise 链串行化，确保顺序正确。
 * @param text 要写入的文本，空字符串将被忽略
 */
export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

/**
 * 等待所有排队的原始 stdout 写入完成
 */
export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

/**
 * 刷新原始 stdout：等待所有排队写入完成后，写入一个空块确保内核缓冲区被刷新
 */
export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
