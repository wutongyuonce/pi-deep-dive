/**
 * API 密钥凭证存储模块
 *
 * 管理 auth.json 文件中的 API 密钥凭证的加载、保存和查询。
 * 使用文件锁（proper-lockfile）防止多个 pi 实例并发更新凭证时产生竞态条件。
 *
 * 支持多级密钥查找优先级：
 *   1. 运行时覆盖（CLI --api-key 参数）
 *   2. auth.json 中存储的密钥
 *   3. 环境变量
 *   4. 回退解析器（models.json 自定义提供商）
 *
 * 提供 FileAuthStorageBackend（文件持久化）和 InMemoryAuthStorageBackend（内存）两种后端。
 */

import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

/** API 密钥凭证类型 */
export type ApiKeyCredential = {
	type: "api_key";
	/** 密钥值（可能是明文或配置引用） */
	key: string;
};

/** 认证凭证联合类型（目前仅有 api_key） */
export type AuthCredential = ApiKeyCredential;

/** 认证存储数据结构：提供商名称 -> 凭证 */
export type AuthStorageData = Record<string, AuthCredential>;

/**
 * 认证状态描述
 * 用于在不暴露密钥值的情况下报告认证配置情况。
 */
export type AuthStatus = {
	/** 是否已配置认证 */
	configured: boolean;
	/** 认证来源 */
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	/** 来源标签（如环境变量名、"--api-key" 等） */
	label?: string;
};

/**
 * 加锁操作的返回结果
 * @typeParam T 操作结果类型
 */
type LockResult<T> = {
	/** 操作返回值 */
	result: T;
	/** 如果需要更新存储内容，传入新的文件内容；undefined 表示不更新 */
	next?: string;
};

/**
 * 认证存储后端接口
 * 定义了同步和异步两种加锁读写操作，确保凭证读写的原子性。
 */
export interface AuthStorageBackend {
	/**
	 * 同步加锁操作
	 * @param fn 操作函数，接收当前存储内容，返回结果和可选的新内容
	 */
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	/**
	 * 异步加锁操作
	 * @param fn 操作函数，接收当前存储内容，返回结果和可选的新内容
	 */
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

/**
 * 基于文件的认证存储后端
 * 通过 proper-lockfile 实现文件锁，确保多进程并发安全。
 * 文件权限设置为 0o600（仅所有者可读写），目录权限为 0o700。
 */
export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	/**
	 * @param authPath 认证文件路径，默认为 ~/.pi/agent/auth.json
	 */
	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	/** 确保认证文件的父目录存在 */
	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	/** 确保认证文件存在，不存在则创建空 JSON 文件并设置权限 */
	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}
	}

	/**
	 * 同步获取文件锁（带重试）
	 * @param path 要锁定的文件路径
	 * @returns 释放锁的函数
	 */
	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// 同步睡眠，避免将调用方改为异步
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

/**
 * 基于内存的认证存储后端（用于测试）
 * 不进行文件持久化，所有数据保存在内存中。
 */
export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * 认证存储主类
 * 封装凭证的增删改查操作，支持多级密钥查找和运行时覆盖。
 * 使用 AuthStorageBackend 接口实现可插拔的存储后端。
 */
export class AuthStorage {
	/** 从持久化存储加载的凭证数据 */
	private data: AuthStorageData = {};
	/** 运行时临时覆盖（如 CLI --api-key），不持久化 */
	private runtimeOverrides: Map<string, string> = new Map();
	/** 回退密钥解析器（如 models.json 自定义提供商） */
	private fallbackResolver?: (provider: string) => string | undefined;
	/** 加载时的错误（如有） */
	private loadError: Error | null = null;
	/** 累积的运行时错误 */
	private errors: Error[] = [];
	/** 存储后端实例 */
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	/** 创建基于文件的 AuthStorage 实例 */
	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	/** 从指定存储后端创建 AuthStorage 实例 */
	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	/** 创建内存中的 AuthStorage 实例（用于测试），可传入初始数据 */
	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * 设置运行时 API 密钥覆盖（不持久化到磁盘）
	 * 用于 CLI --api-key 参数
	 * @param provider 提供商名称
	 * @param apiKey API 密钥
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * 移除运行时 API 密钥覆盖
	 * @param provider 提供商名称
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * 设置回退密钥解析器
	 * 用于在 auth.json 和环境变量中找不到密钥时，从 models.json 自定义提供商配置中查找。
	 * @param resolver 接收提供商名称，返回密钥或 undefined
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	/** 记录运行时错误 */
	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	/** 解析存储内容为 AuthStorageData */
	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/**
	 * 从存储后端重新加载凭证
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	/** 将单个提供商的凭证变更持久化到存储 */
	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * 获取指定提供商的凭证
	 * @param provider 提供商名称
	 * @returns 凭证对象，不存在则返回 undefined
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * 设置指定提供商的凭证（同时持久化）
	 * @param provider 提供商名称
	 * @param credential 凭证对象
	 */
	set(provider: string, credential: AuthCredential): void {
		this.data[provider] = credential;
		this.persistProviderChange(provider, credential);
	}

	/**
	 * 移除指定提供商的凭证（同时持久化）
	 * @param provider 提供商名称
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * 列出所有已配置凭证的提供商
	 * @returns 提供商名称数组
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * 检查 auth.json 中是否存在指定提供商的凭证
	 * @param provider 提供商名称
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * 检查指定提供商是否有任何形式的认证配置
	 * 与 getApiKey() 不同，此方法仅报告是否存在某种认证来源，不获取实际密钥。
	 * @param provider 提供商名称
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * 获取认证状态（不暴露密钥值或刷新令牌）
	 * @param provider 提供商名称
	 * @returns 认证状态描述
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.data[provider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		return { configured: false };
	}

	/** 获取所有存储的凭证（浅拷贝） */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	/** 消费并清空累积的运行时错误 */
	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * 登出指定提供商（移除凭证）
	 * @param provider 提供商名称
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * 获取指定提供商的 API 密钥
	 * 查找优先级：
	 *   1. 运行时覆盖（CLI --api-key）
	 *   2. auth.json 中的存储密钥
	 *   3. 环境变量
	 *   4. 回退解析器（models.json 自定义提供商）
	 *
	 * @param providerId 提供商标识
	 * @param options 选项；includeFallback 为 false 时不查找回退解析器
	 * @returns API 密钥字符串，未找到返回 undefined
	 */
	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		// 运行时覆盖优先级最高
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		// 回退到环境变量
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// 回退到自定义解析器（如 models.json 自定义提供商）
		if (options?.includeFallback !== false) {
			return this.fallbackResolver?.(providerId) ?? undefined;
		}

		return undefined;
	}
}
