/**
 * Node.js HTTP 代理工具模块。
 *
 * 文件定位：
 * - 提供基于环境变量的 HTTP/HTTPS 代理支持
 * - 遵循标准的代理环境变量规范：HTTP_PROXY、HTTPS_PROXY、ALL_PROXY、NO_PROXY
 * - 创建 HttpProxyAgent/HttpsProxyAgent 实例，供 Node.js HTTP 客户端使用
 *
 * 谁调用我：
 * - 目前包内部无直接导入（未通过 index.ts 导出）
 * - 可能供外部包直接引用，或作为未来 provider 代理支持的基础设施
 *
 * 调用链路：
 *   createHttpProxyAgentsForTarget(targetUrl)
 *     -> resolveHttpProxyUrlForTarget(targetUrl)
 *       -> getProxyForUrl(targetUrl)
 *         -> parseProxyTargetUrl(targetUrl)   解析目标 URL
 *         -> shouldProxyHostname(hostname, port)  检查 NO_PROXY 规则
 *           -> getProxyEnv("no_proxy")        读取环境变量
 *         -> getProxyEnv(`${protocol}_proxy`)  读取协议对应的代理变量
 *         -> getProxyEnv("all_proxy")          读取通用代理变量
 *     -> new HttpProxyAgent(proxyUrl)          创建 HTTP 代理 agent
 *     -> new HttpsProxyAgent(proxyUrl)         创建 HTTPS 代理 agent
 */

import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

/** 各协议的默认端口号，当 URL 中未指定端口时使用。 */
const DEFAULT_PROXY_PORTS: Record<string, number> = {
	ftp: 21,
	gopher: 70,
	http: 80,
	https: 443,
	ws: 80,
	wss: 443,
};

/**
 * HTTP 和 HTTPS 代理 agent 对。
 * 传给 Node.js 的 http.request() 或 fetch() 以通过代理发送请求。
 */
export interface NodeHttpProxyAgents {
	httpAgent: HttpAgent;
	httpsAgent: HttpsAgent;
}

/** 不支持的代理协议的错误提示信息。 */
export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
	"Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

/**
 * 从环境变量中读取代理配置值。
 * 同时检查小写和大写形式（如 http_proxy 和 HTTP_PROXY）。
 *
 * 谁调用我：
 * - shouldProxyHostname()（读取 no_proxy）
 * - getProxyForUrl()（读取协议代理变量和 all_proxy）
 */
function getProxyEnv(key: string): string {
	return process.env[key.toLowerCase()] || process.env[key.toUpperCase()] || "";
}

/**
 * 将目标 URL 字符串解析为 URL 对象。
 *
 * 谁调用我：getProxyForUrl()
 *
 * 处理逻辑：
 * - 如果已经是 URL 实例，直接返回
 * - 尝试 new URL() 解析，失败则返回 undefined
 */
function parseProxyTargetUrl(targetUrl: string | URL): URL | undefined {
	if (targetUrl instanceof URL) {
		return targetUrl;
	}

	try {
		return new URL(targetUrl);
	} catch {
		return undefined;
	}
}

/**
 * 检查某个主机名和端口是否应该使用代理。
 * 根据 NO_PROXY 环境变量判断。
 *
 * 谁调用我：getProxyForUrl()
 * 我调用谁：getProxyEnv("no_proxy")
 *
 * NO_PROXY 规则：
 * - 空字符串或未设置：所有请求都走代理
 * - "*"：所有请求都不走代理
 * - 逗号或空格分隔的列表：匹配的主机名不走代理
 *   - 精确匹配：如 "localhost"、"127.0.0.1"
 *   - 带端口匹配：如 "localhost:8080"
 *   - 通配符匹配：如 "*.example.com"（以 * 开头）
 */
function shouldProxyHostname(hostname: string, port: number): boolean {
	const noProxy = getProxyEnv("no_proxy").toLowerCase();
	if (!noProxy) {
		return true;
	}
	if (noProxy === "*") {
		return false;
	}

	// 遍历 NO_PROXY 列表，检查是否所有条目都不匹配（every 返回 true 表示应该走代理）
	return noProxy.split(/[,\s]/).every((proxy) => {
		if (!proxy) {
			return true;
		}

		// 解析带端口的条目（如 "localhost:8080"）
		const parsedProxy = proxy.match(/^(.+):(\d+)$/);
		let proxyHostname = parsedProxy ? parsedProxy[1] : proxy;
		const proxyPort = parsedProxy ? Number.parseInt(parsedProxy[2]!, 10) : 0;
		// 如果指定了端口且不匹配，跳过此条目（不阻止代理）
		if (proxyPort && proxyPort !== port) {
			return true;
		}

		// 精确匹配（不以 . 或 * 开头）
		if (!/^[.*]/.test(proxyHostname)) {
			return hostname !== proxyHostname;
		}

		// 通配符匹配（如 *.example.com）
		if (proxyHostname.startsWith("*")) {
			proxyHostname = proxyHostname.slice(1);
		}
		return !hostname.endsWith(proxyHostname);
	});
}

/**
 * 获取目标 URL 应使用的代理 URL。
 *
 * 谁调用我：resolveHttpProxyUrlForTarget()
 * 我调用谁：
 * - parseProxyTargetUrl()（解析目标 URL）
 * - shouldProxyHostname()（检查 NO_PROXY 规则）
 * - getProxyEnv()（读取代理环境变量）
 *
 * 查找顺序：
 * 1. 检查 NO_PROXY，如果匹配则不使用代理
 * 2. 查找协议专用变量（如 HTTPS_PROXY）
 * 3. 回退到 ALL_PROXY
 * 4. 如果代理 URL 没有协议前缀，自动添加
 */
function getProxyForUrl(targetUrl: string | URL): string {
	const parsedUrl = parseProxyTargetUrl(targetUrl);
	if (!parsedUrl?.protocol || !parsedUrl.host) {
		return "";
	}

	const protocol = parsedUrl.protocol.split(":", 1)[0]!;
	const hostname = parsedUrl.host.replace(/:\d*$/, "");
	const port = Number.parseInt(parsedUrl.port, 10) || DEFAULT_PROXY_PORTS[protocol] || 0;

	// NO_PROXY 检查
	if (!shouldProxyHostname(hostname, port)) {
		return "";
	}

	// 查找代理：协议专用变量 > ALL_PROXY
	let proxy = getProxyEnv(`${protocol}_proxy`) || getProxyEnv("all_proxy");
	// 如果代理 URL 没有协议前缀，自动添加（兼容 "localhost:8080" 形式）
	if (proxy && !proxy.includes("://")) {
		proxy = `${protocol}://${proxy}`;
	}
	return proxy;
}

/**
 * 解析目标 URL 对应的代理 URL。
 *
 * 谁调用我：createHttpProxyAgentsForTarget()
 * 我调用谁：getProxyForUrl()
 *
 * 返回值：
 * - URL 对象：有效的代理地址
 * - undefined：不需要代理或目标 URL 无效
 *
 * 错误处理：
 * - 代理 URL 格式无效：抛出 Error
 * - 代理协议不是 http/https：抛出 Error（不支持 SOCKS/PAC）
 */
export function resolveHttpProxyUrlForTarget(targetUrl: string | URL): URL | undefined {
	const proxy = getProxyForUrl(targetUrl);
	if (!proxy) {
		return undefined;
	}

	let proxyUrl: URL;
	try {
		proxyUrl = new URL(proxy);
	} catch (error) {
		throw new Error(
			`Invalid proxy URL ${JSON.stringify(proxy)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// 仅支持 HTTP 和 HTTPS 代理，不支持 SOCKS、PAC 等
	if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
		throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
	}

	return proxyUrl;
}

/**
 * 为目标 URL 创建 HTTP/HTTPS 代理 agent 对。
 *
 * 谁调用我：
 * - 外部包或其他模块（目前包内部无直接导入）
 *
 * 我调用谁：
 * - resolveHttpProxyUrlForTarget()（解析代理 URL）
 * - new HttpProxyAgent()（创建 HTTP 代理 agent）
 * - new HttpsProxyAgent()（创建 HTTPS 代理 agent）
 *
 * 返回值：
 * - NodeHttpProxyAgents 对象：包含 httpAgent 和 httpsAgent
 * - undefined：不需要代理
 */
export function createHttpProxyAgentsForTarget(targetUrl: string | URL): NodeHttpProxyAgents | undefined {
	const proxyUrl = resolveHttpProxyUrlForTarget(targetUrl);
	if (!proxyUrl) {
		return undefined;
	}

	return {
		httpAgent: new HttpProxyAgent(proxyUrl),
		httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
	};
}
