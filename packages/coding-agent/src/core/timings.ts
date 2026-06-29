/**
 * 启动性能计时模块
 *
 * 提供集中的启动性能分析（profiling）工具。通过设置环境变量 PI_TIMING=1 启用，
 * 记录各阶段耗时，用于诊断启动慢的问题。
 */

/** 是否启用计时（通过 PI_TIMING=1 环境变量控制） */
const ENABLED = process.env.PI_TIMING === "1";
/** 计时记录列表 */
const timings: Array<{ label: string; ms: number }> = [];
/** 上一次记录的时间戳 */
let lastTime = Date.now();

/**
 * 定位：启动性能计时缓冲区的重置入口。
 * 作用：清空已记录阶段并重置起始时间，供一次新的启动分析重新开始。
 * 调用关系：由启动流程或测试在准备重新采样时调用，后续再配合 `time()` 与 `printTimings()` 使用。
 */
export function resetTimings(): void {
	if (!ENABLED) return;
	// 先清空已有采样，再把基准时间回拨到当前时刻。
	timings.length = 0;
	lastTime = Date.now();
}

/**
 * 定位：启动阶段的打点函数。
 * 作用：记录当前阶段距离上一次打点的耗时，便于定位慢启动环节。
 * 调用关系：由各启动步骤插入调用，最终结果由 `printTimings()` 汇总输出。
 *
 * @param label 计时点标签，描述当前阶段
 */
export function time(label: string): void {
	if (!ENABLED) return;
	// 基于相邻阶段差值记账，方便直接看出每一步的独立耗时。
	const now = Date.now();
	timings.push({ label, ms: now - lastTime });
	lastTime = now;
}

/**
 * 定位：启动性能采样的输出收口。
 * 作用：把累计的阶段耗时打印到 stderr，供手动排查启动性能问题。
 * 调用关系：通常在启动完成后调用，读取前面由 `time()` 写入的全部记录。
 */
export function printTimings(): void {
	if (!ENABLED || timings.length === 0) return;
	// 先逐项输出，再汇总总耗时，便于对照各阶段占比。
	console.error("\n--- Startup Timings ---");
	for (const t of timings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${timings.reduce((a, b) => a + b.ms, 0)}ms`);
	console.error("------------------------\n");
}
