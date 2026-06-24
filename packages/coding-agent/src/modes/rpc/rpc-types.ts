/**
 * @file RPC 协议的类型定义文件。
 *
 * @module rpc/rpc-types
 *
 * @description
 * **文件定位**：RPC 模式的类型契约层，定义客户端与服务端之间通信的所有数据结构。
 *
 * **在调用链中的位置**：
 * - 本文件是纯类型定义文件，不包含运行时代码，不被直接执行。
 * - 被 `rpc-mode.ts` 和 `rpc-client.ts` 同时引用，确保两端的协议一致性。
 *
 * **提供的能力**：
 * - `RpcCommand`：stdin 命令的联合类型，定义客户端可发送的所有命令及其参数。
 * - `RpcResponse`：stdout 响应的联合类型，定义服务端可返回的所有响应及其数据。
 * - `RpcSessionState`：会话状态的快照类型。
 * - `RpcSlashCommand`：可通过 prompt 调用的可用命令描述。
 * - `RpcExtensionUIRequest` / `RpcExtensionUIResponse`：扩展 UI 交互的请求/响应类型。
 *
 * **与其他文件的关系**：
 * - `rpc-mode.ts` 导入本文件的类型用于解析命令、构造响应。
 * - `rpc-client.ts` 导入本文件的类型用于构造命令、解析响应。
 * - 依赖 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai` 的核心类型。
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SourceInfo } from "../../core/source-info.ts";

// ============================================================================
// RPC 命令（通过 stdin 发送）
// ============================================================================

/**
 * RPC 命令的联合类型。表示客户端可以通过 stdin 发送给 agent 的所有命令。
 *
 * 每个命令变体都包含：
 * - `id`（可选）：用于将响应与请求关联的标识符。
 * - `type`：命令类型字面量，用于区分不同的命令。
 * - 其他命令特定的参数字段。
 *
 * 按功能分类：
 * - 提示类（prompting）：`prompt`、`steer`、`follow_up`、`abort`、`new_session`
 * - 状态类（state）：`get_state`
 * - 模型类（model）：`set_model`、`cycle_model`、`get_available_models`
 * - 思考类（thinking）：`set_thinking_level`、`cycle_thinking_level`
 * - 队列模式类（queue modes）：`set_steering_mode`、`set_follow_up_mode`
 * - 压缩类（compaction）：`compact`、`set_auto_compaction`
 * - 重试类（retry）：`set_auto_retry`、`abort_retry`
 * - Bash 类：`bash`、`abort_bash`
 * - 会话类（session）：`get_session_stats`、`export_html`、`switch_session`、`fork`、`clone` 等
 * - 消息类（messages）：`get_messages`
 * - 命令类（commands）：`get_commands`
 */
export type RpcCommand =
	// 提示类命令
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// 状态查询命令
	| { id?: string; type: "get_state" }

	// 模型管理命令
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// 思考级别命令
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// 队列模式命令
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// 上下文压缩命令
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// 重试控制命令
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash 命令执行
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// 会话管理命令
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// 消息查询命令
	| { id?: string; type: "get_messages" }

	// 可用命令查询（可通过 prompt 调用的扩展命令、模板、技能）
	| { id?: string; type: "get_commands" };

// ============================================================================
// RPC 可用命令（用于 get_commands 响应）
// ============================================================================

/**
 * 可通过 prompt 调用的命令描述。
 *
 * 表示 agent 中可用的斜杠命令，包括扩展注册的命令、prompt 模板和技能。
 *
 * **调用关系**：
 * - 在 `rpc-mode.ts` 的 `get_commands` 命令处理中构造。
 * - 在 `rpc-client.ts` 的 `getCommands()` 方法返回值中使用。
 */
export interface RpcSlashCommand {
	/** 命令名称（不带前导斜杠） */
	name: string;
	/** 人类可读的命令描述 */
	description?: string;
	/** 命令来源类型：扩展注册的命令、prompt 模板、或技能 */
	source: "extension" | "prompt" | "skill";
	/** 来源资源的元数据信息 */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC 会话状态
// ============================================================================

/**
 * RPC 会话状态的快照。通过 `get_state` 命令获取。
 *
 * 包含当前会话的模型、思考级别、流式状态、会话标识等核心信息。
 *
 * **调用关系**：
 * - 在 `rpc-mode.ts` 的 `get_state` 命令处理中从 session 对象构造。
 * - 在 `rpc-client.ts` 的 `getState()` 方法返回值中使用。
 */
export interface RpcSessionState {
	/** 当前使用的模型（包含 provider 和 id） */
	model?: Model<any>;
	/** 当前思考级别 */
	thinkingLevel: ThinkingLevel;
	/** 是否正在流式输出 */
	isStreaming: boolean;
	/** 是否正在执行上下文压缩 */
	isCompacting: boolean;
	/** 引导模式：全部消息同时处理或逐条处理 */
	steeringMode: "all" | "one-at-a-time";
	/** 后续消息模式：全部消息同时处理或逐条处理 */
	followUpMode: "all" | "one-at-a-time";
	/** 会话文件路径 */
	sessionFile?: string;
	/** 会话唯一标识符 */
	sessionId: string;
	/** 会话显示名称 */
	sessionName?: string;
	/** 自动压缩是否已启用 */
	autoCompactionEnabled: boolean;
	/** 已确认的消息数量 */
	messageCount: number;
	/** 待处理的消息数量 */
	pendingMessageCount: number;
}

// ============================================================================
// RPC 响应（通过 stdout 输出）
// ============================================================================

/**
 * RPC 响应的联合类型。表示服务端可以返回给客户端的所有响应。
 *
 * 每个响应都包含：
 * - `id`（可选）：与请求命令的 id 对应，用于关联请求和响应。
 * - `type`：固定为 `"response"`。
 * - `command`：对应的命令类型，用于区分不同命令的响应。
 * - `success`：操作是否成功。成功时包含 `data` 字段，失败时包含 `error` 字段。
 *
 * 成功响应的 `data` 结构因命令类型而异。失败响应统一使用 `error` 字段携带错误信息。
 *
 * **调用关系**：
 * - 在 `rpc-mode.ts` 的 `handleCommand()` 函数中通过 `success()` / `error()` 辅助函数构造。
 * - 在 `rpc-client.ts` 的 `handleLine()` 方法中解析，并通过 `getData()` 提取 data 字段。
 */
// 成功响应（含数据）
export type RpcResponse =
	// 提示类（异步 - 后续会有事件流）
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// 状态查询响应
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// 模型管理响应
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// 思考级别响应
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// 队列模式响应
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// 上下文压缩响应
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// 重试控制响应
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash 命令响应
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// 会话管理响应
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// 消息查询响应
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// 可用命令查询响应
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// 错误响应（任何命令都可能失败）
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// 扩展 UI 事件（通过 stdout 输出）
// ============================================================================

/**
 * 扩展 UI 请求。当扩展需要用户输入时通过 stdout 发出。
 *
 * RPC 模式下，扩展无法直接访问终端 UI，因此通过此类型将 UI 交互请求
 * 发送给客户端，由客户端负责渲染和响应。
 *
 * 支持的请求方法：
 * - `select`：单选列表
 * - `confirm`：确认对话框
 * - `input`：文本输入
 * - `editor`：编辑器打开请求
 * - `notify`：通知消息
 * - `setStatus`：设置状态栏文本
 * - `setWidget`：设置小部件内容
 * - `setTitle`：设置终端标题
 * - `set_editor_text`：设置编辑器文本
 *
 * **调用关系**：
 * - 在 `rpc-mode.ts` 的 `createExtensionUIContext()` 中通过 `output()` 发出。
 * - 在 `rpc-client.ts` 中作为事件被监听和处理。
 */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// 扩展 UI 命令（通过 stdin 发送）
// ============================================================================

/**
 * 扩展 UI 请求的响应。客户端通过 stdin 将用户操作结果发回给 agent。
 *
 * 响应变体：
 * - `{ value: string }`：用户输入的文本值（用于 select、input、editor）。
 * - `{ confirmed: boolean }`：用户是否确认（用于 confirm）。
 * - `{ cancelled: true }`：用户取消了操作。
 *
 * **调用关系**：
 * - 在 `rpc-mode.ts` 的 `handleInputLine()` 中解析，并通过 `pendingExtensionRequests` 匹配对应的请求。
 * - 在 `rpc-client.ts` 中由用户代码构造并通过 stdin 发送。
 */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// 辅助类型：提取命令类型字面量
// ============================================================================

/**
 * 从 `RpcCommand` 联合类型中提取所有 `type` 字段的字面量类型。
 *
 * 等价于 `"prompt" | "steer" | "follow_up" | "abort" | ... | "get_commands"`。
 * 可用于类型守卫或 switch 语句的穷尽检查。
 */
export type RpcCommandType = RpcCommand["type"];
