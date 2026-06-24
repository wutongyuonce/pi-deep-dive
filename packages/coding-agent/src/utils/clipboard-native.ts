/**
 * 原生剪贴板模块加载器
 *
 * 加载 @mariozechner/clipboard 原生插件，提供跨平台的剪贴板读写能力。
 * 在以下情况下返回 null（降级为命令行工具方案）：
 * - Termux 环境（Android 终端模拟器）
 * - Linux 无显示器环境（无 DISPLAY 和 WAYLAND_DISPLAY 环境变量）
 *
 * 调用方：clipboard.ts（文本复制）、clipboard-image.ts（图片读取）。
 */

import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

/** 原生剪贴板模块接口 */
export type ClipboardModule = {
	/** 将文本写入剪贴板 */
	setText: (text: string) => Promise<void>;
	/** 检查剪贴板中是否有图片 */
	hasImage: () => boolean;
	/** 获取剪贴板中的图片二进制数据 */
	getImageBinary: () => Promise<Array<number>>;
};

/** require 函数类型 */
type ClipboardRequire = (id: string) => unknown;

// 从当前模块位置和可执行文件目录两个位置尝试解析原生插件
const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);
// Linux 上需要有显示器（X11 或 Wayland）才能使用原生剪贴板
const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/**
 * 加载原生剪贴板模块。
 *
 * 依次尝试多个 require 解析根目录（模块位置、可执行文件位置），
 * 任一成功即返回该模块实例。
 *
 * @param requires - require 函数数组，默认从当前模块和可执行文件目录解析
 * @returns 剪贴板模块实例，所有解析位置均失败时返回 null
 */
export function loadClipboardNative(
	requires: readonly ClipboardRequire[] = [moduleRequire, executableDirRequire],
): ClipboardModule | null {
	for (const requireClipboard of requires) {
		try {
			return requireClipboard("@mariozechner/clipboard") as ClipboardModule;
		} catch {
			// 尝试下一个解析位置
		}
	}
	return null;
}

// 模块级加载：非 Termux 且有显示器时加载原生插件，否则为 null
const clipboard = !process.env.TERMUX_VERSION && hasDisplay ? loadClipboardNative() : null;

export { clipboard };
