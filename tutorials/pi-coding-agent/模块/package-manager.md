# 资源包管理器 `core/package-manager.ts`

文件定位：coding-agent 的资源包安装、解析和管理模块。

功能概述：

 - 管理扩展（extensions）、技能（skills）、提示模板（prompts）和主题（themes）的包源
 - 提供包的安装、卸载、更新和版本检查功能
 - 从用户级（~/.pi/agent/）和项目级（.pi/）两个作用域解析资源
 - 支持 pi manifest（package.json 中的 pi 字段）声明式资源管理
 - 支持 glob 模式和覆盖模式（!排除、+强制包含、-强制排除）的资源过滤
 - 自动发现本地目录中的资源文件（遵循目录约定）

调用链路：

* resource-loader.ts → DefaultResourceLoader.reload() → packageManager.resolve() → 资源路径列表
* TUI /login 命令 → packageManager.install() → npm/git 安装
* TUI /reload 命令 → packageManager.update() → 检查并更新已安装的包

```ts
├── 基础工具层
│   ├── getEnv()         环境变量获取（处理 Flatpak 沙箱）
│   ├── 常量定义          超时、并发数
│   └── 导出类型          PathMetadata, ResolvedResource, ResolvedPaths ; ProgressEvent, PackageUpdate
│
├── 核心接口层 ★ 先读这里
│   ├── ConfiguredPackage   已配置包的描述
│   └── PackageManager      包管理器接口（所有对外 API 定义）
│
├── 内部类型与常量
│   ├── NpmSource / GitSource / LocalSource  三种包源类型
│   ├── PiManifest           package.json 中 pi 字段的结构
│   └── RESOURCE_TYPES      四种资源：extensions/skills/prompts/themes
│
├── 文件收集与过滤引擎
│   ├── collectFiles()      通用文件收集
│   ├── collectSkillEntries() / collectAutoSkillEntries()
│   ├── collectAutoPromptEntries() / collectAutoThemeEntries()
│   ├── collectAutoExtensionEntries()
│   └── applyPatterns()     模式匹配（!排除 +强制包含 -强制排除）
│
├── DefaultPackageManager 类 ~ 主实现 ★ 核心逻辑
    ├── 构造函数 + 设置相关方法
    ├── resolve()           解析所有包源 → 返回资源路径列表
    ├── install()           安装 npm/git 包
    ├── update()            检查并更新已安装的包
    ├── remove()            卸载包
    ├── 私有方法            parseSource(), installNpmPackage(), gitCloneOrPull(),
    │                       isUpdateAvailable() 等
    └── 工具方法            runCommand(), runCommandSync() 等
```

##### 导出资源路径类型

```ts
/** 已解析的全部资源路径，按资源类型分组 */
export interface ResolvedPaths {
	extensions: ResolvedResource[]; // 扩展路径列表
	skills: ResolvedResource[]; // 技能路径列表
	prompts: ResolvedResource[]; // 提示模板路径列表
	themes: ResolvedResource[]; // 主题路径列表
}

/** 已解析的资源路径，包含启用状态和元数据 */
export interface ResolvedResource {
	path: string; // 资源文件的绝对路径
	enabled: boolean; // 该资源是否启用
	metadata: PathMetadata; // 资源的来源元数据
}

/** 资源路径元数据，描述一个资源文件的来源、作用域和来源方式 */
export interface PathMetadata {
	source: string; // 来源标识
	scope: SourceScope; // 作用域：用户级 / 项目级 / 临时
	origin: "package" | "top-level"; // 来源方式：包 / 顶层配置
	baseDir?: string; // 资源所在的基础目录
}

type SourceScope = "user" | "project" | "temporary";
type InstalledSourceScope = Exclude<SourceScope, "temporary">; // 已安装包的作用域（不含 temporary）
```

| source 值 | 含义                                         | 来源                                                     |
| --------- | -------------------------------------------- | -------------------------------------------------------- |
| "local"   | 用户在配置中显式指定的文件路径               | settings 中写了 skills: ["/path/to/skill.md"] 等参数     |
| "auto"    | pi 在标准目录下自动扫描发现                  | 扫描 ~/.pi/skills/、<project>/.pi/skills/ 等目录时找到   |
| "cli"     | 通过 命令行参数 --extension / --skill 等传入 | reload() 中补写的临时来源                                |
| 包标识符  | 来自 npm 包 / git 仓库 / 本地路径            | 如 @someone/pi-skill-foo 、 ./local-package 、git URL 等 |

**source 来源标识 - origin 来源方式 - scope 作用域** 三者关系：

- source: "local" + origin: "top-level" → 作用域 scope 根据路径落在用户目录还是项目目录判定为 "user" / "project" / "temporary"
- source: "auto" + origin: "top-level" → scope 固定为 "user" 或 "project"
- source: "cli" + origin: "top-level" + scope: "temporary" → 命令行临时资源
- source: <包名> + origin: "package" → scope 由包安装来源决定（用户级或项目级）

```ts
// 计算资源的优先级排名（数值越小优先级越高）。
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}
```

优先级（从高到低）：

 *   0  项目级 + 设置条目（source: "local", scope: "project"）
 *   1  项目级 + 自动发现（source: "auto", scope: "project"）
 *   2  用户级 + 设置条目（source: "local", scope: "user"）
 *   3  用户级 + 自动发现（source: "auto", scope: "user"）
 *   4  包资源（origin: "package"）

```ts
/** 已配置的包信息 */
export interface ConfiguredPackage {
	/** 包源标识 */
	source: string;
	/** 作用域：用户级或项目级 */
	scope: "user" | "project";
	/** 是否使用了过滤模式 */
	filtered: boolean;
	/** 已安装的路径（如果存在） */
	installedPath?: string;
}

/** npm 包源解析结果 */
type NpmSource = {
	type: "npm";
	/** npm 包规格（如 "@scope/pkg" 或 "pkg@1.0.0"） */
	spec: string;
	/** 包名（不含版本） */
	name: string;
	/** 是否指定了固定版本（如 "pkg@1.0.0" 为 true，"pkg" 为 false） */
	pinned: boolean;
};

/** 本地路径包源 */
type LocalSource = {
	type: "local";
	/** 本地路径 */
	path: string;
};

/** 解析后的包源联合类型 */
type ParsedSource = NpmSource | GitSource | LocalSource;

```

```ts
/** 可更新的包信息 */
export interface PackageUpdate {
	/** 包源标识 */
	source: string;
	/** 显示名称 */
	displayName: string;
	/** 包类型：npm 或 git */
	type: "npm" | "git";
	/** 作用域（不包含 temporary） */
	scope: Exclude<SourceScope, "temporary">;
}

/** 待更新的已配置包源 */
interface ConfiguredUpdateSource {
	/** 包源标识 */
	source: string;
	/** 作用域（用户级或项目级） */
	scope: InstalledSourceScope;
}

/** 待更新的 npm 包源 */
interface NpmUpdateTarget extends ConfiguredUpdateSource {
	/** 解析后的 npm 包源信息 */
	parsed: NpmSource;
}

/** 待更新的 git 包源 */
interface GitUpdateTarget extends ConfiguredUpdateSource {
	/** 解析后的 git 包源信息 */
	parsed: GitSource;
}
```

```ts
/** 包管理操作的进度事件 */
export interface ProgressEvent {
	/** 事件类型：开始 / 进行中 / 完成 / 错误 */
	type: "start" | "progress" | "complete" | "error";
	/** 操作类型：安装 / 移除 / 更新 / 克隆 / 拉取 */
	action: "install" | "remove" | "update" | "clone" | "pull";
	/** 包源标识 */
	source: string;
	/** 进度消息（可选） */
	message?: string;
}

/** 进度回调函数类型 */
export type ProgressCallback = (event: ProgressEvent) => void;
```

```ts
/** 缺失包源时的处理方式 */
export type MissingSourceAction = "install" | "skip" | "error";

```

```ts
/** pi manifest 声明（package.json 中的 "pi" 字段） */
interface PiManifest {
	/** 扩展入口路径列表 */
	extensions?: string[];
	/** 技能路径列表 */
	skills?: string[];
	/** 提示模板路径列表 */
	prompts?: string[];
	/** 主题路径列表 */
	themes?: string[];
}
```



```ts
/** 包管理器接口——定义包的解析、安装、卸载、更新等操作 */
export interface PackageManager {
	/** 解析所有已配置的包源，返回资源路径列表 */
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	/** 安装指定包源 */
	install(source: string, options?: { local?: boolean }): Promise<void>;
	/** 安装并持久化到设置文件 */
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	/** 移除指定包源 */
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	/** 移除并从设置文件中删除，返回是否实际移除了设置条目 */
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	/** 更新指定包源（省略 source 则更新全部） */
	update(source?: string): Promise<void>;
	/** 列出所有已配置的包 */
	listConfiguredPackages(): ConfiguredPackage[];
	/** 解析扩展源路径列表（支持临时作用域） */
	resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths>;
	/** 将包源添加到设置文件，返回是否发生了变更 */
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	/** 从设置文件中移除包源，返回是否实际移除了条目 */
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	/** 设置进度回调函数 */
	setProgressCallback(callback: ProgressCallback | undefined): void;
	/** 获取指定包源的已安装路径 */
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}
```





```ts
/** 包管理器构造选项 */
interface PackageManagerOptions {
	/** 当前工作目录 */
	cwd: string;
	/** Agent 配置目录（如 ~/.pi/agent/） */
	agentDir: string;
	/** 设置管理器实例 */
	settingsManager: SettingsManager;
}

export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private globalNpmRoot: string | undefined;
	private globalNpmRootCommandKey: string | undefined;
	private progressCallback: ProgressCallback | undefined;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
	}
```



# 资源包管理器 `core/package-manager.ts`

`package-manager` 不是单纯的“装包器”，它真正负责的是：

- 从 settings、CLI 临时参数、自动发现目录、已安装包目录中拿到资源来源
- 把这些来源统一解析成 4 类资源文件：`extensions`、`skills`、`prompts`、`themes`
- 在需要时安装、更新、卸载 npm 包和 git 仓库
- 最终输出一份可供 `resource-loader` 直接消费的 `ResolvedPaths`

一句话概括这个模块：

> **把“source”翻译成“资源文件路径列表”，并补齐它们的来源、作用域、启用状态。**

## 一、先抓住主链路：从哪里拿什么，最后输出什么

### 1. 核心解析链路 `resolve()`

这条链路是整个模块最重要的职责。

```ts
resource-loader.ts
  → DefaultResourceLoader.reload()
  → packageManager.resolve()
  → ResolvedPaths
```

`resolve()` 的输入来源有 4 组：

1. **用户级 settings**
   - `~/.pi/agent/` 对应的 global settings
2. **项目级 settings**
   - `<cwd>/.pi/` 对应的 project settings
3. **顶层本地资源配置**
   - 例如 `skills: ["./foo.md", "!legacy.md"]`
4. **自动发现目录**
   - `~/.pi/agent/{extensions,skills,prompts,themes}`
   - `<cwd>/.pi/{extensions,skills,prompts,themes}`
   - 以及 `.agents/skills`

最终输出不是“包对象”，而是：

```ts
export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}
```

也就是说，`package-manager` 的核心产物是**资源文件路径列表**。

### 2. 临时解析链路 `resolveExtensionSources()`

这条链路不读 settings，而是只处理调用方显式传入的 source：

```ts
sources[]
  → packageManager.resolveExtensionSources(sources, { local?, temporary? })
  → resolvePackageSources()
  → ResolvedPaths
```

它常用于：

- CLI 临时传入 `--extension / --skill`
- 某次 reload 只想临时解析一组 source

和 `resolve()` 的区别：

- `resolve()` 会同时处理 settings、顶层资源配置、自动发现目录
- `resolveExtensionSources()` 只处理当前调用传入的 `sources`
- 它支持 `scope: "temporary"`

### 3. 安装链路 `install()`

```ts
source
  → parseSource()
  → npm / git / local 分流
    - npm  → installNpm()
    - git  → installGit()
    - local → 只校验路径存在
```

如果调用的是 `installAndPersist()`，后面还会多一步：

```ts
install()
  → addSourceToSettings()
```

### 4. 更新链路 `update()`

```ts
settings.packages
  → 收集待更新 source
  → parseSource()
  → npm / git 分流
    - npm: 先检查版本，再批量安装 latest
    - git: fetch + reset 到目标 ref / upstream
```

### 5. 卸载链路 `remove()`

```ts
parseSource(source)
  → npm  → uninstallNpm()
  → git  → removeGit()
  → local → 不删除本地目录，只视为无需托管安装
```

## 二、这个模块到底对外提供什么

### 核心接口

```ts
export interface PackageManager {
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	install(source: string, options?: { local?: boolean }): Promise<void>;
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	update(source?: string): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}
```

这些 API 可以分成 3 类：

1. **解析类**
   - `resolve()`
   - `resolveExtensionSources()`
   - `listConfiguredPackages()`
   - `getInstalledPath()`
2. **安装维护类**
   - `install()`
   - `remove()`
   - `update()`
3. **settings 持久化类**
   - `installAndPersist()`
   - `removeAndPersist()`
   - `addSourceToSettings()`
   - `removeSourceFromSettings()`

### 最关键的输出元数据

```ts
export interface PathMetadata {
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
}
```

它告诉上层：

- 这个资源来自哪个 `source`
- 它属于用户级、项目级还是临时作用域
- 它是包内资源，还是顶层配置 / 自动发现资源
- 它解析时使用的是哪个 `baseDir`

所以 `package-manager` 输出的不只是“路径”，而是“可追溯的路径”。

## 三、`resolve()` 总链路

`resolve()` 的整体结构可以概括成 4 步：

```ts
resolve()
  → 1. 读取 global/project settings
  → 2. 解析 settings.packages
  → 3. 解析顶层本地资源 + 自动发现资源
  → 4. 排序、去重，输出 ResolvedPaths
```

对应源码里的实际顺序就是：

```ts
async resolve(onMissing?) {
  const accumulator = this.createAccumulator();
  const globalSettings = this.settingsManager.getGlobalSettings();
  const projectSettings = this.settingsManager.getProjectSettings();

  const allPackages = [...project packages, ...global packages];
  const packageSources = this.dedupePackages(allPackages);
  await this.resolvePackageSources(packageSources, accumulator, onMissing);

  this.resolveLocalEntries(...project top-level entries...);
  this.resolveLocalEntries(...global top-level entries...);
  this.addAutoDiscoveredResources(...);

  return this.toResolvedPaths(accumulator);
}
```

### 第 1 步：读取 settings 快照

输入：

- `settingsManager.getGlobalSettings()`
- `settingsManager.getProjectSettings()`

得到：

- `packages`
- `extensions`
- `skills`
- `prompts`
- `themes`

其中 `packages` 是“包源配置”，后四类是“顶层资源路径配置”。

### 第 2 步：解析 `packages`

这里先把 project/global 的 `packages` 合并，但要做一次按“包身份”的去重：

> **如果同一个包同时出现在 project 和 user 中，project 优先。**

`dedupePackages()` 的 identity 规则：

- npm：按包名去重，忽略版本
- git：按 `host/path` 去重，忽略 ref
- local：按解析后的绝对路径去重

这样做的目的，是把“配置层面其实是同一个包”的多个写法统一起来。

### 第 3 步：解析顶层本地资源

这类配置不经过安装逻辑，直接进入：

```ts
resolveLocalEntries(entries, resourceType, target, metadata, baseDir)
```

它做的事是：

1. 把普通条目和 pattern 条目拆开
2. 把普通条目解析成文件或目录
3. 从这些文件/目录里收集资源文件
4. 用 `applyPatterns()` 算出 `enabled` 状态
5. 写入累积器

### 第 4 步：补充自动发现资源

即使 settings 没写，pi 也会自动扫标准目录：

- 项目级：`<cwd>/.pi/...`
- 用户级：`~/.pi/agent/...`
- skills 额外支持 `.agents/skills`

自动发现也会套用 override 规则，而不是无脑启用：

- `!foo.md` 排除
- `+foo.md` 强制包含
- `-foo.md` 强制排除

### 第 5 步：统一输出

所有路径最后都会进入 `ResourceAccumulator`：

```ts
interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}
```

最后由 `toResolvedPaths()`：

1. 按优先级排序
2. 按 canonical path 去重
3. 输出 `ResolvedPaths`

## 四、`resolvePackageSources()`：把 source 变成包目录，再把包目录变成资源

这是最核心的中间层。

```ts
resolvePackageSources(sources, accumulator, onMissing?)
  → 遍历每个 source
    → parseSource()
    → local / npm / git 分流
    → 定位 packageRoot
    → collectPackageResources(packageRoot, ...)
```

### 1. `parseSource()`：先识别 source 类型

原始输入最终被归一化成：

```ts
type ParsedSource = NpmSource | GitSource | LocalSource;
```

判断顺序：

1. `npm:` 前缀 → npm
2. 是本地路径 → local
3. 能被 `parseGitUrl()` 识别 → git
4. 否则退回 local path

这里的核心思想是：

> 后续所有逻辑都不直接操作原始 source 字符串，而是先归一化成 `ParsedSource`。

### 2. local source：不安装，直接本地解析

local source 走：

```ts
resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir)
```

分两种情况：

- 指向文件：直接把它当成 extension 入口
- 指向目录：把它当成 package root，继续走 `collectPackageResources()`

所以 local source 本质上更像“本地资源入口”，不是“需要托管安装的包”。

### 3. npm source：先确保安装目录存在

链路是：

```ts
npm source
  → getNpmInstallPath()
  → 已安装?
    - 否 → installMissing()
    - 是 → 继续
  → pinned version?
    - 版本不匹配 → installMissing()
  → metadata.baseDir = installedPath
  → collectPackageResources(installedPath, ...)
```

这里要注意：

- 解析资源真正依赖的是**本地安装目录**
- registry 只在缺失安装或更新时参与
- 固定版本包会校验本地版本是否匹配

### 4. git source：先确保 clone 存在

链路是：

```ts
git source
  → getGitInstallPath()
  → 目录不存在?
    → installMissing()
  → temporary + 非 pinned + 非 offline?
    → refreshTemporaryGitSource()
  → metadata.baseDir = installedPath
  → collectPackageResources(installedPath, ...)
```

对后续资源收集来说，npm 和 git 最终都被抽象成一个 `packageRoot`。

## 五、`collectPackageResources()`：进入包目录后，到底收哪些文件

这个函数的优先级非常清楚：

> **外部 filter > 包内 manifest > 目录约定**

```ts
collectPackageResources(packageRoot, accumulator, filter, metadata)
  → 有 filter?
    → applyPackageFilter()
  → 否则有 package.json.pi?
    → addManifestEntries()
  → 否则
    → 扫描 extensions/skills/prompts/themes
```

### 1. 最高优先级：settings 里的包过滤器

`packages` 项不一定只是字符串，也可能是对象：

```ts
{
  source: "npm:@scope/pkg",
  skills: ["review/**", "!draft.md", "+must-keep.md"]
}
```

此时 filter 的含义是：

- `patterns === undefined`
  - 这个资源类型不覆盖，走默认策略
- `patterns.length === 0`
  - 明确表示该资源类型全部禁用
- 有具体 patterns
  - 先收集候选文件
  - 再用 `applyPatterns()` 算哪些启用

这里的一个关键点是：

> 不是只有启用文件才会被记录；在 filter 场景下，文件也可能以 `enabled: false` 的状态被保留下来。

### 2. 第二优先级：包内 `package.json.pi`

包自己可以声明：

```ts
interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}
```

例如：

```json
{
  "pi": {
    "extensions": ["./dist/index.js"],
    "skills": ["skills/**/*.md", "!skills/legacy.md"]
  }
}
```

这条链路是：

```ts
addManifestEntries(entries, root, resourceType, target, metadata)
  → collectFilesFromManifestEntries()
  → applyPatterns()
  → 把启用文件写入 accumulator
```

manifest 的本质作用，是让包作者显式定义“这个包暴露哪些资源”。

### 3. 最后兜底：目录约定扫描

如果没有 filter，也没有 manifest，就退回约定目录：

- `extensions/`
- `skills/`
- `prompts/`
- `themes/`

但不同资源类型的扫描逻辑不一样。

#### `extensions`

优先级：

1. 目录自身 `package.json.pi.extensions`
2. `index.ts / index.js`
3. 扫描 `.ts / .js`

#### `skills`

走 `collectSkillEntries()`：

- 优先识别 `SKILL.md`
- `pi` 模式下根目录普通 `.md` 也算 skill
- `agents` 模式下按 `.agents/skills` 约定扫描

#### `prompts`

- 扫描 `.md`

#### `themes`

- 扫描 `.json`

所以这不是“统一按后缀递归扫目录”，而是每一类资源有自己的发现语义。

## 六、过滤引擎：`applyPatterns()` 在做什么

这套模式语义贯穿了：

- settings 顶层资源配置
- settings 中 package filter
- manifest 里的 override 模式
- 自动发现资源的启用状态判断

支持 4 类 pattern：

1. **普通 include**
   - 例如 `skills/**/*.md`
2. **`!pattern`**
   - 排除匹配项
3. **`+path`**
   - 强制包含精确路径
4. **`-path`**
   - 强制排除精确路径

执行顺序是：

```ts
applyPatterns(allPaths, patterns, baseDir)
  → 1. includes（如果没有 include，就默认全量）
  → 2. excludes
  → 3. forceIncludes
  → 4. forceExcludes
```

所以优先级关系可以记成：

```text
普通包含
  < !排除
  < +强制包含
  < -强制排除
```

自动发现场景里，`isEnabledByOverrides()` 用的是同一套思路。

## 七、自动发现链路：没有显式配置时资源从哪来

`addAutoDiscoveredResources()` 负责补齐标准目录资源。

它分两轮：

### 第 1 轮：项目级

- `<cwd>/.pi/extensions`
- `<cwd>/.pi/skills`
- `<cwd>/.pi/prompts`
- `<cwd>/.pi/themes`
- 从当前目录一路向上到 git root 的 `.agents/skills`

### 第 2 轮：用户级

- `~/.pi/agent/extensions`
- `~/.pi/agent/skills`
- `~/.pi/agent/prompts`
- `~/.pi/agent/themes`
- `~/.agents/skills`

自动发现资源的 `metadata` 是：

```ts
{
  source: "auto",
  scope: "project" | "user",
  origin: "top-level",
  baseDir: ...
}
```

所以在最终结果里，自动发现资源和包资源是可区分的。

## 八、优先级与去重：多个来源都命中同一路径时怎么办

这是理解最终输出顺序的关键。

### 1. 资源优先级

```ts
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}
```

优先级从高到低：

1. 项目级显式本地配置 `project + local`
2. 项目级自动发现 `project + auto`
3. 用户级显式本地配置 `user + local`
4. 用户级自动发现 `user + auto`
5. 包资源 `origin: "package"`

本质上就是：

> **越靠近当前项目、越显式声明的资源，优先级越高。**

### 2. 去重策略

累积器内部是：

```ts
Map<path, { metadata, enabled }>
```

`addResource()` 的规则是：

```ts
if (!map.has(path)) {
  map.set(path, { metadata, enabled });
}
```

所以同一个绝对路径是谁先写进去，就保留谁。这和收集顺序是配套的：

- project 先于 user
- 显式配置先于自动发现
- 顶层资源优先于包资源

最后 `toResolvedPaths()` 还会再按 canonical path 去重一次，避免路径大小写或软链接导致重复。

## 九、安装 / 更新 / 卸载链路

### `install()`

```ts
install(source, { local? })
  → parseSource()
  → withProgress("install", ...)
    → npm  → installNpm()
    → git  → installGit()
    → local → 校验路径是否存在
```

安装目录规则：

- npm 用户级：`~/.pi/agent/npm/node_modules/<pkg>`
- npm 项目级：`<cwd>/.pi/npm/node_modules/<pkg>`
- git 用户级：`~/.pi/agent/git/<host>/<path>`
- git 项目级：`<cwd>/.pi/git/<host>/<path>`
- 临时 source：落到 `/tmp/pi-extensions/...`

### `installAndPersist()`

```ts
install()
  → addSourceToSettings()
```

含义是：不仅装好，而且让它进入未来的 `resolve()` 结果。

### `update()`

`update()` 只针对 settings 里配置过的包，不处理顶层本地资源。

主流程：

```ts
update(source?)
  → 从 global/project settings 收集 configured packages
  → 若指定 source，则按 identity 匹配
  → updateConfiguredSources()
    → npm 候选 / git 候选分流
    → npm: 并发检查版本，再分 scope 批量更新
    → git: 并发 fetch / reset
```

对 npm：

- 固定版本 `pinned` 包不会自动升到新版本

对 git：

- 有固定 `ref`：确保 checkout 到该 ref
- 无固定 `ref`：跟随 upstream 或 `origin/HEAD`

### `checkForAvailableUpdates()`

这条链路不会真的更新，只会返回：

```ts
export interface PackageUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: "user" | "project";
}
```

也就是“哪些 source 可以更新”的摘要信息。

### `remove()` / `removeAndPersist()`

```ts
remove(source)
  → parseSource()
  → npm  → uninstallNpm()
  → git  → removeGit()
  → local → 不删除原始本地文件
```

local source 从一开始就不是托管安装目录，因此 remove 只影响配置，不碰用户自己的文件。

## 十、settings 写回链路

这个模块不只是读 settings，也会修改 settings。

### `addSourceToSettings()`

逻辑是：

1. 根据 `options.local` 决定写入 project 还是 user settings
2. 读取当前 `packages`
3. 归一化 source
   - local path 会尽量转成相对 `baseDir` 的写法
4. 判断 settings 里是否已经有“同一个 source”
   - 有则替换
   - 无则追加

### `removeSourceFromSettings()`

逻辑与之对应：

1. 算出 source 的 match key
2. 从 `packages` 中移除匹配项
3. 写回 settings

这里“同一个 source”的判断也不是直接按字符串，而是按 identity：

- npm：包名
- git：`host/path`
- local：解析后的绝对路径

## 十一、进度事件：安装和更新时上层怎么拿反馈

所有长操作都包在 `withProgress()` 里：

```ts
withProgress(action, source, message, operation)
  → emit start
  → await operation()
  → emit complete
  → catch error → emit error
```

事件结构：

```ts
export interface ProgressEvent {
	type: "start" | "progress" | "complete" | "error";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string;
}
```

所以这个模块除了“最终解析结果”，还会向上层输出“过程状态”。

## 十二、一个具体例子：从 settings 到 `ResolvedPaths`

假设当前输入是：

```ts
// project settings
packages: [
  "npm:@team/pi-pack",
  { source: "../local-tools", skills: ["review/**", "!draft.md"] }
]
skills: ["./skills/*.md", "!legacy.md"]

// global settings
packages: ["git@github.com:foo/bar.git"]
```

`resolve()` 的过程可以理解为：

```ts
1. 读取 global/project settings
2. dedupe packages
3. resolvePackageSources()
   - npm:@team/pi-pack → 找到安装目录 → 收集包资源
   - ../local-tools → 直接按本地目录收集资源
   - git@github.com:foo/bar.git → 找到 clone 目录 → 收集包资源
4. resolveLocalEntries()
   - 解析 "./skills/*.md", "!legacy.md"
5. addAutoDiscoveredResources()
6. toResolvedPaths()
```

最终给上层的是类似：

```ts
{
  skills: [
    {
      path: "/project/.pi/skills/code-review.md",
      enabled: true,
      metadata: { source: "local", scope: "project", origin: "top-level", ... }
    },
    {
      path: "/project/local-tools/review/SKILL.md",
      enabled: true,
      metadata: { source: "../local-tools", scope: "project", origin: "package", ... }
    },
    {
      path: "/Users/me/.pi/agent/git/github.com/foo/bar/skills/debug.md",
      enabled: true,
      metadata: { source: "git@github.com:foo/bar.git", scope: "user", origin: "package", ... }
    }
  ],
  extensions: [...],
  prompts: [...],
  themes: [...]
}
```

注意它输出的不是“哪些包存在”，而是：

- 哪些**资源文件**
- 来自哪个**来源**
- 当前是否**启用**
- 属于哪个**作用域**

这才是 `resource-loader` 真正要消费的数据。

## 十三、最后总结：理解 `package-manager` 要抓哪三层

这个模块真正建立的是一条稳定的数据管线：

```ts
settings / CLI sources / 自动发现目录 / 已安装包目录
  → source 解析（npm / git / local）
  → packageRoot 定位
  → 包内资源收集（filter > manifest > convention）
  → 顶层本地资源收集
  → 自动发现资源补齐
  → 排序 + 去重
  → ResolvedPaths
```

所以理解它时，最值得抓住的是 3 层：

1. **source 层**
   - 先判断输入到底是 npm、git 还是 local
2. **packageRoot 层**
   - 决定这个 source 最终落到磁盘上的哪个目录
3. **resource 层**
   - 决定从这个目录里拿哪些文件、哪些启用、如何与别的来源合并

从上层视角看，它是一个**资源解析器**。

从实现视角看，它是一个**安装器 + 文件扫描器 + 过滤器 + 合并器**的组合。
