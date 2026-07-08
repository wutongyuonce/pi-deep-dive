> pi 可以创建技能（skills）。让它为你的用例构建一个。

# 技能（Skills）

技能（Skills）是自包含的能力包，代理按需加载。技能为特定任务提供专门的工作流程、设置说明、辅助脚本和参考文档。

Pi 实现了 [Agent Skills 标准](https://agentskills.io/specification)，对大多数违规行为给出警告但仍保持宽容。Pi 允许技能名称与其父目录不同，尽管标准禁止这样做；该规则对于跨多个代理框架使用的共享技能目录来说并不理想。

## 目录

- [位置](#位置)
- [技能的工作原理](#技能的工作原理)
- [技能命令](#技能命令)
- [技能结构](#技能结构)
- [前置元数据（Frontmatter）](#前置元数据frontmatter)
- [验证](#验证)
- [示例](#示例)
- [技能仓库](#技能仓库)

## 位置

> **安全：** 技能可以指示模型执行任何操作，并且可能包含模型调用的可执行代码。使用前请审查技能内容。

Pi 从以下位置加载技能：

- 全局：
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- 项目：
  - `.pi/skills/`
  - `cwd` 及其上级目录中的 `.agents/skills/`（向上直到 git 仓库根目录，不在仓库中时直到文件系统根目录）
- 包（Packages）：`skills/` 目录或 `package.json` 中的 `pi.skills` 条目
- 设置（Settings）：`skills` 数组，包含文件或目录路径
- 命令行（CLI）：`--skill <path>`（可重复，即使使用 `--no-skills` 也会叠加加载）

发现规则：
- 在 `~/.pi/agent/skills/` 和 `.pi/skills/` 中，直接位于根目录的 `.md` 文件会被发现为独立技能
- 在所有技能位置中，包含 `SKILL.md` 的目录会被递归发现
- 在 `~/.agents/skills/` 和项目的 `.agents/skills/` 中，根目录的 `.md` 文件会被忽略

使用 `--no-skills` 禁用自动发现（通过 `--skill` 明确指定的路径仍会加载）。

### 使用其他框架的技能

要使用 Claude Code 或 OpenAI Codex 的技能，将其目录添加到设置中：

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

对于项目级别的 Claude Code 技能，添加到 `.pi/settings.json`：

```json
{
  "skills": ["../.claude/skills"]
}
```

## 技能的工作原理

1. 启动时，pi 扫描技能位置并提取名称和描述
2. 系统提示词按照[规范](https://agentskills.io/integrate-skills)以 XML 格式包含可用技能
3. 当任务匹配时，代理使用 `read` 加载完整的 SKILL.md（模型并不总是自动执行此操作；可使用提示词或 `/skill:name` 强制加载）
4. 代理按照指令执行，使用相对路径引用脚本和资源

这是一种渐进式信息透传：描述始终在上下文中，完整的指令按需加载。

## 技能命令

技能注册为 `/skill:name` 命令：

```bash
/skill:brave-search           # 加载并执行技能
/skill:pdf-tools extract      # 加载技能并传入参数
```

命令后的参数会以 `User: <args>` 的形式附加到技能内容中。

在交互模式下通过 `/settings` 或在 `settings.json` 中切换技能命令的启用：

```json
{
  "enableSkillCommands": true
}
```

## 技能结构

技能是一个包含 `SKILL.md` 文件的目录。其余文件自由组织。

```
my-skill/
├── SKILL.md              # 必需：前置元数据 + 指令
├── scripts/              # 辅助脚本
│   └── process.sh
├── references/           # 按需加载的详细文档
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md 格式

````markdown
---
name: my-skill
description: 该技能的功能及使用时机。请具体说明。
---

# My Skill

## 设置

首次使用前运行一次：
```bash
cd /path/to/skill && npm install
```

## 使用方法

```bash
./scripts/process.sh <input>
```
````

使用相对于技能目录的路径：

```markdown
详细信息请参见[参考指南](references/REFERENCE.md)。
```

## 前置元数据（Frontmatter）

根据 [Agent Skills 规范](https://agentskills.io/specification#frontmatter-required)：

| 字段 | 必需 | 描述 |
|-------|----------|-------------|
| `name` | 是 | 最长 64 个字符。仅限小写字母 a-z、数字 0-9、连字符。与标准不同，Pi 不要求此项与父目录名称匹配，因为该标准要求对于共享技能目录来说并不理想。 |
| `description` | 是 | 最长 1024 个字符。技能的用途及使用时机。 |
| `license` | 否 | 许可证名称或对打包文件的引用。 |
| `compatibility` | 否 | 最长 500 个字符。环境要求。 |
| `metadata` | 否 | 任意键值映射。 |
| `allowed-tools` | 否 | 以空格分隔的预批准工具列表（实验性）。 |
| `disable-model-invocation` | 否 | 为 `true` 时，技能在系统提示词中隐藏。用户必须使用 `/skill:name`。 |

### 名称规则

- 1-64 个字符
- 仅限小写字母、数字、连字符
- 不能以连字符开头或结尾
- 不能有连续连字符
- Pi 不要求名称与父目录匹配。Agent Skills 标准有此要求，但该要求对于多个工具使用的共享技能目录来说并不理想。

有效：`pdf-processing`、`data-analysis`、`code-review`
无效：`PDF-Processing`、`-pdf`、`pdf--processing`

### 描述最佳实践

描述决定了代理何时加载该技能。请具体说明。

良好：
```yaml
description: 从 PDF 文件中提取文本和表格，填写 PDF 表单，以及合并多个 PDF 文件。在处理 PDF 文档时使用。
```

较差：
```yaml
description: 帮助处理 PDF。
```

## 验证

Pi 根据 Agent Skills 标准验证技能。大多数问题会产生警告，但技能仍可加载：

- 名称超过 64 个字符或包含无效字符
- 名称以连字符开头/结尾或包含连续连字符
- 描述超过 1024 个字符

未知的前置元数据字段会被忽略。

**例外：** 缺少描述的技能不会被加载。

名称冲突（相同名称来自不同位置）会产生警告并保留第一个找到的技能。

## 示例

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md：**
````markdown
---
name: brave-search
description: 通过 Brave Search API 进行网页搜索和内容提取。用于搜索文档、资料或任何网络内容。
---

# Brave Search

## 设置

```bash
cd /path/to/brave-search && npm install
```

## 搜索

```bash
./search.js "query"              # 基本搜索
./search.js "query" --content    # 包含页面内容
```

## 提取页面内容

```bash
./content.js https://example.com
```
````

## 技能仓库

- [Anthropic Skills](https://github.com/anthropics/skills) - 文档处理（docx、pdf、pptx、xlsx），web 开发
- [Pi Skills](https://github.com/badlogic/pi-skills) - 网页搜索，浏览器自动化，Google API，转录
