/**
 * 资源加载器模块
 *
 * 文件定位：coding-agent 的统一资源加载与管理层。
 *
 * 功能概述：
 * - 集中管理扩展、技能、提示模板、主题和上下文文件（AGENTS.md）的加载
 * - 通过 package-manager.ts 解析包来源，合并用户级、项目级和 CLI 指定的资源
 * - 支持资源的热重载（/reload 命令触发）
 * - 处理资源冲突检测（同名资源的去重与诊断）
 * - 支持扩展提供的额外资源路径（extendResources）
 *
 * 提供：
 * - ResourceLoader 接口：统一的资源访问接口
 * - DefaultResourceLoader：默认实现，协调所有资源的发现、加载和缓存
 * - loadProjectContextFiles()：从 cwd 向上查找 AGENTS.md/CLAUDE.md 上下文文件
 *
 * 调用链路：
 *   应用启动 → DefaultResourceLoader.reload() → packageManager.resolve() → 各资源加载器
 *   扩展运行时 → extendResources() → 追加扩展提供的资源路径
 *   /reload 命令 → reload() → 重新加载所有资源
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "./extensions/loader.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./extensions/types.ts";
import { DefaultPackageManager, type PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	extendResources(paths: ResourceExtensionPaths): void;
	reload(): Promise<void>;
}

/**
 * 解析提示词输入：如果输入是一个存在的文件路径，则读取文件内容返回；否则将输入视为纯文本字符串原样返回。
 *
 * 定位：模块内部辅助函数，为 system prompt / append system prompt 的加载提供"文件或字符串"的统一解析。
 *
 * 被谁调用：
 *   - DefaultResourceLoader.reload() 在加载 systemPrompt 和 appendSystemPrompt 时调用
 *
 * 调用了谁：
 *   - node:fs.existsSync() —— 判断路径是否存在
 *   - node:fs.readFileSync() —— 读取文件内容
 *
 * @param input  - 用户提供的提示词源，可以是文件路径，也可以是纯文本内容
 * @param description - 用于日志/警告消息中的描述标签（如 "system prompt"、"append system prompt"）
 * @returns 解析后的字符串内容，或 undefined（当 input 为空时）
 */
function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	// 空输入直接视为未提供。
	if (!input) {
		return undefined;
	}

	// 若输入本身是一个存在的文件路径，则优先读取文件内容。
	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			// 文件可见但读取失败时，退回原始输入，避免彻底丢失提示词。
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	// 不存在的路径按纯文本提示词处理。
	return input;
}

/**
 * 从指定目录中加载第一个找到的上下文文件（AGENTS.md 或 CLAUDE.md，大小写不敏感）。
 *
 * 定位：模块内部辅助函数，为 loadProjectContextFiles() 提供单目录级别的上下文文件发现能力。
 *
 * 被谁调用：
 *   - loadProjectContextFiles() —— 在遍历祖先目录时调用
 *
 * 调用了谁：
 *   - node:fs.existsSync() —— 检查候选文件是否存在
 *   - node:fs.readFileSync() —— 读取文件内容
 *   - node:path.join() —— 拼接目录与文件名
 *
 * @param dir - 要搜索的目录绝对路径
 * @returns 找到时返回 { path, content }，未找到或读取失败时返回 null
 */
function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	// 按固定优先级尝试上下文文件名，兼容大小写差异。
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				// 找到首个可读文件后立即返回，不继续查找后续候选。
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				// 当前候选读取失败时继续尝试下一个候选文件。
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	// 当前目录下没有可用的上下文文件。
	return null;
}

/**
 * 从工作目录向上遍历所有祖先目录，收集 AGENTS.md / CLAUDE.md 上下文文件。
 *
 * 定位：导出的工具函数，供外部（SessionManager、DefaultResourceLoader.reload()、SDK 等）直接使用，
 *       用于构建项目级的上下文信息链（从全局 agent 配置到当前项目目录层层叠加）。
 *
 * 被谁调用：
 *   - DefaultResourceLoader.reload() —— 在 reload 流程中加载 agentsFiles
 *   - SessionManager（session-manager.ts）—— 独立于 resource-loader 直接调用
 *   - SDK（sdk.ts）—— 通过 index.ts 导出供外部 SDK 使用
 *
 * 调用了谁：
 *   - resolvePath()（utils/paths.ts）—— 规范化路径
 *   - loadContextFileFromDir() —— 在每个目录中搜索上下文文件
 *   - node:path.resolve() —— 计算父目录
 *
 * @param options.cwd       - 当前工作目录
 * @param options.agentDir  - agent 全局配置目录
 * @returns 按层级排序的上下文文件数组（全局优先，然后从根目录到 cwd）
 */
export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	// 先把入口路径统一解析为绝对路径，避免后续遍历时出现重复或比较错误。
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	// 先加载全局 agent 目录中的上下文文件，它位于整条上下文链最前面。
	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	// 再从 cwd 向上遍历祖先目录，把离根更近的文件放前面，离 cwd 更近的放后面。
	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		if (currentDir === root) break;

		// 到达根目录或无法继续上移时结束遍历。
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// 最终顺序：全局上下文 -> 祖先目录上下文（从远到近）。
	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

/**
 * DefaultResourceLoaderOptions 构造选项接口。
 *
 * 定位：DefaultResourceLoader 的配置入口，定义了所有可选的资源路径、禁用开关、
 *       外部覆盖钩子（override）和内联扩展工厂等参数。
 *
 * 关键字段说明：
 *   - cwd / agentDir：工作目录与 agent 全局配置目录，必填
 *   - settingsManager / eventBus：可选注入，默认自动创建
 *   - additionalXxxPaths：CLI 或程序额外指定的资源路径，会与包管理器解析的路径合并
 *   - noXxx 系列布尔开关：跳过对应资源类型的自动发现（用于测试或受限环境）
 *   - xxxOverride 系列钩子：允许外部对已加载的资源列表进行后处理（过滤、替换等）
 */
export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

/**
 * DefaultResourceLoader —— ResourceLoader 接口的默认实现。
 *
 * 定位：coding-agent 核心资源加载协调器，负责统一管理扩展(extensions)、技能(skills)、
 *       提示词模板(prompt templates)、主题(themes)和上下文文件(AGENTS.md)的发现、
 *       加载、缓存和冲突检测。
 *
 * 被谁调用（实例化）：
 *   - agent-session-services.ts 的 createSessionServices() —— 主要的会话创建入口
 *   - sdk.ts 的 createAgent() —— SDK 公开 API
 *   - 外部测试代码 —— 通过 index.ts 导出
 *
 * 实现的核心接口：ResourceLoader（定义 get* 方法组 + extendResources + reload）
 *
 * 核心调用链路：
 *   new DefaultResourceLoader(opts)          ← 构造，初始化所有缓存为空
 *   .reload()                                ← 应用启动时 / /reload 命令触发
 *     └─ packageManager.resolve()            ← 解析所有包来源的资源路径
 *     └─ loadExtensions()                    ← 加载扩展（tools/commands/flags）
 *     └─ loadExtensionFactories()            ← 加载内联扩展工厂
 *     └─ detectExtensionConflicts()          ← 检测扩展间同名工具/标志冲突
 *     └─ updateSkillsFromPaths()             ← 加载技能
 *     └─ updatePromptsFromPaths()            ← 加载提示词模板
 *     └─ updateThemesFromPaths()             ← 加载主题
 *     └─ loadProjectContextFiles()           ← 加载 AGENTS.md 上下文
 *     └─ resolvePromptInput()               ← 解析 system prompt
 *   .extendResources(paths)                  ← 扩展运行时动态追加资源路径
 *   .get*() 系列方法                          ← 读取已缓存的资源
 */
export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private extensionFactories: ExtensionFactory[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
	private lastSkillPaths: string[];
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];

	/**
	 * 构造函数 —— 初始化所有配置和缓存。
	 *
	 * 被谁调用：
	 *   - agent-session-services.ts 的 createSessionServices()
	 *   - sdk.ts 的 createAgent()
	 */
	constructor(options: DefaultResourceLoaderOptions) {
		// 先建立运行所需的基础依赖。
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});

		// 保存外部传入的附加资源路径和工厂能力。
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.extensionFactories = options.extensionFactories ?? [];

		// 保存各类资源的禁用开关。
		this.noExtensions = options.noExtensions ?? false;
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;

		// 保存 prompt 来源和各类 override 钩子。
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		// 初始化所有缓存，真正加载发生在 reload()。
		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
	}

	/**
	 * 返回当前已加载的扩展结果。
	 *
	 * 定位：只读访问器，供外部消费 `reload()` 之后缓存的扩展数据。
	 *
	 * 被谁调用：
	 *   - 会话初始化流程
	 *   - 交互模式/UI 层用于展示扩展加载错误
	 *
	 * 调用了谁：
	 *   - 无，仅返回缓存字段
	 */
	getExtensions(): LoadExtensionsResult {
		// 直接返回当前缓存的扩展结果。
		return this.extensionsResult;
	}

	/**
	 * 返回当前已加载的技能列表及其诊断信息。
	 *
	 * 定位：只读访问器，暴露 `reload()` / `extendResources()` 之后的技能缓存。
	 *
	 * 被谁调用：
	 *   - AgentSession 在构建技能上下文时调用
	 *   - 外部 SDK / 测试代码
	 *
	 * 调用了谁：
	 *   - 无，仅返回缓存字段
	 */
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		// 返回技能列表及对应诊断，供上层一次性消费。
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	/**
	 * 返回当前已加载的提示词模板及其诊断信息。
	 *
	 * 定位：只读访问器，暴露 prompt templates 缓存。
	 *
	 * 被谁调用：
	 *   - AgentSession 在解析斜杠命令或模板提示词时调用
	 *   - 外部 SDK / 测试代码
	 *
	 * 调用了谁：
	 *   - 无，仅返回缓存字段
	 */
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		// 返回提示词模板缓存及其诊断信息。
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	/**
	 * 返回当前已加载的主题及其诊断信息。
	 *
	 * 定位：只读访问器，暴露终端交互主题缓存。
	 *
	 * 被谁调用：
	 *   - interactive mode 主题选择/渲染逻辑
	 *   - 外部 SDK / 测试代码
	 *
	 * 调用了谁：
	 *   - 无，仅返回缓存字段
	 */
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		// 返回主题缓存及其诊断信息。
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	/**
	 * 返回当前已加载的上下文文件（AGENTS.md / CLAUDE.md）。
	 *
	 * 定位：只读访问器，暴露项目上下文链缓存。
	 *
	 * 被谁调用：
	 *   - Session/Prompt 构造逻辑，用于把项目上下文注入系统提示
	 *
	 * 调用了谁：
	 *   - 无，仅返回缓存字段
	 */
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		// 返回项目上下文文件链。
		return { agentsFiles: this.agentsFiles };
	}

	/**
	 * 返回主系统提示词内容。
	 *
	 * 定位：只读访问器，暴露 `SYSTEM.md` 或显式传入的 systemPrompt 解析结果。
	 *
	 * 被谁调用：
	 *   - Session 构建系统提示时调用
	 *
	 * 调用了谁：
	 *   - 无，仅返回缓存字段
	 */
	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	/**
	 * 返回附加系统提示词列表。
	 *
	 * 定位：只读访问器，暴露 `APPEND_SYSTEM.md` 或显式传入 appendSystemPrompt 的解析结果。
	 *
	 * 被谁调用：
	 *   - Session 构建最终系统提示时调用
	 *
	 * 调用了谁：
	 *   - 无，仅返回缓存字段
	 */
	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	/**
	 * 在运行时动态追加资源路径，并立即刷新对应类型的缓存。
	 *
	 * 定位：扩展运行时入口。某些扩展在加载后可以继续声明额外的 skills/prompts/themes，
	 *       这里负责把这些资源合并到当前 loader 中，而不是走一次完整 `reload()`。
	 *
	 * 被谁调用：
	 *   - 扩展运行时（extension runtime）
	 *   - AgentSession 在处理扩展资源扩展时
	 *
	 * 调用了谁：
	 *   - normalizeExtensionPaths() —— 规范化扩展提供的路径及其 metadata
	 *   - createSourceInfo() —— 为新增路径生成来源信息
	 *   - mergePaths() —— 与现有缓存路径去重合并
	 *   - updateSkillsFromPaths() / updatePromptsFromPaths() / updateThemesFromPaths()
	 */
	extendResources(paths: ResourceExtensionPaths): void {
		// 先把扩展动态传入的路径解析成标准绝对路径。
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		// 记录这些动态资源的来源，后续生成 sourceInfo 时优先使用。
		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		// 某一类资源只在对应路径有新增时做局部刷新。
		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths);
		}
	}

	/**
	 * 重新加载全部资源。
	 *
	 * 定位：DefaultResourceLoader 的核心入口。应用启动、会话初始化、`/reload` 命令都会走到这里。
	 *
	 * 被谁调用：
	 *   - agent-session-services.ts 的 createSessionServices()
	 *   - `/reload` 命令对应的调用链
	 *   - SDK 初始化流程
	 *
	 * 调用了谁：
	 *   - settingsManager.reload() —— 刷新设置
	 *   - packageManager.resolve() —— 解析用户级/项目级包中的资源路径
	 *   - packageManager.resolveExtensionSources() —— 解析 CLI 临时指定扩展
	 *   - loadExtensions() —— 加载扩展目录/文件
	 *   - loadExtensionFactories() —— 加载内联扩展工厂
	 *   - detectExtensionConflicts() —— 检测扩展工具/标志冲突
	 *   - applyExtensionSourceInfo() —— 为扩展及其命令/工具打上来源信息
	 *   - updateSkillsFromPaths() / updatePromptsFromPaths() / updateThemesFromPaths()
	 *   - loadProjectContextFiles() —— 读取 AGENTS.md / CLAUDE.md
	 *   - discoverSystemPromptFile() / discoverAppendSystemPromptFile()
	 *   - resolvePromptInput() —— 将 prompt 源解析成最终字符串
	 */
	async reload(): Promise<void> {
		// 1. 先刷新设置与包来源解析结果，准备本轮完整重载。
		await this.settingsManager.reload();
		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});
		const metadataByPath = new Map<string, PathMetadata>();

		// 每次完整重载都重建一遍扩展动态资源来源映射。
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();

		// 辅助函数：提取已启用的路径并存储元数据
		const getEnabledResources = (
			resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
		): Array<{ path: string; enabled: boolean; metadata: PathMetadata }> => {
			for (const r of resources) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, r.metadata);
				}
			}
			return resources.filter((r) => r.enabled);
		};

		const getEnabledPaths = (
			resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
		): string[] => getEnabledResources(resources).map((r) => r.path);
		const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);

		// 2. 自动发现的 skill 目录若存在 `SKILL.md`，实际应映射到这个文件。
		const mapSkillPath = (resource: { path: string; metadata: PathMetadata }): string => {
			// 非自动发现、非 package 来源的 skill 不做路径映射，直接返回原路径。
			if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
				return resource.path;
			}
			// 检查 resource.path 是否为目录：不是目录则直接返回原路径。
			// statSync 可能因权限等原因抛异常，此时也安全降级为原路径。
			try {
				const stats = statSync(resource.path);
				if (!stats.isDirectory()) {
					return resource.path;
				}
			} catch {
				return resource.path;
			}
			// 目录存在时，尝试查找其下的 SKILL.md 作为实际技能入口文件。
			const skillFile = join(resource.path, "SKILL.md");
			if (existsSync(skillFile)) {
				// 将目录的 metadata 关联到 SKILL.md，保证 sourceInfo 推断正确。
				if (!metadataByPath.has(skillFile)) {
					metadataByPath.set(skillFile, resource.metadata);
				}
				return skillFile;
			}
			// 目录下没有 SKILL.md，回退到原路径。
			return resource.path;
		};

		const enabledSkills = enabledSkillResources.map(mapSkillPath);

		// 3. 为 CLI 临时资源补充来源元数据，保证后续 sourceInfo 推断准确。
		for (const r of cliExtensionPaths.extensions) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
		for (const r of cliExtensionPaths.skills) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}

		const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
		const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
		const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
		const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

		// 4. 计算最终扩展路径，先加载磁盘扩展，再叠加内联扩展工厂。
		const extensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths(cliEnabledExtensions, enabledExtensions);

		const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);

		// 5. 检测扩展冲突；冲突只记诊断，不阻止已加载扩展保留。
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}

		// 6. 额外指定的本地扩展路径如果不存在，显式记入错误。
		for (const p of this.additionalExtensionPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved)) {
					extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
				}
			}
		}
		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

		// 7. 计算并刷新技能缓存。
		const skillPaths = this.noSkills
			? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
			: this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths);

		this.lastSkillPaths = skillPaths;
		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		for (const p of this.additionalSkillPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
					this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
				}
			}
		}

		// 8. 计算并刷新提示词模板缓存。
		const promptPaths = this.noPromptTemplates
			? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
			: this.mergePaths([...cliEnabledPrompts, ...enabledPrompts], this.additionalPromptTemplatePaths);

		this.lastPromptPaths = promptPaths;
		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		for (const p of this.additionalPromptTemplatePaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
					this.promptDiagnostics.push({
						type: "error",
						message: "Prompt template path does not exist",
						path: resolved,
					});
				}
			}
		}

		// 9. 计算并刷新主题缓存。
		const themePaths = this.noThemes
			? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
			: this.mergePaths([...cliEnabledThemes, ...enabledThemes], this.additionalThemePaths);

		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths, metadataByPath);
		for (const p of this.additionalThemePaths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
				this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
			}
		}

		// 10. 加载项目上下文文件链。
		const agentsFiles = {
			agentsFiles: this.noContextFiles ? [] : loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir }),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		// 11. 发现并解析主系统提示词。
		const baseSystemPrompt = resolvePromptInput(
			this.systemPromptSource ?? this.discoverSystemPromptFile(),
			"system prompt",
		);
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

		// 12. 发现并解析附加系统提示词列表。
		const appendSources =
			this.appendSystemPromptSource ??
			(this.discoverAppendSystemPromptFile() ? [this.discoverAppendSystemPromptFile()!] : []);
		const baseAppend = appendSources
			.map((s) => resolvePromptInput(s, "append system prompt"))
			.filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
	}

	/**
	 * 规范化扩展动态提供的资源路径。
	 *
	 * 定位：`extendResources()` 的辅助方法。
	 *
	 * 被谁调用：
	 *   - extendResources()
	 *
	 * 调用了谁：
	 *   - resolveResourcePath() —— 解析资源自身路径
	 */
	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		// 同时规范化资源路径和 metadata.baseDir，避免后续来源识别出现相对路径偏差。
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? { ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	/**
	 * 按给定路径重新加载技能缓存，并补全每个技能的来源信息。
	 *
	 * 定位：skills 资源的刷新入口，被 `reload()` 和 `extendResources()` 共用。
	 *
	 * 被谁调用：
	 *   - reload()
	 *   - extendResources()
	 *
	 * 调用了谁：
	 *   - loadSkills() —— 实际解析技能文件
	 *   - skillsOverride() —— 外部可选后处理
	 *   - findSourceInfoForPath() —— 先尝试按扩展 metadata 解析来源
	 *   - getDefaultSourceInfoForPath() —— 无 metadata 时的兜底来源推断
	 */
	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };

		// 没有可加载路径且技能被整体禁用时，直接清空结果。
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			// 否则按给定路径重新解析技能定义。
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}

		// 外部 override 有机会在这里改写最终技能结果。
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;

		// 为每个技能补齐来源信息，优先使用扩展显式提供的 metadata。
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	/**
	 * 按给定路径重新加载提示词模板缓存，并做重名去重与来源信息补全。
	 *
	 * 定位：prompts 资源的刷新入口，被 `reload()` 和 `extendResources()` 共用。
	 *
	 * 被谁调用：
	 *   - reload()
	 *   - extendResources()
	 *
	 * 调用了谁：
	 *   - loadPromptTemplates() —— 加载模板文件
	 *   - dedupePrompts() —— 按名称去重并产生 collision 诊断
	 *   - promptsOverride() —— 外部可选后处理
	 *   - findSourceInfoForPath() / getDefaultSourceInfoForPath()
	 */
	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };

		// 没有可加载路径且模板被整体禁用时，直接清空结果。
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			// 先加载全部模板，再按名称去重。
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}

		// 外部 override 可以在写回缓存前做最后调整。
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;

		// 为每个模板补齐来源信息。
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	/**
	 * 按给定路径重新加载主题缓存，并做重名去重与来源信息补全。
	 *
	 * 定位：themes 资源的刷新入口，被 `reload()` 和 `extendResources()` 共用。
	 *
	 * 被谁调用：
	 *   - reload()
	 *   - extendResources()
	 *
	 * 调用了谁：
	 *   - loadThemes() —— 加载主题文件/目录
	 *   - dedupeThemes() —— 按主题名去重并产生 collision 诊断
	 *   - themesOverride() —— 外部可选后处理
	 *   - findSourceInfoForPath() / getDefaultSourceInfoForPath()
	 */
	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };

		// 没有可加载路径且主题被整体禁用时，直接清空结果。
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			// 先加载主题，再按主题名去重，并把两个阶段的诊断合并。
			const loaded = this.loadThemes(themePaths, false);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}

		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;

		// 主题的来源信息依赖 `sourcePath`，因此逐项补齐。
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	/**
	 * 为扩展对象及其下属命令/工具统一附加来源信息。
	 *
	 * 定位：扩展加载完成后的后处理步骤。
	 *
	 * 被谁调用：
	 *   - reload()
	 *
	 * 调用了谁：
	 *   - findSourceInfoForPath()
	 *   - getDefaultSourceInfoForPath()
	 */
	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		// 扩展本身先确定来源，再把同一来源传播给其命令和工具。
		for (const extension of extensions) {
			extension.sourceInfo =
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				this.getDefaultSourceInfoForPath(extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	/**
	 * 根据资源路径查找最合适的来源信息。
	 *
	 * 定位：sourceInfo 推断的统一入口，服务于 skills/prompts/themes/extensions。
	 *
	 * 被谁调用：
	 *   - updateSkillsFromPaths()
	 *   - updatePromptsFromPaths()
	 *   - updateThemesFromPaths()
	 *   - applyExtensionSourceInfo()
	 *
	 * 调用了谁：
	 *   - createSourceInfo()
	 *   - getDefaultSourceInfoForPath()（处理 `<inline:1>` 这类虚拟路径）
	 *   - node:path.resolve() —— 统一路径比较
	 */
	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		// 空路径无法推断来源。
		if (!resourcePath) {
			return undefined;
		}

		// `<inline:n>` 这类虚拟路径不对应真实文件，直接走默认来源逻辑。
		if (resourcePath.startsWith("<")) {
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);
		if (extraSourceInfos) {
			// 扩展动态注入的来源信息优先级最高，可按父目录覆盖子文件。
			for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		if (metadataByPath) {
			// 先做精确匹配，再退化到祖先目录匹配。
			const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			if (exact) {
				return createSourceInfo(resourcePath, exact);
			}

			for (const [sourcePath, metadata] of metadataByPath.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return createSourceInfo(resourcePath, metadata);
				}
			}
		}

		return undefined;
	}

	/**
	 * 在没有显式 metadata 时，根据路径位置推断默认来源信息。
	 *
	 * 定位：`findSourceInfoForPath()` 的兜底推断逻辑。
	 *
	 * 被谁调用：
	 *   - updateSkillsFromPaths()
	 *   - updatePromptsFromPaths()
	 *   - updateThemesFromPaths()
	 *   - applyExtensionSourceInfo()
	 *   - findSourceInfoForPath()（处理虚拟路径）
	 *
	 * 调用了谁：
	 *   - isUnderPath() —— 判断是否位于 agent/project 默认目录下
	 *   - node:fs.statSync() —— 生成 baseDir 时判断文件/目录
	 */
	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		// 虚拟路径（如内联扩展）统一按 temporary/top-level 处理。
		if (filePath.startsWith("<") && filePath.endsWith(">")) {
			return {
				path: filePath,
				source: filePath.slice(1, -1).split(":")[0] || "temporary",
				scope: "temporary",
				origin: "top-level",
			};
		}

		// 先准备用户级与项目级的默认资源根目录。
		const normalizedPath = resolve(filePath);
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		// 优先识别是否属于用户级资源目录。
		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		// 其次识别是否属于项目级资源目录。
		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		// 其余情况按临时本地资源兜底，baseDir 取目录本身或文件所在目录。
		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
		};
	}

	/**
	 * 合并两组路径并去重，同时统一做路径解析和 canonicalize。
	 *
	 * 定位：资源路径合并工具，`reload()` / `extendResources()` 都会使用。
	 *
	 * 被谁调用：
	 *   - extendResources()
	 *   - reload()
	 *
	 * 调用了谁：
	 *   - resolveResourcePath()
	 *   - canonicalizePath()
	 */
	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		// 先后顺序决定优先级，重复路径只保留首次出现者。
		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	/**
	 * 解析单个资源路径。
	 *
	 * 定位：极小的路径封装，统一走 `resolvePath()` 并以 `cwd` 为相对路径基准。
	 *
	 * 被谁调用：
	 *   - normalizeExtensionPaths()
	 *   - reload()
	 *   - mergePaths()
	 *
	 * 调用了谁：
	 *   - resolvePath()
	 */
	private resolveResourcePath(p: string): string {
		return resolvePath(p, this.cwd, { trim: true });
	}

	/**
	 * 加载主题资源，支持默认目录、显式目录和单个 json 文件。
	 *
	 * 定位：主题加载的主入口，供 `updateThemesFromPaths()` 调用。
	 *
	 * 被谁调用：
	 *   - updateThemesFromPaths()
	 *
	 * 调用了谁：
	 *   - resolveResourcePath()
	 *   - loadThemesFromDir()
	 *   - loadThemeFromFile()
	 *   - node:fs.existsSync() / statSync()
	 */
	private loadThemes(
		paths: string[],
		includeDefaults: boolean = true,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		// 同时收集成功加载的主题和加载过程中的警告。
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			// 默认主题目录总是先于显式路径加载。
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics);
			}
		}

		// 再处理额外传入的主题路径，支持目录和单文件两种形式。
		for (const p of paths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	/**
	 * 从目录中批量加载所有 `.json` 主题文件。
	 *
	 * 定位：`loadThemes()` 的目录级辅助函数。
	 *
	 * 被谁调用：
	 *   - loadThemes()
	 *
	 * 调用了谁：
	 *   - node:fs.readdirSync()
	 *   - node:fs.statSync() —— 处理符号链接
	 *   - loadThemeFromFile()
	 */
	private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		// 不存在的目录不报错，直接跳过。
		if (!existsSync(dir)) {
			return;
		}

		try {
			// 只加载目录中的 json 文件；符号链接需要跟随确认目标类型。
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	/**
	 * 从单个文件加载主题。
	 *
	 * 定位：`loadThemes()` / `loadThemesFromDir()` 的最小加载单元。
	 *
	 * 被谁调用：
	 *   - loadThemes()
	 *   - loadThemesFromDir()
	 *
	 * 调用了谁：
	 *   - loadThemeFromPath()
	 */
	private loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		try {
			// 单文件主题的真正解析逻辑交给 theme 模块。
			themes.push(loadThemeFromPath(filePath));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	/**
	 * 加载通过构造参数注入的内联扩展工厂。
	 *
	 * 定位：扩展加载流程的补充入口，覆盖“不是从磁盘路径加载，而是由代码直接提供工厂函数”的场景。
	 *
	 * 被谁调用：
	 *   - reload()
	 *
	 * 调用了谁：
	 *   - loadExtensionFromFactory()
	 */
	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		// 逐个执行内联扩展工厂，并用虚拟路径标识其来源。
		for (const [index, factory] of this.extensionFactories.entries()) {
			const extensionPath = `<inline:${index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	/**
	 * 对提示词模板按名称去重，保留先出现者，并为冲突生成诊断。
	 *
	 * 定位：prompt templates 的去重策略实现。
	 *
	 * 被谁调用：
	 *   - updatePromptsFromPaths()
	 *
	 * 调用了谁：
	 *   - 无，仅使用 Map 做内存级去重
	 */
	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		// 同名 prompt 只保留首次出现者，后者转为 collision 诊断。
		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	/**
	 * 对主题按名称去重，保留先出现者，并为冲突生成诊断。
	 *
	 * 定位：theme 资源的去重策略实现。
	 *
	 * 被谁调用：
	 *   - updateThemesFromPaths()
	 *
	 * 调用了谁：
	 *   - 无，仅使用 Map 做内存级去重
	 */
	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		// 同名主题只保留首次出现者，后续同名项只留下诊断。
		for (const t of themes) {
			const name = t.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: t.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, t);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	/**
	 * 自动发现主系统提示词文件 `SYSTEM.md`。
	 *
	 * 定位：system prompt 发现逻辑，供 `reload()` 使用。
	 *
	 * 被谁调用：
	 *   - reload()
	 *
	 * 调用了谁：
	 *   - node:path.join()
	 *   - node:fs.existsSync()
	 */
	private discoverSystemPromptFile(): string | undefined {
		// 项目级配置优先级高于用户级全局配置。
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	/**
	 * 自动发现附加系统提示词文件 `APPEND_SYSTEM.md`。
	 *
	 * 定位：append system prompt 发现逻辑，供 `reload()` 使用。
	 *
	 * 被谁调用：
	 *   - reload()
	 *
	 * 调用了谁：
	 *   - node:path.join()
	 *   - node:fs.existsSync()
	 */
	private discoverAppendSystemPromptFile(): string | undefined {
		// 项目级配置优先级高于用户级全局配置。
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	/**
	 * 判断目标路径是否位于给定根路径之下（或就是根路径本身）。
	 *
	 * 定位：路径归属判断工具，主要服务于来源信息推断。
	 *
	 * 被谁调用：
	 *   - getDefaultSourceInfoForPath()
	 *
	 * 调用了谁：
	 *   - node:path.resolve()
	 */
	private isUnderPath(target: string, root: string): boolean {
		// 既支持 target 与 root 完全相等，也支持 target 位于 root 之下。
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}

	/**
	 * 检测多个扩展之间的工具名和标志名冲突。
	 *
	 * 定位：扩展冲突分析器。它不阻止扩展加载，只生成诊断信息，实际优先级由加载顺序决定。
	 *
	 * 被谁调用：
	 *   - reload()
	 *
	 * 调用了谁：
	 *   - 无，仅遍历 extension 内部的 `tools` / `flags` 映射
	 */
	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

		// 分别跟踪工具名和标志名的首个拥有者。
		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		// 后出现的同名项会被记为冲突，但不会从结果中删除。
		for (const ext of extensions) {
			// 检查工具冲突。
			for (const toolName of ext.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, ext.path);
				}
			}

			// 检查标志冲突。
			for (const flagName of ext.flags.keys()) {
				const existingOwner = flagOwners.get(flagName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					flagOwners.set(flagName, ext.path);
				}
			}
		}

		return conflicts;
	}
}
