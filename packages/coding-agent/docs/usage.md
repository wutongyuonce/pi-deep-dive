# 使用 Pi

本页收集了快速开始页面中未涵盖的日常使用细节。

## 交互模式

<p align="center"><img src="../images/interactive-mode.png" alt="交互模式" width="600"></p>

界面分为四个主要区域：

- **启动头** - 快捷键、已加载的上下文文件、提示模板、技能和扩展
- **消息区** - 用户消息、助手回复、工具调用、工具结果、通知、错误和扩展 UI
- **编辑器** - 输入区域；边框颜色表示当前思考级别
- **底栏** - 工作目录、会话名称、令牌/缓存用量、费用、上下文用量和当前模型

编辑器可被内置 UI（如 `/settings`）或自定义扩展 UI 临时替换。

### 编辑器功能

| 功能 | 操作方式 |
|---------|-----|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | 按 Tab 补全路径 |
| 多行输入 | Shift+Enter，或在 Windows Terminal 中使用 Ctrl+Enter |
| 图片 | 使用 Ctrl+V 粘贴，Windows 上使用 Alt+V，或拖入终端 |
| Shell 命令 | `!command` 运行并将输出发送给模型 |
| 隐藏 Shell 命令 | `!!command` 运行但不将输出发送给模型 |
| 外部编辑器 | Ctrl+G 打开 `$VISUAL` 或 `$EDITOR` |

所有快捷键及自定义请参阅[键绑定](zh/keybindings.md)。

## 斜杠命令

在编辑器中输入 `/` 打开命令补全。扩展可以注册自定义命令，技能可通过 `/skill:name` 使用，提示模板通过 `/templatename` 展开。

| 命令 | 描述 |
|---------|-------------|
| `/login`, `/logout` | 管理 API 密钥凭据 |
| `/model` | 切换模型 |
| `/scoped-models` | 启用/禁用用于 Ctrl+P 循环的模型 |
| `/settings` | 思考级别、主题、消息投递、传输方式 |
| `/resume` | 从之前的会话中选择 |
| `/new` | 开始新会话 |
| `/name <name>` | 设置会话显示名称 |
| `/session` | 显示会话文件、ID、消息、令牌和费用 |
| `/tree` | 跳转到会话中的任意节点并从中继续 |
| `/fork` | 从之前的用户消息创建新会话 |
| `/clone` | 将当前活动分支复制到新会话中 |
| `/compact [prompt]` | 手动压缩上下文，可选自定义指令 |
| `/copy` | 将最后一条助手消息复制到剪贴板 |
| `/export [file]` | 将会话导出为 HTML |
| `/share` | 上传为私有 GitHub Gist，附带可分享的 HTML 链接 |
| `/reload` | 重新加载键绑定、扩展、技能、提示和上下文文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 pi |

## 消息队列

你可以在代理仍在工作时提交消息：

- **Enter** 排队一条引导消息，在当前助手轮次完成工具调用后投递。
- **Alt+Enter** 排队一条后续消息，在代理完成所有工作后投递。
- **Escape** 中止并将排队消息恢复到编辑器中。
- **Alt+Up** 将排队消息取回编辑器。

在 Windows Terminal 上，Alt+Enter 默认为全屏。如果希望 pi 接收该快捷键，请按照[终端设置](zh/terminal-setup.md)中的说明重新映射。

在[设置](zh/settings.md)中通过 `steeringMode` 和 `followUpMode` 配置投递方式。

## 会话

会话会自动保存到 `~/.pi/agent/sessions/`，按工作目录组织。

```bash
pi -c                  # 继续最近一次会话
pi -r                  # 浏览并选择一个会话
pi --no-session        # 临时模式；不保存
pi --session <path|id> # 使用特定的会话文件或会话 ID
pi --fork <path|id>    # 将会话分支到新的会话文件
```

有用的会话命令：

- `/session` 显示当前会话文件和 ID。
- `/tree` 导航文件内会话树，并可汇总已放弃的分支。
- `/fork` 从早期用户消息创建新会话。
- `/clone` 将当前活动分支复制到新的会话文件中。
- `/compact` 汇总较旧的消息以释放上下文空间。

详情请参阅[会话](zh/sessions.md)和[压缩](zh/compaction.md)。

## 上下文文件

Pi 启动时会从以下位置加载 `AGENTS.md` 或 `CLAUDE.md`：

- `~/.pi/agent/AGENTS.md` 用于全局指令
- 父目录，从当前工作目录向上遍历
- 当前目录

使用上下文文件设置项目约定、命令、安全规则和偏好。使用 `--no-context-files` 或 `-nc` 禁用加载。

### 系统提示文件

使用以下文件替换默认系统提示：

- 项目级：`.pi/SYSTEM.md`
- 全局：`~/.pi/agent/SYSTEM.md`

在以上任一位置使用 `APPEND_SYSTEM.md` 可在不替换默认提示的情况下追加内容。

## 导出和分享会话

使用 `/export [file]` 将会话导出为 HTML。

使用 `/share` 上传为私有 GitHub Gist，附带可分享的 HTML 链接。

如果你将 pi 用于开源工作，并希望发布会话用于模型、提示、工具和评估研究，请参阅 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。它将会话发布到 Hugging Face 数据集。

## CLI 参考

```bash
pi [options] [@files...] [messages...]
```

### 包命令

```bash
pi install <source> [-l]     # 安装包，-l 表示项目本地安装
pi remove <source> [-l]      # 移除包
pi uninstall <source> [-l]   # remove 的别名
pi update [source|self|pi]   # 更新 pi 和包；同步固定的 git 引用
pi update --extensions       # 仅更新包；同步固定的 git 引用
pi update --self             # 仅更新 pi
pi update --extension <src>  # 更新单个包
pi list                      # 列出已安装的包
pi config                    # 启用/禁用包资源
```

这些命令管理 pi 包，而非 pi CLI 安装本身。要卸载 pi 本身，请参阅[快速开始](zh/quickstart.md#卸载)。

包来源和安全说明请参阅 [Pi 包](zh/packages.md)。

### 模式

| 标志 | 描述 |
|------|-------------|
| 默认 | 交互模式 |
| `-p`, `--print` | 打印回复并退出 |
| `--mode json` | 将所有事件输出为 JSON 行；参见 [JSON 模式](zh/json.md) |
| `--mode rpc` | 通过 stdin/stdout 的 RPC 模式；参见 [RPC 模式](zh/rpc.md) |
| `--export <in> [out]` | 将会话导出为 HTML |

在打印模式下，pi 也会读取通过管道传入的 stdin 并将其合并到初始提示中：

```bash
cat README.md | pi -p "Summarize this text"
```

### 模型选项

| 选项 | 描述 |
|--------|-------------|
| `--provider <name>` | 提供商，如 `anthropic`、`openai` 或 `google` |
| `--model <pattern>` | 模型模式或 ID；支持 `provider/id` 和可选的 `:<thinking>` |
| `--api-key <key>` | API 密钥，覆盖环境变量 |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `--models <patterns>` | 逗号分隔的模式，用于 Ctrl+P 循环切换 |
| `--list-models [search]` | 列出可用模型 |

### 会话选项

| 选项 | 描述 |
|--------|-------------|
| `-c`, `--continue` | 继续最近一次会话 |
| `-r`, `--resume` | 浏览并选择一个会话 |
| `--session <path\|id>` | 使用特定的会话文件或部分 UUID |
| `--fork <path\|id>` | 将会话文件或部分 UUID 分支到新会话 |
| `--session-dir <dir>` | 自定义会话存储目录 |
| `--no-session` | 临时模式；不保存 |

### 工具选项

| 选项 | 描述 |
|--------|-------------|
| `--tools <list>`, `-t <list>` | 仅允许特定的内置、扩展和自定义工具 |
| `--no-builtin-tools`, `-nbt` | 禁用内置工具，但保留扩展/自定义工具 |
| `--no-tools`, `-nt` | 禁用所有工具 |

内置工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。

### 资源选项

| 选项 | 描述 |
|--------|-------------|
| `-e`, `--extension <source>` | 从路径、npm 或 git 加载扩展；可重复 |
| `--no-extensions` | 禁用扩展发现 |
| `--skill <path>` | 加载技能；可重复 |
| `--no-skills` | 禁用技能发现 |
| `--prompt-template <path>` | 加载提示模板；可重复 |
| `--no-prompt-templates` | 禁用提示模板发现 |
| `--theme <path>` | 加载主题；可重复 |
| `--no-themes` | 禁用主题发现 |
| `--no-context-files`, `-nc` | 禁用 `AGENTS.md` 和 `CLAUDE.md` 发现 |

将 `--no-*` 与显式标志结合使用，可以精确加载所需内容，忽略设置中的配置。示例：

```bash
pi --no-extensions -e ./my-extension.ts
```

### 其他选项

| 选项 | 描述 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认提示；上下文文件和技能仍会附加 |
| `--append-system-prompt <text>` | 附加到系统提示之后 |
| `--verbose` | 强制显示详细启动信息 |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

### 文件参数

在文件名前加 `@` 以将其包含在消息中：

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

### 示例

```bash
# 交互模式，带初始提示
pi "List all .ts files in src/"

# 非交互模式
pi -p "Summarize this codebase"

# 非交互模式，带管道 stdin
cat README.md | pi -p "Summarize this text"

# 使用不同模型
pi --provider openai --model gpt-4o "Help me refactor"

# 带提供商前缀的模型
pi --model openai/gpt-4o "Help me refactor"

# 带思考级别简写的模型
pi --model sonnet:high "Solve this complex problem"

# 限制模型循环范围
pi --models "claude-*,gpt-4o"

# 只读模式
pi --tools read,grep,find,ls -p "Review the code"
```

### 环境变量

| 变量 | 描述 |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录；默认为 `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖会话存储目录；被 `--session-dir` 覆盖 |
| `PI_PACKAGE_DIR` | 覆盖包目录，适用于 Nix/Guix 存储路径 |
| `PI_OFFLINE` | 禁用启动时的网络操作，包括更新检查、包更新检查和安装/更新遥测 |
| `PI_SKIP_VERSION_CHECK` | 跳过启动时的 Pi 版本更新检查。阻止向 `pi.dev` 发起最新版本请求 |
| `PI_TELEMETRY` | 覆盖安装/更新遥测：`1`/`true`/`yes` 或 `0`/`false`/`no`。不禁用更新检查 |
| `PI_CACHE_RETENTION` | 设置为 `long` 可在支持的情况下启用扩展提示缓存 |
| `VISUAL`, `EDITOR` | Ctrl+G 使用的外部编辑器 |

## 设计原则

Pi 保持核心小巧，将工作流特定行为推入扩展、技能、提示模板和包中。

它有意不包含内置的 MCP、子代理、权限弹窗、计划模式、待办事项或后台 bash。你可以将此类工作流构建或安装为扩展或包，或使用外部工具（如容器和 tmux）。

完整的设计理念请阅读[博客文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。
