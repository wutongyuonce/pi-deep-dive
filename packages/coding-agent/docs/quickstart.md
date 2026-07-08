# 快速开始

本页将引导你从安装到完成第一个有用的 pi 会话。

## 安装

Pi 以 npm 包形式分发：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 在安装期间禁用依赖的生命周期脚本。Pi 的正常 npm 安装不需要安装脚本。

### 卸载

使用当初安装 pi 的包管理器进行卸载。curl 安装脚本使用全局 npm，因此 curl 安装和 npm 安装均使用 npm 移除：

```bash
# curl 安装脚本 或 npm install -g
npm uninstall -g @earendil-works/pi-coding-agent

# pnpm
pnpm remove -g @earendil-works/pi-coding-agent

# Yarn
yarn global remove @earendil-works/pi-coding-agent

# Bun
bun uninstall -g @earendil-works/pi-coding-agent
```

卸载 pi 后，设置、凭据、会话和已安装的 pi 包会保留在 `~/.pi/agent/` 目录中。

然后在你要使用的项目目录中启动 pi：

```bash
cd /path/to/project
pi
```

## 认证

Pi 可以通过 `/login` 使用订阅提供商，或通过环境变量或认证文件使用 API 密钥提供商。

### 方式 1：订阅登录

启动 pi 并运行：

```text
/login
```

然后选择一个提供商。内置的订阅登录包括 Claude Pro/Max、ChatGPT Plus/Pro (Codex) 和 GitHub Copilot。

### 方式 2：API 密钥

在启动 pi 前设置 API 密钥：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

你也可以运行 `/login` 并选择一个 API 密钥提供商，将密钥存储在 `~/.pi/agent/auth.json` 中。

所有支持的提供商、环境变量和云提供商设置请参阅[提供商](zh/providers.md)。

## 第一个会话

pi 启动后，输入请求并按 Enter：

```text
Summarize this repository and tell me how to run its checks.
```

默认情况下，pi 为模型提供四个工具：

- `read` - 读取文件
- `write` - 创建或覆盖文件
- `edit` - 修改文件
- `bash` - 运行 shell 命令

其他内置只读工具（`grep`、`find`、`ls`）可通过工具选项使用。Pi 在当前工作目录中运行，可以修改该目录下的文件。如果需要轻松回滚，请使用 git 或其他检查点工作流。

## 为 pi 提供项目指令

Pi 在启动时加载上下文文件。添加 `AGENTS.md` 文件来告诉它如何在项目中工作：

```markdown
# 项目指令

- 代码变更后运行 `npm run check`。
- 不要在本地运行生产数据库迁移。
- 保持回复简洁。
```

Pi 会加载：

- `~/.pi/agent/AGENTS.md` 作为全局指令
- 父目录和当前目录中的 `AGENTS.md` 或 `CLAUDE.md`

修改上下文文件后，重启 pi 或运行 `/reload`。

## 常见尝试

### 引用文件

在编辑器中输入 `@` 来模糊搜索文件，或在命令行中传入文件：

```bash
pi @README.md "Summarize this"
pi @src/app.ts @src/app.test.ts "Review these together"
```

图片可以通过 Ctrl+V（Windows 上为 Alt+V）粘贴，或拖入支持的终端。

### 运行 shell 命令

在交互模式中：

```text
!npm run lint
```

命令输出会发送给模型。使用 `!!command` 运行命令但不将输出添加到模型上下文中。

### 切换模型

使用 `/model` 或 Ctrl+L 选择模型。使用 Shift+Tab 切换思考级别。使用 Ctrl+P / Shift+Ctrl+P 在限定模型中循环切换。

### 稍后继续

会话会自动保存：

```bash
pi -c                  # 继续最近一次会话
pi -r                  # 浏览之前的会话
pi --session <path|id> # 打开特定会话
```

在 pi 内部，使用 `/resume`、`/new`、`/tree`、`/fork` 和 `/clone` 管理会话。

### 非交互模式

用于一次性提示：

```bash
pi -p "Summarize this codebase"
cat README.md | pi -p "Summarize this text"
pi -p @screenshot.png "What's in this image?"
```

使用 `--mode json` 获取 JSON 事件输出，或使用 `--mode rpc` 进行进程集成。

## 下一步

- [使用 Pi](zh/usage.md) - 交互模式、斜杠命令、会话、上下文文件和 CLI 参考。
- [提供商](zh/providers.md) - 认证和模型设置。
- [设置](zh/settings.md) - 全局和项目配置。
- [键绑定](zh/keybindings.md) - 快捷键和自定义。
- [Pi 包](zh/packages.md) - 安装共享的扩展、技能、提示和主题。

平台说明：[Windows](zh/windows.md)、[Termux](zh/termux.md)、[tmux](zh/tmux.md)、[终端设置](zh/terminal-setup.md)、[Shell 别名](zh/shell-aliases.md)。
