/**
 * 会话管理器模块
 *
 * 文件定位：coding-agent 的核心会话持久化与管理模块。
 *
 * 功能概述：
 * - 管理以追加式 JSONL 文件存储的树状会话历史
 * - 每个会话条目通过 id/parentId 形成树结构，"leaf" 指针跟踪当前位置
 * - 支持会话分支（branch）、压缩摘要（compaction）、分支摘要（branch summary）
 * - 支持自定义条目（custom entry）供扩展持久化状态
 * - 支持自定义消息条目（custom message entry）注入 LLM 上下文
 * - 提供会话列表、恢复、分叉（fork）等操作
 *
 * 提供：
 * - SessionManager 类：会话管理的核心类，封装所有会话操作
 * - buildSessionContext()：从会话树构建发送给 LLM 的消息上下文
 * - 各种条目类型定义（SessionEntry 的联合类型）
 *
 * 调用链路：
 *   前端交互 → SessionManager.appendMessage() → _persist() → JSONL 文件
 *   LLM 请求 → SessionManager.buildSessionContext() → 消息列表
 *   resource-loader.ts → loadProjectContextFiles() → 加载 AGENTS.md 上下文
 */

import { type AgentMessage, uuidv7 } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join, resolve } from "path";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";

export const CURRENT_SESSION_VERSION = 3;

/** 会话文件头（JSONL 第一行） */
export interface SessionHeader {
	type: "session";
	/** 版本号（v1 会话无此字段） */
	version?: number;
	/** 会话唯一 ID（UUID v7） */
	id: string;
	/** 创建时间戳（ISO 格式） */
	timestamp: string;
	/** 创建时的工作目录 */
	cwd: string;
	/** 父会话文件路径（fork 时设置） */
	parentSession?: string;
}

/** 新建会话时可覆盖的选项 */
export interface NewSessionOptions {
	/** 可选的自定义会话 ID（默认使用 UUID v7） */
	id?: string;
	/** fork 时指向父会话文件路径 */
	parentSession?: string;
}

/** 会话条目基类——所有条目类型共享的基础字段 */
export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

/** 消息条目——包含一条 LLM 对话消息 */
export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

/** 思考级别变更条目——标记用户在对话中切换了思考模式 */
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/** 模型变更条目——标记用户在对话中切换了 provider/model */
export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

/** 压缩摘要条目——记录一次对话上下文压缩 */
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	/** 压缩生成的摘要文本（注入 LLM 上下文） */
	summary: string;
	/** 压缩后仍保留的第一条消息 ID */
	firstKeptEntryId: string;
	/** 压缩前上下文的 token 数量 */
	tokensBefore: number;
	/** 扩展专属数据 */
	details?: T;
	/** 由扩展生成时为 true，pi 生成时为 undefined/false（向后兼容） */
	fromHook?: boolean;
}

/** 分支摘要条目——记录一次对话分支切换，附带被放弃路径的上下文摘要 */
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	/** 分支起始点条目 ID，"root" 表示从根开始 */
	fromId: string;
	/** 涵盖被放弃路径的上下文摘要文本 */
	summary: string;
	/** 扩展专属数据（不发送给 LLM） */
	details?: T;
	/** 由扩展生成时为 true，pi 生成时为 false */
	fromHook?: boolean;
}

/** 会话元数据条目（如用户自定义的会话显示名称） */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * 自定义条目——供扩展在会话中存储扩展专属数据。
 * 使用 customType 标识扩展的条目。
 *
 * 用途：跨会话重载持久化扩展状态。重载时，扩展可以扫描
 * 匹配其 customType 的条目来重建内部状态。
 *
 * 不参与 LLM 上下文（被 buildSessionContext 忽略）。
 * 如需注入上下文内容，请使用 CustomMessageEntry。
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/**
 * 自定义消息条目——供扩展向 LLM 上下文注入消息。
 * 使用 customType 标识扩展的条目。
 *
 * 与 CustomEntry 不同，此类型参与 LLM 上下文。
 * 内容在 buildSessionContext() 中转换为用户消息。
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T; // 扩展专属的元数据（不会发送给 LLM）
	display: boolean; // 控制 TUI 渲染行为，false：完全隐藏，true：以特殊样式渲染（区别于普通用户消息）
}

/** 用户自定义的标签条目——用于在会话条目上添加书签/标记 */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** 会话条目联合类型——通过 id/parentId 形成树结构（SessionManager 的读取方法返回此类型） */
export type SessionEntry =
	| SessionMessageEntry      // 对话消息（user/assistant/toolResult）
	| ThinkingLevelChangeEntry // 思考级别变更
	| ModelChangeEntry         // 模型切换
	| CompactionEntry          // 上下文压缩摘要
	| BranchSummaryEntry       // 分支摘要
	| CustomEntry              // extension 数据（不进 LLM context）
	| CustomMessageEntry       // extension 消息（进 LLM context）
	| LabelEntry               // 用户书签
	| SessionInfoEntry;        // 会话元数据（显示名称）

/** 原始文件条目（包含文件头） */
export type FileEntry = SessionHeader | SessionEntry;

/** 树节点——getTree() 返回的会话结构防御性副本 */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** 该条目的已解析标签（如果有） */
	label?: string;
	/** 该条目最近一次标签变更的时间戳（如果有） */
	labelTimestamp?: string;
}

/** buildSessionContext() 返回的运行态对话上下文 */
export interface SessionContext {
	/** 按顺序排列的 LLM 消息列表（含压缩摘要、分支摘要等） */
	messages: AgentMessage[];
	/** 当前生效的思考级别 */
	thinkingLevel: string;
	/** 当前生效的模型信息（provider + modelId） */
	model: { provider: string; modelId: string } | null;
}

/** 会话列表查询返回的会话摘要信息 */
export interface SessionInfo {
	/** JSONL 文件完整路径 */
	path: string;
	/** 会话唯一 ID */
	id: string;
	/** 创建会话时的工作目录（旧版会话为空字符串） */
	cwd: string;
	/** 来自 session_info 条目的用户自定义显示名称 */
	name?: string;
	/** 父会话文件路径（fork 时设置） */
	parentSessionPath?: string;
	/** 会话创建时间（来自 session header） */
	created: Date;
	/** 会话最后修改时间（优先最后一条消息时间戳） */
	modified: Date;
	/** 会话中的消息总条数 */
	messageCount: number;
	/** 首条用户消息的纯文本片段（用于列表预览） */
	firstMessage: string;
	/** 所有用户和助手消息的拼合文本（用于列表搜索） */
	allMessagesText: string;
}

/** SessionManager 的只读视图——排除写操作，供扩展使用 */
export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

/** 创建会话 ID（UUID v7，时间有序） */
function createSessionId(): string {
	return uuidv7();
}

/**
 * 生成唯一短 ID（8 个十六进制字符）。
 *
 * 通过 `byId.has()` 检测已用 ID 避免碰撞，最多重试 100 次。
 * 碰撞极罕见时退回到完整 UUID。
 */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/**
 * v1 → v2 版本迁移：为所有条目补上 id / parentId，形成树状结构。
 *
 * 定位：启动时由 `setSessionFile()` → `migrateToCurrentVersion()` 调用。
 * 就地修改 entries 数组，不创建新数组。
 */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// 将 firstKeptEntryIndex 转换为 firstKeptEntryId（用于压缩）
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/**
 * v2 → v3 版本迁移：将早期 `hookMessage` 角色重命名为 `custom`。
 *
 * 定位：与 migrateV1ToV2 在同一调用链，确保旧角色名不再出现在运行态。
 * 就地修改 message 对象。
 */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// 更新 hookMessage 角色的消息条目
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * 执行所有必要的版本迁移，将条目升级到 ${CURRENT_SESSION_VERSION}。
 *
 * 定位：启动加载流程的统一入口。由 `loadEntriesFromFile()` 和 `setSessionFile()` 调用。
 * 返回是否执行了任何迁移（调用方据此决定是否重写文件）。
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** 导出供测试使用：对传入条目执行完整的版本迁移 */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/**
 * 将 JSONL 文本解析为文件条目数组。
 *
 * 定位：会话文件的反序列化入口。跳过空行和 JSON 格式错误的行。
 * 不执行版本迁移——由调用方根据需要单独调用 migrateToCurrentVersion()。
 */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// 跳过格式错误的行
		}
	}

	return entries;
}

/**
 * 从给定的会话条目列表中获取最近一次压缩条目。
 *
 * 定位：供 `buildSessionContext()` 使用，遍历时不会占用主构建逻辑。
 * 从列表末尾反向扫描，匹配第一条 compaction 类型条目。
 */
export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/**
 * 定位：会话树到 LLM 上下文的核心转换函数。
 * 作用：从当前叶子回溯整条路径，组装消息、模型和思考级别等运行态上下文。
 * 调用关系：由 `SessionManager.buildSessionContext()` 调用，是会话恢复与发送前的核心步骤。
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	// 步骤 1：必要时先构建 id 索引，方便后续从叶子回溯父链。
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// 步骤 2：确定本次要构建上下文的叶子节点。
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		// 显式为 null——不返回消息（导航到第一条条目之前）
		return { messages: [], thinkingLevel: "off", model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// 回退到最后一条条目（leafId 未定义时）
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return { messages: [], thinkingLevel: "off", model: null };
	}

	// 步骤 3：从叶子一路回溯到根，得到当前分支的完整路径。
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	// 步骤 4：沿路径提取模型、思考级别和最近一次压缩摘要。
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	// 步骤 5：按“压缩摘要 + 保留消息 + 压缩后消息”规则重建最终消息列表。
	const messages: AgentMessage[] = [];

	const appendMessage = (entry: SessionEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message);
		} else if (entry.type === "custom_message") {
			messages.push(
				createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		// 先输出压缩摘要
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));

		// 查找压缩条目在路径中的索引
		const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);

		// 输出保留的消息（压缩之前的，从 firstKeptEntryId 开始）
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry);
			}
		}

		// 输出压缩之后的消息
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		// 无压缩——输出所有消息，处理分支摘要和自定义消息
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return { messages, thinkingLevel, model };
}

/** 计算 cwd 对应的默认会话目录。
 * 将 cwd 编码为安全目录名存储在 ~/.pi/agent/sessions/ 下。
 */
export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(resolvedAgentDir, "sessions", safePath);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

/**
 * 从 JSONL 文件中加载所有文件条目。
 *
 * 定位：`setSessionFile()` 和静态工厂方法的文件反序列化入口。
 * 会校验首行一定是合法的 session header，否则返回空数组。
 * 不在此处执行版本迁移——由 `setSessionFile()` 完成。
 */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const content = readFileSync(resolvedFilePath, "utf8");
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// 跳过格式错误的行
		}
	}

	// 验证会话头
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as any).id !== "string") {
		return [];
	}

	return entries;
}

/**
 * 快速校验文件是否为合法会话文件。
 *
 * 只读取并解析首行 512 字节，避免完整解析大文件。
 * 通过 `openSync + readSync` 实现无缓冲同步检测。
 */
function isValidSessionFile(filePath: string): boolean {
	try {
		const fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(512);
		const bytesRead = readSync(fd, buffer, 0, 512, 0);
		closeSync(fd);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
		if (!firstLine) return false;
		const header = JSON.parse(firstLine);
		return header.type === "session" && typeof header.id === "string";
	} catch {
		return false;
	}
}

/**
 * 在会话目录中找到最近修改的 .jsonl 文件。
 *
 * 定位：`SessionManager.continueRecent()` 的会话恢复入口。
 * 遍历目录下所有 .jsonl，先快速校验合法性，再按 mtime 降序排序取最新一个。
 */
export function findMostRecentSession(sessionDir: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.filter(isValidSessionFile)
			.map((path) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

/** 类型守卫：判定一条 AgentMessage 是否具备 role + content 字段 */
function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

/** 提取 Message 中的纯文本内容（多模态时只取 text block 并拼接） */
function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

/**
 * 从文件条目列表中提取用户/助手最后活跃时间。
 *
 * 定位：`getSessionModifiedDate()` 的时间戳来源。
 * 优先读取消息的 `timestamp` 字段，退回到条目的 `timestamp` 字符串再解析。
 * 没有 user/assistant 消息时返回 undefined。
 */
function getLastActivityTime(entries: FileEntry[]): number | undefined {
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const message = (entry as SessionMessageEntry).message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const msgTimestamp = (message as { timestamp?: number }).timestamp;
		if (typeof msgTimestamp === "number") {
			lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
			continue;
		}

		const entryTimestamp = (entry as SessionEntryBase).timestamp;
		if (typeof entryTimestamp === "string") {
			const t = new Date(entryTimestamp).getTime();
			if (!Number.isNaN(t)) {
				lastActivityTime = Math.max(lastActivityTime ?? 0, t);
			}
		}
	}

	return lastActivityTime;
}

/**
 * 计算会话的“最后修改时间”。
 *
 * 优先级：最后一条 user/assistant 消息的时间戳
 *       → session header 的 timestamp
 *       → 文件的 fs.Stats.mtime
 */
function getSessionModifiedDate(entries: FileEntry[], header: SessionHeader, statsMtime: Date): Date {
	const lastActivityTime = getLastActivityTime(entries);
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

/**
 * 解析单个会话文件并返回会话摘要信息。
 *
 * 定位：`listSessionsFromDir()` → `buildSessionInfosWithConcurrency()` 的并发单元。
 * 异步读取文件，统计消息数、首条用户消息及全部消息文本。
 */
async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const entries: FileEntry[] = [];
		const lines = content.trim().split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line) as FileEntry);
			} catch {
				// Skip malformed lines
			}
		}

		if (entries.length === 0) return null;
		const header = entries[0];
		if (header.type !== "session") return null;

		const stats = await stat(filePath);
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;

		for (const entry of entries) {
			// 提取会话名称（使用最新的，包括显式清除）
			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const message = (entry as SessionMessageEntry).message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		const cwd = typeof (header as SessionHeader).cwd === "string" ? (header as SessionHeader).cwd : "";
		const parentSessionPath = (header as SessionHeader).parentSession;

		const modified = getSessionModifiedDate(entries, header as SessionHeader, stats.mtime);

		return {
			path: filePath,
			id: (header as SessionHeader).id,
			cwd,
			name,
			parentSessionPath,
			created: new Date((header as SessionHeader).timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

/** 会话列表加载进度回调：loaded = 已完成数，total = 总数 */
export type SessionListProgress = (loaded: number, total: number) => void;

/** 同时加载会话信息的最大并发数 */
const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

/**
 * 带并发限制的会话信息批量构建。
 *
 * 定位：`listSessionsFromDir()` 的底层并发调度器。
 * 通过 `Promise.race` + while 循环实现最多 MAX_CONCURRENT_SESSION_INFO_LOADS 个并发任务。
 * 每完成一个文件就回调 onLoaded() 以驱动进度条。
 */
async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

/**
 * 列出指定目录下所有有效会话的摘要信息。
 *
 * 定位：`SessionManager.list()` 和 `listAll()` 的公共实现。
 * 过滤 .jsonl 文件，并发解析每个文件，支持下层进度回调。
 */
async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

/**
 * 以追加式 JSONL 文件管理对话会话。
 *
 * 每个会话条目具有 id 和 parentId 形成树状结构。"leaf" 指针跟踪当前位置。
 * 追加操作在当前叶子下创建子条目。分支操作将叶子移动到较早的条目，
 * 允许创建新分支而不修改历史。
 *
 * 使用 buildSessionContext() 获取发送给 LLM 的已解析消息列表，
 * 该方法处理压缩摘要并从根节点遍历到当前叶子节点。
 */
export class SessionManager {
	/** 会话唯一 ID（UUID v7） */
	private sessionId: string = "";
	/** 当前会话的 JSONL 文件路径（未持久化时为 undefined） */
	private sessionFile: string | undefined;
	/** 会话文件存放目录 */
	private sessionDir: string;
	/** 创建会话时的工作目录 */
	private cwd: string;
	/** 是否启用文件持久化 */
	private persist: boolean;
	/**
	 * 磁盘内容与 fileEntries 一致的标记。
	 * false = 内存有变更但尚未落盘，下次写盘使用批量全写。
	 */
	private flushed: boolean = false;
	/** 内存中的全部文件条目（含 session header） */
	private fileEntries: FileEntry[] = [];
	/** id → 条目的快速查找索引 */
	private byId: Map<string, SessionEntry> = new Map();
	/** targetId → 标签文本的快速查找索引 */
	private labelsById: Map<string, string> = new Map();
	/** targetId → 最新标签时间戳的快速查找索引 */
	private labelTimestampsById: Map<string, string> = new Map();
	/** 当前会话树的叶子节点 ID（null 表示无条目） */
	private leafId: string | null = null;

	/**
	 * 构造 SessionManager（私有，通过静态工厂方法创建）。
	 *
	 * @param cwd 工作目录
	 * @param sessionDir 会话文件存放目录
	 * @param sessionFile 要打开的会话文件路径（undefined 则新建）
	 * @param persist 是否启用文件持久化
	 */
	private constructor(cwd: string, sessionDir: string, sessionFile: string | undefined, persist: boolean) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		if (sessionFile) {
			this.setSessionFile(sessionFile);
		} else {
			this.newSession();
		}
	}

	/**
	 * 切换到不同的会话文件（用于恢复和分支操作）。
	 *
	 * 流程：
	 * 1. 加载文件条目
	 * 2. 校验会话头完整性（损坏时自动重建）
	 * 3. 执行版本迁移（必要时重写文件）
	 * 4. 重建内存索引
	 */
	setSessionFile(sessionFile: string): void {
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			this.fileEntries = loadEntriesFromFile(this.sessionFile);

			// 如果文件为空或损坏（无有效会话头），截断并重新创建，
			// 避免在缺少会话头的情况下追加消息（会导致会话损坏）
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			this.sessionId = header?.id ?? createSessionId();

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}

			this._buildIndex();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // 保留 --session 标志传入的显式路径
		}
	}

	/**
	 * 新建空白会话，写入 SessionHeader 作为第一条文件条目。
	 *
	 * 定位：构造函数、setSessionFile、createBranchedSession、forkFrom 等流程的公共初始化入口。
	 * 持久化模式下会自动生成 `{timestamp}_{id}.jsonl` 文件路径。
	 *
	 * @returns 新建的会话文件路径（非持久化模式下为 undefined）
	 */
	newSession(options?: NewSessionOptions): string | undefined {
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	/**
	 * 从 fileEntries 重建内存索引（byId、leafId、labelsById）。
	 *
	 * 调用时机：setSessionFile 加载或重写文件后、createBranchedSession 构建后。
	 * 索引规则：顺序扫描跳过 session header，每个非 header 条目都会覆盖同一个键，最后一个生效。
	 */
	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			// 顺序扫描追加式文件，最后一个非头条目天然就是当前叶子。
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	/**
	 * 将当前 fileEntries 全量覆盖写回 JSONL 文件。
	 *
	 * 调用于：版本迁移后、createBranchedSession 后。
	 * 仅在 persist=true 且有 sessionFile 时生效。
	 */
	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const content = `${this.fileEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(this.sessionFile, content);
	}

	/** 返回当前会话管理器是否使用文件持久化存储 */
	isPersisted(): boolean {
		return this.persist;
	}

	/** 返回创建会话时记录的工作目录 */
	getCwd(): string {
		return this.cwd;
	}

	/** 返回当前会话文件的存放目录路径 */
	getSessionDir(): string {
		return this.sessionDir;
	}

	/** 返回当前会话的唯一 ID */
	getSessionId(): string {
		return this.sessionId;
	}

	/** 返回当前会话的 JSONL 文件路径（未持久化时为 undefined） */
	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/**
	 * 将条目异步落盘（确保内存变更可靠到达磁盘）。
	 *
	 * 写入策略：
	 * - 当前文件中还没有 assistant 消息 → 延迟到第一条 assistant 到达时批量写入
	 * - 有 assistant 但尚未批量写入 → 一次性写入所有 fileEntries
	 * - 已经批量写入过 → 追加当前条目到文件尾部
	 */
	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
		if (!hasAssistant) {
			// 标记为未刷新，这样当助手消息到达时，所有条目会被一次性写入
			this.flushed = false;
			return;
		}

		if (!this.flushed) {
			// 首次落盘时重写当前内存快照，确保头和历史条目完整写入。
			for (const e of this.fileEntries) {
				appendFileSync(this.sessionFile, `${JSON.stringify(e)}\n`);
			}
			this.flushed = true;
		} else {
			// 之后只需追加最新条目，保持 JSONL 追加式持久化模型。
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}

	/**
	 * 将条目追加到内存并异步落盘。
	 *
	 * 定位：所有 append*() 方法的统一出口。更新 fileEntries、byId、leafId 之后调用 _persist。
	 */
	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
	}

	/** 追加消息到当前叶子节点之后。返回条目 ID。
	 * 不允许直接写入 CompactionSummaryMessage 和 BranchSummaryMessage。
	 * 原因：这些消息需要作为会话的顶级条目，而非消息子条目，
	 * 以便更容易找到它们。需要通过 appendCompaction() 和
	 * appendBranchSummary() 方法来追加。
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加思考级别变更到当前叶子节点之后，返回条目 ID */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加模型变更到当前叶子节点之后，返回条目 ID */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加压缩摘要到当前叶子节点之后，返回条目 ID */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加自定义条目（供扩展使用）到当前叶子节点之后，返回条目 ID */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加会话信息条目（如显示名称），返回条目 ID */
	appendSessionInfo(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 获取当前会话名称（来自最新的 session_info 条目） */
	getSessionName(): string | undefined {
		// 反向遍历条目以找到最新的 session_info 条目
		// 空名称明确清除会话标题
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/**
	 * 追加自定义消息条目（供扩展使用），参与 LLM 上下文。
	 * @param customType 扩展标识符，用于重载时的过滤
	 * @param content 消息内容（字符串或 TextContent/ImageContent 数组）
	 * @param display 是否在 TUI 中显示（true = 特殊样式渲染，false = 隐藏）
	 * @param details 可选的扩展专属元数据（不发送给 LLM）
	 * @returns 条目 ID
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// 树遍历
	// =========================================================================

	/** 返回当前叶子节点 ID（新条目将作为该节点的子节点） */
	getLeafId(): string | null {
		return this.leafId;
	}

	/** 返回当前叶子节点条目（新条目将作为该条目的子节点） */
	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	/** 按 ID 查找任意一条会话条目 */
	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * 获取指定条目的所有直接子条目。
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * 获取条目的标签（如果有）。
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * 设置或清除条目的标签。
	 * 标签是用户定义的书签/导航标记。
	 * 传入 undefined 或空字符串以清除标签。
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * 从指定条目遍历到根节点，返回路径上所有条目（按顺序）。
	 * 包含所有条目类型（消息、压缩、模型变更等）。
	 * 使用 buildSessionContext() 获取发送给 LLM 的已解析消息列表。
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path;
	}

	/**
	 * 构建会话上下文（发送给 LLM 的内容）。
	 * 从当前叶子节点进行树遍历。
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * 获取会话头信息。
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * 获取所有会话条目（不含会话头），返回浅拷贝。
	 * 会话是仅追加的：使用 appendXXX() 添加条目，使用 branch() 更改叶子指针。
	 * 条目不可修改或删除。
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/**
	 * 获取会话的树状结构。返回所有条目的浅防御性副本。
	 * 正常的会话恰好有一个根节点（parentId === null 的第一个条目）。
	 * 孤立的条目（父链断裂）也作为根节点返回。
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// 创建带已解析标签的节点
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// 构建树
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// 孤立节点——视为根节点
					roots.push(node);
				}
			}
		}

		// 按时间戳排序子节点（最旧在上，最新在下）
		// 使用迭代方式避免深树导致的栈溢出
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// 分支操作
	// =========================================================================

	/**
	 * 从较早的条目开始新分支。
	 * 将叶子指针移动到指定条目。下一次 appendXXX() 调用
	 * 将创建该条目的子条目，形成新分支。已有条目不会被修改或删除。
	 */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * 将叶子指针重置为 null（在所有条目之前）。
	 * 下一次 appendXXX() 调用将创建新的根条目（parentId = null）。
	 * 用于导航到第一条用户消息进行重新编辑。
	 */
	resetLeaf(): void {
		this.leafId = null;
	}

	/**
	 * 开始新分支并附带被放弃路径的摘要。
	 * 与 branch() 相同，但还会追加一个 branch_summary 条目，
	 * 捕获被放弃对话路径的上下文。
	 */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * 创建一个新的会话文件，仅包含从根节点到指定叶子节点的路径。
	 * 用于从带分支的会话中提取单条对话路径。
	 * 返回新会话文件路径，如果未启用持久化则返回 undefined。
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// 步骤 1：先截出目标分支路径，再把标签条目单独剥离，稍后重建。
		const pathWithoutLabels = path.filter((e) => e.type !== "label");

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// 步骤 2：收集该路径上仍然生效的标签，保证导出的分支可继续导航。
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// 步骤 3：持久化模式下为新文件重建尾部标签条目。
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// 仅当包含助手消息时才写入文件。
			// 否则延迟到 _persist()——在第一个助手响应时创建文件，
			// 匹配 newSession() 的约定，避免 _persist() 的无助手守卫
			// 后续重置 flushed 时产生重复头的 bug。
			const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
			if (hasAssistant) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		// 步骤 4：内存模式直接用“路径 + 标签”替换当前会话快照。
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	/**
	 * 创建新会话。
	 * @param cwd 工作目录（存储在会话头中）
	 * @param sessionDir 可选的会话目录。省略时使用默认目录（~/.pi/agent/sessions/<编码后的 cwd>/）
	 */
	static create(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true);
	}

	/**
	 * 打开指定的会话文件。
	 * @param path 会话文件路径
	 * @param sessionDir 可选的会话目录，用于 /new 或 /branch 操作。省略时从文件的父目录推导
	 * @param cwdOverride 可选的 cwd 覆盖，替代会话头中的 cwd
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		// 提取 cwd（从会话头中，或使用 process.cwd()）
		const entries = loadEntriesFromFile(resolvedPath);
		const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
		const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
		// 如果未提供 sessionDir，从文件的父目录推导
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true);
	}

	/**
	 * 继续最近的会话，如果没有则创建新会话。
	 * @param cwd 工作目录
	 * @param sessionDir 可选的会话目录。省略时使用默认目录
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const mostRecent = findMostRecentSession(dir);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** 创建内存会话（不持久化到文件） */
	static inMemory(cwd: string = process.cwd()): SessionManager {
		return new SessionManager(cwd, "", undefined, false);
	}

	/**
	 * 从另一个项目目录 fork 会话到当前项目。
	 * 在目标 cwd 中创建新会话，包含源会话的完整历史。
	 * @param sourcePath 源会话文件路径
	 * @param targetCwd 目标工作目录（新会话的存储位置）
	 * @param sessionDir 可选的会话目录。省略时使用 targetCwd 的默认目录
	 */
	static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// 创建包含源历史的新会话文件
		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// 写入指向源文件为父会话的新头，并更新 cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		appendFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`);

		// 从源文件复制所有非头条目
		for (const entry of sourceEntries) {
			if (entry.type !== "session") {
				appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
			}
		}

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
	}

	/**
	 * 列出指定目录的所有会话。
	 * @param cwd 工作目录（用于计算默认会话目录）
	 * @param sessionDir 可选的会话目录。省略时使用默认目录
	 * @param onProgress 可选的进度回调（已加载数, 总数）
	 */
	static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const sessions = await listSessionsFromDir(dir, onProgress);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/**
	 * 列出所有项目目录下的全部会话。
	 * @param onProgress 可选的进度回调（已加载数, 总数）
	 */
	static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) {
				return [];
			}
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));

			// 先统计总文件数以获取准确的进度
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// 带进度追踪处理所有文件
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				onProgress?.(loaded, totalFiles);
			});

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}
}
