/**
 * 支持 AbortSignal 的 sleep 工具
 *
 * 提供可中断的延迟功能，被重试逻辑、延迟操作等调用。
 */

/**
 * 延迟指定毫秒，支持通过 AbortSignal 中断
 * @param ms - 延迟的毫秒数
 * @param signal - 可选的 AbortSignal，用于提前中止延迟
 * @returns Promise<void>，延迟完成或被中止时 resolve/reject
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		// 如果 signal 已经处于中止状态，立即 reject
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		// 设置定时器
		const timeout = setTimeout(resolve, ms);

		// 监听中止事件，清除定时器并 reject
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		});
	});
}
