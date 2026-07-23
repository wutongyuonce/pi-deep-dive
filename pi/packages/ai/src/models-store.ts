/**
 * Provider 模型目录的持久化抽象。
 *
 * 文件定位：为 `Models.refresh()` 与动态 Provider 提供按 provider ID 隔离的模型缓存。
 *
 * 调用链：
 *   Models.refresh() → ProviderModelsStore → ModelsStore → 内存或宿主注入的文件存储
 */
import type { Api, Model } from "./types.ts";

/** 单个 provider 的已缓存模型目录及其远端检查元数据。 */
export interface ModelsStoreEntry {
	models: readonly Model<Api>[];
	/** 远端目录 Last-Modified 响应头对应的 Unix 时间戳。 */
	lastModified?: number;
	/** 最近一次完成远端检查的 Unix 时间戳。 */
	checkedAt?: number;
}

/**
 * 由宿主实现的持久化模型目录接口。
 *
 * `pi-ai` 只依赖这三个异步操作；`coding-agent` 可据此替换为文件存储，测试和轻量宿主可使用内存实现。
 */
export interface ModelsStore {
	read(providerId: string): Promise<ModelsStoreEntry | undefined>;
	write(providerId: string, entry: ModelsStoreEntry): Promise<void>;
	delete(providerId: string): Promise<void>;
}

/**
 * 限定到单一 provider 的存储视图。
 *
 * `Models.refresh()` 创建该适配器后才交给 `Provider.refreshModels()`，避免 provider 读取或覆盖其他 provider 的缓存。
 */
export interface ProviderModelsStore {
	read(): Promise<ModelsStoreEntry | undefined>;
	write(entry: ModelsStoreEntry): Promise<void>;
	delete(): Promise<void>;
}

/**
 * 默认的进程内模型目录存储。
 *
 * 适用于测试和不需要跨进程保留目录的宿主；读写都使用 `structuredClone()`，防止调用方通过引用修改内部缓存。
 */
export class InMemoryModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		// 返回副本，避免动态 provider 直接修改缓存中的 models 数组或元数据。
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		// 写入时同样复制，令存储边界不泄漏可变引用。
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string): Promise<void> {
		this.entries.delete(providerId);
	}
}
