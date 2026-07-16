/**
 * OpenAI provider 定义。
 *
 * 文件定位：
 * - 这是 provider 注册层里的 OpenAI 入口
 * - 负责把 OpenAI 的鉴权方式、模型清单、默认 base URL 与 API 实现绑定成统一的 Provider 对象
 *
 * 调用链路：
 * - `providers/all.ts` 收集各 provider
 * - 上层按 `id: "openai"` 查找 provider
 * - 运行时再通过 `openAIResponsesApi()` 进入真正的 Responses API 流式实现
 */

import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_MODELS } from "./openai.models.ts";

/**
 * 创建 OpenAI 的标准 provider 描述对象。
 *
 * 定位：provider 注册表里的轻量工厂函数，只负责声明元信息，不直接发起请求。
 *
 * 被谁调用：
 * - `providers/all.ts`
 *
 * 调用了谁：
 * - `envApiKeyAuth()` 生成 API Key 鉴权配置
 * - `openAIResponsesApi()` 生成 API 适配层
 * - `createProvider()` 规范化为统一 Provider 结构
 */
export function openaiProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: Object.values(OPENAI_MODELS),
		api: openAIResponsesApi(),
	});
}
