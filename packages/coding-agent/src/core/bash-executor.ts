/**
 * bash-executor.ts - Bash 命令执行器（支持流式输出和取消）
 *
 * 作用：提供统一的 bash 命令执行实现，支持流式输出回调、中止信号、输出截断和全量日志持久化。
 * 定位：core 层的执行引擎，被 AgentSession.executeBash() 调用，也被需要 bash 执行的各种 mode 使用。
 *
 * 与 exec.ts 的区别：
 * - exec.ts 是通用的单次命令执行工具，不处理流式输出
 * - bash-executor.ts 专门面向 bash 执行场景，支持流式回调、ANSI 清理、输出截断、临时文件日志
 *
 * 调用关系：
 * - AgentSession.executeBash() → executeBashWithOperations() → BashOperations.exec()
 * - BashOperations 的具体实现可以是本地 bash（tools/bash.ts）或远程 SSH/bash
 *
 * 核心特性：
 * - 流式输出：通过 onData 回调实时向调用方推送清理后的输出片段
 * - 输出截断：当输出超过阈值时自动截断尾部，保留开头部分
 * - 全量日志：截断时将完整输出写入临时文件，供用户查看
 * - 滚动缓冲区：内存中维护有限大小的输出缓冲区
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Bash 执行器选项。
 * 调用方：AgentSession.executeBash()、直接调用 executeBashWithOperations() 的模块。
 */
export interface BashExecutorOptions {
	/** 流式输出回调，每收到一块数据（已清理）就调用 */
	onChunk?: (chunk: string) => void;
	/** 用于取消执行的中止信号 */
	signal?: AbortSignal;
}

/**
 * Bash 执行结果。
 * 返回给 AgentSession 用于记录到会话历史和上下文中。
 */
export interface BashResult {
	/** 合并后的 stdout + stderr 输出（已清理，可能已截断） */
	output: string;
	/** 进程退出码，被中止/取消时为 undefined */
	exitCode: number | undefined;
	/** 是否通过信号被取消 */
	cancelled: boolean;
	/** 输出是否被截断 */
	truncated: boolean;
	/** 当输出超过截断阈值时，完整输出写入的临时文件路径 */
	fullOutputPath?: string;
}

// ============================================================================
// 实现
// ============================================================================

/**
 * 使用自定义 BashOperations 执行 bash 命令。
 *
 * 此函数支持远程执行（SSH、容器等），通过 BashOperations 接口抽象实际的命令执行。
 *
 * 内部步骤：
 * 1. 创建输出收集器：滚动缓冲区（内存）+ 可选的临时文件（全量日志）
 * 2. onData 回调处理每个数据块：
 *    a. 累计原始字节数，超过阈值时创建临时文件
 *    b. 清理数据：去除 ANSI 转义码、替换二进制垃圾字符、规范化换行符
 *    c. 维护滚动缓冲区，确保内存占用有限
 *    d. 调用 onChunk 回调向调用方推送清理后的文本
 * 3. 执行完成后，对完整输出执行截断处理
 * 4. 如果输出被截断，确保临时文件已创建并包含完整内容
 * 5. 返回结果对象，包含（截断后的）输出、退出码、是否取消、完整输出路径
 *
 * @param command 要执行的 bash 命令
 * @param cwd 工作目录
 * @param operations 抽象的 bash 操作接口（本地或远程实现）
 * @param options 可选的执行选项（流式回调、中止信号）
 * @returns 执行结果，包含输出、退出码、取消状态和截断信息
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	/**
	 * 懒创建临时文件：当输出总量超过截断阈值时触发。
	 * 将已缓冲的输出块先写入文件，后续数据边收边写。
	 */
	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		tempFileStream = createWriteStream(tempFilePath);
		// 将已缓冲的块先写入临时文件
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const decoder = new TextDecoder();

	/**
	 * 数据块处理回调：清理、缓冲、持久化、流式推送。
	 */
	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// 清理：去除 ANSI 转义码、替换二进制垃圾字符、规范化换行符
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// 超过截断阈值时，开始写入临时文件
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// 维护滚动缓冲区，限制内存占用
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// 流式推送到调用方
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		// 执行完成，处理截断
		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		if (tempFileStream) {
			tempFileStream.end();
		}
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		// 检查是否为中止导致的错误
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			if (tempFileStream) {
				tempFileStream.end();
			}
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		if (tempFileStream) {
			tempFileStream.end();
		}

		throw err;
	}
}
