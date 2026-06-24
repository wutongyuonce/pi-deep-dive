/**
 * HTTP User-Agent 字符串生成工具
 *
 * 格式：pi/{version} ({platform}; {runtime}; {arch})
 * 被版本检查和 API 请求调用。
 */

/**
 * 生成 pi 的 HTTP User-Agent 字符串
 * @param version - pi 当前版本号
 * @returns 格式化的 User-Agent 字符串，例如 "pi/1.0.0 (darwin; node/v20.0.0; arm64)"
 */
export function getPiUserAgent(version: string): string {
	// 根据运行时类型选择 bun 或 node 标识
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
