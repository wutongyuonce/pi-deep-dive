/**
 * 提示模板（Prompt Templates）的加载、解析与展开。
 *
 * 文件定位：coding-agent 的提示模板管理模块，负责从文件系统加载 .md 格式的提示模板，
 * 解析 frontmatter 元数据，支持参数替换，以及将 /command 格式的输入展开为模板内容。
 *
 * 提供：
 * - PromptTemplate 接口：模板的数据结构
 * - parseCommandArgs()：解析命令参数（支持引号）
 * - substituteArgs()：替换模板中的参数占位符（$1, $@, $ARGUMENTS 等）
 * - loadPromptTemplates()：从多个路径加载所有模板
 * - expandPromptTemplate()：将 "/command args" 格式的输入展开为模板内容
 *
 * 调用链路：
 * - 被 agent 启动时调用 loadPromptTemplates() 加载模板
 * - 被 TUI/CLI 输入处理调用 expandPromptTemplate()，检测用户输入是否为模板命令
 * - 使用 config.ts 的 CONFIG_DIR_NAME 确定项目配置目录
 * - 使用 frontmatter.ts 解析 .md 文件的元数据
 * - 使用 source-info.ts 创建来源信息
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/**
 * 提示模板的数据结构，从 .md 文件加载而来。
 * 模板文件名（去掉 .md）即为模板名称，用户通过 /name 触发。
 */
export interface PromptTemplate {
	/** 模板名称（从文件名派生） */
	name: string;
	/** 模板描述（来自 frontmatter 或文件首行） */
	description: string;
	/** 参数提示（来自 frontmatter 的 argument-hint 字段） */
	argumentHint?: string;
	/** 模板正文内容（frontmatter 之后的部分） */
	content: string;
	/** 模板的来源信息（文件路径、作用域等） */
	sourceInfo: SourceInfo;
	/** 模板文件的绝对路径 */
	filePath: string;
}

/**
 * 定位：提示模板命令行参数解析器。
 * 作用：把 `/prompt foo "bar baz"` 这种输入拆成稳定的参数数组，供模板展开使用。
 * 调用关系：仅由 `expandPromptTemplate()` 调用，结果继续传给 `substituteArgs()`。
 *
 * 例如: `'hello world' arg2 "arg three"` → ["hello world", "arg2", "arg three"]
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			// 引号内保留空白，仅在遇到同类引号时结束当前片段。
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			// 非引号态遇到引号，开始收集一个整体参数。
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				// 空白只在当前片段非空时切分参数，避免生成空字符串参数。
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * 定位：提示模板正文的参数替换器。
 * 作用：把模板中的位置参数和聚合参数占位符替换成用户输入的实参。
 * 调用关系：由 `expandPromptTemplate()` 在模板命中后调用。
 *
 * 支持的占位符：
 * - $1, $2, ...  → 位置参数（1-indexed）
 * - $@ 和 $ARGUMENTS  → 所有参数拼接
 * - ${@:N}  → 从第 N 个参数开始的所有参数（bash 风格切片）
 * - ${@:N:L}  → 从第 N 个参数开始的 L 个参数
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// 先替换位置参数 $1, $2 等（在通配符之前替换，防止二次替换）
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	// 替换 ${@:start} 或 ${@:start:length}（bash 风格切片），在 $@ 之前处理
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1; // 转为 0 索引（用户提供的是 1 索引）
		if (start < 0) start = 0; // 将 0 视为 1（bash 惯例：参数从 1 开始）

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	// 预计算所有参数的拼接结果
	const allArgs = args.join(" ");

	// 替换 $ARGUMENTS（新语法，与 Claude/Codex/OpenCode 对齐）
	result = result.replace(/\$ARGUMENTS/g, allArgs);

	// 替换 $@（现有语法）
	result = result.replace(/\$@/g, allArgs);

	return result;
}

/**
 * 定位：单个提示模板文件的加载器。
 * 作用：读取 `.md` 模板、解析 frontmatter，并产出运行时可消费的 `PromptTemplate`。
 * 调用关系：由 `loadTemplatesFromDir()` 和显式文件路径加载流程调用。
 */
function loadTemplateFromFile(filePath: string, sourceInfo: SourceInfo): PromptTemplate | null {
	try {
		// 先解析 frontmatter，再从文件名与正文补齐模板元数据。
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);

		const name = basename(filePath).replace(/\.md$/, "");

		// 从 frontmatter 或首行非空文本获取描述
		let description = frontmatter.description || "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) {
				// 过长时截断
				description = firstLine.slice(0, 60);
				if (firstLine.length > 60) description += "...";
			}
		}

		return {
			name,
			description,
			...(frontmatter["argument-hint"] && { argumentHint: frontmatter["argument-hint"] }),
			content: body,
			sourceInfo,
			filePath,
		};
	} catch {
		return null;
	}
}

/**
 * 定位：目录级提示模板收集器。
 * 作用：扫描单层目录中的 `.md` 文件并批量转成模板对象。
 * 调用关系：由 `loadPromptTemplates()` 在默认目录和显式目录路径上调用。
 */
function loadTemplatesFromDir(dir: string, getSourceInfo: (filePath: string) => SourceInfo): PromptTemplate[] {
	const templates: PromptTemplate[] = [];

	if (!existsSync(dir)) {
		return templates;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// 对于符号链接，检查其指向的是否为文件
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
				} catch {
					// 损坏的符号链接，跳过
					continue;
				}
			}

			if (isFile && entry.name.endsWith(".md")) {
				// 仅收集 markdown 模板文件，其他文件类型直接跳过。
				const template = loadTemplateFromFile(fullPath, getSourceInfo(fullPath));
				if (template) {
					templates.push(template);
				}
			}
		}
	} catch {
		return templates;
	}

	return templates;
}

export interface LoadPromptTemplatesOptions {
	/** 项目工作目录，用于加载项目级模板 */
	cwd: string;
	/** Agent 配置目录，用于加载全局模板 */
	agentDir: string;
	/** 显式指定的提示模板路径（文件或目录） */
	promptPaths: string[];
	/** 是否包含默认的提示目录 */
	includeDefaults: boolean;
}

/**
 * 定位：提示模板总加载入口。
 * 作用：合并全局、项目级和显式路径中的模板，生成启动期模板列表。
 * 调用关系：由资源加载与会话初始化流程调用，结果再交给输入处理阶段展开命令。
 *
 * 加载顺序：
 * 1. 全局：agentDir/prompts/
 * 2. 项目级：cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. 显式指定的提示模板路径
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions): PromptTemplate[] {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const promptPaths = options.promptPaths;
	const includeDefaults = options.includeDefaults;

	const templates: PromptTemplate[] = [];

	const globalPromptsDir = join(resolvedAgentDir, "prompts");
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSourceInfo = (resolvedPath: string): SourceInfo => {
		// 先判断是否落在默认目录中，以便写入准确的 scope/baseDir。
		if (isUnderPath(resolvedPath, globalPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "user",
				baseDir: globalPromptsDir,
			});
		}
		if (isUnderPath(resolvedPath, projectPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectPromptsDir,
			});
		}
		return createSyntheticSourceInfo(resolvedPath, {
			source: "local",
			baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
		});
	};

	if (includeDefaults) {
		// 先装载默认目录，再追加显式路径，保持来源顺序稳定。
		templates.push(...loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		templates.push(...loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}

	// 3. 加载显式指定的提示路径
	for (const rawPath of promptPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			if (stats.isDirectory()) {
				templates.push(...loadTemplatesFromDir(resolvedPath, getSourceInfo));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const template = loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath));
				if (template) {
					templates.push(template);
				}
			}
		} catch {
			// 忽略读取失败
		}
	}

	return templates;
}

/**
 * 定位：用户输入到模板正文的展开入口。
 * 作用：识别 `/name args` 形式的输入，命中模板时返回替换后的正文，否则原样透传。
 * 调用关系：由输入处理链路调用；内部依次复用 `parseCommandArgs()` 和 `substituteArgs()`。
 *
 * @param text - 用户输入文本（如 "/review src/foo.ts"）
 * @param templates - 已加载的提示模板列表
 * @returns 展开后的文本或原始文本
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;

	const templateName = match[1];
	const argsString = match[2] ?? "";

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		// 先解析参数，再把参数灌入模板正文。
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	return text;
}
