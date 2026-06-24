/**
 * 渲染工具函数 (render-utils.ts)
 *
 * 本文件提供工具输出在 TUI 中渲染时使用的通用文本处理函数。
 *
 * 定位：
 *   被所有工具文件（bash、read、write、edit、find、grep、ls）的 renderCall 和
 *   renderResult 方法调用，用于格式化显示文本。
 *
 * 提供的能力：
 *   1. shortenPath：将主目录路径缩写为 ~ 前缀
 *   2. str：安全提取参数值为字符串（null/undefined → ""，非字符串 → null）
 *   3. replaceTabs：将制表符替换为空格（用于代码高亮显示）
 *   4. normalizeDisplayText：去除回车符 (\r)
 *   5. getTextOutput：从工具结果中提取纯文本，处理图片回退显示
 *   6. invalidArgText：生成 "invalid arg" 错误提示
 */

import * as os from "node:os";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

/**
 * 将路径中的主目录缩写为 ~ 前缀。
 * 例如 "/Users/foo/bar" → "~/bar"
 */
export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * 安全地将参数值转换为字符串。
 *
 * @returns 字符串值：原始字符串、null/undefined → ""，其他类型 → null（表示参数无效）
 */
export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

/**
 * 将制表符替换为 3 个空格，用于代码内容的终端显示。
 */
export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * 去除文本中的回车符 (\r)，统一为 Unix 换行格式。
 */
export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/**
 * 从工具执行结果中提取纯文本输出。
 *
 * 处理逻辑：
 *   1. 提取所有 text 类型的内容块，去除 ANSI 转义序列
 *   2. 如果有图片块但终端不支持图片显示，用文本占位符替代
 *
 * @param result       工具执行结果
 * @param showImages   是否显示图片
 * @returns 拼接后的纯文本输出
 */
export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

/**
 * 工具渲染结果的通用类型，包含内容和详情。
 */
export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

/**
 * 生成参数无效时的提示文本，使用 error 颜色主题。
 */
export function invalidArgText(theme: { fg: (name: any, text: string) => string }): string {
	return theme.fg("error", "[invalid arg]");
}
