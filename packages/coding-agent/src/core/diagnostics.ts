/**
 * 资源诊断模块
 *
 * 定义了资源加载过程中产生的诊断信息类型，用于报告扩展、技能、提示词和主题
 * 在加载时遇到的冲突、警告和错误。被 resource-loader.ts 和 package-manager.ts
 * 用于在资源发现和加载过程中收集和传递诊断信息。
 */

/**
 * 资源冲突描述
 * 当同名资源从不同来源加载时产生冲突（例如两个扩展注册了同名工具）。
 */
export interface ResourceCollision {
	/** 资源类型 */
	resourceType: "extension" | "skill" | "prompt" | "theme";
	/** 冲突资源的名称（技能名、命令/工具/标志名、提示词名、主题名） */
	name: string;
	/** 优胜方的文件路径 */
	winnerPath: string;
	/** 落败方的文件路径 */
	loserPath: string;
	/** 优胜方的来源标识，如 "npm:foo"、"git:..."、"local" */
	winnerSource?: string;
	/** 落败方的来源标识 */
	loserSource?: string;
}

/**
 * 资源诊断信息
 * 描述资源加载过程中遇到的问题，包括警告、错误和资源名称冲突。
 */
export interface ResourceDiagnostic {
	/** 诊断类型：warning（警告）、error（错误）、collision（冲突） */
	type: "warning" | "error" | "collision";
	/** 诊断消息 */
	message: string;
	/** 相关文件路径 */
	path?: string;
	/** 如果类型为 collision，包含冲突的详细信息 */
	collision?: ResourceCollision;
}
