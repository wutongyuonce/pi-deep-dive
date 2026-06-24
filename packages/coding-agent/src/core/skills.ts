/**
 * 技能（Skill）加载模块
 *
 * 文件定位：coding-agent 的技能资源发现与加载层。
 *
 * 功能概述：
 * - 从指定目录递归扫描 SKILL.md 文件，解析 frontmatter 元数据，构建 Skill 对象
 * - 遵循 Agent Skills 规范进行名称和描述的校验
 * - 支持 .gitignore / .ignore / .fdignore 忽略规则
 * - 将技能列表格式化为 XML 片段注入系统提示词
 * - 处理多来源（用户级、项目级、路径级）技能的去重与冲突诊断
 *
 * 提供：
 * - loadSkillsFromDir()：从单个目录加载技能
 * - loadSkills()：从所有配置位置加载技能并去重
 * - formatSkillsForPrompt()：将技能列表格式化为系统提示词中的 XML 片段
 *
 * 调用链路：
 *   resource-loader.ts → loadSkills() → loadSkillsFromDir() / loadSkillFromFile()
 *   前端会话构建 → formatSkillsForPrompt() → 注入系统提示词
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/** 名称最大长度（Agent Skills 规范） */
const MAX_NAME_LENGTH = 64;

/** 描述最大长度（Agent Skills 规范） */
const MAX_DESCRIPTION_LENGTH = 1024;

/** 支持的忽略规则文件名列表 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** ignore 库的匹配器类型 */
type IgnoreMatcher = ReturnType<typeof ignore>;

/** 将系统路径分隔符转换为 POSIX 风格（正斜杠） */
function toPosixPath(p: string): string {
	return p.split(sep).join("/");
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

/** SKILL.md 文件的 frontmatter 数据结构 */
export interface SkillFrontmatter {
	/** 技能名称（可选，默认使用父目录名） */
	name?: string;
	/** 技能描述（必填） */
	description?: string;
	/** 是否禁止模型自动调用（仅允许通过 /skill:name 手动调用） */
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

/** 加载后的技能对象 */
export interface Skill {
	/** 技能名称 */
	name: string;
	/** 技能描述 */
	description: string;
	/** SKILL.md 文件的绝对路径 */
	filePath: string;
	/** 技能所在的基础目录（SKILL.md 的父目录） */
	baseDir: string;
	/** 资源来源信息 */
	sourceInfo: SourceInfo;
	/** 是否禁止模型自动调用 */
	disableModelInvocation: boolean;
}

/** 技能加载结果 */
export interface LoadSkillsResult {
	/** 加载成功的技能列表 */
	skills: Skill[];
	/** 加载过程中的诊断信息（警告、错误、冲突） */
	diagnostics: ResourceDiagnostic[];
}

/**
 * 按 Agent Skills 规范校验技能名称
 * @param name 技能名称
 * @returns 校验错误消息数组（空数组表示合法）
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * 按 Agent Skills 规范校验技能描述
 * @param description 技能描述
 * @returns 校验错误消息数组（空数组表示合法）
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

/** 从目录加载技能的选项 */
export interface LoadSkillsFromDirOptions {
	/** 要扫描技能的目录 */
	dir: string;
	/** 来源标识（如 "user"、"project"、"path"） */
	source: string;
}

/**
 * 根据来源标识创建技能的 SourceInfo
 * @param filePath SKILL.md 文件路径
 * @param baseDir 技能基础目录
 * @param source 来源标识
 * @returns SourceInfo 对象
 */
function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * 从目录加载技能
 *
 * 发现规则：
 * - 如果目录包含 SKILL.md，将其作为技能根目录，不再递归
 * - 否则加载根目录下的直接子 .md 文件
 * - 递归进入子目录查找 SKILL.md
 *
 * 被 loadSkills() 调用，是技能发现的核心入口
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

/**
 * 内部递归加载技能实现
 * @param dir 要扫描的目录
 * @param source 来源标识
 * @param includeRootFiles 是否加载根目录下的 .md 文件（仅 pi 模式的根目录为 true）
 * @param ignoreMatcher 继承的忽略匹配器
 * @param rootDir 根目录（用于计算忽略规则的相对路径）
 */
function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
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
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { skills, diagnostics };
}

/**
 * 从单个 SKILL.md 文件加载技能
 * 解析 frontmatter 元数据，校验名称和描述，构建 Skill 对象。
 * 即使有校验警告仍会加载（除非描述完全缺失）。
 *
 * @param filePath SKILL.md 文件路径
 * @param source 来源标识
 * @returns 加载结果（skill 为 null 表示加载失败）和诊断信息
 */
function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Use name from frontmatter, or fall back to parent directory name
		const name = frontmatter.name || parentDirName;

		// Validate name
		const nameErrors = validateName(name);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Still load the skill even with warnings (unless description is completely missing)
		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null, diagnostics };
		}

		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir,
				sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}
}

/**
 * 将技能列表格式化为系统提示词中的 XML 片段
 * 遵循 Agent Skills 标准的 XML 格式。
 * 参见：https://agentskills.io/integrate-skills
 *
 * disableModelInvocation=true 的技能会被排除（只能通过 /skill:name 命令手动调用）。
 *
 * 被前端会话构建流程调用，将技能信息注入 LLM 的系统提示词。
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

/** XML 特殊字符转义 */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** 技能全局加载选项 */
export interface LoadSkillsOptions {
	/** 工作目录（用于项目级技能） */
	cwd: string;
	/** Agent 配置目录（用于全局技能） */
	agentDir: string;
	/** 显式指定的技能路径（文件或目录） */
	skillPaths: string[];
	/** 是否包含默认技能目录 */
	includeDefaults: boolean;
}

/**
 * 从所有配置位置加载技能
 * 合并用户级、项目级和显式路径的技能，处理去重和冲突诊断。
 *
 * 被 resource-loader.ts 的 DefaultResourceLoader.reload() 调用。
 *
 * @returns 技能列表和诊断信息
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	/** 将加载结果合并到总技能表中，处理符号链接去重和名称冲突 */
	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			const realPath = canonicalizePath(skill.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
		addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
