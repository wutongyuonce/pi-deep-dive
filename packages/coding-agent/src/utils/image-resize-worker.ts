/**
 * 图片缩放 Worker 线程入口
 *
 * 接收主线程发送的图片数据和缩放选项，调用 resizeImageInProcess 执行缩放，
 * 然后将结果（或错误）通过 postMessage 返回给主线程。
 * 被 image-resize.ts 通过 Worker 线程调用。
 */
import { parentPort } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./image-resize-core.ts";

/** Worker 请求消息结构 */
interface ResizeImageWorkerRequest {
	inputBytes: Uint8Array;
	mimeType: string;
	options?: ImageResizeOptions;
}

/** Worker 响应消息结构 */
interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

/** 类型守卫：验证输入消息是否为合法的 Worker 请求 */
function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string";
}

const port = parentPort;
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

// 监听主线程消息，执行缩放后返回结果
port.once("message", (message: unknown) => {
	void (async () => {
		try {
			if (!isResizeImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			// 调用核心缩放逻辑
			const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
			const response: ResizeImageWorkerResponse = { result };
			port.postMessage(response);
		} catch (error) {
			// 将错误信息返回给主线程
			const response: ResizeImageWorkerResponse = {
				error: error instanceof Error ? error.message : String(error),
			};
			port.postMessage(response);
		}
	})();
});
