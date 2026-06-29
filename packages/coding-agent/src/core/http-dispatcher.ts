/**
 * HTTP 请求调度器配置模块
 *
 * 使用 undici 配置全局 HTTP 代理调度器，支持 HTTP 代理环境变量（HTTP_PROXY 等），
 * 并提供空闲超时的解析、格式化和预设选项。通过 configureHttpDispatcher() 在应用
 * 启动时初始化全局 HTTP 客户端。
 *
 * undici（意大利语"十一"）是 Node.js 官方的 HTTP 客户端库。
 * 它负责所有出站 HTTP 请求的底层收发，包括 AI API 调用。
 */

import * as undici from "undici";

// ── 默认值 ──────────────────────────────────────────────────────────

/**
 * 默认 HTTP 空闲超时时间
 * = 300,000 毫秒 = 5 分钟
 * 如果连接空闲超过这个时间，会被自动断开，释放资源。
 */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

/**
 * HTTP 空闲超时预设选项列表
 * 用户在 /settings 界面中可以选择这些预设值。
 * disabled（0）表示不限制超时。
 */
export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 }, // 默认值
	{ label: "disabled", timeoutMs: 0 }, // 不限制
] as const;

/**
 * 解析 HTTP 空闲超时值
 *
 * 支持灵活输入：
 * - 字符串 "disabled" → 0（不限制）
 * - 字符串 "300000"  → 300000（自动转数字）
 * - 数字 300000      → 300000
 * - 无效输入         → undefined（调用方抛错）
 *
 * @param value 输入值，支持字符串（"disabled"、"120" 等）或数字
 * @returns 解析后的毫秒数；"disabled" 返回 0；无效输入返回 undefined
 */
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0; // "disabled" 字符串，返回 0 表示不限制
		}
		if (trimmed.length === 0) {
			return undefined; // 空字符串，返回 undefined 表示无效
		}
		return parseHttpIdleTimeoutMs(Number(trimmed)); // 字符串转数字后递归解析
	}

	// 非数字 / 无穷大 / 负数 → 无效
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value); // 取整，去掉小数部分
}

/**
 * 将毫秒超时值格式化为人类可读标签
 *
 * 用于 /settings 界面的下拉列表显示：
 * 300000 → "5 min"
 * 75000  → "75 sec"（匹配不到预设时，自己算）
 *
 * @param timeoutMs 超时毫秒数
 * @returns 匹配预设选项的标签，否则返回 "X sec" 格式
 */
export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	// 先尝试匹配预设选项列表
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label; // 匹配到 "30 sec" / "5 min" 等
	}
	return `${timeoutMs / 1000} sec`; // 没匹配到就显示 "XX sec"
}

/**
 * 配置全局 HTTP 调度器
 *
 * 这是应用启动时调用的关键函数。它:
 * 1. 创建一个 EnvHttpProxyAgent，自动读取 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量
 * 2. 设置为 undici 的全局调度器，后续所有 fetch() 请求都走这个配置
 * 3. 调用 undici.install() 确保 Node.js 内置 fetch 也使用同一实现
 *
 * 因为它在 cli.ts 中比 main() 先执行，所以 provider SDK 发起任何 HTTP 请求前，
 * 代理和超时配置已经就绪。
 *
 * 运行时的超时设置可以被 SettingsManager 加载用户配置后覆盖（调用同一函数重新配置）。
 *
 * @param timeoutMs 空闲超时毫秒数，默认 5 分钟
 */
export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	// 标准化超时值：字符串转数字，"disabled" 转 0
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}

	// 创建"能自动读代理环境变量"的 HTTP 客户端
	// HTTP_PROXY= http://127.0.0.1:7890 之类的代理会自动生效
	undici.setGlobalDispatcher(
		new undici.EnvHttpProxyAgent({
			allowH2: false, // 不用 HTTP/2，代理兼容性更好
			bodyTimeout: normalizedTimeoutMs, // 等待响应体的超时（毫秒）
			headersTimeout: normalizedTimeoutMs, // 等待响应头的超时（毫秒）
		}),
	);

	// 用 undici 的 npm 版本覆盖内置版本，确保全局 fetch() 使用 npm 安装的 undici（而不是 Node 自带的）
	// 避免版本差异带来的问题
	undici.install?.();
}
