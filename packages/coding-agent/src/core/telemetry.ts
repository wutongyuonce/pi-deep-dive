/**
 * 遥测模块
 *
 * 判断安装遥测（install telemetry）是否启用。优先读取环境变量 PI_TELEMETRY，
 * 若未设置则回退到 SettingsManager 中的配置值。
 */

import type { SettingsManager } from "./settings-manager.ts";

/**
 * 定位：遥测开关解析里的环境变量布尔解释器。
 * 作用：把字符串形式的环境变量值统一折叠为布尔语义，避免调用方重复判断。
 * 调用关系：仅由 `isInstallTelemetryEnabled()` 调用，用来优先解释 `PI_TELEMETRY`。
 *
 * @param value 环境变量值
 * @returns 如果值为 "1"、"true" 或 "yes"（不区分大小写）则返回 true
 */
function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	// 兼容常见的启用写法，便于 shell 和 CI 中统一配置。
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * 定位：安装遥测总开关的最终判定入口。
 * 作用：按照“环境变量优先、设置项兜底”的顺序给调用方返回稳定布尔值。
 * 调用关系：被安装、更新等需要上报匿名遥测的流程调用。
 *
 * @param settingsManager 设置管理器实例
 * @param telemetryEnv 环境变量值，默认读取 process.env.PI_TELEMETRY
 * @returns 遥测是否启用
 */
export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	// 先尊重进程级覆盖，便于用户临时禁用或强制开启。
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
