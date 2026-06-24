/**
 * 外部工具（fd/rg）管理器
 *
 * 从 GitHub 下载、解压、安装二进制工具（fd-find、ripgrep）。
 * 优先使用系统已安装版本，未找到时自动下载。
 * 被 find/grep 工具调用。
 */
import chalk from "chalk";
import { type SpawnSyncReturns, spawnSync } from "child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { APP_NAME, getBinDir } from "../config.ts";

/** 工具安装目录 */
const TOOLS_DIR = getBinDir();
/** GitHub API 请求超时时间（毫秒） */
const NETWORK_TIMEOUT_MS = 10_000;
/** 文件下载超时时间（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * 检查是否启用了离线模式
 * 通过 PI_OFFLINE 环境变量控制
 */
function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** 工具配置 */
interface ToolConfig {
	name: string; // 工具显示名称
	repo: string; // GitHub 仓库（如 "sharkdp/fd"）
	binaryName: string; // 压缩包内的二进制文件名
	systemBinaryNames?: string[]; // 系统 PATH 中的备选命令名（下载前先尝试）
	tagPrefix: string; // GitHub release 标签前缀（如 "v" 或 ""）
	/** 根据平台和架构生成 release 资源文件名 */
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

/** 支持的工具配置表（fd 和 rg） */
const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

/** 工具配置表结束 */

/**
 * 检查命令是否存在于 PATH 中
 * 通过尝试执行 cmd --version 来判断
 * @param cmd - 要检查的命令名
 * @returns true 表示命令存在
 */
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

/**
 * 获取工具的可执行文件路径
 * 优先查找本地安装目录，然后查找系统 PATH
 * @param tool - 工具名称（"fd" 或 "rg"）
 * @returns 工具的完整路径或命令名，未找到返回 null
 */
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// 优先检查本地工具目录
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// 检查系统 PATH 中的命令名（如 Ubuntu 的 fdfind）
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

/**
 * 从 GitHub API 获取指定仓库的最新 release 版本号
 * @param repo - GitHub 仓库路径（如 "sharkdp/fd"）
 * @returns 最新版本号字符串（去除 "v" 前缀）
 */
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": `${APP_NAME}-coding-agent` },
		signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

/**
 * 从 URL 下载文件到指定路径
 * @param url - 下载地址
 * @param dest - 目标文件路径
 */
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

/**
 * 在目录树中递归查找指定名称的二进制文件
 * @param rootDir - 搜索根目录
 * @param binaryFileName - 要查找的文件名
 * @returns 找到的文件完整路径，未找到返回 null
 */
function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

/**
 * 格式化 spawn 命令执行失败的错误信息
 * 优先使用 error.message，其次 stderr，再次 stdout，最后 exit status
 */
function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

/**
 * 执行解压命令，返回错误信息或 null（成功）
 */
function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

/**
 * 解压 .tar.gz 压缩包到指定目录
 */
function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

/**
 * 获取 Windows 系统自带的 tar.exe 路径
 * Windows 内置 bsdtar（tar.exe），支持解压 zip 文件，优先于 Git Bash 的 GNU tar
 */
function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

/**
 * 解压 .zip 压缩包到指定目录
 * Windows 优先使用系统 tar.exe，失败则尝试 PowerShell Expand-Archive
 * Unix 优先使用 unzip，失败则尝试 tar
 */
function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows: 优先使用系统 bsdtar（支持 zip），优于 Git Bash 的 GNU tar
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		// 回退到 PowerShell Expand-Archive
		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		// Unix: 优先使用 unzip，失败则尝试 tar
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

/**
 * 下载并安装指定工具
 * 流程：获取最新版本 → 下载压缩包 → 解压 → 查找并移动二进制文件 → 设置可执行权限
 * @param tool - 工具名称（"fd" 或 "rg"）
 * @returns 安装后的二进制文件路径
 */
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// 获取最新版本号
	let version = await getLatestVersion(config.repo);
	// fd 在 macOS x64 上使用固定版本（后续版本可能有问题）
	if (tool === "fd" && plat === "darwin" && architecture === "x64") {
		version = "10.3.0";
	}

	// 根据平台和架构获取资源文件名
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// 确保工具目录存在
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// 下载压缩包
	await downloadFile(downloadUrl, archivePath);

	// 使用唯一临时目录解压，避免并发下载时的竞态条件
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		// 根据压缩格式选择解压方式
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// 在解压目录中查找二进制文件
		// 某些压缩包直接包含在根目录，某些嵌套在版本子目录中
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		// 候选路径都未找到时，递归搜索
		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Unix: 设置可执行权限
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// 清理临时文件
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

/** Termux (Android) 包管理器中的工具包名映射 */
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

/**
 * 确保工具可用，未找到时自动下载安装
 * @param tool - 工具名称（"fd" 或 "rg"）
 * @param silent - 是否静默模式（不输出日志）
 * @returns 工具的可执行路径，不可用返回 undefined
 */
export async function ensureTool(tool: "fd" | "rg", silent: boolean = false): Promise<string | undefined> {
	// 先检查是否已存在
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	// 离线模式下不下载
	if (isOfflineModeEnabled()) {
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Offline mode enabled, skipping download.`));
		}
		return undefined;
	}

	// Android/Termux 环境：Linux 二进制不兼容 Bionic libc，需用户通过 pkg 安装
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
		}
		return undefined;
	}

	// 工具未找到，自动下载
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return path;
	} catch (e) {
		if (!silent) {
			console.log(chalk.yellow(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`));
		}
		return undefined;
	}
}
