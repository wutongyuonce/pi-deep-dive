/**
 * 输出累积器 (output-accumulator.ts)
 *
 * 本文件实现了流式输出的增量收集器，用于 bash 工具在子进程运行时实时跟踪输出。
 *
 * 定位：
 *   被 bash.ts 的 execute 方法使用，负责收集子进程的 stdout/stderr 输出。
 *
 * 提供的能力：
 *   1. 增量追加 Buffer 数据，使用流式 UTF-8 解码器处理多字节字符
 *   2. 保持有界内存：只保留尾部文本用于展示快照，超出限制时自动滚出旧数据
 *   3. 输出超限时自动写入临时文件保存完整输出
 *   4. 快照功能：提供截断后的输出内容，附带截断元信息
 *
 * 调用链路：
 *   bash.ts execute → new OutputAccumulator() → append()（实时）→ snapshot()（获取快照）→ closeTempFile()（结束）
 *   截断逻辑委托给 truncate.ts 的 truncateTail
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

/** 输出累积器的配置选项 */
export interface OutputAccumulatorOptions {
	/** 最大保留行数，默认 2000 */
	maxLines?: number;
	/** 最大保留字节数，默认 50KB */
	maxBytes?: number;
	/** 临时文件名前缀，默认 "pi-output" */
	tempFilePrefix?: string;
}

/** 输出快照：包含截断后的文本内容、截断元信息和完整输出文件路径 */
export interface OutputSnapshot {
	/** 截断后的输出文本 */
	content: string;
	/** 截断信息（是否截断、截断原因、总行数/字节数等） */
	truncation: TruncationResult;
	/** 完整输出的临时文件路径（仅在输出超限时有值） */
	fullOutputPath?: string;
}

/**
 * 生成临时文件路径。
 * 使用随机 ID 确保路径唯一。
 */
function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

/**
 * 计算文本的 UTF-8 字节长度。
 */
function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * 流式输出累积器，以内存友好的方式增量跟踪子进程输出。
 *
 * 工作原理：
 *   - 使用 TextDecoder 流式解码 Buffer → 文本（处理跨 chunk 的多字节字符）
 *   - 只保留有界的尾部文本（tailText）用于展示快照，超出 2x maxBytes 时自动滚出旧数据
 *   - 当输出超过行数或字节数限制时，自动创建临时文件写入完整原始输出
 *   - snapshot() 调用时对尾部文本应用 truncateTail 截断，返回可直接展示的结果
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
	}

	/**
	 * 追加一块原始 Buffer 数据。
	 * 解码文本后追加到尾部缓冲区，必要时写入临时文件。
	 * 被 bash.ts 的 onData 回调在子进程产生输出时调用。
	 */
	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	/**
	 * 标记输出结束，刷新解码器剩余字节。
	 * 被 bash.ts 在子进程关闭后调用。
	 */
	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	/**
	 * 获取当前输出的截断快照。
	 *
	 * @param options.persistIfTruncated  如果截断了，确保临时文件已创建（保存完整输出）
	 * @returns 包含截断后文本、截断元信息和完整输出路径的快照
	 */
	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
		};
	}

	/**
	 * 关闭临时文件流。
	 * 被 bash.ts 在 finishOutput 流程最后调用。
	 */
	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	/** 获取当前未完成行的字节数，用于 bash 截断信息显示 */
	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	/** 将解码后的文本追加到尾部缓冲区，更新行计数 */
	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	/** 裁剪尾部缓冲区到 maxRollingBytes 范围内，确保不在 UTF-8 多字节字符中间截断 */
	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	/** 获取用于快照的文本，确保不从行中间开始 */
	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	/** 判断是否需要使用临时文件保存完整输出 */
	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	/** 确保临时文件已创建，将已缓存的原始 Buffer 块写入后清空缓存 */
	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		this.rawChunks = [];
	}
}
