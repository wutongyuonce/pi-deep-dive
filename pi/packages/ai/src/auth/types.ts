import type { Api, ImagesApi, ImagesModel, Model, ProviderEnv, ProviderHeaders } from "../types.ts";
import type { OAuthCredentials } from "../utils/oauth/types.ts";

/**
 * 单次模型请求的认证信息。如果某个值无法用 apiKey、headers 或 baseUrl 表达，
 * 说明它属于 provider 配置而非认证。
 */
export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

/**
 * 存储的 api-key credential。
 * env 持有 provider 级别的环境/配置值，例如 Cloudflare 的 account/gateway id。
 */
export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

/** 存储的 OAuth credential（access、refresh、expires 来自 OAuthCredentials）。 */
export interface OAuthCredential extends OAuthCredentials {
	type: "oauth";
}

/** 每个 provider 最多一种类型的 credential —— 相当于当前 auth.json 的结构。 */
export type Credential = ApiKeyCredential | OAuthCredential;

/**
 * 应用层持有的 credential 存储，按 Provider.id 为键，每个 provider 一个 credential。
 *
 * modify 是唯一的写入路径，每一次变更都是串行化的 read-modify-write 操作。
 * Models.getAuth() 在 modify 内部执行 OAuth 刷新，确保并发请求不会重复刷新已轮换的 token。
 * 应用层在登录后通过 `modify(provider.id, async () => credential)` 持久化 credential。
 * 登录/登出的编排由应用层负责。
 *
 * 错误语义：
 * - read 在 key 不存在时返回 undefined
 * - 方法仅在存储失败时 reject；Models 会将此类 rejection 包装为 code="auth" 的 ModelsError
 * - 最佳实践实现（如 coding-agent 的 AuthStorage）可在内部记录持久化错误，同时继续提供内存视图
 */
export interface CredentialStore {
	/**
	 * 读取存储的 credential，可能已过期。用于展示/状态查询；
	 * 解析后的请求 auth 来自 Models.getAuth()。
	 */
	read(providerId: string): Promise<Credential | undefined>;

	/**
	 * 串行化写入 —— 唯一的写路径。fn 接收当前 credential（因为正确的写入如刷新、
	 * 刷新期间的登录操作都依赖当前值）；返回新 credential，或返回 undefined 保持
	 * 原值不变。每个 provider 互斥（跨进程也互斥，前提是底层存储支持，如文件锁）。
	 * 返回写入后的 credential。fn 抛出的异常会向外传播。
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined>;

	/** 删除 credential（登出）。实现需与 modify 串行化。 */
	delete(providerId: string): Promise<void>;
}

/** 认证解析的环境访问抽象。可注入以便测试和浏览器环境使用。 */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	/** 检查文件是否存在。支持 ~ 前缀。浏览器中始终返回 false。 */
	fileExists(path: string): Promise<boolean>;
}

/** 模型认证解析的结果。 */
export interface AuthResult {
	auth: ModelAuth;
	/** 从 credential 和环境上下文解析出的 provider 级环境/配置值。 */
	env?: ProviderEnv;
	/** 供状态 UI 展示的人类可读标签：如 "ANTHROPIC_API_KEY"、"OAuth"、"~/.aws/credentials"。 */
	source?: string;
}

/**
 * 登录过程中展示给用户的提示。
 *
 * signal 允许流程在带外事件解决当前步骤时取消待处理的 prompt，
 * 例如：manual_code 类型的 prompt 与回调服务器竞争，当回调胜出时取消 prompt。
 */
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

/** 登录过程中发生的事件，实现层通过 notify 回调分发给 UI 层。 */
export type AuthEvent =
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/**
 * 登录交互回调，同时服务于 api-key 和 OAuth 两种流程。
 *
 * prompt() 返回用户输入/选择的字符串（select 返回选项 id）。取消/中止时 reject。
 * signal 会中止整个登录流程；单个 prompt 的取消通过 AuthPrompt.signal 实现。
 */
export interface AuthLoginCallbacks {
	signal?: AbortSignal;

	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

/**
 * Api-key 认证：存储的 key/provider env 加上环境来源（环境变量、AWS profiles、
 * ADC 文件）。仅环境认证的 provider 不提供 login。
 */
export interface ApiKeyAuth {
	/** 显示名称，如 "Anthropic API key"。 */
	name: string;

	/** 交互式设置（提示输入 key/provider env）。不存在表示仅支持环境认证。 */
	login?(callbacks: AuthLoginCallbacks): Promise<ApiKeyCredential>;

	/**
	 * 从存储的 credential 和/或环境来源解析认证信息，逐字段合并
	 *（credential.key ?? env("...")，credential.env?.NAME ?? env("...")）。
	 * undefined 表示未配置。接收请求对应的 chat 或图像生成模型（两者都携带 provider 和 baseUrl）。
	 */
	resolve(input: {
		model: Model<Api> | ImagesModel<ImagesApi>;
		ctx: AuthContext;
		credential?: ApiKeyCredential;
	}): Promise<AuthResult | undefined>;
}

/**
 * OAuth 认证。
 *
 * refresh / toAuth 的拆分设计让 Models 拥有锁定的刷新模式：
 * refresh 产生 credential，toAuth 从最终存储的 credential 推导请求 auth。
 */
export interface OAuthAuth {
	/** 显示名称，如 "Anthropic (Claude Pro/Max)"。 */
	name: string;

	login(callbacks: AuthLoginCallbacks): Promise<OAuthCredential>;

	/**
	 * 交换 refresh token。网络调用；失败时抛出异常（如 invalid_grant）。
	 * Models 在存储锁内调用此方法。
	 */
	refresh(credential: OAuthCredential): Promise<OAuthCredential>;

	/**
	 * 从有效 credential 无副作用地推导请求 auth。
	 * 覆盖每个 credential 的 baseUrl（如 GitHub Copilot）。
	 * 异步以便延迟包装器在首次使用时加载实现。
	 */
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * Provider 认证配置。
 * apiKey 和 oauth 至少提供一个：即使是仅环境认证的 provider 和无需 key 的本地服务器，
 * 也提供 apiKey auth，其 resolve() 用于报告 provider 是否已配置。
 */
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
	oauth?: OAuthAuth;
}
