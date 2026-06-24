/**
 * 版本检查工具
 *
 * 从 pi.dev API 获取最新版本信息，支持语义化版本比较。
 * 被自更新流程和启动时版本提示调用。
 */
import { getPiUserAgent } from "./pi-user-agent.ts";

/** pi 最新版本 API 地址 */
const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
/** 版本检查请求超时时间（毫秒） */
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

/** pi 最新版本发布信息 */
export interface LatestPiRelease {
	version: string; // 版本号
	packageName?: string; // npm 包名（可选）
	note?: string; // 版本说明（可选）
}

/** 解析后的语义化版本号 */
interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string; // 预发布标识（如 "beta.1"）
}

/**
 * 解析语义化版本号字符串
 * @param version - 版本号字符串（如 "1.2.3"、"v1.2.3-beta.1"）
 * @returns 解析后的版本对象，格式不合法返回 undefined
 */
function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

/**
 * 比较两个语义化版本号
 * @param leftVersion - 左侧版本号
 * @param rightVersion - 右侧版本号
 * @returns 负数（left < right）、正数（left > right）、0（相等），解析失败返回 undefined
 */
export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	// 按 major → minor → patch → prerelease 顺序逐级比较
	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1; // 无预发布标识的版本更新
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

/**
 * 判断候选版本是否比当前版本更新
 * @param candidateVersion - 候选版本号
 * @param currentVersion - 当前版本号
 * @returns true 表示候选版本更新
 */
export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	// 无法解析时进行字符串比较
	return candidateVersion.trim() !== currentVersion.trim();
}

/**
 * 从 pi.dev API 获取最新版本发布信息
 * @param currentVersion - 当前版本号（用于 User-Agent）
 * @param options - 可选项（超时时间等）
 * @returns 最新版本信息，请求失败或跳过检查返回 undefined
 */
export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	// 环境变量可跳过版本检查或离线模式
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	// 验证返回的版本号格式
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

/**
 * 获取最新版本号（简化接口）
 * @param currentVersion - 当前版本号
 * @param options - 可选项
 * @returns 最新版本号字符串，失败返回 undefined
 */
export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

/**
 * 检查是否有新版本可用
 * @param currentVersion - 当前版本号
 * @returns 若有更新版本则返回版本发布信息，否则返回 undefined
 */
export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
