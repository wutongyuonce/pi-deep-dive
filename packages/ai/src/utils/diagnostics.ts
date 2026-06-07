/**
 * 诊断信息工具模块。
 *
 * 文件定位：
 * - 提供统一的错误诊断信息结构，用于在 AssistantMessage 上附加诊断数据
 * - 帮助调试和排查 LLM 请求失败的原因（如网络错误、API 限流、内容过滤等）
 *
 * 被谁调用：
 * - types.ts：导入 AssistantMessageDiagnostic 类型，用于 AssistantMessage.diagnostics 字段
 * - index.ts：通过桶导出向外部包暴露所有函数和类型
 * - 目前 4 个导出函数在代码库中零调用，是预留的公共 API，供外部消费者在需要时使用
 *
 * 调用链路：
 *   外部调用方
 *     -> createAssistantMessageDiagnostic()  构造诊断信息
 *       -> extractDiagnosticError()          从 Error 对象提取结构化错误信息
 *         -> formatThrownValue()             格式化非 Error 类型的异常值
 *     -> appendAssistantMessageDiagnostic()  将诊断信息追加到 AssistantMessage
 */

/**
 * 诊断错误信息的结构化表示。
 *
 * 谁使用：AssistantMessageDiagnostic 的 error 字段
 * 用途：将各种类型的异常统一为可序列化的结构体，方便日志记录和调试。
 */
export interface DiagnosticErrorInfo {
	/** 错误名称（如 "TypeError"、"NetworkError"）。 */
	name?: string;
	/** 错误消息文本。 */
	message: string;
	/** 错误堆栈（如果有的话）。 */
	stack?: string;
	/** 错误码（如 Node.js 的 ECONNREFUSED 或 HTTP 状态码）。 */
	code?: string | number;
}

/**
 * AssistantMessage 上的诊断信息条目。
 *
 * 谁使用：
 * - types.ts 中 AssistantMessage.diagnostics?: AssistantMessageDiagnostic[]
 * - 外部包通过 appendAssistantMessageDiagnostic() 追加到消息上
 */
export interface AssistantMessageDiagnostic {
	/** 诊断类型标识（如 "provider_error"、"overflow"、"retry"）。 */
	type: string;
	/** 诊断记录的时间戳（毫秒）。 */
	timestamp: number;
	/** 结构化的错误信息（如果有的话）。 */
	error?: DiagnosticErrorInfo;
	/** 附加的键值对详情（如请求参数、响应头等）。 */
	details?: Record<string, unknown>;
}

/**
 * 将未知类型的异常值格式化为可读字符串。
 *
 * 谁调用我：extractDiagnosticError()（当异常不是 Error 实例时）
 * 我调用谁：无
 *
 * 处理逻辑：
 * - Error 实例：返回 message 或 name
 * - 字符串：直接返回
 * - 其他类型：通过 String() 转换
 */
export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

/**
 * 从未知类型的异常中提取结构化的 DiagnosticErrorInfo。
 *
 * 谁调用我：createAssistantMessageDiagnostic()
 * 我调用谁：formatThrownValue()（当异常不是 Error 实例时）
 *
 * 处理逻辑：
 * - 非 Error 类型：返回 { name: "ThrownValue", message: formatThrownValue(value) }
 * - Error 类型：提取 name、message、stack、code（如果存在且为 string/number）
 */
export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	// Node.js 的 fs.readFile 等 API 抛出的 Error 会带 code: "ENOENT" 这样的字段，但 TypeScript 的 Error 类型定义里没有 code。所以用类型断言"骗"过编译器来读取它。
	// & 是交叉类型： Error 的所有属性 + 可选的 code 属性
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

/**
 * 创建一条 AssistantMessageDiagnostic 诊断记录。
 *
 * 谁调用我：
 * - 外部包（packages/agent、packages/coding-agent 等）在捕获错误时调用
 *
 * 我调用谁：extractDiagnosticError()（提取结构化错误信息）
 *
 * @param type 诊断类型标识
 * @param error 原始异常（可以是任何类型）
 * @param details 附加的调试详情（可选）
 */
export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

/**
 * 将诊断信息追加到 AssistantMessage 的 diagnostics 数组中。
 *
 * 谁调用我：
 * - 外部包在构造完诊断信息后调用，将其附加到消息上
 *
 * 我调用谁：无（纯数组操作）
 *
 * 使用不可变更新模式：创建新数组而非修改原数组，确保引用安全。
 */
export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
