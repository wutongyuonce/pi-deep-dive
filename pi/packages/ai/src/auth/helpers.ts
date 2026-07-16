import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * 标准 API key 认证
 *
 * 定位：生成常规 API key 认证的工厂函数。适用于大多数需要通过环境变量或存储 key
 * 来认证的 provider。
 *
 * 解析策略：
 * - 存储的 credential.key 优先
 * - 否则按顺序检查传入的环境变量列表，使用第一个已设置的值
 * - 都未设置时返回 undefined，表示 provider 未配置
 *
 * 被谁调用：
 *   - 各 provider 定义中作为 auth.apiKey 的工厂（如 anthropic、openai 等）
 *
 * @param name 认证的显示名称，如 "Anthropic API key"
 * @param envVars 要检查的环境变量列表，按优先级排序
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: `Enter ${name}` });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			// 存储的 key 优先，用户显式配置的覆盖环境变量。
			if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
			// 遍历环境变量列表，取第一个已设置的值。
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * 延迟加载 OAuth 认证实现
 *
 * 定位：为 OAuth 认证提供懒加载包装器。provider 定义中使用此函数声明 OAuth 支持，
 * 实际实现（如 Bedrock、GitHub Copilot 的 OAuth 流程）延迟到首次调用时才动态导入，
 * 避免将 Node-only 的流程代码打入浏览器 bundle。
 *
 * 被谁调用：
 *   - 各 provider 定义中作为 auth.oauth 的工厂
 *
 * @param input.name 认证的显示名称
 * @param input.load 返回 OAuthAuth 实现的动态导入函数
 */
export function lazyOAuth(input: { name: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
	// 加载 promise 缓存，多次调用共享同一加载过程。
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		login: async (callbacks) => (await loaded()).login(callbacks),
		refresh: async (credential) => (await loaded()).refresh(credential),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
