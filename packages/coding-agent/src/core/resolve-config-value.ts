/**
 * 配置值解析器，将配置值（API key、header 等）解析为实际字符串。
 *
 * 文件定位：coding-agent 的配置值解析层，支持三种配置值格式：
 * - shell 命令：以 "!" 开头，执行命令取 stdout
 * - 环境变量：值作为环境变量名查找
 * - 字面量：直接作为值使用
 *
 * 提供：
 * - resolveConfigValue()：带缓存的配置值解析（用于 header 等可能重复的场景）
 * - resolveConfigValueUncached()：不缓存的解析（用于 API key 等敏感值）
 * - resolveConfigValueOrThrow()：解析失败时抛出异常
 * - resolveHeaders() / resolveHeadersOrThrow()：批量解析 header 字典
 * - clearConfigValueCache()：清除缓存（测试用）
 *
 * 调用链路：
 * - 被 model-registry.ts 调用，解析 models.json 中的 apiKey 和 headers
 * - 被 auth-storage.ts 调用，解析存储的认证信息
 */

import { execSync, spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.ts";

// shell 命令结果缓存（进程生命周期内有效）
const commandResultCache = new Map<string, string | undefined>();

/**
 * 解析配置值为实际字符串（带缓存）。
 *
 * 解析规则：
 * - 以 "!" 开头 → 执行 shell 命令，使用 stdout 结果（结果被缓存）
 * - 否则 → 先查找环境变量，找到则返回环境变量值；未找到则作为字面量返回
 *
 * @param config - 配置值字符串
 * @returns 解析后的实际值，解析失败返回 undefined
 */
export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

/** 使用配置的 shell 执行命令（Windows 平台优先尝试），返回是否执行和结果 */
function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args } = getShellConfig();
		const result = spawnSync(shell, [...args, command], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

/** 使用默认 shell（execSync）执行命令 */
function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** 执行 shell 命令（不带缓存），去掉 "!" 前缀后执行 */
function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				const configuredResult = executeWithConfiguredShell(command);
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

/** 执行 shell 命令（带缓存），相同命令只执行一次 */
function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * 不带缓存的配置值解析，用于 API key 等不应被缓存的敏感值。
 * 解析规则与 resolveConfigValue 相同。
 *
 * @param config - 配置值字符串
 * @returns 解析后的实际值，解析失败返回 undefined
 */
export function resolveConfigValueUncached(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommandUncached(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

/**
 * 解析配置值，解析失败时抛出带有描述信息的异常。
 *
 * @param config - 配置值字符串
 * @param description - 用于错误消息的描述（如 "API key for provider 'openai'"）
 * @returns 解析后的实际值
 * @throws 解析失败时抛出 Error
 */
export function resolveConfigValueOrThrow(config: string, description: string): string {
	const resolvedValue = resolveConfigValueUncached(config);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	if (config.startsWith("!")) {
		throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
	}

	throw new Error(`Failed to resolve ${description}`);
}

/**
 * 批量解析 header 字典中的所有值（使用与 API key 相同的解析逻辑，带缓存）。
 * 解析失败的 header 会被静默跳过。
 *
 * @param headers - 原始 header 字典
 * @returns 解析后的 header 字典，所有值解析失败时返回 undefined
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * 批量解析 header 字典中的所有值，任一值解析失败时抛出异常。
 *
 * @param headers - 原始 header 字典
 * @param description - 用于错误消息的描述
 * @returns 解析后的 header 字典
 * @throws 任一值解析失败时抛出 Error
 */
export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** 清除配置值的 shell 命令结果缓存。导出用于测试。 */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
