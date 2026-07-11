# Skills 不是代码是文档 `core/skills.ts`

## 一、`Skill` `SkillFrontmatter` 接口

Skill 是**带 frontmatter 的 markdown 文件**。它的类型定义极其简洁：

```typescript
/** 加载后的技能对象 */
export interface Skill {
	name: string; // 技能名称
	description: string; // 技能描述
	filePath: string; // SKILL.md 文件的绝对路径
	baseDir: string; // 技能所在的基础目录（SKILL.md 的父目录）
	sourceInfo: SourceInfo; // 资源来源信息
	disableModelInvocation: boolean; // 是否禁止模型自动调用
}
```

六个字段，没有任何可执行代码。Skill 的全部运行时能力就是**被 LLM 读取**。

对应的 frontmatter 接口同样极简：

```typescript
/** SKILL.md 文件的 frontmatter 数据结构 */
export interface SkillFrontmatter {
	name?: string; // 技能名称（可选，默认使用父目录名）
	description?: string; // 技能描述（必填）
	"disable-model-invocation"?: boolean; // 是否禁止模型自动调用（仅允许通过 /skill:name 手动调用）
	[key: string]: unknown;
}
```

三个已知字段加一个 index signature — skill 的 metadata 可以携带任意额外信息，但系统只关心名称、描述和是否允许 LLM 自动调用。

#### 一个完整的 Skill 示例

让我们看一个真实的 skill 文件，理解 frontmatter 和内容体的关系：

```markdown
---
name: tdd
description: >
  Test-driven development workflow.
  Use when implementing any feature or bugfix where tests
  are feasible. Guides the red-green-refactor cycle with
  emphasis on writing minimal tests first.
---

## When to use

When implementing any feature or bugfix where automated
tests are feasible. Especially important for:
- Bug fixes (write the regression test FIRST)
- New API endpoints
- Data transformation functions

## Steps

1. **Red**: Write the smallest test that expresses the requirement
2. **Run**: Execute the test, confirm it fails for the right reason
3. **Green**: Write the minimal implementation to make the test pass
4. **Run**: Execute the test again, confirm it passes
5. **Refactor**: Improve the implementation without changing behavior
6. **Run**: Confirm tests still pass after refactoring

## Important

- Do NOT write implementation before the test exists
- Each test should test ONE behavior
- If a test is hard to write, the interface needs redesigning
```

Frontmatter 中的 `name` 必须匹配父目录名（如 `skills/tdd/SKILL.md`）。`description` 是注入 system prompt 的部分 — 它是 LLM 决定"要不要读这个 skill"的唯一依据，所以应该包含足够的触发条件信息。

正文（`## When to use` 以下）不会自动注入 prompt — 只有当 LLM 认为当前任务匹配 description 时，它会用 `read` 工具读取完整文件。

当 `disable-model-invocation: true` 时，skill 不会出现在 system prompt 的 `<available_skills>` 列表中，LLM 无法自动发现和加载它。这类 skill 只能通过用户的 `/skill:name` 命令显式触发。适用场景：包含敏感指令、或只在特定上下文中才有意义的 skill。

## 二、`loadSkills()` Skills 载入

Skill 的载入过程是系统中最体现"约定优于配置"哲学的部分。

```ts
/** 技能全局加载选项 */
export interface LoadSkillsOptions {
	cwd: string; // 工作目录（用于项目级技能）
	agentDir: string; // Agent 配置目录（用于全局技能）
	skillPaths: string[]; // 显式指定的技能路径（文件或目录）
	includeDefaults: boolean; // 是否包含默认技能目录
}

/**
 * 定位：技能资源的总加载入口。
 * 作用：合并用户级、项目级和显式路径的技能，并统一处理去重与冲突诊断。
 * 调用关系：由 resource-loader.ts 的重载流程调用，结果再进入系统提示和命令注册链路。
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
```

**关注点：**

* `addSkills()` **载入优先级**：**全局 skill 优先于项目 skill**
* `loadSkillsFromDirInternal()`
  * **目录 Skill 加载规则**

  * **遵循 ignore 规则**：发现过程会读取 `.gitignore`、`.ignore`、`.fdignore` 文件，跳过被忽略的路径。这意味着你可以在 skill 目录中放置工作文件而不用担心它们被加载为 skill


### 步骤1：根据传入的 `LoadSkillsOptions` 进行初始化

```typescript
const { agentDir, skillPaths, includeDefaults } = options;

const resolvedCwd = resolvePath(options.cwd);
const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

const skillMap = new Map<string, Skill>();
const realPathSet = new Set<string>();
const allDiagnostics: ResourceDiagnostic[] = [];
const collisionDiagnostics: ResourceDiagnostic[] = [];
```

1、解析 `cwd` 和 `agentDir` 的绝对路径，如果没有提供 `agentDir`，就用 config.ts 提供的 `getAgentDir()`。

2、初始化三个数据结构：

- `skillMap` (`Map<name, Skill>`) — 最终技能表，以名称去重，先到先得
- `realPathSet` (`Set<realPath>`) — 已加载文件的真实路径集合，防止同一文件通过软链接或不同相对路径被重复加载
- `allDiagnostics` / `collisionDiagnostics` — 诊断信息收集器

### 步骤 2：若 `includeDefaults` 为 true，先 `addSkills()` 载入两个默认 Skill 目录

```ts
addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));
```

1. `<agentDir>/skills`（用户级，source: `"user"`）
2. `<cwd>/.pi/skills`（项目级，source: `"project"`）

#### `addSkills()` 载入（全局 Skill 优先）

遍历一批 skill，解析真实路径后做两重去重——先查 `realPathSet`（同文件不重复加载），再查 `skillMap`（同名冲突记录 collision 类型的 diagnostic，保留先到者）。

* 如果全局和项目 skill 目录中有 symlink 指向同一个文件，只加载一次。这和名称冲突（记录 diagnostic，需要让用户知道）不同 — **symlink 去重是完全静默的**，因为它不是错误，只是重复引用。

* **加载顺序决定了优先级**：**先加载的优先级高**。全局 skill（`~/.pi/agent/skills/`）先于项目 skill（`.pi/skills/`）加载。这意味着**全局 skill 优先**。

#### `loadSkillsFromDirInternal()` 从目录递归加载 Skill

```ts
/** 从目录加载技能的选项 */
export interface LoadSkillsFromDirOptions {
	dir: string; // 要扫描技能的目录
	source: string; // 来源标识（如 "user"、"project"、"path"）
}

export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

// 递归函数，扫描一个目录并加载其中的 skill 文件
function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
    const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
```

1、**初始化**

* 缺失目录，直接返回空结果按“无技能”处理，避免把可选目录当成错误。

  ```typescript
  if (!existsSync(dir)) return { skills, diagnostics };
  ```

* 初始化 root （递归过程始终不变的根目录引用）和 ig（IgnoreMatcher ，累积 ignore 规则）。

  ```typescript
  const root = rootDir ?? dir;
  const ig = ignoreMatcher ?? ignore();
  ```

* 调用 `addIgnoreRules(ig, dir, root)` 把当前目录下的 ignore 文件规则合并进匹配器，后续递归的子目录会继承同一个匹配器。

  ```typescript
  // 将当前目录下的 .gitignore/.ignore/.fdignore 规则合并进 ignore 匹配器。
  function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
  	步骤 1：计算当前目录相对于根目录的前缀。这是为了让 ignore 规则中的相对路径在递归扫描时语义正确——每层目录的规则都要带上从根目录到此目录的路径前缀。
  	步骤 2：检查当前目录下是否存在 ignore 文件。
  	步骤 3：读取文件按行分割后，过滤掉空行和非字符串结果，调用 prefixIgnorePattern(line, prefix) 给每条规则加上前缀，保证匹配时以根目录为基准。
      步骤 4：合并进匹配器 ig.add(patterns)，将规则追加到共享的 IgnoreMatcher 中。由于匹配器在递归各层间共享，当前层添加的规则自动影响所有后代目录。
  }
  ```

  > **为什么需要给每条规则加上前缀**
  >
  > ```
  > ~/.pi/skills/          ← rootDir, prefix=""
  > ├── .gitignore         ← 规则 "*.log" → 直接保留
  > ├── sub/
  > │   ├── .gitignore     ← 规则 "*.md" → 转换为 "sub/*.md"
  > │   └── foo.md
  > ```
  >
  > 如果不加前缀，`sub/.gitignore` 里的 `*.md` 会无知地匹配根目录下的 `.md` 文件，造成错误忽略。加上 `sub/` 前缀后，`sub/*.md` 只匹配 `sub/` 目录下的文件，语义正确。

2、**第一轮遍历：查找 SKILL.md**

遍历当前目录的所有条目， 只找名为 SKILL.md 的条目 （其余跳过）。

找到 SKILL.md 后：

1. 判断是否真的是文件 （处理符号链接：如果是软链接则 statSync 取真实类型，断链/无权限则跳过）
2. 检查是否被 ignore 规则命中（命中则跳过）
3. 通过后立即 `loadSkillFromFile()` 加载该文件并返回 — 一旦某个目录包含 SKILL.md ，该目录就被视为一个完整技能单元，不再继续向下扫描子目录。

这表达了**核心约定： 目录里有 SKILL.md → 它是一个技能 → 加载它，停止下钻。**

3、**第二轮遍历：递归扫描子目录和散落 .md 文件**

只有当前目录没有 SKILL.md 时才会进入这一步。

遍历每个条目：

1. 跳过隐藏目录 （ . 开头）— 内部元数据/缓存不参与发现
2. 跳过 node_modules — 依赖目录体积大，扫描低效且来源不受控
3. 处理符号链接 — 判断链接指向的是目录还是文件，断链则跳过
4. 应用 ignore 规则 — 目录路径补 / 后匹配，被忽略则跳过

对目录 ：递归调用自身，传入 includeRootFiles: false 。子目录模式只认 SKILL.md ，不认散落的 .md 文件（避免把普通文档误识别为技能）。

对文件 ：三条件同时满足才调用 `loadSkillFromFile()` 加载：

- 是文件
- includeRootFiles === true （只有根目录模式为 true）
- 文件名以 .md 结尾

这样根目录可以兼容"多个 markdown 技能文件并列"的场景（如 ~/.pi/skills/foo.md 、 ~/.pi/skills/bar.md ），子目录则强制走 SKILL.md 约定。

##### 目录 Skill 加载规则

**规则 1**：如果目录包含 `SKILL.md`，这个目录就是一个 skill 包。`SKILL.md` 是 skill 的入口文件，目录名就是 skill 名。不再向下递归 — skill 包内的其他 `.md` 文件是 skill 的内部文件（可以被引用但不单独加载）。

**规则 2**：根目录下的 `.md` 文件（非 `SKILL.md`）被当作独立 skill 加载。这是简化模式 — 不需要创建子目录。

**规则 3**：递归扫描子目录寻找 `SKILL.md`。支持任意深度的目录结构。

```
skills/
├── tdd/
│   └── SKILL.md          # → skill "tdd"（规则 1）
├── code-review/
│   ├── SKILL.md           # → skill "code-review"（规则 1）
│   └── checklist.md       # 内部文件，不独立加载
├── quick-tips.md          # → skill "quick-tips"（规则 2）
└── advanced/
    └── perf-tuning/
        └── SKILL.md       # → skill "perf-tuning"（规则 3）
```

##### `loadSkillFromFile()` 单 Skill 文件解析器

解析单个 `.md` 技能文件为运行时 `Skill` 对象。 

```ts
function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
```

1. **读取文件并解析 frontmatter**

   ```ts
   const rawContent = readFileSync(filePath, "utf-8");
   const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
   ```

   提取 `skillDir`（文件所在目录）和 `parentDirName`（父目录名），后者用于兜底技能名。

   ```ts
   const skillDir = dirname(filePath);
   const parentDirName = basename(skillDir);
   ```

2. **`validateDescription()` 校验 frontmatter 中的 `description` 字段后保存 warning 类型的 diagnostic**

3. **确定技能名并校验**

   优先用 frontmatter 里的 `name`，没有则用父目录名兜底。这让最简技能文件只需写 `description` 就能被识别。然后 `validateName()` 校验 Skill 名称后保存 warning 类型的 diagnostic。

   * **约束**：**小写字母、数字、连字符，最长 64 字符，不能以连字符开头或结尾，不能有连续连字符**。确保 skill 名可以安全地用作文件路径、命令名、XML 标签。

4. **当 description 完全缺失或为空字符串时阻断 Skill 加载**，返回 `{skill: null, diagnostics}`。

   阻断原因：description 是模型判断技能适用场景的依据，没有它就无法正确路由技能。

5. **组装 Skill 对象**

   ```ts
   {
       name,                              // 技能名
       description,                       // 技能描述（用于模型路由）
       filePath,                          // 文件路径
       baseDir: skillDir,                 // 文件所在目录（技能执行时的基准目录）
       sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
       disableModelInvocation: frontmatter["disable-model-invocation"] === true,
   }
   ```

   - `sourceInfo`：根据路径和 source 生成来源信息（如 "用户级技能" / "项目级技能"）

   - `disableModelInvocation`：若 frontmatter 设为 true，模型不会自动调用此技能，只能通过 `/skill:name` 手动触发


6. **异常兜底**

   整段 `try/catch` 包裹。读文件或解析过程中抛异常时，转成 warning 诊断并返回 `{skill: null, diagnostics}`，不阻断其他技能的加载。

###### Frontmatter 解析

Skill 文件的 frontmatter 通过 `utils/frontmatter.ts` 中通用的 `parseFrontmatter` 函数解析：

```typescript
// utils/frontmatter.ts
export const parseFrontmatter = <T extends Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> => {
    const { yamlString, body } = extractFrontmatter(content);
    if (!yamlString) {
      return { frontmatter: {} as T, body };
    }
    const parsed = parse(yamlString);
    return { frontmatter: (parsed ?? {}) as T, body };
};
```

解析规则：以 `---` 开头和 `\n---` 结尾的 YAML 块被提取为 frontmatter，剩余部分为 body。没有 frontmatter 的 markdown 文件返回空对象 — 这意味着 skill 仍然可以加载，但会因缺少 `description` 而产生验证警告。

###### 根据来源标识创建技能的 SourceInfo

```typescript
function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			// 用户级技能固定标记为 local/user，便于后续诊断与优先级判定。
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			// 项目级技能与用户级技能同属 local，但 scope 不同。
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			// 显式路径可能来自任意位置，这里只保留 local 和 baseDir，不额外附带 scope。
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			// 兜底分支保留原始 source 字符串，方便未来扩展新的来源类型。
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}
```

### 步骤 3：处理 `skillPaths` 中的每条显式路径

1. **解析为绝对路径**，若路径不存在则记 warning 并跳过
2. **判定来源标签**：通过 `getSource()` 判断该路径落在用户目录、项目目录还是外部路径（`"user"` / `"project"` / `"path"`）。当默认目录未加载时，落在默认目录内的显式路径仍会被正确标记为 `"user"` 或 `"project"`。
3. **按路径类型加载**：
   - **目录** → 调用 `loadSkillsFromDirInternal()` 递归扫描目录下所有 `.md` 文件，批量加载
   - **`.md` 文件** → 调用 `loadSkillFromFile()` 解析单个 skill 文件
   - **非 `.md` 文件** → 记 warning，跳过
4. **异常兜底**：`statSync` 或加载过程中抛错，转为 warning 诊断，不阻断整体流程

### 步骤 4：返回结果 `LoadSkillsResult`

将 `skillMap` 的值转数组作为最终 skill 列表，合并 `allDiagnostics` 和 `collisionDiagnostics` 一起返回。诊断信息不会阻断加载，只是供调用方（`resource-loader.ts`）展示给用户。

```ts
/** 技能加载结果 */
export interface LoadSkillsResult {
	skills: Skill[]; // 加载成功的技能列表
	diagnostics: ResourceDiagnostic[]; // 加载过程中的诊断信息（警告、错误、冲突）
}
```

```ts
return {
    skills: Array.from(skillMap.values()),
    diagnostics: [...allDiagnostics, ...collisionDiagnostics],
};
```

## 三、`formatSkillsForPrompt()` 可见 Skills 到 prompt 中的 `<available_skills>`

载入完成后，可见的 skills 需要被转换为 XML 片段（[Agent Skills 标准](https://agentskills.io/integrate-skills)）后才能注入 system prompt。

```typescript
/**
 * 将技能列表格式化为系统提示词中的 XML 片段，遵循 Agent Skills 标准的 XML 格式。
 * disableModelInvocation=true 的技能会被排除（只能通过 /skill:name 命令手动调用）。
 * 被前端会话构建流程调用，将技能信息注入 LLM 的系统提示词。
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	// 没有可自动调用的技能时返回空串，避免在系统提示中注入空壳 XML。
	if (visibleSkills.length === 0) return "";

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		// 每个技能只暴露名称、描述和定位信息，具体内容由模型按需再去 read。
		// 这种“先目录、后展开”的设计能把系统提示词体积控制在较小范围内。
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

/** XML 特殊字符转义 */
function escapeXml(str: string): string {
	// 技能描述直接写入 XML 文本节点，必须先转义特殊字符，避免破坏标签结构。
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
```

关键设计决策：

* **XML 格式**。Skill 列表使用 XML 标签而不是 markdown 或 JSON，遵循 [Agent Skills 标准](https://agentskills.io/integrate-skills)。XML 在 LLM prompt 中有明确的起止标记，不容易和自然语言混淆。
* **只注入 metadata，不注入全文**。每个 skill 只贡献 name + description + location 三个字段到 prompt。完整内容需要 LLM 用 `read` 工具主动读取。
* **preamble 指令**。XML 列表前面有三行指令文本，告诉 LLM：(1) skill 提供任务特化的指令，(2) 要用 read 工具加载匹配的 skill，(3) skill 内的相对路径要基于 skill 目录解析。第三点容易被忽视但很重要 — skill 可能引用同目录下的模板文件或配置文件。
* **disableModelInvocation 过滤**。标记了 `disable-model-invocation: true` 的 skill 在此处被过滤掉，LLM 完全看不到它们。

