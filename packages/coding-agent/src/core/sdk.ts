/**
 * sdk.ts - Agent 会话创建的 SDK 入口
 *
 * 作用：提供创建 AgentSession 的最底层工厂函数，是 core 层对外暴露的 SDK 接口。
 *       负责组装所有基础设施（认证、设置、模型、工具、扩展）并创建 Agent 实例。
 *
 * 定位：core 层的会话创建入口，被 agent-session-services.ts 的 createAgentSessionFromServices()
 *       和 agent-session-runtime.ts 的运行时工厂函数调用。
 *
 * 提供的能力：
 * - CreateAgentSessionOptions：创建会话的完整选项接口
 * - CreateAgentSessionResult：创建结果（包含 session、扩展加载结果、模型回退消息）
 * - createAgentSession()：核心工厂函数，创建并返回 AgentSession
 * - 工具工厂导出：createCodingTools、createReadOnlyTools 等
 *
 * 调用关系：
 * - agent-session-services.ts → createAgentSessionFromServices() → createAgentSession()
 * - agent-session-runtime.ts → CreateAgentSessionRuntimeFactory → createAgentSession()
 * - 外部 SDK 消费者直接调用 createAgentSession()
 */

import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel } from "./model-resolver.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

export interface CreateAgentSessionOptions {
	/** 工作目录，用于项目级发现。默认: process.cwd() */
	cwd?: string;
	/** 全局配置目录。默认: ~/.pi/agent */
	agentDir?: string;

	/** 凭据的认证存储。默认: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** 模型注册表。默认: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** 要使用的模型。默认: 从设置获取，否则使用第一个可用模型 */
	model?: Model<any>;
	/** 思维级别。默认: 从设置获取，否则为 'medium'（钳位到模型能力范围） */
	thinkingLevel?: ThinkingLevel;
	/** 可切换的模型列表（交互模式中 Ctrl+P 切换） */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * 可选的默认工具禁用模式（当未提供显式白名单时）。
	 *
	 * - "all": 启动时无工具启用
	 * - "builtin": 禁用默认内置工具（read、bash、edit、write），
	 *   但保留扩展/自定义工具启用
	 */
	noTools?: "all" | "builtin";
	/**
	 * 可选的工具名称白名单。
	 *
	 * 省略时，pi 启用默认内置工具（read、bash、edit、write），
	 * 除非 noTools 改变了该默认行为，否则保留扩展/自定义工具启用。
	 * 提供时，仅启用列出的工具名称。
	 */
	tools?: string[];
	/** 要注册的自定义工具（在内置工具之外）。 */
	customTools?: ToolDefinition[];

	/** 资源加载器。省略时使用 DefaultResourceLoader。 */
	resourceLoader?: ResourceLoader;

	/** 会话管理器。默认: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** 设置管理器。默认: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** 扩展运行时启动时的 session_start 事件元数据。 */
	sessionStartEvent?: SessionStartEvent;
}

/** createAgentSession 的返回结果 */
export interface CreateAgentSessionResult {
	/** 创建的会话 */
	session: AgentSession;
	/** 扩展加载结果（用于交互模式的 UI 上下文设置） */
	extensionsResult: LoadExtensionsResult;
	/** 如果会话恢复时使用的模型与保存时不同，此为警告信息 */
	modelFallbackMessage?: string;
}

// 重新导出

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// 工具工厂（用于自定义 cwd）
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// 辅助函数

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function getAttributionHeaders(
	model: Model<any>,
	settingsManager: SettingsManager,
	sessionId?: string,
): Record<string, string> | undefined {
	void sessionId;

	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) {
		return {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	return undefined;
}

/**
 * 使用指定选项创建 AgentSession。
 *
 * @example
 * ```typescript
 * // 最简用法 - 使用默认值
 * const { session } = await createAgentSession();
 *
 * // 指定模型
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // 继续之前的会话
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // 完全控制
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// 使用提供的或创建 AuthStorage 和 ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// 检查会话是否有现有数据需要恢复
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// 如果会话有数据，尝试从中恢复模型
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// 如果仍然没有模型，使用 findInitialModel（检查设置默认值，然后是提供方默认值）
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// 如果会话有数据，从中恢复思维级别
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// 回退到设置默认值
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// 钳位到模型能力范围
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const initialActiveToolNames: string[] = options.tools
		? [...options.tools]
		: options.noTools
			? []
			: defaultActiveToolNames;

	let agent: Agent;

	// 创建 convertToLlm 包装器，当 blockImages 启用时过滤图片（纵深防御）
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// 动态检查设置，以便会话中更改即时生效
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// 从所有消息中过滤掉 ImageContent，替换为文本占位符
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// 去重连续的 "Image reading is disabled." 文本
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const attributionHeaders = getAttributionHeaders(model, settingsManager, options?.sessionId);
			return streamSimple(model, context, {
				...options,
				apiKey: auth.apiKey,
				timeoutMs: options?.timeoutMs ?? providerRetrySettings.timeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers:
					attributionHeaders || auth.headers || options?.headers
						? { ...attributionHeaders, ...auth.headers, ...options?.headers }
						: undefined,
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// 如果会话有现有数据则恢复消息
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// 为新会话保存初始模型和思维级别，以便恢复时使用
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		allowedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
