/**
 * auth-guidance.ts - 认证缺失场景的人类可读提示组装器
 *
 * 定位：core 层的轻量提示词辅助模块，专门负责把“缺少模型/缺少密钥”的内部状态
 * 转成用户可直接执行的说明文案。
 *
 * 作用：
 * - 统一 `/login`、`/model` 相关引导文案，避免多个调用点各自拼接
 * - 在模型未选择、模型列表为空、认证缺失等场景复用相同表述
 *
 * 调用关系：
 * - 被 `agent-session.ts` 的发送前校验逻辑调用
 * - 被模型解析和认证失败分支调用，生成最终展示给用户的错误消息
 */

import { join } from "node:path";
import { getDocsPath } from "../config.ts";

/** 未知提供商的标识常量 */
const UNKNOWN_PROVIDER = "unknown";

/**
 * 生成登录帮助段落。
 *
 * 定位：本文件的基础文案拼装函数。
 * 作用：统一返回 `/login` 命令说明和相关文档路径，供下游错误消息复用。
 * 调用关系：被 `formatNoModelsAvailableMessage()`、`formatNoModelSelectedMessage()`
 * 和 `formatNoApiKeyFoundMessage()` 直接调用。
 *
 * @returns 包含 `/login` 命令说明和文档路径的字符串
 */
export function getProviderLoginHelp(): string {
	return [
		"Use /login to configure a provider API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

/**
 * 生成“当前没有可用模型”提示。
 *
 * 定位：模型发现为空时的兜底文案。
 * 作用：告知用户当前没有任何可用模型，并附带统一的登录引导。
 * 调用关系：被模型选择与启动前检查流程调用。
 *
 * @returns 当没有可用模型时显示的错误提示
 */
export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

/**
 * 生成“尚未选择模型”提示。
 *
 * 定位：会话可启动但模型尚未确定时的引导文案。
 * 作用：提醒用户先完成登录，再执行 `/model` 选择模型。
 * 调用关系：被 `AgentSession.prompt()` 等发送前校验流程调用。
 *
 * @returns 当用户尚未选择模型时显示的提示，包含登录和选择模型的指引
 */
export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

/**
 * 生成“缺少指定 provider API key”提示。
 *
 * 定位：认证检查失败时的最终文案出口。
 * 作用：根据 provider 名称给出缺失说明，并拼接统一登录帮助段落。
 * 调用关系：被 `agent-session.ts`、模型恢复和认证校验相关流程调用。
 *
 * @param provider 提供商标识，如 "openai"、"anthropic"；传入 "unknown" 时显示 "the selected model"
 * @returns 包含缺失密钥说明和配置指引的错误提示
 */
export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
