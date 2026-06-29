/**
 * 模型提供商显示名称映射模块
 *
 * 文件定位：coding-agent 的提供商名称展示层。
 * 作用：把内部 provider 标识转换为界面展示使用的稳定名称，避免各处重复硬编码。
 * 调用关系：由模型选择器、登录界面和会话信息展示等 UI 层读取。
 *
 * 提供：
 * - BUILT_IN_PROVIDER_DISPLAY_NAMES：内置提供商标识到人类可读显示名称的映射表
 *   用于 TUI 界面中展示友好的提供商名称（如 "anthropic" -> "Anthropic"）
 */
// 统一维护内置提供商的展示文案，新增 provider 时优先在这里补齐映射。
export const BUILT_IN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	deepseek: "DeepSeek",
	openai: "OpenAI",
	openrouter: "OpenRouter",
};
