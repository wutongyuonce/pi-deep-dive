/**
 * ANSI 转义序列处理工具
 *
 * 提供 stripAnsi() 函数，用于从字符串中移除 ANSI 转义序列（颜色、样式等控制字符）。
 * 从 ansi-regex 和 strip-ansi 库派生，内联以减少外部依赖。
 *
 * 调用方：TUI 渲染模块、日志输出模块、终端宽度计算等。
 *
 * 许可证：MIT License
 * 版权所有 (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * 特此免费授予任何获得本软件及相关文档文件（以下简称"软件"）副本的人不受限制地
 * 处理本软件的权限，包括但不限于使用、复制、修改、合并、发布、分发、再许可和/或
 * 出售本软件副本的权利，并允许向其提供本软件的人这样做，但须满足以下条件：
 *
 * 上述版权声明和本许可声明应包含在本软件的所有副本或重要部分中。
 *
 * 本软件按"原样"提供，不作任何形式的明示或暗示保证，包括但不限于对适销性、
 * 特定用途适用性和不侵权的保证。在任何情况下，作者或版权持有人均不对因本软件
 * 或本软件的使用或其他交易而产生的任何索赔、损害或其他责任承担任何责任。
 */

/**
 * 生成匹配 ANSI 转义序列的正则表达式。
 *
 * 覆盖两类序列：
 * - OSC 序列：ESC ] ... ST（操作系统命令序列）
 * - CSI 序列：ESC/C1 + 可选中间字节 + 可选参数 + 终止字节
 *
 * @param onlyFirst - 是否只匹配第一个出现的 ANSI 序列，默认为 false（全局匹配）
 * @returns 匹配 ANSI 转义序列的正则表达式
 */
function ansiRegex({ onlyFirst = false }: { onlyFirst?: boolean } = {}): RegExp {
	// 有效的字符串终止序列：BEL (\u0007)、ESC\ (\u001B\u005C) 和 0x9c
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";

	// OSC 序列：ESC ] ... ST（非贪婪匹配到第一个 ST）
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;

	// CSI 及相关序列：ESC/C1，可选中间字节，可选参数（支持 ; 和 : 分隔），终止字节
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";

	const pattern = `${osc}|${csi}`;

	return new RegExp(pattern, onlyFirst ? undefined : "g");
}

// 预编译的全局匹配正则表达式
const regex = ansiRegex();

/**
 * 从字符串中移除所有 ANSI 转义序列。
 *
 * 用于清理终端输出中的颜色、样式等控制字符，得到纯文本内容。
 *
 * @param value - 需要清理的字符串
 * @returns 移除所有 ANSI 转义序列后的纯文本字符串
 * @throws TypeError - 当输入不是字符串类型时抛出
 */
export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	// 快速路径：ANSI 转义码需要 ESC (7-bit) 或 CSI (8-bit) 引导符，
	// 如果字符串中不存在这些字符则无需正则匹配
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}

	// 虽然正则表达式是全局模式，但无需手动重置 `.lastIndex`，
	// 因为 `.replace()` 会自动重置（与 `.exec()` 和 `.test()` 不同），
	// 手动重置反而会有性能损耗。
	return value.replace(regex, "");
}
