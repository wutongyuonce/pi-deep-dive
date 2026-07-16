import type { Credential, CredentialStore } from "./types.ts";

/**
 * 默认的内存凭证存储
 *
 * 文件定位：实现 CredentialStore 接口的默认内存版本。应用层可注入持久化存储替代它。
 *
 * 功能概述：
 * - 以 Provider.id 为键，每个 provider 最多持有一个 credential
 * - 写操作通过 Promise 链按 provider 串行化，保证同一 provider 的并发写入不会冲突
 * - delete 也与 modify 串行化，保证登出操作不会与并发刷新产生竞态
 *
 * 典型调用链：
 *   Models.getAuth() → resolveProviderAuth() → credentialStore.read / .modify
 *   App login → credentialStore.modify(provider.id, () => newCredential)
 */
export class InMemoryCredentialStore implements CredentialStore {
	private credentials = new Map<string, Credential>();
	private chains = new Map<string, Promise<unknown>>();

	/**
	 * 按 provider 串行化异步任务。
	 *
	 * 定位：所有写操作的底层串行化原语。每个 provider 维护一个 Promise 链尾部，
	 * 新任务等待前一个 Promise settled（无论成败）后再执行。
	 *
	 * 被谁调用：
	 *   - this.modify()
	 *   - this.delete()
	 *
	 * @param providerId 要串行化的 provider 标识
	 * @param task 要执行的任务
	 * @returns task 的返回值
	 */
	private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = (async () => {
			// 等待前一个任务结束（包括失败），保证串行顺序不会被异常打断。
			await previous.catch(() => {});
			return task();
		})();
		// 将链尾推进到当前任务，链尾始终 catch 以避免未处理的 rejection。
		this.chains.set(
			providerId,
			next.catch(() => {}),
		);
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.credentials.get(providerId);
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.enqueue(providerId, async () => {
			const current = this.credentials.get(providerId);
			const next = await fn(current);
			// fn 返回 undefined 表示不修改，保持原值不变。
			if (next !== undefined) this.credentials.set(providerId, next);
			return next ?? current;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.enqueue(providerId, async () => {
			this.credentials.delete(providerId);
		});
	}
}
