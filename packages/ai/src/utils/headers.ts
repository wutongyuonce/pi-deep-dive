/**
 * HTTP Headers 工具模块。
 *
 * 文件定位：
 * - 提供 Headers 对象与普通 Record 之间的转换工具
 * - Web API 的 Headers 对象不可直接序列化，需要转为 Record<string, string>
 *   才能传递给 onResponse 回调或日志系统
 *
 * 谁调用我：
 * - providers/openai-completions.ts：streamOpenAICompletions() 中将 HTTP 响应头转为 Record
 * - providers/openai-responses.ts：streamOpenAIResponses() 中将 HTTP 响应头转为 Record
 * - providers/anthropic.ts：streamAnthropic() 中将 HTTP 响应头转为 Record
 * - providers/images/openrouter.ts：generateImagesOpenRouter() 中将 HTTP 响应头转为 Record
 *
 * 调用链路：
 *   各 provider 的 stream 函数
 *     -> client.create().withResponse()  拿到 HTTP response
 *     -> headersToRecord(response.headers)  转为可序列化的 Record
 *     -> options.onResponse({ headers })  传给回调
 */

/**
 * 将 Web API 的 Headers 对象转换为普通的 Record<string, string>。
 *
 * 谁调用我：
 * - openai-completions.ts 的 streamOpenAICompletions()
 * - openai-responses.ts 的 streamOpenAIResponses()
 * - anthropic.ts 的 streamAnthropic()
 * - images/openrouter.ts 的 generateImagesOpenRouter()
 *
 * 我调用谁：无（纯数据转换）
 *
 * 为什么需要这个：
 * - Web API 的 Headers 是一个类 Map 的迭代器对象，不可直接 JSON.stringify
 * - onResponse 回调期望拿到普通的键值对对象
 * - headers.entries() 返回 [key, value] 的迭代器，for-of 遍历即可
 */
export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}
