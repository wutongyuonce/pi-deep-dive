/**
 * 跨平台剪贴板图片读取工具
 *
 * 从系统剪贴板读取图片数据，支持多种平台和环境：
 * - Wayland: wl-paste 命令
 * - X11: xclip 命令
 * - WSL: PowerShell 访问 Windows 剪贴板
 * - 原生插件: @mariozechner/clipboard
 *
 * 自动将不支持的图片格式（如 WSLg 的 BMP）转换为 PNG。
 *
 * 调用方：图片输入功能（粘贴截图等）。
 */

import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { clipboard } from "./clipboard-native.ts";
import { loadPhoton } from "./photon.ts";

/** 剪贴板图片数据类型 */
export type ClipboardImage = {
	/** 图片的原始字节数据 */
	bytes: Uint8Array;
	/** 图片的 MIME 类型（如 "image/png"） */
	mimeType: string;
};

/** 支持的图片 MIME 类型列表（按优先级排序） */
const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** 列举剪贴板内容类型的默认超时时间（毫秒） */
const DEFAULT_LIST_TIMEOUT_MS = 1000;
/** 读取剪贴板图片数据的默认超时时间（毫秒） */
const DEFAULT_READ_TIMEOUT_MS = 3000;
/** PowerShell 命令的默认超时时间（毫秒） */
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;
/** stdout 缓冲区默认最大字节数（50MB） */
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

/**
 * 检测当前是否为 Wayland 会话。
 *
 * 通过环境变量 WAYLAND_DISPLAY 或 XDG_SESSION_TYPE 判断。
 *
 * @param env - 环境变量对象，默认为 process.env
 * @returns 如果是 Wayland 会话返回 true
 */
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

/**
 * 从 MIME 类型字符串中提取基础类型（去除参数部分）。
 *
 * 例如 "image/png; charset=utf-8" -> "image/png"
 *
 * @param mimeType - 完整的 MIME 类型字符串
 * @returns 基础 MIME 类型（小写）
 */
function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

/**
 * 将图片 MIME 类型转换为对应的文件扩展名。
 *
 * @param mimeType - 图片 MIME 类型
 * @returns 文件扩展名（不含点号），不支持的类型返回 null
 */
export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

/**
 * 从可用的 MIME 类型列表中选择首选的图片类型。
 *
 * 按 SUPPORTED_IMAGE_MIME_TYPES 的优先级顺序选择。
 * 如果没有匹配的已知类型，选择任意 image/* 类型。
 *
 * @param mimeTypes - 可用的 MIME 类型列表
 * @returns 首选的原始 MIME 类型字符串，无可用类型时返回 null
 */
function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	// 按优先级查找支持的类型
	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	// 回退：选择任意 image/* 类型
	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

/**
 * 检查给定的 MIME 类型是否为支持的图片格式。
 *
 * @param mimeType - 要检查的 MIME 类型
 * @returns 如果是支持的图片类型返回 true
 */
function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * 使用 Photon 将不支持的图片格式转换为 PNG。
 *
 * Photon 是基于 WebAssembly 的图片处理库，支持 BMP 等格式到 PNG 的转换。
 *
 * @param bytes - 原始图片字节数据
 * @returns 转换后的 PNG 字节数据，转换不可用或失败时返回 null
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

/**
 * 同步执行外部命令并捕获 stdout。
 *
 * @param command - 要执行的命令
 * @param args - 命令参数
 * @param options - 可选配置：超时时间、缓冲区大小、环境变量
 * @returns 包含 stdout 缓冲区和成功标志的对象
 */
function runCommand(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv },
): { stdout: Buffer; ok: boolean } {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
		env: options?.env,
	});

	if (result.error) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	if (result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf-8" : undefined);

	return { ok: true, stdout };
}

/**
 * 通过 wl-paste 命令读取 Wayland 剪贴板中的图片。
 *
 * 先列举剪贴板支持的类型，选择首选图片类型后读取数据。
 *
 * @returns 剪贴板图片数据，无图片或读取失败时返回 null
 */
function readClipboardImageViaWlPaste(): ClipboardImage | null {
	// 列举剪贴板支持的所有 MIME 类型
	const list = runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	// 选择首选的图片类型
	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	// 读取选定类型的图片数据
	const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) {
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

/**
 * 检测当前是否运行在 WSL (Windows Subsystem for Linux) 环境中。
 *
 * 通过环境变量和 /proc/version 文件内容判断。
 *
 * @param env - 环境变量对象，默认为 process.env
 * @returns 如果是 WSL 环境返回 true
 */
function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

/**
 * 通过 PowerShell 读取 WSL 中 Windows 剪贴板的图片。
 *
 * 在 WSL 中，Linux 剪贴板（Wayland/X11）无法接收 Windows 截图
 * （Win+Shift+S）的图片数据。PowerShell 可以直接访问 Windows 剪贴板，
 * 因此作为回退方案。
 *
 * 流程：创建临时文件 -> wslpath 转换路径 -> PowerShell 读取剪贴板保存为 PNG -> 读取文件
 *
 * @returns 剪贴板图片数据，读取失败时返回 null
 */
function readClipboardImageViaPowerShell(): ClipboardImage | null {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.png`);

	try {
		// 将 Linux 路径转换为 Windows 路径
		const winPathResult = runCommand("wslpath", ["-w", tmpFile], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
		if (!winPathResult.ok) {
			return null;
		}

		const winPath = winPathResult.stdout.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		// 构建 PowerShell 脚本：读取剪贴板图片并保存为 PNG
		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = runCommand("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (!result.ok) {
			return null;
		}

		const output = result.stdout.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		// 读取 PowerShell 写入的临时 PNG 文件
		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		// 清理临时文件
		try {
			unlinkSync(tmpFile);
		} catch {
			// 忽略清理错误
		}
	}
}

/**
 * 通过 xclip 命令读取 X11 剪贴板中的图片。
 *
 * 先查询剪贴板支持的 TARGETS，然后按优先级尝试读取图片数据。
 *
 * @returns 剪贴板图片数据，无图片或读取失败时返回 null
 */
function readClipboardImageViaXclip(): ClipboardImage | null {
	// 查询剪贴板支持的目标类型
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	// 按优先级选择类型，优先使用剪贴板报告的类型
	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];

	// 依次尝试每种类型读取图片
	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

/**
 * 通过原生剪贴板插件读取图片。
 *
 * @returns 剪贴板图片数据（始终为 PNG 格式），无图片或读取失败时返回 null
 */
async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null> {
	if (!clipboard || !clipboard.hasImage()) {
		return null;
	}

	const imageData = await clipboard.getImageBinary();
	if (!imageData || imageData.length === 0) {
		return null;
	}

	const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
	return { bytes, mimeType: "image/png" };
}

/**
 * 从系统剪贴板读取图片。
 *
 * 根据平台和环境选择合适的读取方式：
 * - Linux/Wayland: wl-paste -> xclip -> 原生插件
 * - Linux/X11: xclip -> 原生插件
 * - WSL: wl-paste -> xclip -> PowerShell -> 原生插件
 * - 其他平台（macOS/Windows）: 原生插件
 *
 * 读取后自动将不支持的格式（如 WSLg 的 BMP）转换为 PNG。
 *
 * @param options - 可选的环境变量和平台覆盖（用于测试）
 * @returns 剪贴板图片数据，无图片时返回 null
 */
export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	// Termux 环境不支持读取剪贴板图片
	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null = null;

	if (platform === "linux") {
		const wsl = isWSL(env);
		const wayland = isWaylandSession(env);

		if (wayland || wsl) {
			// Wayland 或 WSL：优先使用 wl-paste，回退到 xclip
			image = readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip();
		}

		if (!image && wsl) {
			// WSL 环境：通过 PowerShell 访问 Windows 剪贴板
			image = readClipboardImageViaPowerShell();
		}

		if (!image && !wayland) {
			// 非 Wayland 的 Linux：尝试原生插件
			image = await readClipboardImageViaNativeClipboard();
		}
	} else {
		// macOS / Windows：使用原生插件
		image = await readClipboardImageViaNativeClipboard();
	}

	if (!image) {
		return null;
	}

	// 将不支持的格式（如 WSLg 的 BMP）转换为 PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}
