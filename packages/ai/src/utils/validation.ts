/**
 * 工具调用参数校验工具模块。
 *
 * 文件定位：
 * - 提供 LLM 返回的工具调用参数的 schema 校验能力
 * - 使用 TypeBox 编译器进行高性能 JSON Schema 校验
 * - 支持类型强制转换（coercion）：当 LLM 返回的参数类型与 schema 不匹配时
 *   自动尝试转换（如字符串 "123" -> 数字 123）
 *
 * 谁调用我：
 * - index.ts：通过桶导出向外部包暴露 validateToolCall 和 validateToolArguments
 * - 外部包（packages/agent、packages/coding-agent）在收到工具调用后调用
 *   validateToolCall() 或 validateToolArguments() 校验参数
 *
 * 调用链路：
 *   外部包收到 LLM 的工具调用
 *     -> validateToolCall(tools, toolCall)            按名称查找工具 + 校验
 *       -> validateToolArguments(tool, toolCall)       核心校验逻辑
 *         -> Value.Convert()                           TypeBox 类型转换
 *         -> coerceWithJsonSchema()                    JSON Schema 级别的类型强制转换
 *         -> getValidator() -> Compile()               编译 schema 为校验器
 *         -> validator.Check() / validator.Errors()    执行校验
 *
 * 类型强制转换（coercion）的必要性：
 * - LLM 返回的 JSON 中，数字可能以字符串形式出现（如 "42" 而非 42）
 * - 布尔值可能以 "true"/"false" 字符串形式出现
 * - 需要在校验前自动转换，避免不必要的校验失败
 */

import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

/**
 * 校验器缓存：避免对同一个 schema 重复编译。
 * 使用 WeakMap 以 schema 对象为 key，schema 被 GC 回收时缓存自动清理。
 */
const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

/** TypeBox 的 Kind symbol，用于检测 schema 是否由 TypeBox 生成。 */
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

/**
 * JSON Schema 对象的简化类型定义。
 * 只包含本模块实际使用的字段，不覆盖完整的 JSON Schema 规范。
 */
interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
}

// ============================================================================
// 内部辅助函数：类型检查
// ============================================================================

/**
 * 判断值是否为普通对象（非 null、非数组）。
 * 谁调用我：isJsonSchemaObject()、coerceWithJsonSchema() 等多处
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 判断值是否为 JSON Schema 对象（目前等价于 isRecord）。
 * 谁调用我：getSubSchemaValidator()、coerceWithJsonSchema() 等
 */
function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return isRecord(value);
}

/**
 * 检测 schema 是否由 TypeBox 生成。
 * TypeBox 生成的 schema 带有 Symbol.for("TypeBox.Kind") 元数据。
 *
 * 谁调用我：validateToolArguments()（判断是否需要 JSON Schema 级别的强制转换）
 * - 如果是 TypeBox schema：Value.Convert() 已经处理了类型转换
 * - 如果是原生 JSON Schema：需要 coerceWithJsonSchema() 手动转换
 */
function hasTypeBoxMetadata(schema: unknown): boolean {
	return isRecord(schema) && Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND);
}

// ============================================================================
// 内部辅助函数：JSON Schema 类型系统
// ============================================================================

/**
 * 从 schema 中提取类型列表。
 * JSON Schema 的 type 可以是字符串或字符串数组（如 ["string", "null"]）。
 *
 * 谁调用我：coerceWithJsonSchema()（判断值是否匹配 schema 类型）
 */
function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

/**
 * 检查值是否匹配指定的 JSON Schema 类型。
 *
 * 谁调用我：coerceWithJsonSchema()（在强制转换前检查是否已经匹配）
 * 我调用谁：无（纯类型检查）
 *
 * 类型映射：
 * - "number"：typeof === "number"
 * - "integer"：typeof === "number" && Number.isInteger()
 * - "boolean"：typeof === "boolean"
 * - "string"：typeof === "string"
 * - "null"：=== null
 * - "array"：Array.isArray()
 * - "object"：isRecord() && !Array.isArray()
 */
function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return isRecord(value) && !Array.isArray(value);
		default:
			return false;
	}
}

/**
 * 判断值是否为合法的校验器 schema（即 Record 对象）。
 * 谁调用我：getSubSchemaValidator()
 */
function isValidatorSchema(value: unknown): value is Tool["parameters"] {
	return isRecord(value);
}

/**
 * 为子 schema 创建校验器（用于 union 类型的逐个尝试）。
 * 编译失败时返回 undefined（不抛错）。
 *
 * 谁调用我：coerceWithUnionSchema()（在 anyOf/oneOf 的每个分支上尝试校验）
 * 我调用谁：getValidator()（获取或创建编译后的校验器）
 */
function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	if (!isValidatorSchema(schema)) {
		return undefined;
	}
	try {
		return getValidator(schema);
	} catch {
		return undefined;
	}
}

// ============================================================================
// 内部辅助函数：类型强制转换（coercion）
// ============================================================================

/**
 * 将原始值强制转换为指定 JSON Schema 类型。
 *
 * 谁调用我：coerceWithJsonSchema()（当值不匹配 schema 类型时）
 * 我调用谁：无（纯值转换）
 *
 * 转换规则：
 * - "number"：字符串 -> parseFloat，布尔 -> 0/1，null -> 0
 * - "integer"：字符串 -> parseInt（必须是整数），布尔 -> 0/1，null -> 0
 * - "boolean"：字符串 "true"/"false" -> 布尔，数字 1/0 -> 布尔，null -> false
 * - "string"：数字/布尔 -> String()，null -> ""
 * - "null"：空字符串/0/false -> null
 */
function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "integer": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "boolean": {
			if (value === null) {
				return false;
			}
			if (typeof value === "string") {
				if (value === "true") {
					return true;
				}
				if (value === "false") {
					return false;
				}
			}
			if (typeof value === "number") {
				if (value === 1) {
					return true;
				}
				if (value === 0) {
					return false;
				}
			}
			return value;
		}
		case "string": {
			if (value === null) {
				return "";
			}
			if (typeof value === "number" || typeof value === "boolean") {
				return String(value);
			}
			return value;
		}
		case "null": {
			if (value === "" || value === 0 || value === false) {
				return null;
			}
			return value;
		}
		default:
			return value;
	}
}

/**
 * 对对象值应用 schema 定义的属性强制转换。
 *
 * 谁调用我：coerceWithJsonSchema()（当 schema 类型包含 "object" 时）
 * 我调用谁：coerceWithJsonSchema()（递归转换每个属性值）
 *
 * 处理逻辑：
 * 1. 遍历 schema.properties 中定义的属性，对存在于值中的属性递归转换
 * 2. 如果 schema.additionalProperties 是对象 schema，对额外属性也递归转换
 */
function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && isJsonSchemaObject(schema.additionalProperties)) {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

/**
 * 对数组值应用 schema 定义的元素强制转换。
 *
 * 谁调用我：coerceWithJsonSchema()（当 schema 类型包含 "array" 时）
 * 我调用谁：coerceWithJsonSchema()（递归转换每个元素）
 *
 * 处理逻辑：
 * - tuple 类型（schema.items 是数组）：按位置匹配每个元素的 schema
 * - 列表类型（schema.items 是对象）：所有元素共用同一个 schema
 */
function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		// Tuple 类型：items 是数组，每个元素有独立的 schema
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (isJsonSchemaObject(schema.items)) {
		// 列表类型：所有元素共用同一个 schema
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

/**
 * 尝试将值与 union 类型（anyOf/oneOf）的每个分支匹配，
 * 返回第一个通过校验的强制转换结果。
 *
 * 谁调用我：coerceWithJsonSchema()（当 schema 包含 anyOf 或 oneOf 时）
 * 我调用谁：
 * - coerceWithJsonSchema()（递归转换值）
 * - getSubSchemaValidator()（编译子 schema 用于校验）
 *
 * 策略：对每个 union 分支，深拷贝值 -> 强制转换 -> 校验，
 * 返回第一个通过校验的结果。全部失败则返回原始值。
 */
function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

/**
 * 核心递归函数：根据 JSON Schema 对值进行类型强制转换。
 *
 * 谁调用我：
 * - validateToolArguments()（顶层入口）
 * - applySchemaObjectCoercion()（递归属性转换）
 * - applySchemaArrayCoercion()（递归元素转换）
 * - coerceWithUnionSchema()（union 分支转换）
 *
 * 我调用谁：
 * - coerceWithUnionSchema()（处理 anyOf/oneOf）
 * - coercePrimitiveByType()（基本类型转换）
 * - applySchemaObjectCoercion()（对象属性转换）
 * - applySchemaArrayCoercion()（数组元素转换）
 *
 * 处理顺序：
 * 1. 递归处理 allOf（合并所有子 schema）
 * 2. 递归处理 anyOf/oneOf（选择第一个匹配的分支）
 * 3. 如果值不匹配 schema 类型，尝试基本类型转换
 * 4. 对对象类型递归处理属性
 * 5. 对数组类型递归处理元素
 */
function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	// 处理 allOf：依次应用每个子 schema（合并效果）
	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	// 处理 anyOf：选择第一个匹配的 union 分支
	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	// 处理 oneOf：选择第一个匹配的 union 分支
	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	// 基本类型转换：如果值不匹配任何 schema 类型，尝试强制转换
	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	// 递归处理对象属性
	if (schemaTypes.includes("object") && isRecord(nextValue) && !Array.isArray(nextValue)) {
		applySchemaObjectCoercion(nextValue, schema);
	}

	// 递归处理数组元素
	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

// ============================================================================
// 内部辅助函数：校验器管理
// ============================================================================

/**
 * 获取 schema 对应的编译后校验器（带缓存）。
 *
 * 谁调用我：
 * - validateToolArguments()（校验最终参数）
 * - getSubSchemaValidator()（校验 union 分支）
 *
 * 我调用谁：Compile()（TypeBox 的 schema 编译器）
 *
 * 编译是一次性的，后续调用直接从 WeakMap 缓存中读取。
 */
function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

// ============================================================================
// 内部辅助函数：错误格式化
// ============================================================================

/**
 * 将校验错误的路径格式化为人类可读的点分路径。
 *
 * 谁调用我：validateToolArguments()（格式化校验错误消息）
 *
 * 特殊处理：
 * - "required" 类型错误：路径指向缺失的属性（如 "config.timeout"）
 * - 其他错误：直接转换 instancePath（如 "/config/timeout" -> "config.timeout"）
 * - 空路径：显示 "root"
 */
function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

// ============================================================================
// 导出函数：工具调用校验
// ============================================================================

/**
 * 按名称查找工具并校验工具调用参数。
 *
 * 谁调用我：
 * - 外部包（packages/agent、packages/coding-agent）在收到 LLM 工具调用后调用
 *
 * 我调用谁：validateToolArguments()（核心校验逻辑）
 *
 * @param tools 工具定义列表
 * @param toolCall LLM 返回的工具调用
 * @returns 校验通过的参数（可能经过类型强制转换）
 * @throws Error 如果工具未找到或校验失败
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * 校验工具调用参数是否符合工具的 schema 定义。
 *
 * 谁调用我：
 * - validateToolCall()（通过名称查找工具后调用）
 * - 外部包直接调用（当已有 tool 引用时）
 *
 * 我调用谁：
 * - Value.Convert()（TypeBox 内置的类型转换）
 * - hasTypeBoxMetadata()（检测 schema 是否为 TypeBox 生成）
 * - coerceWithJsonSchema()（JSON Schema 级别的类型强制转换）
 * - getValidator()（获取编译后的校验器）
 * - validator.Check() / validator.Errors()（执行校验）
 * - formatValidationPath()（格式化错误路径）
 *
 * 校验流程：
 * 1. 深拷贝参数（避免修改原始数据）
 * 2. Value.Convert()：TypeBox 内置的类型转换（处理 TypeBox schema）
 * 3. 如果是原生 JSON Schema（非 TypeBox），执行 coerceWithJsonSchema() 手动转换
 * 4. validator.Check()：执行校验
 * 5. 校验通过：返回转换后的参数
 * 6. 校验失败：收集错误信息并抛出详细的 Error
 *
 * @param tool 工具定义（包含 schema）
 * @param toolCall LLM 返回的工具调用（包含 arguments）
 * @returns 校验通过的参数（可能经过类型强制转换）
 * @throws Error 如果校验失败，包含详细的错误路径和消息
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	// 步骤 1：深拷贝参数，避免修改原始数据
	const args = structuredClone(toolCall.arguments);

	// 步骤 2：TypeBox 内置的类型转换（如字符串数字转为实际数字）
	Value.Convert(tool.parameters, args);

	// 步骤 3：获取编译后的校验器
	const validator = getValidator(tool.parameters);

	// 步骤 4：如果是原生 JSON Schema（非 TypeBox 生成），执行额外的强制转换
	// TypeBox 的 Value.Convert 已经处理了 TypeBox schema，
	// 但原生 JSON Schema 需要 coerceWithJsonSchema() 手动处理
	if (!hasTypeBoxMetadata(tool.parameters) && isJsonSchemaObject(tool.parameters)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters);
		if (coerced !== args) {
			// 如果转换产生了新对象，将结果合并回 args
			if (isRecord(args) && isRecord(coerced)) {
				for (const key of Object.keys(args)) {
					delete args[key];
				}
				Object.assign(args, coerced);
			} else {
				// 基本类型被替换，直接返回校验结果
				return validator.Check(coerced) ? coerced : args;
			}
		}
	}

	// 步骤 5：执行校验
	if (validator.Check(args)) {
		return args;
	}

	// 步骤 6：校验失败，收集并格式化错误信息
	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
