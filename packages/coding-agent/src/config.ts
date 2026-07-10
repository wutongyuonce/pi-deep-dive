/**
 * coding-agent 的配置中心模块。
 *
 * 本文件是整个 coding-agent 包的基础设施层，提供以下核心能力：
 * 1. 运行时检测 —— 识别当前是 Bun 编译二进制还是 Node.js 运行时
 * 2. 安装方式检测 —— 判断通过 npm/pnpm/yarn/bun 哪种包管理器安装
 * 3. 自更新命令生成 —— 根据安装方式生成对应的全局更新命令
 * 4. 包资产路径解析 —— 定位随包分发的主题、文档、模板等静态资源
 * 5. 应用配置常量 —— APP_NAME、VERSION 等从 package.json 读取的元信息
 * 6. 用户配置目录路径 —— ~/.pi/agent/ 下各类用户数据文件的路径
 *
 * 调用关系：
 * - 被 cli.ts、main.ts、migrations.ts、package-manager-cli.ts 等几乎所有模块 import
 * - getAgentDir() 被大量模块调用来定位用户配置目录
 * - getPackageDir() 被资源加载器等调用来定位包内资产
 * - detectInstallMethod() 被自更新流程调用
 * - getSelfUpdateCommand() 被 package-manager-cli.ts 调用
 */
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { spawnProcessSync } from "./utils/child-process.ts";
import { normalizePath } from "./utils/paths.ts";

// =============================================================================
// 运行时检测（Package Detection）
// 检测当前进程是 Bun 编译二进制还是 Node.js 运行时，影响后续所有路径解析逻辑
// =============================================================================

// ESM 中没有 CommonJS 的内置 __filename / __dirname，这里通过 import.meta.url 手动还原当前文件路径和所在目录。
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 检测是否以 Bun 编译二进制方式运行。
 * Bun 编译后的二进制文件中，import.meta.url 会包含 "$bunfs"、"~BUN" 或 "%7EBUN"（Bun 虚拟文件系统标识）。
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** 检测当前运行时是否为 Bun（包括编译二进制和 `bun run` 方式运行） */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// 安装方式检测（Install Method Detection）
// 通过分析文件路径特征判断安装来源，用于生成自更新命令和确定资产查找策略
// =============================================================================

/** 安装方式枚举：bun-binary（Bun 编译二进制）、npm/pnpm/yarn/bun（各包管理器全局安装）、unknown（未知） */
export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

/** 自更新命令的单个步骤（一条 shell 命令） */
interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string; // 人类可读的命令展示文本
}

/**
 * 完整的自更新命令。
 * 当更新涉及包名变更时（如重命名），需要先卸载旧包再安装新包，此时 steps 包含多个步骤。
 */
export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

/**
 * 组装自更新命令。
 * 如果不需要卸载步骤（安装包名未变），直接返回安装步骤；
 * 否则返回组合后的多步骤命令，display 字段拼接展示。
 */
function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

/**
 * 构造单个自更新命令步骤。
 * 将命令和参数组合，并生成带引号处理的 display 字段（含空格的参数用双引号包裹）。
 */
function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

/**
 * 检测当前的安装方式。
 * 逻辑顺序：
 * 1. 如果是 Bun 编译二进制 → "bun-binary"
 * 2. 拼接 __dirname + process.execPath 作为路径特征，转小写后做关键词匹配：
 *    - 含 "/pnpm/" 或 "/.pnpm/" → "pnpm"
 *    - 含 "/yarn/" 或 "/.yarn/" → "yarn"
 *    - Bun 运行时或含 "/install/global/node_modules/" → "bun"
 *    - 含 "/npm/" 或 "/node_modules/" → "npm"
 * 3. 以上均不匹配 → "unknown"
 *
 * 调用方：detectInstallMethod() 被 getSelfUpdateCommand()、getSelfUpdateUnavailableInstruction()、getUpdateInstruction() 调用
 */
export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

/**
 * 从包目录路径推断 npm 全局安装前缀。
 * 通过分析 node_modules 的目录结构来还原 npm 全局安装的 root 和 prefix 路径。
 * 例如：/usr/lib/node_modules/@scope/pkg → root=/usr/lib/node_modules, prefix=/usr
 * 仅在 Linux/macOS 的标准目录布局下有效，Windows 的全局 npm 前缀无法从路径推断。
 */
function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows 全局 npm 前缀格式为 `<prefix>\\node_modules`，仅从路径形状无法与本地项目安装区分。
	// 在没有 `npm root -g` 命令输出的情况下，不推断 Windows 的自定义前缀。
	return undefined;
}

/**
 * 根据安装方式生成对应的自更新命令。
 * - bun-binary：不支持自更新（返回 undefined）
 * - pnpm/yarn/bun：各自对应的全局安装命令，若包名变更则生成先卸载再安装的多步骤命令
 * - npm：支持自定义 npm 命令（通过 npmCommand 参数），尝试从路径推断 --prefix
 * - unknown：不支持自更新
 *
 * 调用方：getSelfUpdateCommand()、getSelfUpdateUnavailableInstruction()、getUpdateInstruction()
 */
function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updatePackageName = installedPackageName,
	npmCommand?: string[],
): SelfUpdateCommand | undefined {
	switch (method) {
		case "bun-binary":
			return undefined;
		case "pnpm":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", [
					"install",
					"-g",
					"--ignore-scripts",
					"--config.minimumReleaseAge=0",
					updatePackageName,
				]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]),
			);
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", updatePackageName]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", [
					"install",
					"-g",
					"--ignore-scripts",
					"--minimum-release-age=0",
					updatePackageName,
				]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			const installStep = makeSelfUpdateCommandStep(command, [
				...prefixArgs,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				updatePackageName,
			]);
			const uninstallStep =
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep);
		}
		case "unknown":
			return undefined;
	}
}

/**
 * 同步执行外部命令并获取其 stdout 输出。
 * 成功（exit code 0）时返回 stdout（已 trim），否则：
 * - 若 requireSuccess 为 true，抛出异常
 * - 否则返回 undefined
 *
 * 调用方：getGlobalPackageRoots() —— 用于运行 `npm/pnpm/yarn/bun root -g` 等命令
 */
function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnProcessSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

/**
 * 获取全局包管理器的 node_modules 根目录列表。
 * 根据安装方式不同，通过各自包管理器的命令（如 `npm root -g`）获取全局包目录。
 * 返回候选路径数组，用于判断当前包是否由全局包管理器管理。
 *
 * @param method - 安装方式
 * @param _packageName - 包名（当前未使用，预留接口一致性）
 * @param npmCommand - 自定义 npm 命令（可选）
 * @returns 全局 node_modules 根目录路径数组
 */
function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			return root ? [root, dirname(root)] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

/**
 * 规范化路径用于比较（内部辅助函数）。
 * 先解析为绝对路径，检查是否存在；可选地解析符号链接。
 * Windows 下统一转小写以忽略大小写差异。
 *
 * @param path - 原始路径
 * @param resolveSymlinks - 是否解析符号链接
 * @returns 规范化后的路径；若路径不存在则返回 undefined
 */
function normalizeExistingPathForComparison(path: string, resolveSymlinks: boolean): string | undefined {
	const resolvedPath = resolve(path); // 把一个路径字符串变成“规范的绝对路径”
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath = resolvedPath;
	if (resolveSymlinks) {
		try {
			normalizedPath = realpathSync(resolvedPath); // 解析符号链接（symlink）
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

/**
 * 获取路径的比较候选集（内部辅助函数）。
 * 返回规范化后的路径（含符号链接和非符号链接两个版本），去重后用于路径前缀匹配。
 *
 * @param path - 原始路径
 * @returns 去重后的规范化路径数组
 */
function getPathComparisonCandidates(path: string): string[] {
	return Array.from(
		new Set(
			[normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter(
				(candidate): candidate is string => !!candidate,
			),
		),
	);
}

/**
 * 获取进程入口脚本所在的包根目录（内部辅助函数）。
 * 从 process.argv[1]（入口脚本路径）向上逐级查找包含 package.json 的目录。
 *
 * @returns 包根目录路径；若未找到则返回 undefined
 */
function getEntrypointPackageDir(): string | undefined {
	const entrypoint = process.argv[1];
	if (!entrypoint) return undefined;
	let dir = dirname(entrypoint);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

/**
 * 检测包目录及其父目录是否可写（内部辅助函数）。
 * 自更新需要同时写入包目录和父目录（node_modules），任一不可写则无法自更新。
 *
 * @returns 是否可写
 */
function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 判断当前安装的包是否由全局包管理器管理（内部辅助函数）。
 * 通过比较包目录是否位于全局 node_modules 根目录下来判断。
 *
 * @param method - 安装方式
 * @param packageName - 包名
 * @param npmCommand - 自定义 npm 命令（可选）
 * @returns 是否由全局包管理器管理
 */
function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDirs = [getPackageDir(), getEntrypointPackageDir()].filter((dir): dir is string => !!dir);
	const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
	return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
		return getPathComparisonCandidates(root).some((normalizedRoot) => {
			const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
		});
	});
}

/**
 * 获取自更新命令。
 * 综合判断安装方式、全局包管理器管理状态和路径可写性，生成可用的自更新命令。
 * 若不支持自更新（如 Bun 二进制、非全局安装、路径不可写），返回 undefined。
 *
 * @param packageName - 当前安装的包名
 * @param npmCommand - 自定义 npm 命令（可选，用于覆盖默认 npm 行为）
 * @param updatePackageName - 更新目标包名（默认与 packageName 相同，重命名时不同）
 * @returns 自更新命令；若不支持则返回 undefined
 */
export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updatePackageName = packageName,
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

/**
 * 获取自更新不可用时的用户提示信息。
 * 当自更新命令不可用时（如 Bun 二进制、非全局安装），返回相应的手动更新说明。
 *
 * @param packageName - 当前安装的包名
 * @param npmCommand - 自定义 npm 命令（可选）
 * @param updatePackageName - 更新目标包名（默认与 packageName 相同）
 * @returns 面向用户的更新说明文本
 */
export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updatePackageName = packageName,
): string {
	const method = detectInstallMethod();
	if (method === "bun-binary") {
		return `Download from: https://github.com/earendil-works/pi-mono/releases/latest`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${updatePackageName} using the package manager, wrapper, or source checkout that provides this installation.`;
}

/**
 * 获取更新指引文本。
 * 如果支持自更新，返回 "Run: ..." 命令；否则降级到 getSelfUpdateUnavailableInstruction() 的提示。
 *
 * @param packageName - 当前安装的包名
 * @returns 面向用户的更新指引文本
 */
export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// 包资产路径（Package Asset Paths）
// 解析随包分发的静态资源路径：主题、文档、模板、package.json 等
// 不同运行时（Bun 二进制 / Node.js dist / tsx src）下资产目录结构不同，本节统一处理
// =============================================================================

/**
 * 获取包资产的基础目录（主题、package.json、README.md、CHANGELOG.md 等的父目录）。
 * - Bun 编译二进制：返回可执行文件所在目录
 * - Node.js（dist/ 模式）：返回 __dirname（即 dist/ 目录）
 * - tsx（src/ 模式）：返回父目录（即包根目录）
 *
 * 调用方：几乎所有资产路径函数（getThemesDir、getPackageJsonPath 等）都依赖此函数；
 * 也被 getGlobalPackageRoots()、isManagedByGlobalPackageManager() 等调用。
 */
export function getPackageDir(): string {
	// 支持通过环境变量覆盖（适用于 Nix/Guix 等存储路径难以正确解析的场景）
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun 二进制：process.execPath 指向编译后的可执行文件
		return dirname(process.execPath);
	}
	// Node.js：从 __dirname 向上逐级查找 package.json 所在的目录
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// 兜底（正常情况下不会执行到这里）
	return __dirname;
}

/**
 * 获取内置主题目录路径（随包分发的内置主题）。
 * - Bun 编译二进制：可执行文件旁边的 theme/ 目录
 * - Node.js（dist/ 模式）：dist/modes/interactive/theme/
 * - tsx（src/ 模式）：src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// 主题位于 src/ 或 dist/ 下的 modes/interactive/theme/ 目录
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * 获取 HTML 导出模板目录路径（用于将对话导出为 HTML 文件的模板）。
 * - Bun 编译二进制：可执行文件旁边的 export-html/ 目录
 * - Node.js（dist/ 模式）：dist/core/export-html/
 * - tsx（src/ 模式）：src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** 获取包内 package.json 的路径 */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** 获取 README.md 文件的路径 */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** 获取文档目录（docs/）的路径 */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** 获取示例目录（examples/）的路径 */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** 获取 CHANGELOG.md 文件的路径 */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * 获取内置交互资源目录路径（交互模式使用的静态资源，如 favicon 等）。
 * - Bun 编译二进制：可执行文件旁边的 assets/ 目录
 * - Node.js（dist/ 模式）：dist/modes/interactive/assets/
 * - tsx（src/ 模式）：src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** 获取指定名称的内置交互资源的完整路径 */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// 应用配置（App Config）
// 从 package.json 的 piConfig 字段读取应用元信息（名称、版本、配置目录名等）
// 这些常量被整个应用的各个模块引用
// =============================================================================

/** package.json 中与 pi 相关的配置字段结构 */
interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string; // 应用名称（如 "pi" 或自定义名称）
		configDir?: string; // 用户配置目录名（默认 ".pi"）
	};
}

/** 从磁盘读取并解析 package.json，提取应用元信息 */
const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;

const piConfigName: string | undefined = pkg.piConfig?.name;
/** npm 包名（如 "@earendil-works/pi-coding-agent"），用于安装/卸载等操作 */
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
/** 应用名称（如 "pi"），用于环境变量前缀、配置目录名等 */
export const APP_NAME: string = piConfigName || "pi";
/** 应用显示标题（默认 "π"），用于 UI 界面展示 */
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
/** 用户配置根目录名称（默认 ".pi"），即 ~/.pi/ 中的目录名 */
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
/** 当前版本号，从 package.json 读取，默认 "0.0.0" */
export const VERSION: string = pkg.version || "0.0.0";

// 环境变量名示例：PI_CODING_AGENT_DIR 或 TAU_CODING_AGENT_DIR
/** 覆盖 agent 配置目录的环境变量名（如 "PI_CODING_AGENT_DIR"） */
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
/** 覆盖 session 目录的环境变量名（如 "PI_CODING_AGENT_SESSION_DIR"） */
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

/** 将路径中的 ~ 展开为用户主目录并规范化路径分隔符 */
export function expandTildePath(path: string): string {
	return normalizePath(path);
}

/** 默认的会话分享查看器 URL */
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/**
 * 根据 gist ID 生成会话分享链接。
 * 支持通过 PI_SHARE_VIEWER_URL 环境变量覆盖默认查看器地址。
 */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// 用户配置目录路径（User Config Paths: ~/.pi/agent/*）
// 提供 agent 配置目录及其下各类用户数据文件的路径解析
// =============================================================================

/** 获取 agent 配置目录路径（如 ~/.pi/agent/），可通过 PI_CODING_AGENT_DIR 环境变量覆盖 */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** 获取用户自定义主题目录路径（~/.pi/agent/themes/） */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** 获取 models.json 文件路径（~/.pi/agent/models.json），存储用户自定义模型配置 */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** 获取 auth.json 文件路径（~/.pi/agent/auth.json），存储认证凭证 */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** 获取 settings.json 文件路径（~/.pi/agent/settings.json），存储用户设置 */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 获取工具目录路径（~/.pi/agent/tools/），存放自定义工具定义 */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** 获取托管二进制目录路径（~/.pi/agent/bin/），存放 fd、rg 等依赖工具的二进制文件 */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** 获取提示词模板目录路径（~/.pi/agent/prompts/），存放自定义提示词模板 */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** 获取会话数据目录路径（~/.pi/agent/sessions/），存放历史会话记录 */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** 获取调试日志文件路径（~/.pi/agent/<app-name>-debug.log） */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
