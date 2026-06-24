/**
 * 路径工具函数 (path-utils.ts)
 *
 * 本文件提供文件路径的解析、规范化和存在性检查工具函数。
 *
 * 定位：
 *   被 read、write、edit、find、grep、ls 等所有文件操作工具调用，
 *   统一处理路径解析逻辑。
 *
 * 提供的能力：
 *   1. 路径解析：expandPath（规范化）、resolveToCwd（相对路径转绝对路径）
 *   2. 路径存在性检查：pathExists（异步）、fileExists（同步，内部使用）
 *   3. macOS 特殊路径兼容：resolveReadPath / resolveReadPathAsync
 *      - AM/PM 截图文件名中的窄不换行空格（U+202F）
 *      - NFD Unicode 分解形式
 *      - 弯引号（U+2019）替代直引号
 *      - 法语 macOS 截图的组合情况
 *
 * 调用链路：
 *   read.ts resolveReadPathAsync → path-utils.ts resolveReadPathAsync → resolveToCwd + 各变体尝试
 *   write.ts / edit.ts / find.ts / grep.ts / ls.ts → resolveToCwd
 */

import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

/** macOS 截图文件名中 AM/PM 前使用的窄不换行空格字符 */
const NARROW_NO_BREAK_SPACE = "\u202F";

/**
 * 尝试将路径中的 AM/PM 前空格替换为窄不换行空格。
 * macOS 截图命名格式如 "Screenshot 2024-01-01 at 10.30.00 AM.png"
 */
function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

/**
 * 尝试将路径转换为 NFD（分解）Unicode 形式。
 * macOS 文件系统默认使用 NFD 存储文件名。
 */
function tryNFDVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

/**
 * 尝试将路径中的直引号 (') 替换为弯引号 (U+2019)。
 * macOS 截图名称如 "Capture d'écran" 使用 U+2019 而非 U+0027。
 */
function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

/**
 * 同步检查文件是否存在。
 * 内部使用，仅用于 resolveReadPath 的同步版本。
 */
function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 异步检查文件/目录是否存在。
 * 被 find.ts、ls.ts 等工具的 operations.exists 调用。
 */
export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 规范化路径：处理 Unicode 空格和 @ 前缀。
 * 委托给 utils/paths.ts 的 normalizePath，启用 Unicode 空格规范化和 @ 前缀剥离。
 */
export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * 将路径解析为相对于 cwd 的绝对路径。
 * 处理 ~ 展开和绝对路径。被所有文件操作工具调用。
 *
 * @param filePath  相对或绝对路径
 * @param cwd       当前工作目录
 * @returns 解析后的绝对路径
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * 同步版本的读取路径解析，带 macOS 兼容性回退。
 *
 * 解析步骤：
 *   1. 先尝试 resolveToCwd 得到的原始路径
 *   2. 回退尝试 AM/PM 窄空格变体
 *   3. 回退尝试 NFD Unicode 分解变体
 *   4. 回退尝试弯引号变体
 *   5. 回退尝试 NFD + 弯引号组合变体（法语 macOS 截图）
 *   6. 如果所有变体都不存在，返回原始解析路径
 *
 * @param filePath  文件路径
 * @param cwd       当前工作目录
 * @returns 解析后的路径
 */
export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// 尝试 macOS AM/PM 变体（AM/PM 前的窄不换行空格）
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// 尝试 NFD 变体（macOS 以 NFD 形式存储文件名）
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// 尝试弯引号变体（macOS 截图名称使用 U+2019）
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// 尝试 NFD + 弯引号组合变体（如法语 macOS 截图 "Capture d'écran"）
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

/**
 * 异步版本的读取路径解析，带 macOS 兼容性回退。
 * 与 resolveReadPath 逻辑相同，但使用异步文件存在性检查。
 * 被 read.ts 的 execute 方法调用。
 *
 * @param filePath  文件路径
 * @param cwd       当前工作目录
 * @returns 解析后路径的 Promise
 */
export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	if (await pathExists(resolved)) {
		return resolved;
	}

	// 尝试 macOS AM/PM 变体（AM/PM 前的窄不换行空格）
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		return amPmVariant;
	}

	// 尝试 NFD 变体（macOS 以 NFD 形式存储文件名）
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		return nfdVariant;
	}

	// 尝试弯引号变体（macOS 截图名称使用 U+2019）
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		return curlyVariant;
	}

	// 尝试 NFD + 弯引号组合变体（如法语 macOS 截图 "Capture d'écran"）
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}
