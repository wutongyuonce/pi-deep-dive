/**
 * diagnostics.ts - 资源加载诊断类型定义
 *
 * 定位：core 资源系统的共享类型文件，本身不执行业务逻辑，只负责约束诊断数据结构。
 *
 * 作用：
 * - 描述资源加载期间的警告、错误与名称冲突
 * - 为资源扫描、合并、展示流程提供统一的数据契约
 *
 * 调用关系：
 * - 被 `resource-loader.ts` 生产诊断数据
 * - 被 `package-manager.ts`、上层 UI/CLI 消费，用于汇总并展示问题
 */

/**
 * 资源冲突描述。
 *
 * 定位：`ResourceDiagnostic` 中 `collision` 分支的详细负载。
 * 作用：记录同名资源竞争时的胜出方、落败方及来源信息，便于 UI 给出可追踪提示。
 * 调用关系：由资源发现与合并逻辑构造，随 `ResourceDiagnostic` 一起上传给调用方。
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
 * 资源诊断信息。
 *
 * 定位：资源系统对外暴露的统一诊断项。
 * 作用：承载资源加载期间的 warning、error 和 collision 结果。
 * 调用关系：由加载器产出，被包管理、启动流程和展示层消费。
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
