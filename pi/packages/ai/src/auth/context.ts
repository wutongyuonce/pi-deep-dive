import type { AuthContext } from "./types.ts";

interface NodeFsModule {
	access(path: string): Promise<void>;
}

interface NodeOsModule {
	homedir(): string;
}

// 使用变量形式的模块标识符，避免浏览器打包器尝试解析 Node 内置模块。
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

/** 从 globalThis 上安全获取 process.env，在浏览器环境中返回 undefined。 */
function getProcessEnv(): Record<string, string | undefined> | undefined {
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return proc?.env;
}

/**
 * 默认认证上下文
 *
 * 文件定位：为 auth 模块提供跨平台的认证上下文实现，是 AiKeyAuth.resolve() 的参数依赖。
 *
 * 功能概述：
 * - 读取环境变量（Node 下来自 process.env，浏览器下返回 undefined）
 * - 检查文件是否存在（仅 Node 下支持，浏览器下始终返回 false）
 *
 * 典型调用链：
 *   Models.getAuth() → resolveProviderAuth() → resolveApiKey() → defaultProviderAuthContext().env / .fileExists
 */
export function defaultProviderAuthContext(): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			const value = getProcessEnv()?.[name];
			// 空字符串视同未设置，与大多数 CLI 工具的行为一致。
			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		},

		async fileExists(path: string): Promise<boolean> {
			try {
				const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
				let resolved = path;
				// 展开 ~ 为用户主目录，支持如 ~/.aws/credentials 这类常见路径。
				if (resolved.startsWith("~")) {
					const os = (await importNodeModule("node:os")) as NodeOsModule;
					resolved = os.homedir() + resolved.slice(1);
				}
				await fs.access(resolved);
				return true;
			} catch {
				// access 失败（文件不存在、权限不足等）均视为不可访问。
				return false;
			}
		},
	};
}
