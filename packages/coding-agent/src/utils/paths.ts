/**
 * 路径处理工具集
 *
 * 提供路径规范化、解析、相对路径计算、云同步标记等功能。
 * 被几乎所有需要路径操作的模块调用。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./child-process.ts";

/** Unicode 空格字符正则（非常规 ASCII 空格） */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 路径输入选项 */
export interface PathInputOptions {
	/** 规范化前去除首尾空白 */
	trim?: boolean;
	/** 展开开头的 `~` 为用户主目录，默认 true */
	expandTilde?: boolean;
	/** 用于 `~` 展开的主目录路径，默认为 `os.homedir()` */
	homeDir?: string;
	/** 去除开头的 `@`，用于 CLI 的 @file 路径参数 */
	stripAtPrefix?: boolean;
	/** 将 Unicode 空格变体规范化为常规空格 */
	normalizeUnicodeSpaces?: boolean;
}

/**
 * 将路径解析为规范化的真实路径（跟随符号链接）
 * 若解析失败（如目标不存在），回退返回原始路径，不会抛出异常
 * @param path - 输入路径
 * @returns 规范化的真实路径或原始路径
 */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * 判断路径值是否为本地路径（非 npm:/git:/http: 等远程源）
 * @param value - 路径字符串
 * @returns true 表示是本地路径（裸名、相对路径、file: URL 等）
 */
export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	// 已知的非本地路径前缀。file: URL 是本地路径，由 resolvePath() 负责解析
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	) {
		return false;
	}
	return true;
}

/**
 * 规范化路径输入：可选地修剪空白、Unicode 空格、@ 前缀和 ~ 展开
 * @param input - 原始路径输入
 * @param options - 规范化选项
 * @returns 规范化后的路径
 */
export function normalizePath(input: string, options: PathInputOptions = {}): string {
	let normalized = options.trim ? input.trim() : input;
	// 将 Unicode 空格变体替换为常规空格
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	// 去除 CLI 的 @ 前缀
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}

	// 展开 ~ 为用户主目录
	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}

	// 将 file:// URL 转为文件路径
	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}

	return normalized;
}

/**
 * 解析路径为绝对路径，支持相对路径和 ~ 展开
 * @param input - 输入路径
 * @param baseDir - 相对路径的基准目录，默认为当前工作目录
 * @param options - 路径规范化选项
 * @returns 解析后的绝对路径
 */
export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

/**
 * 获取文件相对于工作目录的路径
 * @param filePath - 文件路径
 * @param cwd - 工作目录
 * @returns 相对路径字符串，若文件不在工作目录下则返回 undefined
 */
export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = relative(resolvedCwd, resolvedPath);
	// 判断路径是否在工作目录内部（非 .. 开头且非绝对路径）
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	return isInsideCwd ? relativePath || "." : undefined;
}

/**
 * 格式化路径为相对于工作目录的路径，若不在工作目录下则返回绝对路径
 * 路径分隔符统一使用正斜杠 (/)
 * @param filePath - 文件路径
 * @param cwd - 工作目录
 * @returns 格式化后的路径字符串
 */
export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

/**
 * 将路径标记为云同步忽略（如 Dropbox、iCloud）
 * 通过设置文件系统扩展属性实现跨平台云同步排除
 * @param path - 要标记的文件/目录路径
 */
export function markPathIgnoredByCloudSync(path: string): void {
	// 根据平台选择需要设置的扩展属性
	const attrs =
		process.platform === "darwin"
			? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
			: process.platform === "linux"
				? ["user.com.dropbox.ignored"]
				: [];

	for (const attr of attrs) {
		if (process.platform === "darwin") {
			// macOS 使用 xattr 命令
			spawnProcessSync("xattr", ["-w", attr, "1", path], { encoding: "utf-8", stdio: "ignore" });
		} else {
			// Linux 使用 setfattr 命令
			spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], { encoding: "utf-8", stdio: "ignore" });
		}
	}
}
