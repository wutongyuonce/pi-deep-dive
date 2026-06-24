/**
 * 图片缩放核心逻辑（进程内执行）
 *
 * 使用 Photon (Rust/WASM) 进行 Lanczos3 高质量缩放。
 * 缩放策略：先缩放尺寸 → 尝试 PNG/JPEG 编码 → 降低 JPEG 质量 → 逐步缩小尺寸。
 * 目标：确保 base64 编码后 < 4.5MB（Anthropic 5MB 限制以下留有余量）。
 *
 * 被 image-resize.ts（Worker 模式）和 image-resize.ts（进程内回退）调用。
 */
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

/** 图片缩放选项 */
export interface ImageResizeOptions {
	maxWidth?: number; // 最大宽度，默认 2000
	maxHeight?: number; // 最大高度，默认 2000
	maxBytes?: number; // 最大 base64 编码大小，默认 4.5MB（Anthropic 5MB 限制以下）
	jpegQuality?: number; // JPEG 压缩质量，默认 80
}

/** 缩放后的图片结果 */
export interface ResizedImage {
	data: string; // base64 编码的图片数据
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

// 4.5MB base64 负载，在 Anthropic 5MB 限制以下留出余量
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

/** 编码候选结果，用于比较不同编码格式的大小 */
interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

/**
 * 将图片字节编码为 base64 并计算编码大小
 * @param buffer - 图片字节数据
 * @param mimeType - 编码格式的 MIME 类型
 * @returns 编码候选结果（包含 base64 数据和大小）
 */
function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * 在进程内缩放图片，使其满足指定的最大尺寸和编码大小限制。
 * 如果无法将图片缩放到 maxBytes 以下，返回 null。
 *
 * 使用 Photon (Rust/WASM) 进行图片处理，若 Photon 不可用则返回 null。
 *
 * 压缩策略（按优先级逐步尝试）：
 * 1. 先将图片缩放到 maxWidth/maxHeight 以内
 * 2. 同时尝试 PNG 和 JPEG 格式，选择更小的
 * 3. 如果仍然过大，逐步降低 JPEG 质量（85→70→55→40）
 * 4. 如果仍然过大，每次将尺寸缩小为 75%，直到 1x1
 *
 * @param inputBytes - 图片原始字节
 * @param mimeType - 图片 MIME 类型
 * @param options - 缩放选项
 * @returns 缩放后的图片数据，失败返回 null
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	// 计算输入图片的 base64 编码大小（每 3 字节 → 4 个 base64 字符）
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		// 从字节创建 Photon 图片对象
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		// 根据 EXIF 信息修正图片方向
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		// 检查图片是否已在所有限制范围内（尺寸和编码大小均满足）
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// 按最大宽高限制计算初始目标尺寸（保持宽高比）
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		/**
		 * 尝试用指定尺寸和多种 JPEG 质量进行编码，返回所有候选结果
		 * @param width - 目标宽度
		 * @param height - 目标高度
		 * @param jpegQualities - 要尝试的 JPEG 质量列表
		 * @returns 编码候选结果数组（PNG + 多个 JPEG 质量）
		 */
		function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
			// 使用 Lanczos3 高质量滤镜缩放
			const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

			try {
				// 先尝试 PNG 编码
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				// 再尝试多个 JPEG 质量级别
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		}

		// JPEG 质量降级步骤（去重后按使用顺序排列）
		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		// 主循环：逐步缩小尺寸直到找到满足限制的编码或达到 1x1
		while (true) {
			const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
			// 在当前尺寸下，检查是否有任何编码满足大小限制
			for (const candidate of candidates) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
					};
				}
			}

			// 已达到最小尺寸 1x1，无法继续缩小
			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			// 将尺寸缩小为 75%（至少为 1）
			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			// 尺寸已无法再缩小（整数截断后不变）
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	} finally {
		// 释放 Photon 图片资源
		if (image) {
			image.free();
		}
	}
}
