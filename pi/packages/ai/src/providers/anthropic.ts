/**
 * Anthropic provider 定义。
 *
 * 文件定位：
 * - 这是 provider 注册层里的 Anthropic 入口
 * - 负责把 Claude 的 API 地址、模型列表、API Key / OAuth 两套认证方式绑定到统一 Provider 对象
 *
 * 调用链路：
 * - `providers/all.ts` 收集 provider
 * - 上层按 `id: "anthropic"` 选中该 provider
 * - 运行时通过 `anthropicMessagesApi()` 进入真正的 Messages API 流式实现
 */

import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadAnthropicOAuth } from "../utils/oauth/load.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

/**
 * 创建 Anthropic 的 provider 描述对象。
 *
 * 定位：provider 注册表中的声明函数，集中描述 Claude 可用模型、基础地址与认证策略。
 *
 * 关键点：
 * - 同时暴露 API Key 与 OAuth 登录能力
 * - API Key 检查优先读取 `ANTHROPIC_OAUTH_TOKEN`，便于复用 OAuth 登录态
 */
export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			// 优先复用 OAuth token；没有时再退回普通 API key。
			apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]),
			oauth: lazyOAuth({ name: "Anthropic (Claude Pro/Max)", load: loadAnthropicOAuth }),
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	});
}
