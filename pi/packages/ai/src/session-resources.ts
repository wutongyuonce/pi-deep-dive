/**
 * 会话级资源清理注册表。
 *
 * 文件定位：让 API 实现把 WebSocket 等按 session 归属的资源注册给上层统一释放。
 *
 * 调用链：
 *   API 模块初始化 → registerSessionResourceCleanup()
 *   AgentSession 结束/重置 → cleanupSessionResources(sessionId)
 */

/** 清理函数可针对指定会话释放资源；未传入 session ID 时由实现自行决定清理范围。 */
export type SessionResourceCleanup = (sessionId?: string) => void;

const sessionResourceCleanups = new Set<SessionResourceCleanup>();

/**
 * 注册一个会话资源清理器。
 *
 * @returns 反注册函数，供 API 模块卸载或测试清理时移除自身回调。
 */
export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	sessionResourceCleanups.add(cleanup);
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

/**
 * 执行全部已注册清理器，并汇总失败。
 *
 * 单个清理器失败不会阻断后续清理，最终统一抛出 `AggregateError`，避免一个损坏的资源泄漏其余会话资源。
 */
export function cleanupSessionResources(sessionId?: string): void {
	const errors: unknown[] = [];
	for (const cleanup of sessionResourceCleanups) {
		try {
			cleanup(sessionId);
		} catch (error) {
			// 保留错误，继续尝试释放其他资源。
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}
