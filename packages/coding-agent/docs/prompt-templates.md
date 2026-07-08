> pi 可以创建提示词模板（prompt templates）。让它为你的工作流构建一个。

# 提示词模板（Prompt Templates）

提示词模板是扩展为完整提示词的 Markdown 片段。在编辑器中输入 `/name` 来调用模板，其中 `name` 是不带 `.md` 扩展名的文件名。

## 位置

Pi 从以下位置加载提示词模板：

- 全局：`~/.pi/agent/prompts/*.md`
- 项目：`.pi/prompts/*.md`
- 包（Packages）：`prompts/` 目录或 `package.json` 中的 `pi.prompts` 条目
- 设置（Settings）：`prompts` 数组，包含文件或目录路径
- 命令行（CLI）：`--prompt-template <path>`（可重复）

使用 `--no-prompt-templates` 禁用自动发现。

## 格式

```markdown
---
description: 审查暂存的 git 变更
---
审查已暂存的变更（`git diff --cached`）。重点关注：
- Bug 和逻辑错误
- 安全问题
- 错误处理遗漏
```

- 文件名成为命令名称。`review.md` 变为 `/review`。
- `description` 是可选的。如果缺失，则使用第一个非空行。
- `argument-hint` 是可选的。设置后，提示会在自动完成下拉菜单中显示在描述之前。

### 参数提示

在前置元数据中使用 `argument-hint` 来显示自动完成中的预期参数。使用 `<尖括号>` 表示必需参数，`[方括号]` 表示可选参数：

```markdown
---
description: 从 URL 审查 PR，进行结构化问题和代码分析
argument-hint: "<PR-URL>"
---
```

在自动完成下拉菜单中显示为：

```
→ pr   <PR-URL>       — 从 URL 审查 PR，进行结构化问题和代码分析
  is   <issue>        — 分析 GitHub issue（Bug 或功能请求）
  wr   [instructions] — 端到端完成当前任务
  cl   — 在发布前审计更新日志条目
```

## 使用方法

在编辑器中输入 `/` 后跟模板名称。自动完成会显示可用模板及其描述。

```
/review                           # 展开 review.md
/component Button                 # 带参数展开
/component Button "click handler" # 多个参数
```

## 参数

模板支持位置参数和简单切片：

- `$1`、`$2`、... 位置参数
- `$@` 或 `$ARGUMENTS` 所有参数拼接
- `${@:N}` 从第 N 个位置开始的参数（从 1 开始计数）
- `${@:N:L}` 从 N 开始的 L 个参数

示例：

```markdown
---
description: 创建一个组件
---
创建一个名为 $1 的 React 组件，功能：$@
```

用法：`/component Button "onClick handler" "disabled support"`

## 加载规则

- `prompts/` 中的模板发现是非递归的。
- 如果希望使用子目录中的模板，请通过 `prompts` 设置或包清单显式添加它们。
