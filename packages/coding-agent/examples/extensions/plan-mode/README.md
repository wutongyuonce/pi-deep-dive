# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Read-only tools**: Restricts available tools to read, bash, grep, find, ls, question
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status

## How It Works

### Plan Mode (Read-Only)
- Only read-only tools available
- Bash commands filtered through allowlist
- Agent creates a plan without making changes

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress

### Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`

---

# 中文翻译

## Plan Mode 扩展

用于安全代码分析的只读探索模式。

## 功能特性

- **只读工具集**：将可用工具限制为 `read`、`bash`、`grep`、`find`、`ls`、`question`
- **Bash 白名单**：只允许执行只读型 bash 命令
- **计划提取**：从 `Plan:` 段落中提取编号步骤
- **进度跟踪**：执行期间通过组件展示完成状态
- **`[DONE:n]` 标记**：显式跟踪每一步的完成情况
- **会话持久化**：恢复会话后仍可保留状态

## 命令

- `/plan` - 切换 plan mode
- `/todos` - 显示当前计划进度
- `Ctrl+Alt+P` - 切换 plan mode（快捷键）

## 用法

1. 用 `/plan` 或 `--plan` 参数启用 plan mode
2. 让 agent 分析代码并创建计划
3. agent 应在 `Plan:` 标题下输出一个编号计划：

```text
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. 在提示出现时选择 “Execute the plan”
5. 执行过程中，agent 会使用 `[DONE:n]` 标签标记步骤已完成
6. 进度组件会显示完成状态

## 工作原理

### Plan Mode（只读）

- 只开放只读工具
- Bash 命令会经过白名单过滤
- Agent 只生成计划，不做修改

### 执行模式

- 恢复完整工具权限
- Agent 按顺序执行各个步骤
- 使用 `[DONE:n]` 标记跟踪完成状态
- 组件会显示进度

### 命令白名单

允许的安全命令：

- 文件查看：`cat`、`head`、`tail`、`less`、`more`
- 搜索：`grep`、`find`、`rg`、`fd`
- 目录：`ls`、`pwd`、`tree`
- Git 只读：`git status`、`git log`、`git diff`、`git branch`
- 包信息：`npm list`、`npm outdated`、`yarn info`
- 系统信息：`uname`、`whoami`、`date`、`uptime`

被阻止的命令：

- 文件修改：`rm`、`mv`、`cp`、`mkdir`、`touch`
- Git 写操作：`git add`、`git commit`、`git push`
- 安装依赖：`npm install`、`yarn add`、`pip install`
- 系统级操作：`sudo`、`kill`、`reboot`
- 编辑器：`vim`、`nano`、`code`
