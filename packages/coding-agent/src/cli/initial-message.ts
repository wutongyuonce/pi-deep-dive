/**
 * @file 初始消息构建器，将 stdin 内容、@file 文本和 CLI 消息合并为单一初始提示
 *
 * 文件定位：CLI 消息组装层，负责将多个输入源合并为统一的初始消息。
 * 调用链位置：../cli.ts -> buildInitialMessage() -> 返回初始消息和图片附件
 *
 * 提供的能力：
 *   - 将 stdin 管道输入、@file 文件文本、CLI 命令行消息三者按顺序拼接
 *   - 附带 @file 处理阶段产生的图片附件
 *   - 消费 parsed.messages 中的第一条消息（shift 操作，具有副作用）
 *
 * 与其他文件的关系：
 *   - 被 ../cli.ts 在构建初始消息时调用
 *   - 接收 file-processor.ts 处理后产生的 fileText 和 fileImages
 *   - 接收 args.ts 解析后产生的 parsed 对象（Args 类型）
 *   - 纯函数，不进行 I/O 操作（但 shift 修改了 parsed.messages 数组）
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";

/**
 * buildInitialMessage 的输入参数接口
 */
export interface InitialMessageInput {
	/** CLI 参数解析结果，包含用户传入的 messages 数组 */
	parsed: Args;
	/** @file 参数处理后生成的文本内容（可能包含 <file> XML 标签） */
	fileText?: string;
	/** @file 参数处理后生成的图片附件数组 */
	fileImages?: ImageContent[];
	/** 通过 stdin 管道传入的文本内容 */
	stdinContent?: string;
}

/**
 * 初始消息构建结果接口
 */
export interface InitialMessageResult {
	/** 合并后的初始提示文本，若所有输入源均为空则为 undefined */
	initialMessage?: string;
	/** 图片附件数组，若无图片则为 undefined */
	initialImages?: ImageContent[];
}

/**
 * 将 stdin 内容、@file 文本和 CLI 第一条消息合并为单一初始提示。
 *
 * 按以下优先级顺序拼接文本部分：
 *   1. stdinContent（管道输入）
 *   2. fileText（@file 文件内容）
 *   3. parsed.messages[0]（CLI 命令行消息，消费后从数组中移除）
 *
 * 注意：此函数会通过 shift() 消费 parsed.messages 中的第一条消息，
 * 这是有意为之，确保第一条消息不会被重复处理。
 *
 * 调用者：../cli.ts（在处理完 @file 和 stdin 后调用本函数组装最终初始消息）
 * 调用了：无外部调用，纯数据组装逻辑
 *
 * @param input - 输入参数对象
 * @param input.parsed - CLI 参数解析结果
 * @param input.fileText - @file 处理后的文本内容
 * @param input.fileImages - @file 处理后的图片附件
 * @param input.stdinContent - stdin 管道输入的内容
 * @returns InitialMessageResult - 包含合并消息文本和图片附件的结果对象
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	// 按顺序收集所有文本片段
	const parts: string[] = [];

	// 第一优先级：stdin 管道输入
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}

	// 第二优先级：@file 文件文本内容
	if (fileText) {
		parts.push(fileText);
	}

	// 第三优先级：CLI 命令行中传入的第一条消息
	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		// 移除已消费的第一条消息，避免后续重复处理
		parsed.messages.shift();
	}

	return {
		// 所有文本片段直接拼接（无分隔符），无内容时返回 undefined
		initialMessage: parts.length > 0 ? parts.join("") : undefined,
		// 仅在有图片时返回图片数组，否则返回 undefined
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
