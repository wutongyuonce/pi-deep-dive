/**
 * 认证引导模块
 *
 * 提供用户友好的 API 密钥配置引导消息。当用户尚未配置模型提供商的 API 密钥时，
 * 生成格式化的提示信息，引导用户通过 /login 命令进行配置。
 * 被模型选择和认证检查流程使用。
 */

import { join } from "node:path";
import { getDocsPath } from "../config.ts";

/** 未知提供商的标识常量 */
const UNKNOWN_PROVIDER = "unknown";

/**
 * 生成提供商登录帮助信息
 * @returns 包含 /login 命令说明和文档路径的字符串
 */
export function getProviderLoginHelp(): string {
	return [
		"Use /login to configure a provider API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

/**
 * 格式化"无可用模型"错误消息
 * @returns 当没有可用模型时显示的错误提示
 */
export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

/**
 * 格式化"未选择模型"错误消息
 * @returns 当用户尚未选择模型时显示的提示，包含登录和选择模型的指引
 */
export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

/**
 * 格式化"未找到 API 密钥"错误消息
 * @param provider 提供商标识，如 "openai"、"anthropic"；传入 "unknown" 时显示 "the selected model"
 * @returns 包含缺失密钥说明和配置指引的错误提示
 */
export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
