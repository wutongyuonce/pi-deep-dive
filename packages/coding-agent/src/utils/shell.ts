/**
 * Shell 配置和进程管理工具
 *
 * 提供跨平台的 shell 发现（Git Bash/bash/sh）、
 * 进程树清理（killProcessTree）和二进制输出清理（sanitizeBinaryOutput）功能。
 * 被 bash 工具调用。
 */
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

/** Shell 配置信息 */
export interface ShellConfig {
	shell: string; // shell 可执行文件路径
	args: string[]; // shell 启动参数（通常为 ["-c"]）
}

/**
 * 在 PATH 中查找 bash 可执行文件（跨平台）
 * @returns bash 的完整路径，找不到返回 null
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: 使用 'where' 命令查找 bash.exe，并验证文件确实存在
		try {
			const result = spawnSync("where", ["bash.exe"], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// 忽略查找失败
		}
		return null;
	}

	// Unix: 使用 'which' 命令查找 bash（兼容 Termux 和特殊文件系统）
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// 忽略查找失败
	}
	return null;
}

/**
 * 根据平台和可选的自定义 shell 路径解析 shell 配置
 *
 * 查找优先级：
 * 1. 用户指定的 shellPath
 * 2. Windows：Git Bash 已知位置 → PATH 中的 bash
 * 3. Unix：/bin/bash → PATH 中的 bash → sh 回退
 *
 * @param customShellPath - 用户自定义的 shell 路径
 * @returns shell 配置（shell 路径和启动参数）
 * @throws 找不到可用 shell 时抛出错误（仅 Windows）
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. 优先使用用户指定的 shell 路径
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. 尝试 Git Bash 的已知安装位置
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		// 3. 回退：在 PATH 中搜索 bash.exe（Cygwin、MSYS2、WSL 等）
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"] };
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix：依次尝试 /bin/bash → PATH 中的 bash → sh 回退
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

/**
 * 获取包含 pi 工具目录的 shell 环境变量
 * 确保 bin 目录在 PATH 中，以便 shell 能找到 pi 的工具
 * @returns 包含更新后 PATH 的环境变量对象
 */
export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	// 兼容大小写不同的 PATH 环境变量（如 Windows 的 Path）
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	// 若 binDir 不在 PATH 中则添加到最前面
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * 清理二进制输出中的特殊字符，避免显示问题
 * 移除会导致 string-width 崩溃或显示异常的字符：
 * - 控制字符（tab/换行/回车除外）
 * - 孤立代理对（lone surrogates）
 * - Unicode 格式字符（会触发 string-width 的 bug）
 * - 未定义的码点
 *
 * @param str - 原始字符串
 * @returns 清理后的安全字符串
 */
export function sanitizeBinaryOutput(str: string): string {
	// 使用 Array.from 正确遍历 Unicode 码点（非码元），
	// 正确处理代理对，并捕获 codePointAt() 可能返回 undefined 的边界情况
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);

			// 跳过无效码点
			if (code === undefined) return false;

			// 允许 tab、换行、回车
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// 过滤控制字符（0x00-0x1F，不含 0x09/0x0A/0x0D）
			if (code <= 0x1f) return false;

			// 过滤 Unicode 格式字符（会触发 string-width 崩溃）
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * 跟踪的分离式子进程 PID 集合
 * 用于在父进程收到关闭信号（SIGHUP/SIGTERM）时清理子进程
 */
const trackedDetachedChildPids = new Set<number>();

/** 注册一个分离式子进程的 PID 以便跟踪 */
export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

/** 取消跟踪一个分离式子进程的 PID */
export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

/** 终止所有被跟踪的分离式子进程并清空跟踪集合 */
export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * 终止进程及其所有子进程（跨平台）
 * @param pid - 要终止的进程 ID
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Windows: 使用 taskkill 终止进程树（/F 强制 /T 包含子进程）
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// 忽略 taskkill 失败
		}
	} else {
		// Unix/Linux/Mac: 使用 SIGKILL 终止进程组（负 PID）
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// 进程组终止失败，回退到仅终止单个进程
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// 进程已退出
			}
		}
	}
}
