/**
 * Windows 自更新辅助工具
 *
 * 在 npm 更新前隔离已加载的原生 DLL 文件，避免 Windows 上的 EBUSY 错误。
 * Windows 不允许修改正在被加载的 .node/.dll 文件，所以需要先将其
 * 移动到隔离目录，再将副本放回原位，然后才能执行 npm 更新。
 *
 * 被 package-manager-cli.ts 的 Windows 更新流程调用。
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, toNamespacedPath } from "node:path";
import { getCwdRelativePath } from "./paths.ts";

/** 隔离目录名 */
const QUARANTINE_DIR_NAME = ".pi-native-quarantine";

/**
 * 将路径规范化为 Windows 命名空间路径（带 \\?\ 前缀）
 * @param path - 原始路径
 * @returns 规范化后的路径
 */
function normalizePath(path: string): string {
	return toNamespacedPath(resolve(path));
}

/**
 * 获取隔离根目录路径
 * 从给定目录向上查找 node_modules 目录，在其中创建隔离目录
 * @param packageDir - 包目录路径
 * @returns 隔离根目录路径，找不到 node_modules 返回 undefined
 */
function getQuarantineRoot(packageDir: string): string | undefined {
	let current = resolve(packageDir);
	while (true) {
		if (basename(current).toLowerCase() === "node_modules") {
			return join(current, QUARANTINE_DIR_NAME);
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/**
 * 获取指定包目录中已加载的原生共享对象文件列表
 * 通过 process.report.getReport() 获取当前进程加载的所有共享对象，
 * 筛选出位于指定包目录内的文件
 * @param packageDir - 包目录路径
 * @returns 已加载的原生文件路径列表
 */
function getLoadedSharedObjectsInPackageDir(packageDir: string): string[] {
	const sharedObjects = (process.report.getReport() as { sharedObjects?: unknown }).sharedObjects;
	if (!Array.isArray(sharedObjects)) {
		return [];
	}

	const root = normalizePath(packageDir).toLowerCase();
	const seen = new Set<string>();
	const loadedFiles: string[] = [];
	for (const value of sharedObjects) {
		if (typeof value !== "string") {
			continue;
		}
		const filePath = normalizePath(value);
		const comparisonPath = filePath.toLowerCase();
		// 只保留位于包目录内且未重复的文件
		if (getCwdRelativePath(comparisonPath, root) === undefined || seen.has(comparisonPath)) {
			continue;
		}
		seen.add(comparisonPath);
		loadedFiles.push(filePath);
	}
	return loadedFiles;
}

/**
 * 清理隔离目录
 * 在更新完成后删除隔离目录，释放磁盘空间
 * @param packageDir - 包目录路径
 */
export function cleanupWindowsSelfUpdateQuarantine(packageDir: string): void {
	const quarantineRoot = getQuarantineRoot(packageDir);
	if (!quarantineRoot) {
		return;
	}
	try {
		rmSync(quarantineRoot, { recursive: true, force: true });
	} catch {
		// 前一个 pi 进程可能仍在退出中并持有原生 addon，忽略错误
	}
}

/**
 * 将已加载的原生 DLL 隔离到临时目录
 *
 * Windows 不允许修改被加载的 .node/.dll 文件。此函数：
 * 1. 查找当前进程中已加载的原生文件
 * 2. 将它们移动（rename）到隔离目录
 * 3. 将隔离副本复制回原位（保持文件存在但不再被锁定）
 *
 * 这样 npm 更新时就能替换原位的副本文件，不会触发 EBUSY 错误。
 *
 * @param packageDir - 包目录路径
 */
export function quarantineWindowsNativeDependencies(packageDir: string): void {
	const resolvedPackageDir = normalizePath(packageDir);
	const quarantineRoot = getQuarantineRoot(resolvedPackageDir);
	if (!quarantineRoot) {
		return;
	}

	// 获取当前进程已加载的原生文件
	const loadedFiles = getLoadedSharedObjectsInPackageDir(resolvedPackageDir);
	if (loadedFiles.length === 0) {
		return;
	}

	// 创建本次隔离的唯一目录（包含时间戳、PID 和 UUID 避免冲突）
	const quarantineRunDir = join(quarantineRoot, `${Date.now()}-${process.pid}-${randomUUID()}`);
	for (const loadedFile of loadedFiles) {
		if (!existsSync(loadedFile)) {
			continue;
		}
		// 计算隔离目标路径（保持原始目录结构）
		const quarantinePath = join(quarantineRunDir, relative(resolvedPackageDir, loadedFile));
		mkdirSync(dirname(quarantinePath), { recursive: true });
		// 移动到隔离目录（释放原路径的文件锁）
		renameSync(loadedFile, quarantinePath);
		// 复制回原位（新的文件不再被进程锁定）
		copyFileSync(quarantinePath, loadedFile);
	}
}
