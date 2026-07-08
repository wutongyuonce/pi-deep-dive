# resource-loader.ts 源码解析

`resource-loader.ts` 是 coding-agent 的**统一资源加载层**，对外暴露 `ResourceLoader` 接口，对内协调 Extension、Skill、Prompt、Theme、Context File 五种资源的发现、加载、去重和诊断。

## 文件定位

```
         ┌─────────────────────────────────────────────┐
         │              AgentSession                    │
         │  (消费 getExtensions/skills/prompts/themes)  │
         └──────────────────┬──────────────────────────┘
                            │
         ┌──────────────────▼──────────────────────────┐
         │         DefaultResourceLoader                │
         │  ┌──────────────────────────────────────┐    │
         │  │  reload() — 统一重载所有资源          │    │
         │  └──────────┬───────────────────────────┘    │
         │             │                                 │
         │  ┌──────────▼───────────────────────────┐    │
         │  │  PackageManager.resolve()             │    │
         │  │  → 收集用户级/项目级/npm包的资源路径    │    │
         │  └──────────┬───────────────────────────┘    │
         │             │                                 │
         │  ┌──────────▼───────────────────────────┐    │
         │  │  Skills / Prompts / Themes 加载器     │    │
         │  │  extensions/loader.ts                 │    │
         │  └──────────────────────────────────────┘    │
         └──────────────────────────────────────────────┘
```

调用链路：

- 应用启动 → `createSessionServices()` → `new DefaultResourceLoader()` → `.reload()`
- `/reload` 命令 → `AgentSession.reload()` → `resourceLoader.reload()`
- 扩展运行时 → `resourceLoader.extendResources()`

## 接口与类型定义

### ResourceLoader 接口（L50-L60）

对外暴露的公共契约，只有 7 个方法：

| 方法 | 用途 |
|------|------|
| `getExtensions()` | 获取已加载的扩展及其运行时 |
| `getSkills()` | 获取技能列表 + 诊断 |
| `getPrompts()` | 获取提示词模板 + 诊断 |
| `getThemes()` | 获取主题 + 诊断 |
| `getAgentsFiles()` | 获取 AGENTS.md 上下文链 |
| `getSystemPrompt()` | 获取主系统提示词 |
| `getAppendSystemPrompt()` | 获取附加系统提示词列表 |
| `extendResources()` | 运行时动态追加资源路径 |
| `reload()` | 完整重载所有资源 |

### ResourceExtensionPaths（L44-L48）

扩展在加载后可以动态声明额外资源的类型：

```ts
export interface ResourceExtensionPaths {
  skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
  promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
  themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}
```

注意：Extension 本身只能追加 skills/prompts/themes，不能追加其他 extensions。

### DefaultResourceLoaderOptions（L215-L250）

构造函数参数，核心设计是"开箱即用 + 处处可覆盖"：

- **基础配置**：`cwd`、`agentDir`（必填），`settingsManager`/`eventBus`（可选，自动创建）
- **CLI 额外路径**：`additionalExtensionPaths`、`additionalSkillPaths` 等
- **禁用开关**：`noExtensions`、`noSkills`、`noPromptTemplates`、`noThemes`、`noContextFiles`
- **Override 钩子**：每种资源类型都有对应的 `xxxOverride` 回调，在加载完成后调用，允许外部在不修改源码的情况下过滤、替换或增强资源列表

---

## 模块级工具函数

### resolvePromptInput（L78-L97）

将用户输入统一解析为字符串内容，遵循"文件优先、字符串兜底"原则：

1. 空输入直接返回 `undefined`
2. 若输入路径在文件系统存在 → 读取文件内容返回
3. 若文件读取失败 → 打印警告，退回使用原始输入文本
4. 若路径不存在 → 将输入视为纯文本字符串直接返回

### loadContextFileFromDir（L115-L135）

在单个目录中查找上下文文件：

1. 按固定优先级尝试候选文件名：`AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`
2. 找到首个存在的文件后立即读取并返回 `{ path, content }`
3. 若读取失败则继续尝试后续候选
4. 全部未找到返回 `null`

### loadProjectContextFiles（L157-L199）- 导出

从 cwd 向上遍历所有祖先目录，构建项目级上下文链（全局 → 祖先 → 当前）：

1. 解析 `cwd` 和 `agentDir` 为绝对路径
2. 先加载全局 `agentDir` 中的上下文文件（优先级最高，排最前面）
3. 从 cwd 开始向上遍历到根目录 `/`
4. 每层目录调用 `loadContextFileFromDir()` 查找
5. 使用 `unshift` 确保离根越近的目录越靠前
6. 最终顺序：`[全局上下文, /AGENTS.md, /home/AGENTS.md, ..., /cwd/AGENTS.md]`

---

## DefaultResourceLoader 类

### 构造函数（L342-L395）

职责是**保存配置 + 初始化空缓存**，不做任何实际加载：

1. 解析 `cwd` 和 `agentDir` 为绝对路径
2. 创建或注入 `SettingsManager` 和 `EventBus`
3. 创建 `DefaultPackageManager` 实例，传入 `cwd`、`agentDir`、`settingsManager`
4. 保存所有 `additional*Paths`、`extensionFactories`、`no*` 禁用开关
5. 保存所有 `*Override` 钩子函数
6. 将所有缓存字段初始化为空值（空数组、空 Map）

### Getter 方法（L409-L508）

六大 getter（`getExtensions`、`getSkills`、`getPrompts`、`getThemes`、`getAgentsFiles`、`getSystemPrompt`、`getAppendSystemPrompt`）都是**纯只读访问器**，直接返回内部缓存字段。设计意图：

- 调用方可以随时调用这些方法获取最新状态
- 方法本身不做任何计算，开销极低
- 所有缓存由 `reload()` 或 `extendResources()` 负责更新

---

## 核心方法: reload()（L593-L771）

`reload()` 是整个 Resource Loader 的心脏，每次调用执行 12 个步骤完成一次完整资源重载。下面按步骤详述：

### 步骤 1：刷新设置与包源解析（L595-L599）

```
settingsManager.reload() → packageManager.resolve() → resolvedPaths
                                                      ↓
                                    packageManager.resolveExtensionSources()
                                    → cliExtensionPaths（CLI 临时扩展）
```

- 先刷新设置文件（用户可能在 `reload` 之间修改了 `settings.json`）
- 然后通过 `PackageManager.resolve()` 获取所有已安装包的资源路径
- 再单独解析 CLI 传入的临时扩展路径（标记为 `temporary` 作用域）
- 重建 `metadataByPath` 映射（记录每个路径的来源元数据）和扩展动态资源来源映射

### 步骤 2：过滤启用资源 + SKILL.md 自动映射（L608-L651）

使用两个内联辅助函数：

- `getEnabledResources()` — 提取 `enabled: true` 的资源，同时填充 `metadataByPath`
- `getEnabledPaths()` — 从启用资源中提取纯路径数组

对 skill 资源有特殊处理：若 skill 路径是自动发现（`source: "auto"`）或来自 npm 包（`origin: "package"`），且路径指向一个目录，则自动查找目录下的 `SKILL.md` 文件作为实际 skill 路径。这让 npm 包可以用目录组织 skill。

### 步骤 3：填充 CLI 临时资源元数据（L653-L662）

为 CLI 传入的临时扩展和技能路径统一标记 `{ source: "cli", scope: "temporary", origin: "top-level" }`，确保后续 `findSourceInfoForPath()` 能正确推断来源。

### 步骤 4：加载扩展（L669-L677）

```
mergePaths(cli扩展路径, 包源扩展路径) → extensionPaths
    ↓
loadExtensions(extensionPaths, cwd, eventBus) → extensionsResult
    ↓
loadExtensionFactories(runtime) → inlineExtensions
    ↓
extensionsResult.extensions.push(...inlineExtensions.extensions)
```

1. 如果 `noExtensions` 为 true，跳过包源扩展，只保留 CLI 临时扩展
2. 调用 `loadExtensions()` 从磁盘加载扩展（使用 jiti 编译和执行 `.ts` 文件）
3. 调用 `loadExtensionFactories()` 加载内联扩展工厂（每个工厂被执行，返回 Extension 对象，路径标记为 `<inline:N>`）

### 步骤 5：冲突检测（L679-L683）

调用 `detectExtensionConflicts()` 检查多个扩展之间的工具名和标志名冲突：

- 维护 `toolOwners` 和 `flagOwners` 两个 Map
- 遍历扩展，同名工具/标志的后出现者被记录为冲突诊断
- 冲突只记录不阻止 — 所有扩展仍然保留在结果中

### 步骤 6：额外路径存在性校验（L685-L695）

遍历 `additionalExtensionPaths` 中的本地路径，检查其是否实际存在：

- 对每个本地路径做 `existsSync()` 检查
- 不存在的路径被记录为错误诊断

最后应用 `extensionsOverride` 钩子（如果有），再调用 `applyExtensionSourceInfo()` 为扩展及其命令/工具打上来源信息。

### 步骤 7：计算并刷新技能缓存（L697-L711）

```
cliEnabledSkills + enabledSkills + additionalSkillPaths → skillPaths
    ↓
updateSkillsFromPaths(skillPaths, metadataByPath)
```

- 如果 `noSkills` 为 true，只保留 CLI 和手动添加的路径
- 校验额外的本地 skill 路径是否存在
- 不存在的路径记录为错误诊断

### 步骤 8：计算并刷新提示词模板缓存（L713-L731）

逻辑与步骤 7 相同，只是操作对象为 prompt templates。额外对不存在的本地路径做存在性检查。

### 步骤 9：计算并刷新主题缓存（L733-L745）

逻辑与步骤 7/8 相同，操作对象为 themes。

### 步骤 10：加载项目上下文文件链（L747-L752）

调用 `loadProjectContextFiles()` 从 `cwd` 向上查找 AGENTS.md/CLAUDE.md：

- 若 `noContextFiles` 为 true，返回空数组
- 应用 `agentsFilesOverride` 钩子

### 步骤 11：发现并解析主系统提示词（L754-L759）

```
systemPromptSource ?? discoverSystemPromptFile() → systemPrompt
```

优先级：

1. 构造时显式传入的 `systemPrompt`
2. 自动发现的 `SYSTEM.md` 文件（项目级 `.pi/SYSTEM.md` > 全局 `~/.pi/agent/SYSTEM.md`）
3. 通过 `resolvePromptInput()` 解析（支持文件路径或纯文本）
4. 应用 `systemPromptOverride` 钩子

### 步骤 12：发现并解析附加系统提示词（L761-L770）

同理，处理 `APPEND_SYSTEM.md`，但返回的是数组（可叠加多个附加提示）。

---

## 资源刷新方法

### updateSkillsFromPaths（L814-L842）

技能缓存刷新的统一入口，被 `reload()` 和 `extendResources()` 共用：

1. 若 `noSkills` 为 true 且无可用路径 → 清空结果
2. 否则调用 `loadSkills()` 从给定路径列表重新解析技能文件
3. 应用 `skillsOverride` 钩子
4. 为每个技能补齐 `sourceInfo`（优先级：扩展显式 metadata → skill 自带 sourceInfo → 默认推断）
5. 写入 `this.skills` 和 `this.skillDiagnostics`

### updatePromptsFromPaths（L859-L888）

提示词模板缓存刷新的统一入口：

1. 若 `noPromptTemplates` 且无路径 → 清空结果
2. 调用 `loadPromptTemplates()` 加载所有模板
3. 调用 `dedupePrompts()` 按名称去重，同名后出现的转为 collision 诊断
4. 应用 `promptsOverride` 钩子
5. 为每个模板补齐 `sourceInfo`
6. 写入 `this.prompts` 和 `this.promptDiagnostics`

### updateThemesFromPaths（L905-L931）

主题缓存刷新的统一入口：

1. 若 `noThemes` 且无路径 → 清空结果
2. 调用 `this.loadThemes()` 加载主题文件/目录
3. 调用 `dedupeThemes()` 按主题名去重
4. 合并加载诊断和去重诊断
5. 应用 `themesOverride` 钩子
6. 为每个主题补齐 `sourceInfo`（主题使用 `sourcePath` 字段而非 `filePath`）

---

## 来源信息推断

### findSourceInfoForPath（L976-L1024）

sourceInfo 查找的统一入口，服务于所有资源类型。按优先级查询：

1. 空路径 → `undefined`
2. `<inline:N>` 虚拟路径 → 走默认推断
3. **扩展动态注入的来源信息**最高优先级：检查 `extraSourceInfos` Map，支持精确匹配和父目录匹配
4. **包源元数据**次优先级：先精确匹配 `metadataByPath`，再退化为祖先目录匹配
5. 全部未命中 → `undefined`（由调用方继续走默认推断）

### getDefaultSourceInfoForPath（L1042-L1090）

当上述查找失败时的兜底推断逻辑：

1. 虚拟路径（`<xxx:y>`）→ `{ source: "xxx", scope: "temporary", origin: "top-level" }`
2. 位于 `~/.pi/agent/skills|prompts|themes|extensions/` 下 → `{ source: "local", scope: "user" }`
3. 位于 `.pi/skills|prompts|themes|extensions/` 下 → `{ source: "local", scope: "project" }`
4. 其余位置 → `{ source: "local", scope: "temporary" }`

---

## 工具/辅助方法

### extendResources（L527-L568）

运行时动态追加资源路径的入口：

1. 调用 `normalizeExtensionPaths()` 将扩展传入的路径解析为标准绝对路径
2. 将路径记录到对应的 `extension*SourceInfos` Map（供后续 sourceInfo 查找）
3. 对每种资源类型，如果新增路径非空 → `mergePaths()` 合并 → `update*FromPaths()` 刷新

设计意图：扩展在加载后可以声明额外资源（例如某个 extension 自带了一套 skill），这些资源不需要走完整 `reload()`。

### normalizeExtensionPaths（L784-L797）

规范化扩展传入的资源路径：

1. 调用 `resolveResourcePath()` 解析资源路径为绝对路径
2. 若 `metadata.baseDir` 存在，也同样解析为绝对路径
3. 返回规范化后的路径-元数据对

### mergePaths（L1105-L1119）

合并两组路径并去重：

1. 按 `[...primary, ...additional]` 的顺序遍历
2. 每个路径先调用 `resolveResourcePath()` 再 `canonicalizePath()`
3. 用 Set 去重，保留首次出现者
4. 返回去重后的绝对路径数组

### resolveResourcePath（L1134-L1136）

单行封装，统一以 `cwd` 为基准解析路径：

- 调用 `resolvePath(p, this.cwd, { trim: true })`

### applyExtensionSourceInfo（L945-L958）

为扩展及其下属命令/工具统一附加来源信息：

1. 遍历每个 extension，查找其 sourceInfo
2. 将同一个 sourceInfo 传播给 extension 的所有 command 和 tool

---

## 主题加载链

### loadThemes（L1152-L1195）

主题加载的主入口：

1. 若 `includeDefaults` 为 true → 先加载默认目录（全局和项目下的 `themes/`）
2. 遍历传入的 paths 数组：
   - 路径不存在 → 记录 warning 诊断
   - 路径为目录 → 调用 `loadThemesFromDir()`
   - 路径为 `.json` 文件 → 调用 `loadThemeFromFile()`

### loadThemesFromDir（L1210-L1240）

从目录批量加载 `.json` 主题文件：

1. 目录不存在则静默跳过
2. 读取目录条目（`withFileTypes: true` 避免额外 stat）
3. 过滤：只处理 `.json` 文件，符号链接需跟随确认目标类型
4. 每个文件调用 `loadThemeFromFile()`

### loadThemeFromFile（L1254-L1262）

单文件主题加载的最小单元：

1. 调用 `loadThemeFromPath()`（theme 模块的解析器）
2. 成功则 push 到 themes 数组
3. 失败则记录为 warning 诊断（不中断其他主题加载）

---

## 冲突检测与去重

### detectExtensionConflicts（L1460-L1496）

扩展间的工具名和标志名冲突检测：

1. 维护 `toolOwners` Map（工具名 → 首个拥有者路径）
2. 维护 `flagOwners` Map（标志名 → 首个拥有者路径）
3. 遍历扩展列表，后出现的同名工具/标志记录为冲突信息
4. 冲突不阻止加载 — 实际优先级由扩展在数组中的顺序决定

### dedupePrompts（L1308-L1333）

按名称对提示词模板去重：

1. 用 Map 记录每个名称的首个出现
2. 后续同名模板记录为 `collision` 诊断（包含 winner/loser 路径）
3. 返回去重后的模板列表 + 冲突诊断

### dedupeThemes（L1346-L1372）

按名称对主题去重，逻辑与 `dedupePrompts` 一致，区别在于：

- 主题使用 `name` 字段（而非 `prompt.name`）
- 无名称主题统一归为 `"unnamed"`
- 冲突诊断的 `winnerPath`/`loserPath` 使用 `sourcePath`（而非 `filePath`）

---

## 自动发现方法

### discoverSystemPromptFile（L1386-L1399）

发现主系统提示词文件 `SYSTEM.md`：

1. 优先检查项目级 `.pi/SYSTEM.md`
2. 其次检查全局 `~/.pi/agent/SYSTEM.md`
3. 都不存在返回 `undefined`

### discoverAppendSystemPromptFile（L1413-L1426）

同理发现附加系统提示词文件 `APPEND_SYSTEM.md`。

---

## 内联扩展加载

### loadExtensionFactories（L1275-L1295）

加载通过构造函数注入的内联扩展工厂：

1. 遍历 `this.extensionFactories` 数组
2. 对每个工厂调用 `loadExtensionFromFactory(factory, cwd, eventBus, runtime, path)`
3. 虚拟路径格式：`<inline:1>`、`<inline:2>` 等
4. 单个工厂失败不中断后续加载，错误被收集到 errors 数组
5. 返回 `{ extensions, errors }`

---

## 整体设计模式

### 1. 缓存 + 懒加载

所有 getter 方法返回的都是上一次 `reload()` 或 `extendResources()` 的缓存结果。这避免了在读取资源时发生意外 I/O。

### 2. 渐进式降级

单个资源的加载失败不会阻塞其他资源的加载。所有错误被收集到 `diagnostics` 数组中，由上层自行决定如何处理。

### 3. Override 钩子

每种资源类型都提供了 override 钩子，允许外部在加载完成后、写入缓存前修改结果。这让测试、RPC mode 等场景可以在不 mock 整个 ResourceLoader 的情况下定制行为。

### 4. 来源信息传播

所有资源都附加了 `sourceInfo`，记录其来源（local/npm/git/cli）、作用域（user/project/temporary）和类型（top-level/package）。这为冲突诊断、UI 展示和调试提供了统一的元数据基础设施。
