/**
 * Unicode 代理对清理工具模块。
 *
 * 文件定位：
 * - 提供清理字符串中非法 Unicode 代理字符的功能
 * - 未配对的代理字符（surrogate）会导致 JSON 序列化错误或 API 拒绝请求
 * - 正常的 emoji 和 BMP 以外的字符使用配对代理，不受影响
 *
 * 谁调用我：
 * - providers/openai-completions.ts：convertMessages() 中清理所有发送给 OpenAI 的文本
 * - providers/anthropic.ts：convertMessages() 中清理所有发送给 Anthropic 的文本
 * - providers/openai-responses-shared.ts：convertResponsesMessages() 中清理文本
 * - providers/images/openrouter.ts：buildParams() 中清理发送给 OpenRouter 的文本
 *
 * 调用链路：
 *   各 provider 的 convertMessages()
 *     -> sanitizeSurrogates(text)  在发送前清理文本中的非法代理字符
 */

export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
