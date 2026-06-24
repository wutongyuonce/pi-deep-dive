/**
 * 文件变更队列 (file-mutation-queue.ts)
 *
 * 本文件实现了针对同一文件的变更操作序列化机制，防止并发写入导致数据竞争。
 *
 * 定位：
 *   被 write.ts 和 edit.ts 的 execute 方法调用，确保对同一文件的写入操作串行执行。
 *   不同文件的操作仍然可以并行执行。
 *
 * 提供的能力：
 *   1. withFileMutationQueue：将文件变更操作排队执行
 *   2. 基于文件真实路径（realpath）作为队列键，处理符号链接
 *   3. 使用 Promise 链实现无锁串行化
 *
 * 调用链路：
 *   write.ts execute → withFileMutationQueue(absolutePath, async () => { writeFile... })
 *   edit.ts execute → withFileMutationQueue(absolutePath, async () => { readFile + writeFile... })
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** 按文件路径维护的 Promise 链映射，每个路径对应一个串行队列 */
const fileMutationQueues = new Map<string, Promise<void>>();

/** 注册队列，确保队列注册操作本身也是串行的，防止竞态条件 */
let registrationQueue = Promise.resolve();

/**
 * 判断错误是否为路径不存在（ENOENT 或 ENOTDIR）。
 * 用于在文件尚未创建时（如 write 新文件）仍能正确获取队列键。
 */
function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/**
 * 获取文件的队列键。
 * 优先使用 realpath（解析符号链接），如果文件不存在则使用解析后的绝对路径。
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath;
		}
		throw error;
	}
}

/**
 * 将针对同一文件的变更操作序列化执行。
 *
 * 实现原理：
 *   1. 通过 registrationQueue 串行注册（获取队列键 + 创建 Promise 链节点）
 *   2. 等待当前文件的前一个操作完成后执行 fn()
 *   3. 执行完成后释放下一个等待者
 *   4. 如果队列为空则自动清理映射条目
 *
 * @param filePath  文件路径
 * @param fn        要执行的变更操作
 * @returns fn 的返回值
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		// 如果此队列节点是最后一个，清理映射条目防止内存泄漏
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
