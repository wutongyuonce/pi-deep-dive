/**
 * `@earendil-works/pi-ai` 的核心导出入口。
 *
 * 文件定位：
 * - 这是面向外部使用者的主入口之一
 * - 只导出“无副作用、可按需组合”的核心类型、工具和基础能力
 *
 * 设计意图：
 * - 避免在主入口里隐式引入 provider 工厂、全局注册表、生成目录或 OAuth 实现
 * - 让新代码优先通过 `createModels()`、provider factories 和 `src/api/*` 组合能力
 */

export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

// 主入口只保留 core exports，不附带 provider 工厂、compat 全局 API 或其他副作用模块。
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./api/anthropic-messages.ts";
export type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
export type { BedrockOptions, BedrockThinkingDisplay } from "./api/bedrock-converse-stream.ts";
export type { GoogleOptions } from "./api/google-generative-ai.ts";
export type { GoogleThinkingLevel } from "./api/google-shared.ts";
export type { GoogleVertexOptions } from "./api/google-vertex.ts";
export * from "./api/lazy.ts";
export type { MistralOptions } from "./api/mistral-conversations.ts";
export type { OpenAICodexResponsesOptions, OpenAICodexWebSocketDebugStats } from "./api/openai-codex-responses.ts";
export type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
export type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
export * from "./auth/context.ts";
export * from "./auth/credential-store.ts";
export * from "./auth/helpers.ts";
export * from "./auth/types.ts";
export * from "./images-models.ts";
export * from "./models.ts";
export * from "./providers/faux.ts";
export * from "./session-resources.ts";
export * from "./types.ts";
export * from "./utils/diagnostics.ts";
export * from "./utils/event-stream.ts";
export * from "./utils/json-parse.ts";
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./utils/oauth/types.ts";
export * from "./utils/overflow.ts";
export * from "./utils/retry.ts";
export * from "./utils/typebox-helpers.ts";
export * from "./utils/validation.ts";
