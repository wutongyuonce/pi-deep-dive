/**
 * @file JSONL（JSON Lines）序列化/反序列化工具模块。
 *
 * @module rpc/jsonl
 *
 * @description
 * **文件定位**：RPC 模式的基础设施层，提供 JSONL 协议的读写能力。
 *
 * **在调用链中的位置**：
 * - 上游调用方：`rpc-mode.ts`（服务端，读取 stdin 命令、写入 stdout 响应）和 `rpc-client.ts`（客户端，写入 stdin 命令、读取 stdout 响应）。
 * - 本模块不依赖其他 RPC 模块，是最底层的纯工具模块。
 *
 * **提供的能力**：
 * - `serializeJsonLine()`：将任意值序列化为一行 JSONL（JSON 字符串 + LF 换行符）。
 * - `attachJsonlLineReader()`：将 JSONL 行读取器附加到可读流，严格按 `\n` 分割行。
 *
 * **与其他文件的关系**：
 * - 被 `rpc-mode.ts` 引用，用于将响应序列化写入 stdout，以及从 stdin 读取命令。
 * - 被 `rpc-client.ts` 引用，用于将命令序列化写入子进程 stdin，以及从子进程 stdout 读取响应。
 *
 * **设计决策**：
 * 不使用 Node.js 内置的 `readline` 模块，因为 `readline` 会按额外的 Unicode 分隔符
 * （如 U+2028 行分隔符、U+2029 段落分隔符）进行分割，而这些字符在 JSON 字符串中是合法的。
 * 使用 `readline` 会导致 JSON payload 被错误截断。本模块严格按 `\n` 分割，确保 JSONL 帧的正确性。
 */

import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * 将一个值序列化为严格的一行 JSONL 记录。
 *
 * 帧格式仅以 LF（`\n`）作为行终止符。payload 字符串中可能包含其他 Unicode 分隔符
 * （如 U+2028 和 U+2029），调用方必须仅按 `\n` 分割记录。
 *
 * **调用关系**：
 * - 被 `rpc-mode.ts` 的 `output()` 函数调用，将响应/事件序列化后写入 stdout。
 * - 被 `rpc-client.ts` 的 `send()` 方法调用，将命令序列化后写入子进程 stdin。
 *
 * @param value - 任意可 JSON 序列化的值
 * @returns 格式为 `<json>\n` 的字符串，末尾包含换行符
 */
export function serializeJsonLine(value: unknown): string {
	// JSON.stringify 后追加 LF 换行符，构成一行 JSONL 记录
	return `${JSON.stringify(value)}\n`;
}

/**
 * 将一个仅按 LF 分割的 JSONL 行读取器附加到可读流上。
 *
 * **不使用 Node readline 的原因**：`readline` 会按额外的 Unicode 分隔符分割，
 * 这些分隔符在 JSON 字符串中是合法字符，会导致 JSON payload 被错误截断。
 * 本函数严格按 `\n` 分割，确保 JSONL 帧的完整性。
 *
 * **调用关系**：
 * - 被 `rpc-mode.ts` 调用，附加到 `process.stdin` 以读取来自客户端的 JSONL 命令。
 * - 被 `rpc-client.ts` 调用，附加到子进程的 `stdout` 以读取来自服务端的 JSONL 响应。
 * - 内部调用用户提供的 `onLine` 回调处理每一行。
 *
 * @param stream - 要附加读取器的可读流
 * @param onLine - 每解析出一行时的回调函数，接收去除行终止符后的行内容
 * @returns 解除函数，调用后会移除所有事件监听器并停止读取
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	// UTF-8 字符串解码器，用于将 Buffer 块解码为字符串
	const decoder = new StringDecoder("utf8");
	// 行缓冲区，暂存未完成的行数据
	let buffer = "";

	/** 发射一行，去除可能的 CR 字符（兼容 CRLF 行终止符）后交给 onLine 回调 */
	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	/** 处理流数据：将新数据追加到缓冲区，循环查找 LF 并逐行发射 */
	const onData = (chunk: string | Buffer) => {
		// 将 Buffer 块通过解码器转为字符串，字符串块直接拼接
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		// 循环查找换行符，每次找到就提取一行并从缓冲区移除
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				// 没有更多完整行，等待后续数据
				return;
			}

			// 提取 LF 之前的内容作为一行
			emitLine(buffer.slice(0, newlineIndex));
			// 从缓冲区移除已处理的行（包括 LF 字符）
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	/** 处理流结束：刷新解码器剩余字节，如果缓冲区还有数据则作为最后一行发射 */
	const onEnd = () => {
		// decoder.end() 返回解码器中剩余的字节
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	// 注册事件监听器
	stream.on("data", onData);
	stream.on("end", onEnd);

	// 返回解除函数，移除所有事件监听器
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
