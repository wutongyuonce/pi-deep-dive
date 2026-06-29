/**
 * footer-data-provider.ts - 底栏状态数据聚合器
 *
 * 定位：interactive 模式底部状态栏的数据源实现，处于 UI 展示层和 git/扩展状态之间。
 *
 * 作用：
 * - 提供当前 git 分支名
 * - 提供扩展自定义状态文本
 * - 提供可用模型 provider 数量等 UI 统计值
 *
 * 调用关系：
 * - 被 interactive 模式的 footer 视图持有
 * - 被扩展 UI 上下文写入状态文案
 * - 内部通过文件监视器感知 git 元数据变化
 */

import { type ExecFileException, execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, statSync, unwatchFile, watchFile } from "fs";
import { dirname, join, resolve } from "path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.ts";

/** git 元数据路径信息 */
type GitPaths = {
	/** 仓库根目录 */
	repoDir: string;
	/** 通用 git 目录（worktree 模式下可能与 repoDir 不同） */
	commonGitDir: string;
	/** HEAD 文件路径 */
	headPath: string;
};

/**
 * 从 cwd 向上查找 git 元数据路径
 * 同时处理普通 git 仓库（.git 是目录）和 worktree（.git 是文件指向 gitdir）
 * @param cwd 起始搜索目录
 * @returns git 路径信息，不在 git 仓库中则返回 null
 */
function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * 同步调用 git 获取当前分支名
 * @param repoDir git 仓库目录
 * @returns 分支名，detached HEAD 或 git 不可用时返回 null
 */
function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/**
 * 异步调用 git 获取当前分支名
 * @param repoDir git 仓库目录
 * @returns 分支名，detached HEAD 或 git 不可用时返回 null
 */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

/**
 * 底部数据提供者
 * 提供 git 分支和扩展状态数据——这些数据无法通过扩展 API 直接获取。
 * 令牌统计、模型信息等可通过 ctx.sessionManager 和 ctx.model 获取。
 */
export class FooterDataProvider {
	private cwd: string;
	/** 分支变更监视防抖延迟（毫秒） */
	private static readonly WATCH_DEBOUNCE_MS = 500;

	/** 扩展状态文本映射（key -> 状态文本） */
	private extensionStatuses = new Map<string, string>();
	/** 缓存的分支名（undefined 表示未初始化） */
	private cachedBranch: string | null | undefined = undefined;
	/** git 元数据路径 */
	private gitPaths: GitPaths | null | undefined = undefined;
	/** HEAD 文件变更监视器 */
	private headWatcher: FSWatcher | null = null;
	/** reftable 目录监视器 */
	private reftableWatcher: FSWatcher | null = null;
	/** reftable/tables.list 文件监视器 */
	private reftableTablesListWatcher: FSWatcher | null = null;
	/** reftable/tables.list 路径（用于 watchFile 回退） */
	private reftableTablesListPath: string | null = null;
	/** 分支变更回调集合 */
	private branchChangeCallbacks = new Set<() => void>();
	/** 可用模型提供商数量 */
	private availableProviderCount = 0;
	/** 防抖刷新定时器 */
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	/** git 监视器重试定时器 */
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	/** 是否有正在进行的异步刷新 */
	private refreshInFlight = false;
	/** 是否有待处理的刷新请求 */
	private refreshPending = false;
	/** 是否已销毁 */
	private disposed = false;

	/**
	 * @param cwd 当前工作目录
	 */
	constructor(cwd: string) {
		this.cwd = cwd;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
	}

	/**
	 * 获取当前 git 分支名
	 * @returns 分支名；不在 git 仓库中返回 null；detached HEAD 返回 "detached"
	 */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** 获取扩展状态文本（通过 ctx.ui.setStatus() 设置） */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/**
	 * 订阅 git 分支变更事件
	 * @param callback 分支变更时的回调函数
	 * @returns 取消订阅函数
	 */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** 设置扩展状态（内部使用） */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** 清除所有扩展状态（内部使用） */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** 获取可用模型提供商数量（用于底部栏显示） */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** 更新可用提供商数量（内部使用） */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	/** 更新工作目录，重新查找 git 仓库并设置文件监视器 */
	setCwd(cwd: string): void {
		if (this.cwd === cwd) {
			return;
		}

		this.cwd = cwd;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.cachedBranch = undefined;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.notifyBranchChange();
	}

	/** 销毁实例，清除所有监视器和回调 */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.branchChangeCallbacks.clear();
	}

	/** 通知所有订阅者分支已变更 */
	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	/** 调度防抖刷新（在 HEAD 文件变更后触发） */
	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	/**
	 * 异步刷新缓存中的分支名。
	 *
	 * 定位：文件监视触发后的实际刷新执行器。
	 * 作用：串行化异步刷新，避免并发读取，并在分支变更时通知订阅者。
	 * 调用关系：由 `scheduleRefresh()` 触发。
	 */
	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			if (this.disposed) return;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	/**
	 * 同步解析当前分支名。
	 *
	 * 定位：首次渲染和同步读取路径的解析入口。
	 * 作用：优先直接解析 `HEAD`，在 reftable 的特殊占位场景下回退到 git 命令。
	 * 调用关系：被 `getGitBranch()` 调用。
	 */
	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	/**
	 * 异步解析当前分支名。
	 *
	 * 定位：监视器驱动刷新时的分支解析入口。
	 * 作用：与同步版本保持同样的判定规则，但通过异步 git 调用避免阻塞刷新链路。
	 * 调用关系：被 `refreshGitBranchAsync()` 调用。
	 */
	private async resolveGitBranchAsync(): Promise<string | null> {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid"
					? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private clearGitWatchers(): void {
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		closeWatcher(this.reftableTablesListWatcher);
		this.reftableTablesListWatcher = null;
		if (this.reftableTablesListPath) {
			unwatchFile(this.reftableTablesListPath);
			this.reftableTablesListPath = null;
		}
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	private scheduleGitWatcherRetry(): void {
		if (this.disposed || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.setupGitWatcher();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	/**
	 * 建立 git 元数据监视器。
	 *
	 * 定位：git 状态感知链路的初始化入口。
	 * 作用：监视 `HEAD` 所在目录以及 reftable 相关文件，在变更时触发防抖刷新。
	 * 调用关系：构造函数、`setCwd()` 和 watcher 重试逻辑都会调用它。
	 */
	private setupGitWatcher(): void {
		this.clearGitWatchers();
		if (!this.gitPaths) return;

		// 监视包含 HEAD 的目录而非 HEAD 文件本身。
		// Git 使用原子写入（先写临时文件再重命名覆盖 HEAD），这会改变 inode。
		// fs.watch 监视文件时在 inode 变更后会停止工作。
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				if (!filename || filename === "HEAD") {
					this.scheduleRefresh();
				}
			},
			() => this.handleGitWatcherError(),
		);
		if (!this.headWatcher) {
			return;
		}

		// 在 reftable 格式的仓库中，分支切换更新的是 reftable 目录中的文件而非 HEAD。
		// 需要单独监视该目录以捕获这些变更。
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				() => {
					this.scheduleRefresh();
				},
				() => this.handleGitWatcherError(),
			);
			if (!this.reftableWatcher) {
				return;
			}

			const tablesListPath = join(reftableDir, "tables.list");
			if (existsSync(tablesListPath)) {
				this.reftableTablesListPath = tablesListPath;
				this.reftableTablesListWatcher = watchWithErrorHandler(
					tablesListPath,
					() => {
						this.scheduleRefresh();
					},
					() => this.handleGitWatcherError(),
				);
				if (!this.reftableTablesListWatcher) {
					return;
				}
				watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
					if (
						current.mtimeMs !== previous.mtimeMs ||
						current.ctimeMs !== previous.ctimeMs ||
						current.size !== previous.size
					) {
						this.scheduleRefresh();
					}
				});
			}
		}
	}
}

/** 只读视图——供扩展使用，排除了 setExtensionStatus、setAvailableProviderCount 和 dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
