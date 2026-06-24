/**
 * 输出截断工具 (truncate.ts)
 *
 * 本文件提供工具输出的截断功能，基于行数和字节两个独立限制，先触发者生效。
 *
 * 定位：
 *   被 read.ts（truncateHead）、bash.ts（truncateTail，通过 OutputAccumulator）、
 *   find.ts/grep.ts/ls.ts（truncateHead）调用。
 *
 * 提供的能力：
 *   1. truncateHead：从头部截断，保留前 N 行/字节（适用于文件读取）
 *   2. truncateTail：从尾部截断，保留后 N 行/字节（适用于 bash 输出）
 *   3. truncateLine：截断单行到指定字符数（适用于 grep 匹配行）
 *   4. formatSize：格式化字节数为人类可读格式（B/KB/MB）
 *
 * 截断规则：
 *   - 行限制默认 2000 行，字节限制默认 50KB，先触发者生效
 *   - 不返回不完整行（bash 尾部截断的极端情况除外）
 *   - 如果第一行就超过字节限制，返回空内容并标记 firstLineExceedsLimit
 */

/** 默认最大行数限制 */
export const DEFAULT_MAX_LINES = 2000;
/** 默认最大字节数限制（50KB） */
export const DEFAULT_MAX_BYTES = 50 * 1024;
/** grep 匹配行的最大字符数 */
export const GREP_MAX_LINE_LENGTH = 500;

/** 截断结果，包含截断后的内容和详细的截断元信息 */
export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 哪个限制被触发："lines" | "bytes"，未截断时为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 截断输出中的完整行数 */
	outputLines: number;
	/** 截断输出的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断（仅在 tail 截断的极端情况下为 true） */
	lastLinePartial: boolean;
	/** 第一行是否超出字节限制（仅在 head 截断时为 true） */
	firstLineExceedsLimit: boolean;
	/** 应用的最大行数限制 */
	maxLines: number;
	/** 应用的最大字节数限制 */
	maxBytes: number;
}

/** 截断选项 */
export interface TruncationOptions {
	/** 最大行数（默认 2000） */
	maxLines?: number;
	/** 最大字节数（默认 50KB） */
	maxBytes?: number;
}

/**
 * 将内容按换行符分割为行数组，用于截断计算。
 * 如果内容以换行符结尾，去除末尾的空元素以获得准确的行数。
 */
function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

/**
 * 将字节数格式化为人类可读的大小字符串。
 * 小于 1KB 显示 B，小于 1MB 显示 KB，否则显示 MB。
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 从头部截断内容，保留前 N 行/字节。
 * 适用于文件读取场景，需要查看文件开头。
 *
 * 被 read.ts、find.ts、grep.ts、ls.ts 调用。
 *
 * @param content  要截断的文本内容
 * @param options  截断选项（maxLines、maxBytes）
 * @returns 截断结果，包含内容和元信息
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 检查是否不需要截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 检查第一行是否单独超过字节限制
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// 收集能容纳的完整行
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 如果因行数限制退出循环
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从尾部截断内容，保留后 N 行/字节。
 * 适用于 bash 输出场景，需要查看末尾的错误信息和最终结果。
 * 被 OutputAccumulator.snapshot() 调用。
 *
 * 注意：在极端情况下（单行超过字节限制），可能返回部分首行。
 *
 * @param content  要截断的文本内容
 * @param options  截断选项（maxLines、maxBytes）
 * @returns 截断结果，包含内容和元信息
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 检查是否不需要截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 从末尾向前遍历收集行
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 极端情况：尚未添加任何行且当前行超过 maxBytes，取行末尾（部分行）
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 如果因行数限制退出循环
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从末尾截断字符串以适应字节限制。
 * 正确处理多字节 UTF-8 字符，不会在字符中间截断。
 * 被 truncateTail 在单行超过字节限制时调用。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// 从末尾向前跳过 maxBytes 个字节
	let start = buf.length - maxBytes;

	// 找到有效的 UTF-8 字符边界（不在多字节字符中间截断）
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/**
 * 截断单行到指定最大字符数，超出时添加 "... [truncated]" 后缀。
 * 被 grep.ts 调用，用于保持 grep 输出紧凑。
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
