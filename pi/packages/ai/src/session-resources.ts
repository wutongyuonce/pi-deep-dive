/**
 * 会话级资源清理注册表。
 *
 * 文件定位：
 * - 这是 `pi-ai` 内部的轻量生命周期模块
 * - 用来集中登记“某个 session 结束后需要释放的资源”，例如缓存句柄、连接状态、临时对象等
 *
 * 调用链路：
 * - 各模块通过 `registerSessionResourceCleanup()` 注册清理函数
 * - 会话结束或上层显式回收时调用 `cleanupSessionResources()`
 */

/**
 * 会话资源清理函数的类型签名。
 * 定位：定义清理回调的标准契约，接收可选的 sessionId 参数。
 * 作用：各模块按此签名注册自己的清理逻辑，由 {@link cleanupSessionResources} 统一执行。
 */
export type SessionResourceCleanup = (sessionId?: string) => void;

/** 全局会话资源清理函数集合。 */
const sessionResourceCleanups = new Set<SessionResourceCleanup>();

/** 注册一个会话清理函数，并返回对应的注销函数。 */
export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	sessionResourceCleanups.add(cleanup);
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

/**
 * 会话结束时的统一资源回收入口。执行当前已注册的所有会话资源清理逻辑。
 * 被谁调用：由上层会话管理模块在会话结束时调用，或由框架生命周期钩子触发。
 * 调用了谁：遍历执行 {@link sessionResourceCleanups} 中的所有清理函数。
 */
export function cleanupSessionResources(sessionId?: string): void {
	const errors: unknown[] = [];
	// 逐个执行已注册的清理函数，单个失败不影响后续清理。
	for (const cleanup of sessionResourceCleanups) {
		try {
			cleanup(sessionId);
		} catch (error) {
			errors.push(error);
		}
	}
	// 全部执行完后，若有异常统一抛出。
	if (errors.length > 0) {
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}
