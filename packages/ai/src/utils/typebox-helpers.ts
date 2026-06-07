/**
 * TypeBox schema 辅助工具模块。
 *
 * 文件定位：
 * - 提供 TypeBox schema 的便捷构造函数
 * - TypeBox 是 pi-ai 用于定义工具参数 JSON Schema 的库
 * - 本模块扩展了 TypeBox 缺少的实用 schema 类型
 *
 * 谁调用我：
 * - index.ts：通过桶导出向外部包暴露 StringEnum
 * - 外部包在定义工具参数时使用 StringEnum 构造字符串枚举 schema
 *
 * 调用链路：
 *   外部包定义工具
 *     -> StringEnum(["value1", "value2"], { description: "..." })
 *       -> Type.Unsafe()  构造 TypeBox schema 对象
 *     -> 将返回的 schema 传给 Tool.parameters
 *       -> LLM 根据 schema 约束参数值
 *       -> validation.ts 的 validateToolArguments() 根据 schema 校验参数
 */

import { type TUnsafe, Type } from "typebox";

/**
 * 创建字符串枚举 schema，兼容 Google API 和其他不支持 anyOf/const 模式的 provider。
 *
 * 谁调用我：
 * - 外部包在定义工具时使用（如定义操作类型、模式选择等参数）
 *
 * 我调用谁：Type.Unsafe()（TypeBox 的底层构造函数，允许自定义 JSON Schema）
 *
 * 为什么不直接用 Type.Union([Type.Literal("a"), Type.Literal("b")])：
 * - 某些 API provider（如 Google）不支持 anyOf/const 模式
 * - JSON Schema 的 enum 字段是更通用的格式，兼容性更好
 * - Type.Unsafe 允许直接指定 { type: "string", enum: [...] }
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 *
 * @param values 枚举值列表
 * @param options 可选的 description 和 default 值
 * @returns TypeBox 的 TUnsafe schema 对象
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
