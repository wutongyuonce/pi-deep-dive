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
 * 定位：配置值解析的缓存入口。
 * 作用：把命令式、环境变量式和字面量式配置统一解析成字符串，并缓存 shell 结果。
 * 调用关系：被模型配置与认证读取流程调用；内部按需委托给 `executeCommand()`。
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
		// 命令型配置走缓存路径，避免同一 header 重复启动子进程。
		return executeCommand(config);
	}
	// 非命令型配置先尝试环境变量，再兜底为字面量。
	const envValue = process.env[config];
	return envValue || config;
}

/**
 * 定位：Windows 优先的 shell 执行适配层。
 * 作用：按 `getShellConfig()` 解析出的 shell/参数运行命令，并区分“没执行到”和“执行失败”。
 * 调用关系：仅由 `executeCommandUncached()` 在 Windows 分支调用。
 */
function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args } = getShellConfig();
		// 先按配置的 shell 启动子进程，避免直接依赖系统默认 shell。
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

/**
 * 定位：默认 shell 的兜底执行器。
 * 作用：在非 Windows 或配置 shell 不可用时，用 `execSync` 获取命令输出。
 * 调用关系：由 `executeCommandUncached()` 直接调用，或作为 Windows 分支的回退路径。
 */
function executeWithDefaultShell(command: string): string | undefined {
	try {
		// 只关心 stdout 结果，stderr 被静默抑制以保持调用侧接口简单。
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

/**
 * 定位：命令型配置的无缓存执行入口。
 * 作用：去掉前缀后执行命令，并按平台选择合适的 shell 路径。
 * 调用关系：被 `resolveConfigValueUncached()` 和 `executeCommand()` 调用。
 */
function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				// Windows 先尝试配置 shell；若 shell 缺失再回退到默认执行方式。
				const configuredResult = executeWithConfiguredShell(command);
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

/**
 * 定位：命令型配置的缓存包装器。
 * 作用：保证同一条 shell 配置在进程生命周期内最多执行一次。
 * 调用关系：仅由 `resolveConfigValue()` 调用。
 */
function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	// 首次解析时真正执行命令，并把 undefined 结果也一并缓存下来。
	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * 定位：敏感配置值的即时解析入口。
 * 作用：在不使用缓存的前提下解析 API key 等敏感值，避免旧值滞留。
 * 调用关系：被认证和 provider 配置读取链路调用；内部复用无缓存命令执行逻辑。
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
 * 定位：配置值解析的强约束入口。
 * 作用：在调用方必须拿到有效值时，把 `undefined` 结果提升为带上下文的异常。
 * 调用关系：由需要强校验的 API key、header 解析流程调用。
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
 * 定位：header 字典的宽松批量解析入口。
 * 作用：逐项解析 header 值，跳过失败项，给 provider 请求组装可用的子集。
 * 调用关系：由模型注册表等需要读取可选 headers 的逻辑调用。
 *
 * @param headers - 原始 header 字典
 * @returns 解析后的 header 字典，所有值解析失败时返回 undefined
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		// 按键逐个解析，只保留成功得到值的 header。
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * 定位：header 字典的严格批量解析入口。
 * 作用：要求每个 header 都能成功解析，否则立即抛错阻断后续请求。
 * 调用关系：由必须保证 header 完整性的调用点使用。
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
		// 逐项强校验，确保错误消息能带上具体的 header 名称。
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** 清除配置值的 shell 命令结果缓存。导出用于测试。 */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
