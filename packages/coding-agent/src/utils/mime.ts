/**
 * 图片 MIME 类型检测工具
 *
 * 通过文件头的魔数（magic bytes）识别 JPEG/PNG/GIF/WebP 格式。
 * 检测 APNG（动画 PNG）并将其排除（终端不支持动画 PNG）。
 * 被文件参数处理和图片读取功能调用。
 */
import { open } from "node:fs/promises";

/** 需要读取的头部字节数，足够覆盖所有格式的魔数检测 */
const IMAGE_TYPE_SNIFF_BYTES = 4100;
/** PNG 文件签名（8 字节魔数） */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 从字节缓冲区检测图片的 MIME 类型
 * @param buffer - 图片文件的头部字节（至少 4100 字节以确保准确性）
 * @returns 支持的 MIME 类型字符串，不支持返回 null
 */
export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	// JPEG: 以 FF D8 FF 开头
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		// 第4字节为 0xF7 表示 JPEG 无损格式，不支持，返回 null
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	// PNG: 以 89 50 4E 47 0D 0A 1A 0A 开头
	if (startsWith(buffer, PNG_SIGNATURE)) {
		// 验证是合法 PNG 且非动画 PNG（APNG 不支持）
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	// GIF: 以 ASCII "GIF" 开头
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	// WebP: 以 "RIFF" 开头且偏移 8 处为 "WEBP"
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	return null;
}

/**
 * 从文件路径检测图片的 MIME 类型
 * @param filePath - 图片文件路径
 * @returns 支持的 MIME 类型字符串，不支持或读取失败返回 null
 */
export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		// 读取文件头部字节用于魔数检测
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

/**
 * 验证是否为合法的 PNG 文件（包含 IHDR 数据块且 IHDR 长度为 13 字节）
 */
function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

/**
 * 检测 PNG 文件是否为动画 PNG (APNG)
 * APNG 包含 acTL（动画控制）数据块，出现在 IDAT 之前
 * @returns true 表示是动画 PNG，应排除
 */
function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		// acTL 块表示动画控制 → 是 APNG
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		// IDAT 块表示图像数据开始，acTL 必须在此之前，所以已过动画块区域 → 不是 APNG
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		// 跳到下一个数据块：chunk头部(4+4) + 数据长度(chunkLength) + CRC(4)
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

/** 从缓冲区读取大端序 32 位无符号整数 */
function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

/** 检查缓冲区是否以指定字节序列开头 */
function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

/** 检查缓冲区从指定偏移开始是否匹配 ASCII 文本 */
function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
