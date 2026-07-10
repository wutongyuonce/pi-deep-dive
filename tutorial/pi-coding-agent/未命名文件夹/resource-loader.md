# 外部资源的统一入口 `core/resource-loader`

coding-agent 的统一资源发现、加载与缓存模块。

> **pi 的资源不是"启动时读几个配置文件"那么简单。** 它有**四种可扩展资源**（extensions、skills、prompts、themes）、两个先天作用域（全局 `~/.pi/agent/` 和项目 `.pi/`）、外加 npm 包来源和 CLI 临时路径。如果不做统一收口，就会有四套发现逻辑、四套冲突处理、四套作用域合并。
>
> ResourceLoader 的解决方案是：**把多来源、多类型的外部资源统一装配为一份可查询的缓存**，再暴露给 system-prompt.ts、AgentSession、TUI 等消费者。

它管理的资源类型：

| 资源类型 | 本质 | 最终影响谁 |
|---|---|---|
| `extensions` | TypeScript/JS 代码模块 | 工具、命令、UI、事件、provider |
| `skills` | Markdown 指令文档（`SKILL.md`） | system prompt 中的 `<available_skills>` |
| `prompt templates` | 参数化文本模板 | slash command / prompt expansion |
| `themes` | UI 主题 JSON | interactive mode 视觉层 |
| `AGENTS.md` / `CLAUDE.md` | 目录级规则文本 | system prompt 的 `# Project Context` |
| `SYSTEM.md` | 自定义 system prompt 基础文本 | 替换默认 system prompt |
| `APPEND_SYSTEM.md` | 追加文本 | 拼接到 system prompt 末尾 |

---

## 一、ResourceLoader 接口与 DefaultResourceLoader 类

### ResourceLoader 接口 —— 消费者看到的契约

```typescript
export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	extendResources(paths: ResourceExtensionPaths): void;
	reload(): Promise<void>;
}
```

几个设计要点：

* **每种资源的返回值都包含 `diagnostics`**。单个资源加载失败不会中止整个流程，错误被收集到 `ResourceDiagnostic[]` 中。上层（TUI）可以选择展示或忽略。
* **`reload` 是异步的** — 涉及文件系统读取和 npm 包解析。但 `get*()` 是同步的 — 它们只返回上一次 `reload()` 的缓存结果。
* **`extendResources` 允许运行时动态扩展**。Extension 加载完成后可以通过它追加额外的 skill/prompt/theme 路径。这是"Extension 可以提供 Skill"的底层机制。

### DefaultResourceLoaderOptions —— 构造配置

```typescript
export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	// CLI / 程序额外指定的资源路径
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	// 内联扩展工厂（非磁盘来源）
	extensionFactories?: ExtensionFactory[];
	// 跳过对应资源类型的自动发现（测试 / 受限环境）
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	// 显式指定 prompt 来源
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	// Override 钩子（允许外部对加载结果做后处理）
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => { ... };
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => { ... };
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => { ... };
	agentsFilesOverride?: (base: { agentsFiles: ... }) => { ... };
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}
```

### DefaultResourceLoader 类 —— 字段全景

ResourceLoader 的字段可以分为三类：**构造参数存储**、**缓存字段**、**扩展动态来源追踪**。

**构造参数存储（只读，构造后不再变）：**

```typescript
export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;                           // 工作目录（绝对路径）
	private agentDir: string;                      // agent 全局配置目录（~/.pi/agent）
	private settingsManager: SettingsManager;      // 设置管理器
	private eventBus: EventBus;                    // 扩展事件总线
	private packageManager: DefaultPackageManager; // 包来源解析器

	// 附加资源路径
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private extensionFactories: ExtensionFactory[];

	// 禁用开关
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;

	// Prompt 来源
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];

	// Override 钩子（7 个）
	private extensionsOverride?: ...;
	private skillsOverride?: ...;
	private promptsOverride?: ...;
	private themesOverride?: ...;
	private agentsFilesOverride?: ...;
	private systemPromptOverride?: ...;
	private appendSystemPromptOverride?: ...;
```

**缓存字段（`reload()` / `extendResources()` 写入，`get*()` 读取）：**

```typescript
	// 扩展
	private extensionsResult: LoadExtensionsResult;
	// 技能
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private lastSkillPaths: string[];
	// 提示词模板
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private lastPromptPaths: string[];
	// 主题
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private lastThemePaths: string[];
	// 上下文文件
	private agentsFiles: Array<{ path: string; content: string }>;
	// System Prompt
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
```

**扩展动态来源追踪（`extendResources()` 写入，`findSourceInfoForPath()` 读取）：**

```typescript
	// 扩展在运行时通过 extendResources() 注入的资源的来源信息
	// reload() 时会清空重建
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
}
```

`lastSkillPaths` / `lastPromptPaths` / `lastThemePaths` 的用处是：`extendResources()` 不会完整重载，而是在**现有的路径列表上追加**新路径。保留 `last*Paths` 让增量扩展成为可能。

### 构造函数 —— 初始化但不加载

```typescript
constructor(options: DefaultResourceLoaderOptions) {
	// 基础路径与依赖
	this.cwd = resolvePath(options.cwd);
	this.agentDir = resolvePath(options.agentDir);
	this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
	this.eventBus = options.eventBus ?? createEventBus();
	this.packageManager = new DefaultPackageManager({
		cwd: this.cwd, agentDir: this.agentDir,
		settingsManager: this.settingsManager,
	});

	// 保存附加路径、工厂、禁用开关、override 钩子（省略）

	// 初始化所有缓存为空
	this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	this.skills = [];
	this.skillDiagnostics = [];
	this.prompts = [];
	this.promptDiagnostics = [];
	this.themes = [];
	this.themeDiagnostics = [];
	this.agentsFiles = [];
	this.appendSystemPrompt = [];
	this.lastSkillPaths = [];
	this.extensionSkillSourceInfos = new Map();
	this.extensionPromptSourceInfos = new Map();
	this.extensionThemeSourceInfos = new Map();
	this.lastPromptPaths = [];
	this.lastThemePaths = [];
}
```

> 构造函数**不执行任何文件 I/O 或加载逻辑**。所有资源在首次 `reload()` 调用时才真正加载。这让调用方可以先构造 ResourceLoader，注入 override 钩子，再决定何时触发加载。

---

## 二、资源加载链路（`reload()` 12 步全流程）

`reload()` 是 ResourceLoader 的核心。它的本质不是"重新读几个文件"，而是：

> **重建当前 cwd 下的整个外部资源世界。**

它按精确的顺序完成 12 个步骤，覆盖从 settings 刷新到 system prompt 解析的全部资源加载：

```text
reload()                                           ← 应用启动 / /reload 命令
  │
  ├─ 步骤 1: settingsManager.reload()              ← 刷新设置快照
  ├─ 步骤 1: packageManager.resolve()              ← 解析包来源资源路径
  ├─ 步骤 1: packageManager.resolveExtensionSources() ← 解析 CLI 临时路径
  │
  ├─ 步骤 2: getEnabledResources() / mapSkillPath  ← 过滤启用资源 + skill 目录→文件映射
  ├─ 步骤 3: 为 CLI 临时路径补 metadata             ← source: "cli", scope: "temporary"
  │
  ├─ 步骤 4: loadExtensions()                      ← 加载磁盘扩展
  │         + loadExtensionFactories()              ← 加载内联扩展工厂
  ├─ 步骤 5: detectExtensionConflicts()            ← 检测扩展工具/标志冲突
  ├─ 步骤 6: 校验 additionalExtensionPaths 存在性
  │         + extensionsOverride()                  ← 允许外部改写
  │         + applyExtensionSourceInfo()            ← 打来源标签
  │
  ├─ 步骤 7: updateSkillsFromPaths()               ← 刷新技能缓存
  ├─ 步骤 8: updatePromptsFromPaths()              ← 刷新提示词模板缓存
  ├─ 步骤 9: updateThemesFromPaths()               ← 刷新主题缓存
  │
  ├─ 步骤 10: loadProjectContextFiles()            ← 加载 AGENTS.md/CLAUDE.md
  ├─ 步骤 11: discoverSystemPromptFile()           ← 发现 SYSTEM.md
  │          + resolvePromptInput()                 ← 解析为字符串
  ├─ 步骤 12: discoverAppendSystemPromptFile()     ← 发现 APPEND_SYSTEM.md
             + resolvePromptInput()
```

12 个步骤可以归为三类：

| 类别 | 步骤 | 产出 |
|---|---|---|
| 扩展系统 | 1-6 | `extensionsResult`（扩展列表 + 运行时 + 错误） |
| 内容资源 | 7-9 | skill / prompt / theme 缓存及其诊断 |
| 上下文与提示 | 10-12 | agents 文件、system prompt、append prompt |

### 每一步的详细说明

#### 步骤 1 — 刷新设置与包来源解析

```
settingsManager.reload()
  → 从磁盘重新读取 settings.json 等配置

packageManager.resolve()
  → 解析全局目录 (~/.pi/agent/) 和项目目录 (.pi/) 中
    extensions/ skills/ prompts/ themes/ 的资源路径
  → 解析 settings.json 中 packages 字段声明的 npm 包资源
  → 返回 ResolvedPaths { extensions, skills, prompts, themes }
    每条路径包含 { path, enabled, metadata: PathMetadata }

packageManager.resolveExtensionSources(additionalExtensionPaths)
  → 把 CLI --extension / --skill 等参数转为标准 ResolvedResource[]
  → 标记为 scope: "temporary"

初始化 metadataByPath = new Map<string, PathMetadata>()
清空 extensionSkillSourceInfos / extensionPromptSourceInfos / extensionThemeSourceInfos
```

`metadataByPath` 是本次 reload 的核心中间数据结构。它从 `PackageManager` 的解析结果中提取每个路径的 `PathMetadata`（source、scope、origin），后续为每项资源补 `sourceInfo` 时就靠它。

#### 步骤 2 — 提取已启用资源并做 skill 目录映射

```
getEnabledResources(resolvedPaths.skills)
  → 遍历所有 skill 资源 → 将 path→metadata 写入 metadataByPath
  → 过滤 enabled === true 的资源

mapSkillPath (仅对 auto-discovered 或 package 来源)
  → 资源路径是文件 → 直接用
  → 资源路径是目录 → 查找 <dir>/SKILL.md
    → 找到 → 映射到 SKILL.md，同时把目录的 metadata 关联过去
    → 没找到 → 原路径返回（让后续加载报错）
```

为什么只对 auto/package 来源做目录映射？因为 CLI、additional 路径是用户显式指定的，用户指到目录时可能期望加载目录下所有文件（而非只加载 `SKILL.md`）。

#### 步骤 3 — 为 CLI 临时资源补元数据

```
遍历 cliExtensionPaths.extensions 和 cliExtensionPaths.skills
  → 若 metadataByPath 中没有该路径
    → 写入 { source: "cli", scope: "temporary", origin: "top-level" }
```

CLI 临时路径不经过 PackageManager 解析，metadataByPath 里缺少它们的信息。这一步补齐，让后续 sourceInfo 推断不受影响。

#### 步骤 4 — 加载扩展

```
extensionPaths = noExtensions
  ? cliEnabledExtensions
  : mergePaths(cliEnabledExtensions, enabledExtensions)

extensionsResult = await loadExtensions(extensionPaths, cwd, eventBus)
  → 使用 jiti 编译 .ts 文件
  → 每个扩展执行 setup，获得 Extension 对象
  → 错误隔离：一个扩展崩溃不影响其他扩展

inlineExtensions = await loadExtensionFactories(extensionsResult.runtime)
  → 执行构造参数传入的 ExtensionFactory 函数
  → 虚拟路径标记为 "<inline:1>", "<inline:2>" ...
  → 共享同一个 runtime 对象

合并：extensionsResult.extensions.push(...inlineExtensions.extensions)
```

#### 步骤 5 — 检测扩展冲突

```
detectExtensionConflicts(extensionsResult.extensions)
  → 遍历所有扩展的 tools 和 flags
  → toolOwners Map 记录每个工具名的首个拥有者
  → 后出现同名工具 → 记入 conflicts（不删除，只是诊断）
  → flagOwners Map 同理
  → 冲突追加到 extensionsResult.errors
```

"宽容加载 + 事后报告"策略：冲突不阻止扩展保留，用户通过 diagnostic 知晓即可。

#### 步骤 6 — 校验额外路径 + Override + 来源信息

```
校验 additionalExtensionPaths 中的本地路径是否存在
  → 不存在 → 追加错误到 extensionsResult.errors

extensionsOverride 钩子（如果有）
  → 外部可过滤/改写扩展结果（测试注入等场景）

applyExtensionSourceInfo(extensions, metadataByPath)
  → 为每个扩展找 sourceInfo
  → 把同一 sourceInfo 传播给扩展的 commands 和 tools
```

#### 步骤 7-9 — 内容资源（skills / prompts / themes）

三类资源遵循相同的加载模式：

```
路径合并：
  skillPaths = noSkills
    ? mergePaths(cliEnabledSkills, additionalSkillPaths)
    : mergePaths([...cliEnabledSkills, ...enabledSkills], additionalSkillPaths)

加载：
  updateSkillsFromPaths(skillPaths, metadataByPath)
    → loadSkills({ skillPaths }) → { skills, diagnostics }
    → skillsOverride 钩子（如果有）
    → 为每个 skill 补 sourceInfo → findSourceInfoForPath()

校验：
  遍历 additionalSkillPaths 本地路径 → 不存在则追加 diagnostic
```

`updateSkillsFromPaths` / `updatePromptsFromPaths` / `updateThemesFromPaths` 三个方法被 `reload()` 和 `extendResources()` 共用。`extendResources()` 增量追加路径后调用同一个方法做局部刷新。

#### 步骤 10 — 加载项目上下文文件链

```
agentsFiles = noContextFiles
  ? []
  : loadProjectContextFiles({ cwd, agentDir })

agentsFilesOverride 钩子（如果有）
```

`loadProjectContextFiles()` 的详细逻辑见第四章。

#### 步骤 11-12 — System Prompt

```
systemPrompt = resolvePromptInput(
  systemPromptSource ?? discoverSystemPromptFile(),
  "system prompt"
)
systemPromptOverride 钩子（如果有）

appendSystemPrompt = resolvePromptInput(每个 append 来源)
appendSystemPromptOverride 钩子（如果有）
```

`resolvePromptInput()` 的逻辑：如果输入是一个存在的文件路径 → 读取文件内容；否则将输入当纯文本使用。

`discoverSystemPromptFile()` 的优先级：`.pi/SYSTEM.md`（项目）> `~/.pi/agent/SYSTEM.md`（全局）。

### 合并路径的优先级

在整个 `reload()` 中，路径通过 `mergePaths(primary, additional)` 合并，**先后顺序决定优先级**：先出现的保留，后出现的被去重丢弃。这意味着：

```text
CLI 路径 > 包解析路径 > additional 路径
  (primary)      (primary)    (additional)
```

用户通过 `--extension` 传入的路径优先级最高，目录自动发现的次之，程序额外指定的最低。

---

## 三、四种资源的加载机制

虽然 ResourceLoader 对外暴露了统一接口，但四种资源的加载本质完全不同。

### Extensions —— 需要执行代码

Extension 是 TypeScript/JavaScript 模块，加载意味着**执行代码**。这是四种资源中最复杂的：

```text
loadExtensions(paths, cwd, eventBus)
  │
  ├─ 对每个路径：
  │   ├─ 目录 → 找 index.ts / index.js
  │   └─ 文件 → 直接加载
  │
  ├─ 使用 jiti 编译 .ts 文件
  │   └─ jiti 是运行时 TypeScript 编译器，让 .ts 文件无需预编译即可加载
  │
  ├─ 执行 setup 函数
  │   └─ setup(runtime: ExtensionRuntime) → Extension | Promise<Extension>
  │
  └─ 错误隔离
      └─ try/catch 包裹每个扩展的加载，单个崩溃不影响其他扩展
```

`ExtensionRuntime` 是注入给扩展的能力对象，让扩展可以注册工具、命令、flag、事件处理器。它由 `createExtensionRuntime()` 创建。

内联扩展工厂（`ExtensionFactory`）是另一种加载路径：不是从磁盘加载，而是由代码直接提供工厂函数。每个工厂生成一个 `<inline:N>` 虚拟路径。

### Skills —— 只需读文件

Skill 是 Markdown 文件（`SKILL.md`），加载只需要读文件内容。核心是 `loadSkills()` 函数（`core/skills.ts`）：

```typescript
// 简化调用
loadSkills({
  cwd: this.cwd,
  agentDir: this.agentDir,
  skillPaths,          // 显式指定的 skill 路径
  includeDefaults: false,  // ResourceLoader 不加载默认路径（路径由 PackageManager 提供）
})
```

Skill 加载后的结果被缓存在 `this.skills` 中。消费者（`system-prompt.ts`）通过 `getSkills()` 获取，再调用 `formatSkillsForPrompt()` 格式化为 `<available_skills>` 注入 system prompt。

> skills 不是代码插件，而是**可被模型读取的能力文档**。它没有执行入口，没有 handler，没有 runtime context。extension 改系统行为，skill 改模型行为。

### Prompts —— 需要模板解析与去重

Prompt Template 是文本文件，加载使用 `loadPromptTemplates()`：

```typescript
loadPromptTemplates({
  cwd: this.cwd,
  agentDir: this.agentDir,
  promptPaths,
  includeDefaults: false,
})
```

加载后需要按名称去重（`dedupePrompts`）：同名 prompt 只保留先出现的，后者生成 collision 诊断。这和 extension 的"宽容策略"一致。

### Themes —— 需要 Schema 验证

Theme 是 JSON 文件，加载逻辑在 ResourceLoader 内部（`loadThemes` / `loadThemesFromDir` / `loadThemeFromFile`），最终调用 `loadThemeFromPath()` 解析：

```text
loadThemes(paths, includeDefaults)
  │
  ├─ includeDefaults === true?
  │   └─ 先加载 ~/.pi/agent/themes/ 和 .pi/themes/
  │
  └─ 遍历 paths：
      ├─ 目录 → loadThemesFromDir(dir)
      │   └─ readdirSync → 过滤 .json → 逐个 loadThemeFromFile
      └─ .json 文件 → loadThemeFromFile
          └─ loadThemeFromPath(filePath)
```

加载后按主题名去重（`dedupeThemes`），同名碰撞生成 collision 诊断。

---

## 四、上下文文件与 System Prompt 发现

### AGENTS.md / CLAUDE.md —— 目录树上溯发现

`loadProjectContextFiles()` 不依赖 PackageManager，它是一个独立的工具函数，被 ResourceLoader 和 SessionManager 等多处调用。

```text
loadProjectContextFiles({ cwd, agentDir })
  │
  ├─ 1. 加载全局上下文：~/.pi/agent/ 下的 AGENTS.md 或 CLAUDE.md
  │     └─ loadContextFileFromDir(agentDir)
  │        → 依次查找 AGENTS.md → AGENTS.MD → CLAUDE.md → CLAUDE.MD
  │        → 找到第一个可读文件就返回
  │
  ├─ 2. 从 cwd 向上遍历到根目录
  │     └─ 每个目录调用 loadContextFileFromDir()
  │     └─ 按 unshift 收集（远的在前，近的在后）
  │
  └─ 3. 返回：[全局上下文, ...祖先目录上下文(从远到近)]
```

最终拼接顺序：

```text
1. ~/.pi/agent/AGENTS.md          ← 全局规则（最先注入）
2. /AGENTS.md                     ← 根目录
3. /home/user/project/AGENTS.md   ← 项目根目录
4. /home/user/project/src/AGENTS.md ← 当前工作目录
```

所有文件**按顺序拼接**（不覆盖），注入 system prompt 的 `# Project Context` 区域。这个设计让组织可以在不同层级的目录中放置不同粒度的上下文。

### SYSTEM.md —— 替换，而非拼接

```
discoverSystemPromptFile()
  → .pi/SYSTEM.md 存在? → 返回
  → ~/.pi/agent/SYSTEM.md 存在? → 返回
  → undefined（使用默认 system prompt）
```

`SYSTEM.md` 是**替换**语义：存在则完全替换默认 system prompt。这与 AGENTS.md 的拼接语义形成对比：

| 文件 | 语义 | 原因 |
|---|---|---|
| `AGENTS.md` / `CLAUDE.md` | **拼接** | 目录级规则不应消灭全局规则，而是逐层叠加 |
| `SYSTEM.md` | **替换** | 用户自定义 system prompt 时，通常想完全控制其内容 |

### APPEND_SYSTEM.md —— 追加

```
discoverAppendSystemPromptFile()
  → .pi/APPEND_SYSTEM.md 存在? → 返回
  → ~/.pi/agent/APPEND_SYSTEM.md 存在? → 返回
  → undefined
```

`APPEND_SYSTEM.md` 让用户在不替换默认 prompt 的情况下追加内容。优先级同样是项目级高于全局级。

---

## 五、运行时动态扩展（`extendResources`）

`extendResources()` 是 extension 在加载后动态追加资源的入口。它**不是完整 reload**，而是在现有缓存上做增量追加：

```text
extendResources({ skillPaths, promptPaths, themePaths })
  │
  ├─ normalizeExtensionPaths()  ← 规范化路径及其 metadata
  │
  ├─ 记录来源信息到 extensionSkillSourceInfos / extensionPromptSourceInfos / extensionThemeSourceInfos
  │   └─ createSourceInfo(path, metadata)
  │
  ├─ skillPaths 有新增?
  │   └─ lastSkillPaths = mergePaths(lastSkillPaths, newPaths)
  │      └─ updateSkillsFromPaths(lastSkillPaths)
  │
  ├─ promptPaths 有新增?
  │   └─ lastPromptPaths = mergePaths(...)
  │      └─ updatePromptsFromPaths(lastPromptPaths)
  │
  └─ themePaths 有新增?
      └─ lastThemePaths = mergePaths(...)
         └─ updateThemesFromPaths(lastThemePaths)
```

这意味着资源流是**两阶段装配**：

```text
阶段 1：ResourceLoader.reload()
  先装全局 / 项目 / package / CLI 资源

阶段 2：AgentSession.bindExtensions()
  extension 通过 resources_discover 事件 → extendResources() 动态追加
```

这也是 `bindExtensions()` 之后需要重建 system prompt 的原因 — extension 可能追加了新的 skills 和 prompts。

### sourceInfo 推断机制

每项资源加载后都需要确定它的"来源信息"（`SourceInfo`）。`findSourceInfoForPath()` 是统一入口，查询优先级为：

```text
findSourceInfoForPath(resourcePath, extraSourceInfos, metadataByPath)
  │
  ├─ 空路径 → undefined
  ├─ 虚拟路径（以 "<" 开头） → getDefaultSourceInfoForPath()
  │
  ├─ extraSourceInfos (扩展动态注入的来源) 精确匹配
  │   └─ 支持祖先目录匹配：父目录的 sourceInfo 覆盖子文件
  │
  ├─ metadataByPath (PackageManager 提供的元数据) 精确匹配
  │   └─ 同样支持祖先目录匹配
  │
  └─ 都没找到 → undefined
```

当 `findSourceInfoForPath()` 返回 `undefined` 时，调用方回退到 `getDefaultSourceInfoForPath()`：

```text
getDefaultSourceInfoForPath(filePath)
  │
  ├─ 虚拟路径 → scope: "temporary", origin: "top-level"
  ├─ 位于 ~/.pi/agent/skills|prompts|themes|extensions 下 → scope: "user"
  ├─ 位于 .pi/skills|prompts|themes|extensions 下 → scope: "project"
  └─ 其他 → scope: "temporary"
```

---

## 六、冲突检测与错误处理

ResourceLoader 遵循**渐进式降级**原则：任何单个资源加载失败都不会阻塞系统启动。

### Extension 工具/标志冲突

```typescript
detectExtensionConflicts(extensions: Extension[])
  → toolOwners = new Map<工具名, 扩展路径>()
  → flagOwners = new Map<标志名, 扩展路径>()
  → 遍历扩展：
     工具名已存在 → 记冲突（不删除）
     标志名已存在 → 记冲突（不删除）
  → 返回 conflicts[]
```

冲突不阻止扩展保留。实际优先级由**加载顺序**决定（先加载者生效）。这是"宽容加载 + 事后报告"策略：开发阶段用户经常需要临时覆盖某个扩展的行为，如果每次覆盖都报错阻断，开发体验会很差。

### 资源路径不存在检测

每种资源类型在加载后都会校验 `additional*Paths` 中的本地路径是否存在：

```typescript
for (const p of this.additionalSkillPaths) {
  if (isLocalPath(p)) {
    const resolved = this.resolveResourcePath(p);
    if (!existsSync(resolved) && !this.skillDiagnostics.some(d => d.path === resolved)) {
      this.skillDiagnostics.push({
        type: "error",
        message: "Skill path does not exist",
        path: resolved,
      });
    }
  }
}
```

用户在 CLI 中指定了一个不存在的 skill 路径，不会崩溃 — 它被记录为 diagnostic，其他资源正常加载。

### Prompt / Theme 同名碰撞

`dedupePrompts()` 和 `dedupeThemes()` 逻辑一致：同名资源保留先出现的，后出现者生成 `type: "collision"` 的诊断。丢失方和胜出方的路径都会记录在 `ResourceCollision` 中，方便用户排查。

---

## 七、Override 机制

ResourceLoader 为每种资源类型提供了 override 钩子，允许外部在加载完成后修改结果：

```typescript
extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
skillsOverride?: (base: { skills; diagnostics }) => { skills; diagnostics };
promptsOverride?: (base: { prompts; diagnostics }) => { prompts; diagnostics };
themesOverride?: (base: { themes; diagnostics }) => { themes; diagnostics };
agentsFilesOverride?: (base: { agentsFiles }) => { agentsFiles };
systemPromptOverride?: (base: string | undefined) => string | undefined;
appendSystemPromptOverride?: (base: string[]) => string[];
```

Override 钩子接收加载完成的基础结果，返回修改后的结果。这让测试、RPC mode、Slack bot 等不同的产品壳可以在不修改 ResourceLoader 代码的情况下定制资源加载行为。例如：

* 测试时注入 `noExtensions: true` 禁用所有 extension 加载
* 通过 `skillsOverride` 注入测试用 skill
* 通过 `systemPromptOverride` 为不同产品壳提供不同的 system prompt

这比 mock 整个 ResourceLoader 简单得多。

---

## 八、取舍分析

### 得到了什么

**1. 统一的心智模型。** 所有资源遵循同样的路径合并优先级（CLI > 包 > additional）和加载模式（merge → load → override → sourceInfo）。用户学会一套规则就能理解所有资源的行为。

**2. 渐进式降级。** 任何单个资源加载失败都不会阻塞系统启动。通过 diagnostic 机制，用户可以在启动后看到哪些资源加载失败了，但系统仍然可用。`reload()` 中每个步骤的 try/catch 让一个 skill 文件的格式错误不会影响 extension 的加载。

**3. 两阶段资源发现。** `extendResources()` 让 extension 可以动态追加资源，而不需要触发完整 reload。这让扩展系统从"静态配置"升级为"动态装配" — extension 在 `resources_discover` 事件中可以继续声明新的 skill 和 prompt。

**4. 可测试性。** `noXxx` 开关 + override 钩子让测试可以精确控制每种资源的加载结果。不需要 mock 文件系统或 PackageManager。

**5. 来源可追踪。** 每项资源都带有 `sourceInfo`（来自哪个 package、是用户级还是项目级、是包来源还是顶层配置）。这让 TUI 可以展示"这个 skill 来自哪个 npm 包"，也让冲突报告有意义。

### 放弃了什么

**1. 资源类型之间的差异被抹平。** Extension 需要执行 setup、skill 只需读文件、theme 需要验证 schema。统一入口需要为最复杂的类型（extension）设计接口，这导致接口上有些设计（如 `reload` 的异步性）对简单资源来说存在过度抽象。

**2. 加载顺序不够透明。** 全局 → 项目 → npm 包 → CLI 额外路径 → extension 动态追加 — 当多个来源都提供了同名资源时，用户需要理解完整的合并顺序才能预测最终结果。虽然有 collision 诊断，但合并过程本身不够可观测。

**3. npm 包来源的覆盖优先级反直觉。** npm 包资源在合并顺序中最后加载（优先级高于本地全局/项目目录），这意味着显式安装的 npm 包会覆盖本地资源。对于习惯了"本地配置优先"的用户来说，这可能需要适应。

**4. 无增量重载。** `reload()` 是全量重建。即使只有一个 skill 文件变更，也会重新解析所有 extensions、skills、prompts、themes。`extendResources()` 提供了局部增量，但那是追加语义，不是更新/删除已有资源。

**5. 内存缓存无过期机制。** 资源加载后缓存在内存中，`get*()` 返回缓存引用。如果外部持有缓存引用并在 reload 之间修改了内容，不会自动感知。这是"reload 时重建整个缓存"策略的必然结果 — 缓存的生命周期等于两次 reload 之间的间隔。

对于 pi 的使用场景 — 单用户、本地文件系统、资源数量通常在几十个以内 — 全量重建的开销可以忽略（几十 ms），简单性远胜于增量更新的复杂性。

---

### 版本演化说明
> 本章核心分析基于 pi-mono v0.66.0。ResourceLoader 的来源随着 npm 包支持的加入
> 从两级（全局 + 项目）扩展到了三级（全局 + 项目 + npm 包）。
