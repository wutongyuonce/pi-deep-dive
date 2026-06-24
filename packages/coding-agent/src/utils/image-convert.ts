/**
 * 图片格式转换工具
 *
 * 将非 PNG 格式的图片转换为 PNG 格式，用于终端显示。
 * Kitty 图形协议要求 PNG 格式 (f=100)。
 *
 * 使用 Photon (Rust/WASM) 进行转换，并自动处理 EXIF 方向信息。
 * 被 TUI 图片显示功能调用。
 */
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

/**
 * 将图片转换为 PNG 格式
 * @param base64Data - 图片的 base64 编码数据
 * @param mimeType - 图片的 MIME 类型（如 "image/jpeg"）
 * @returns 转换后的 { data, mimeType } 对象，若已是 PNG 则原样返回，失败返回 null
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// 已经是 PNG 格式，无需转换
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	// 加载 Photon 图片处理库
	const photon = await loadPhoton();
	if (!photon) {
		// Photon 不可用，无法转换
		return null;
	}

	try {
		// 将 base64 解码为字节数组
		const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
		// 从字节创建 Photon 图片对象
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		// 根据 EXIF 信息修正图片方向（如手机拍摄的旋转照片）
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			// 导出为 PNG 字节并编码为 base64
			const pngBuffer = image.get_bytes();
			return {
				data: Buffer.from(pngBuffer).toString("base64"),
				mimeType: "image/png",
			};
		} finally {
			image.free();
		}
	} catch {
		// 转换失败
		return null;
	}
}
