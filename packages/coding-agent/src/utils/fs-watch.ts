/**
 * 文件系统监视工具
 *
 * 提供安全的文件系统 watcher 创建和关闭包装函数。
 * 处理 watcher 创建失败和关闭时的异常，避免未捕获错误导致进程崩溃。
 *
 * 调用方：设置文件监视、主题文件监视、配置文件热重载等。
 */

import { type FSWatcher, type WatchListener, watch } from "node:fs";

/** watcher 创建失败后的重试延迟时间（毫秒） */
export const FS_WATCH_RETRY_DELAY_MS = 5000;

/**
 * 安全关闭文件系统 watcher。
 *
 * 忽略关闭时可能发生的错误（如 watcher 已被关闭）。
 *
 * @param watcher - 要关闭的 watcher 实例，可以为 null 或 undefined
 */
export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// 忽略 watcher 关闭错误
	}
}

/**
 * 创建带错误处理的文件系统 watcher。
 *
 * 如果创建 watcher 本身失败（如路径不存在），会调用 onError 回调
 * 而不是抛出异常，返回 null。
 *
 * @param path - 要监视的文件或目录路径
 * @param listener - 文件变化事件的回调函数
 * @param onError - 创建失败或运行时错误的回调函数
 * @returns 成功创建的 watcher 实例，失败时返回 null
 */
export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
): FSWatcher | null {
	try {
		const watcher = watch(path, listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		onError();
		return null;
	}
}
