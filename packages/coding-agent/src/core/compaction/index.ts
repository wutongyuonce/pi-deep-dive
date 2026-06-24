/**
 * 上下文压缩与分支摘要模块入口（barrel 文件）。
 *
 * 作用/定位：compaction 子模块的统一对外导出入口。
 * 提供：上下文压缩、分支摘要、共享工具函数的 re-export。
 *
 * 模块结构：
 * - compaction.ts           — 上下文压缩核心逻辑（长会话截断与摘要）
 * - branch-summarization.ts — 分支摘要生成（会话树导航时保留上下文）
 * - utils.ts                — 共享工具函数（文件操作跟踪、消息序列化、系统提示词）
 *
 * 典型调用链路：
 *   prepareCompaction() → compact() → generateSummary()
 *   generateBranchSummary() → prepareBranchEntries() → completeSimple()
 */

export * from "./branch-summarization.ts";
export * from "./compaction.ts";
export * from "./utils.ts";
