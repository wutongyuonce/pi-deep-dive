/**
 * agent-session-services.ts - 会话运行时服务层
 *
 * 作用：负责创建与 cwd 绑定的运行时基础设施（认证存储、设置管理器、模型注册表、资源加载器等）。
 *       这些服务与 AgentSession 的创建是分离的，使得调用方可以在创建 session 之前先解析模型、工具等选项。
 *
 * 定位：core 层的服务工厂，位于 sdk.ts（会话创建）和 agent-session-runtime.ts（运行时生命周期）之间。
 *
 * 提供的能力：
 * - AgentSessionServices：cwd 绑定的运行时服务集合接口
 * - AgentSessionRuntimeDiagnostic：非致命诊断信息（info/warning/error）
 * - createAgentSessionServices()：创建运行时服务（不创建 AgentSession）
 * - createAgentSessionFromServices()：从已有服务创建 AgentSession
 *
 * 调用关系：
 * - agent-session-runtime.ts → createAgentSessionServices() → 创建基础设施
 * - agent-session-runtime.ts → createAgentSessionFromServices() → sdk.ts → AgentSession
 * - CLI/TUI 模式 → createAgentSessionRuntime() → 本模块的服务创建
 */

import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRegistry } from "./model-registry.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

/**
 * 创建服务或会话时收集的非致命诊断信息。
 *
 * 运行时创建将诊断信息返回给调用方，而不是直接打印或退出。
 * 由应用层决定是否显示警告，以及错误是否应该中止启动。
 */
export interface AgentSessionRuntimeDiagnostic {
	/** 诊断级别：info=信息、warning=警告、error=错误 */
	type: "info" | "warning" | "error";
	/** 诊断消息 */
	message: string;
}

/**
 * 创建 cwd 绑定运行时服务的输入参数。
 *
 * 这些服务会在有效会话 cwd 发生变化时重新创建。
 * CLI 提供的资源路径应在此函数之前解析为绝对路径，避免 cwd 切换时被重新解释。
 *
 * 调用方：agent-session-runtime.ts 中的 createAgentSessionRuntime() 工厂函数。
 */
export interface CreateAgentSessionServicesOptions {
	/** 工作目录（项目根目录） */
	cwd: string;
	/** 全局配置目录，默认 ~/.pi/agent */
	agentDir?: string;
	/** 认证存储实例 */
	authStorage?: AuthStorage;
	/** 设置管理器实例 */
	settingsManager?: SettingsManager;
	/** 模型注册表实例 */
	modelRegistry?: ModelRegistry;
	/** 扩展标志值（来自 CLI 参数 --flag=value） */
	extensionFlagValues?: Map<string, boolean | string>;
	/** 资源加载器的额外选项（cwd、agentDir、settingsManager 由内部自动填充） */
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
}

/**
 * 从已创建的服务创建 AgentSession 的输入参数。
 *
 * 使用场景：服务已创建完成，cwd 绑定的模型/工具/会话选项已解析完毕后，
 * 调用此接口来最终创建 AgentSession。
 *
 * 调用方：agent-session-runtime.ts 中的 createRuntime 工厂函数。
 */
export interface CreateAgentSessionFromServicesOptions {
	/** 已创建的服务集合 */
	services: AgentSessionServices;
	/** 会话管理器（负责会话的持久化和状态管理） */
	sessionManager: SessionManager;
	/** 会话启动事件元数据（用于扩展系统） */
	sessionStartEvent?: SessionStartEvent;
	/** 要使用的模型，默认从设置或可用模型中选取 */
	model?: Model<any>;
	/** 思维级别，默认从设置中获取 */
	thinkingLevel?: ThinkingLevel;
	/** 可切换的模型列表（用于 Ctrl+P 切换） */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** 启用的工具名称白名单 */
	tools?: string[];
	/** 工具禁用模式 */
	noTools?: CreateAgentSessionOptions["noTools"];
	/** 自定义工具定义 */
	customTools?: ToolDefinition[];
}

/**
 * cwd 绑定的运行时服务集合。
 *
 * 这是基础设施层，不包含 AgentSession 本身。
 * AgentSession 单独创建，以便调用方可以先基于这些服务解析会话选项。
 *
 * 被 AgentSession 和 AgentSessionRuntime 持有和使用。
 */
export interface AgentSessionServices {
	/** 有效工作目录 */
	cwd: string;
	/** 全局配置目录路径 */
	agentDir: string;
	/** 认证存储（管理 API 密钥等凭据） */
	authStorage: AuthStorage;
	/** 设置管理器（读写用户设置） */
	settingsManager: SettingsManager;
	/** 模型注册表（API 密钥解析、模型发现） */
	modelRegistry: ModelRegistry;
	/** 资源加载器（加载技能、提示词、主题、上下文文件等） */
	resourceLoader: ResourceLoader;
	/** 创建过程中收集的诊断信息 */
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * 将扩展标志值应用到资源加载器的扩展运行时中。
 *
 * 内部步骤：
 * 1. 收集所有已注册扩展声明的标志（name → type）
 * 2. 遍历调用方传入的标志值，匹配已注册标志
 * 3. 未注册的标志收集为诊断错误
 * 4. 类型不匹配的标志也记录为诊断错误
 *
 * @param resourceLoader 资源加载器实例
 * @param extensionFlagValues CLI 传入的扩展标志值
 * @returns 收集到的诊断信息数组
 */
function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * 创建 cwd 绑定的运行时服务。
 *
 * 返回服务集合和诊断信息。不会创建 AgentSession。
 *
 * 内部步骤：
 * 1. 解析 cwd 和 agentDir 路径
 * 2. 创建或复用 AuthStorage、SettingsManager、ModelRegistry
 * 3. 创建 DefaultResourceLoader 并加载资源（技能、提示词、扩展等）
 * 4. 处理扩展注册的自定义 provider（模型提供方）
 * 5. 应用扩展标志值
 * 6. 返回服务集合和诊断信息
 *
 * @param options 创建选项
 * @returns 服务集合，包含 cwd、认证存储、设置、模型注册表、资源加载器和诊断信息
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload();

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	// 处理扩展注册的自定义模型提供方
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRegistry.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	// 应用扩展标志值（来自 CLI --flag 参数）
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		diagnostics,
	};
}

/**
 * 从已创建的服务创建 AgentSession。
 *
 * 将会话创建与服务创建分离，使调用方可以先基于服务解析模型、思维级别、工具等选项，
 * 再构造 AgentSession。
 *
 * 内部委托给 sdk.ts 中的 createAgentSession()，传入服务中已初始化的基础设施。
 *
 * @param options 包含服务集合、会话管理器和会话配置选项
 * @returns 包含 AgentSession 和扩展加载结果的 CreateAgentSessionResult
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
	});
}
