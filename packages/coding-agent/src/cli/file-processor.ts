/**
 * @file CLI @file 参数处理器，将用户通过 @file 语法传入的文件转换为文本内容和图片附件
 *
 * 文件定位：CLI 参数处理层，负责文件 I/O 和格式转换。
 * 调用链位置：用户在 CLI 中使用 @file 语法 -> ../cli.ts -> processFileArguments() -> 返回结构化的文件内容
 *
 * 提供的能力：
 *   - 解析 @file 参数中的文件路径（支持 ~ 展开和 macOS 截图的 Unicode 空格）
 *   - 自动识别文件类型（图片 vs 文本），分别处理
 *   - 图片文件自动缩放至内联尺寸限制以内，并转为 base64
 *   - 文本文件读取内容并用 <file> XML 标签包裹
 *   - 文件不存在或读取失败时输出错误信息并退出
 *
 * 与其他文件的关系：
 *   - 被 ../cli.ts 在处理初始消息时调用，将 @file 参数列表传入
 *   - 调用 resolveReadPath（来自 core/tools/path-utils.ts）解析文件路径
 *   - 调用 resizeImage / formatDimensionNote（来自 utils/image-resize.ts）处理图片缩放
 *   - 调用 detectSupportedImageMimeTypeFromFile（来自 utils/mime.ts）检测图片 MIME 类型
 *   - 返回的 ProcessedFiles 对象供 initial-message.ts 构建初始消息时使用
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

/**
 * 文件处理结果接口
 */
export interface ProcessedFiles {
	/** 所有文本文件和图片引用合并后的文本内容 */
	text: string;
	/** 所有图片文件处理后的 ImageContent 数组 */
	images: ImageContent[];
}

/**
 * 文件处理选项接口
 */
export interface ProcessFileOptions {
	/** 是否自动将图片缩放至 2000x2000 以内，默认为 true */
	autoResizeImages?: boolean;
}

/**
 * 处理 @file 参数列表，将每个文件解析为文本内容或图片附件。
 *
 * 逐个处理 fileArgs 中的文件路径：
 *   1. 展开并解析路径（处理 ~ 和 Unicode 空格等特殊字符）
 *   2. 校验文件存在性和非空性
 *   3. 检测 MIME 类型，区分图片文件和文本文件
 *   4. 图片文件：自动缩放后转为 base64 附件，并在文本中生成引用占位符
 *   5. 文本文件：读取内容并用 <file> XML 标签包裹
 *
 * 调用者：../cli.ts（在解析 CLI 参数并构建初始消息时调用）
 * 调用了：
 *   - resolveReadPath() - 解析文件路径（处理 ~ 展开和 Unicode 空格）
 *   - detectSupportedImageMimeTypeFromFile() - 检测文件是否为支持的图片格式
 *   - resizeImage() - 将图片缩放至内联尺寸限制以内
 *   - formatDimensionNote() - 生成图片尺寸信息的文本说明
 *
 * @param fileArgs - 用户通过 @file 语法传入的文件路径列表
 * @param options - 可选的处理选项
 * @param options.autoResizeImages - 是否自动缩放图片，默认 true
 * @returns ProcessedFiles - 包含合并文本和图片附件数组的处理结果
 */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	// 默认启用图片自动缩放
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// 展开并解析路径：resolveReadPath 处理 ~ 展开和 macOS 截图文件名中的 Unicode 空格
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// 校验文件是否存在
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// 校验文件是否为空，空文件直接跳过
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			continue;
		}

		// 检测文件是否为支持的图片 MIME 类型，非图片返回 null
		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// 处理图片文件：读取二进制数据
			const content = await readFile(absolutePath);

			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				// 自动缩放图片至内联尺寸限制以内
				const resized = await resizeImage(content, mimeType);
				if (!resized) {
					// 缩放失败（图片无法缩小到限制以内），用占位文本替代
					text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
					continue;
				}
				// 获取缩放后的尺寸说明文本
				dimensionNote = formatDimensionNote(resized);
				attachment = {
					type: "image",
					mimeType: resized.mimeType,
					data: resized.data,  // 已经是 base64 编码的缩放后图片数据
				};
			} else {
				// 不缩放，直接将原始图片转为 base64
				attachment = {
					type: "image",
					mimeType,
					data: content.toString("base64"),
				};
			}

			images.push(attachment);

			// 在文本中添加图片引用占位符，如有尺寸说明则包含在内
			if (dimensionNote) {
				text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// 处理文本文件：读取 UTF-8 文本内容并用 <file> 标签包裹
			try {
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
