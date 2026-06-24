/**
 * 模型提供商显示名称映射模块
 *
 * 文件定位：coding-agent 的提供商名称展示层。
 *
 * 提供：
 * - BUILT_IN_PROVIDER_DISPLAY_NAMES：内置提供商标识到人类可读显示名称的映射表
 *   用于 TUI 界面中展示友好的提供商名称（如 "anthropic" -> "Anthropic"）
 */
export const BUILT_IN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	deepseek: "DeepSeek",
	openai: "OpenAI",
	openrouter: "OpenRouter",
};
