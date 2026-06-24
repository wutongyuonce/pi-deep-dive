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
 * 重置所有计时记录
 */
export function resetTimings(): void {
	if (!ENABLED) return;
	timings.length = 0;
	lastTime = Date.now();
}

/**
 * 记录一个计时点，计算距离上一次计时点的毫秒数
 * @param label 计时点标签，描述当前阶段
 */
export function time(label: string): void {
	if (!ENABLED) return;
	const now = Date.now();
	timings.push({ label, ms: now - lastTime });
	lastTime = now;
}

/**
 * 将所有计时记录输出到 stderr
 */
export function printTimings(): void {
	if (!ENABLED || timings.length === 0) return;
	console.error("\n--- Startup Timings ---");
	for (const t of timings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${timings.reduce((a, b) => a + b.ms, 0)}ms`);
	console.error("------------------------\n");
}
