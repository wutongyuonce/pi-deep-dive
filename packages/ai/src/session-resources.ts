/**
 * 会话资源清理管理器。
 *
 * 解决的问题：
 * - 某些 provider 或功能在会话期间会分配资源（如 WebSocket 连接、临时文件）
 * - 会话结束时需要清理这些资源
 * - 但调用方不知道具体有哪些资源需要清理
 *
 * 设计模式：观察者模式（注册回调 → 统一触发）
 *
 * 使用方式：
 * ```typescript
 * // 注册清理回调
 * const unregister = registerSessionResourceCleanup((sessionId) => {
 *     closeConnection(sessionId);
 * });
 *
 * // 会话结束时触发所有清理
 * cleanupSessionResources("session-123");
 *
 * // 不再需要时取消注册
 * unregister();
 * ```
 */

/** 清理回调的类型：接收可选的 sessionId，无返回值。 */
export type SessionResourceCleanup = (sessionId?: string) => void;

/** 已注册的清理回调集合。使用 Set 保证不重复注册。 */
const sessionResourceCleanups = new Set<SessionResourceCleanup>();

/**
 * 注册一个会话资源清理回调。
 *
 * @param cleanup 清理函数
 * @returns 取消注册的函数（调用后该清理回调不再参与后续清理）
 */
export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	sessionResourceCleanups.add(cleanup);
	// 返回取消注册函数
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

/**
 * 触发所有已注册的清理回调。
 *
 * 容错策略：
 * - 每个回调独立 try/catch，一个失败不影响其他回调执行
 * - 全部执行完毕后，如果有失败的回调，抛出 AggregateError 汇总所有错误
 *
 * @param sessionId 可选的会话标识符，传递给每个清理回调
 */
export function cleanupSessionResources(sessionId?: string): void {
	const errors: unknown[] = [];
	for (const cleanup of sessionResourceCleanups) {
		try {
			cleanup(sessionId);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}
