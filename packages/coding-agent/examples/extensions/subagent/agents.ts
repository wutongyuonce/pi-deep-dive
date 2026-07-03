/**
 * Subagent 配置发现模块
 *
 * 文件定位：为 subagent 扩展提供 agent 配置文件的发现、解析与展示能力。
 *
 * 核心职责：
 * - 从用户级目录与项目级 `.pi/agents` 目录加载 agent 定义
 * - 解析 markdown frontmatter，生成运行期可用的 `AgentConfig`
 * - 按作用域合并结果，并为 UI 提供简要列表文本
 *
 * 调用链路：
 *   subagent 工具执行 -> discoverAgents() -> loadAgentsFromDir() / findNearestProjectAgentsDir()
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

/**
 * 单个 agent 的运行期配置。
 */
export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

/**
 * agent 发现结果，包含可用 agent 列表与最近的项目级目录位置。
 */
export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * 从指定目录加载所有符合约定的 agent markdown 文件。
 *
 * 定位：模块内部的目录扫描入口，负责把磁盘上的 agent 定义转成 `AgentConfig[]`。
 *
 * 被谁调用：
 *   - discoverAgents()
 *
 * 调用了谁：
 *   - node:fs.existsSync()
 *   - node:fs.readdirSync()
 *   - node:fs.readFileSync()
 *   - parseFrontmatter()
 *
 * @param dir 要扫描的 agent 目录
 * @param source 当前目录对应的来源标记
 * @returns 成功解析出的 agent 配置列表
 */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	// 目录不存在时直接返回空数组，避免把“无配置”视为异常。
	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		// 读取 Dirent 以便后续同时判断扩展名和文件类型。
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		// 仅接受 markdown 文件，agent 定义约定存储为 `.md`。
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		// frontmatter 提供元信息，正文作为 agent 的 system prompt。
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		// 缺少基础元信息的文件不纳入可发现列表。
		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

/**
 * 判断给定路径是否存在且为目录。
 *
 * 定位：为项目级 agent 目录探测提供容错封装。
 *
 * 被谁调用：
 *   - findNearestProjectAgentsDir()
 *
 * @param p 待检查的路径
 * @returns 路径存在且为目录时返回 `true`
 */
function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 从当前工作目录向上查找最近的项目级 `.pi/agents` 目录。
 *
 * 定位：负责把“当前执行位置”映射到最近的项目内 agent 配置目录。
 *
 * 被谁调用：
 *   - discoverAgents()
 *
 * 调用了谁：
 *   - isDirectory()
 *   - node:path.join()
 *   - node:path.dirname()
 *
 * @param cwd 子进程或工具当前工作目录
 * @returns 找到时返回目录绝对路径，否则返回 `null`
 */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		// 到达文件系统根目录后停止向上搜索。
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * 按指定作用域发现可用 agent，并在需要时合并用户级与项目级配置。
 *
 * 定位：subagent 扩展的主发现入口。
 *
 * 被谁调用：
 *   - `index.ts` 中的 subagent 工具执行逻辑
 *
 * 调用了谁：
 *   - getAgentDir()
 *   - findNearestProjectAgentsDir()
 *   - loadAgentsFromDir()
 *
 * @param cwd 当前工作目录，用于定位最近的项目级 agent 目录
 * @param scope 要加载的作用域范围
 * @returns 发现出的 agent 列表及项目目录位置
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// 当同名 agent 同时存在时，后写入的配置会覆盖先写入的配置。
	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * 将 agent 列表格式化为适合提示或确认对话框展示的短文本。
 *
 * @param agents 待展示的 agent 列表
 * @param maxItems 最多输出的条目数
 * @returns 文本内容与剩余未展示数量
 */
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
