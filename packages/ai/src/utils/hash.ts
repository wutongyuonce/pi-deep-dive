/**
 * 快速确定性哈希工具模块。
 *
 * 文件定位：
 * - 提供一个轻量级的字符串哈希函数，用于将长字符串缩短为固定长度的哈希值
 * - 主要用于 prompt cache key 等需要将长 session ID 缩短为固定长度标识符的场景
 *
 * 谁调用我：
 * - providers/openai-responses-shared.ts：导入 shortHash 用于生成短哈希标识符
 * - index.ts 不导出此模块（纯内部工具）
 *
 * 调用链路：
 *   openai-responses-shared.ts
 *     -> shortHash()
 */

/**
 * 快速确定性哈希函数，将任意字符串映射为短的 base36 编码字符串。
 *
 * 算法：MurmurHash3 的 32 位双哈希变体，输出为两个 32 位哈希的 base36 拼接。
 *
 * 谁调用我：openai-responses-shared.ts（用于缩短长标识符）
 * 我调用谁：无（纯数学计算）
 *
 * 特性：
 * - 确定性：相同输入始终产生相同输出
 * - 快速：纯位运算，无 I/O
 * - 输出长度：约 12-13 个 base36 字符（足以避免实际碰撞）
 * - 不适合密码学用途（非加密哈希）
 *
 * @param str 要哈希的字符串
 * @returns base36 编码的短哈希字符串
 */
export function shortHash(str: string): string {
	// 步骤 1：初始化两个 32 位哈希种子
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;

	// 步骤 2：逐字符混合，使用不同的乘法常数产生两个独立的哈希流
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		// Math.imul 执行 32 位整数乘法（模拟溢出行为）
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}

	// 步骤 3：最终混合（avalanche / finalizer），确保每一位都影响输出
	// 通过 XOR 和移位将高位的信息扩散到低位
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	// 步骤 4：将两个 32 位哈希转为无符号整数，再转为 base36 字符串并拼接
	// >>> 0 确保解释为无符号 32 位整数
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
