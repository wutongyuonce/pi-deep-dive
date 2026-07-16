/**
 * DeepSeek provider 定义。
 *
 * 文件定位：
 * - 这是 provider 注册层里的 DeepSeek 入口
 * - 负责声明 DeepSeek 的模型清单、认证方式和默认网关地址
 *
 * 调用链路：
 * - `providers/all.ts` 收集 provider
 * - 上层选择 `id: "deepseek"` 后，最终转到 `openAICompletionsApi()` 执行
 *
 * 说明：
 * - DeepSeek 在这里复用 OpenAI Completions 兼容协议，而不是单独维护一套 API 实现
 */

import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { DEEPSEEK_MODELS } from "./deepseek.models.ts";

/**
 * 创建 DeepSeek 的 provider 描述对象。
 *
 * 定位：把 DeepSeek 的服务元信息接入统一 provider 注册表。
 */
export function deepseekProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
		models: Object.values(DEEPSEEK_MODELS),
		api: openAICompletionsApi(),
	});
}
