/**
 * 遥测模块
 *
 * 判断安装遥测（install telemetry）是否启用。优先读取环境变量 PI_TELEMETRY，
 * 若未设置则回退到 SettingsManager 中的配置值。
 */

import type { SettingsManager } from "./settings-manager.ts";

/**
 * 判断环境变量值是否为"真"
 * @param value 环境变量值
 * @returns 如果值为 "1"、"true" 或 "yes"（不区分大小写）则返回 true
 */
function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * 检查安装遥测是否启用
 * 优先级：环境变量 PI_TELEMETRY > SettingsManager 配置
 *
 * @param settingsManager 设置管理器实例
 * @param telemetryEnv 环境变量值，默认读取 process.env.PI_TELEMETRY
 * @returns 遥测是否启用
 */
export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
