import type { KnownProvider } from "./types.ts";

/**
 * 获取指定 provider 对应的环境变量名列表。
 *
 * 不同 provider 使用不同的环境变量存储 API 密钥：
 * - anthropic: ANTHROPIC_API_KEY
 * - openai: OPENAI_API_KEY
 * - deepseek: DEEPSEEK_API_KEY
 * - openrouter: OPENROUTER_API_KEY
 *
 * 返回数组是为了支持一个 provider 有多个备选环境变量的场景（目前未使用）。
 * 返回 undefined 表示该 provider 没有已知的环境变量映射。
 */
function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	// Anthropic 单独处理
	if (provider === "anthropic") {
		// 返回一个只包含一个元素的数组
		return ["ANTHROPIC_API_KEY"];
	}

	// 其他 provider 用一个对象映射：key 是 provider 名，value 是环境变量名
	// Record<string, string> 表示"键和值都是字符串的对象"
	const envMap: Record<string, string> = {
		deepseek: "DEEPSEEK_API_KEY",
		openai: "OPENAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};

	// 用 provider 名作为 key 去查找对应的环境变量名
	// 如果 provider 不在 envMap 中，envVar 就是 undefined
	const envVar = envMap[provider];

	// 三元表达式：条件 ? 值1 : 值2
	// 如果 envVar 存在（不是 undefined），返回 [envVar]
	// 如果 envVar 不存在，返回 undefined
	return envVar ? [envVar] : undefined;
}

/**
 * 查找指定 provider 在环境变量中已设置的 API 密钥变量名。
 *
 * 与 getEnvApiKey 的区别：
 * - findEnvKeys 返回的是变量名（如 "OPENAI_API_KEY"），不返回值
 * - getEnvApiKey 返回的是变量的值（如 "sk-xxx"）
 *
 * 用途：诊断 / 调试时检查哪些环境变量已设置。
 *
 * @returns 已设置的环境变量名数组，如果没有则返回 undefined
 */
// 下面三行是"函数重载"：同一个函数名，不同的参数类型，不同的返回类型
// TypeScript 会根据调用时传入的参数类型，选择正确的签名
export function findEnvKeys(provider: KnownProvider): string[] | undefined; // 重载 1：传 KnownProvider
export function findEnvKeys(provider: string): string[] | undefined; // 重载 2：传 string
export function findEnvKeys(provider: string): string[] | undefined {
	// 实现：处理所有情况
	// 第一步：获取这个 provider 对应的环境变量名列表
	// 例如 provider = "openai" → envVars = ["OPENAI_API_KEY"]
	const envVars = getApiKeyEnvVars(provider);

	// 如果没有对应的环境变量映射，直接返回 undefined
	if (!envVars) return undefined;

	// 第二步：过滤出实际已设置的环境变量
	// process.env 是 Node.js 的全局对象，包含所有环境变量
	// .filter() 遍历数组，只保留满足条件的元素
	// !! 是双重否定，把值转为 boolean（有值 → true，无值 → false）
	const found = envVars.filter((envVar) => !!process.env[envVar]);

	// 如果找到了已设置的变量，返回变量名数组；否则返回 undefined
	// found.length > 0 是条件判断：数组不为空
	return found.length > 0 ? found : undefined;
}

/**
 * 获取指定 provider 的 API 密钥（从环境变量中读取）。
 *
 * 调用链：
 * - provider 的 streamSimple 函数在未收到显式 apiKey 时调用此函数
 * - 例如 streamSimpleAnthropic 中：`options?.apiKey || getEnvApiKey(model.provider)`
 *
 * 优先级：显式传入的 apiKey > 环境变量 > undefined
 *
 * @returns API 密钥字符串，如果环境变量未设置则返回 undefined
 */
// 同样是函数重载
export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: string): string | undefined {
	// 第一步：查找已设置的环境变量名
	// 例如 provider = "openai" → envKeys = ["OPENAI_API_KEY"]
	const envKeys = findEnvKeys(provider);

	// 第二步：读取环境变量的值
	// envKeys?.[0] 是"可选链"语法：
	// - 如果 envKeys 是 undefined，整个表达式返回 undefined（不会报错）
	// - 如果 envKeys 是数组，取第一个元素
	// 等价于：envKeys ? envKeys[0] : undefined
	if (envKeys?.[0]) {
		// process.env["OPENAI_API_KEY"] 读取环境变量的值
		// 例如返回 "sk-xxx..."
		return process.env[envKeys[0]];
	}

	// 没有找到已设置的环境变量，返回 undefined
	return undefined;
}
