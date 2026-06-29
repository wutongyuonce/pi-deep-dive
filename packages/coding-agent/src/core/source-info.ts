/**
 * 资源来源信息的类型定义与创建工具。
 *
 * 文件定位：coding-agent 的资源来源追踪层，为各种资源（技能、提示模板、扩展等）
 * 提供统一的来源元数据描述，用于 UI 展示和来源追溯。
 *
 * 提供：
 * - SourceScope / SourceOrigin 类型：来源的作用域和来源方式
 * - SourceInfo 接口：完整的来源信息结构
 * - createSourceInfo()：从包管理器元数据创建来源信息
 * - createSyntheticSourceInfo()：手动合成来源信息（不依赖包管理器）
 */

import type { PathMetadata } from "./package-manager.ts";

/** 来源作用域：用户级（全局）/ 项目级 / 临时 */
export type SourceScope = "user" | "project" | "temporary";
/** 来源方式：来自包（npm/git） / 顶层直接配置 */
export type SourceOrigin = "package" | "top-level";

/** 资源来源信息，描述一个资源文件从哪里来、属于哪个作用域 */
export interface SourceInfo {
	/** 资源文件的绝对路径 */
	path: string;
	/** 来源标识（如包名、"local" 等） */
	source: string;
	/** 作用域：用户级 / 项目级 / 临时 */
	scope: SourceScope;
	/** 来源方式：包 / 顶层配置 */
	origin: SourceOrigin;
	/** 资源所在的基础目录 */
	baseDir?: string;
}

/**
 * 定位：将包管理器阶段产生的路径元数据转换为统一的来源信息对象。
 * 作用：把资源路径与 `PathMetadata` 拼成后续 UI、命令面板和诊断统一消费的 `SourceInfo`。
 * 调用关系：由资源加载链路在拿到包解析结果后调用，再把结果传给技能、提示模板、扩展等展示层。
 *
 * @param path - 资源文件的绝对路径
 * @param metadata - 包管理器提供的路径元数据
 * @returns SourceInfo 来源信息对象
 */
export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	// 直接保留包管理阶段已经确定的来源字段，避免下游重复推断。
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

/**
 * 定位：为不经过包管理器的资源补齐来源元数据。
 * 作用：给直接从文件系统读取的技能、提示模板等对象生成可追溯的 `SourceInfo`。
 * 调用关系：由本地扫描型加载逻辑调用，返回值继续传给斜杠命令、资源诊断和界面展示层。
 *
 * @param path - 资源文件的绝对路径
 * @param options - 来源配置选项
 * @param options.source - 来源标识
 * @param options.scope - 作用域，默认 "temporary"
 * @param options.origin - 来源方式，默认 "top-level"
 * @param options.baseDir - 基础目录
 * @returns SourceInfo 来源信息对象
 */
export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
	},
): SourceInfo {
	// 对未显式指定的字段补默认值，保证下游始终拿到结构完整的来源信息。
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}
