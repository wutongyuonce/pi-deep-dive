/**
 * Photon 图片处理库的加载器
 *
 * 提供 @silvia-odwyer/photon-node 的统一加载接口，兼容以下环境：
 * 1. Node.js（开发模式，npm run build）
 * 2. Bun 编译的独立二进制文件
 *
 * 核心问题：photon-node 的 CJS 入口使用 fs.readFileSync(__dirname + '/photon_rs_bg.wasm')
 * 这会在 Bun 编译的二进制中硬编码构建机器的绝对路径。
 *
 * 解决方案：
 * 1. 修补 fs.readFileSync，重定向缺失的 photon_rs_bg.wasm 读取到备用路径
 * 2. 在 build:binary 阶段将 photon_rs_bg.wasm 复制到可执行文件旁边
 *
 * 被所有图片处理模块（image-convert、image-resize-core 等）调用。
 */

import type { PathOrFileDescriptor } from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");

// 从主包重新导出类型
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

type ReadFileSync = typeof fs.readFileSync;

/** Photon WASM 文件名 */
const WASM_FILENAME = "photon_rs_bg.wasm";

// 惰性加载的 Photon 模块缓存
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

/**
 * 将文件描述符转换为路径字符串（仅支持 string 和 URL 类型）
 */
function pathOrNull(file: PathOrFileDescriptor): string | null {
	if (typeof file === "string") {
		return file;
	}
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	return null;
}

/**
 * 获取 WASM 文件的备用搜索路径列表
 * 用于在原始路径找不到 WASM 时尝试替代位置
 */
function getFallbackWasmPaths(): string[] {
	const execDir = path.dirname(process.execPath);
	return [
		path.join(execDir, WASM_FILENAME), // 可执行文件同目录
		path.join(execDir, "photon", WASM_FILENAME), // 可执行文件下的 photon 子目录
		path.join(process.cwd(), WASM_FILENAME), // 当前工作目录
	];
}

/**
 * 修补 fs.readFileSync 以重定向 Photon WASM 文件的查找
 *
 * 当读取 photon_rs_bg.wasm 时，如果原始路径不存在，
 * 自动尝试备用路径（解决 Bun 编译二进制中路径硬编码问题）。
 * @returns 恢复函数，调用后可还原 fs.readFileSync 为原始实现
 */
function patchPhotonWasmRead(): () => void {
	const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs);
	const fallbackPaths = getFallbackWasmPaths();
	const mutableFs = fs as { readFileSync: ReadFileSync };

	const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
		const [file, options] = args;
		const resolvedPath = pathOrNull(file);

		// 仅拦截对 WASM 文件的读取
		if (resolvedPath?.endsWith(WASM_FILENAME)) {
			try {
				// 先尝试原始路径
				return originalReadFileSync(...args);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				// 仅处理文件不存在的情况，其他错误直接抛出
				if (err?.code && err.code !== "ENOENT") {
					throw error;
				}

				// 依次尝试备用路径
				for (const fallbackPath of fallbackPaths) {
					if (!fs.existsSync(fallbackPath)) {
						continue;
					}
					if (options === undefined) {
						return originalReadFileSync(fallbackPath);
					}
					return originalReadFileSync(fallbackPath, options);
				}

				// 所有路径都失败，抛出原始错误
				throw error;
			}
		}

		// 非 WASM 文件读取不做拦截
		return originalReadFileSync(...args);
	}) as ReadFileSync;

	// 应用修补（优先直接赋值，失败则使用 defineProperty）
	try {
		mutableFs.readFileSync = patchedReadFileSync;
	} catch {
		Object.defineProperty(fs, "readFileSync", {
			value: patchedReadFileSync,
			writable: true,
			configurable: true,
		});
	}

	// 返回恢复函数
	return () => {
		try {
			mutableFs.readFileSync = originalReadFileSync;
		} catch {
			Object.defineProperty(fs, "readFileSync", {
				value: originalReadFileSync,
				writable: true,
				configurable: true,
			});
		}
	};
}

/**
 * 异步加载 Photon 图片处理模块
 * 使用缓存避免重复加载，后续调用直接返回已缓存的模块
 * @returns Photon 模块实例，加载失败返回 null
 */
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	if (photonModule) {
		return photonModule;
	}

	// 防止并发加载
	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		// 在加载前临时修补 readFileSync 以处理 WASM 路径问题
		const restoreReadFileSync = patchPhotonWasmRead();
		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			photonModule = null;
			return photonModule;
		} finally {
			// 加载完成后恢复原始 readFileSync
			restoreReadFileSync();
		}
	})();

	return loadPromise;
}
