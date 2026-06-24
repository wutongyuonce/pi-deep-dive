/**
 * 跨平台剪贴板文本复制工具
 *
 * 将文本复制到系统剪贴板，支持多种平台和环境：
 * - macOS: pbcopy
 * - Windows: clip
 * - Linux Wayland: wl-copy
 * - Linux X11: xclip / xsel
 * - Termux (Android): termux-clipboard-set
 * - 远程会话 (SSH/MOSH): OSC 52 终端转义序列
 * - 原生插件: @mariozechner/clipboard
 *
 * 调用方：TUI 组件（复制代码块、复制命令输出等）。
 */

import { execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";

/** execSync 执行剪贴板命令的选项类型 */
type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

/**
 * 将文本复制到 X11 剪贴板。
 * 优先使用 xclip，失败时回退到 xsel。
 *
 * @param options - execSync 选项（包含 input 文本）
 */
function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

/** OSC 52 编码后最大允许长度（字节），超过则不发送 */
const MAX_OSC52_ENCODED_LENGTH = 100_000;

/**
 * 检测当前是否为远程会话（SSH、MOSH 等）。
 *
 * @param env - 环境变量对象，默认为 process.env
 * @returns 如果是远程会话返回 true
 */
function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

/**
 * 通过 OSC 52 转义序列将文本写入终端剪贴板。
 *
 * OSC 52 是终端标准协议，允许程序通过转义序列设置剪贴板内容，
 * 适用于 SSH 等远程会话场景。
 *
 * @param text - 要复制的文本
 * @returns 成功发送返回 true，文本过长无法编码时返回 false
 */
function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/**
 * 将文本复制到系统剪贴板。
 *
 * 按优先级尝试多种方式：
 * 1. 原生剪贴板插件（非 Linux 平台）
 * 2. 平台特定工具（pbcopy / clip / wl-copy / xclip 等）
 * 3. OSC 52 终端转义序列（远程会话或以上方式均失败时的兜底方案）
 *
 * 注意：Linux 上跳过原生插件，因为底层 clipboard-rs 仅支持 X11 且不保留
 * 选择所有权，导致在 Wayland 合成器上可能静默失败。
 *
 * @param text - 要复制到剪贴板的文本
 * @throws Error - 所有方式均失败时抛出
 */
export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// 优先使用直接剪贴板写入。先发 OSC 52 会导致终端和原生插件并发写入同一剪贴板，
	// 且超大 OSC 52 载荷可能导致终端渲染失同步。
	//
	// Linux 上跳过原生插件：底层 clipboard-rs 仅支持 X11，
	// set_text 完成后不保留选择所有权，在 Wayland-only 合成器上会静默失败。
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// 原生插件失败，回退到平台特定工具
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		try {
			if (p === "darwin") {
				// macOS: 使用 pbcopy
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				// Windows: 使用 clip
				execSync("clip", options);
				copied = true;
			} else {
				// Linux: 依次尝试 Termux、Wayland、X11 剪贴板工具
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						copied = true;
					} catch {
						// Termux 失败，回退到 Wayland 或 X11 工具
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// 验证 wl-copy 是否存在（spawn 错误是异步的，不会被捕获）
							execSync("which wl-copy", { stdio: "ignore" });
							// wl-copy 使用 execSync 会因 fork 行为而挂起，改用 spawn
							const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
							proc.stdin.on("error", () => {
								// 忽略 wl-copy 提前退出时的 EPIPE 错误
							});
							proc.stdin.write(text);
							proc.stdin.end();
							proc.unref();
							copied = true;
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// 平台工具失败，回退到 OSC 52
		}
	}

	// 远程会话时始终额外发送 OSC 52（确保远程终端也能复制）
	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
