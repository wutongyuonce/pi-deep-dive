import type { Api, ImagesApi, ImagesModel, Model, ProviderEnv } from "../types.ts";
import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

/** 认证解析时的可选覆盖参数：允许调用方临时注入 API key 或 provider 环境变量。 */
export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
}

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/** 认证解析支持的模型形态：chat 模型或图像生成模型。 */
export type AuthModel = Model<Api> | ImagesModel<ImagesApi>;

/**
 * 认证解析入口
 *
 * 文件定位：Models 和 ImagesModels 集合共用的认证解析核心。每个请求发起前，
 * Models.getAuth() 调用此函数获取请求所需的 auth、env 和 source 信息。
 *
 * 解析优先级：
 * 1. 调用方覆盖（overrides.apiKey / env）—— 临时注入，不走存储
 * 2. 存储的 credential —— 已持久化的 api_key 或 OAuth token
 * 3. 环境认证（环境变量、AWS profiles、ADC 文件等）—— 仅在无存储 credential 时使用
 *
 * 关键设计：
 * - 存储的 credential 拥有 provider：有存储就不会回退到环境变量
 * - OAuth 过期 token 的刷新在此函数内部通过 credentialStore.modify 完成，
 *   使用双重检查锁定模式避免并发请求重复刷新
 *
 * 被谁调用：
 *   - Models.getAuth()
 *   - ImagesModels.getAuth()
 *
 * 调用了谁：
 *   - readCredential()
 *   - resolveApiKey()
 *   - resolveStoredOAuth()
 *   - overlayEnvAuthContext()
 *
 * @param provider provider 定义（含 auth 配置）
 * @param model 请求对应的模型信息
 * @param credentials credential 存储实例
 * @param authContext 认证上下文（环境变量、文件系统访问）
 * @param overrides 可选的调用方覆盖参数
 * @returns 解析成功的 AuthResult，或 undefined 表示未配置
 */
export async function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	model: AuthModel,
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	// 如有 env 覆盖，将覆盖层应用到 authContext，使覆盖值优先于原始环境变量。
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	// 第一优先级：调用方通过 overrides 注入的 apiKey，跳过存储和环境。
	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(requestAuthContext, provider.auth.apiKey, model, {
			type: "api_key",
			key: overrides.apiKey,
			env: overrides.env,
		});
	}

	// 第二优先级：从存储中读取 credential。
	const stored = await readCredential(credentials, provider.id);
	if (stored) {
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(credentials, provider.id, provider.auth.oauth, stored);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			// 如有 env 覆盖，合并到 credential 的 env 中，使覆盖值优先。
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, model, credential);
		}
		return undefined;
	}

	// 第三优先级：无存储 credential 时，回退到环境认证（仅 apiKey 路径）。
	return provider.auth.apiKey ? resolveApiKey(requestAuthContext, provider.auth.apiKey, model, undefined) : undefined;
}

/** 将覆盖层的 env 叠加到基础 AuthContext 上：覆盖值优先，未覆盖的 key 回退到原始 env。 */
function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

/**
 * 存储的 OAuth credential 解析
 *
 * 定位：resolveProviderAuth 的内部辅助函数。处理已存储的 OAuth credential 的
 * 验证与自动刷新。
 *
 * 双重检查锁定模式：
 * 1. 乐观检查：如果 token 未过期，直接使用，零锁开销
 * 2. 如果过期：进入 credentialStore.modify 锁，在锁内重新检查过期时间
 *    - 如果已被其他请求/进程刷新，跳过刷新
 *    - 否则执行 OAuth refresh，更新存储，释放锁
 * 3. 锁外使用最终 credential 推导请求 auth
 *
 * 被谁调用：
 *   - resolveProviderAuth()
 *
 * 调用了谁：
 *   - credentialStore.modify()
 *   - oauth.refresh()
 *   - oauth.toAuth()
 *
 * @param credentials credential 存储
 * @param providerId provider 标识
 * @param oauth OAuth 认证配置
 * @param stored 当前存储的 OAuth credential
 * @returns 解析成功的 AuthResult，或 undefined 表示已登出
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
): Promise<AuthResult | undefined> {
	let credential = stored;

	// 乐观过期检查：未过期直接跳过锁。
	if (Date.now() >= credential.expires) {
		// 已过期的判断来自锁外，需要在锁内做权威检查。
		let post: Credential | undefined;
		try {
			post = await credentials.modify(providerId, async (current) => {
				// 登出场景：credential 类型已变，放弃刷新。
				if (current?.type !== "oauth") return undefined;
				// 双重检查：锁内再次判断过期，避免重复刷新。
				if (Date.now() < current.expires) return undefined;
				try {
					return await oauth.refresh(current);
				} catch (error) {
					throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
				}
			});
		} catch (error) {
			if (error instanceof ModelsError) throw error;
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		// 锁内返回非 oauth 类型表示登出，放弃本次解析。
		if (post?.type !== "oauth") return undefined;
		credential = post;
	}

	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

/**
 * API key 认证解析
 *
 * 定位：resolveProviderAuth 的内部辅助函数。将 apiKey auth 的解析委托给
 * provider 提供的 resolve 方法，统一错误包装。
 *
 * 被谁调用：
 *   - resolveProviderAuth()
 *
 * 调用了谁：
 *   - apiKey.resolve()
 */
async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	model: AuthModel,
	credential: ApiKeyCredential | undefined,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ model, ctx: authContext, credential });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${model.provider}`, { cause: error });
	}
}

/**
 * 从 credential 存储中读取指定 provider 的 credential。
 *
 * 定位：resolveProviderAuth 的内部辅助函数。将读取操作包装为统一的 ModelsError。
 *
 * @returns 存储的 credential，或 undefined 表示不存在
 */
async function readCredential(credentials: CredentialStore, providerId: string): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId);
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
