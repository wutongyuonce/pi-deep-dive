/**
 * 模型解析、作用域选择与初始模型确定。
 *
 * 文件定位：coding-agent 的模型选择层，负责将用户输入的模型模式（pattern）
 * 解析为实际的 Model 对象，并确定会话的初始模型和思考级别。
 *
 * 提供：
 * - findExactModelReferenceMatch()：精确匹配模型引用（支持 provider/modelId 格式）
 * - parseModelPattern()：解析 "model:thinkingLevel" 格式的模式字符串
 * - resolveModelScope()：将一组模式解析为带思考级别的模型列表（支持 glob 匹配）
 * - resolveCliModel()：从 CLI 参数解析单个模型（支持 --provider / --model 标志）
 * - findInitialModel()：按优先级确定会话的初始模型
 * - restoreModelFromSession()：从会话恢复模型，带降级逻辑
 *
 * 调用链路：
 * - 被 agent 启动时调用 findInitialModel() 确定默认模型
 * - 被 TUI 模型切换时调用 resolveModelScope() 解析模型模式
 * - 调用 model-registry.ts 获取可用模型列表和查询模型
 * - 调用 defaults.ts 获取 DEFAULT_THINKING_LEVEL
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type KnownProvider, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRegistry } from "./model-registry.ts";

/** 每个已知 provider 的默认模型 ID */
export const defaultModelPerProvider: Record<KnownProvider, string> = {
	anthropic: "claude-opus-4-7",
	openai: "gpt-5.4",
};

export interface ScopedModel {
	model: Model<Api>;
	/** 如果在模式中显式指定了思考级别（如 "model:high"），则为该级别；否则为 undefined */
	thinkingLevel?: ThinkingLevel;
}

/**
 * 辅助函数：判断模型 ID 是否为别名（无日期后缀）。
 * 日期格式通常为：-20241022 或 -20250929
 */
function isAlias(id: string): boolean {
	// 以 -latest 结尾的视为别名
	if (id.endsWith("-latest")) return true;

	// 以日期格式 (-YYYYMMDD) 结尾的视为带日期版本
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * 精确查找模型引用匹配。
 * 支持裸模型 ID 或 "provider/modelId" 规范格式。
 * 按裸 ID 匹配时，如果跨多个 provider 存在歧义则拒绝匹配。
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * 尝试将模式字符串匹配到可用模型列表中的某个模型。
 * 先尝试精确匹配，失败后回退到模糊匹配（ID 或名称包含模式字符串）。
 * 模糊匹配时优先选择别名（如 claude-sonnet-4-5），其次选择最新日期版本。
 *
 * @returns 匹配到的模型或 undefined
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}

	// 无精确匹配——回退到部分匹配
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// 分离为别名和带日期版本
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		// 优先选择别名——多个别名时取排序最高的
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		// 无别名，选择最新的带日期版本
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

/** 解析模型模式的结果 */
export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** 如果在模式中显式指定了思考级别，则为该级别；否则为 undefined */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

/**
 * 构建降级模型：当精确匹配失败时，基于该 provider 的默认模型创建自定义模型 ID。
 * 用于支持用户输入未预注册的模型 ID（如新发布的模型）。
 */
function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const providerModels = availableModels.filter((m) => m.provider === provider);
	if (providerModels.length === 0) return undefined;

	const defaultId = defaultModelPerProvider[provider as KnownProvider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

/**
 * 解析模式字符串，提取模型和思考级别。
 * 支持模型 ID 中包含冒号的情况（如 OpenRouter 的 :exacto 后缀）。
 *
 * 算法：
 * 1. 尝试将完整模式作为模型名匹配
 * 2. 如果匹配成功，返回该模型（无显式思考级别）
 * 3. 如果未匹配且包含冒号，在最后一个冒号处分割：
 *    - 如果后缀是有效的思考级别，使用该级别并递归处理前缀
 *    - 如果后缀无效，发出警告并递归处理前缀（使用默认级别）
 *
 * @internal 导出用于测试
 */
export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	// 先尝试精确匹配
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}

	// 无匹配——尝试在最后一个冒号处分割
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// 无冒号，模式不匹配任何模型
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	if (isValidThinkingLevel(suffix)) {
		// 有效思考级别——递归处理前缀并使用此级别
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			// 仅在内部递归无警告时使用此思考级别
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		}
		return result;
	} else {
		// 无效后缀
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback) {
			// 严格模式（CLI --model 解析）：将其视为模型 ID 的一部分，匹配失败。
			// 避免意外解析为不同的模型。
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		// 作用域模式：递归处理前缀并发出警告
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			};
		}
		return result;
	}
}

/**
 * 将模型模式列表解析为实际的 Model 对象（附带可选思考级别）。
 * 格式："pattern:level"，其中 :level 可选。
 * 对每个模式，查找所有匹配的模型并选择最佳版本：
 * 1. 优先选择别名（如 claude-sonnet-4-5）而非带日期版本（claude-sonnet-4-5-20250929）
 * 2. 无别名时选择最新的带日期版本
 *
 * 支持模型 ID 中包含冒号的情况（如 OpenRouter 的 model:exacto）。
 * 算法先尝试匹配完整模式，然后逐步剥离冒号后缀寻找匹配。
 *
 * 支持 glob 通配符模式（如 "anthropic/*"、"*sonnet*"）。
 */
export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
	const availableModels = await modelRegistry.getAvailable();
	const scopedModels: ScopedModel[] = [];

	for (const pattern of patterns) {
		// 检查模式是否包含 glob 通配符字符
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// 提取可选的思考级别后缀（如 "provider/*:high"）
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				if (isValidThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.substring(0, colonIdx);
				}
			}

			// 匹配 "provider/modelId" 格式或仅匹配模型 ID
			// 这允许 "*sonnet*" 匹配而无需写成 "anthropic/*sonnet*"
			const matchingModels = availableModels.filter((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
			});

			if (matchingModels.length === 0) {
				console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
				continue;
			}

			for (const model of matchingModels) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
					scopedModels.push({ model, thinkingLevel });
				}
			}
			continue;
		}

		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			console.warn(chalk.yellow(`Warning: ${warning}`));
		}

		if (!model) {
			console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
			continue;
		}

		// 去重
		if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	}

	return scopedModels;
}

/** CLI 模型解析结果 */
export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * 适合 CLI 显示的错误消息。
	 * 设置时 model 为 undefined。
	 */
	error: string | undefined;
}

/**
 * 从 CLI 参数解析单个模型。
 *
 * 支持的格式：
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - 模糊匹配（与模型作用域相同的规则：精确 ID、部分 ID/名称匹配）
 *
 * 注意：此函数不会直接应用思考级别，但会解析并返回 "<pattern>:<thinking>" 中的
 * 思考级别，由调用者负责应用。
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: ModelRegistry;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// 重要：此处使用*所有*模型，不仅限于已配置认证的模型。
	// 这允许 "--api-key" 用于首次设置。
	const availableModels = modelRegistry.getAll();
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	// 构建规范化的 provider 查找表（不区分大小写）
	const providerMap = new Map<string, string>();
	for (const m of availableModels) {
		providerMap.set(m.provider.toLowerCase(), m.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	// 如果没有显式 --provider，先尝试将输入解释为 "provider/model" 格式。
	// 当第一个斜杠前的前缀匹配已知 provider 时，优先使用该解释。
	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	// 如果未从斜杠推断出 provider，尝试不进行 provider 推断的精确匹配。
	// 这处理了模型 ID 自然包含斜杠的情况（如 OpenRouter 风格的 ID）。
	if (!provider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
	}

	if (cliProvider && provider) {
		// 如果同时提供了 --provider 和 --model，容忍 --model 中的 provider 前缀（剥离它）
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	const candidates = provider ? availableModels.filter((m) => m.provider === provider) : availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		return { model, thinkingLevel, warning, error: undefined };
	}

	// 如果从斜杠推断了 provider 但在该 provider 内未找到匹配，
	// 回退到将完整输入作为原始模型 ID 跨所有模型匹配。
	// 这处理了 OpenRouter 风格的 ID（如 "openai/gpt-4o:extended"），其中 "openai"
	// 看起来像 provider 但完整字符串实际上是 openrouter 上的模型 ID。
	if (inferredProvider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		// 同时尝试将完整输入通过 parseModelPattern 对所有模型进行匹配
		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	if (provider) {
		const fallbackModel = buildFallbackModel(provider, pattern, availableModels);
		if (fallbackModel) {
			const fallbackWarning = warning
				? `${warning} Model "${pattern}" not found for provider "${provider}". Using custom model id.`
				: `Model "${pattern}" not found for provider "${provider}". Using custom model id.`;
			return { model: fallbackModel, thinkingLevel: undefined, warning: fallbackWarning, error: undefined };
		}
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}

/** 初始模型选择结果 */
export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * 按优先级确定会话的初始模型：
 * 1. CLI 参数（--provider + --model）
 * 2. 作用域模型列表中的第一个（非继续/恢复会话时）
 * 3. 从会话恢复的模型（继续/恢复会话时）
 * 4. 设置中保存的默认模型
 * 5. 第一个有有效 API key 的可用模型
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelRegistry: ModelRegistry;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelRegistry,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. CLI 参数优先级最高
	if (cliProvider && cliModel) {
		const resolved = resolveCliModel({
			cliProvider,
			cliModel,
			modelRegistry,
		});
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
		}
	}

	// 2. 使用作用域模型列表中的第一个（继续/恢复会话时跳过）
	if (scopedModels.length > 0 && !isContinuing) {
		return {
			model: scopedModels[0].model,
			thinkingLevel: scopedModels[0].thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 3. 尝试设置中保存的默认模型
	if (defaultProvider && defaultModelId) {
		const found = modelRegistry.find(defaultProvider, defaultModelId);
		if (found) {
			model = found;
			if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. 尝试第一个有有效 API key 的可用模型
	const availableModels = await modelRegistry.getAvailable();

	if (availableModels.length > 0) {
		// 尝试从已知 provider 中查找默认模型
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				return { model: match, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
			}
		}

		// 无默认模型，使用第一个可用模型
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. 无可用模型
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * 从会话恢复模型，带降级逻辑。
 * 如果保存的模型不再可用或无认证配置，回退到当前模型或第一个可用模型。
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRegistry: ModelRegistry,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRegistry.find(savedProvider, savedModelId);

	// 检查恢复的模型是否存在且仍有认证配置
	const hasConfiguredAuth = restoredModel ? modelRegistry.hasConfiguredAuth(restoredModel) : false;

	if (restoredModel && hasConfiguredAuth) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// 模型未找到或无 API key——降级
	const reason = !restoredModel ? "model no longer exists" : "no auth configured";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// 如果已有模型，将其作为降级选项
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// 尝试查找任何可用模型
	const availableModels = await modelRegistry.getAvailable();

	if (availableModels.length > 0) {
		// 尝试从已知 provider 中查找默认模型作为降级
		let fallbackModel: Model<Api> | undefined;
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				fallbackModel = match;
				break;
			}
		}

		// 无默认模型，使用第一个可用模型
		if (!fallbackModel) {
			fallbackModel = availableModels[0];
		}

		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// 无可用模型
	return { model: undefined, fallbackMessage: undefined };
}
