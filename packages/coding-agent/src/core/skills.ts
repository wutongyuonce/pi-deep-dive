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
	// 空行和普通注释行不参与 ignore 规则计算。
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	// 保留 ignore 的取反语义，后续补前缀时不能丢掉前导 `!`。
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		// 转义的 `!` 表示字面量，不应当触发取反。
		pattern = pattern.slice(1);
	}

	// ignore 文件中的根路径规则改写为相对 rootDir 的规则形式。
	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	// 例如当前正在处理 `foo/.gitignore`，其中的 `bar` 需要被理解成
	// 相对于扫描根目录的 `foo/bar`，否则递归扫描时会丢失规则的作用域。
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	// 前面暂存过取反标记，这里再补回去，确保最终规则和原始 ignore 语义一致。
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
				// 每个目录中的规则都要带上相对根目录前缀，这样递归扫描时匹配语义才一致。
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				// 匹配器是跨递归层级共享的，因此这里加入的规则会自动影响所有后代目录。
				ig.add(patterns);
			}
			// ignore 规则文件本身是辅助信息；读取失败时宁可少忽略，也不要让技能加载整体失败。
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

	// 名称校验只收集问题，不直接抛错，方便调用方统一产出诊断。
	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	// 名称最终可能出现在命令、日志和提示词中，因此限制为较稳妥的字符集合。
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	// 连字符只允许出现在中间，避免出现 `-foo`、`foo-` 这类边界不清晰的名称。
	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	// 连续连字符通常不是有意设计，单独报出能让用户更快定位命名问题。
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

	// 描述是技能能否暴露给模型的最小必要信息，因此缺失时直接记为错误。
	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		// 过长不会阻止解析，但会增加系统提示词体积，因此仍给出 warning。
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
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
			// 用户级技能固定标记为 local/user，便于后续诊断与优先级判定。
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			// 项目级技能与用户级技能同属 local，但 scope 不同。
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			// 显式路径可能来自任意位置，这里只保留 local 和 baseDir，不额外附带 scope。
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			// 兜底分支保留原始 source 字符串，方便未来扩展新的来源类型。
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/** 从目录加载技能的选项 */
export interface LoadSkillsFromDirOptions {
	/** 要扫描技能的目录 */
	dir: string;
	/** 来源标识（如 "user"、"project"、"path"） */
	source: string;
}

/**
 * 定位：单目录技能发现的对外入口。
 * 作用：按 Agent Skills 目录约定扫描一个目录并返回技能与诊断结果。
 * 调用关系：由 `loadSkills()` 和测试直接调用；内部委托给 `loadSkillsFromDirInternal()`。
 *
 * 发现规则：
 * - 如果目录包含 SKILL.md，将其作为技能根目录，不再递归
 * - 否则加载根目录下的直接子 .md 文件
 * - 递归进入子目录查找 SKILL.md
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

	// 缺失目录按“无技能”处理，避免把可选目录当成错误。
	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	// 递归过程中持续把当前目录的 ignore 规则并入同一个匹配器。
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			// 如果当前目录本身就是技能根目录，优先直接加载它并停止下钻。
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					// 对符号链接做一次真实文件判断，避免把指向目录的链接误当成 SKILL.md 文件。
					isFile = statSync(fullPath).isFile();
				} catch {
					// 断链或无权限链接直接跳过，不影响其它技能继续发现。
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			// 命中目录级 SKILL.md 后立即返回；该目录不再继续向下扫描其它候选项。
			// 这样可以稳定表达“当前目录就是一个完整技能单元”的约定。
			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			// 否则继续扫描子目录，并在根目录模式下接收散落的 .md 技能文件。
			if (entry.name.startsWith(".")) {
				// 隐藏目录通常包含内部元数据或缓存，不参与技能发现。
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			if (entry.name === "node_modules") {
				// 依赖目录体积大且来源不受控，扫描它既低效也容易引入误判。
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					// 这里同时判断文件和目录，是为了让符号链接也能完整参与后续分支逻辑。
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
				// 目录路径补 `/` 后再匹配，和 ignore 对目录规则的常见写法保持一致。
				continue;
			}

			if (isDirectory) {
				// 子目录继承同一套 ignore 上下文，保持整棵扫描树的匹配结果稳定。
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			// 只有根目录模式才接收散落的 .md 文件；子目录模式只认 SKILL.md。
			// 这样根目录可以兼容“多个 markdown 技能文件并列存在”的场景，
			// 同时避免深入子目录时把普通文档误识别为技能。
			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
		// 读取目录失败时保持静默，调用方最终拿到的是“部分成功”的结果集合。
	} catch {}

	return { skills, diagnostics };
}

/**
 * 定位：单个技能文件的解析器。
 * 作用：读取 `SKILL.md`、校验 frontmatter，并产出运行时 `Skill` 对象。
 * 调用关系：由目录扫描逻辑和显式技能文件加载流程调用。
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
		// 先解析 frontmatter，再推导技能名和基础目录。
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			// 描述问题先进入诊断列表；只有“完全缺失”才会在后面阻断技能创建。
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Use name from frontmatter, or fall back to parent directory name
		// 目录名兜底让最简技能文件只写 description 也能被系统识别。
		const name = frontmatter.name || parentDirName;

		// Validate name
		const nameErrors = validateName(name);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// 描述完全缺失时视为无效技能；其余 warning 仅进入诊断。
		if (!frontmatter.description || frontmatter.description.trim() === "") {
			// 模型需要 description 来判断技能适用场景，因此这里不能继续生成 Skill 对象。
			return { skill: null, diagnostics };
		}

		// 命名、来源和禁用标记都在这一层归一化，后续调用方只消费 Skill 运行时对象。
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
		// 解析失败统一降级成 warning，让上层仍能继续加载其它技能来源。
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

	// 没有可自动调用的技能时返回空串，避免在系统提示中注入空壳 XML。
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
		// 每个技能只暴露名称、描述和定位信息，具体内容由模型按需再去 read。
		// 这种“先目录、后展开”的设计能把系统提示词体积控制在较小范围内。
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
	// 技能描述直接写入 XML 文本节点，必须先转义特殊字符，避免破坏标签结构。
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
 * 定位：技能资源的总加载入口。
 * 作用：合并用户级、项目级和显式路径的技能，并统一处理去重与冲突诊断。
 * 调用关系：由 `resource-loader.ts` 的重载流程调用，结果再进入系统提示和命令注册链路。
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
			// 解析符号链接以检测重复文件。
			const realPath = canonicalizePath(skill.filePath);

			// 如果已经加载过同一个文件（通过符号链接），静默跳过。
			if (realPathSet.has(realPath)) {
				// 真实路径去重比字符串路径去重更稳，能覆盖软链接和不同相对路径写法。
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				// 同名冲突保留先到先得的技能，把后到者记录成 collision 诊断。
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
				// 名称唯一且真实路径未重复时，才真正进入最终技能表。
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		// 步骤 1：先装载默认目录，保证用户级和项目级技能拥有稳定优先顺序。
		// 当前顺序意味着先加入的来源优先保留，同名后加入者只记录 collision。
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
		// 通过补路径分隔符避免 `/a/b2` 被误判为位于 `/a/b` 下。
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		// 关闭默认目录加载时，显式路径仍可能落在默认目录下，需要恢复其真实来源标签。
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		// 步骤 2：再处理显式路径，并把路径问题转成诊断而不是直接抛错。
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			// statSync 获取文件元数据，据此判断路径是目录还是文件，决定后续加载策略。
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				// 显式目录沿用目录扫描规则，可一次性批量引入多个技能。
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				// 单文件路径直接按技能文件解析，不必再走目录递归。
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					// 文件存在但无效时，仍保留解析产生的 warning，方便调用方展示原因。
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				// 非 markdown 普通文件不是合法技能输入，但这类问题只影响当前路径本身。
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
