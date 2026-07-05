/**
 * 设置管理器（Settings Manager）—— 读取、写入、合并全局和项目级设置。
 *
 * 文件定位：coding-agent 的设置持久化层，负责从文件系统或内存加载 settings.json，
 * 支持全局设置（~/.pi/settings.json）和项目设置（{cwd}/.pi/settings.json）两层合并，
 * 以及旧格式的自动迁移。
 *
 * 提供：
 * - Settings 接口：所有可配置项的类型定义
 * - SettingsManager 类：设置的读取、写入、热重载、变更追踪、持久化
 * - FileSettingsStorage / InMemorySettingsStorage：文件和内存两种存储后端
 * - deepMergeSettings()：递归合并全局和项目设置（项目级优先）
 *
 * 调用链路：
 * - 被 agent 启动时创建，加载并合并全局/项目设置
 * - 被 TUI/CLI 各模块调用，获取/修改各项配置
 * - 调用 config.ts 获取 agent 目录和配置目录名
 * - 使用 proper-lockfile 实现文件锁，防止并发写入冲突
 */

import type { Transport } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";

/** 压缩（compaction）设置 */
export interface CompactionSettings {
	enabled?: boolean; // 是否启用压缩，默认: true
	reserveTokens?: number; // 为压缩后的响应预留的 token 数，默认: 16384
	keepRecentTokens?: number; // 压缩时保留的最近对话 token 数，默认: 20000
}

/** 分支摘要设置 */
export interface BranchSummarySettings {
	reserveTokens?: number; // 为摘要提示和 LLM 响应预留的 token 数，默认: 16384
	skipPrompt?: boolean; // 为 true 时跳过"是否生成摘要"的提示，默认为不生成摘要，默认: false
}

/** Provider 级别的重试设置 */
export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider 请求超时时间（毫秒）
	maxRetries?: number; // SDK/provider 重试次数
	maxRetryDelayMs?: number; // 服务端要求的最大延迟时间，超过则失败，默认: 60000
}

/** 重试设置 */
export interface RetrySettings {
	enabled?: boolean; // 是否启用重试，默认: true
	maxRetries?: number; // 最大重试次数，默认: 3
	baseDelayMs?: number; // 指数退避基础延迟（毫秒），默认: 2000（2s → 4s → 8s）
	provider?: ProviderRetrySettings; // Provider 级别的重试设置
}

/** 终端显示设置 */
export interface TerminalSettings {
	showImages?: boolean; // 是否在终端中显示图片，默认: true（仅在终端支持时有效）
	imageWidthCells?: number; // 终端内联图片的首选宽度（以终端单元格为单位），默认: 60
	clearOnShrink?: boolean; // 内容缩小时是否清除空行，默认: false
	showTerminalProgress?: boolean; // 是否显示 OSC 9;4 终端进度指示器，默认: false
}

/** 图片处理设置 */
export interface ImageSettings {
	autoResize?: boolean; // 是否自动缩放图片至 2000x2000 最大尺寸以提高模型兼容性，默认: true
	blockImages?: boolean; // 是否阻止所有图片发送给 LLM provider，默认: false
}

/** 思考级别自定义 token 预算设置 */
export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

/** Markdown 渲染设置 */
export interface MarkdownSettings {
	codeBlockIndent?: string; // 代码块缩进字符，默认: "  "（两个空格）
}

/** 警告设置 */
export interface WarningSettings {
	anthropicExtraUsage?: boolean; // 是否显示 Anthropic 额外使用量警告，默认: true
}

/** 传输层设置类型 */
export type TransportSetting = Transport;

/**
 * npm/git 包的来源配置。
 * - 字符串形式：从该包加载所有资源
 * - 对象形式：可指定过滤要加载的资源类型
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

/** 核心设置接口，定义所有可配置项 */
export interface Settings {
	// 版本与会话持久化
	lastChangelogVersion?: string;
	sessionDir?: string; // 自定义会话存储目录（与 --session-dir CLI 标志格式相同）

	// 默认模型与推理行为
	defaultProvider?: string;
	defaultModel?: string;
	enabledModels?: string[]; // 模型循环模式列表（与 --models CLI 标志格式相同）
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	thinkingBudgets?: ThinkingBudgetsSettings; // 自定义思考级别的 token 预算
	transport?: TransportSetting; // 传输层模式，默认: "auto"
	retry?: RetrySettings; // 重试设置
	httpIdleTimeoutMs?: number; // HTTP 头/体空闲超时时间（毫秒），0 表示禁用

	// 对话与运行流程
	steeringMode?: "all" | "one-at-a-time"; // 消息引导模式
	followUpMode?: "all" | "one-at-a-time"; // 跟进消息模式
	compaction?: CompactionSettings; // 压缩设置
	branchSummary?: BranchSummarySettings; // 分支摘要设置
	hideThinkingBlock?: boolean; // 是否隐藏思考过程块
	quietStartup?: boolean; // 静默启动模式
	collapseChangelog?: boolean; // 更新后显示精简 changelog（用 /changelog 查看完整版）

	// Shell 与命令执行
	shellPath?: string; // 自定义 shell 路径（如 Windows Cygwin 用户使用）
	shellCommandPrefix?: string; // 每条 bash 命令前添加的前缀（如 "shopt -s expand_aliases" 以支持别名）
	npmCommand?: string[]; // npm 包查找/安装命令，argv 格式（如 ["mise", "exec", "node@20", "--", "npm"]）

	// 外观与交互
	theme?: string;
	terminal?: TerminalSettings; // 终端显示设置
	images?: ImageSettings; // 图片处理设置
	doubleEscapeAction?: "fork" | "tree" | "none"; // 编辑器为空时双击 Escape 的操作（默认: "tree"）
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // 打开 /tree 时的默认过滤模式
	editorPaddingX?: number; // 输入编辑器的水平内边距（默认: 0）
	autocompleteMaxVisible?: number; // 自动补全下拉列表的最大可见项数（默认: 5）
	showHardwareCursor?: boolean; // 在定位终端光标以支持 IME 的同时显示硬件光标
	markdown?: MarkdownSettings; // Markdown 渲染设置
	warnings?: WarningSettings; // 警告设置

	// 资源来源与扩展能力
	packages?: PackageSource[]; // npm/git 包来源数组（字符串或带过滤器的对象）
	extensions?: string[]; // 本地扩展文件路径或目录数组
	skills?: string[]; // 本地技能文件路径或目录数组
	prompts?: string[]; // 本地提示模板文件路径或目录数组
	themes?: string[]; // 本地主题文件路径或目录数组
	enableSkillCommands?: boolean; // 是否将技能注册为 /skill:name 命令，默认: true

	// 统计与遥测
	enableInstallTelemetry?: boolean; // 是否启用安装遥测（匿名版本/更新 ping），默认: true
}

/**
 * 定位：设置对象的基础合并器。
 * 作用：以全局设置为底，把项目级或临时覆盖递归叠加上去。
 * 调用关系：由构造、重载、覆盖应用和保存前刷新多个路径共用。
 */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// 对原始类型和数组，覆盖值直接替换。
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

/** 设置的作用域：全局或项目级 */
export type SettingsScope = "global" | "project";

/** 设置存储后端接口 */
export interface SettingsStorage {
	/** 在锁保护下读取/写入指定作用域的设置内容 */
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

/** 设置操作的错误记录 */
export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

/** 基于文件系统的设置存储后端，使用 proper-lockfile 实现并发安全 */
export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		// 构造时先把传入路径规范化，避免后续锁文件和读写路径受相对路径差异影响。
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	/** 获取文件锁，带重试机制（最多重试 10 次，间隔 20ms） */
	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				// 拿到锁后直接返回 release 函数，调用方在 finally 中统一释放。
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				// 只对“文件当前被锁住”这一类竞争错误做短暂重试，其它错误直接抛出。
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}

				// 记录最后一次锁竞争错误；如果后续一直失败，循环外会把它作为最终错误抛出。
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// 同步等待，避免将调用者改为 async
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	// 在文件锁保护下，完成一次“读取当前设置内容 -> 让调用方决定是否修改 -> 需要时写回”的完整事务
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		// 先根据作用域解析出目标设置文件路径。
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// 仅在文件存在或需要写入时才创建目录和获取锁
			const fileExists = existsSync(path);
			if (fileExists) {
				// 已存在文件时先加锁再读取，避免读到另一个写线程更新中的中间状态。
				release = this.acquireLockSyncWithRetry(path);
			}

			// 读取当前文本内容并交给回调决定是否需要写回。
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// 仅在实际需要写入时才创建目录
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					// 文件原本不存在但现在要写入时，在真正落盘前补拿锁。
					release = this.acquireLockSyncWithRetry(path);
				}

				// 回调返回的新内容按 utf-8 原样覆盖写回。
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			// 无论读取、回调还是写入阶段是否抛错，只要拿过锁就必须释放。
			if (release) {
				release();
			}
		}
	}
}

/** 基于内存的设置存储后端（不涉及文件 I/O，用于测试） */
export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

/**
 * 设置管理器——管理全局和项目级设置的读取、写入、合并与持久化。
 *
 * 主要职责：
 * 1. 从文件或内存加载全局设置和项目设置，执行深度合并
 * 2. 追踪会话期间修改的字段，实现增量持久化（只写变更部分）
 * 3. 支持旧格式自动迁移（queueMode -> steeringMode 等）
 * 4. 通过异步写入队列保证并发安全
 */
export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	/** 追踪会话期间修改的全局顶层字段 */
	private modifiedFields = new Set<keyof Settings>();
	/** 追踪会话期间修改的全局嵌套字段（如 compaction.enabled） */
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>();
	/** 追踪会话期间修改的项目级顶层字段 */
	private modifiedProjectFields = new Set<keyof Settings>();
	/** 追踪会话期间修改的项目级嵌套字段 */
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>();
	/** 全局设置文件加载时的解析错误（如有） */
	private globalSettingsLoadError: Error | null = null;
	/** 项目设置文件加载时的解析错误（如有） */
	private projectSettingsLoadError: Error | null = null;
	/** 异步写入队列，保证写操作顺序执行 */
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** 从文件系统创建 SettingsManager */
	static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage);
	}

	/** 创建纯内存模式的 SettingsManager（无文件 I/O） */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage);
	}

	/** 从任意存储后端创建 SettingsManager */
	static fromStorage(storage: SettingsStorage): SettingsManager {
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
		);
	}

	/**
	 * 安全读取指定作用域的设置。
	 *
	 * 定位：对 `loadFromStorage()` 的容错包装层，把异常转换成 `{ settings, error }`
	 * 结果对象，避免调用方在初始化阶段被单个损坏配置文件直接打断。
	 *
	 * @param storage 设置存储后端
	 * @param scope 要读取的作用域（global / project）
	 * @returns 成功时返回解析后的设置，失败时返回空设置和错误对象
	 */
	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; error: Error | null } {
		try {
			// 读取成功时保留真实设置，并显式标记 error 为 null。
			return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
		} catch (error) {
			// 解析失败、I/O 失败等都降级成“空设置 + 错误”，由上层决定如何记录和展示。
			return { settings: {}, error: error as Error };
		}
	}

	/**
	 * 从指定作用域的存储后端读取设置，并在返回前执行兼容迁移。
	 *
	 * 定位：底层读取辅助函数，供 `fromStorage()` 和 `reload()` 的加载链路复用。
	 *
	 * @param storage 设置存储后端
	 * @param scope 要读取的作用域（global / project）
	 * @returns 解析并迁移后的设置对象；无内容时返回空对象
	 */
	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
		let content: string | undefined;

		// 读取也通过存储层的锁入口完成，保证和写入路径共享同一套并发保护语义。
		storage.withLock(scope, (current) => {
			content = current;
			// 这里是纯读取操作，不需要写回内容，因此返回 undefined。
			return undefined;
		});

		// 对应作用域尚未创建设置文件时，按“空配置”处理。
		if (!content) {
			return {};
		}

		// 先解析 JSON，再统一走迁移逻辑，把旧版字段形态收敛到当前接口结构。
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	/**
	 * 定位：设置文件的兼容迁移入口。
	 * 作用：把旧版字段形态转换成当前结构，降低升级期间的手工修复成本。
	 * 调用关系：由存储加载流程调用，确保内存中的设置始终符合当前接口。
	 */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// 迁移 queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// 迁移旧版 websockets 布尔值 -> transport 枚举
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// 迁移旧版 skills 对象格式到新版数组格式
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// 迁移 retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	/** 返回全局设置的深拷贝，避免调用方直接修改内部状态对象。 */
	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	/** 返回项目级设置的深拷贝，避免外部持有内部引用并绕过变更追踪。 */
	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	/**
	 * 从存储后端重新加载全局和项目级设置，并刷新内存中的合并结果。
	 *
	 * 定位：运行时重载入口，供外部在设置文件被修改后同步内存态。
	 *
	 * 调用关系：
	 * - 先等待当前写入队列排空
	 * - 再分别读取 global / project 两个作用域
	 * - 最后重新执行一次深度合并
	 */
	async reload(): Promise<void> {
		// 步骤 1：先等待排队写入完成，避免读到自己尚未落盘的旧快照。
		await this.writeQueue;

		// 先刷新全局设置；成功时覆盖内存快照，失败时保留旧值并记录错误。
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		// 步骤 2：重置修改追踪，再重新加载全局与项目配置。
		// 这些集合记录的是“当前内存态相对磁盘的待写改动”；
		// 一旦主动从磁盘重载，就要把旧的脏标记全部清空，避免后续保存时把过期变更再次写回。
		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		// 再刷新项目级设置；项目级读取失败同样只记录错误，不中断整个 reload 流程。
		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		// 最后按“全局为底、项目覆盖”的规则重建当前生效设置。
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** 在当前设置基础上叠加额外覆盖 */
	applyOverrides(overrides: Partial<Settings>): void {
		// 这类覆盖只作用于当前内存态，不进入全局/项目配置文件，也不参与修改追踪。
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** 标记全局字段为会话期间已修改 */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			// 嵌套对象字段单独记录到第二层集合，持久化时只回写这些子键。
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** 标记项目级字段为会话期间已修改 */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			// 项目级和全局级分别追踪，避免两个作用域的改动互相污染。
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** 规范化并记录一次设置读写错误，供外部稍后批量提取。 */
	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	/** 清空指定作用域的脏标记；持久化成功后调用。 */
	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	/**
	 * 把一次写入任务排进串行队列。
	 *
	 * 定位：所有落盘路径共享的调度器，保证多个写操作严格按顺序执行。
	 */
	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				// 让同一作用域的持久化任务严格串行执行，避免锁竞争和乱序覆盖。
				task();
				// 只有任务执行完成后才清理脏标记，避免尚未落盘的修改被误判为已保存。
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	/** 为嵌套字段的修改追踪创建快照，避免异步写入期间被后续变更继续修改。 */
	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	/**
	 * 将某个作用域的设置快照按“仅回写已改字段”的策略写回存储层。
	 *
	 * 定位：真正的落盘实现入口。`save()` / `saveProjectSettings()` 准备好快照和脏标记后，通过
	 * `enqueueWrite()` 排队回调到本方法，最终在 `withLock()` 的文件锁保护下完成读-改-写。
	 *
	 * 作用：
	 * - 从磁盘读出当前 JSON 并解析成运行时 Settings 对象
	 * - 用传入的快照值覆盖本次被标记过的字段
	 * - 对嵌套对象只更新被标记的子键，其余子键保持磁盘现状
	 *
	 * 被谁调用：
	 *   - `save()`（全局作用域，通过 enqueueWrite 间接调用）
	 *   - `saveProjectSettings()`（项目作用域，通过 enqueueWrite 间接调用）
	 *
	 * 调用了谁：
	 *   - `this.storage.withLock()`——底层的锁保护读写
	 *   - `SettingsManager.migrateSettings()`——合并前先做格式迁移
	 *
	 * @param scope 要持久化的作用域（"global" 或 "project"）
	 * @param snapshotSettings 当前内存态的冻结快照（调用前已完成 structuredClone）
	 * @param modifiedFields 本次被修改的顶层字段集合
	 * @param modifiedNestedFields 本次被修改的嵌套子键映射（field → Set<subKey>）
	 */
	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			// 先读取磁盘当前内容，再只把本次改动字段合并回去，避免覆盖其他未改字段。
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					// 嵌套对象只覆盖被标记过的子键，未改动的子键仍保留磁盘现状。
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					// 顶层原始值、数组或整个对象直接以快照值替换。
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	/**
	 * 持久化当前全局设置。
	 *
	 * 先把内存中的全局/项目配置重新合并成当前生效设置，再只把全局作用域的脏字段排队写回。
	 */
	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		// 全局设置文件本身不可读时，不继续覆盖写入，避免吞掉用户手工修复机会。
		if (this.globalSettingsLoadError) {
			return;
		}

		// 写入是异步串行的，这里先冻结当前快照，确保落盘内容与本次调用时的状态一致。
		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	/**
	 * 持久化当前项目级设置。
	 *
	 * 调用方会先构造一份新的项目设置对象，再通过这里统一替换内存态并排队写入。
	 */
	private saveProjectSettings(settings: Settings): void {
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		// 项目级配置有解析错误时停止持久化，等待用户修复原文件。
		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	/** 等待当前所有排队写入完成，供外部在退出或测试断言前同步状态。 */
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/** 取出并清空累计的错误列表，避免同一错误被重复上报。 */
	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	// -------------------------------------------------------------------------
	// 版本与会话路径
	// -------------------------------------------------------------------------

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	/** 【内部调用】更新已展示的 changelog 版本号，由启动流程自动触发。 */
	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	/** 返回规范化后的会话目录路径；未设置时保持 undefined。 */
	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	// -------------------------------------------------------------------------
	// 模型与请求默认值
	// -------------------------------------------------------------------------

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	/** 【/model 命令】设置默认 provider。 */
	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	/** 【/model 命令】设置默认模型。 */
	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	/** 【/model 命令】同时设置默认 provider 和模型。 */
	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	// -------------------------------------------------------------------------
	// 对话流程与推理控制
	// -------------------------------------------------------------------------

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	/** 【/settings 面板】设置消息注入模式。 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	/** 【/settings 面板】设置跟进消息模式。 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	/** 【/settings 面板】设置颜色主题。 */
	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	/** 【/settings 面板（Thinking level 子菜单）】设置默认思考等级。 */
	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	/** 返回传输偏好；未显式配置时默认交给 provider 自行决定。 */
	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	/** 【/settings 面板】设置传输层偏好。 */
	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	/** 【/settings 面板】设置是否启用自动压缩。 */
	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	/** 【/enable-retry 命令】设置是否启用自动重试。 */
	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	/**
	 * 解析 HTTP 空闲超时设置。
	 *
	 * 有值时先走统一解析器校验；未配置时退回默认值；配置非法时主动抛错暴露问题。
	 */
	getHttpIdleTimeoutMs(): number {
		const value = this.settings.httpIdleTimeoutMs;
		const timeoutMs = parseHttpIdleTimeoutMs(value);
		if (timeoutMs !== undefined) {
			return timeoutMs;
		}
		if (value !== undefined) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(value)}`);
		}
		return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	/** 【/settings 面板】设置 HTTP 空闲超时毫秒数。 */
	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		// 存储前向下取整，保证配置文件里始终是稳定的整数毫秒值。
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	/** 【/settings 面板】设置是否隐藏思考过程块。 */
	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	// -------------------------------------------------------------------------
	// Shell 与启动行为
	// -------------------------------------------------------------------------

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	/** 【CLI --shell-path】设置自定义 shell 路径。 */
	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	/** 【/settings 面板】设置静默启动模式。 */
	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	/** 【CLI --shell-command-prefix】设置每条 bash 命令前添加的前缀。 */
	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		// 返回副本而不是原数组，避免调用方直接修改内部状态。
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	/** 【CLI --npm-command】设置 npm 包查找/安装命令。 */
	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	/** 【/settings 面板】是否折叠 changelog 展示。 */
	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	/** 【/settings 面板】是否允许（匿名）安装遥测。 */
	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	// -------------------------------------------------------------------------
	// 资源路径与扩展能力
	// -------------------------------------------------------------------------

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	/** 【/package add 命令】设置全局包注册源。 */
	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	/** 【/package add 命令（项目级）】设置项目包注册源。 */
	setProjectPackages(packages: PackageSource[]): void {
		// 先基于当前项目配置克隆一份副本，再在副本上修改，避免原对象被外部继续持有和篡改。
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.packages = packages;
		this.markProjectModified("packages");
		this.saveProjectSettings(projectSettings);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	/** 【/extension add 命令】设置全局扩展路径。 */
	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	/** 【/extension add 命令（项目级）】设置项目扩展路径。 */
	setProjectExtensionPaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.extensions = paths;
		this.markProjectModified("extensions");
		this.saveProjectSettings(projectSettings);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	/** 【/skill add 命令】设置全局技能源路径。 */
	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	/** 【/skill add 命令（项目级）】设置项目技能源路径。 */
	setProjectSkillPaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.skills = paths;
		this.markProjectModified("skills");
		this.saveProjectSettings(projectSettings);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	/** 【/prompt add 命令】设置全局提示模板路径。 */
	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	/** 【/prompt add 命令（项目级）】设置项目提示模板路径。 */
	setProjectPromptTemplatePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.prompts = paths;
		this.markProjectModified("prompts");
		this.saveProjectSettings(projectSettings);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	/** 【/theme add 命令】设置全局主题路径。 */
	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	/** 【/theme add 命令（项目级）】设置项目主题路径。 */
	setProjectThemePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.themes = paths;
		this.markProjectModified("themes");
		this.saveProjectSettings(projectSettings);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	/** 【/settings 面板】是否启用技能命令。 */
	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	// -------------------------------------------------------------------------
	// 终端、图片与交互界面
	// -------------------------------------------------------------------------

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	/** 【/settings 面板】是否在终端显示图片。 */
	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			// 嵌套设置对象按需创建，避免把一整块默认结构预写进配置文件。
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		// 统一限制为正整数，避免布局层处理 0、负数或小数。
		return Math.max(1, Math.floor(width));
	}

	/** 【/settings 面板】设置终端图片宽度（字符格数）。 */
	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// 设置优先，其次环境变量，默认 false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	/** 【/settings 面板】终端尺寸缩小时是否清除屏幕。 */
	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	/** 【/settings 面板】是否显示终端操作进度条。 */
	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	/** 【/settings 面板】是否自动调整图片尺寸以适应终端。 */
	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	/** 【/settings 面板】是否拦截/屏蔽图片显示。 */
	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	/** 【/model set 命令】设置启用的模型白名单（glob 匹配模式）。 */
	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	/** 【/settings 面板】双击 Escape 触发的动作（fork / tree / none）。 */
	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		// 即使配置文件里写了未知值，也在读取阶段回退到安全默认值。
		return mode && valid.includes(mode) ? mode : "default";
	}

	/** 【/settings 面板】设置会话树的过滤显示模式。 */
	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		// 显式设置优先；未设置时兼容旧环境变量开关。
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	/** 【/settings 面板】是否使用终端硬件光标（而非软件绘制）。 */
	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	/** 【/settings 面板】设置编辑器水平内边距（0-3 格）。 */
	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	/** 【/settings 面板】设置自动补全面板最大可见条目数（3-20）。 */
	setAutocompleteMaxVisible(maxVisible: number): void {
		// 自动补全面板限制在合理区间，避免过小影响可用性，过大挤占终端空间。
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	// -------------------------------------------------------------------------
	// Markdown 与告警
	// -------------------------------------------------------------------------

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	/** 【/settings 面板（Warnings 子菜单）】批量设置各类告警开关。 */
	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
