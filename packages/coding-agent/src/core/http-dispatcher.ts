/**
 * HTTP 请求调度器配置模块
 *
 * 使用 undici 配置全局 HTTP 代理调度器，支持 HTTP 代理环境变量（HTTP_PROXY 等），
 * 并提供空闲超时的解析、格式化和预设选项。通过 configureHttpDispatcher() 在应用
 * 启动时初始化全局 HTTP 客户端。
 */

import * as undici from "undici";

/** 默认 HTTP 空闲超时时间（5 分钟，单位毫秒） */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

/** HTTP 空闲超时预设选项列表 */
export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

/**
 * 解析 HTTP 空闲超时值
 * @param value 输入值，支持字符串（"disabled"、"120" 等）或数字
 * @returns 解析后的毫秒数；"disabled" 返回 0；无效输入返回 undefined
 */
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

/**
 * 将毫秒超时值格式化为人类可读标签
 * @param timeoutMs 超时毫秒数
 * @returns 匹配预设选项的标签，否则返回 "X sec" 格式
 */
export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

/**
 * 配置全局 HTTP 调度器
 * 创建支持代理的 undici 全局调度器，设置 body 超时和 headers 超时。
 * 同时调用 undici.install() 确保全局 fetch 使用相同的 undici 实现，
 * 避免 Node 26.0+ 中内置 fetch 与 npm undici 不兼容导致的解压问题。
 *
 * @param timeoutMs 空闲超时毫秒数，默认 5 分钟
 */
export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	undici.setGlobalDispatcher(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			headersTimeout: normalizedTimeoutMs,
		}),
	);
	// 保持 fetch 和 dispatcher 使用同一 undici 实现。Node 26.0 的内置 fetch
	// 可能通过 npm undici 的 dispatcher 消费压缩响应但未解压，导致 response.json() 失败。
	undici.install?.();
}
