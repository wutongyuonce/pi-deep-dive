/**
 * 模型列表展示器 -- 用于 --list-models 命令行参数
 *
 * 【文件定位】
 * 此文件是 CLI 层的模型展示模块，负责从 ModelRegistry 获取所有可用的 AI 模型，
 * 并以格式化的表格形式输出到终端。支持可选的模糊搜索过滤。
 *
 * 【在调用链中的位置】
 * 用户执行 `pi --list-models [search]`
 *   → main.ts 检测到 parsed.listModels !== undefined
 *     → listModels(modelRegistry, searchPattern)
 *       → modelRegistry.getAvailable() 获取模型列表
 *       → fuzzyFilter() 模糊搜索过滤（如有搜索模式）
 *       → formatNoModelsAvailableMessage() 无模型时显示引导信息
 *       → formatTokenCount() 格式化 token 数量为人类可读形式
 *       → 输出对齐的表格到终端
 *
 * 【提供的能力】
 * 1. listModels(): 主入口函数，列出所有可用模型（支持模糊搜索）
 * 2. formatTokenCount(): 内部工具函数，将大数字格式化为 K/M 单位
 *
 * 【与其他文件的关系】
 * - 被 main.ts 调用（用户指定 --list-models 时）
 * - 依赖 core/model-registry.ts 的 ModelRegistry 获取模型数据
 * - 依赖 core/auth-guidance.ts 的 formatNoModelsAvailableMessage() 显示无模型提示
 * - 依赖 @earendil-works/pi-tui 的 fuzzyFilter() 进行模糊搜索
 * - 依赖 @earendil-works/pi-ai 的 Model/Api 类型定义
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import type { ModelRegistry } from "../core/model-registry.ts";

/**
 * 将 token 数量格式化为人类可读的形式
 *
 * 用于在模型列表表格中展示上下文窗口大小和最大输出 token 数。
 * 例如：200000 -> "200K"，1000000 -> "1M"，500 -> "500"
 *
 * 【被谁调用】
 * - listModels() 在构建表格行数据时调用
 *
 * 【调用了谁】
 * - 无外部依赖，纯数值计算
 *
 * @param count - 原始 token 数量
 * @returns 格式化后的字符串（如 "200K"、"1.5M"、"500"）
 */
function formatTokenCount(count: number): string {
	// 大于等于 100 万时，以 M（百万）为单位显示
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		// 整数时不显示小数点，否则保留一位小数
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	// 大于等于 1000 时，以 K（千）为单位显示
	if (count >= 1_000) {
		const thousands = count / 1_000;
		// 整数时不显示小数点，否则保留一位小数
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	// 小于 1000 时直接显示原始数字
	return count.toString();
}

/**
 * 列出所有可用模型，支持可选的模糊搜索过滤
 *
 * 从 ModelRegistry 获取已注册的模型列表，按提供商和模型 ID 排序，
 * 然后以对齐的表格形式输出到终端。表格包含以下列：
 * - provider: 提供商名称
 * - model: 模型 ID
 * - context: 上下文窗口大小
 * - max-out: 最大输出 token 数
 * - thinking: 是否支持推理/思考模式
 * - images: 是否支持图片输入
 *
 * 【被谁调用】
 * - main.ts 在检测到 --list-models 参数时调用
 *   调用方式：listModels(modelRegistry, searchPattern)
 *   其中 searchPattern 可能是用户提供的搜索字符串或 undefined
 *
 * 【调用了谁】
 * - modelRegistry.getError(): 检查模型加载是否有错误
 * - modelRegistry.getAvailable(): 获取所有可用模型列表
 * - fuzzyFilter(): 对模型列表进行模糊搜索过滤
 * - formatNoModelsAvailableMessage(): 生成无可用模型时的引导提示信息
 * - formatTokenCount(): 将 token 数字格式化为 K/M 单位
 *
 * @param modelRegistry - 模型注册中心，管理所有已注册的 AI 模型
 * @param searchPattern - 可选的模糊搜索模式，用于过滤模型列表
 * @returns 无返回值（void），结果直接输出到控制台
 */
export async function listModels(modelRegistry: ModelRegistry, searchPattern?: string): Promise<void> {
	// 检查模型注册表在加载过程中是否有错误（如 models.json 解析失败）
	const loadError = modelRegistry.getError();
	if (loadError) {
		console.error(chalk.yellow(`Warning: errors loading models.json:\n${loadError}`));
	}

	// 从注册表获取所有可用模型
	const models = modelRegistry.getAvailable();

	// 如果没有任何可用模型，显示引导用户配置 API 密钥的提示信息
	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage());
		return;
	}

	// 如果提供了搜索模式，使用模糊过滤缩小模型列表范围
	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		// 以 "provider id" 拼接字符串作为模糊匹配的目标文本
		filteredModels = fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	// 搜索后无匹配结果时，提示用户
	if (filteredModels.length === 0) {
		console.log(`No models matching "${searchPattern}"`);
		return;
	}

	// 按提供商名称排序，同一提供商内按模型 ID 排序
	filteredModels.sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	// 将模型数据转换为表格行格式，数值字段使用人类可读的格式
	const rows = filteredModels.map((m) => ({
		provider: m.provider,
		model: m.id,
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
	}));

	// 定义表头文本
	const headers = {
		provider: "provider",
		model: "model",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};

	// 计算每列的最大宽度（取表头和所有数据行中最长的值）
	const widths = {
		provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
	};

	// 输出表头行，各列使用 padEnd 补齐空格以实现对齐
	const headerLine = [
		headers.provider.padEnd(widths.provider),
		headers.model.padEnd(widths.model),
		headers.context.padEnd(widths.context),
		headers.maxOut.padEnd(widths.maxOut),
		headers.thinking.padEnd(widths.thinking),
		headers.images.padEnd(widths.images),
	].join("  ");
	console.log(headerLine);

	// 逐行输出模型数据，各列同样使用 padEnd 对齐
	for (const row of rows) {
		const line = [
			row.provider.padEnd(widths.provider),
			row.model.padEnd(widths.model),
			row.context.padEnd(widths.context),
			row.maxOut.padEnd(widths.maxOut),
			row.thinking.padEnd(widths.thinking),
			row.images.padEnd(widths.images),
		].join("  ");
		console.log(line);
	}
}
