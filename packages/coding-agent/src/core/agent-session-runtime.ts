/**
 * agent-session-runtime.ts - 会话运行时生命周期管理
 *
 * 作用：管理 AgentSession 及其运行时服务的完整生命周期，包括会话的创建、切换、
 *       分支（fork）、导入和销毁。是连接 CLI/TUI 层和 core 层的核心桥梁。
 *
 * 定位：core 层的运行时管理器，持有当前 AgentSession 和 cwd 绑定的服务集合，
 *       并通过工厂函数在 cwd 变化时重建整个运行时。
 *
 * 提供的能力：
 * - AgentSessionRuntime 类：运行时容器，封装会话和服务的生命周期操作
 * - createAgentSessionRuntime()：创建初始运行时的工厂函数
 * - switchSession()：切换到已有会话
 * - newSession()：创建新会话
 * - fork()：从指定条目分叉新会话
 * - importFromJsonl()：从 JSONL 文件导入会话
 * - dispose()：销毁运行时并释放资源
 *
 * 调用关系：
 * - 被 CLI/TUI 的入口代码创建并持有
 * - 内部调用 agent-session-services.ts 创建 cwd 绑定的服务
 * - 内部调用 sdk.ts 的 createAgentSession() 创建 AgentSession
 * - 通过 CreateAgentSessionRuntimeFactory 工厂函数在会话切换时重建运行时
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type { ReplacedSessionContext, SessionShutdownEvent, SessionStartEvent } from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";

/**
 * 运行时创建返回的结果。
 *
 * 调用方获得创建的会话、cwd 绑定的服务以及设置过程中收集的所有诊断信息。
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * 为目标 cwd 和会话管理器创建完整运行时的工厂函数类型。
 *
 * 工厂函数捕获进程级的固定输入，为有效 cwd 重建 cwd 绑定的服务，
 * 基于这些服务解析会话选项，最终创建 AgentSession。
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * 当 /import 引用的 JSONL 文件路径不存在时抛出。
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

/**
 * 从用户消息内容中抽取纯文本。
 *
 * 定位：`fork()` 逻辑的本地辅助函数。
 * 作用：把字符串或多段内容数组统一压平成可回填到编辑器的文本。
 * 调用关系：仅被本文件中的 `fork()` 在“before”分叉场景下调用。
 */
function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * 持有当前 AgentSession 及其 cwd 绑定的服务。
 *
 * 会话替换方法会先销毁当前运行时，然后创建并应用下一个运行时。
 * 如果创建失败，错误会传播给调用方。调用方负责面向用户的错误处理。
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * 设置在 session_shutdown 处理器完成后、当前会话失效前运行的同步回调。
	 *
	 * 用于宿主拥有的 UI 拆卸操作（不能让出事件循环），
	 * 如在旧扩展上下文失效前分离扩展提供的 TUI 组件。
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	/**
	 * 在会话切换前向扩展系统发送可取消事件。
	 *
	 * 定位：`switchSession()` / `newSession()` / `importFromJsonl()` 的公共前置钩子。
	 * 作用：给扩展机会在真正销毁旧会话前拦截或取消切换。
	 * 调用关系：仅被本类的会话切换类方法复用。
	 */
	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	/**
	 * 在分叉前向扩展系统发送可取消事件。
	 *
	 * 定位：`fork()` 的前置通知钩子。
	 * 作用：允许扩展检查目标条目和分叉位置，并在需要时阻止分叉。
	 * 调用关系：仅被 `fork()` 调用。
	 */
	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	/**
	 * 按统一顺序拆除当前运行时。
	 *
	 * 定位：会话替换和退出流程的共享清理步骤。
	 * 作用：先发 `session_shutdown`，再执行宿主同步拆卸，最后销毁旧会话。
	 * 调用关系：被 `switchSession()`、`newSession()`、`fork()`、`importFromJsonl()` 和 `dispose()` 复用。
	 */
	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}

	/**
	 * 用新建运行时结果覆盖当前实例的活动状态。
	 *
	 * 定位：会话替换的状态提交点。
	 * 作用：把新 session、services、diagnostics 和模型降级提示一次性切换到当前对象。
	 * 调用关系：被所有成功创建新运行时的方法调用。
	 */
	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	/**
	 * 完成会话替换后的重绑定和回调执行。
	 *
	 * 定位：会话切换成功后的尾部收口逻辑。
	 * 作用：先把宿主重新绑定到新会话，再把新的扩展上下文交给调用方继续后处理。
	 * 调用关系：被 `switchSession()`、`newSession()`、`fork()`、`importFromJsonl()` 复用。
	 */
	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	/**
	 * 切换到一个已存在的会话文件。
	 *
	 * 定位：恢复已有会话的主入口。
	 * 作用：加载目标会话、按其 cwd 重建服务，并用新运行时替换当前实例。
	 * 调用关系：通常由 CLI/TUI 的 `/resume`、会话选择器等流程调用。
	 */
	async switchSession(
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }> {
		// 先让扩展决定是否允许本次切换。
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		// 基于目标会话文件创建新的 SessionManager，并校验目标 cwd 可用。
		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		// 旧运行时彻底下线后，再创建并应用新的运行时。
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	/**
	 * 创建一个新会话并替换当前运行时。
	 *
	 * 定位：`/new` 和相关扩展 API 的实现入口。
	 * 作用：新建 `SessionManager`、可选挂接父会话，然后重建运行时并执行额外初始化。
	 * 调用关系：由宿主 UI、扩展命令和运行时上下文控制逻辑调用。
	 */
	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		// 先给扩展一次拦截新建会话的机会。
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		// 创建新的会话管理器，并按需挂接父会话关系。
		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = SessionManager.create(this.cwd, sessionDir);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		// 销毁旧运行时后创建新会话对应的运行时。
		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		if (options?.setup) {
			// setup 允许调用方在新会话上追加初始状态，随后把 agent 上下文同步回内存状态。
			await options.setup(this.session.sessionManager);
			this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	/**
	 * 从当前会话树的指定条目分叉出新会话。
	 *
	 * 定位：会话树分叉操作的统一实现。
	 * 作用：根据 entry 和位置选择目标叶子，创建新分支会话，并在必要时返回用户原始文本。
	 * 调用关系：由 `/fork` 命令、树视图和扩展上下文调用。
	 */
	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		// 计算分叉所依附的目标叶子，同时在 before 模式下提取用户原文供编辑器回填。
		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				// 从根开始分叉时，直接创建一个继承当前会话的新会话文件。
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			// 分支文件创建完成后，用新文件对应的运行时替换当前实例。
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		// 非持久化会话直接在内存中的 SessionManager 上改写分支关系。
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * 导入会话 JSONL 文件并将运行时状态切换到导入的会话。
	 *
	 * @returns 当被 session_before_switch 取消时返回 `{ cancelled: true }`，否则返回 `{ cancelled: false }`
	 * @throws {SessionImportFileNotFoundError} 当输入路径不存在时
	 * @throws {MissingSessionCwdError} 当导入的会话 cwd 无法解析且未提供覆盖时
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		// 确保目标会话目录存在，必要时把外部 JSONL 复制进当前会话目录。
		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}

		// 打开导入后的会话文件，并像普通 resume 一样重建运行时。
		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	/**
	 * 销毁当前运行时。
	 *
	 * 定位：宿主退出时的最终清理入口。
	 * 作用：发出退出型 `session_shutdown` 事件，执行失效前回调，并释放当前会话资源。
	 * 调用关系：由 CLI/TUI 退出流程调用。
	 */
	async dispose(): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}
}

/**
 * 从运行时工厂和初始会话目标创建初始运行时。
 *
 * 同一个工厂函数存储在返回的 AgentSessionRuntime 上，供后续的
 * /new、/resume、/fork 和 import 流程复用。
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
