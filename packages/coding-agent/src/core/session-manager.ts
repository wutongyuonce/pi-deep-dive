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

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** 扩展专属数据（如 ArtifactIndex、结构化压缩的版本标记） */
	details?: T;
	/** 由扩展生成时为 true，pi 生成时为 undefined/false（向后兼容） */
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** 扩展专属数据（不发送给 LLM） */
	details?: T;
	/** 由扩展生成时为 true，pi 生成时为 false */
	fromHook?: boolean;
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

/** 用户自定义的标签条目——用于在会话条目上添加书签/标记 */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** 会话元数据条目（如用户自定义的会话显示名称） */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * 自定义消息条目——供扩展向 LLM 上下文注入消息。
 * 使用 customType 标识扩展的条目。
 *
 * 与 CustomEntry 不同，此类型参与 LLM 上下文。
 * 内容在 buildSessionContext() 中转换为用户消息。
 * details 字段用于扩展专属的元数据（不会发送给 LLM）。
 *
 * display 控制 TUI 渲染行为：
 * - false：完全隐藏
 * - true：以特殊样式渲染（区别于普通用户消息）
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

/** 会话条目联合类型——通过 id/parentId 形成树结构（SessionManager 的读取方法返回此类型） */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

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

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** 创建会话时的工作目录（旧版会话为空字符串） */
	cwd: string;
	/** 来自 session_info 条目的用户自定义显示名称 */
	name?: string;
	/** 父会话文件路径（fork 时设置） */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
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

/** 生成唯一短 ID（8 个十六进制字符，带冲突检测） */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/** 迁移 v1 → v2：添加 id/parentId 树结构。就地修改。 */
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

/** 迁移 v2 → v3：将 hookMessage 角色重命名为 custom。就地修改。 */
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
 * 执行所有必要的迁移，将条目升级到当前版本。
 * 就地修改条目。返回是否应用了任何迁移。
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** 导出供测试使用 */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/** 导出供 compaction.test.ts 使用 */
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

/** 导出供测试使用 */
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

/** Exported for testing */
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

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

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

function getSessionModifiedDate(entries: FileEntry[], header: SessionHeader, statsMtime: Date): Date {
	const lastActivityTime = getLastActivityTime(entries);
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

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

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

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
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;

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

	/** 切换到不同的会话文件（用于恢复和分支操作） */
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

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const content = `${this.fileEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(this.sessionFile, content);
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

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

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

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
