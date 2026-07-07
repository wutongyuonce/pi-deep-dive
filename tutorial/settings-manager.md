### 设置管理器 `core/settings-manager.ts`：全局、项目级 Settings.json

文件定位：coding-agent 的设置持久化层，负责从文件系统或内存加载 settings.json

提供：

* Settings 接口：所有可配置项的类型定义
* SettingsManager 类：设置的读取、写入、热重载、变更追踪、持久化
* FileSettingsStorage / InMemorySettingsStorage：文件和内存两种存储后端
* deepMergeSettings()：递归合并全局和项目设置（项目级优先）

调用链路：

* 被 agent 启动时创建，加载并合并全局/项目设置
* 被 TUI/CLI 各模块调用，获取/修改各项配置
* 调用 config.ts 获取 agent 目录和配置目录名
* 使用 proper-lockfile 实现文件锁，防止并发写入冲突

#### `Settings` 接口：完整的可配置维度

`settings.json` 存储结构化配置。Settings 接口定义了 pi 所有可配置的维度：

```typescript
/** 核心设置接口，定义所有可配置项 */
export interface Settings {
	// 版本与会话持久化
	lastChangelogVersion?: string;
	sessionDir?: string; // 自定义会话存储目录（与 --session-dir CLI 标志格式相同）

	// 默认模型与推理行为
	defaultProvider?: string;
	defaultModel?: string;
	enabledModels?: string[]; // 模型循环模式列表（与 --models CLI 标志格式相同）
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	thinkingBudgets?: ThinkingBudgetsSettings; // 自定义思考级别的 token 预算
	transport?: TransportSetting; // 传输层模式，默认: "auto"
	retry?: RetrySettings; // 重试设置
	httpIdleTimeoutMs?: number; // HTTP 头/体空闲超时时间（毫秒），0 表示禁用

	// 对话与运行流程
	steeringMode?: "all" | "one-at-a-time"; // 消息引导模式
	followUpMode?: "all" | "one-at-a-time"; // 跟进消息模式
	compaction?: CompactionSettings; // 压缩设置
	branchSummary?: BranchSummarySettings; // 分支摘要设置
	hideThinkingBlock?: boolean; // 是否隐藏思考过程块
	quietStartup?: boolean; // 静默启动模式
	collapseChangelog?: boolean; // 更新后显示精简 changelog（用 /changelog 查看完整版）

	// Shell 与命令执行
	shellPath?: string; // 自定义 shell 路径（如 Windows Cygwin 用户使用）
	shellCommandPrefix?: string; // 每条 bash 命令前添加的前缀（如 "shopt -s expand_aliases" 以支持别名）
	npmCommand?: string[]; // npm 包查找/安装命令，argv 格式（如 ["mise", "exec", "node@20", "--", "npm"]）

	// 外观与交互
	theme?: string;
	terminal?: TerminalSettings; // 终端显示设置
	images?: ImageSettings; // 图片处理设置
	doubleEscapeAction?: "fork" | "tree" | "none"; // 编辑器为空时双击 Escape 的操作（默认: "tree"）
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // 打开 /tree 时的默认过滤模式
	editorPaddingX?: number; // 输入编辑器的水平内边距（默认: 0）
	autocompleteMaxVisible?: number; // 自动补全下拉列表的最大可见项数（默认: 5）
	showHardwareCursor?: boolean; // 在定位终端光标以支持 IME 的同时显示硬件光标
	markdown?: MarkdownSettings; // Markdown 渲染设置
	warnings?: WarningSettings; // 警告设置

	// 资源来源与扩展能力
	packages?: PackageSource[]; // npm/git 包来源数组（字符串或带过滤器的对象）
	extensions?: string[]; // 本地扩展文件路径或目录数组
	skills?: string[]; // 本地技能文件路径或目录数组
	prompts?: string[]; // 本地提示模板文件路径或目录数组
	themes?: string[]; // 本地主题文件路径或目录数组
	enableSkillCommands?: boolean; // 是否将技能注册为 /skill:name 命令，默认: true

	// 统计与遥测
	enableInstallTelemetry?: boolean; // 是否启用安装遥测（匿名版本/更新 ping），默认: true
}
```

每个子接口和字段也值得展开看看，展示了 pi 在不同维度上提供的精细控制：

```typescript
interface CompactionSettings {
  enabled?: boolean;         // default: true
  reserveTokens?: number;    // default: 16384
  keepRecentTokens?: number; // default: 20000
}

interface BranchSummarySettings {
  reserveTokens?: number;    // default: 16384
  skipPrompt?: boolean;      // default: false
}

interface RetrySettings {
  enabled?: boolean;     // default: true
  maxRetries?: number;   // default: 3
  baseDelayMs?: number;  // default: 2000（指数退避：2s, 4s, 8s）
  maxDelayMs?: number;   // default: 60000
}

interface TerminalSettings {
  showImages?: boolean;      // default: true
  clearOnShrink?: boolean;   // default: false
}

interface ImageSettings {
  autoResize?: boolean;      // default: true（最大 2000x2000）
  blockImages?: boolean;     // default: false
}

interface ThinkingBudgetsSettings {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

interface MarkdownSettings {
  codeBlockIndent?: string;  // default: "  "
}

/** 压缩（compaction）设置 */
export interface CompactionSettings {
	enabled?: boolean; // 是否启用压缩，默认: true
	reserveTokens?: number; // 为压缩后的响应预留的 token 数，默认: 16384
	keepRecentTokens?: number; // 压缩时保留的最近对话 token 数，默认: 20000
}

/** 分支摘要设置 */
export interface BranchSummarySettings {
	reserveTokens?: number; // 为摘要提示和 LLM 响应预留的 token 数，默认: 16384
	skipPrompt?: boolean; // 为 true 时跳过"是否生成摘要"的提示，默认为不生成摘要，默认: false
}

/** Provider 级别的重试设置 */
export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider 请求超时时间（毫秒）
	maxRetries?: number; // SDK/provider 重试次数
	maxRetryDelayMs?: number; // 服务端要求的最大延迟时间，超过则失败，默认: 60000
}

/** 重试设置 */
export interface RetrySettings {
	enabled?: boolean; // 是否启用重试，默认: true
	maxRetries?: number; // 最大重试次数，默认: 3
	baseDelayMs?: number; // 指数退避基础延迟（毫秒），默认: 2000（2s → 4s → 8s）
	provider?: ProviderRetrySettings; // Provider 级别的重试设置
}

/** 终端显示设置 */
export interface TerminalSettings {
	showImages?: boolean; // 是否在终端中显示图片，默认: true（仅在终端支持时有效）
	imageWidthCells?: number; // 终端内联图片的首选宽度（以终端单元格为单位），默认: 60
	clearOnShrink?: boolean; // 内容缩小时是否清除空行，默认: false
	showTerminalProgress?: boolean; // 是否显示 OSC 9;4 终端进度指示器，默认: false
}

/** 图片处理设置 */
export interface ImageSettings {
	autoResize?: boolean; // 是否自动缩放图片至 2000x2000 最大尺寸以提高模型兼容性，默认: true
	blockImages?: boolean; // 是否阻止所有图片发送给 LLM provider，默认: false
}

/** 思考级别自定义 token 预算设置 */
export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

/** Markdown 渲染设置 */
export interface MarkdownSettings {
	codeBlockIndent?: string; // 代码块缩进字符，默认: "  "（两个空格）
}

/** 警告设置 */
export interface WarningSettings {
	anthropicExtraUsage?: boolean; // 是否显示 Anthropic 额外使用量警告，默认: true
}

/** 传输层设置类型 */
export type TransportSetting = Transport;

/**
 * 外部能力的来源配置。支持两种格式：
 * - 字符串形式：从该包加载所有资源
 * - 对象形式：可指定过滤要加载的资源类型
 */
export type PackageSource =
	| string
	| {
			source: string; // npm 包名或 git URL
			extensions?: string[]; // 只加载指定 extensions
			skills?: string[]; // 只加载指定 skills
			prompts?: string[]; // 只加载指定 prompts
			themes?: string[]; // 只加载指定 themes
	  };
```

* PackageSource 的设计让用户可以安装一个大型的能力包（比如包含 20 个 skills 的社区包），但只启用其中几个。配置示例：

  ```json
  {
    "packages": [
      "pi-community-skills",
      { "source": "pi-advanced-tools", "skills": ["tdd", "code-review"] }
    ]
  }
  ```

* 注意接口中所有字段都是 optional（`?`）。这是"渐进式定制"的基础 — 用户只需要设置自己关心的字段，其他全部使用默认值。

* 每一层的默认值都经过精心选择。比如 `retry.baseDelayMs = 2000` 配合指数退避产生 2s → 4s → 8s 的重试间隔 — 既不会因为太频繁而被 API 限流，也不会因为等太久而影响用户体验。`compaction.keepRecentTokens = 20000` 大约相当于 10-15 轮对话，足以保留足够的近期上下文。

#### `SettingsStorage` 存储后端接口和 `SettingsError` 操作错误记录接口

```ts
/** 设置的作用域：全局或项目级 */
export type SettingsScope = "global" | "project";

/** 设置操作的错误记录 */
export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

/** 设置存储后端接口 */
export interface SettingsStorage {
	/** 在锁保护下读取/写入指定作用域的设置内容 */
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

/** 基于文件系统的设置存储后端，使用 proper-lockfile 实现并发安全 */
export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	/** 获取文件锁，带重试机制（最多重试 10 次，间隔 20ms） */
	private acquireLockSyncWithRetry(path: string): () => void {...}

    // 在文件锁保护下，完成一次“读取当前设置内容 -> 让调用方决定是否修改 -> 需要时写回”的完整事务
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {...}
}
```

#### `deepMergeSettings` 设置对象的深度合并工具

作用：以全局设置为底，把项目级或临时覆盖递归叠加上去。

```ts
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	// 创建基础对象的浅拷贝作为结果容器
	const result: Settings = { ...base };

	// 遍历覆盖对象的每一个键
	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key]; // 覆盖值
		const baseValue = base[key];          // 基础值

		// 如果覆盖值为 undefined，则跳过该字段，保留基础值
		if (overrideValue === undefined) continue;

		// 判断覆盖值和基础值是否都是“普通对象”（非数组、非 null）
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			// 都是普通对象 → 执行浅合并：将覆盖对象的属性合并到基础对象上
			// 注意：这里只合并第一层，嵌套更深的对象会被直接覆盖（非递归）
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// 否则（原始类型、数组、或一方不是普通对象）→ 直接用覆盖值替换
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}
```

合并规则：

- **原始值**（string, number, boolean）：项目值覆盖全局值
- **数组**（packages, extensions, skills 等）：项目值**完全替换**全局值（不是追加）
- **嵌套对象**（compaction, retry, terminal 等）：浅层合并

#### `SettingsManager` 设置管理器：读取、写入、合并 全局和项目级设置

```ts
export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	/** 追踪会话期间修改的全局顶层字段 */
	private modifiedFields = new Set<keyof Settings>();
	/** 追踪会话期间修改的全局嵌套字段（如 compaction.enabled） */
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>();
	/** 追踪会话期间修改的项目级顶层字段 */
	private modifiedProjectFields = new Set<keyof Settings>();
	/** 追踪会话期间修改的项目级嵌套字段 */
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>();
	/** 全局设置文件加载时的解析错误（如有） */
	private globalSettingsLoadError: Error | null = null;
	/** 项目设置文件加载时的解析错误（如有） */
	private projectSettingsLoadError: Error | null = null;
	/** 异步写入队列，保证写操作顺序执行 */
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
```

##### Settings 的两级加载

`create` 从文件系统创建 SettingsManager，调用 `fromStorage()` 分别加载 global 和 project 两级配置，最终通过 `constructor` 构造函数创建了合并后的 `this.settings` 深度合并。

```typescript
/** 从文件系统创建 SettingsManager */
static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
    const storage = new FileSettingsStorage(cwd, agentDir);
    return SettingsManager.fromStorage(storage);
}

/** 从任意存储后端创建 SettingsManager */
static fromStorage(storage: SettingsStorage): SettingsManager {
    const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
    const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
    const initialErrors: SettingsError[] = [];
    if (globalLoad.error) {
        initialErrors.push({ scope: "global", error: globalLoad.error });
    }
    if (projectLoad.error) {
        initialErrors.push({ scope: "project", error: projectLoad.error });
    }

    return new SettingsManager(
        storage,
        globalLoad.settings,
        projectLoad.settings,
        globalLoad.error,
        projectLoad.error,
        initialErrors,
    );
}

private constructor(
    storage: SettingsStorage,
    initialGlobal: Settings,
    initialProject: Settings,
    globalLoadError: Error | null = null,
    projectLoadError: Error | null = null,
    initialErrors: SettingsError[] = [],
) {
    this.storage = storage;
    this.globalSettings = initialGlobal;
    this.projectSettings = initialProject;
    this.globalSettingsLoadError = globalLoadError;
    this.projectSettingsLoadError = projectLoadError;
    this.errors = [...initialErrors];
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings); // 深度合并
}
```



文件路径固定：

- 全局：`~/.pi/agent/settings.json`
- 项目：`{cwd}/.pi/settings.json`

加载使用 `tryLoadFromStorage` — 如果文件不存在或 JSON 解析失败，返回空对象 `{}` 而不是崩溃。错误被记录下来，可以后续通过 `drainErrors()` 检查。这个设计让 pi 在配置文件损坏时仍然能启动。

```ts
// 从指定作用域的存储后端读取设置，并在返回前执行兼容迁移。
private static tryLoadFromStorage(
    storage: SettingsStorage,
    scope: SettingsScope,
): { settings: Settings; error: Error | null } {
    try {
        return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
    } catch (error) {
        return { settings: {}, error: error as Error };
    }
}

// 安全读取指定作用域的设置。
private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
    let content: string | undefined;
    storage.withLock(scope, (current) => {
        content = current;
        return undefined;
    });

    if (!content) {
        return {};
    }
    const settings = JSON.parse(content);
    return SettingsManager.migrateSettings(settings);
}
```

###### Settings 迁移

pi 的配置格式会随版本演进而变化。`migrateSettings` 函数处理旧格式的自动迁移：

```typescript
static migrateSettings(settings): Settings {
  // queueMode → steeringMode
  if ("queueMode" in settings && !("steeringMode" in settings)) {
    settings.steeringMode = settings.queueMode;
    delete settings.queueMode;
  }

  // websockets: boolean → transport: "sse" | "websocket"
  if (typeof settings.websockets === "boolean") {
    settings.transport = settings.websockets ? "websocket" : "sse";
    delete settings.websockets;
  }

  // skills: { enableSkillCommands, customDirectories } → skills: string[]
  // （旧的对象格式迁移为新的数组格式）
  // ...
}
```

迁移在**每次加载时**自动执行，但不会立即回写文件。只有当用户下次修改设置时，新格式才会被持久化。这避免了无谓的文件写入。

###### 运行时 Settings 覆盖

除了全局和项目两级，`SettingsManager` 还支持运行时覆盖：

```typescript
applyOverrides(overrides: Partial<Settings>): void {
  this.settings = deepMergeSettings(this.settings, overrides);
}
```

这用于 CLI 参数等临时性的配置。比如 `pi --model gpt-4o` 会在运行时覆盖 `defaultModel`，但不会写入任何配置文件。这构成了实际上的第四级配置：CLI 参数 > 项目 settings > 全局 settings > 默认值。

##### Settings 的读取：Getter 中的默认值

SettingsManager 为每个配置项提供 getter 方法，默认值在 getter 中硬编码而非在 Settings 对象中：

```typescript
getCompactionEnabled(): boolean {
  return this.settings.compaction?.enabled ?? true;
}

getRetrySettings() {
  return {
    enabled: this.getRetryEnabled(),
    maxRetries: this.settings.retry?.maxRetries ?? 3,
    baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
    maxDelayMs: this.settings.retry?.maxDelayMs ?? 60000,
  };
}
```

为什么不在构造时填入默认值？因为这样保持了 `globalSettings` 和 `projectSettings` 的"原始状态" — 它们只包含用户显式设置的字段。这对于后续的 `persistScopedSettings` 很重要：保存时只写入用户修改过的字段，不会把默认值写入文件。如果默认值将来改变，用户的配置文件不需要手动更新。

##### Settings 的写入和持久化链路：从内存写入文件

```typescript
setter
  → this.globalSettings.* = value
  → markModified(field)
  → save()
    → 刷新 this.settings 合并视图
    → structuredClone(globalSettings)     // 冻结快照
    → enqueueWrite("global", callback)     // 排进串行队列
      → persistScopedSettings("global", ...)
        → storage.withLock("global", cb)
          → readFileSync → JSON.parse → migrateSettings
          → 只覆盖 modifiedFields
          → JSON.stringify → writeFileSync
      → clearModifiedScope("global")       // 清脏
```

绝大部分 setter 都是针对全局的，`/settings` 面板里能改的那些设置也都是针对全局设置的。

只有 5 个项目级的 setter `setProject*`，全是资源路径类的：

* `setProjectPackages()`
* `setProjectExtensionPaths()`
* `setProjectSkillPaths()`
* `setProjectPromptTemplatePaths()`
* `setProjectThemePaths()`

```typescript
/**
 * 持久化当前全局设置。
 * 先把内存中的全局/项目配置重新合并成当前生效设置，再只把全局作用域的脏字段排队写回。
 */
private save(): void {
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

    // 全局设置文件本身不可读时，不继续覆盖写入，避免吞掉用户手工修复机会。
    if (this.globalSettingsLoadError) {
        return;
    }

    // 写入是异步串行的，这里先冻结当前快照，确保落盘内容与本次调用时的状态一致。
    const snapshotGlobalSettings = structuredClone(this.globalSettings);
    const modifiedFields = new Set(this.modifiedFields);
    const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

    this.enqueueWrite("global", () => {
        this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
    });
}

/**
 * 持久化当前项目级设置。
 * 调用方会先构造一份新的项目设置对象，再通过这里统一替换内存态并排队写入。
 */
private saveProjectSettings(settings: Settings): void {
    this.projectSettings = structuredClone(settings);
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

    // 项目级配置有解析错误时停止持久化，等待用户修复原文件。
    if (this.projectSettingsLoadError) {
        return;
    }

    const snapshotProjectSettings = structuredClone(this.projectSettings);
    const modifiedFields = new Set(this.modifiedProjectFields);
    const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
    this.enqueueWrite("project", () => {
        this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
    });
}

/**
 * 把一次写入任务排进串行队列。
 * 定位：所有落盘路径共享的调度器，保证多个写操作严格按顺序执行。
 */
private enqueueWrite(scope: SettingsScope, task: () => void): void {
    this.writeQueue = this.writeQueue
        .then(() => {
            // 让同一作用域的持久化任务严格串行执行，避免锁竞争和乱序覆盖。
            task();
            // 只有任务执行完成后才清理脏标记，避免尚未落盘的修改被误判为已保存。
            this.clearModifiedScope(scope);
        })
        .catch((error) => {
            this.recordError(scope, error);
        });
}
    
/** 将某个作用域的设置快照按“仅回写已改字段”的策略写回存储层。*/
private persistScopedSettings(
    scope: SettingsScope, // 要持久化的作用域
    snapshotSettings: Settings, // 当前内存态的冻结快照（调用前一般已完成 structuredClone）
    modifiedFields: Set<keyof Settings>, // 本次被修改的顶层字段集合
    modifiedNestedFields: Map<keyof Settings, Set<string>>, // 本次被修改的嵌套子键映射
): void {
    this.storage.withLock(scope, (current) => {
        // 从磁盘读出当前 JSON 并解析成运行时 Settings 对象
        // 用传入的快照值覆盖本次被标记过的字段
        // 对嵌套对象只更新被标记的子键，其余子键保持磁盘现状
    }
}
```

**Settings 的持久化使用了存储后端接口 `FileSettingsStorage` 的文件锁来防止并发写入**：保存时不是简单地覆盖文件，而是读取当前文件内容，只合并本次会话中修改过的字段（通过 `modifiedFields` 追踪），再写回。这意味着如果用户在另一个 pi 实例中修改了 settings，本实例不会覆盖那些更改。

##### Settings 的 Reload 机制：从文件热重载到内存

```
reload()
  → await this.writeQueue                  // 等写入排空
  → loadFromStorage(storage, "global")
    → storage.withLock("global", cb)
      → readFileSync → JSON.parse → migrateSettings
    → this.globalSettings = result
  → 同理读 project
  → this.settings = deepMergeSettings(global, project)
```

当用户在会话中修改了配置文件（比如在另一个终端编辑 `settings.json`），pi 可以通过 `reload()` 方法热重载，用户不需要重启 pi 就能看到配置变更的效果。

```typescript
async reload(): Promise<void> {
    // 步骤 1：先等待排队写入完成，避免读到自己尚未落盘的旧快照。
    await this.writeQueue;

    // 先刷新全局设置；成功时覆盖内存快照，失败时保留旧值并记录错误。
    const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
    if (!globalLoad.error) {
        this.globalSettings = globalLoad.settings;
        this.globalSettingsLoadError = null;
    } else {
        this.globalSettingsLoadError = globalLoad.error;
        this.recordError("global", globalLoad.error);
    }

    // 步骤 2：重置修改追踪，再重新加载全局与项目配置。
    // 这些集合记录的是“当前内存态相对磁盘的待写改动”；
    // 一旦主动从磁盘重载，就要把旧的脏标记全部清空，避免后续保存时把过期变更再次写回。
    this.modifiedFields.clear();
    this.modifiedNestedFields.clear();
    this.modifiedProjectFields.clear();
    this.modifiedProjectNestedFields.clear();

    // 再刷新项目级设置；项目级读取失败同样只记录错误，不中断整个 reload 流程。
    const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
    if (!projectLoad.error) {
        this.projectSettings = projectLoad.settings;
        this.projectSettingsLoadError = null;
    } else {
        this.projectSettingsLoadError = projectLoad.error;
        this.recordError("project", projectLoad.error);
    }

    // 最后按“全局为底、项目覆盖”的规则重建当前生效设置。
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
}
```

#### 优点

**1、零配置启动**。不创建任何配置文件，pi 用内建默认值就能工作。所有 Settings 字段都是 optional，默认值在 getter 中硬编码。

**2、渐进式定制**。用户可以从全局 settings 开始，遇到特殊项目时加项目配置，遇到特殊目录时加目录规则。复杂度只在需要时引入。

**3、并发安全**。文件锁 + 只写入修改过的字段，多个 pi 实例可以安全地共享同一个 settings 文件。

**4、热重载**。