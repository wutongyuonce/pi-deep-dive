/**
 * 包管理器模块
 *
 * 文件定位：coding-agent 的资源包安装、解析和管理模块。
 *
 * 功能概述：
 * - 管理扩展（extensions）、技能（skills）、提示模板（prompts）和主题（themes）的包源
 * - 支持三种包源类型：npm 包、git 仓库、本地路径
 * - 提供包的安装、卸载、更新和版本检查功能
 * - 从用户级（~/.pi/agent/）和项目级（.pi/）两个作用域解析资源
 * - 支持 pi manifest（package.json 中的 pi 字段）声明式资源管理
 * - 支持 glob 模式和覆盖模式（!排除、+强制包含、-强制排除）的资源过滤
 * - 自动发现本地目录中的资源文件（遵循目录约定）
 *
 * 提供：
 * - PackageManager 接口：包管理的统一接口
 * - DefaultPackageManager：默认实现，协调包源解析、安装和资源收集
 * - PathMetadata / ResolvedResource / ResolvedPaths：资源路径元数据和解析结果类型
 *
 * 调用链路：
 *   resource-loader.ts → DefaultResourceLoader.reload() → packageManager.resolve() → 资源路径列表
 *   TUI /login 命令 → packageManager.install() → npm/git 安装
 *   TUI /reload 命令 → packageManager.update() → 检查并更新已安装的包
 */

import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

/**
 * 获取进程环境变量
 * 在 Linux 上当 process.env 为空时（如 Flatpak 沙箱），回退到读取 /proc/self/environ
 */
function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { globSync } from "glob";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { CONFIG_DIR_NAME } from "../config.ts";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import { canonicalizePath, isLocalPath, markPathIgnoredByCloudSync, resolvePath } from "../utils/paths.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import type { PackageSource, SettingsManager } from "./settings-manager.ts";

/** 网络操作超时时间（毫秒） */
const NETWORK_TIMEOUT_MS = 10000;
/** 更新检查的并发数 */
const UPDATE_CHECK_CONCURRENCY = 4;
/** Git 更新操作的并发数 */
const GIT_UPDATE_CONCURRENCY = 4;

/**
 * 检查是否启用离线模式
 * 通过 PI_OFFLINE 环境变量控制（值为 "1"、"true" 或 "yes" 时启用）
 */
function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** 资源路径元数据，描述一个资源文件的来源、作用域和来源方式 */
export interface PathMetadata {
	/** 来源标识（如 "local"、"auto"、npm 包名、git URL 等） */
	source: string;
	/** 作用域：用户级 / 项目级 / 临时 */
	scope: SourceScope;
	/** 来源方式：包 / 顶层配置 */
	origin: "package" | "top-level";
	/** 资源所在的基础目录 */
	baseDir?: string;
}

/** 已解析的资源路径，包含启用状态和元数据 */
export interface ResolvedResource {
	/** 资源文件的绝对路径 */
	path: string;
	/** 该资源是否启用 */
	enabled: boolean;
	/** 资源的来源元数据 */
	metadata: PathMetadata;
}

/** 已解析的全部资源路径，按资源类型分组 */
export interface ResolvedPaths {
	/** 扩展路径列表 */
	extensions: ResolvedResource[];
	/** 技能路径列表 */
	skills: ResolvedResource[];
	/** 提示模板路径列表 */
	prompts: ResolvedResource[];
	/** 主题路径列表 */
	themes: ResolvedResource[];
}

/** 缺失包源时的处理方式 */
export type MissingSourceAction = "install" | "skip" | "error";

/** 包管理操作的进度事件 */
export interface ProgressEvent {
	/** 事件类型：开始 / 进行中 / 完成 / 错误 */
	type: "start" | "progress" | "complete" | "error";
	/** 操作类型：安装 / 移除 / 更新 / 克隆 / 拉取 */
	action: "install" | "remove" | "update" | "clone" | "pull";
	/** 包源标识 */
	source: string;
	/** 进度消息（可选） */
	message?: string;
}

/** 进度回调函数类型 */
export type ProgressCallback = (event: ProgressEvent) => void;

/** 可更新的包信息 */
export interface PackageUpdate {
	/** 包源标识 */
	source: string;
	/** 显示名称 */
	displayName: string;
	/** 包类型：npm 或 git */
	type: "npm" | "git";
	/** 作用域（不包含 temporary） */
	scope: Exclude<SourceScope, "temporary">;
}

/** 已配置的包信息 */
export interface ConfiguredPackage {
	/** 包源标识 */
	source: string;
	/** 作用域：用户级或项目级 */
	scope: "user" | "project";
	/** 是否使用了过滤模式 */
	filtered: boolean;
	/** 已安装的路径（如果存在） */
	installedPath?: string;
}

/** 包管理器接口——定义包的解析、安装、卸载、更新等操作 */
export interface PackageManager {
	/** 解析所有已配置的包源，返回资源路径列表 */
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	/** 安装指定包源 */
	install(source: string, options?: { local?: boolean }): Promise<void>;
	/** 安装并持久化到设置文件 */
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	/** 移除指定包源 */
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	/** 移除并从设置文件中删除，返回是否实际移除了设置条目 */
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	/** 更新指定包源（省略 source 则更新全部） */
	update(source?: string): Promise<void>;
	/** 列出所有已配置的包 */
	listConfiguredPackages(): ConfiguredPackage[];
	/** 解析扩展源路径列表（支持临时作用域） */
	resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths>;
	/** 将包源添加到设置文件，返回是否发生了变更 */
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	/** 从设置文件中移除包源，返回是否实际移除了条目 */
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	/** 设置进度回调函数 */
	setProgressCallback(callback: ProgressCallback | undefined): void;
	/** 获取指定包源的已安装路径 */
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

/** 包管理器构造选项 */
interface PackageManagerOptions {
	/** 当前工作目录 */
	cwd: string;
	/** Agent 配置目录（如 ~/.pi/agent/） */
	agentDir: string;
	/** 设置管理器实例 */
	settingsManager: SettingsManager;
}

/** 资源来源作用域：用户级 / 项目级 / 临时 */
type SourceScope = "user" | "project" | "temporary";

/** npm 包源解析结果 */
type NpmSource = {
	type: "npm";
	/** npm 包规格（如 "@scope/pkg" 或 "pkg@1.0.0"） */
	spec: string;
	/** 包名（不含版本） */
	name: string;
	/** 是否指定了固定版本（如 "pkg@1.0.0" 为 true，"pkg" 为 false） */
	pinned: boolean;
};

/** 本地路径包源 */
type LocalSource = {
	type: "local";
	/** 本地路径 */
	path: string;
};

/** 解析后的包源联合类型 */
type ParsedSource = NpmSource | GitSource | LocalSource;

/** 已安装包的作用域（不含 temporary） */
type InstalledSourceScope = Exclude<SourceScope, "temporary">;

/** 待更新的已配置包源 */
interface ConfiguredUpdateSource {
	/** 包源标识 */
	source: string;
	/** 作用域（用户级或项目级） */
	scope: InstalledSourceScope;
}

/** 待更新的 npm 包源 */
interface NpmUpdateTarget extends ConfiguredUpdateSource {
	/** 解析后的 npm 包源信息 */
	parsed: NpmSource;
}

/** 待更新的 git 包源 */
interface GitUpdateTarget extends ConfiguredUpdateSource {
	/** 解析后的 git 包源信息 */
	parsed: GitSource;
}

/** pi manifest 声明（package.json 中的 "pi" 字段） */
interface PiManifest {
	/** 扩展入口路径列表 */
	extensions?: string[];
	/** 技能路径列表 */
	skills?: string[];
	/** 提示模板路径列表 */
	prompts?: string[];
	/** 主题路径列表 */
	themes?: string[];
}

/** 资源累积器——用于在包解析过程中收集所有资源路径 */
interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * 计算资源的优先级排名（数值越小优先级越高）。
 * 用于对已解析的资源排序，确保名称冲突时"先到先得"产生正确结果。
 *
 * 优先级（从高到低）：
 *   0  项目级 + 设置条目（source: "local", scope: "project"）
 *   1  项目级 + 自动发现（source: "auto", scope: "project"）
 *   2  用户级 + 设置条目（source: "local", scope: "user"）
 *   3  用户级 + 自动发现（source: "auto", scope: "user"）
 *   4  包资源（origin: "package"）
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

/** 包资源过滤器——用于按资源类型过滤包内的资源 */
interface PackageFilter {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

/** 资源类型枚举 */
type ResourceType = "extensions" | "skills" | "prompts" | "themes";

/** 所有资源类型列表 */
const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

/** 各资源类型对应的文件扩展名匹配模式 */
const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

/** 支持的忽略规则文件名列表 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** ignore 库的匹配器类型 */
type IgnoreMatcher = ReturnType<typeof ignore>;

/** 将系统路径分隔符转换为 POSIX 风格（正斜杠） */
function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

/** 获取用户主目录 */
function getHomeDir(): string {
	return process.env.HOME || homedir();
}

/**
 * 为忽略规则模式添加目录前缀
 * 将相对路径的忽略规则转换为基于根目录的完整路径规则
 * @param line 原始忽略规则行
 * @param prefix 目录前缀（相对于根目录）
 * @returns 带前缀的规则，空行或注释返回 null
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * 将目录下的忽略规则文件（.gitignore / .ignore / .fdignore）添加到匹配器中
 * @param ig 忽略匹配器实例
 * @param dir 要扫描忽略规则文件的目录
 * @param rootDir 根目录（用于计算相对路径前缀）
 */
function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

/** 判断字符串是否为模式表达式（包含特殊字符或前缀） */
function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

/** 判断字符串是否为覆盖模式（!排除、+强制包含、-强制排除） */
function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

/** 判断字符串是否包含 glob 通配符（* 或 ?） */
function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

/**
 * 将条目列表拆分为普通路径和模式表达式两组
 * @param entries 原始条目列表
 * @returns 包含 plain（普通路径）和 patterns（模式表达式）的对象
 */
function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

/**
 * 递归收集目录中匹配指定文件模式的文件
 * 支持 .gitignore/.ignore/.fdignore 忽略规则
 * @param dir 要扫描的目录
 * @param filePattern 文件名正则匹配模式
 * @param skipNodeModules 是否跳过 node_modules 目录
 * @param ignoreMatcher 继承的忽略匹配器
 * @param rootDir 根目录（用于计算忽略规则的相对路径）
 * @returns 匹配的文件绝对路径列表
 */
function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

/** 技能发现模式：pi 模式（.pi/skills）或 agents 模式（.agents/skills） */
type SkillDiscoveryMode = "pi" | "agents";

/**
 * 递归收集目录中的技能条目（SKILL.md 文件）
 * pi 模式下还会加载根目录中的 .md 文件
 * @param dir 要扫描的目录
 * @param mode 发现模式（pi 或 agents）
 * @param ignoreMatcher 继承的忽略匹配器
 * @param rootDir 根目录（用于计算忽略规则的相对路径）
 * @returns 技能文件路径列表
 */
function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (mode === "pi" && dir === root && isFile && entry.name.endsWith(".md") && !ig.ignores(relPath)) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/** 自动发现目录中的技能条目（委托给 collectSkillEntries） */
function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

/**
 * 从指定目录向上查找 git 仓库根目录
 * @param startDir 起始搜索目录
 * @returns git 仓库根目录路径，不在 git 仓库中则返回 null
 */
function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/**
 * 收集从起始目录到 git 仓库根目录（或文件系统根目录）之间所有祖先目录的 .agents/skills 路径
 * @param startDir 起始目录
 * @returns 祖先目录的 .agents/skills 路径列表（从近到远）
 */
function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

/** 自动发现目录中的提示模板文件（.md 文件） */
function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/** 自动发现目录中的主题文件（.json 文件） */
function collectAutoThemeEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".json")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/** 读取 package.json 中的 pi manifest 声明 */
function readPiManifestFile(packageJsonPath: string): PiManifest | null {
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as { pi?: PiManifest };
		return pkg.pi ?? null;
	} catch {
		return null;
	}
}

/**
 * 解析目录中的扩展入口文件
 * 优先读取 package.json 中的 pi.extensions 声明，
 * 其次查找 index.ts / index.js 文件
 * @param dir 要查找的目录
 * @returns 扩展入口文件路径列表，未找到返回 null
 */
function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifestFile(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * 自动发现目录中的扩展文件
 * 先检查目录本身是否有显式扩展入口（package.json 或 index），
 * 否则从目录内容中发现 .ts/.js 文件和子目录中的扩展
 */
function collectAutoExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
			} else if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/**
 * 定位：资源目录到文件列表的统一分发器。
 * 作用：根据资源类型切换到对应的发现策略，屏蔽扩展/技能/普通文件的差异。
 * 调用关系：被 manifest、包目录和本地路径解析流程复用。
 */
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

/**
 * 检查文件路径是否匹配任意一个模式
 * 支持相对路径、文件名和绝对路径的匹配，对 SKILL.md 还匹配其父目录
 */
function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

/** 规范化精确路径模式（去除 "./" 前缀，转换路径分隔符） */
function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

/** 检查文件路径是否精确匹配任意一个模式（不支持通配符，仅路径完全相等） */
function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

/** 从条目列表中提取覆盖模式（!、+、- 前缀的条目） */
function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/**
 * 将模式应用于路径列表，返回启用路径的集合。
 * 模式类型：
 * - 普通模式：包含匹配的路径
 * - `!模式`：排除匹配的路径
 * - `+路径`：强制包含精确路径（覆盖排除）
 * - `-路径`：强制排除精确路径（覆盖强制包含）
 */
function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	// Step 1: Apply includes (or all if no includes)
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// Step 2: Apply excludes
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private globalNpmRoot: string | undefined;
	private globalNpmRootCommandKey: string | undefined;
	private progressCallback: ProgressCallback | undefined;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progressCallback = callback;
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
		const matchIndex = currentPackages.findIndex((existing) => this.packageSourcesMatch(existing, source, scope));
		if (matchIndex !== -1) {
			const existing = currentPackages[matchIndex];
			if (this.getPackageSourceString(existing) === normalizedSource) {
				return false;
			}
			const nextPackages = [...currentPackages];
			nextPackages[matchIndex] =
				typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
			if (scope === "project") {
				this.settingsManager.setProjectPackages(nextPackages);
			} else {
				this.settingsManager.setPackages(nextPackages);
			}
			return true;
		}
		const nextPackages = [...currentPackages, normalizedSource];
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
		const changed = nextPackages.length !== currentPackages.length;
		if (!changed) {
			return false;
		}
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			const path = this.getNpmInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "git") {
			const path = this.getGitInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "local") {
			const baseDir = this.getBaseDirForScope(scope);
			const path = this.resolvePathFromBase(parsed.path, baseDir);
			return existsSync(path) ? path : undefined;
		}
		return undefined;
	}

	private emitProgress(event: ProgressEvent): void {
		this.progressCallback?.(event);
	}

	private async withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void> {
		this.emitProgress({ type: "start", action, source, message });
		try {
			await operation();
			this.emitProgress({ type: "complete", action, source });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.emitProgress({ type: "error", action, source, message: errorMessage });
			throw error;
		}
	}

	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		// 步骤 1：先创建累积器并读取全局/项目设置快照。
		const accumulator = this.createAccumulator();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();

		// 收集所有包源及其作用域（项目级优先，确保 cwd 资源在冲突时胜出）
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		// 步骤 2：对包源做作用域去重后解析包资源。
		const packageSources = this.dedupePackages(allPackages);
		await this.resolvePackageSources(packageSources, accumulator, onMissing);

		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		// 步骤 3：补齐顶层本地资源配置与自动发现资源。
		for (const resourceType of RESOURCE_TYPES) {
			const target = this.getTargetMap(accumulator, resourceType);
			const globalEntries = (globalSettings[resourceType] ?? []) as string[];
			const projectEntries = (projectSettings[resourceType] ?? []) as string[];
			this.resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "project",
					origin: "top-level",
				},
				projectBaseDir,
			);
			this.resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "user",
					origin: "top-level",
				},
				globalBaseDir,
			);
		}

		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		// 步骤 4：统一转换为排序后的已解析结果。
		return this.toResolvedPaths(accumulator);
	}

	async resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
		const packageSources = sources.map((source) => ({ pkg: source as PackageSource, scope }));
		await this.resolvePackageSources(packageSources, accumulator);
		return this.toResolvedPaths(accumulator);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const configuredPackages: ConfiguredPackage[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "user",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		for (const pkg of projectSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "project",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		return configuredPackages;
	}

	async install(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		await this.withProgress("install", source, `Installing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.installNpm(parsed, scope, false);
				return;
			}
			if (parsed.type === "git") {
				await this.installGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				const resolved = this.resolvePath(parsed.path);
				if (!existsSync(resolved)) {
					throw new Error(`Path does not exist: ${resolved}`);
				}
				return;
			}
			throw new Error(`Unsupported install source: ${source}`);
		});
	}

	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	async remove(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		await this.withProgress("remove", source, `Removing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.uninstallNpm(parsed, scope);
				return;
			}
			if (parsed.type === "git") {
				await this.removeGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				return;
			}
			throw new Error(`Unsupported remove source: ${source}`);
		});
	}

	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	async update(source?: string): Promise<void> {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const identity = source ? this.getPackageIdentity(source) : undefined;
		let matched = false;
		const updateSources: ConfiguredUpdateSource[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "user") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "user" });
		}
		for (const pkg of projectSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "project") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "project" });
		}

		if (source && !matched) {
			throw new Error(
				this.buildNoMatchingPackageMessage(source, [
					...(globalSettings.packages ?? []),
					...(projectSettings.packages ?? []),
				]),
			);
		}

		await this.updateConfiguredSources(updateSources);
	}

	private async updateConfiguredSources(sources: ConfiguredUpdateSource[]): Promise<void> {
		if (isOfflineModeEnabled() || sources.length === 0) {
			return;
		}

		// 步骤 1：先按 npm / git 类型拆分待更新目标。
		const npmCandidates: NpmUpdateTarget[] = [];
		const gitCandidates: GitUpdateTarget[] = [];

		for (const entry of sources) {
			const parsed = this.parseSource(entry.source);
			// 固定版本的 npm 包不会更新。固定 ref 的 git 包是配置的检出目标，
			// 需要包含在内以在配置的 ref 变更时协调已有克隆。
			if (parsed.type === "npm") {
				if (!parsed.pinned) {
					npmCandidates.push({ ...entry, parsed });
				}
			} else if (parsed.type === "git") {
				gitCandidates.push({ ...entry, parsed });
			}
		}

		// 步骤 2：并发检查 npm 是否存在新版本，再按作用域批量更新。
		const npmCheckTasks = npmCandidates.map((entry) => async () => ({
			entry,
			shouldUpdate: await this.shouldUpdateNpmSource(entry.parsed, entry.scope),
		}));
		const npmCheckResults = await this.runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
		const userNpmUpdates: NpmUpdateTarget[] = [];
		const projectNpmUpdates: NpmUpdateTarget[] = [];
		for (const result of npmCheckResults) {
			if (!result.shouldUpdate) {
				continue;
			}
			if (result.entry.scope === "user") {
				userNpmUpdates.push(result.entry);
			} else {
				projectNpmUpdates.push(result.entry);
			}
		}

		// 步骤 3：汇总用户级、项目级 npm 更新以及 git 更新任务并并发执行。
		const tasks: Promise<void>[] = [];
		if (userNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(userNpmUpdates, "user"));
		}
		if (projectNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(projectNpmUpdates, "project"));
		}
		if (gitCandidates.length > 0) {
			const gitTasks = gitCandidates.map(
				(entry) => async () =>
					this.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
						await this.updateGit(entry.parsed, entry.scope);
					}),
			);
			tasks.push(this.runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
		}

		await Promise.all(tasks);
	}

	private async shouldUpdateNpmSource(source: NpmSource, scope: InstalledSourceScope): Promise<boolean> {
		const installedPath = this.getManagedNpmInstallPath(source, scope);
		const installedVersion = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
		if (!installedVersion) {
			return true;
		}

		try {
			const latestVersion = await this.getLatestNpmVersion(source.name);
			return latestVersion !== installedVersion;
		} catch {
			// Preserve existing update behavior when version lookup fails.
			return true;
		}
	}

	private async updateNpmBatch(sources: NpmUpdateTarget[], scope: InstalledSourceScope): Promise<void> {
		if (sources.length === 0) {
			return;
		}

		const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
		const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
		const specs = sources.map((entry) => `${entry.parsed.name}@latest`);

		await this.withProgress("update", sourceLabel, message, async () => {
			await this.installNpmBatch(specs, scope);
		});
	}

	private async installNpmBatch(specs: string[], scope: InstalledSourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs(specs, installRoot));
	}

	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		if (isOfflineModeEnabled()) {
			return [];
		}

		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		const packageSources = this.dedupePackages(allPackages);
		const checks = packageSources
			.filter(
				(entry): entry is { pkg: PackageSource; scope: Exclude<SourceScope, "temporary"> } =>
					entry.scope !== "temporary",
			)
			.map((entry) => async (): Promise<PackageUpdate | undefined> => {
				const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
				const parsed = this.parseSource(source);
				if (parsed.type === "local" || parsed.pinned) {
					return undefined;
				}

				if (parsed.type === "npm") {
					const installedPath = this.getNpmInstallPath(parsed, entry.scope);
					if (!existsSync(installedPath)) {
						return undefined;
					}
					const hasUpdate = await this.npmHasAvailableUpdate(parsed, installedPath);
					if (!hasUpdate) {
						return undefined;
					}
					return {
						source,
						displayName: parsed.name,
						type: "npm",
						scope: entry.scope,
					};
				}

				const installedPath = this.getGitInstallPath(parsed, entry.scope);
				if (!existsSync(installedPath)) {
					return undefined;
				}
				const hasUpdate = await this.gitHasAvailableUpdate(installedPath);
				if (!hasUpdate) {
					return undefined;
				}
				return {
					source,
					displayName: `${parsed.host}/${parsed.path}`,
					type: "git",
					scope: entry.scope,
				};
			});

		const results = await this.runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
		return results.filter((result): result is PackageUpdate => result !== undefined);
	}

	private async resolvePackageSources(
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
		accumulator: ResourceAccumulator,
		onMissing?: (source: string) => Promise<MissingSourceAction>,
	): Promise<void> {
		for (const { pkg, scope } of sources) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			const filter = typeof pkg === "object" ? pkg : undefined;
			const parsed = this.parseSource(sourceStr);
			const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

			// 步骤 1：本地路径不需要安装，直接按本地目录解析资源。
			if (parsed.type === "local") {
				const baseDir = this.getBaseDirForScope(scope);
				this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
				continue;
			}

			const installMissing = async (): Promise<boolean> => {
				if (isOfflineModeEnabled()) {
					return false;
				}
				if (!onMissing) {
					await this.installParsedSource(parsed, scope);
					return true;
				}
				const action = await onMissing(sourceStr);
				if (action === "skip") return false;
				if (action === "error") throw new Error(`Missing source: ${sourceStr}`);
				await this.installParsedSource(parsed, scope);
				return true;
			};

			// 步骤 2：npm 源在缺失或版本不匹配时先安装，再收集包内资源。
			if (parsed.type === "npm") {
				let installedPath = this.getNpmInstallPath(parsed, scope);
				const needsInstall =
					!existsSync(installedPath) ||
					(parsed.pinned && !(await this.installedNpmMatchesPinnedVersion(parsed, installedPath)));
				if (needsInstall) {
					const installed = await installMissing();
					if (!installed) continue;
					installedPath = this.getNpmInstallPath(parsed, scope);
				}
				metadata.baseDir = installedPath;
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
				continue;
			}

			// 步骤 3：git 源按已有 checkout、临时刷新和缺失安装三种情况处理。
			if (parsed.type === "git") {
				const installedPath = this.getGitInstallPath(parsed, scope);
				if (!existsSync(installedPath)) {
					const installed = await installMissing();
					if (!installed) continue;
				} else if (scope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
					await this.refreshTemporaryGitSource(parsed, sourceStr);
				}
				metadata.baseDir = installedPath;
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
			}
		}
	}

	private resolveLocalExtensionSource(
		source: LocalSource,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		const resolved = this.resolvePathFromBase(source.path, baseDir);
		if (!existsSync(resolved)) {
			return;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isFile()) {
				metadata.baseDir = dirname(resolved);
				this.addResource(accumulator.extensions, resolved, metadata, true);
				return;
			}
			if (stats.isDirectory()) {
				metadata.baseDir = resolved;
				const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
				if (!resources) {
					this.addResource(accumulator.extensions, resolved, metadata, true);
				}
			}
		} catch {
			return;
		}
	}

	private async installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		if (parsed.type === "npm") {
			await this.installNpm(parsed, scope, scope === "temporary");
			return;
		}
		if (parsed.type === "git") {
			await this.installGit(parsed, scope);
			return;
		}
	}

	private getPackageSourceString(pkg: PackageSource): string {
		return typeof pkg === "string" ? pkg : pkg.source;
	}

	private getSourceMatchKeyForInput(source: string): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		return `local:${this.resolvePath(parsed.path)}`;
	}

	private getSourceMatchKeyForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		const baseDir = this.getBaseDirForScope(scope);
		return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
	}

	private buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
		const suggestion = this.findSuggestedConfiguredSource(source, configuredPackages);
		if (!suggestion) {
			return `No matching package found for ${source}`;
		}
		return `No matching package found for ${source}. Did you mean ${suggestion}?`;
	}

	private findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
		const trimmedSource = source.trim();
		const suggestions = new Set<string>();

		for (const pkg of configuredPackages) {
			const sourceStr = this.getPackageSourceString(pkg);
			const parsed = this.parseSource(sourceStr);
			if (parsed.type === "npm") {
				if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
					suggestions.add(sourceStr);
				}
				continue;
			}
			if (parsed.type === "git") {
				const shorthand = `${parsed.host}/${parsed.path}`;
				const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
				if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
					suggestions.add(sourceStr);
				}
			}
		}

		return suggestions.values().next().value;
	}

	private packageSourcesMatch(existing: PackageSource, inputSource: string, scope: SourceScope): boolean {
		const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
		const right = this.getSourceMatchKeyForInput(inputSource);
		return left === right;
	}

	private normalizePackageSourceForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type !== "local") {
			return source;
		}
		const baseDir = this.getBaseDirForScope(scope);
		const resolved = this.resolvePath(parsed.path);
		const rel = relative(baseDir, resolved);
		return rel || ".";
	}

	private parseSource(source: string): ParsedSource {
		if (source.startsWith("npm:")) {
			const spec = source.slice("npm:".length).trim();
			const { name, version } = this.parseNpmSpec(spec);
			return {
				type: "npm",
				spec,
				name,
				pinned: Boolean(version),
			};
		}

		if (isLocalPath(source)) {
			return { type: "local", path: source };
		}

		// Try parsing as git URL
		const gitParsed = parseGitUrl(source);
		if (gitParsed) {
			return gitParsed;
		}

		return { type: "local", path: source };
	}

	private async installedNpmMatchesPinnedVersion(source: NpmSource, installedPath: string): Promise<boolean> {
		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		const { version: pinnedVersion } = this.parseNpmSpec(source.spec);
		if (!pinnedVersion) {
			return true;
		}

		return installedVersion === pinnedVersion;
	}

	private async npmHasAvailableUpdate(source: NpmSource, installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		try {
			const latestVersion = await this.getLatestNpmVersion(source.name);
			return latestVersion !== installedVersion;
		} catch {
			return false;
		}
	}

	private getInstalledNpmVersion(installedPath: string): string | undefined {
		const packageJsonPath = join(installedPath, "package.json");
		if (!existsSync(packageJsonPath)) return undefined;
		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(content) as { version?: string };
			return pkg.version;
		} catch {
			return undefined;
		}
	}

	private async getLatestNpmVersion(packageName: string): Promise<string> {
		const npmCommand = this.getNpmCommand();
		const stdout = await this.runCommandCapture(
			npmCommand.command,
			[...npmCommand.args, "view", packageName, "version", "--json"],
			{ cwd: this.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
		);
		const raw = stdout.trim();
		if (!raw) throw new Error("Empty response from npm view");
		return JSON.parse(raw);
	}

	private async gitHasAvailableUpdate(installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		try {
			const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const remoteHead = await this.getRemoteGitHead(installedPath);
			return localHead.trim() !== remoteHead.trim();
		} catch {
			return false;
		}
	}

	private async getRemoteGitHead(installedPath: string): Promise<string> {
		const upstreamRef = await this.getGitUpstreamRef(installedPath);
		if (upstreamRef) {
			const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", upstreamRef]);
			const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
			if (match?.[1]) {
				return match[1];
			}
		}

		const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", "HEAD"]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
		if (!match?.[1]) {
			throw new Error("Failed to determine remote HEAD");
		}
		return match[1];
	}

	private async getLocalGitUpdateTarget(
		installedPath: string,
	): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmedUpstream = upstream.trim();
			if (!trimmedUpstream.startsWith("origin/")) {
				throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
			}
			const branch = trimmedUpstream.slice("origin/".length);
			if (!branch) {
				throw new Error("Missing upstream branch name");
			}
			const head = await this.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			return {
				ref: "@{upstream}",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		} catch {
			await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch(() => {});
			const head = await this.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const originHeadRef = await this.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			}).catch(() => "");
			const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
			if (branch) {
				return {
					ref: "origin/HEAD",
					head,
					fetchArgs: [
						"fetch",
						"--prune",
						"--no-tags",
						"origin",
						`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
					],
				};
			}
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
			};
		}
	}

	private async getGitUpstreamRef(installedPath: string): Promise<string | undefined> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmed = upstream.trim();
			if (!trimmed.startsWith("origin/")) {
				return undefined;
			}
			const branch = trimmed.slice("origin/".length);
			return branch ? `refs/heads/${branch}` : undefined;
		} catch {
			return undefined;
		}
	}

	private runGitRemoteCommand(installedPath: string, args: string[]): Promise<string> {
		return this.runCommandCapture("git", args, {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
			env: {
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	}

	private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
		if (tasks.length === 0) {
			return [];
		}

		const results: T[] = new Array(tasks.length);
		let nextIndex = 0;
		const workerCount = Math.max(1, Math.min(limit, tasks.length));

		const worker = async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= tasks.length) {
					return;
				}
				results[index] = await tasks[index]();
			}
		};

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	/**
	 * 获取包的唯一标识（忽略版本/ref）。
	 * 用于检测同一包同时存在于全局和项目设置中的情况。
	 * 对于 git 包，使用规范化的 host/path 确保同一仓库的 SSH 和 HTTPS URL
	 * 被视为同一标识。
	 */
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			// Use host/path for identity to normalize SSH and HTTPS
			return `git:${parsed.host}/${parsed.path}`;
		}
		if (scope) {
			const baseDir = this.getBaseDirForScope(scope);
			return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
		}
		return `local:${this.resolvePath(parsed.path)}`;
	}

	/**
	 * 去重包源：如果同一包标识同时出现在全局和项目设置中，
	 * 仅保留项目级条目（项目级优先）。
	 */
	private dedupePackages(
		packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): Array<{ pkg: PackageSource; scope: SourceScope }> {
		const seen = new Map<string, { pkg: PackageSource; scope: SourceScope }>();

		for (const entry of packages) {
			const sourceStr = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
			const identity = this.getPackageIdentity(sourceStr, entry.scope);

			const existing = seen.get(identity);
			if (!existing) {
				seen.set(identity, entry);
			} else if (entry.scope === "project" && existing.scope === "user") {
				// Project wins over user
				seen.set(identity, entry);
			}
			// If existing is project and new is global, keep existing (project)
			// If both are same scope, keep first one
		}

		return Array.from(seen.values());
	}

	private parseNpmSpec(spec: string): { name: string; version?: string } {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) {
			return { name: spec };
		}
		const name = match[1] ?? spec;
		const version = match[2];
		return { name, version };
	}

	private getNpmCommand(): { command: string; args: string[] } {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (!configuredCommand || configuredCommand.length === 0) {
			return { command: "npm", args: [] };
		}
		const [command, ...args] = configuredCommand;
		if (!command) {
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		return { command, args };
	}

	private getPackageManagerName(): string {
		const npmCommand = this.getNpmCommand();
		const commandParts = [npmCommand.command, ...npmCommand.args];
		const separatorIndex = commandParts.lastIndexOf("--");
		const packageManagerCommand = separatorIndex >= 0 ? commandParts[separatorIndex + 1] : npmCommand.command;
		return packageManagerCommand ? basename(packageManagerCommand).replace(/\.(cmd|exe)$/i, "") : "";
	}

	private async runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> {
		const npmCommand = this.getNpmCommand();
		await this.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
	}

	private getGitDependencyInstallArgs(): string[] {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (configuredCommand && configuredCommand.length > 0) {
			return ["install"];
		}
		return ["install", "--omit=dev"];
	}

	private runNpmCommandSync(args: string[]): string {
		const npmCommand = this.getNpmCommand();
		return this.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
	}

	private getNpmInstallArgs(specs: string[], installRoot: string): string[] {
		const packageManagerName = this.getPackageManagerName();
		// 扩展包在 pi 内部运行，通过 loader 别名/虚拟模块解析 pi API。
		// 禁用托管安装的 peer 依赖解析（npm 的 --legacy-peer-deps 及 bun/pnpm 的等效配置），
		// 以防包管理器安装或解析宿主提供的 @earendil-works/pi-* peer 依赖。
		// 过时的自动安装 pi peer 依赖可能会阻塞更新。
		if (packageManagerName === "bun") {
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
		}
		if (packageManagerName === "pnpm") {
			return [
				"install",
				...specs,
				"--prefix",
				installRoot,
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		}
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
	}

	private async installNpm(source: NpmSource, scope: SourceScope, temporary: boolean): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, temporary);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs([source.spec], installRoot));
	}

	private async uninstallNpm(source: NpmSource, scope: SourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		if (!existsSync(installRoot)) {
			return;
		}
		if (this.getPackageManagerName() === "bun") {
			await this.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			return;
		}
		await this.runNpmCommand(["uninstall", source.name, "--prefix", installRoot]);
	}

	private async installGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (existsSync(targetDir)) {
			if (source.ref) {
				await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
				return;
			}
			const target = await this.getLocalGitUpdateTarget(targetDir);
			await this.ensureGitRef(targetDir, target.fetchArgs, target.ref);
			return;
		}
		const gitRoot = this.getGitInstallRoot(scope);
		if (gitRoot) {
			this.ensureGitIgnore(gitRoot);
		}
		mkdirSync(dirname(targetDir), { recursive: true });

		await this.runCommand("git", ["clone", source.repo, targetDir]);
		if (source.ref) {
			await this.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
		}
		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
	}

	private async updateGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (!existsSync(targetDir)) {
			await this.installGit(source, scope);
			return;
		}

		if (source.ref) {
			await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
			return;
		}

		const target = await this.getLocalGitUpdateTarget(targetDir);
		await this.ensureGitRef(targetDir, target.fetchArgs, target.ref);
	}

	private async ensureGitRef(targetDir: string, fetchArgs: string[], ref: string): Promise<void> {
		// 仅拉取目标 ref，避免不相关的分支/标签干扰。
		await this.runCommand("git", fetchArgs, { cwd: targetDir });

		const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const commitRef = `${ref}^{commit}`;
		const targetHead = await this.runCommandCapture("git", ["rev-parse", commitRef], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		if (localHead.trim() === targetHead.trim()) {
			return;
		}

		await this.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });

		// 清理未跟踪文件（扩展应保持干净状态）
		await this.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });

		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
	}

	private async refreshTemporaryGitSource(source: GitSource, sourceStr: string): Promise<void> {
		if (isOfflineModeEnabled()) {
			return;
		}
		try {
			await this.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
				await this.updateGit(source, "temporary");
			});
		} catch {
			// Keep cached temporary checkout if refresh fails.
		}
	}

	private async removeGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (!existsSync(targetDir)) return;
		rmSync(targetDir, { recursive: true, force: true });
		this.pruneEmptyGitParents(targetDir, this.getGitInstallRoot(scope));
	}

	private pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): void {
		if (!installRoot) return;
		const resolvedRoot = resolve(installRoot);
		let current = dirname(targetDir);
		while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
			if (!existsSync(current)) {
				current = dirname(current);
				continue;
			}
			const entries = readdirSync(current);
			if (entries.length > 0) {
				break;
			}
			try {
				rmSync(current, { recursive: true, force: true });
			} catch {
				break;
			}
			current = dirname(current);
		}
	}

	private ensureNpmProject(installRoot: string): void {
		if (!existsSync(installRoot)) {
			mkdirSync(installRoot, { recursive: true });
		}
		markPathIgnoredByCloudSync(installRoot);
		this.ensureGitIgnore(installRoot);
		const packageJsonPath = join(installRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			const pkgJson = { name: "pi-extensions", private: true };
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	private ensureGitIgnore(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const ignorePath = join(dir, ".gitignore");
		if (!existsSync(ignorePath)) {
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	private getNpmInstallRoot(scope: SourceScope, temporary: boolean): string {
		if (temporary) {
			return this.getTemporaryDir("npm");
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "npm");
		}
		return join(this.agentDir, "npm");
	}

	private getGlobalNpmRoot(): string {
		const npmCommand = this.getNpmCommand();
		const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
		if (this.globalNpmRoot && this.globalNpmRootCommandKey === commandKey) {
			return this.globalNpmRoot;
		}
		if (this.getPackageManagerName() === "bun") {
			const binDir = this.runNpmCommandSync(["pm", "bin", "-g"]).trim();
			this.globalNpmRoot = join(dirname(binDir), "install", "global", "node_modules");
		} else {
			this.globalNpmRoot = this.runNpmCommandSync(["root", "-g"]).trim();
		}
		this.globalNpmRootCommandKey = commandKey;
		return this.globalNpmRoot;
	}

	private getPnpmGlobalPackagePath(packageName: string): string | undefined {
		if (this.getPackageManagerName() !== "pnpm") {
			return undefined;
		}

		const output = this.runNpmCommandSync(["list", "-g", "--depth", "0", "--json"]);
		const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
		for (const entry of entries) {
			const path = entry.dependencies?.[packageName]?.path;
			if (path) return path;
		}
		return undefined;
	}

	private getManagedNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return join(this.getTemporaryDir("npm"), "node_modules", source.name);
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
		}
		return join(this.agentDir, "npm", "node_modules", source.name);
	}

	private getLegacyGlobalNpmInstallPath(source: NpmSource): string | undefined {
		try {
			return this.getPnpmGlobalPackagePath(source.name) ?? join(this.getGlobalNpmRoot(), source.name);
		} catch {
			return undefined;
		}
	}

	private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		const managedPath = this.getManagedNpmInstallPath(source, scope);
		if (scope !== "user" || existsSync(managedPath)) {
			return managedPath;
		}
		const legacyPath = this.getLegacyGlobalNpmInstallPath(source);
		return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
	}

	private getGitInstallPath(source: GitSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return this.getTemporaryDir(`git-${source.host}`, source.path);
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "git", source.host, source.path);
		}
		return join(this.agentDir, "git", source.host, source.path);
	}

	private getGitInstallRoot(scope: SourceScope): string | undefined {
		if (scope === "temporary") {
			return undefined;
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "git");
		}
		return join(this.agentDir, "git");
	}

	private getTemporaryDir(prefix: string, suffix?: string): string {
		const hash = createHash("sha256")
			.update(`${prefix}-${suffix ?? ""}`)
			.digest("hex")
			.slice(0, 8);
		return join(tmpdir(), "pi-extensions", prefix, hash, suffix ?? "");
	}

	private getBaseDirForScope(scope: SourceScope): string {
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME);
		}
		if (scope === "user") {
			return this.agentDir;
		}
		return this.cwd;
	}

	private resolvePath(input: string): string {
		return resolvePath(input, this.cwd, { homeDir: getHomeDir(), trim: true });
	}

	private resolvePathFromBase(input: string, baseDir: string): string {
		return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
	}

	private collectPackageResources(
		packageRoot: string,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
	): boolean {
		if (filter) {
			// 步骤 1：显式过滤器优先，逐类决定收集策略和启用状态。
			for (const resourceType of RESOURCE_TYPES) {
				const patterns = filter[resourceType as keyof PackageFilter];
				const target = this.getTargetMap(accumulator, resourceType);
				if (patterns !== undefined) {
					this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
				} else {
					this.collectDefaultResources(packageRoot, resourceType, target, metadata);
				}
			}
			return true;
		}

		const manifest = this.readPiManifest(packageRoot);
		if (manifest) {
			// 步骤 2：没有显式过滤器时，优先尊重包内 manifest 声明。
			for (const resourceType of RESOURCE_TYPES) {
				const entries = manifest[resourceType as keyof PiManifest];
				this.addManifestEntries(
					entries,
					packageRoot,
					resourceType,
					this.getTargetMap(accumulator, resourceType),
					metadata,
				);
			}
			return true;
		}

		// 步骤 3：最后回退到目录约定扫描 extensions/skills/prompts/themes。
		let hasAnyDir = false;
		for (const resourceType of RESOURCE_TYPES) {
			const dir = join(packageRoot, resourceType);
			if (existsSync(dir)) {
				// Collect all files from the directory (all enabled by default)
				const files = collectResourceFiles(dir, resourceType);
				for (const f of files) {
					this.addResource(this.getTargetMap(accumulator, resourceType), f, metadata, true);
				}
				hasAnyDir = true;
			}
		}
		return hasAnyDir;
	}

	private collectDefaultResources(
		packageRoot: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const manifest = this.readPiManifest(packageRoot);
		const entries = manifest?.[resourceType as keyof PiManifest];
		if (entries) {
			this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
			return;
		}
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			// Collect all files from the directory (all enabled by default)
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	private applyPackageFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);

		if (userPatterns.length === 0) {
			// Empty array explicitly disables all resources of this type
			for (const f of allFiles) {
				this.addResource(target, f, metadata, false);
			}
			return;
		}

		// Apply user patterns
		const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

		for (const f of allFiles) {
			const enabled = enabledByUser.has(f);
			this.addResource(target, f, metadata, enabled);
		}
	}

	/**
	 * 从包中收集指定资源类型的所有文件，应用 manifest 模式。
	 * 返回 { allFiles, enabledByManifest }，其中 enabledByManifest 是
	 * 通过 manifest 自身模式筛选的文件集合。
	 */
	private collectManifestFiles(
		packageRoot: string,
		resourceType: ResourceType,
	): { allFiles: string[]; enabledByManifest: Set<string> } {
		const manifest = this.readPiManifest(packageRoot);
		const entries = manifest?.[resourceType as keyof PiManifest];
		if (entries && entries.length > 0) {
			const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
			const manifestPatterns = entries.filter(isOverridePattern);
			const enabledByManifest =
				manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
			return { allFiles: Array.from(enabledByManifest), enabledByManifest };
		}

		const conventionDir = join(packageRoot, resourceType);
		if (!existsSync(conventionDir)) {
			return { allFiles: [], enabledByManifest: new Set() };
		}
		const allFiles = collectResourceFiles(conventionDir, resourceType);
		return { allFiles, enabledByManifest: new Set(allFiles) };
	}

	private readPiManifest(packageRoot: string): PiManifest | null {
		const packageJsonPath = join(packageRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			return null;
		}

		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(content) as { pi?: PiManifest };
			return pkg.pi ?? null;
		} catch {
			return null;
		}
	}

	private addManifestEntries(
		entries: string[] | undefined,
		root: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (!entries) return;

		const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
		const patterns = entries.filter(isOverridePattern);
		const enabledPaths = applyPatterns(allFiles, patterns, root);

		for (const f of allFiles) {
			if (enabledPaths.has(f)) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	private collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
		const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
		const resolved = sourceEntries.flatMap((entry) => {
			if (!hasGlobPattern(entry)) {
				return [resolve(root, entry)];
			}

			return globSync(entry, {
				cwd: root,
				absolute: true,
				dot: false,
				nodir: false,
			}).map((match) => resolve(match));
		});
		return this.collectFilesFromPaths(resolved, resourceType);
	}

	private resolveLocalEntries(
		entries: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		if (entries.length === 0) return;

		// Collect all files from plain entries (non-pattern entries)
		const { plain, patterns } = splitPatterns(entries);
		const resolvedPlain = plain.map((p) => this.resolvePathFromBase(p, baseDir));
		const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);

		// Determine which files are enabled based on patterns
		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

		// Add all files with their enabled state
		for (const f of allFiles) {
			this.addResource(target, f, metadata, enabledPaths.has(f));
		}
	}

	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		globalBaseDir: string,
		projectBaseDir: string,
	): void {
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			origin: "top-level",
			baseDir: globalBaseDir,
		};
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};

		const userOverrides = {
			extensions: (globalSettings.extensions ?? []) as string[],
			skills: (globalSettings.skills ?? []) as string[],
			prompts: (globalSettings.prompts ?? []) as string[],
			themes: (globalSettings.themes ?? []) as string[],
		};
		const projectOverrides = {
			extensions: (projectSettings.extensions ?? []) as string[],
			skills: (projectSettings.skills ?? []) as string[],
			prompts: (projectSettings.prompts ?? []) as string[],
			themes: (projectSettings.themes ?? []) as string[],
		};

		const userDirs = {
			extensions: join(globalBaseDir, "extensions"),
			skills: join(globalBaseDir, "skills"),
			prompts: join(globalBaseDir, "prompts"),
			themes: join(globalBaseDir, "themes"),
		};
		const projectDirs = {
			extensions: join(projectBaseDir, "extensions"),
			skills: join(projectBaseDir, "skills"),
			prompts: join(projectBaseDir, "prompts"),
			themes: join(projectBaseDir, "themes"),
		};
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		const projectAgentsSkillDirs = collectAncestorAgentsSkillDirs(this.cwd).filter(
			(dir) => resolve(dir) !== resolve(userAgentsSkillsDir),
		);

		const addResources = (
			resourceType: ResourceType,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
		) => {
			const target = this.getTargetMap(accumulator, resourceType);
			for (const path of paths) {
				// 自动发现也要套用 overrides，保持与显式配置一致的启用语义。
				const enabled = isEnabledByOverrides(path, overrides, baseDir);
				this.addResource(target, path, metadata, enabled);
			}
		};

		// 步骤 1：先收集项目级 .pi/ 与 .agents/ 资源，保证项目覆盖优先。
		addResources(
			"extensions",
			collectAutoExtensionEntries(projectDirs.extensions),
			projectMetadata,
			projectOverrides.extensions,
			projectBaseDir,
		);

		// Project skills from .pi/
		addResources(
			"skills",
			collectAutoSkillEntries(projectDirs.skills, "pi"),
			projectMetadata,
			projectOverrides.skills,
			projectBaseDir,
		);

		// Project skills from .agents/ (each with its own baseDir)
		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"skills",
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				agentsMetadata,
				projectOverrides.skills,
				agentsBaseDir,
			);
		}

		addResources(
			"prompts",
			collectAutoPromptEntries(projectDirs.prompts),
			projectMetadata,
			projectOverrides.prompts,
			projectBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(projectDirs.themes),
			projectMetadata,
			projectOverrides.themes,
			projectBaseDir,
		);

		// 步骤 2：再补用户级 ~/.pi/agent/ 与 ~/.agents/ 资源。
		addResources(
			"extensions",
			collectAutoExtensionEntries(userDirs.extensions),
			userMetadata,
			userOverrides.extensions,
			globalBaseDir,
		);

		// User skills from ~/.pi/agent/
		addResources(
			"skills",
			collectAutoSkillEntries(userDirs.skills, "pi"),
			userMetadata,
			userOverrides.skills,
			globalBaseDir,
		);

		// User skills from ~/.agents/ (with its own baseDir)
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		const userAgentsMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			userOverrides.skills,
			userAgentsBaseDir,
		);

		addResources(
			"prompts",
			collectAutoPromptEntries(userDirs.prompts),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(userDirs.themes),
			userMetadata,
			userOverrides.themes,
			globalBaseDir,
		);
	}

	private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
		const files: string[] = [];
		for (const p of paths) {
			if (!existsSync(p)) continue;

			try {
				const stats = statSync(p);
				if (stats.isFile()) {
					files.push(p);
				} else if (stats.isDirectory()) {
					files.push(...collectResourceFiles(p, resourceType));
				}
			} catch {
				// Ignore errors
			}
		}
		return files;
	}

	private getTargetMap(
		accumulator: ResourceAccumulator,
		resourceType: ResourceType,
	): Map<string, { metadata: PathMetadata; enabled: boolean }> {
		switch (resourceType) {
			case "extensions":
				return accumulator.extensions;
			case "skills":
				return accumulator.skills;
			case "prompts":
				return accumulator.prompts;
			case "themes":
				return accumulator.themes;
			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	private addResource(
		map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		path: string,
		metadata: PathMetadata,
		enabled: boolean,
	): void {
		if (!path) return;
		if (!map.has(path)) {
			map.set(path, { metadata, enabled });
		}
	}

	private createAccumulator(): ResourceAccumulator {
		return {
			extensions: new Map(),
			skills: new Map(),
			prompts: new Map(),
			themes: new Map(),
		};
	}

	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		const mapToResolved = (
			entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		): ResolvedResource[] => {
			const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				path,
				enabled,
				metadata,
			}));
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			const seen = new Set<string>();
			return resolved.filter((entry) => {
				const canonicalPath = canonicalizePath(entry.path);
				if (seen.has(canonicalPath)) return false;
				seen.add(canonicalPath);
				return true;
			});
		};

		return {
			extensions: mapToResolved(accumulator.extensions),
			skills: mapToResolved(accumulator.skills),
			prompts: mapToResolved(accumulator.prompts),
			themes: mapToResolved(accumulator.themes),
		};
	}

	private spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
		const env = getEnv();
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env,
		});
	}

	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		const baseEnv = getEnv();
		const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
	}

	private runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			// 统一收集 stdout/stderr 和超时状态，给上层返回单个字符串结果。
			const child = this.spawnCaptureCommand(command, args, options);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout =
				typeof options?.timeoutMs === "number"
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeoutMs)
					: undefined;

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			child.once("error", (error) => {
				if (timeout) clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (timeout) clearTimeout(timeout);
				if (timedOut) {
					reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
					return;
				}
				if (code === 0) {
					resolvePromise(stdout.trim());
					return;
				}
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
			});
		});
	}

	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}

	private runCommandSync(command: string, args: string[]): string {
		const env = getEnv();
		const result = spawnProcessSync(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
			env,
		});
		if (result.error || result.status !== 0) {
			throw new Error(
				`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
			);
		}
		return (result.stdout || result.stderr || "").trim();
	}
}
