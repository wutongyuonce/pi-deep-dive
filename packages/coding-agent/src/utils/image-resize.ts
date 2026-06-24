/**
 * 图片缩放入口模块
 *
 * 在 Worker 线程中运行 Photon (WASM) 避免阻塞 TUI 事件循环。
 * Worker 加载失败时回退到进程内缩放，确保图片读取始终可用。
 * 被图片输入功能调用。
 */
import { Worker } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

/** Worker 线程响应消息结构 */
interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

/**
 * 将输入字节复制为 Worker 可转移的副本
 * 因为 transfer 会 detach 原始 buffer，所以需要先复制一份给 Worker
 */
function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(input);
}

/** 类型守卫：检查消息是否为合法的 Worker 响应 */
function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return value !== null && typeof value === "object";
}

/** 创建图片缩放 Worker 实例 */
function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier);
}

/**
 * 在 Worker 线程中执行图片缩放
 * @param workerSpecifier - Worker 脚本路径（字符串或 URL）
 * @param inputBytes - 图片原始字节
 * @param mimeType - 图片 MIME 类型
 * @param options - 缩放选项
 * @returns 缩放后的图片数据，失败返回 null
 */
async function resizeImageInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const worker = createResizeWorker(workerSpecifier);
	try {
		// 复制字节以便通过 transferable 传递给 Worker
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<ResizedImage | null>((resolve, reject) => {
			// 防止多次 settle（message/error/exit 可能竞态触发）
			let settled = false;
			const settle = (result: ResizedImage | null): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			// 监听 Worker 返回的缩放结果
			worker.once("message", (message: unknown) => {
				if (!isResizeImageWorkerResponse(message)) {
					fail(new Error("Invalid image resize worker response"));
					return;
				}
				if (message.error) {
					fail(new Error(message.error));
					return;
				}
				settle(message.result ?? null);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			// 通过 transferable 方式发送数据，避免内存复制
			worker.postMessage(
				{
					inputBytes: inputBytesForWorker,
					mimeType,
					options,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		// 无论成功失败都终止 Worker 线程
		void worker.terminate().catch(() => undefined);
	}
}

/**
 * 图片缩放主入口
 *
 * 在 Worker 线程中运行 Photon，避免 WASM 解码/缩放/编码阻塞 TUI 事件循环。
 * 如果 Worker 无法加载（如某些 Bun 编译布局），回退到进程内缩放。
 *
 * @param inputBytes - 图片原始字节
 * @param mimeType - 图片 MIME 类型
 * @param options - 缩放选项（最大宽高、最大字节数等）
 * @returns 缩放后的图片数据，失败返回 null
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	// 根据当前运行环境选择 Worker 文件扩展名
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	const workerUrl = new URL(
		isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);

	// Bun 编译的可执行文件通过字符串路径解析 Worker 入口（而非 new URL），
	// 所以先尝试字符串路径，确保发布二进制使用内嵌的 Worker 而非回退到进程内
	if (typeof process.versions.bun === "string") {
		try {
			return await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
		} catch {}
	}

	// 尝试 Worker 线程缩放，失败则回退到进程内缩放
	try {
		return await resizeImageInWorker(workerUrl, inputBytes, mimeType, options);
	} catch {
		return resizeImageInProcess(inputBytes, mimeType, options);
	}
}

/**
 * 生成缩放后图片的尺寸说明文本
 * 帮助 AI 模型理解坐标映射关系（原始尺寸 vs 显示尺寸）
 * @param result - 缩放结果
 * @returns 尺寸说明字符串，未缩放则返回 undefined
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
