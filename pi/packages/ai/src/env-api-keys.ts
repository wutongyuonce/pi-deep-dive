/**
 * 环境变量与环境凭证解析工具。
 *
 * 文件定位：
 * - 这是 provider 认证层的环境读取辅助模块
 * - 负责从显式环境变量、Vertex ADC、Bedrock 环境凭证等来源判断某个 provider 是否“已配置”
 *
 * 核心职责：
 * - 维护 provider -> 环境变量名 的映射
 * - 查找当前已配置的 API key 环境变量
 * - 为支持环境凭证的 provider 返回统一的“已认证”标记
 *
 * 说明：
 * - 这里刻意不用顶层 `node:*` 导入，避免破坏 browser / Vite 构建
 */

// 禁止转换为顶层导入 —— 会破坏 browser / Vite 构建
let _existsSync: typeof import("node:fs").existsSync | null = null;
let _homedir: typeof import("node:os").homedir | null = null;
let _join: typeof import("node:path").join | null = null;

/** 动态模块导入函数签名，用于在非 Node 环境（浏览器）中安全地按需加载 Node 内建模块 */
type DynamicImport = (specifier: string) => Promise<unknown>;

/** 通过字符串拼接绕开打包工具的静态分析，避免浏览器构建尝试打包 `node:*` 模块 */
const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_FS_SPECIFIER = "node:" + "fs";
const NODE_OS_SPECIFIER = "node:" + "os";
const NODE_PATH_SPECIFIER = "node:" + "path";

// 仅在 Node.js / Bun 环境下预先加载 Node 内建模块
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport(NODE_FS_SPECIFIER).then((m) => {
		_existsSync = (m as typeof import("node:fs")).existsSync;
	});
	dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		_homedir = (m as typeof import("node:os")).homedir;
	});
	dynamicImport(NODE_PATH_SPECIFIER).then((m) => {
		_join = (m as typeof import("node:path")).join;
	});
}

import type { KnownProvider, ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

/** Vertex ADC 凭证文件是否存在的缓存结果；`null` 表示尚未探测 */
let cachedVertexAdcCredentialsExists: boolean | null = null;

/**
 * 检查当前环境是否存在可用的 Vertex ADC 凭证。
 *
 * 定位：`google-vertex` 的环境认证探测函数。
 *
 * 说明：
 * - 优先检查显式传入的 `GOOGLE_APPLICATION_CREDENTIALS`
 * - 否则回退到 gcloud 默认的 ADC 文件路径
 * - Node 侧动态模块尚未加载完成时，不会把 `false` 永久缓存下来，避免启动早期误判
 */
function hasVertexAdcCredentials(env?: ProviderEnv): boolean {
	// 优先检查显式传入的 credentials 路径
	const explicitCredentialsPath = env?.GOOGLE_APPLICATION_CREDENTIALS;
	if (explicitCredentialsPath) {
		return _existsSync ? _existsSync(explicitCredentialsPath) : false;
	}

	// 缓存未命中时，需要探测实际文件系统
	if (cachedVertexAdcCredentialsExists === null) {
		// Node 模块尚未加载完成时（例如启动阶段的异步导入竞态），
		// 不缓存 false，下次调用时重试；仅浏览器环境才会永久缓存 false。
		if (!_existsSync || !_homedir || !_join) {
			const isNode = typeof process !== "undefined" && (process.versions?.node || process.versions?.bun);
			if (!isNode) {
				// 确认处于浏览器环境 —— 可以安全地永久缓存 false
				cachedVertexAdcCredentialsExists = false;
			}
			return false;
		}

		// 标准方式：从 GOOGLE_APPLICATION_CREDENTIALS 环境变量读取路径
		const gacPath = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
		if (gacPath) {
			cachedVertexAdcCredentialsExists = _existsSync(gacPath);
		} else {
			// 回退到 gcloud 默认 ADC 文件路径
			cachedVertexAdcCredentialsExists = _existsSync(
				_join(_homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

/**
 * 根据 provider 返回其对应的 API key 环境变量名列表。
 * 注意：对于存在多个候选环境变量的 provider（如 Anthropic），按优先级顺序返回
 *
 * 被谁调用：被 `findEnvKeys()` 调用，用于获取某个 provider 需要检查的环境变量列表
 */
function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	if (provider === "github-copilot") {
		return ["COPILOT_GITHUB_TOKEN"];
	}

	// ANTHROPIC_OAUTH_TOKEN 优先级高于 ANTHROPIC_API_KEY
	if (provider === "anthropic") {
		return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
	}

	const envMap: Record<string, string> = {
		"ant-ling": "ANT_LING_API_KEY",
		openai: "OPENAI_API_KEY",
		"azure-openai-responses": "AZURE_OPENAI_API_KEY",
		nvidia: "NVIDIA_API_KEY",
		deepseek: "DEEPSEEK_API_KEY",
		google: "GEMINI_API_KEY",
		"google-vertex": "GOOGLE_CLOUD_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		zai: "ZAI_API_KEY",
		"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
		mistral: "MISTRAL_API_KEY",
		minimax: "MINIMAX_API_KEY",
		"minimax-cn": "MINIMAX_CN_API_KEY",
		moonshotai: "MOONSHOT_API_KEY",
		"moonshotai-cn": "MOONSHOT_API_KEY",
		huggingface: "HF_TOKEN",
		fireworks: "FIREWORKS_API_KEY",
		together: "TOGETHER_API_KEY",
		opencode: "OPENCODE_API_KEY",
		"opencode-go": "OPENCODE_API_KEY",
		"kimi-coding": "KIMI_API_KEY",
		"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
		"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
		xiaomi: "XIAOMI_API_KEY",
		"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? [envVar] : undefined;
}

/**
 * `getEnvApiKey()` 的第一阶段辅助 —— 从显式 API key 环境变量中查找已配置的 key。
 * 
 * 调用了谁：
 * - `getApiKeyEnvVars()` —— 获取 provider 对应的环境变量名列表
 * - `getProviderEnvValue()` —— 检查环境变量是否有值
 */
export function findEnvKeys(provider: KnownProvider, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) return undefined;

	// 筛选出实际存在值的环境变量，丢弃空字符串或未设置的变量
	const found = envVars.filter((envVar) => !!getProviderEnvValue(envVar, env));
	return found.length > 0 ? found : undefined;
}

/**
 * provider 认证入口 —— 统一从环境变量 / 环境凭证中提取认证凭据。
 *
 * 被谁调用：
 * - 被 provider 初始化流程调用，用于判断某个 provider 是否可以无额外配置直接使用
 *
 * 调用了谁：
 * - `findEnvKeys()` —— 查找显式 API key 环境变量
 * - `getProviderEnvValue()` —— 读取环境变量值
 * - `hasVertexAdcCredentials()` —— 检查 Google Vertex ADC 凭证
 *
 * 返回约定：
 * - 普通 API key provider：返回实际 key
 * - 依赖环境凭证的 provider：返回 `"<authenticated>"`
 * - 未配置：返回 `undefined`
 */
export function getEnvApiKey(provider: KnownProvider, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	// 第一阶段：查找显式 API key 环境变量
	const envKeys = findEnvKeys(provider, env);
	if (envKeys?.[0]) {
		return getProviderEnvValue(envKeys[0], env);
	}

	// Vertex AI 既支持显式 API key，也支持 gcloud 的 Application Default Credentials。
	// 第二阶段：google-vertex 的 ADC 凭证回退
	if (provider === "google-vertex") {
		const hasCredentials = hasVertexAdcCredentials(env);
		const hasProject = !!(
			getProviderEnvValue("GOOGLE_CLOUD_PROJECT", env) || getProviderEnvValue("GCLOUD_PROJECT", env)
		);
		const hasLocation = !!getProviderEnvValue("GOOGLE_CLOUD_LOCATION", env);

		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	}

	// 第三阶段：amazon-bedrock 的 AWS 环境凭证检测
	if (provider === "amazon-bedrock") {
		// Bedrock 没有单一 API key 入口，这里统一识别常见 AWS 环境凭证来源。
		if (
			getProviderEnvValue("AWS_PROFILE", env) ||
			(getProviderEnvValue("AWS_ACCESS_KEY_ID", env) && getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env)) ||
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", env) ||
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env) ||
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_FULL_URI", env) ||
			getProviderEnvValue("AWS_WEB_IDENTITY_TOKEN_FILE", env)
		) {
			return "<authenticated>";
		}
	}

	// 未找到任何认证凭证，返回 undefined
	return undefined;
}
