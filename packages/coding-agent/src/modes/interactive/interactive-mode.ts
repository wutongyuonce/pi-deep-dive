/**
 * 交互模式核心模块 - pi coding agent 的终端用户界面实现
 *
 * 【文件定位】
 * 这是 pi coding agent 三种运行模式之一（interactive / headless / pipeline）的完整实现。
 * 交互模式提供完整的终端 TUI（Text User Interface）体验，包括：
 * - 用户输入编辑器（支持斜杠命令、自动补全、文件路径提示）
 * - 消息流式渲染（助手回复、工具调用、技能调用等）
 * - 会话管理（历史会话切换、模型选择、主题切换）
 * - 扩展系统集成（自定义命令、widget、编辑器、对话框）
 *
 * 【调用链位置】
 * 入口层: CLI 解析 -> createSession() -> AgentSessionRuntime -> InteractiveMode
 * 上游调用: AgentSessionRuntime.start() 创建并启动本模块
 * 下游依赖: AgentSession (业务逻辑) -> Agent (AI 模型交互) -> LLM API
 * 并行组件: HeadlessMode (非交互模式), PipelineMode (管道模式)
 *
 * 【核心职责分离】
 * - 本模块 (InteractiveMode): 负责 TUI 渲染、用户输入处理、UI 状态管理
 * - AgentSession: 负责业务逻辑、消息处理、工具执行、会话持久化
 * - AgentSessionRuntime: 负责会话生命周期、错误恢复、模式切换
 *
 * 【与外部文件的关系】
 * - components/ 目录: 各类 UI 组件（消息、编辑器、选择器等）
 * - theme/ 目录: 主题和样式系统
 * - core/ 目录: 核心业务逻辑（session, agent, tools 等）
 * - utils/ 目录: 工具函数（clipboard, git, paths 等）
 */

// ==================== Node.js 内置模块 ====================
import * as crypto from "node:crypto"; // 用于生成唯一 ID（如消息 ID、工具调用 ID）
import * as fs from "node:fs"; // 文件系统操作（读取配置、检查文件存在等）
import * as os from "node:os"; // 操作系统信息（临时目录、用户主目录等）
import * as path from "node:path"; // 路径处理（拼接、解析、规范化）

// ==================== 核心类型和 API ====================
import type { AgentMessage } from "@earendil-works/pi-agent-core"; // Agent 消息的基础类型定义
import {
	type AssistantMessage, // 助手消息类型（包含文本、工具调用等内容）
	getProviders, // 获取所有可用的 AI 提供商列表（如 openai, anthropic, google 等）
	type ImageContent, // 图片内容类型（用于多模态输入）
	type Message, // 消息的基础类型（User | Assistant | System）
	type Model, // 模型定义类型（包含 provider, id, api 等元数据）
} from "@earendil-works/pi-ai";

// ==================== TUI 框架类型定义 ====================
import type {
	AutocompleteItem, // 自动补全项（包含 value, label, description）
	AutocompleteProvider, // 自动补全提供者接口（负责生成补全建议）
	EditorComponent, // 编辑器组件接口（支持文本输入、快捷键、自动补全）
	Keybinding, // 快捷键绑定类型
	KeyId, // 按键标识符类型（如 "ctrl+c", "enter"）
	MarkdownTheme, // Markdown 渲染主题配置
	OverlayHandle, // 覆盖层句柄（用于管理弹出层的生命周期）
	OverlayOptions, // 覆盖层配置选项
	SlashCommand, // 斜杠命令定义（用于命令面板和自动补全）
} from "@earendil-works/pi-tui";

// ==================== TUI 框架运行时组件 ====================
import {
	CombinedAutocompleteProvider, // 组合多个自动补全提供者（合并内置命令、模板、扩展命令）
	type Component, // TUI 组件基础接口
	Container, // 容器组件（用于组织和布局子组件）
	fuzzyFilter, // 模糊过滤函数（用于搜索和补全）
	getCapabilities, // 获取终端能力（颜色数、Unicode 支持等）
	hyperlink, // 创建终端超链接（OSC 8 序列）
	Loader, // 加载动画组件（显示旋转指示器）
	type LoaderIndicatorOptions, // 加载指示器配置（自定义动画、颜色等）
	Markdown, // Markdown 渲染组件（支持代码高亮、表格、列表等）
	matchesKey, // 按键匹配函数（检查按键事件是否匹配快捷键）
	ProcessTerminal, // 进程终端适配器（连接 stdin/stdout 到 TUI 框架）
	Spacer, // 空间组件（用于垂直/水平间距）
	setKeybindings, // 设置全局快捷键绑定
	Text, // 文本组件（基础文本渲染，支持样式和颜色）
	TruncatedText, // 截断文本组件（超长文本自动截断并显示省略号）
	TUI, // TUI 框架主类（管理整个终端界面的渲染循环）
	visibleWidth, // 计算字符串的可见宽度（处理 ANSI 转义序列和 Unicode 宽字符）
} from "@earendil-works/pi-tui";
// ==================== 进程管理 ====================
import { spawn, spawnSync } from "child_process"; // 进程创建（用于执行 shell 命令、外部工具）

// ==================== 项目配置和常量 ====================
import {
	APP_NAME, // 应用名称（如 "pi"）
	APP_TITLE, // 应用标题（用于显示，可能包含品牌标识）
	getAgentDir, // 获取 agent 配置目录路径（~/.pi 或项目级 .pi）
	getAuthPath, // 获取认证文件路径（存储 API key 等凭证）
	getDebugLogPath, // 获取调试日志文件路径
	getShareViewerUrl, // 获取会话分享查看器的 URL
	VERSION, // 当前版本号
} from "../../config.ts";

// ==================== 核心会话和 Agent 模块 ====================
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts"; // AgentSession: 会话核心类，管理消息历史、工具执行、模型交互；AgentSessionEvent: 会话事件类型（消息、错误、状态变更等）；parseSkillBlock: 解析技能文件中的指令块
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts"; // AgentSessionRuntime: 会话运行时管理器，负责生命周期和模式切换

// ==================== 扩展系统类型 ====================
import type {
	AutocompleteProviderFactory, // 自动补全提供者工厂（允许扩展注册自定义补全逻辑）
	EditorFactory, // 编辑器工厂（允许扩展替换默认编辑器组件）
	ExtensionCommandContext, // 扩展命令执行上下文（包含会话信息、工具访问等）
	ExtensionContext, // 扩展上下文（扩展加载和初始化时的环境信息）
	ExtensionRunner, // 扩展运行器（管理和执行已注册的扩展）
	ExtensionUIContext, // 扩展 UI 上下文（提供 UI 操作接口给扩展使用）
	ExtensionUIDialogOptions, // 扩展对话框配置选项
	ExtensionWidgetOptions, // 扩展 widget 配置选项（位置、大小、样式等）
} from "../../core/extensions/index.ts";

// ==================== 会话和配置管理 ====================
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts"; // 底部状态栏数据提供者（当前目录、git 分支、模型信息等）
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts"; // HTTP 调度器配置（管理 API 请求的并发和超时）
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts"; // 快捷键管理器（注册、查询、自定义快捷键绑定）
import { createCompactionSummaryMessage } from "../../core/messages.ts"; // 创建压缩摘要消息（当历史消息过多时，压缩并生成摘要）
import { defaultModelPerProvider, findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.ts"; // 模型解析器：defaultModelPerProvider 提供商默认模型映射；findExactModelReferenceMatch 精确匹配模型引用；resolveModelScope 解析模型作用域配置
import { DefaultPackageManager } from "../../core/package-manager.ts"; // 包管理器（处理扩展和技能的安装、更新）
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts"; // 内置提供商显示名称映射（如 "openai" -> "OpenAI"）
import type { ResourceDiagnostic } from "../../core/resource-loader.ts"; // 资源加载诊断信息（警告、错误等）
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts"; // 会话工作目录缺失处理：formatMissingSessionCwdPrompt 生成提示信息；MissingSessionCwdError 错误类型
import { type SessionContext, SessionManager } from "../../core/session-manager.ts"; // SessionContext: 会话上下文（包含 cwd、环境变量等）；SessionManager: 会话管理器（创建、加载、保存会话）
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts"; // 内置斜杠命令列表（/model, /clear, /help 等）
import type { SourceInfo } from "../../core/source-info.ts"; // 资源来源信息（文件路径、npm 包、git 仓库等）
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts"; // 检查是否启用安装遥测
import type { TruncationResult } from "../../core/tools/truncate.ts"; // 工具输出截断结果（截断后的文本和截断信息）
// ==================== 工具函数模块 ====================
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.ts"; // 变更日志处理：getChangelogPath 获取 changelog 文件路径；getNewEntries 获取新版本的变更条目；parseChangelog 解析 changelog 文件
import { copyToClipboard } from "../../utils/clipboard.ts"; // 复制文本到系统剪贴板
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts"; // 剪贴板图片处理：extensionForImageMimeType 根据 MIME 类型获取文件扩展名；readClipboardImage 从剪贴板读取图片
import { parseGitUrl } from "../../utils/git.ts"; // 解析 Git URL（提取 host, path, ref 等信息）
import { getCwdRelativePath } from "../../utils/paths.ts"; // 获取相对于当前工作目录的路径
import { getPiUserAgent } from "../../utils/pi-user-agent.ts"; // 获取 User-Agent 字符串（用于 HTTP 请求头）
import { killTrackedDetachedChildren } from "../../utils/shell.ts"; // 终止所有跟踪的后台子进程（退出时清理）
import { ensureTool } from "../../utils/tools-manager.ts"; // 确保外部工具可用（如 fd, rg），不存在时自动下载
import { checkForNewPiVersion, type LatestPiRelease } from "../../utils/version-check.ts"; // 版本检查：checkForNewPiVersion 检查是否有新版本可用；LatestPiRelease 最新版本信息类型
// ==================== UI 组件 - 消息和显示 ====================
import { ArminComponent } from "./components/armin.ts"; // Armin 彩蛋组件（特殊显示效果）
import { AssistantMessageComponent } from "./components/assistant-message.ts"; // 助手消息组件（渲染 AI 回复，支持 Markdown、代码块、工具调用等）
import { AuthSelectorComponent, type AuthSelectorProvider } from "./components/auth-selector.ts"; // 认证选择器组件（选择 API 提供商和认证方式）
import { BashExecutionComponent } from "./components/bash-execution.ts"; // Bash 命令执行组件（显示命令输出、状态、支持交互）
import { BorderedLoader } from "./components/bordered-loader.ts"; // 带边框的加载组件（用于状态提示区域）
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts"; // 分支摘要消息组件（显示 git 分支变更摘要）
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts"; // 压缩摘要消息组件（显示消息历史压缩后的摘要）
import { CountdownTimer } from "./components/countdown-timer.ts"; // 倒计时组件（用于自动重试等待显示）

// ==================== UI 组件 - 编辑器和输入 ====================
import { CustomEditor } from "./components/custom-editor.ts"; // 自定义编辑器组件（增强的文本输入框，支持多行、快捷键、自动补全）
import { CustomMessageComponent } from "./components/custom-message.ts"; // 自定义消息组件（用于扩展和特殊消息类型）
import { DynamicBorder } from "./components/dynamic-border.ts"; // 动态边框组件（根据内容自动调整的分隔线）
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts"; // Earendil 公告组件（显示官方公告和通知）

// ==================== UI 组件 - 扩展系统 ====================
import { ExtensionEditorComponent } from "./components/extension-editor.ts"; // 扩展编辑器组件（扩展提供的自定义编辑器界面）
import { ExtensionInputComponent } from "./components/extension-input.ts"; // 扩展输入组件（扩展提供的自定义输入界面）
import { ExtensionSelectorComponent } from "./components/extension-selector.ts"; // 扩展选择器组件（扩展提供的自定义选择列表）

// ==================== UI 组件 - 页脚和快捷键提示 ====================
import { FooterComponent } from "./components/footer.ts"; // 页脚组件（显示当前目录、git 分支、模型、token 使用量等状态信息）
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts"; // 快捷键提示工具函数：formatKeyText 格式化按键文本；keyDisplayText 获取按键显示文本；keyHint 创建快捷键提示组件；keyText 获取按键标识文本；rawKeyHint 创建原始快捷键提示

// ==================== UI 组件 - 对话框和选择器 ====================
import { LoginDialogComponent } from "./components/login-dialog.ts"; // 登录对话框组件（API Key 输入、提供商认证）
import { ModelSelectorComponent } from "./components/model-selector.ts"; // 模型选择器组件（选择 AI 模型）
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts"; // 作用域模型选择器组件（选择项目级或全局模型配置）
import { SessionSelectorComponent } from "./components/session-selector.ts"; // 会话选择器组件（切换历史会话）
import { SettingsSelectorComponent } from "./components/settings-selector.ts"; // 设置选择器组件（修改配置选项）

// ==================== UI 组件 - 工具和技能 ====================
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts"; // 技能调用消息组件（显示技能执行过程和结果）
import { ToolExecutionComponent } from "./components/tool-execution.ts"; // 工具执行组件（显示工具调用的输入、输出、状态）

// ==================== UI 组件 - 通用选择器 ====================
import { TreeSelectorComponent } from "./components/tree-selector.ts"; // 树形选择器组件（支持层级结构的选择列表）
import { UserMessageComponent } from "./components/user-message.ts"; // 用户消息组件（渲染用户输入的消息）
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts"; // 用户消息选择器组件（从历史消息中选择）
// ==================== 主题系统 ====================
import {
	getAvailableThemes, // 获取所有可用主题列表
	getAvailableThemesWithPaths, // 获取所有可用主题及其文件路径（用于设置界面显示）
	getEditorTheme, // 获取编辑器主题配置（语法高亮、光标样式等）
	getMarkdownTheme, // 获取 Markdown 渲染主题（代码块、链接、标题等样式）
	getThemeByName, // 根据主题名称获取主题实例
	initTheme, // 初始化主题系统（加载默认主题或用户配置的主题）
	onThemeChange, // 注册主题变更监听器（主题切换时更新 UI）
	setRegisteredThemes, // 设置已注册的主题列表（从资源加载器获取）
	setTheme, // 切换当前主题
	setThemeInstance, // 设置主题实例（用于自定义主题）
	stopThemeWatcher, // 停止主题文件监视器（退出时清理）
	Theme, // 主题类（定义颜色、样式、字体等配置）
	type ThemeColor, // 主题颜色类型（支持语义化颜色名称）
	theme, // 当前主题实例的全局引用（用于快速访问主题颜色和样式）
} from "./theme/theme.ts";

// ==================== 辅助类型和工具函数 ====================

/**
 * 可展开/折叠组件的接口
 *
 * 用于实现可折叠的内容区域，如工具输出、思考过程、长文本等。
 * 组件实现此接口后，可以通过 setExpanded() 方法切换展开/折叠状态。
 *
 * 实现此接口的组件：ToolExecutionComponent, AssistantMessageComponent 等
 */
interface Expandable {
	/** 设置展开状态。true 为展开，false 为折叠 */
	setExpanded(expanded: boolean): void;
}

/**
 * 类型守卫函数：检查对象是否实现了 Expandable 接口
 *
 * 作用：在运行时安全地判断一个组件是否支持展开/折叠功能
 * 调用场景：当需要对组件进行展开/折叠操作前，先检查其是否支持
 *
 * @param obj - 待检查的对象
 * @returns 如果对象实现了 Expandable 接口则返回 true
 */
function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

/**
 * 可展开/折叠的文本组件
 *
 * 继承自 Text 组件，增加了展开/折叠功能。
 * 通过传入两个文本生成函数（折叠态和展开态），在切换状态时自动更新显示内容。
 *
 * 典型用途：工具输出的摘要/完整显示、思考过程的简略/详细显示
 *
 * 调用者：ToolExecutionComponent, AssistantMessageComponent 等需要可折叠文本的组件
 */
class ExpandableText extends Text implements Expandable {
	/** 获取折叠状态下的文本内容 */
	private readonly getCollapsedText: () => string;
	/** 获取展开状态下的文本内容 */
	private readonly getExpandedText: () => string;

	/**
	 * 创建可展开文本组件
	 *
	 * @param getCollapsedText - 返回折叠态文本的函数（延迟求值，避免不必要的计算）
	 * @param getExpandedText - 返回展开态文本的函数（延迟求值）
	 * @param expanded - 初始展开状态，默认为折叠
	 * @param paddingX - 水平内边距
	 * @param paddingY - 垂直内边距
	 */
	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		// 根据初始展开状态选择对应的文本
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	/**
	 * 切换展开/折叠状态
	 *
	 * @param expanded - 目标展开状态
	 */
	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

/**
 * 压缩期间排队的消息类型
 *
 * 当会话正在进行消息历史压缩（compaction）时，用户发送的新消息会被暂存到队列中，
 * 等压缩完成后再发送。这样可以避免压缩过程中的消息丢失或顺序错乱。
 *
 * 使用场景：InteractiveMode.handleInput() 中检测到压缩进行中时，将消息加入队列
 */
type CompactionQueuedMessage = {
	/** 消息文本内容 */
	text: string;
	/** 消息模式：steer = 引导/纠正方向，followUp = 追问/补充 */
	mode: "steer" | "followUp";
};

/**
 * 终端死亡错误代码集合
 *
 * 这些错误代码表示终端连接已断开或损坏，通常发生在：
 * - SSH 连接中断
 * - 终端模拟器崩溃
 * - 伪终端（PTY）资源耗尽
 *
 * 检测到这些错误时，应优雅地退出而非显示复杂的错误堆栈
 */
const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

/**
 * 判断错误是否为终端死亡错误
 *
 * 作用：检测终端连接是否已断开，用于决定错误处理策略
 * 调用者：InteractiveMode 中的错误处理逻辑（如 init(), subscribeToAgent() 等）
 * 被调用时机：捕获到未知错误时，判断是否应该优雅退出
 *
 * @param error - 捕获到的错误对象
 * @returns 如果是终端死亡错误返回 true
 */
function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

/**
 * 判断模型是否为"未知"状态
 *
 * 作用：检查模型对象是否处于未配置/未识别的状态
 * 调用场景：当用户尝试切换模型或发送消息时，检查当前模型是否有效
 * 返回 true 时表示模型未正确配置，需要提示用户选择模型
 *
 * @param model - 模型对象（可能为 undefined）
 * @returns 如果模型的所有标识字段都是 "unknown" 则返回 true
 */
function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

/**
 * 类型守卫：检查提供商 ID 是否有对应的默认模型
 *
 * 作用：判断给定的提供商是否在默认模型映射表中
 * 调用场景：解析模型配置时，确定是否需要使用提供商的默认模型
 *
 * @param providerId - 提供商标识符（如 "openai", "anthropic"）
 * @returns 如果提供商在默认模型映射表中返回 true
 */
function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

/** 内置 AI 提供商集合（从 pi-ai 模块动态获取） */
const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

/**
 * 判断提供商是否需要 API Key 登录
 *
 * 作用：区分需要 API Key 的提供商和使用其他认证方式的提供商
 * 调用者：登录对话框组件（LoginDialogComponent）、认证选择器（AuthSelectorComponent）
 *
 * 判断逻辑：
 * 1. 如果提供商在 BUILT_IN_PROVIDER_DISPLAY_NAMES 中有显示名称，说明是已知的需要 API Key 的提供商
 * 2. 如果提供商在内置提供商集合中，说明使用内置认证（如 OAuth），不需要 API Key
 * 3. 其他情况（第三方/自定义提供商）默认需要 API Key
 *
 * @param providerId - 提供商标识符
 * @param ignoredProviderIds - 忽略的提供商集合（用于过滤已处理的提供商）
 * @param builtInProviderIds - 内置提供商集合（默认使用全局集合）
 * @returns 如果需要 API Key 登录返回 true
 */
export function isApiKeyLoginProvider(
	providerId: string,
	ignoredProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	void ignoredProviderIds; // 参数保留用于未来扩展，当前未使用
	// 已知的需要 API Key 的提供商（有显示名称配置）
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	// 内置提供商使用其他认证方式（如 OAuth），不需要 API Key
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	// 第三方/自定义提供商默认需要 API Key
	return true;
}

/**
 * 交互模式初始化选项接口
 *
 * 用于配置 InteractiveMode 的启动行为。
 * 由 CLI 解析层创建，通过 AgentSessionRuntime 传递给 InteractiveMode。
 *
 * 调用链：CLI 参数解析 -> createSession() -> AgentSessionRuntime -> InteractiveMode 构造函数
 */
export interface InteractiveModeOptions {
	/** 已迁移到 auth.json 的提供商列表（显示迁移警告提示用户检查） */
	migratedProviders?: string[];
	/** 模型回退警告消息（当会话中保存的模型不可用时，使用默认模型并显示此消息） */
	modelFallbackMessage?: string;
	/**
	 * 启动时自动发送的初始消息
	 * 支持 @file 语法引用文件内容（如 "请解释 @src/main.ts 的作用"）
	 * 来源：CLI 的 -p/--prompt 参数或管道输入
	 */
	initialMessage?: string;
	/** 附加到初始消息的图片内容（用于多模态输入） */
	initialImages?: ImageContent[];
	/** 初始消息之后的额外消息列表（批量发送多条消息） */
	initialMessages?: string[];
	/**
	 * 强制详细启动模式
	 * 覆盖 quietStartup 设置，显示启动横幅、快捷键提示、变更日志等
	 * 来源：CLI 的 --verbose 参数
	 */
	verbose?: boolean;
}

/**
 * 交互模式主类 - TUI 渲染和用户交互的核心控制器
 *
 * 【职责】
 * 1. 管理整个终端界面的布局和渲染（header, chat, editor, footer）
 * 2. 处理用户输入（键盘事件、快捷键、斜杠命令）
 * 3. 订阅 AgentSession 事件并更新 UI（消息流、工具执行、状态变更）
 * 4. 协调 UI 组件的生命周期（创建、更新、销毁）
 * 5. 管理扩展系统的 UI 集成（自定义组件、widget、对话框）
 *
 * 【架构设计】
 * - 采用"被动订阅"模式：不主动调用业务逻辑，而是通过事件订阅响应状态变化
 * - UI 组件通过 TUI 框架的 Container 组织，形成树形结构
 * - 快捷键通过 KeybindingsManager 统一管理，支持运行时自定义
 *
 * 【与其他模块的关系】
 * - AgentSessionRuntime: 创建并持有本类实例，提供会话生命周期管理
 * - AgentSession: 业务逻辑核心，本类订阅其事件并委托其执行操作
 * - TUI 框架: 提供底层渲染能力，本类负责组装和调度
 * - 各 Component: 负责具体 UI 元素的渲染，本类负责协调它们
 *
 * 【生命周期】
 * 1. 构造函数: 初始化 UI 框架、容器、编辑器、页脚等基础组件
 * 2. init(): 注册信号处理、加载配置、设置自动补全、启动渲染循环
 * 3. start(): 进入主事件循环，处理用户输入和 UI 更新
 * 4. shutdown(): 清理资源、停止渲染、退出进程
 */
export class InteractiveMode {
	// ==================== 核心依赖 ====================
	/** 会话运行时管理器（提供会话访问和生命周期管理） */
	private runtimeHost: AgentSessionRuntime;
	/** TUI 框架主实例（管理整个终端界面的渲染循环） */
	private ui: TUI;

	// ==================== 主要 UI 容器 ====================
	/** 聊天消息容器（显示历史消息、AI 回复、工具执行等） */
	private chatContainer: Container;
	/** 待发送消息容器（显示正在编辑但未发送的消息，如 bash 命令预览） */
	private pendingMessagesContainer: Container;
	/** 状态容器（显示加载动画、工作状态、错误提示等） */
	private statusContainer: Container;

	// ==================== 编辑器相关 ====================
	/** 默认编辑器实例（内置的 CustomEditor，不会被扩展替换） */
	private defaultEditor: CustomEditor;
	/** 当前活跃的编辑器（可能是 defaultEditor 或扩展提供的自定义编辑器） */
	private editor: EditorComponent;
	/** 扩展提供的编辑器工厂（用于创建自定义编辑器） */
	private editorComponentFactory: EditorFactory | undefined;
	/** 当前自动补全提供者（合并了内置命令、模板、扩展命令等） */
	private autocompleteProvider: AutocompleteProvider | undefined;
	/** 自动补全提供者包装器列表（扩展可以通过这些包装器修改补全行为） */
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	/** fd 工具的路径（用于文件路径自动补全，init() 中下载设置） */
	private fdPath: string | undefined;
	/** 编辑器容器（包裹编辑器组件，支持运行时替换编辑器） */
	private editorContainer: Container;

	// ==================== 页脚和快捷键 ====================
	/** 页脚组件（显示当前目录、git 分支、模型、token 使用量等） */
	private footer: FooterComponent;
	/** 页脚数据提供者（收集和格式化页脚需要的各类信息） */
	private footerDataProvider: FooterDataProvider;
	/** 快捷键管理器（注册、查询、自定义快捷键绑定，注入到编辑器和选择器中） */
	private keybindings: KeybindingsManager;

	// ==================== 应用状态 ====================
	/** 当前版本号（从 config 模块获取） */
	private version: string;
	/** 是否已完成初始化（防止重复初始化） */
	private isInitialized = false;
	/** 用户输入回调函数（当用户提交消息时调用） */
	private onInputCallback?: (text: string) => void;

	// ==================== 加载和工作状态 ====================
	/** 加载动画组件（显示旋转指示器，表示 Agent 正在处理） */
	private loadingAnimation: Loader | undefined = undefined;
	/** 当前工作状态消息（如 "Thinking...", "Reading file..."） */
	private workingMessage: string | undefined = undefined;
	/** 工作状态指示器是否可见 */
	private workingVisible = true;
	/** 加载指示器配置（自定义动画样式、颜色等） */
	private workingIndicatorOptions: LoaderIndicatorOptions | undefined = undefined;
	/** 默认工作状态消息 */
	private readonly defaultWorkingMessage = "Working...";
	/** 默认隐藏思考标签（当思考块被隐藏时显示） */
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	/** 当前隐藏思考标签文本 */
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	// ==================== 用户交互状态 ====================
	/** 上次收到 SIGINT 信号的时间戳（用于检测双击 Ctrl+C 退出） */
	private lastSigintTime = 0;
	/** 上次按下 Escape 键的时间戳（用于检测双击 Escape 取消操作） */
	private lastEscapeTime = 0;
	/** 变更日志 Markdown 内容（启动时显示，或通过 /changelog 命令查看） */
	private changelogMarkdown: string | undefined = undefined;
	/** 启动通知是否已显示（防止重复显示） */
	private startupNoticesShown = false;

	// ==================== 状态行跟踪 ====================
	/** 上一个状态行 Spacer 组件（用于就地更新连续的状态消息） */
	private lastStatusSpacer: Spacer | undefined = undefined;
	/** 上一个状态行 Text 组件（用于就地更新连续的状态消息） */
	private lastStatusText: Text | undefined = undefined;

	// ==================== 流式消息跟踪 ====================
	/** 当前正在流式渲染的助手消息组件 */
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	/** 当前正在流式渲染的助手消息对象 */
	private streamingMessage: AssistantMessage | undefined = undefined;

	// ==================== 工具执行跟踪 ====================
	/** 工具执行组件映射表（toolCallId -> 组件实例，用于跟踪和更新工具执行状态） */
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// ==================== UI 展开/折叠状态 ====================
	/** 工具输出的全局展开状态（true = 所有工具输出展开显示） */
	private toolOutputExpanded = false;

	// ==================== 思考块可见性 ====================
	/** 是否隐藏思考块（用户可以通过快捷键切换） */
	private hideThinkingBlock = false;

	// ==================== 技能命令 ====================
	/** 技能命令映射表（命令名 -> 技能文件路径，如 "skill:code-review" -> "~/.pi/skills/code-review.md"） */
	private skillCommands = new Map<string, string>();

	// ==================== 清理和生命周期 ====================
	/** Agent 事件订阅的取消函数（用于在 shutdown 时取消订阅） */
	private unsubscribe?: () => void;
	/** 信号处理器清理函数列表（用于在 shutdown 时恢复原始信号处理） */
	private signalCleanupHandlers: Array<() => void> = [];

	// ==================== Bash 模式 ====================
	/** 编辑器是否处于 bash 模式（用户输入以 ! 开头时自动进入） */
	private isBashMode = false;
	/** 当前正在执行的 bash 命令组件 */
	private bashComponent: BashExecutionComponent | undefined = undefined;
	/** 待发送的 bash 组件列表（显示在待发送区域，提交后移动到聊天区域） */
	private pendingBashComponents: BashExecutionComponent[] = [];

	// ==================== 自动压缩状态 ====================
	/** 自动压缩加载动画（显示压缩进度） */
	private autoCompactionLoader: Loader | undefined = undefined;
	/** 自动压缩期间的 Escape 键处理器（用于取消压缩） */
	private autoCompactionEscapeHandler?: () => void;

	// ==================== 自动重试状态 ====================
	/** 自动重试加载动画（显示重试等待） */
	private retryLoader: Loader | undefined = undefined;
	/** 自动重试倒计时组件（显示距离下次重试的秒数） */
	private retryCountdown: CountdownTimer | undefined = undefined;
	/** 自动重试期间的 Escape 键处理器（用于取消重试） */
	private retryEscapeHandler?: () => void;

	// ==================== 压缩期间的消息队列 ====================
	/** 压缩进行中时排队的消息（压缩完成后自动发送） */
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// ==================== 关闭状态 ====================
	/** 是否已请求关闭（防止重复关闭） */
	private shutdownRequested = false;

	// ==================== 扩展 UI 状态 ====================
	/** 扩展提供的选择器组件（如文件选择器、命令选择器等） */
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	/** 扩展提供的输入组件（如自定义对话框输入） */
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	/** 扩展提供的编辑器组件（如专用代码编辑器） */
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	/** 扩展终端输入的取消订阅函数集合 */
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// ==================== 扩展 Widget ====================
	/** 编辑器上方的扩展 widget（按注册顺序渲染） */
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	/** 编辑器下方的扩展 widget（按注册顺序渲染） */
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	/** 编辑器上方 widget 容器 */
	private widgetContainerAbove!: Container;
	/** 编辑器下方 widget 容器 */
	private widgetContainerBelow!: Container;

	// ==================== 自定义页脚和头部 ====================
	/** 扩展提供的自定义页脚（undefined = 使用内置页脚） */
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;
	/** 头部容器（持有内置或自定义头部组件） */
	private headerContainer: Container;
	/** 内置头部组件（logo + 快捷键提示 + 变更日志） */
	private builtInHeader: Component | undefined = undefined;
	/** 扩展提供的自定义头部（undefined = 使用内置头部） */
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// ==================== 配置选项 ====================
	/** 初始化选项（初始消息、图片、verbose 模式等） */
	private options: InteractiveModeOptions;

	// ==================== 便捷访问器 ====================
	/**
	 * 获取当前 AgentSession 实例
	 *
	 * 作用：提供对业务逻辑层的便捷访问
	 * 调用者：本类的几乎所有方法（用于访问会话状态、执行操作等）
	 * 数据来源：AgentSessionRuntime.session
	 */
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}

	/**
	 * 获取当前 Agent 实例
	 *
	 * 作用：提供对 AI 代理的便捷访问（发送消息、取消请求等）
	 * 调用者：handleInput(), cancelCurrentRequest() 等方法
	 */
	private get agent() {
		return this.session.agent;
	}

	/**
	 * 获取会话管理器实例
	 *
	 * 作用：提供对会话持久化和切换的便捷访问
	 * 调用者：会话选择器、会话保存/加载相关方法
	 */
	private get sessionManager() {
		return this.session.sessionManager;
	}

	/**
	 * 获取设置管理器实例
	 *
	 * 作用：提供对用户配置的便捷访问（主题、快捷键、行为偏好等）
	 * 调用者：构造函数、init()、各种 UI 配置方法
	 */
	private get settingsManager() {
		return this.session.settingsManager;
	}

	/**
	 * 构造函数 - 初始化交互模式的所有基础组件
	 *
	 * 执行流程：
	 * 1. 存储运行时宿主和配置选项
	 * 2. 注册会话失效和重绑定回调（用于会话切换时清理和重建 UI）
	 * 3. 创建 TUI 框架实例和所有容器
	 * 4. 初始化快捷键管理器
	 * 5. 创建默认编辑器（带自动补全支持）
	 * 6. 初始化页脚组件（显示目录、分支、模型等状态信息）
	 * 7. 加载用户设置（思考块隐藏、主题等）
	 *
	 * 调用者：AgentSessionRuntime.start() 在启动交互模式前调用
	 * 调用的下游：TUI 框架初始化、KeybindingsManager.create()、CustomEditor 构造、主题初始化等
	 *
	 * @param runtimeHost - 会话运行时管理器（提供会话访问和生命周期管理）
	 * @param options - 初始化选项（初始消息、verbose 模式等）
	 */
	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.options = options;

		// 注册会话失效回调：当会话被销毁或切换前，清理扩展 UI 状态
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});

		// 注册会话重绑定回调：当会话需要重新绑定时（如模型切换、配置变更），重建 UI 绑定
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession();
		});

		this.version = VERSION;

		// 创建 TUI 框架实例，连接到进程终端（stdin/stdout）
		// getShowHardwareCursor(): 是否显示硬件光标（某些终端模拟器需要）
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		// setClearOnShrink: 窗口缩小时是否清屏（避免残留内容）
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());

		// 创建主要 UI 容器
		this.headerContainer = new Container(); // 头部（logo、快捷键提示）
		this.chatContainer = new Container(); // 聊天消息区域
		this.pendingMessagesContainer = new Container(); // 待发送消息区域
		this.statusContainer = new Container(); // 状态指示区域（加载、错误等）
		this.widgetContainerAbove = new Container(); // 编辑器上方的扩展 widget
		this.widgetContainerBelow = new Container(); // 编辑器下方的扩展 widget

		// 初始化快捷键管理器，并设置为全局快捷键提供者
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);

		// 从用户设置读取编辑器配置
		const editorPaddingX = this.settingsManager.getEditorPaddingX(); // 编辑器水平内边距
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible(); // 自动补全最大显示项数

		// 创建默认编辑器（使用编辑器主题、快捷键管理器、自动补全配置）
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor; // 设置当前编辑器为默认编辑器

		// 创建编辑器容器并添加默认编辑器
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);

		// 初始化页脚数据提供者和页脚组件
		// FooterDataProvider 收集当前目录、git 分支、模型信息等用于页脚显示
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		// 根据会话配置设置自动压缩开关
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// 加载"隐藏思考块"设置（用户可以通过快捷键切换）
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// 注册从资源加载器获取的主题列表，并初始化当前主题
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	/**
	 * 获取自动补全项的来源标签
	 *
	 * 作用：为自动补全项生成简短的来源标识，帮助用户区分命令来源
	 * 标签格式示例：[u] = 用户级, [p] = 项目级, [t] = 团队级
	 *              [u:npm:@scope/pkg] = 用户级 npm 包
	 *              [p:git:github.com/user/repo@main] = 项目级 git 仓库
	 *
	 * 调用者：prefixAutocompleteDescription() 在生成补全项描述时调用
	 * 调用的下游：parseGitUrl() 解析 git URL
	 *
	 * @param sourceInfo - 资源来源信息（包含 scope 和 source）
	 * @returns 来源标签字符串，如果无来源信息返回 undefined
	 */
	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		// 根据作用域生成前缀：u = user（用户级）, p = project（项目级）, t = team（团队级）
		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		// 本地来源（自动检测、本地文件、CLI 参数）只显示作用域前缀
		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		// npm 包来源：显示为 [u:npm:@scope/pkg] 格式
		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		// Git 仓库来源：解析 URL 并显示为 [u:git:host/path@ref] 格式
		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		// 其他来源只显示作用域前缀
		return scopePrefix;
	}

	/**
	 * 为自动补全项描述添加来源前缀
	 *
	 * 作用：将来源标签（如 [u], [p:git:...]）添加到命令描述前面
	 * 效果示例："[p:git:github.com/user/repo] Code review command"
	 *
	 * 调用者：createBaseAutocompleteProvider() 在构建模板命令和扩展命令时调用
	 * 调用的下游：getAutocompleteSourceTag() 获取来源标签
	 *
	 * @param description - 原始描述文本（可能为 undefined）
	 * @param sourceInfo - 资源来源信息（可能为 undefined）
	 * @returns 添加来源前缀后的描述，如果无来源则返回原描述
	 */
	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	/**
	 * 检测扩展命令与内置命令的冲突
	 *
	 * 作用：扫描扩展注册的命令，找出与内置斜杠命令同名的冲突
	 * 冲突处理：扩展命令会被跳过（不显示在自动补全中），但会生成警告诊断信息
	 *
	 * 调用者：init() 中在设置自动补全提供者之前调用，用于显示冲突警告
	 * 调用的下游：BUILTIN_SLASH_COMMANDS 获取内置命令列表，ExtensionRunner.getRegisteredCommands() 获取扩展命令
	 *
	 * @param extensionRunner - 扩展运行器实例
	 * @returns 资源诊断信息数组（包含冲突警告）
	 */
	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		// 构建内置命令名称集合
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return (
			extensionRunner
				.getRegisteredCommands()
				// 过滤出与内置命令同名的扩展命令
				.filter((command) => builtinNames.has(command.name))
				.map((command) => ({
					type: "warning" as const,
					// 根据调用名是否与原名相同，生成不同的警告信息
					message:
						command.invocationName === command.name
							? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
							: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
					path: command.sourceInfo.path,
				}))
		);
	}

	/**
	 * 创建基础自动补全提供者
	 *
	 * 作用：合并所有命令来源（内置命令、模板命令、扩展命令、技能命令），
	 *       生成统一的自动补全提供者供编辑器使用
	 *
	 * 命令来源：
	 * 1. 内置斜杠命令（/model, /clear, /help 等）
	 * 2. 提示模板命令（用户或项目定义的自定义提示）
	 * 3. 扩展命令（插件注册的自定义命令）
	 * 4. 技能命令（skill:name 格式，从技能文件加载）
	 *
	 * 特殊处理：
	 * - /model 命令支持模型名称自动补全（模糊搜索 provider/id）
	 * - 扩展命令会过滤掉与内置命令冲突的条目
	 * - 技能命令受 enableSkillCommands 设置控制
	 *
	 * 调用者：setupAutocompleteProvider() 在初始化和会话重绑定时调用
	 * 调用的下游：CombinedAutocompleteProvider 合并多个提供者，fuzzyFilter 模糊过滤
	 *
	 * @returns 合并后的自动补全提供者实例
	 */
	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// 构建内置斜杠命令列表（用于自动补全）
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		// 为 /model 命令添加参数补全支持
		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// 获取可用模型列表：优先使用作用域模型，否则使用模型注册表中的所有模型
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// 构建模型项（包含 id, provider, label）
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// 使用模糊过滤（支持 "opus anthropic" 这样的跨字段搜索）
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				// 返回格式化的补全项（value = 完整值，label = 模型名，description = 提供商）
				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		// 将提示模板转换为斜杠命令格式（用于自动补全）
		// 模板命令的描述会添加来源标签（如 [p], [u:npm:...]）
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// 将扩展命令转换为斜杠命令格式
		// 过滤掉与内置命令冲突的扩展命令（避免重复）
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// 构建技能命令（如果启用）
		// 技能命令格式：skill:<name>，从技能文件加载
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		// 合并所有命令来源，创建组合自动补全提供者
		// CombinedAutocompleteProvider 会按顺序搜索所有命令，并支持文件路径补全
		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(), // 当前工作目录（用于文件路径补全）
			this.fdPath, // fd 工具路径（用于快速文件搜索）
		);
	}

	/**
	 * 设置自动补全提供者
	 *
	 * 作用：创建基础提供者，应用所有扩展包装器，然后注入到编辑器中
	 * 包装器机制允许扩展修改或增强自动补全行为（如添加特殊命令、修改过滤逻辑等）
	 *
	 * 调用者：init() 初始化时、rebindCurrentSession() 会话重绑定时
	 * 调用的下游：createBaseAutocompleteProvider() 创建基础提供者，Editor.setAutocompleteProvider() 注入到编辑器
	 */
	private setupAutocompleteProvider(): void {
		// 创建基础提供者（合并内置命令、模板、扩展命令、技能命令）
		let provider = this.createBaseAutocompleteProvider();
		// 应用所有扩展包装器（按注册顺序链式包装）
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
		}

		// 将最终的提供者注入到编辑器中
		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		// 如果当前使用的不是默认编辑器（扩展提供的），也需要注入
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	/**
	 * 显示启动通知（如果需要）
	 *
	 * 作用：在首次启动时显示变更日志或版本更新提示
	 * 显示逻辑：
	 * 1. 如果已显示过，跳过（防止重复显示）
	 * 2. 如果没有变更日志内容，跳过
	 * 3. 根据 collapseChangelog 设置决定显示完整日志还是简略提示
	 *
	 * 调用者：init() 初始化完成后调用
	 * 调用的下游：getMarkdownThemeWithSettings() 获取 Markdown 主题配置
	 */
	private showStartupNoticesIfNeeded(): void {
		// 防止重复显示
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		// 没有变更日志内容则跳过
		if (!this.changelogMarkdown) {
			return;
		}

		// 在聊天容器中添加变更日志显示
		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());

		if (this.settingsManager.getCollapseChangelog()) {
			// 折叠模式：只显示版本号和查看完整日志的提示
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			// 完整模式：显示 "What's New" 标题和完整变更日志
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	/**
	 * 初始化交互模式的所有 UI 组件、扩展系统和事件监听。
	 *
	 * 作用: 完整初始化 TUI 界面，包括工具检查、头部构建、UI 布局、扩展绑定、消息渲染等
	 * 被谁调用: run() 方法在启动主循环前调用
	 * 调用了谁: registerSignalHandlers(), getChangelogForDisplay(), ensureTool(),
	 *   rebindCurrentSession(), renderInitialMessages(), onThemeChange(),
	 *   updateAvailableProviderCount()
	 */
	async init(): Promise<void> {
		// 防止重复初始化
		if (this.isInitialized) return;

		// 注册进程信号处理器（SIGINT、SIGTERM 等）
		this.registerSignalHandlers();

		// 加载变更日志（仅显示上次版本以来的新条目，恢复会话时跳过）
		this.changelogMarkdown = this.getChangelogForDisplay();

		// 确保 fd 和 rg 工具可用（缺失时自动下载，通过 getBinDir 添加到 PATH）
		// fd 用于自动补全的文件搜索，rg 用于 grep 工具和 bash 命令
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// 在控制台输出当前模型作用域信息（如果启用了详细模式或未启用静默启动）
		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			// 构建模型列表字符串，包含模型 ID 和思维级别
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			// 获取模型切换的快捷键并生成提示文本
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		// 将头部容器作为第一个子组件添加到 UI 根节点
		this.ui.addChild(this.headerContainer);

		// 构建启动头部信息（除非处于静默模式）
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			// 构建品牌标识：应用名称 + 版本号
			const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);

			// 快捷键提示辅助函数，将 AppKeybinding 枚举转换为格式化的提示文本
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			// 构建展开状态下的完整快捷键提示列表（每行一个快捷键说明）
			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			// 构建紧凑模式下的快捷键提示列表（用分隔符连接，节省空间）
			const compactInstructions = [
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));
			// 紧凑模式下的引导提示，提示用户可按快捷键展开完整帮助和已加载资源
			const compactOnboarding = theme.fg(
				"dim",
				`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
			);
			// 通用引导提示，告知用户可以向 Pi 询问功能使用方法
			const onboarding = theme.fg(
				"dim",
				`Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`,
			);
			// 创建可展开/折叠的头部文本组件，紧凑模式和展开模式显示不同的快捷键提示
			this.builtInHeader = new ExpandableText(
				() => `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
				() => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
				this.getStartupExpansionState(),
				1,
				0,
			);

			// 设置 UI 布局：将头部组件添加到 header 容器中
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// 静默模式下使用空头部，不显示任何启动信息
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}

		// 按顺序组装 UI 的各个层级容器：聊天区、待处理消息、状态栏、小部件、编辑器、底部栏
		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // 使用默认间距初始化小部件区域
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		// 绑定键盘快捷键处理器和编辑器提交处理器
		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// 在初始化扩展之前先启动 UI，以便 session_start 处理器可以使用交互式对话框
		this.ui.start();
		this.isInitialized = true;

		// 初始化扩展系统（先于消息渲染，以便已加载的资源在消息之前显示）
		await this.rebindCurrentSession();

		// 在显示已加载资源之后，渲染初始消息（历史消息或欢迎消息）
		this.renderInitialMessages();

		// 监听主题文件变更，当主题更新时刷新 UI
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// 监听 git 分支变更，更新底部栏显示
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// 初始化可用的 AI 提供者数量，用于底部栏显示
		await this.updateAvailableProviderCount();
	}

	/**
	 * 更新终端窗口标题，显示应用名称、会话名称和当前工作目录。
	 *
	 * 作用: 设置终端标题栏文本，格式为 "APP_TITLE - 会话名 - 目录名" 或 "APP_TITLE - 目录名"
	 * 被谁调用: init() 在初始化完成时调用; rebindCurrentSession() 在切换会话时调用
	 * 调用了谁: sessionManager.getCwd(), sessionManager.getSessionName(), ui.terminal.setTitle()
	 */
	private updateTerminalTitle(): void {
		// 获取当前工作目录的基础名称（不含父路径）
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			// 有会话名称时显示三段式标题
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			// 无会话名称时显示两段式标题
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * 交互模式的主入口方法。
	 *
	 * 作用: 初始化 UI，显示启动警告，处理初始消息，然后进入无限循环等待用户输入
	 * 被谁调用: AgentSessionRuntime.start() 创建并启动本模块时调用
	 * 调用了谁: init(), checkForNewPiVersion(), checkForPackageUpdates(),
	 *   checkTmuxKeyboardSetup(), session.prompt(), getUserInput(),
	 *   showNewVersionNotification(), showPackageUpdateNotification(), showWarning(), showError()
	 */
	async run(): Promise<void> {
		// 第一步：初始化所有 UI 组件和扩展系统
		await this.init();

		// 异步检查是否有新版本可用（不阻塞主流程）
		checkForNewPiVersion(this.version).then((newRelease) => {
			if (newRelease) {
				this.showNewVersionNotification(newRelease);
			}
		});

		// 异步检查扩展包是否有可用更新
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) {
				this.showPackageUpdateNotification(updates);
			}
		});

		// 异步检查 tmux 键盘配置是否正确
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// 显示启动警告信息
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		// 提示用户凭据已迁移到 auth.json
		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		// 检查模型注册表是否有加载错误
		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		// 显示模型回退消息（当请求的模型不可用时）
		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		// 检查 Anthropic 订阅认证状态并发出警告
		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// 处理通过命令行传入的初始消息（单条）
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		// 处理通过命令行传入的初始消息列表（多条，依次执行）
		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// 进入主交互循环：持续等待用户输入并处理
		while (true) {
			// 阻塞等待用户在编辑器中输入并提交
			const userInput = await this.getUserInput();
			try {
				// 将用户输入发送到 AgentSession 处理（包含 AI 模型调用、工具执行等）
				await this.session.prompt(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	/**
	 * 检查已安装的扩展包是否有可用更新。
	 *
	 * 作用: 创建包管理器实例并查询扩展包的更新状态
	 * 被谁调用: run() 在启动时异步调用
	 * 调用了谁: DefaultPackageManager 构造函数, packageManager.checkForAvailableUpdates()
	 */
	private async checkForPackageUpdates(): Promise<string[]> {
		// 离线模式下跳过更新检查
		if (process.env.PI_OFFLINE) {
			return [];
		}

		try {
			// 创建默认包管理器，用于检查扩展包的更新
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			// 返回可读的显示名称列表
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	/**
	 * 检查 tmux 环境下的键盘扩展配置是否正确。
	 *
	 * 作用: 验证 tmux 的 extended-keys 和 extended-keys-format 设置，确保修改键组合能正常工作
	 * 被谁调用: run() 在启动时异步调用
	 * 调用了谁: spawn("tmux") 子进程查询 tmux 配置选项
	 */
	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		// 非 tmux 环境下无需检查
		if (!process.env.TMUX) return undefined;

		/**
		 * 运行 tmux show 命令查询指定选项的值。
		 * 使用子进程执行，并设置 2 秒超时以防止阻塞。
		 */
		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				// 设置 2 秒超时，超时后终止子进程并返回 undefined
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		// 并行查询两个 tmux 配置选项
		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// 如果无法查询 tmux（超时、沙箱限制等），不发出警告
		if (extendedKeys === undefined) return undefined;

		// 检查 extended-keys 是否启用，未启用时返回警告
		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		// 检查 extended-keys-format 是否为推荐的 csi-u 格式
		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * 获取启动时需要显示的变更日志内容。
	 *
	 * 作用: 比较当前版本与上次查看的版本，返回新增的变更日志条目
	 * 被谁调用: init() 在初始化阶段调用
	 * 调用了谁: settingsManager.getLastChangelogVersion(), getChangelogPath(),
	 *   parseChangelog(), getNewEntries(), reportInstallTelemetry()
	 */
	private getChangelogForDisplay(): string | undefined {
		// 恢复/继续的会话已有消息，跳过变更日志显示
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		// 获取上次查看变更日志的版本号
		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		// 解析变更日志文件，获取所有条目
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// 全新安装：记录当前版本号，发送安装遥测，但不显示变更日志
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		// 获取自上次版本以来的新增条目
		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			// 有新条目时更新版本记录、发送遥测，并返回格式化的变更日志内容
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries.map((e) => e.content).join("\n\n");
		}

		return undefined;
	}

	/**
	 * 报告安装遥测数据到远程服务器。
	 *
	 * 作用: 向 pi.dev 发送安装/更新事件的匿名遥测请求
	 * 被谁调用: getChangelogForDisplay() 在检测到新版本或首次安装时调用
	 * 调用了谁: isInstallTelemetryEnabled(), getPiUserAgent(), fetch()
	 */
	private reportInstallTelemetry(version: string): void {
		// 离线模式下跳过遥测
		if (process.env.PI_OFFLINE) {
			return;
		}

		// 检查用户是否启用了安装遥测
		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			return;
		}

		// 发送异步的 HTTP 请求报告安装事件，设置 5 秒超时，错误静默忽略
		void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
			headers: {
				"User-Agent": getPiUserAgent(version),
			},
			signal: AbortSignal.timeout(5000),
		})
			.then(() => undefined)
			.catch(() => undefined);
	}

	/**
	 * 获取合并了用户设置的 Markdown 主题配置。
	 *
	 * 作用: 基于默认主题，叠加用户自定义的代码块缩进设置
	 * 被谁调用: showStartupNoticesIfNeeded() 渲染变更日志时调用; 以及其他需要渲染 Markdown 的地方
	 * 调用了谁: getMarkdownTheme(), settingsManager.getCodeBlockIndent()
	 */
	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			// 用户自定义的代码块缩进量
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// 扩展系统 - 路径格式化与资源显示方法
	// =========================================================================

	/**
	 * 格式化显示路径，将用户主目录替换为 ~ 符号。
	 *
	 * 作用: 缩短绝对路径，使其更易读
	 * 被谁调用: formatExtensionDisplayPath(), formatContextPath(), getShortPath(),
	 *   formatPathWithSource(), showLoadedResources() 等多个路径格式化方法
	 * 调用了谁: os.homedir()
	 */
	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// 将用户主目录路径替换为 ~ 前缀
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	/**
	 * 格式化扩展文件的显示路径，去除 index.ts/index.js 后缀。
	 *
	 * 作用: 扩展文件通常以 index.ts/js 为入口，显示时去除冗余的文件名
	 * 被谁调用: showLoadedResources() 中格式化扩展路径显示
	 * 调用了谁: formatDisplayPath()
	 */
	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		// 去除扩展入口文件的 index.ts/index.js 后缀
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	/**
	 * 格式化上下文文件路径，优先显示相对于当前工作目录的路径。
	 *
	 * 作用: 上下文文件（如 AGENTS.md）优先显示相对路径，外部路径则显示 ~ 缩写形式
	 * 被谁调用: showLoadedResources() 中格式化上下文文件列表
	 * 调用了谁: getCwdRelativePath(), formatDisplayPath()
	 */
	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		// 将相对路径转换为绝对路径
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		// 尝试获取相对于工作目录的路径
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		// 无法获取相对路径时，使用 ~ 缩写的绝对路径
		return this.formatDisplayPath(absolutePath);
	}

	/**
	 * 获取启动时头部的展开/折叠初始状态。
	 *
	 * 作用: 决定启动时是否展开显示完整的快捷键帮助
	 * 被谁调用: init() 中创建 ExpandableText 时调用
	 * 调用了谁: 无（读取 options.verbose 和 toolOutputExpanded 状态）
	 */
	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/**
	 * 获取相对于包根目录的短路径，用于显示。
	 *
	 * 作用: 根据资源来源（npm 包、git 仓库、本地路径）计算最简短的显示路径
	 * 被谁调用: formatPathWithSource(), getCompactExtensionLabel(),
	 *   getCompactPackageSourceLabel(), showLoadedResources() 等
	 * 调用了谁: isPackageSource(), formatDisplayPath()
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const baseDir = sourceInfo?.baseDir;
		// 对于包来源的资源，尝试计算相对于包根目录的路径
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			// 确保相对路径有效（不以 .. 开头，不是绝对路径，不是 "."）
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		// 对于 npm 包来源，从 node_modules 路径中提取包内的相对路径
		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		// 对于 git 来源，从 git 缓存路径中提取仓库内的相对路径
		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		// 兜底：使用 ~ 缩写的完整路径
		return this.formatDisplayPath(fullPath);
	}

	/**
	 * 获取资源路径的紧凑标签，仅返回路径的最后一段（文件名）。
	 *
	 * 作用: 在资源列表的紧凑视图中只显示文件名，节省空间
	 * 被谁调用: getCompactExtensionLabel(), getCompactNonPackageExtensionLabel(), showLoadedResources()
	 * 调用了谁: getShortPath()
	 */
	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		// 按路径分隔符分割，过滤空段和 ~ 符号
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			// 返回路径的最后一段（文件名或目录名）
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	/**
	 * 获取包来源的紧凑标签，提取 npm 包名或 git 仓库路径。
	 *
	 * 作用: 从来源标识中提取人类可读的包名称
	 * 被谁调用: getCompactExtensionLabel() 中格式化包来源扩展的标签
	 * 调用了谁: parseGitUrl()
	 */
	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		// npm 来源：去掉 "npm:" 前缀，获取包名
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		// git 来源：解析 git URL，提取仓库路径
		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	/**
	 * 获取扩展的紧凑标签，格式为 "包名:子路径"。
	 *
	 * 作用: 为包来源的扩展生成 "npm包名:extensions/xxx" 格式的紧凑标签
	 * 被谁调用: getCompactExtensionLabels() 中处理包来源的扩展
	 * 调用了谁: isPackageSource(), getCompactPathLabel(), getCompactPackageSourceLabel(), getShortPath()
	 */
	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		// 非包来源的扩展直接使用文件名作为标签
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		// 获取包来源的名称标签（如 npm 包名或 git 仓库路径）
		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		// 获取包内的短路径，去掉 extensions/ 前缀
		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		// 如果入口文件是 index，只显示目录名；否则显示完整子路径
		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	/**
	 * 获取资源路径的紧凑显示段数组，按 "/" 分割后的路径片段列表。
	 *
	 * 作用: 将路径转换为段数组，用于后续的唯一性比较和紧凑标签生成
	 * 被谁调用: getCompactExtensionLabels() 中为非包来源扩展生成路径段
	 * 调用了谁: formatDisplayPath()
	 */
	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return (
			this.formatDisplayPath(resourcePath)
				.replace(/\\/g, "/")
				.split("/")
				// 过滤掉空字符串段和 ~ 符号
				.filter((segment) => segment.length > 0 && segment !== "~")
		);
	}

	/**
	 * 获取非包来源扩展的最短唯一标签。
	 *
	 * 作用: 在多个非包扩展之间，通过逐步增加路径段数来生成能唯一标识每个扩展的最短标签
	 * 被谁调用: getCompactExtensionLabels() 中处理非包来源的扩展
	 * 调用了谁: getCompactPathLabel()
	 */
	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		// 从 1 个路径段开始，逐步增加，直到找到能唯一标识当前扩展的标签
		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			// 检查当前候选标签是否在所有扩展中唯一
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		// 所有路径段拼接仍无法唯一区分时，使用完整路径段
		return segments.join("/");
	}

	/**
	 * 为所有扩展生成紧凑标签列表。
	 *
	 * 作用: 区分包来源和非包来源的扩展，分别使用不同的标签生成策略
	 * 被谁调用: showLoadedResources() 中生成扩展列表的紧凑视图
	 * 调用了谁: getCompactDisplayPathSegments(), isPackageSource(),
	 *   getCompactExtensionLabel(), getCompactPathLabel(), getCompactNonPackageExtensionLabel()
	 */
	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		// 预处理非包来源的扩展：提取路径段并去除 index.ts/index.js 后缀
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				// 去除入口文件的 index 后缀以简化显示
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		// 为每个扩展生成对应的紧凑标签
		return extensions.map((extension) => {
			// 包来源的扩展使用 "包名:子路径" 格式
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			// 非包来源的扩展使用最短唯一路径标签
			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	/**
	 * 获取资源来源的显示信息，包括标签文本、作用域标签和颜色。
	 *
	 * 作用: 根据来源（local/cli/npm/git）和作用域（user/project/temporary/path）生成显示用的标签配置
	 * 被谁调用: formatPathWithSource() 中格式化带来源的路径; formatDiagnostics() 中显示诊断信息
	 * 调用了谁: 无（纯数据转换逻辑）
	 */
	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		// 本地来源：根据作用域返回不同的标签
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		// 命令行来源：标记为 path，临时作用域时附加 temp 标签
		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		// 外部包来源（npm/git 等）：使用高亮颜色显示来源名称和作用域
		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	/**
	 * 根据来源信息确定资源所属的作用域分组。
	 *
	 * 作用: 将资源归类到 user、project 或 path 三个分组之一
	 * 被谁调用: buildScopeGroups() 中对每个资源进行分组
	 * 调用了谁: 无（纯数据判断逻辑）
	 */
	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		// 命令行来源或临时作用域归入 path 分组
		if (source === "cli" || scope === "temporary") return "path";
		// 用户级作用域归入 user 分组
		if (scope === "user") return "user";
		// 项目级作用域归入 project 分组
		if (scope === "project") return "project";
		// 其他情况归入 path 分组
		return "path";
	}

	/**
	 * 判断资源来源是否为外部包（npm 或 git）。
	 *
	 * 作用: 区分本地文件和外部包来源的资源，用于决定路径格式化和分组策略
	 * 被谁调用: buildScopeGroups(), getCompactExtensionLabel(),
	 *   getCompactExtensionLabels(), getShortPath() 等多处
	 * 调用了谁: 无（纯字符串判断）
	 */
	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	/**
	 * 将资源列表按作用域（user/project/path）分组，并在每个组内区分包来源和本地路径。
	 *
	 * 作用: 构建分层的资源分组结构，用于在 "已加载资源" 面板中按作用域和来源组织显示
	 * 被谁调用: showLoadedResources() 中对 skills、prompts、extensions、themes 进行分组
	 * 调用了谁: getScopeGroup(), isPackageSource()
	 */
	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		// 初始化三个作用域分组容器
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		// 遍历所有资源，按作用域分组，并在组内区分包来源和本地路径
		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				// 包来源的资源按来源标识（npm/git URL）归类到 packages Map 中
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				// 本地路径来源的资源直接放入 paths 数组
				group.paths.push(item);
			}
		}

		// 按 project -> user -> path 顺序返回非空分组
		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	/**
	 * 将作用域分组格式化为可读的文本列表。
	 *
	 * 作用: 将 buildScopeGroups() 生成的分组结构渲染为带缩进和颜色的文本行
	 * 被谁调用: showLoadedResources() 中格式化 skills、prompts、extensions、themes 列表
	 * 调用了谁: 通过 options.formatPath 和 options.formatPackagePath 回调调用外部格式化函数
	 */
	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			// 输出作用域分组标题（如 "project"、"user"、"path"）
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			// 按路径字母顺序排列本地路径来源的资源
			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			// 按来源名称字母顺序排列包来源的资源
			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				// 输出包来源标题（如 npm 包名或 git URL）
				lines.push(`    ${theme.fg("mdLink", source)}`);
				// 按路径字母顺序排列该包下的资源
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * 在 sourceInfos 映射中查找给定路径对应的来源信息，支持向上遍历父目录匹配。
	 *
	 * 作用: 精确匹配或通过父目录路径回溯查找资源的来源信息
	 * 被谁调用: formatDiagnostics() 中为诊断信息中的路径查找来源信息
	 * 调用了谁: 无（纯 Map 查找逻辑）
	 */
	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		// 优先精确匹配
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		// 精确匹配失败时，逐步向上遍历父目录查找
		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	/**
	 * 格式化带来源标识的路径，显示为 "[来源标签] 短路径" 的格式。
	 *
	 * 作用: 在诊断信息和资源列表中显示路径时附加来源和作用域标签
	 * 被谁调用: formatDiagnostics() 中格式化碰撞诊断和错误诊断中的路径
	 * 调用了谁: getShortPath(), getDisplaySourceInfo(), formatDisplayPath()
	 */
	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			// 组合标签文本，有作用域时显示为 "来源 (作用域)" 格式
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	/**
	 * 格式化资源诊断信息为可读的文本，包括名称碰撞和错误/警告。
	 *
	 * 作用: 将碰撞诊断按名称分组显示胜出/被跳过的路径，其他诊断按错误/警告级别显示
	 * 被谁调用: showLoadedResources() 中显示技能、提示词、扩展、主题的诊断信息
	 * 调用了谁: formatPathWithSource(), findSourceInfoForPath()
	 */
	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// 将碰撞诊断按名称分组，其他诊断单独收集
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// 按名称分组格式化碰撞诊断，显示胜出路径（标记为 checkmark）和被跳过路径（标记为 cross）
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			// 显示胜出的路径（被选中的资源）
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			// 显示被跳过的路径（重复的资源）
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		// 格式化其他类型的诊断信息（加载错误、命令冲突等）
		for (const d of otherDiagnostics) {
			if (d.path) {
				// 有路径信息的诊断：第一行显示路径，第二行显示消息
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				// 无路径信息的诊断：直接显示消息
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	/**
	 * 在启动时显示已加载的资源列表和诊断信息。
	 *
	 * 作用: 将已加载的上下文文件、技能、提示词、扩展、主题以可展开/折叠的列表形式显示在聊天区域，
	 *       同时显示资源冲突和加载错误的诊断信息
	 * 被谁调用: bindCurrentSessionExtensions() 中初始化扩展后调用
	 * 调用了谁: buildScopeGroups(), formatScopeGroups(), formatCompactList(),
	 *   getCompactExtensionLabels(), formatDiagnostics(), formatDisplayPath(),
	 *   formatContextPath(), formatExtensionDisplayPath(), getCompactPathLabel(),
	 *   getShortPath(), getStartupExpansionState()
	 */
	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		// 判断是否显示资源列表和诊断信息
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		// 生成带颜色的分区标题，如 "[Skills]"
		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		// 格式化紧凑列表：将标签用逗号连接，可选按字母排序
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		// 向聊天容器添加一个可展开/折叠的资源分区
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.chatContainer.addChild(section);
			this.chatContainer.addChild(new Spacer(1));
		};

		// 从资源加载器获取所有类型的资源
		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		// 获取扩展列表（优先使用传入的参数，否则从资源加载器获取）
		const extensions =
			options?.extensions ??
			this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		// 构建路径到来源信息的映射表，用于诊断信息中的来源查找
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			// 显示上下文文件列表（如 AGENTS.md）
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				// 紧凑视图中保持原始顺序（不排序）
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			// 显示技能列表，按作用域分组
			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				// 紧凑视图中显示技能名称列表
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			// 显示提示词模板列表，按作用域分组
			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				// 构建路径到模板的映射，用于格式化时显示命令名称
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				// 紧凑视图中显示 /name 格式的命令列表
				const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			// 显示扩展列表，按作用域分组
			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}

			// 显示已加载的自定义主题列表（排除内置主题）
			const loadedThemes = themesResult.themes;
			// 只显示有自定义来源路径的主题（排除内置主题）
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				// 紧凑视图中显示主题名称，无名称时使用路径标签
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("Themes", themeCompactList, themeList);
			}
		}

		// 显示诊断信息（资源冲突、加载错误等）
		if (showDiagnostics) {
			// 显示技能冲突诊断
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			// 显示提示词冲突诊断
			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			// 收集扩展相关的诊断信息（加载错误、命令冲突、快捷键冲突）
			const extensionDiagnostics: ResourceDiagnostic[] = [];
			// 收集扩展加载错误
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			// 收集扩展命令冲突诊断（与内置命令同名等）
			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			// 收集与内置斜杠命令的冲突诊断
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			// 收集快捷键冲突诊断
			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			// 显示扩展问题诊断
			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			// 显示主题冲突诊断
			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * 使用 TUI 上下文初始化当前会话的扩展系统。
	 *
	 * 作用: 创建扩展 UI 上下文，绑定扩展到会话，设置自动补全、快捷键，并显示已加载资源
	 * 被谁调用: rebindCurrentSession() 中初始化或切换会话时调用
	 * 调用了谁: createExtensionUIContext(), session.bindExtensions(),
	 *   setRegisteredThemes(), setupAutocompleteProvider(), setupExtensionShortcuts(),
	 *   showLoadedResources(), showStartupNoticesIfNeeded()
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		// 创建扩展 UI 上下文，提供 TUI 环境下的对话框、widget、编辑器等能力
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			// 中止处理器：将队列中的消息恢复到编辑器中
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			// 扩展命令可调用的上下文操作
			commandContextActions: {
				// 等待 Agent 空闲
				waitForIdle: () => this.session.agent.waitForIdle(),
				// 创建新会话：停止加载动画，清空状态栏，创建新会话后重新渲染
				newSession: async (options) => {
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();
					try {
						const result = await this.runtimeHost.newSession(options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.ui.requestRender();
						}
						return result;
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				// 从指定对话条目分叉出新会话
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				// 导航到对话树中的指定节点
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					// 重新渲染聊天区域和初始消息
					this.chatContainer.clear();
					this.renderInitialMessages();
					// 如果编辑器为空，设置导航返回的文本
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					// 刷新压缩队列
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				// 切换到另一个会话
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				// 重新加载扩展和资源
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			// 关闭处理器：标记关闭请求，如果不在流式传输中则立即关闭
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			// 错误处理器：显示扩展执行错误
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		// 注册已加载的自定义主题供主题切换使用
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		// 设置自动补全提供者（包含命令、模板、扩展、技能）
		this.setupAutocompleteProvider();

		// 设置扩展注册的快捷键绑定
		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		// 显示已加载的资源列表（静默模式下仅显示诊断信息）
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		// 显示启动通知（变更日志等）
		this.showStartupNoticesIfNeeded();
	}

	/**
	 * 应用从设置管理器读取的运行时配置到 UI 组件。
	 *
	 * 作用: 将用户配置的 HTTP 超时、编辑器内距、自动补全显示数量、光标样式等设置应用到对应的 UI 组件
	 * 被谁调用: rebindCurrentSession() 中初始化或切换会话时调用
	 * 调用了谁: configureHttpDispatcher(), settingsManager 的各种 getter 方法,
	 *   footer 的设置方法, ui 的设置方法, editor 的设置方法
	 */
	private applyRuntimeSettings(): void {
		// 配置 HTTP 连接池的空闲超时时间
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		// 设置底部栏的会话引用和自动压缩状态
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		// 更新底部栏显示的当前工作目录
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		// 应用是否隐藏思维链的设置
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		// 应用硬件光标和窗口缩小清除的设置
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		// 应用编辑器内距和自动补全最大可见数的设置
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		// 如果当前使用的是非默认编辑器，也需要同步应用设置
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	/**
	 * 重新绑定当前会话：取消旧订阅，应用设置，重新初始化扩展和事件监听。
	 *
	 * 作用: 在会话初始化或切换时，完整重建所有会话相关的绑定关系
	 * 被谁调用: init() 在首次初始化时调用; AgentSessionRuntime 在切换会话时调用
	 * 调用了谁: applyRuntimeSettings(), bindCurrentSessionExtensions(),
	 *   subscribeToAgent(), updateAvailableProviderCount(), updateEditorBorderColor(), updateTerminalTitle()
	 */
	private async rebindCurrentSession(): Promise<void> {
		// 取消旧的事件订阅
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		// 应用运行时设置到 UI 组件
		this.applyRuntimeSettings();
		// 初始化扩展系统并显示已加载资源
		await this.bindCurrentSessionExtensions();
		// 订阅 Agent 事件（流式消息、工具调用等）
		this.subscribeToAgent();
		// 更新底部栏的可用提供者数量
		await this.updateAvailableProviderCount();
		// 更新编辑器边框颜色（反映当前连接状态）
		this.updateEditorBorderColor();
		// 更新终端标题栏
		this.updateTerminalTitle();
	}

	/**
	 * 处理致命运行时错误：显示错误信息，停止主题监视器，终止进程。
	 *
	 * 作用: 当关键操作（如创建会话、分叉会话）失败时，显示错误并以非零退出码终止进程
	 * 被谁调用: bindCurrentSessionExtensions() 中的 newSession 和 fork 命令处理
	 * 调用了谁: showError(), stopThemeWatcher(), stop(), process.exit()
	 */
	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		// 停止主题文件监视器
		stopThemeWatcher();
		this.stop();
		// 以非零退出码终止进程
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * 根据工具名称获取已注册的工具定义（用于自定义渲染）。
	 *
	 * 作用：从当前会话中按名称查找工具定义，供渲染器使用自定义方式展示工具输出。
	 * 调用者：内部渲染逻辑（如工具输出的自定义渲染器）。
	 * 调用了：this.session.getToolDefinition() — 从会话工具注册表中查找。
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/**
	 * 设置扩展注册的键盘快捷键。
	 *
	 * 作用：从扩展运行器中获取扩展注册的快捷键列表，并在默认编辑器上注册快捷键处理器。
	 *       当用户按下匹配的快捷键时，会创建一个扩展上下文并异步执行对应的处理器。
	 * 调用者：扩展加载流程中初始化扩展时调用。
	 * 调用了：
	 *   - extensionRunner.getShortcuts() — 获取扩展注册的快捷键列表
	 *   - this.createExtensionUIContext() — 创建扩展 UI 上下文供快捷键处理器使用
	 *   - matchesKey() — 匹配按键事件与快捷键字符串
	 *   - this.restoreQueuedMessagesToEditor() — 中止时恢复队列中的消息到编辑器
	 *   - this.session.compact() — 压缩会话上下文
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		// 根据当前键绑定配置获取扩展注册的快捷键
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// 为快捷键处理器创建扩展上下文
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			signal: this.session.agent.signal,
			// 中止当前操作并恢复队列中的消息到编辑器
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			// 请求关闭应用程序
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			// 压缩会话上下文，支持自定义指令和回调
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// 在默认编辑器上设置扩展快捷键处理器
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			// 遍历所有注册的快捷键，查找匹配的处理器
			for (const [shortcutStr, shortcut] of shortcuts) {
				// 转换为 KeyId — 扩展快捷键使用相同的格式
				if (matchesKey(data, shortcutStr as KeyId)) {
					// 异步运行处理器，不阻塞输入
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * 设置扩展状态文本，显示在底部栏中。
	 *
	 * 作用：通过 key-value 方式管理扩展在底部栏显示的状态文本（如扩展名称、连接状态等）。
	 *       传入 undefined 可清除指定 key 的状态。
	 * 调用者：扩展通过 ExtensionUIContext.setStatus() 调用。
	 * 调用了：this.footerDataProvider.setExtensionStatus() — 更新数据源并触发 UI 刷新。
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	/**
	 * 获取当前工作加载器的显示消息。
	 *
	 * 作用：返回扩展自定义的工作消息，若未设置则返回默认消息。
	 * 调用者：createWorkingLoader()。
	 * 调用了：无（纯数据访问）。
	 */
	private getWorkingLoaderMessage(): string {
		return this.workingMessage ?? this.defaultWorkingMessage;
	}

	/**
	 * 创建工作加载器（加载动画组件）。
	 *
	 * 作用：实例化一个 Loader 组件，用于在会话流式传输期间显示加载动画和消息。
	 * 调用者：setWorkingVisible() — 当需要显示加载动画时。
	 * 调用了：
	 *   - this.getWorkingLoaderMessage() — 获取加载动画的显示文本
	 *   - Loader 构造函数 — 创建加载动画组件
	 */
	private createWorkingLoader(): Loader {
		return new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner), // 使用主题强调色绘制旋转动画
			(text) => theme.fg("muted", text), // 使用主题弱化色绘制消息文本
			this.getWorkingLoaderMessage(),
			this.workingIndicatorOptions,
		);
	}

	/**
	 * 停止工作加载器并清除状态容器。
	 *
	 * 作用：停止加载动画、释放引用并清空状态容器中的所有子组件。
	 * 调用者：setWorkingVisible() — 当需要隐藏加载动画时。
	 * 调用了：this.loadingAnimation.stop() — 停止动画定时器。
	 */
	private stopWorkingLoader(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
	}

	/**
	 * 设置工作加载器的可见性。
	 *
	 * 作用：控制加载动画的显示与隐藏。隐藏时停止动画，显示时在会话正在流式传输
	 *       且动画未运行的情况下创建并启动加载动画。
	 * 调用者：扩展通过 ExtensionUIContext.setWorkingVisible() 调用。
	 * 调用了：
	 *   - this.stopWorkingLoader() — 停止并移除加载动画
	 *   - this.createWorkingLoader() — 创建新的加载动画
	 */
	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.stopWorkingLoader();
			this.ui.requestRender();
			return;
		}
		// 仅在会话正在流式传输且无现有动画时创建新动画
		if (this.session.isStreaming && !this.loadingAnimation) {
			this.statusContainer.clear();
			this.loadingAnimation = this.createWorkingLoader();
			this.statusContainer.addChild(this.loadingAnimation);
		}
		this.ui.requestRender();
	}

	/**
	 * 设置工作加载器的指示器选项。
	 *
	 * 作用：更新加载动画的指示器样式（如进度条类型、Spinner 样式等），
	 *       同时保存选项以便后续重建动画时使用。
	 * 调用者：扩展通过 ExtensionUIContext.setWorkingIndicator() 调用。
	 * 调用了：this.loadingAnimation.setIndicator() — 更新正在运行的动画的指示器。
	 */
	private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.loadingAnimation?.setIndicator(options);
		this.ui.requestRender();
	}

	/**
	 * 设置隐藏思考块的标签文本。
	 *
	 * 作用：更新"隐藏思考"标签的显示文本，并同步更新所有已有的 AssistantMessageComponent
	 *       和当前流式组件中的标签。传入 undefined 则恢复默认标签。
	 * 调用者：扩展通过 ExtensionUIContext.setHiddenThinkingLabel() 调用。
	 * 调用了：
	 *   - AssistantMessageComponent.setHiddenThinkingLabel() — 更新聊天消息中的隐藏思考标签
	 *   - streamingComponent.setHiddenThinkingLabel() — 更新流式组件中的隐藏思考标签
	 */
	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		// 遍历聊天容器中的所有子组件，更新 AssistantMessageComponent 的标签
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		// 同步更新当前流式传输组件的标签
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * 设置扩展 widget（文本行数组或自定义组件）。
	 *
	 * 作用：在编辑器上方或下方放置扩展提供的 widget 内容。支持两种形式：
	 *       1. 字符串数组 — 自动包装为 Text 组件（超过 MAX_WIDGET_LINES 行会被截断）
	 *       2. 工厂函数 — 调用后返回自定义组件
	 *       传入 undefined 则移除指定 key 的 widget。
	 * 调用者：扩展通过 ExtensionUIContext.setWidget() 调用。
	 * 调用了：
	 *   - this.renderWidgets() — 重新渲染所有 widget
	 *   - Component.dispose() — 释放被替换的旧组件
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		// 确定 widget 放置位置，默认为编辑器上方
		const placement = options?.placement ?? "aboveEditor";
		// 移除已有同名 widget 的辅助函数
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		// 从上方和下方 widget 映射中移除已有的同名 widget
		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		// content 为 undefined 表示移除 widget，重新渲染后返回
		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// 将字符串数组包装到容器中，每行一个 Text 组件
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			// 超出最大行数时显示截断提示
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// 工厂函数 — 创建自定义组件
			component = content(this.ui, theme);
		}

		// 根据放置位置选择目标映射并存储
		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	/**
	 * 清除所有扩展 widgets。
	 *
	 * 作用：释放并移除编辑器上方和下方的所有扩展 widget，然后重新渲染。
	 * 调用者：resetExtensionUI() — 重置扩展 UI 状态时。
	 * 调用了：
	 *   - Component.dispose() — 释放每个 widget 的资源
	 *   - this.renderWidgets() — 重新渲染空的 widget 容器
	 */
	private clearExtensionWidgets(): void {
		// 释放上方所有 widget 的资源
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		// 释放下方所有 widget 的资源
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	/**
	 * 重置所有扩展 UI 状态，恢复到默认界面。
	 *
	 * 作用：这是扩展 UI 清理的核心方法。当扩展切换、卸载或重新加载时调用，
	 *       会关闭所有扩展对话框、清除 widgets、恢复默认头部/底部栏、
	 *       重置编辑器组件、清除快捷键绑定、恢复工作加载器和思考标签等。
	 * 调用者：扩展生命周期管理（扩展卸载/重载时）。
	 * 调用了：
	 *   - this.hideExtensionSelector() — 隐藏扩展选择器
	 *   - this.hideExtensionInput() — 隐藏扩展输入框
	 *   - this.hideExtensionEditor() — 隐藏扩展编辑器
	 *   - this.ui.hideOverlay() — 隐藏覆盖层
	 *   - this.clearExtensionTerminalInputListeners() — 清除终端输入监听器
	 *   - this.setExtensionFooter() / setExtensionHeader() — 恢复默认底部栏和头部
	 *   - this.clearExtensionWidgets() — 清除所有 widget
	 *   - this.setCustomEditorComponent(undefined) — 恢复默认编辑器
	 *   - this.setupAutocompleteProvider() — 重置自动补全提供者
	 */
	private resetExtensionUI(): void {
		// 关闭所有扩展对话框
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		// 清除终端输入监听器和底部栏/头部
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		// 清除 widget 和扩展状态
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		// 重置自动补全和编辑器组件
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		// 清除扩展快捷键绑定
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		// 恢复工作加载器到默认状态
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
		}
		// 恢复隐藏思考标签到默认值
		this.setHiddenThinkingLabel();
	}

	// widget 最大总行数，防止视口溢出
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * 渲染所有扩展 widget 到 widget 容器中。
	 *
	 * 作用：分别渲染编辑器上方和下方的 widget 容器，将所有扩展注册的 widget 组件
	 *       添加到对应的 UI 容器中。
	 * 调用者：setExtensionWidget()、clearExtensionWidgets()、resetExtensionUI()。
	 * 调用了：
	 *   - this.renderWidgetContainer() — 渲染单个 widget 容器
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		// 渲染上方容器（空时显示间距，带前导间距）
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		// 渲染下方容器（空时不显示间距，无前导间距）
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	/**
	 * 渲染单个 widget 容器，将 widget 组件添加到 UI 容器中。
	 *
	 * 作用：清空容器后根据是否有 widget 内容决定是否添加间距和组件。
	 * 调用者：renderWidgets()。
	 * 调用了：Container.addChild() — 添加子组件到容器。
	 *
	 * @param container - 目标 UI 容器
	 * @param widgets - widget 映射（key -> 组件）
	 * @param spacerWhenEmpty - 无 widget 时是否添加间距
	 * @param leadingSpacer - 有 widget 时是否在前面添加间距
	 */
	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			// 无 widget 时，根据配置决定是否添加占位间距
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		// 有 widget 时，在前面添加间距以与编辑器分隔
		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		// 将所有 widget 组件添加到容器中
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * 设置自定义底部栏组件，或恢复内置底部栏。
	 *
	 * 作用：允许扩展替换默认底部栏为自定义组件。传入 undefined 恢复内置底部栏。
	 *       释放旧的自定义底部栏资源，移除当前底部栏，再添加新的。
	 * 调用者：扩展通过 ExtensionUIContext.setFooter() 调用。
	 * 调用了：
	 *   - Component.dispose() — 释放旧的自定义底部栏
	 *   - this.ui.removeChild() — 从 UI 中移除当前底部栏
	 *   - this.ui.addChild() — 添加新底部栏
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// 释放已有的自定义底部栏
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// 从 UI 中移除当前底部栏
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// 创建并添加自定义底部栏，传入数据提供者以供底部栏读取状态
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// 恢复内置底部栏
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * 设置自定义头部组件，或恢复内置头部。
	 *
	 * 作用：允许扩展替换默认头部为自定义组件。传入 undefined 恢复内置头部。
	 *       通过替换 headerContainer 中对应位置的子组件来实现。
	 * 调用者：扩展通过 ExtensionUIContext.setHeader() 调用。
	 * 调用了：
	 *   - Component.dispose() — 释放旧的自定义头部
	 *   - isExpandable() — 检查组件是否支持展开/折叠
	 *   - Component.setExpanded() — 设置展开/折叠状态
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// 头部可能在早期初始化阶段尚未初始化
		if (!this.builtInHeader) {
			return;
		}

		// 释放已有的自定义头部
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// 查找当前头部在 headerContainer 中的位置索引
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// 创建并添加自定义头部
			this.customHeader = factory(this.ui, theme);
			// 同步展开/折叠状态
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				// 替换原位置的头部组件
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// 未找到（如 builtInHeader 从未被添加），插入到顶部
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// 恢复内置头部
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	/**
	 * 添加扩展终端输入监听器。
	 *
	 * 作用：注册一个终端输入事件监听器，扩展可以通过此方法拦截和处理用户的终端输入。
	 *       监听器可以消费输入事件（阻止传递给其他处理器）或修改输入数据。
	 *       返回一个取消订阅函数，用于移除该监听器。
	 * 调用者：扩展通过 ExtensionUIContext.onTerminalInput() 调用。
	 * 调用了：this.ui.addInputListener() — 在 TUI 层注册输入监听器。
	 *
	 * @param handler - 输入处理函数，返回 { consume?, data? } 或 undefined
	 * @returns 取消订阅函数
	 */
	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		// 返回取消订阅函数，同时从跟踪集合中移除
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	/**
	 * 清除所有扩展终端输入监听器。
	 *
	 * 作用：取消所有扩展注册的终端输入监听器并清空跟踪集合。
	 * 调用者：resetExtensionUI() — 重置扩展 UI 时。
	 * 调用了：每个 unsubscribe 函数 — 取消对应的输入监听器。
	 */
	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * 创建扩展 UI 上下文（ExtensionUIContext）。
	 *
	 * 作用：构建扩展可访问的 UI API 对象，是扩展与交互式界面之间的核心桥梁。
	 *       返回的上下文提供了一系列方法供扩展操作 UI，包括：
	 *       - 对话框交互：select（选择器）、confirm（确认框）、input（文本输入）
	 *       - 通知与状态：notify（通知）、setStatus（底部状态栏）
	 *       - 工作加载器：setWorkingMessage、setWorkingVisible、setWorkingIndicator
	 *       - Widget 管理：setWidget（编辑器上下方的自定义内容区域）
	 *       - 布局覆盖：setFooter（自定义底部栏）、setHeader（自定义头部）
	 *       - 编辑器操作：setEditorText、getEditorText、pasteToEditor、editor（多行编辑器）
	 *       - 编辑器扩展：setEditorComponent（自定义编辑器组件）、addAutocompleteProvider
	 *       - 主题管理：theme、getAllThemes、getTheme、setTheme
	 *       - 工具输出：getToolsExpanded、setToolsExpanded
	 * 调用者：
	 *   - setupExtensionShortcuts() — 为快捷键处理器创建上下文
	 *   - 扩展运行器 — 在扩展激活和事件处理时使用
	 * 调用了：几乎所有的扩展 UI 相关方法（见下方各委托调用）。
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			// 显示单选选择器对话框
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			// 显示确认对话框（Yes/No）
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			// 显示文本输入对话框
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			// 显示通知消息（info/warning/error）
			notify: (message, type) => this.showExtensionNotify(message, type),
			// 注册终端输入监听器
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			// 设置底部状态栏扩展状态文本
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			// 设置工作加载器的显示消息
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.loadingAnimation) {
					this.loadingAnimation.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			// 控制工作加载器的可见性
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			// 设置工作加载器的指示器样式
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			// 设置隐藏思考块的标签文本
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			// 设置或移除扩展 widget
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			// 设置自定义底部栏
			setFooter: (factory) => this.setExtensionFooter(factory),
			// 设置自定义头部
			setHeader: (factory) => this.setExtensionHeader(factory),
			// 设置终端窗口标题
			setTitle: (title) => this.ui.terminal.setTitle(title),
			// 显示自定义组件（覆盖层或替换编辑器区域）
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			// 模拟粘贴操作，将文本插入编辑器
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			// 设置编辑器文本内容
			setEditorText: (text) => this.editor.setText(text),
			// 获取编辑器文本内容（优先获取展开后的文本）
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			// 打开多行编辑器对话框
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			// 注册自动补全提供者
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			// 设置自定义编辑器组件（替换默认编辑器）
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			// 获取当前编辑器组件工厂
			getEditorComponent: () => this.editorComponentFactory,
			// 获取当前主题实例（只读属性）
			get theme() {
				return theme;
			},
			// 获取所有可用主题及其路径
			getAllThemes: () => getAvailableThemesWithPaths(),
			// 按名称获取主题
			getTheme: (name) => getThemeByName(name),
			// 设置主题（支持主题实例或主题名称）
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					// 直接设置主题实例
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				// 按名称设置主题
				const result = setTheme(themeOrName, true);
				if (result.success) {
					// 持久化到设置管理器
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			// 获取工具输出区域的展开/折叠状态
			getToolsExpanded: () => this.toolOutputExpanded,
			// 设置工具输出区域的展开/折叠状态
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * 显示扩展选择器对话框。
	 *
	 * 作用：创建一个模态选择器，替换编辑器区域显示，让用户从选项列表中选择一项。
	 *       支持 AbortSignal 取消和超时机制。返回 Promise，用户选择后 resolve 选中的值，
	 *       取消或关闭则 resolve undefined。
	 * 调用者：
	 *   - createExtensionUIContext() 中的 select 委托
	 *   - showExtensionConfirm() — 实现确认对话框
	 * 调用了：
	 *   - ExtensionSelectorComponent 构造函数 — 创建选择器组件
	 *   - this.hideExtensionSelector() — 关闭选择器
	 *   - this.toggleToolOutputExpansion() — 切换工具输出展开状态
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			// 如果信号已中止，立即返回
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			// 注册中止回调：关闭选择器并 resolve undefined
			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			// 创建选择器组件，配置选中和取消回调
			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					// 用户选中了某个选项
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					// 用户取消了选择
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			// 将选择器替换到编辑器容器中并获取焦点
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * 隐藏扩展选择器，恢复编辑器。
	 *
	 * 作用：释放选择器组件，将编辑器恢复到编辑器容器中并重新获取焦点。
	 * 调用者：showExtensionSelector() 的回调、resetExtensionUI()。
	 * 调用了：ExtensionSelectorComponent.dispose() — 释放选择器资源。
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * 显示扩展确认对话框（Yes/No）。
	 *
	 * 作用：基于 showExtensionSelector 实现的确认对话框，标题和消息拼接后显示，
	 *       选项为 ["Yes", "No"]。返回 true 表示用户选择 "Yes"。
	 * 调用者：
	 *   - createExtensionUIContext() 中的 confirm 委托
	 *   - promptForMissingSessionCwd() — 提示用户确认会话工作目录丢失
	 * 调用了：this.showExtensionSelector() — 底层选择器实现。
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/**
	 * 提示用户确认会话工作目录丢失的处理方式。
	 *
	 * 作用：当会话的工作目录（cwd）不存在时，显示确认对话框询问是否使用回退目录。
	 * 调用者：会话初始化流程中检测到 MissingSessionCwdError 时。
	 * 调用了：
	 *   - this.showExtensionConfirm() — 显示确认对话框
	 *   - formatMissingSessionCwdPrompt() — 格式化提示消息
	 */
	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * 显示扩展文本输入对话框。
	 *
	 * 作用：创建一个模态文本输入框，替换编辑器区域显示，让用户输入文本。
	 *       支持 AbortSignal 取消和超时机制。返回 Promise，用户提交后 resolve 输入值，
	 *       取消或关闭则 resolve undefined。
	 * 调用者：createExtensionUIContext() 中的 input 委托。
	 * 调用了：
	 *   - ExtensionInputComponent 构造函数 — 创建输入组件
	 *   - this.hideExtensionInput() — 关闭输入框
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			// 如果信号已中止，立即返回
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			// 注册中止回调：关闭输入框并 resolve undefined
			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			// 创建输入组件，配置提交和取消回调
			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					// 用户提交了输入
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					// 用户取消了输入
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			// 将输入框替换到编辑器容器中并获取焦点
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * 隐藏扩展输入框，恢复编辑器。
	 *
	 * 作用：释放输入框组件，将编辑器恢复到编辑器容器中并重新获取焦点。
	 * 调用者：showExtensionInput() 的回调、resetExtensionUI()。
	 * 调用了：ExtensionInputComponent.dispose() — 释放输入框资源。
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * 显示扩展多行编辑器对话框（支持 Ctrl+G 提交）。
	 *
	 * 作用：创建一个多行编辑器组件，替换编辑器区域显示，允许用户输入多行文本。
	 *       支持预填充文本。返回 Promise，用户通过 Ctrl+G 提交后 resolve 编辑器内容，
	 *       取消则 resolve undefined。
	 * 调用者：createExtensionUIContext() 中的 editor 委托。
	 * 调用了：
	 *   - ExtensionEditorComponent 构造函数 — 创建多行编辑器组件
	 *   - this.hideExtensionEditor() — 关闭编辑器
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			// 创建多行编辑器组件，配置提交和取消回调
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					// 用户通过 Ctrl+G 提交了内容
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					// 用户取消了编辑
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			// 将编辑器替换到编辑器容器中并获取焦点
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * 隐藏扩展多行编辑器，恢复默认编辑器。
	 *
	 * 作用：将编辑器容器中的扩展编辑器替换回默认编辑器并重新获取焦点。
	 * 调用者：showExtensionEditor() 的回调、resetExtensionUI()。
	 * 调用了：无。
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * 设置扩展提供的自定义编辑器组件，传入 undefined 恢复默认编辑器。
	 *
	 * 作用：允许扩展替换默认的文本编辑器为自定义编辑器组件。切换时会：
	 *       1. 保存当前编辑器的文本内容
	 *       2. 使用工厂函数创建新编辑器
	 *       3. 迁移回调函数（onSubmit、onChange）
	 *       4. 复制文本和外观设置（边框色、内边距）
	 *       5. 设置自动补全提供者
	 *       6. 通过鸭子类型检测并迁移应用级处理器（Escape、Ctrl+D、粘贴图片、快捷键等）
	 *       传入 undefined 时恢复默认编辑器并保留文本。
	 * 调用者：
	 *   - createExtensionUIContext() 中的 setEditorComponent 委托
	 *   - resetExtensionUI() — 重置扩展 UI 时恢复默认编辑器
	 * 调用了：
	 *   - EditorFactory — 创建自定义编辑器的工厂函数
	 *   - this.setupAutocompleteProvider() — 在 resetExtensionUI 中重置自动补全
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// 切换前保存当前编辑器的文本内容
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// 使用工厂函数创建自定义编辑器，传入 TUI、编辑器主题和键绑定
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// 将默认编辑器的回调绑定到新编辑器
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// 从旧编辑器复制文本内容
			newEditor.setText(currentText);

			// 复制外观设置（如果新编辑器支持）
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// 设置自动补全提供者（如果新编辑器支持）
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// 如果自定义编辑器扩展了 CustomEditor，复制应用级处理器
			// 使用鸭子类型检测，因为 instanceof 在 jiti 模块边界处会失败
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				// 仅在新编辑器未定义处理器时，回退到默认编辑器的处理器
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// 复制动作处理器（清屏、挂起、模型切换等）
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// 恢复默认编辑器，从自定义编辑器复制文本内容
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		// 将编辑器添加到容器并设置焦点
		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * 显示扩展通知消息。
	 *
	 * 作用：根据消息类型显示不同级别的通知。error 使用 showError，
	 *       warning 使用 showWarning，info（默认）使用 showStatus。
	 * 调用者：createExtensionUIContext() 中的 notify 委托。
	 * 调用了：
	 *   - this.showError() — 显示错误消息
	 *   - this.showWarning() — 显示警告消息
	 *   - this.showStatus() — 显示普通状态消息
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/**
	 * 显示扩展自定义组件，支持键盘焦点。覆盖层模式渲染在现有内容之上。
	 *
	 * 作用：允许扩展创建并显示完全自定义的 UI 组件。支持两种显示模式：
	 *       1. 覆盖层模式（overlay=true）— 组件渲染在现有内容之上
	 *       2. 替换模式（overlay=false）— 组件替换编辑器区域
	 *       工厂函数接收 done 回调，扩展在组件内调用 done(result) 来关闭并返回结果。
	 *       返回 Promise，在组件关闭时 resolve 结果。
	 * 调用者：createExtensionUIContext() 中的 custom 委托。
	 * 调用了：
	 *   - 工厂函数（由扩展提供）— 创建自定义组件
	 *   - this.ui.showOverlay() — 显示覆盖层
	 *   - this.ui.hideOverlay() — 隐藏覆盖层
	 */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		// 保存当前编辑器文本，以便关闭时恢复
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		// 恢复编辑器的辅助函数
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			// 关闭组件并返回结果的回调（由扩展调用 done(result) 触发）
			const close = (result: T) => {
				if (closed) return; // 防止重复关闭
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// 注意：上述两个分支都已调用 requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* 忽略 dispose 错误 */
				}
			};

			// 调用工厂函数创建组件（支持同步或异步工厂）
			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// 覆盖层模式：解析覆盖层选项（支持静态对象或动态函数）
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// 回退：使用组件的 width 属性（如果可用）
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// 将覆盖层句柄暴露给调用者，以便控制可见性
						options?.onHandle?.(handle);
					} else {
						// 替换模式：将组件放入编辑器容器中
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * 在聊天容器中显示扩展错误信息。
	 *
	 * 作用：将扩展运行时的错误信息和可选的堆栈跟踪添加到聊天容器中显示。
	 *       错误消息使用错误主题色，堆栈跟踪使用弱化色和缩进显示。
	 * 调用者：扩展运行器在捕获扩展错误时调用。
	 * 调用了：this.chatContainer.addChild() — 将错误文本添加到聊天容器。
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		// 构造错误消息并使用错误主题色添加到聊天容器
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// 使用弱化色显示堆栈跟踪，缩进排列，跳过第一行（与错误消息重复）
			const stackLines = stack
				.split("\n")
				.slice(1) // 跳过第一行（与错误消息重复）
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// 键盘处理器
	// =========================================================================

	/**
	 * 设置键盘快捷键处理器。
	 *
	 * 作用：在 defaultEditor 上注册所有键盘快捷键处理器。处理器设置在 defaultEditor 上，
	 *       但通过 this.editor 访问文本，因此无论哪个编辑器处于活动状态都能正确工作。
	 *       注册的快捷键包括：
	 *       - Escape：中止流式传输 / 中止 bash / 退出 bash 模式 / 双击触发树/分支选择
	 *       - Ctrl+C：清屏 / 中止操作
	 *       - Ctrl+D：退出
	 *       - Ctrl+Z：挂起
	 *       - 思考级别切换、模型切换、工具输出展开/折叠
	 *       - 外部编辑器、跟进消息、出队、新建会话、会话树/分支/恢复
	 *       - Bash 模式检测（!前缀）
	 *       - 剪贴板图片粘贴
	 * 调用者：InteractiveMode 构造函数中初始化时调用。
	 * 调用了：
	 *   - this.restoreQueuedMessagesToEditor() — 中止流式传输并恢复消息
	 *   - this.session.abortBash() — 中止正在运行的 bash 命令
	 *   - this.handleCtrlC() / handleCtrlD() / handleCtrlZ() — 处理 Ctrl+C/D/Z
	 *   - this.cycleThinkingLevel() — 循环切换思考级别
	 *   - this.cycleModel() — 循环切换模型
	 *   - this.showModelSelector() — 显示模型选择器
	 *   - this.toggleToolOutputExpansion() — 切换工具输出展开/折叠
	 *   - this.toggleThinkingBlockVisibility() — 切换思考块可见性
	 *   - this.openExternalEditor() — 打开外部编辑器
	 *   - this.handleFollowUp() / handleDequeue() — 处理跟进/出队
	 *   - this.handleClearCommand() — 处理新建会话
	 *   - this.showTreeSelector() / showUserMessageSelector() / showSessionSelector()
	 *   - this.handleDebugCommand() — 处理调试命令
	 *   - this.handleClipboardImagePaste() — 处理剪贴板图片粘贴
	 */
	private setupKeyHandlers(): void {
		// 在 defaultEditor 上设置处理器 — 它们通过 this.editor 访问文本，
		// 因此无论哪个编辑器处于活动状态都能正确工作
		this.defaultEditor.onEscape = () => {
			if (this.session.isStreaming) {
				// 流式传输中：中止并恢复队列消息到编辑器
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				// bash 正在运行：中止 bash 命令
				this.session.abortBash();
			} else if (this.isBashMode) {
				// bash 模式下：清空编辑器并退出 bash 模式
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// 编辑器为空时，双击 Escape 触发 /tree、/fork 或无操作（取决于设置）
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					// 500ms 内连续按两次 Escape 触发动作
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// 注册应用级动作处理器（通过键绑定配置映射）
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// 全局调试处理器（绑定到 TUI，无论焦点在哪个组件都有效）
		this.ui.onDebug = () => this.handleDebugCommand();
		// 注册更多应用级动作处理器
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		// 编辑器文本变化回调 — 检测是否进入/退出 bash 模式（以 ! 开头）
		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			// 文本以 ! 开头时进入 bash 模式
			this.isBashMode = text.trimStart().startsWith("!");
			// bash 模式状态变化时更新编辑器边框颜色以提供视觉反馈
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// 处理剪贴板图片粘贴（Ctrl+V 触发）
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	/**
	 * 处理剪贴板图片粘贴操作。
	 *
	 * 作用：从系统剪贴板读取图片数据，写入临时文件，然后将文件路径插入编辑器。
	 *       静默忽略剪贴板读取错误（如无权限等情况）。
	 * 调用者：setupKeyHandlers() 中的 onPasteImage 回调（Ctrl+V 触发）。
	 * 调用了：
	 *   - readClipboardImage() — 从系统剪贴板读取图片数据
	 *   - extensionForImageMimeType() — 根据 MIME 类型获取文件扩展名
	 *   - this.editor.insertTextAtCursor() — 将文件路径插入编辑器光标位置
	 */
	private async handleClipboardImagePaste(): Promise<void> {
		try {
			// 从系统剪贴板读取图片
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// 将图片数据写入临时文件
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			// 将临时文件路径直接插入编辑器光标位置
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			// 静默忽略剪贴板错误（可能没有权限等）
		}
	}

	/**
	 * 设置编辑器提交处理器（用户按下回车时触发）。
	 *
	 * 作用：处理用户在编辑器中提交文本的所有逻辑，是交互模式的核心输入处理器。
	 *       处理流程按优先级依次为：
	 *       1. 斜杠命令（/settings、/model、/export、/import、/share、/copy 等）
	 *       2. Bash 命令（! 或 !! 前缀）
	 *       3. 压缩期间的消息队列（扩展命令立即执行，其他消息排队）
	 *       4. 流式传输期间的消息转向（通过 prompt() 的 steering 行为）
	 *       5. 正常消息提交（刷新待处理 bash 组件后提交）
	 * 调用者：InteractiveMode 构造函数中初始化时调用。
	 * 调用了：
	 *   - this.showSettingsSelector() — 显示设置选择器
	 *   - this.showModelsSelector() — 显示作用域模型选择器
	 *   - this.handleModelCommand() — 处理 /model 命令
	 *   - this.handleExportCommand() / handleImportCommand() — 处理导入导出
	 *   - this.handleShareCommand() / handleCopyCommand() — 处理分享/复制
	 *   - this.handleNameCommand() / handleSessionCommand() — 处理会话命名/管理
	 *   - this.handleChangelogCommand() / handleHotkeysCommand() — 处理变更日志/快捷键
	 *   - this.showUserMessageSelector() / showTreeSelector() — 显示分支/树选择器
	 *   - this.handleCloneCommand() — 处理克隆命令
	 *   - this.showAuthSelector() — 显示认证选择器
	 *   - this.handleClearCommand() — 处理新建会话
	 *   - this.handleCompactCommand() — 处理压缩命令
	 *   - this.handleReloadCommand() — 处理重载命令
	 *   - this.handleDebugCommand() — 处理调试命令
	 *   - this.showSessionSelector() — 显示会话选择器
	 *   - this.shutdown() — 关闭应用
	 *   - this.handleBashCommand() — 处理 bash 命令
	 *   - this.session.prompt() — 向会话发送消息（流式传输期间）
	 *   - this.flushPendingBashComponents() — 刷新待处理的 bash 组件
	 */
	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// ========== 斜杠命令处理 ==========
			// 打开设置选择器
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			// 打开作用域模型选择器
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			// 切换或搜索模型（支持可选的搜索词）
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			// 导出会话（支持可选的路径参数）
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			// 导入会话（支持可选的路径参数）
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			// 分享会话
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			// 复制会话内容到剪贴板
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			// 命名当前会话
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			// 管理会话
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			// 显示变更日志
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			// 显示快捷键列表
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			// 从当前消息创建分支
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			// 克隆当前会话
			if (text === "/clone") {
				this.editor.setText("");
				await this.handleCloneCommand();
				return;
			}
			// 显示会话树形视图
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			// 登录
			if (text === "/login") {
				this.showAuthSelector("login");
				this.editor.setText("");
				return;
			}
			// 登出
			if (text === "/logout") {
				this.showAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			// 新建会话（清空当前上下文）
			if (text === "/new") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			// 压缩会话上下文（支持可选的自定义指令）
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			// 重新加载扩展
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			// 显示调试信息
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			// 彩蛋命令
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			// 彩蛋命令
			if (text === "/dementedelves") {
				this.handleDementedDelves();
				this.editor.setText("");
				return;
			}
			// 恢复历史会话
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			// 退出应用
			if (text === "/quit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// ========== Bash 命令处理（! 为普通 bash，!! 排除出上下文） ==========
			if (text.startsWith("!")) {
				// !! 前缀表示命令不包含在上下文中
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					// 如果已有 bash 命令在运行，提示用户先取消
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					// 将命令添加到编辑器历史记录
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					// 退出 bash 模式并恢复编辑器边框颜色
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// ========== 压缩期间的消息处理 ==========
			// 压缩进行中时，扩展命令立即执行，其他消息排队等待
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					// 扩展命令在压缩期间仍可立即执行
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					// 普通消息排入压缩队列，等待压缩完成后处理
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			// ========== 流式传输期间的消息转向 ==========
			// 流式传输中时，通过 prompt() 的 steering 行为处理消息
			// 这会处理扩展命令（立即执行）、提示模板扩展和消息队列
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text, { streamingBehavior: "steer" });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// ========== 正常消息提交 ==========
			// 先将待处理的 bash 组件移动到聊天区域
			this.flushPendingBashComponents();

			// 通过回调函数提交消息给会话
			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
			// 将消息添加到编辑器历史记录
			this.editor.addToHistory?.(text);
		};
	}

	/**
	 * 订阅 agent 会话事件。这是交互模式的核心事件处理入口。
	 *
	 * 作用：将 session 的所有事件（agent 开始/结束、消息流、工具执行、压缩、重试等）
	 * 路由到 handleEvent() 方法进行处理，并更新 TUI 界面。
	 *
	 * 调用者：init()（初始化时注册）
	 * 调用了：session.subscribe()、handleEvent()
	 */
	private subscribeToAgent(): void {
		// 注册事件订阅，将所有 session 事件转发给 handleEvent 处理
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	/**
	 * 处理所有 agent 会话事件。这是事件分发的核心方法。
	 *
	 * 作用：根据事件类型（如 `agent_start`、`message_end`、`tool_execution_*`、
	 * `compaction_*`、`auto_retry_*` 等）执行对应的 UI 更新逻辑，包括渲染消息流、工具执行组件、
	 * 压缩进度、重试倒计时等。
	 *
	 * 调用者：subscribeToAgent()（通过 session.subscribe 回调）
	 * 调用了：init()、addMessageToChat()、updatePendingMessagesDisplay()、updateEditorBorderColor()、
	 * rebuildChatFromMessages()、flushCompactionQueue()、checkShutdownRequested()、showError()、showStatus()、
	 * 以及各种 UI 组件的创建和更新方法
	 *
	 * @param event - 来自 session 的 agent 会话事件
	 */
	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		// 如果 UI 尚未初始化，先执行初始化
		if (!this.isInitialized) {
			await this.init();
		}

		// 每次事件到达时都标记 footer 需要重绘（显示 token 计数等）
		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				// agent 开始新的执行轮次，清理上次遗留的工具组件
				this.pendingTools.clear();
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// 如果重试处理器仍然活跃，恢复主 escape 处理器
				// （重试成功事件稍后触发，但此时需要主处理器）
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				this.stopWorkingLoader();
				if (this.workingVisible) {
					this.loadingAnimation = this.createWorkingLoader();
					this.statusContainer.addChild(this.loadingAnimation);
				}
				this.ui.requestRender();
				break;

			case "queue_update":
				// 队列内容变化，刷新待处理消息显示
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "session_info_changed":
				// 会话信息变化（如名称变更），更新终端标题和 footer
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				// 思考级别变化，更新 footer 和编辑器边框颜色
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "message_start":
				// 新消息开始：根据消息角色分别处理
				if (event.message.role === "custom") {
					// 自定义消息（来自扩展），直接渲染
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					// 用户消息，渲染到聊天区并刷新待处理消息
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					// 助手消息，创建流式渲染组件用于增量更新
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				// 助手消息增量更新（流式输出过程中的每次更新）
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					// 更新流式组件的渲染内容
					this.streamingComponent.updateContent(this.streamingMessage);

					// 遍历消息内容中的工具调用，为新的工具调用创建 UI 组件
					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								// 首次出现的工具调用，创建新的 ToolExecutionComponent
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
										imageWidthCells: this.settingsManager.getImageWidthCells(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								// 已存在的工具调用，更新参数（流式接收参数时可能多次更新）
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				// 助手消息结束事件：完成流式渲染，处理中止/错误状态
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					// 检查是否被中止，生成相应的错误消息
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					// 最后一次更新流式组件内容
					this.streamingComponent.updateContent(this.streamingMessage);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						// 中止或错误：将所有待处理的工具调用标记为错误
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						// 正常结束：标记所有工具参数接收完成，触发 diff 计算（用于编辑工具）
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					// 清理流式渲染状态
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				// 工具执行开始：查找或创建工具执行 UI 组件
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					// 组件不存在时创建新组件（可能由 message_update 阶段已创建）
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
							imageWidthCells: this.settingsManager.getImageWidthCells(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				// 标记工具开始执行（显示加载动画）
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				// 工具执行进度更新：展示部分结果（如命令输出流）
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				// 工具执行完成：更新最终结果并从待处理列表中移除
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				// agent 执行结束：清理所有临时状态
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				// 停止并移除加载动画
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				// 移除未完成的流式组件（如果消息正常结束则已被置为 undefined）
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "compaction_start": {
				// 上下文压缩开始：显示加载动画，将 escape 绑定为取消压缩
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// 保持编辑器可用，用户提交的消息会在压缩期间排队
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.statusContainer.clear();
				// 根据压缩原因显示不同的提示文本
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context... ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
				// 创建加载动画组件
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					label,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				// 上下文压缩结束：恢复 UI 状态，处理结果
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				// 恢复原始的 escape 处理器
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				// 停止并移除加载动画
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				if (event.aborted) {
					// 压缩被取消
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					// 压缩成功：清空聊天区，从消息重建界面，并显示压缩摘要
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					this.footer.invalidate();
				} else if (event.errorMessage) {
					// 压缩失败：根据原因显示错误或内联错误消息
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				// 将压缩期间排队的消息发送出去
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// 自动重试开始：绑定 escape 为取消重试
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				// 显示重试指示器（带倒计时）
				this.statusContainer.clear();
				this.retryCountdown?.dispose();
				// 构造重试状态消息
				const retryMessage = (seconds: number) =>
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
				// 创建带警告色的加载动画
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					retryMessage(Math.ceil(event.delayMs / 1000)),
				);
				// 创建倒计时定时器，每秒更新重试消息
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.ui,
					(seconds) => {
						// 每秒回调：更新加载动画显示的剩余秒数
						this.retryLoader?.setMessage(retryMessage(seconds));
					},
					() => {
						// 倒计时完成回调：清理引用
						this.retryCountdown = undefined;
					},
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// 自动重试结束：恢复 escape 处理器
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				// 停止并移除重试加载动画
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// 仅在最终失败时显示错误（成功时会显示正常响应）
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}
		}
	}

	/**
	 * 从用户消息中提取纯文本内容。
	 *
	 * 作用：将消息内容（可能是字符串或内容块数组）转换为纯文本字符串，
	 * 仅保留文本类型的内容块。
	 *
	 * 调用者：addMessageToChat()（渲染用户消息时提取文本）
	 * 调用了：无
	 *
	 * @param message - 消息对象
	 * @returns 提取的纯文本字符串，非用户消息返回空字符串
	 */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		// 处理两种消息格式：纯字符串和内容块数组
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * 在聊天界面显示状态消息。
	 *
	 * 作用：显示临时状态信息（如模型切换、操作提示等）。如果连续显示多条状态消息
	 * （中间没有其他内容插入），会就地更新上一条状态消息，避免刷屏。
	 *
	 * 调用者：handleEvent()、handleDequeue()、cycleThinkingLevel()、cycleModel()、
	 * showModelSelector()、showSettingsSelector()、各种命令处理方法等
	 * 调用了：theme.fg()、ui.requestRender()
	 *
	 * @param message - 要显示的状态消息文本
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		// 如果上两条子元素就是上次显示的状态消息（spacer + text），就地更新文本
		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		// 否则添加新的 spacer 和文本组件
		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	/**
	 * 将消息添加到聊天界面。根据消息角色创建对应的 UI 组件。
	 *
	 * 作用：将不同类型的消息（bash 执行、自定义、压缩摘要、分支摘要、用户、助手、工具结果）
	 * 渲染为对应的 UI 组件并添加到聊天容器中。
	 *
	 * 调用者：handleEvent()（message_start 事件）、renderSessionContext()、
	 * handleCompactionEnd()（显示压缩摘要）
	 * 调用了：getUserMessageText()、parseSkillBlock()、各种消息组件构造函数
	 *
	 * @param message - 要添加的消息对象
	 * @param options.populateHistory - 是否将用户消息添加到编辑器历史记录
	 */
	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				// Bash 命令执行消息：创建命令执行组件并显示输出
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				// 标记执行完成，包括退出码、取消状态和截断信息
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				// 自定义消息（来自扩展）：仅在需要显示时渲染
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				// 上下文压缩摘要消息
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				// 分支摘要消息（导航到其他分支时显示）
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				// 用户消息：提取文本并渲染
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					// 如果聊天区已有内容，先添加空行分隔
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					// 检查是否包含技能块（如 /skill 调用）
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// 渲染技能块（可折叠）
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// 如果技能块中包含用户消息，单独渲染
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						// 普通用户消息
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					// 根据选项决定是否将消息添加到编辑器输入历史
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				// 助手消息：创建助手消息组件（非流式，用于重建历史）
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// 工具结果：在工具调用组件内联渲染，不单独处理
				break;
			}
			default: {
				// 穷举检查：确保所有消息类型都被处理
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * 将会话上下文渲染到聊天界面。用于初始加载和压缩后重建。
	 *
	 * 作用：遍历会话中的所有消息，为助手消息的工具调用创建对应的 UI 组件，
	 * 并将工具结果匹配到对应的工具组件。支持更新 footer 状态和编辑器历史记录。
	 *
	 * 调用者：renderInitialMessages()、rebuildChatFromMessages()
	 * 调用了：addMessageToChat()、footer.invalidate()、updateEditorBorderColor()、
	 * ToolExecutionComponent 构造函数
	 *
	 * @param sessionContext - 会话上下文，包含消息列表
	 * @param options.updateFooter - 是否更新 footer 状态
	 * @param options.populateHistory - 是否将用户消息添加到编辑器历史
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		// 清理待处理的工具组件映射
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		// 根据选项更新 footer 和编辑器边框颜色
		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			if (message.role === "assistant") {
				// 助手消息需要特殊处理：先渲染消息文本，再渲染工具调用组件
				this.addMessageToChat(message);
				for (const content of message.content) {
					if (content.type === "toolCall") {
						// 为每个工具调用创建执行组件
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							// 如果消息因中止或错误结束，将工具调用标记为错误状态
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							// 正常结束，记录为待匹配工具（等待后续 toolResult 消息）
							renderedPendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// 工具结果消息：匹配到之前创建的工具组件并更新结果
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// 其他消息类型使用标准渲染
				this.addMessageToChat(message, options);
			}
		}

		// 将未匹配到结果的工具组件保留在待处理列表中
		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	/**
	 * 渲染初始消息。在 TUI 启动或会话切换后调用。
	 *
	 * 作用：从会话管理器获取上下文并渲染到聊天区，同时更新 footer 和编辑器历史。
	 * 如果会话曾被压缩过，还会显示压缩次数提示。
	 *
	 * 调用者：init()、handleResumeSession()、handleClearCommand()、showTreeSelector()、
	 * renderCurrentSessionState()
	 * 调用了：sessionManager.buildSessionContext()、renderSessionContext()、showStatus()
	 */
	renderInitialMessages(): void {
		// 获取对齐的消息和会话条目
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});

		// 如果会话曾被压缩过，显示压缩次数提示
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	/**
	 * 获取用户输入。返回一个 Promise，在用户通过编辑器提交文本时解析。
	 *
	 * 作用：等待用户在编辑器中输入文本并按提交键，返回输入的文本内容。
	 * 用于需要阻塞等待用户输入的场景（如扩展的输入对话框）。
	 *
	 * 调用者：扩展命令处理器
	 * 调用了：无（设置 onInputCallback 回调）
	 */
	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			// 设置输入回调，在用户提交时触发解析
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	/**
	 * 从会话消息重建聊天界面。用于压缩完成后或需要完全重绘时。
	 *
	 * 作用：清空聊天容器，然后根据当前会话消息重新渲染所有内容。
	 *
	 * 调用者：handleEvent()（compaction_end 事件）、toggleThinkingBlockVisibility()、
	 * handleReloadCommand()、handleClearCommand()
	 * 调用了：sessionManager.buildSessionContext()、renderSessionContext()
	 */
	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// 键盘处理器
	// =========================================================================

	/**
	 * 处理 Ctrl+C 快捷键。
	 *
	 * 作用：双击快速按下时执行关闭操作（shutdown），单次按下时清除编辑器内容。
	 * 使用 500 毫秒的时间窗口判断是否为双击。
	 *
	 * 调用者：setupKeyHandlers()（通过 onAction("app.clear") 绑定）
	 * 调用了：shutdown()、clearEditor()
	 */
	private handleCtrlC(): void {
		const now = Date.now();
		// 500ms 内连续按两次则执行关闭
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			// 单次按下清除编辑器内容
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	/**
	 * 处理 Ctrl+D 快捷键。仅在编辑器为空时触发（由 CustomEditor 保证）。
	 *
	 * 作用：当编辑器为空时按下 Ctrl+D，执行关闭操作。
	 *
	 * 调用者：setupKeyHandlers()（通过 onCtrlD 绑定）
	 * 调用了：shutdown()
	 */
	private handleCtrlD(): void {
		// 仅在编辑器为空时调用（由 CustomEditor 保证）
		void this.shutdown();
	}

	/**
	 * 优雅关闭 agent。在关闭前停止 TUI 以防止扩展 UI 清理在进程退出时重绘最后一帧。
	 *
	 * 作用：注销信号处理器、等待终端输入排空、停止 TUI、释放运行时宿主、退出进程。
	 *
	 * 调用者：handleCtrlC()、handleCtrlD()、showSessionSelector()（关闭按钮）、
	 * handleEvent()（agent_end 中检查 shutdownRequested）
	 * 调用了：unregisterSignalHandlers()、ui.terminal.drainInput()、stop()、runtimeHost.dispose()、process.exit()
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		// 防止重复调用
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();

		// 排空 Kitty 键盘释放事件，防止转义序列泄漏到父 shell（慢速 SSH 场景）
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();
		process.exit(0);
	}

	/**
	 * 紧急终端退出。当终端已断开（如 SSH 连接丢失）时调用。
	 *
	 * 作用：终端已消失时不能执行正常的关闭流程（因为 TUI 恢复序列会触发 EIO 错误），
	 * 直接杀死子进程并退出。
	 *
	 * 调用者：registerSignalHandlers()（SIGHUP 信号、终端错误处理器）
	 * 调用了：unregisterSignalHandlers()、killTrackedDetachedChildren()、process.exit()
	 */
	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// 终端已消失，不执行正常关闭流程，因为 TUI 和扩展清理可能会写入恢复序列并再次触发 EIO
		process.exit(129);
	}

	/**
	 * 未捕获异常的最终处理程序。确保终端在异常退出时恢复到正常状态。
	 *
	 * 作用：TUI 将 stdin 设为 raw 模式并隐藏光标；如果不处理未捕获异常，
	 * 进程退出后终端会处于 raw 模式且无光标，需要手动执行 `stty sane && reset` 恢复。
	 * 与 emergencyTerminalExit 不同，此处终端仍然存活，所以调用 ui.stop() 恢复正常模式。
	 *
	 * 调用者：registerSignalHandlers()（注册为 uncaughtException 监听器）
	 * 调用了：unregisterSignalHandlers()、killTrackedDetachedChildren()、ui.stop()、process.exit()
	 *
	 * @param error - 未捕获的异常对象
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			// 恢复终端到正常模式（cooked 模式、显示光标、禁用特殊序列）
			this.ui.stop();
		} catch {}
		console.error("pi exiting due to uncaughtException:");
		console.error(error);
		process.exit(1);
	}

	/**
	 * 检查是否请求了关闭，如果是则执行关闭操作。
	 *
	 * 作用：在 agent 执行结束后检查是否有待处理的关闭请求（如用户在 agent 运行时按了退出）。
	 *
	 * 调用者：handleEvent()（agent_end 事件处理中）
	 * 调用了：shutdown()
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	/**
	 * 注册进程信号处理器和终端错误处理器。
	 *
	 * 作用：处理 SIGTERM、SIGHUP 信号，监听 stdout/stderr 的终端错误，
	 * 以及注册未捕获异常处理程序，确保终端在各种异常情况下能正确恢复。
	 *
	 * 调用者：init()（初始化时注册）
	 * 调用了：emergencyTerminalExit()、uncaughtCrash()、killTrackedDetachedChildren()、shutdown()
	 */
	private registerSignalHandlers(): void {
		// 先注销已有的处理器，防止重复注册
		this.unregisterSignalHandlers();

		// 注册进程信号处理器
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				if (signal === "SIGHUP") {
					// 终端挂起（如 SSH 断开），执行紧急退出
					this.emergencyTerminalExit();
				}
				killTrackedDetachedChildren();
				void this.shutdown();
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		// 注册终端 I/O 错误处理器（如 EIO 错误表示终端已断开）
		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// 注册未捕获异常处理程序：防止终端留在 raw 模式且无光标状态
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	/**
	 * 注销所有已注册的信号处理器和终端错误处理器。
	 *
	 * 作用：执行所有清理函数并重置列表，防止处理器泄漏。
	 *
	 * 调用者：shutdown()、emergencyTerminalExit()、uncaughtCrash()、registerSignalHandlers()、stop()
	 * 调用了：无
	 */
	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	/**
	 * 处理 Ctrl+Z 快捷键，将进程挂起到后台。
	 *
	 * 作用：停止 TUI、发送 SIGTSTP 信号挂起进程组。收到 SIGCONT 信号后恢复 TUI。
	 * Windows 不支持此操作。
	 *
	 * 调用者：setupKeyHandlers()（通过 onAction("app.suspend") 绑定）
	 * 调用了：showStatus()、ui.stop()、ui.start()、ui.requestRender()
	 */
	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// 创建一个长时间间隔的定时器，防止事件循环在挂起期间退出
		// 如果没有引用的句柄，停止 TUI 后 Node 会在 fg 操作前退出
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// 挂起期间忽略 SIGINT，防止后台进程被 Ctrl+C 杀死
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// 注册 SIGCONT 处理器，恢复时重建 TUI
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// 停止 TUI，恢复终端到正常模式
			this.ui.stop();

			// 发送 SIGTSTP 到进程组（pid=0 表示组内所有进程）
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	/**
	 * 处理 Alt+Enter 快捷键，发送排队消息（追加式消息）。
	 *
	 * 作用：在 agent 流式输出时，用户可以通过 Alt+Enter 排队一条追加消息。
	 * 如果 agent 不在运行，则等同于普通 Enter（触发提交）。扩展命令会立即执行。
	 *
	 * 调用者：setupKeyHandlers()（通过 onAction("app.message.followUp") 绑定）
	 * 调用了：isExtensionCommand()、queueCompactionMessage()、session.prompt()、
	 * updatePendingMessagesDisplay()、editor.onSubmit()
	 */
	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// 压缩期间：扩展命令立即执行，普通消息排入压缩队列
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// 流式输出时：Alt+Enter 排队为追加消息（等待 agent 完成后发送）
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// 非流式时：Alt+Enter 等同于普通 Enter
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	/**
	 * 处理恢复排队消息的快捷键（dequeue）。
	 *
	 * 作用：将所有排队的消息（steering 和 follow-up）恢复到编辑器中，供用户编辑后再提交。
	 * 如果没有排队消息，显示提示。
	 *
	 * 调用者：setupKeyHandlers()（通过 onAction("app.message.dequeue") 绑定）
	 * 调用了：restoreQueuedMessagesToEditor()、showStatus()
	 */
	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	/**
	 * 更新编辑器边框颜色，反映当前模式或思考级别。
	 *
	 * 作用：bash 模式下使用 bash 模式专用边框颜色，否则根据思考级别设置边框颜色。
	 *
	 * 调用者：handleEvent()（thinking_level_changed）、setupKeyHandlers()、
	 * cycleThinkingLevel()、cycleModel()、showSettingsSelector()、showModelSelector() 等
	 * 调用了：theme.getBashModeBorderColor()、theme.getThinkingBorderColor()、ui.requestRender()
	 */
	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	/**
	 * 循环切换思考级别（off -> low -> medium -> high -> off）。
	 *
	 * 作用：调用 session 的 cycleThinkingLevel 方法切换级别，更新 footer 和编辑器边框颜色。
	 * 如果当前模型不支持思考，显示提示。
	 *
	 * 调用者：setupKeyHandlers()（通过 onAction("app.thinking.cycle") 绑定）
	 * 调用了：session.cycleThinkingLevel()、footer.invalidate()、updateEditorBorderColor()、showStatus()
	 */
	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async openExternalEditor(): Promise<void> {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after ui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			// On successful exit (status 0), replace editor content
			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(release: LatestPiRelease): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
		const changelogUrl = "https://pi.dev/changelog";
		const changelogLink = getCapabilities().hyperlinks
			? hyperlink(theme.fg("accent", "open changelog"), changelogUrl)
			: theme.fg("accent", changelogUrl);
		const changelogLine = theme.fg("muted", "Changelog: ") + changelogLink;
		const note = release.note?.trim();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`, 1, 0),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					color: (text) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new Text(changelogLine, 1, 0));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					showImages: this.settingsManager.getShowImages(),
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					thinkingLevel: this.session.thinkingLevel,
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					currentTheme: this.settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					warnings: this.settingsManager.getWarnings(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onImageWidthCellsChange: (width) => {
						this.settingsManager.setImageWidthCells(width);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setImageWidthCells(width);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						configureHttpDispatcher(timeoutMs);
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onEnableInstallTelemetryChange: (enabled) => {
						this.settingsManager.setEnableInstallTelemetry(enabled);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onWarningsChange: (warnings) => {
						this.settingsManager.setWarnings(warnings);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		void model;
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
						void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		let currentEnabledIds: string[] | null = null;

		if (hasSessionScope) {
			// Use current session's scoped models
			currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			}
		}

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: string[] | null) => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
				const newScopedModels = await resolveModelScope(enabledIds, this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
				},
				{
					onChange: async (enabledIds) => {
						await updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds === null || enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							done();
							this.ui.requestRender();
							return;
						}

						this.renderCurrentSessionState();
						this.editor.setText(result.selectedText ?? "");
						done();
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			this.renderCurrentSessionState();
			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
			});
			if (result.cancelled) {
				return result;
			}
			this.renderCurrentSessionState();
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
				});
				if (result.cancelled) {
					return result;
				}
				this.renderCurrentSessionState();
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private getLoginProviderOptions(authType?: "api_key"): AuthSelectorProvider[] {
		const options: AuthSelectorProvider[] = [];

		const modelProviders = new Set(this.session.modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (!isApiKeyLoginProvider(providerId, new Set())) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const options: AuthSelectorProvider[] = [];

		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: credential.type,
			});
		}

		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private showLoginAuthTypeSelector(): void {
		this.showLoginProviderSelector("api_key");
	}

	private showLoginProviderSelector(authType: "api_key"): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			this.showStatus("No API key providers available.");
			return;
		}

		this.showSelector((done) => {
			const selector = new AuthSelectorComponent(
				"login",
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
				},
				() => {
					done();
					this.showLoginAuthTypeSelector();
				},
				(providerId) => this.session.modelRegistry.getProviderAuthStatus(providerId),
			);
			return { component: selector, focus: selector };
		});
	}

	private async showAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "login") {
			this.showLoginProviderSelector("api_key");
			return;
		}

		const providerOptions = this.getLogoutProviderOptions();
		if (providerOptions.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new AuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						this.session.modelRegistry.authStorage.logout(providerOption.id);
						this.session.modelRegistry.refresh();
						await this.updateAvailableProviderCount();
						const message = `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.showStatus(message);
					} catch (error: unknown) {
						this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		_authType: "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		this.session.modelRegistry.refresh();

		const actionLabel = `Saved API key for ${providerName}`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.session.modelRegistry.getAvailable();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (!hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await this.session.setModel(selectedModel);
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		await this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
		if (selectedModel) {
			this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.checkDaxnutsEasterEgg(selectedModel);
		} else {
			this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			if (selectionError) {
				this.showError(selectionError);
			} else {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });

			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes..."), 1, 0),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.rebuildChatFromMessages();
			dismissReloadBox(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
		} catch (error) {
			dismissReloadBox(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
			}
			this.statusContainer.clear();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			this.renderCurrentSessionState();
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				this.renderCurrentSessionState();
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.session.setSessionName(name);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => e.content)
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				const keyDisplay = formatKeyText(key, { capitalize: true });
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleClearCommand(): Promise<void> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.renderCurrentSessionState();
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		void model;
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(): void {
		this.unregisterSignalHandlers();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
