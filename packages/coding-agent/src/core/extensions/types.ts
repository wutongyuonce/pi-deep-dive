/**
 * 扩展系统类型定义。
 *
 * 作用/定位：定义扩展系统的所有类型接口，是扩展系统的类型基础。
 * 提供：事件类型、上下文接口、工具定义、API 接口、运行时状态等。
 *
 * 模块组织：
 * - UI 上下文      — ExtensionUIContext 及相关选项
 * - 扩展上下文     — ExtensionContext / ExtensionCommandContext
 * - 工具类型       — ToolDefinition、ToolRenderContext、类型守卫
 * - 事件类型       — Session/Agent/Tool/Input/Model 等事件及其结果
 * - API 接口       — ExtensionAPI（扩展工厂函数接收的对象）
 * - 运行时类型     — ExtensionRuntime、ExtensionActions、Extension
 * - Provider 注册  — ProviderConfig、ProviderModelConfig
 *
 * 扩展是 TypeScript 模块，可以：
 * - 订阅 agent 生命周期事件
 * - 注册 LLM 可调用的工具
 * - 注册命令、键盘快捷键和 CLI 标志
 * - 通过 UI 原语与用户交互
 */

import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
import type { EventBus } from "../event-bus.ts";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionManager,
} from "../session-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditToolDetails } from "../tools/edit.ts";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../tools/index.ts";

export type { ExecOptions, ExecResult } from "../exec.ts";
export type { BuildSystemPromptOptions } from "../system-prompt.ts";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";

// ============================================================================
// UI 上下文
// ============================================================================

/** 扩展 UI 对话框选项。 */
export interface ExtensionUIDialogOptions {
	/** 用于程序化关闭对话框的 AbortSignal。 */
	signal?: AbortSignal;
	/** 超时毫秒数。对话框自动关闭并显示倒计时。 */
	timeout?: number;
}

/** 扩展 widget 的放置位置。 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** 扩展 widget 选项。 */
export interface ExtensionWidgetOptions {
	/** widget 渲染位置，默认 "aboveEditor"。 */
	placement?: WidgetPlacement;
}

/** 扩展的原始终端输入监听器。 */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** 交互式流式加载指示器的配置选项。 */
export interface WorkingIndicatorOptions {
	/** 动画帧。使用空数组完全隐藏指示器。自定义帧按原样渲染。 */
	frames?: string[];
	/** 动画指示器的帧间隔毫秒数。 */
	intervalMs?: number;
}

/** 包装当前自动补全提供器以添加额外行为。 */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/**
 * 扩展请求交互式 UI 的上下文接口。
 * 每种模式（交互式、RPC、打印模式）提供自己的实现。
 */
export interface ExtensionUIContext {
	/** 显示选择器并返回用户选择。 */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 显示确认对话框。 */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** 显示文本输入对话框。 */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 向用户显示通知。 */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** 监听原始终端输入（仅交互模式可用）。返回取消订阅函数。 */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** 在底部栏/状态栏设置状态文本。传入 undefined 清除。 */
	setStatus(key: string, text: string | undefined): void;

	/** 设置流式传输期间显示的加载消息。无参数调用恢复默认。 */
	setWorkingMessage(message?: string): void;

	/** 显示或隐藏交互式流式传输期间的内置加载行。 */
	setWorkingVisible(visible: boolean): void;

	/**
	 * 配置流式传输期间显示的交互式加载指示器。
	 *
	 * - 省略参数恢复默认动画旋转器
	 * - 使用 `frames: ["●"]` 为静态指示器
	 * - 使用 `frames: []` 完全隐藏指示器
	 * - 自定义帧按原样渲染，扩展需自行添加颜色
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** 设置隐藏思考块的标签。无参数调用恢复默认。 */
	setHiddenThinkingLabel(label?: string): void;

	/** 设置显示在编辑器上方或下方的 widget。接受字符串数组或组件工厂。 */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/** 设置自定义底部组件，或 undefined 恢复内置底部栏。
	 *
	 * 工厂函数接收 FooterDataProvider，用于获取其他方式无法访问的数据：
	 * git 分支信息和通过 setStatus() 设置的扩展状态。Token 统计、模型信息等
	 * 可通过 ctx.sessionManager 和 ctx.model 获取。
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** 设置自定义头部组件（启动时显示在聊天上方），或 undefined 恢复内置头部。 */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** 设置终端窗口/标签页标题。 */
	setTitle(title: string): void;

	/** 显示一个自定义组件并获取键盘焦点。 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			/** 覆盖层定位/大小选项。可以是静态值或动态更新函数。 */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** 覆盖层显示后回调，接收 overlay handle 用于控制可见性。 */
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;

	/** 粘贴文本到编辑器，触发粘贴处理（大内容会折叠）。 */
	pasteToEditor(text: string): void;

	/** 设置核心输入编辑器的文本。 */
	setEditorText(text: string): void;

	/** 获取核心输入编辑器的当前文本。 */
	getEditorText(): string;

	/** 显示多行编辑器用于文本编辑。 */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** 在内置提供器之上堆叠额外的自动补全行为。 */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * 通过工厂函数设置自定义编辑器组件。
	 * 传入 undefined 恢复默认编辑器。
	 *
	 * 工厂函数接收：
	 * - `theme`：用于边框和自动补全样式的 EditorTheme
	 * - `keybindings`：应用级别的键盘绑定管理器
	 *
	 * 如需完整的应用键盘绑定支持（escape、ctrl+d、模型切换等），
	 * 请继承 `@earendil-works/pi-coding-agent` 中的 `CustomEditor` 并对未处理的按键
	 * 调用 `super.handleInput(data)`。
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@earendil-works/pi-coding-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // 处理 vim 普通模式按键...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // 应用键盘绑定 + 文本编辑
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** 获取当前配置的自定义编辑器工厂，使用默认编辑器时返回 undefined。 */
	getEditorComponent(): EditorFactory | undefined;

	/** 获取当前主题样式。 */
	readonly theme: Theme;

	/** 获取所有可用主题的名称和文件路径。 */
	getAllThemes(): { name: string; path: string | undefined }[];

	/** 按名称加载主题但不切换。未找到时返回 undefined。 */
	getTheme(name: string): Theme | undefined;

	/** 通过名称或 Theme 对象设置当前主题。 */
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** 获取当前工具输出展开状态。 */
	getToolsExpanded(): boolean;

	/** 设置工具输出展开状态。 */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// 扩展上下文
// ============================================================================

export interface ContextUsage {
	/** 上下文使用情况估计，或未知时返回 null（如压缩后、下次 LLM 响应前）。 */
	tokens: number | null;
	contextWindow: number;
	/** 占上下文窗口的百分比，或 tokens 为 null 时也返回 null。 */
	percent: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * 传递给扩展事件处理器的上下文。
 */
export interface ExtensionContext {
	/** UI 交互方法 */
	ui: ExtensionUIContext;
	/** UI 是否可用（print/RPC 模式下为 false） */
	hasUI: boolean;
	/** 当前工作目录 */
	cwd: string;
	/** 会话管理器（只读） */
	sessionManager: ReadonlySessionManager;
	/** 模型注册中心，用于 API key 解析 */
	modelRegistry: ModelRegistry;
	/** 当前模型（可能为 undefined） */
	model: Model<any> | undefined;
	/** agent 是否空闲（未在流式传输中） */
	isIdle(): boolean;
	/** 当前的中止信号，agent 未流式传输时为 undefined。 */
	signal: AbortSignal | undefined;
	/** 中止当前 agent 操作 */
	abort(): void;
	/** 是否有排队等待的消息 */
	hasPendingMessages(): boolean;
	/** 优雅关闭 pi 并退出。所有上下文中可用。 */
	shutdown(): void;
	/** 获取当前活动模型的上下文使用情况。 */
	getContextUsage(): ContextUsage | undefined;
	/** 触发压缩但不等待完成。 */
	compact(options?: CompactOptions): void;
	/** 获取当前有效的系统提示词。 */
	getSystemPrompt(): string;
}

/**
 * 命令处理器的扩展上下文。
 * 包含仅在用户发起的命令中安全使用的会话控制方法。
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** 等待 agent 完成流式传输 */
	waitForIdle(): Promise<void>;

	/** 开始新会话，可选初始化设置。 */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** 从特定条目分叉，创建新的会话文件。 */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** 导航到会话树中的不同位置。 */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** 切换到不同的会话文件。 */
	switchSession(
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** 重新加载扩展、技能、提示词和主题。 */
	reload(): Promise<void>;
}

/**
 * 会话切换后绑定到新会话的全新命令上下文。
 * 传递给 newSession()、fork()、switchSession() 的 withSession 回调。
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void>;
}

// ============================================================================
// 工具类型
// ============================================================================

/** 工具结果的渲染选项 */
export interface ToolRenderResultOptions {
	/** 结果视图是否展开 */
	expanded: boolean;
	/** 是否为部分/流式结果 */
	isPartial: boolean;
}

/** 传递给工具渲染器的上下文。 */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** 当前工具调用参数。同一工具调用的 call/result 渲染共享此参数。 */
	args: TArgs;
	/** 此工具执行的唯一 ID。同一工具调用的 call/result 渲染保持稳定。 */
	toolCallId: string;
	/** 使此工具执行组件失效以重新绘制。 */
	invalidate: () => void;
	/** 此渲染槽位之前返回的组件（如果有的话）。 */
	lastComponent: Component | undefined;
	/** 此工具行的共享渲染器状态。由 tool-execution.ts 初始化。 */
	state: TState;
	/** 此工具执行的工作目录。 */
	cwd: string;
	/** 工具执行是否已开始。 */
	executionStarted: boolean;
	/** 工具调用参数是否完整。 */
	argsComplete: boolean;
	/** 工具结果是否为部分/流式。 */
	isPartial: boolean;
	/** 结果视图是否展开。 */
	expanded: boolean;
	/** TUI 中是否当前显示内联图片。 */
	showImages: boolean;
	/** 当前结果是否为错误。 */
	isError: boolean;
}

/**
 * 通过 registerTool() 注册的工具定义。
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** 工具名称（用于 LLM 工具调用） */
	name: string;
	/** UI 显示用的可读标签 */
	label: string;
	/** LLM 描述 */
	description: string;
	/** 可选的单行摘要，用于默认系统提示词中的"可用工具"部分。未提供时自定义工具将从该部分省略。 */
	promptSnippet?: string;
	/** 可选的指导要点，在此工具激活时追加到默认系统提示词的"指南"部分。 */
	promptGuidelines?: string[];
	/** 参数模式（TypeBox） */
	parameters: TParams;
	/** 控制 ToolExecutionComponent 渲染标准彩色 shell 还是工具自行渲染边框。 */
	renderShell?: "default" | "self";

	/** 可选的兼容性垫片，在 schema 校验前预处理原始工具调用参数。必须返回符合 TParams 的对象。 */
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * 每个工具的执行模式覆盖。
	 * - "sequential"：此工具必须与其他工具调用逐一执行。
	 * - "parallel"：此工具可以与其他工具调用并发执行。
	 *
	 * 如果省略，则使用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;

	/** 执行工具。 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** 工具调用的自定义渲染 */
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** 工具结果的自定义渲染 */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * 保留独立工具定义中的参数类型推断。
 *
 * 当将工具赋值给变量或通过数组（如 `customTools`）传递时使用，
 * 防止上下文类型推断将 params 收窄为 `unknown`。
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

// ============================================================================
// 资源事件
// ============================================================================

/** 在 session_start 之后触发，允许扩展提供额外的资源路径。 */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** resources_discover 事件处理器的结果 */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// 会话事件
// ============================================================================

/** 会话启动、加载或重新加载时触发 */
export interface SessionStartEvent {
	type: "session_start";
	/** 触发此次会话启动的原因。 */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** 之前的活动会话文件。在 "new"、"resume" 和 "fork" 时存在。 */
	previousSessionFile?: string;
}

/** 切换到另一会话之前触发（可取消） */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

/** 分叉会话之前触发（可取消） */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** 上下文压缩之前触发（可取消或自定义） */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}

/** 上下文压缩完成后触发 */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
}

/** 扩展运行时因退出、重载或会话替换而被拆除之前触发。 */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** 因会话替换而关闭时的目标会话文件。 */
	targetSessionFile?: string;
}

/** 树导航的准备数据 */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	/** 摘要的自定义指令 */
	customInstructions?: string;
	/** 如果为 true，customInstructions 替代默认提示词而非追加 */
	replaceInstructions?: boolean;
	/** 附加到分支摘要条目的标签 */
	label?: string;
}

/** 在会话树中导航之前触发（可取消） */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** 在会话树中导航完成后触发 */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

// ============================================================================
// Agent 事件
// ============================================================================

/** 每次 LLM 调用前触发。可修改消息。 */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** Provider 请求发送前触发。可替换请求体。 */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/** Provider 响应接收后、响应流被消费前触发。 */
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

/** 用户提交提示词后、agent 循环开始前触发。 */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** 扩展后的原始用户提示文本。 */
	prompt: string;
	/** 用户提示词附带的图片（如果有的话）。 */
	images?: ImageContent[];
	/** 完整组装的系统提示词字符串。 */
	systemPrompt: string;
	/** 用于构建系统提示词的结构化选项。扩展可检查此内容以了解 Pi 加载了哪些资源，无需重新发现。 */
	systemPromptOptions: BuildSystemPromptOptions;
}

/** agent 循环开始时触发 */
export interface AgentStartEvent {
	type: "agent_start";
}

/** agent 循环结束时触发 */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

/** 每轮开始时触发 */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** 每轮结束时触发 */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

/** 消息开始时触发（用户、助手或工具结果） */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** 助手消息流式传输期间，逐 token 更新触发 */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** 消息结束时触发 */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** 工具开始执行时触发 */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
}

/** 工具执行期间触发，携带部分/流式输出 */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
}

/** 工具执行完成时触发 */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
}

// ============================================================================
// 模型事件
// ============================================================================

export type ModelSelectSource = "set" | "cycle" | "restore";

/** 选择新模型时触发 */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

/** 选择新思考级别时触发 */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

// ============================================================================
// 用户 Bash 事件
// ============================================================================

/** 用户通过 ! 或 !! 前缀执行 bash 命令时触发 */
export interface UserBashEvent {
	type: "user_bash";
	/** 要执行的命令 */
	command: string;
	/** 如果使用 !! 前缀则为 true（从 LLM 上下文中排除） */
	excludeFromContext: boolean;
	/** 当前工作目录 */
	cwd: string;
}

// ============================================================================
// 输入事件
// ============================================================================

/** 用户输入来源 */
export type InputSource = "interactive" | "rpc" | "extension";

/** 用户输入接收后、agent 处理前触发 */
export interface InputEvent {
	type: "input";
	/** 输入文本 */
	text: string;
	/** 附带的图片（如果有的话） */
	images?: ImageContent[];
	/** 输入来源 */
	source: InputSource;
}

/** input 事件处理器的结果 */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ============================================================================
// 工具事件
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * 工具执行前触发。可阻止执行。
 *
 * `event.input` 是可变的。可就地修改它以在执行前修补工具参数。
 * 后续 `tool_call` 处理器能看到之前的修改。修改后不会重新校验。
 */
export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details: LsToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** 工具执行后触发。可修改结果。 */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

// ToolResultEvent 的类型守卫
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}

/**
 * 按工具名称缩窄 ToolCallEvent 类型的类型守卫。
 *
 * 内置工具自动缩窄（无需类型参数）：
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * 自定义工具需要显式类型参数：
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // 已类型化
 * }
 * ```
 *
 * 注意：直接使用 `event.toolName === "bash"` 无法缩窄类型，因为
 * CustomToolCallEvent.toolName 是 `string` 类型，与所有字面量重叠。
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** 所有事件类型的联合类型 */
export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// 事件结果
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	/** 阻止工具执行。要修改参数请就地修改 `event.input`。 */
	block?: boolean;
	reason?: string;
}

/** user_bash 事件处理器的结果 */
export interface UserBashEventResult {
	/** 自定义操作用于执行 */
	operations?: BashOperations;
	/** 完全替换：扩展已处理执行，使用此结果 */
	result?: BashResult;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

export interface MessageEndEventResult {
	/** 替换最终消息。替换时必须保持原始消息角色。 */
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** 替换本轮的系统提示词。多个扩展返回时链式叠加。 */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
	};
	/** 覆盖摘要的自定义指令 */
	customInstructions?: string;
	/** 如果为 true，customInstructions 替代默认提示词而非追加 */
	replaceInstructions?: boolean;
	/** 覆盖附加到分支摘要条目的标签 */
	label?: string;
}

// ============================================================================
// 消息渲染
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// 命令注册
// ============================================================================

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
}

// ============================================================================
// 扩展 API
// ============================================================================

/** 事件的处理器函数类型 */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * 传递给扩展工厂函数的 ExtensionAPI。
 */
export interface ExtensionAPI {
	// =========================================================================
	// 事件订阅
	// =========================================================================

	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

	// =========================================================================
	// 工具注册
	// =========================================================================

	/** 注册 LLM 可调用的工具。 */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	// =========================================================================
	// 命令、快捷键、标志注册
	// =========================================================================

	/** 注册自定义命令。 */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	/** 注册键盘快捷键。 */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** 注册 CLI 标志。 */
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;

	/** 获取已注册 CLI 标志的值。 */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// 消息渲染
	// =========================================================================

	/** 为 CustomMessageEntry 注册自定义渲染器。 */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	// =========================================================================
	// 操作
	// =========================================================================

	/** 向会话发送自定义消息。 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/**
	 * 向 agent 发送用户消息。始终触发一轮对话。
	 * agent 正在流式传输时，使用 deliverAs 指定消息排队方式。
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;

	/** 向会话追加自定义条目用于状态持久化（不发送给 LLM）。 */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	// =========================================================================
	// 会话元数据
	// =========================================================================

	/** 设置会话显示名称（在会话选择器中显示）。 */
	setSessionName(name: string): void;

	/** 获取当前会话名称（如果已设置）。 */
	getSessionName(): string | undefined;

	/** 设置或清除条目上的标签。标签是用户定义的书签/导航标记。 */
	setLabel(entryId: string, label: string | undefined): void;

	/** 执行 shell 命令。 */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** 获取当前活动的工具名称列表。 */
	getActiveTools(): string[];

	/** 获取所有已配置的工具，包含参数模式和来源元数据。 */
	getAllTools(): ToolInfo[];

	/** 按名称设置活动工具。 */
	setActiveTools(toolNames: string[]): void;

	/** 获取当前会话中可用的斜杠命令。 */
	getCommands(): SlashCommandInfo[];

	// =========================================================================
	// 模型和思考级别
	// =========================================================================

	/** 设置当前模型。如果无可用 API key 则返回 false。 */
	setModel(model: Model<any>): Promise<boolean>;

	/** 获取当前思考级别。 */
	getThinkingLevel(): ThinkingLevel;

	/** 设置思考级别（限制在模型能力范围内）。 */
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// Provider 注册
	// =========================================================================

	/**
	 * 注册或覆盖模型 provider。
	 *
	 * 如果提供了 `models`：替换该 provider 的所有现有模型。
	 * 如果仅提供 `baseUrl`：覆盖现有模型的 URL。
	 * 如果提供了 `streamSimple`：注册自定义 API 流处理器。
	 *
	 * 在初始扩展加载期间，此调用会被排队，待 runner 绑定上下文后应用。
	 * 之后调用则立即生效，因此可安全地从命令处理器或事件回调中调用，
	 * 无需 `/reload`。
	 *
	 * @example
	 * // 注册带自定义模型的新 provider
	 * pi.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // 覆盖现有 provider 的 baseUrl
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 */
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * 注销先前注册的 provider。
	 *
	 * 移除该 provider 下的所有模型，并恢复被其覆盖的内置模型。
	 * 如果该 provider 当前未注册，则无任何效果。
	 *
	 * 与 `registerProvider` 相同，在初始加载阶段之后调用时立即生效。
	 *
	 * @example
	 * pi.unregisterProvider("my-proxy");
	 */
	unregisterProvider(name: string): void;

	/** 共享事件总线，用于扩展间通信。 */
	events: EventBus;
}

// ============================================================================
// Provider 注册类型
// ============================================================================

/** 通过 pi.registerProvider() 注册 provider 的配置。 */
export interface ProviderConfig {
	/** UI 中 provider 的显示名称。 */
	name?: string;
	/** API 端点的基础 URL。定义模型时必需。 */
	baseUrl?: string;
	/** API key 或环境变量名称。定义模型时必需。 */
	apiKey?: string;
	/** API 类型。在 provider 或模型级别定义模型时必需。 */
	api?: Api;
	/** 可选的 streamSimple 处理器，用于自定义 API。 */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** 请求中包含的自定义头部。 */
	headers?: Record<string, string>;
	/** 如果为 true，添加 Authorization: Bearer 头部，使用解析后的 API key。 */
	authHeader?: boolean;
	/** 要注册的模型。如果提供，替换此 provider 的所有现有模型。 */
	models?: ProviderModelConfig[];
}

/** Provider 内模型的配置。 */
export interface ProviderModelConfig {
	/** 模型 ID（如 "claude-sonnet-4-20250514"）。 */
	id: string;
	/** 显示名称（如 "Claude 4 Sonnet"）。 */
	name: string;
	/** 此模型的 API 类型覆盖。 */
	api?: Api;
	/** 此模型的 API 端点 URL 覆盖。 */
	baseUrl?: string;
	/** 模型是否支持扩展思考。 */
	reasoning: boolean;
	/** 将 pi 思考级别映射到 provider/模型特定值；null 表示该级别不支持。 */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** 支持的输入类型。 */
	input: ("text" | "image")[];
	/** 每 token 成本（用于跟踪，可为 0）。 */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** 最大上下文窗口大小（token 数）。 */
	contextWindow: number;
	/** 最大输出 token 数。 */
	maxTokens: number;
	/** 此模型的自定义头部。 */
	headers?: Record<string, string>;
	/** OpenAI 兼容性设置。 */
	compat?: Model<Api>["compat"];
}

/** 扩展工厂函数类型。支持同步和异步初始化。 */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// ============================================================================
// 已加载扩展类型
// ============================================================================

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp" },
) => void;

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export type SetSessionNameHandler = (name: string) => void;

export type GetSessionNameHandler = () => string | undefined;

export type GetActiveToolsHandler = () => string[];

/** 包含名称、描述、参数模式和来源元数据的工具信息 */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters"> & {
	sourceInfo: SourceInfo;
};

export type GetAllToolsHandler = () => ToolInfo[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => void;

export type RefreshToolsHandler = () => void;

export type SetModelHandler = (model: Model<any>) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel;

export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

export type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * 由 loader 创建的共享状态，在注册和运行时使用。
 * 包含 flag 值（注册时设置默认值，CLI 设置后覆盖）。
 */
export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	/** 扩展加载期间排队的 provider 注册请求，待 runner 绑定时处理 */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
	/** 当此扩展实例在运行时替换后过期时抛出异常。 */
	assertActive: () => void;
	/** 将此扩展实例标记为运行时替换或重载后过期。 */
	invalidate: (message?: string) => void;
	/**
	 * 注册或注销 provider。
	 *
	 * bindCore() 之前：排队注册 / 从队列中移除。
	 * bindCore() 之后：直接调用 ModelRegistry 立即生效。
	 */
	registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
	unregisterProvider: (name: string, extensionPath?: string) => void;
}

/**
 * pi.* API 方法的操作实现。
 * 传递给 runner.initialize()，复制到共享运行时中。
 */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	refreshTools: RefreshToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * ExtensionContext 的操作方法（事件处理器中的 ctx.*）。
 * 所有模式都需要。
 */
export interface ExtensionContextActions {
	getModel: () => Model<any> | undefined;
	isIdle: () => boolean;
	getSignal: () => AbortSignal | undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
}

/**
 * ExtensionCommandContext 的操作方法（命令处理器中的 ctx.*）。
 * 仅交互模式需要（扩展命令可在此模式中调用）。
 */
export interface ExtensionCommandContextActions {
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	fork: (
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	) => Promise<{ cancelled: boolean }>;
	switchSession: (
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/**
 * 完整运行时 = 状态 + 操作方法。
 * 由 loader 创建（带抛出异常的操作桩方法），由 runner.initialize() 完成。
 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** 已加载扩展及其所有注册项。 */
export interface Extension {
	path: string;
	resolvedPath: string;
	sourceInfo: SourceInfo;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool>;
	messageRenderers: Map<string, MessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** 加载扩展的结果。 */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	/** 共享运行时 - 操作方法在 runner.initialize() 之前是抛出异常的桩方法 */
	runtime: ExtensionRuntime;
}

// ============================================================================
// 扩展错误
// ============================================================================

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
