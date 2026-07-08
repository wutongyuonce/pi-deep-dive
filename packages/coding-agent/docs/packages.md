> pi 可以帮助你创建 pi 包。请它打包你的扩展、技能、提示模板或主题。

# Pi 包

Pi 包将扩展、技能、提示模板和主题打包在一起，方便你通过 npm 或 git 分享。一个包可以在 `package.json` 的 `pi` 键下声明资源，也可以使用约定目录。

## 目录

- [安装与管理](#install-and-manage)
- [包来源](#package-sources)
- [创建 Pi 包](#creating-a-pi-package)
- [包结构](#package-structure)
- [依赖管理](#dependencies)
- [包过滤](#package-filtering)
- [启用和禁用资源](#enable-and-disable-resources)
- [作用域与去重](#scope-and-deduplication)

## 安装与管理

> **安全提示：** Pi 包拥有完整的系统访问权限。扩展可以执行任意代码，技能可以指示模型执行任何操作，包括运行可执行文件。在安装第三方包之前，请审查源代码。

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # 原始 URL 也可以
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list                     # 显示设置中已安装的包
pi update                   # 更新 pi、更新包并协调固定的 git 引用来安装缺失的包以及验证 git 引用
pi update --extensions      # 仅更新包并协调固定的 git 引用
pi update --self            # 仅更新 pi
pi update --self --force    # 即使当前版本已是最新也重新安装 pi
pi update npm:@foo/bar      # 更新单个包
pi update --extension npm:@foo/bar
```

这些命令管理的是 pi 包，而非 pi CLI 本身。要卸载 pi，请参阅[快速入门](zh/quickstart.md#uninstall)。

默认情况下，`install` 和 `remove` 写入用户设置（`~/.pi/agent/settings.json`）。使用 `-l` 可写入项目设置（`.pi/settings.json`）。项目设置可以与团队共享，pi 会在启动时自动安装任何缺失的包。

如果想在不安装的情况下试用某个包，可以使用 `--extension` 或 `-e`。这会将包安装到临时目录，仅对当前运行有效：

```bash
pi -e npm:@foo/bar
pi -e git:github.com/user/repo
```

## 包来源

Pi 在设置和 `pi install` 中支持三种来源类型。

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- 带版本号的 spec 会被固定，并在包更新（`pi update`、`pi update --extensions`）时跳过。
- 用户安装的包位于 `~/.pi/agent/npm/`。
- 项目安装的包位于 `.pi/npm/`。
- 在 `settings.json` 中设置 `npmCommand`，可将 npm 包查找和安装操作固定到特定的包装命令，例如 `mise` 或 `asdf`。

示例：

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- 不带 `git:` 前缀时，仅接受协议 URL（`https://`、`http://`、`ssh://`、`git://`）。
- 带 `git:` 前缀时，支持简写格式，包括 `github.com/user/repo` 和 `git@github.com:user/repo`。
- HTTPS 和 SSH URL 均受支持。
- SSH URL 会自动使用你配置的 SSH 密钥（遵循 `~/.ssh/config`）。
- 对于非交互式运行（例如 CI），可以设置 `GIT_TERMINAL_PROMPT=0` 禁用凭据提示，并设置 `GIT_SSH_COMMAND`（例如 `ssh -o BatchMode=yes -o ConnectTimeout=5`）以快速失败。
- 引用（refs）被固定为标签（tag）或提交（commit）。`pi update` 和 `pi update --extensions` 不会将其更新到更新的引用，但会协调现有 clone 到配置的引用。
- 使用 `pi install git:host/user/repo@new-ref` 可更新设置并将现有包迁移到新的固定引用。
- 克隆到 `~/.pi/agent/git/<host>/<path>`（全局）或 `.pi/git/<host>/<path>`（项目）。
- 当协调导致检出内容发生变化时，pi 会重置并清理 clone，然后如果存在 `package.json` 则运行 `npm install`。

**SSH 示例：**
```bash
# git@host:path 简写格式（需要 git: 前缀）
pi install git:git@github.com:user/repo

# ssh:// 协议格式
pi install ssh://git@github.com/user/repo

# 带版本引用
pi install git:git@github.com:user/repo@v1.0.0
```

### 本地路径

```
/absolute/path/to/package
./relative/path/to/package
```

本地路径指向磁盘上的文件或目录，会被添加到设置中而不会复制。相对路径是相对于其所在的设置文件进行解析的。如果路径是一个文件，则作为单个扩展加载。如果是一个目录，pi 会使用包规则加载资源。

## 创建 Pi 包

在 `package.json` 中添加 `pi` 清单，或使用约定目录。添加 `pi-package` 关键字以便于发现。

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

路径是相对于包根目录的。数组支持 glob 模式和 `!排除` 语法。

### 图库元数据

[包图库](https://pi.dev/packages) 会展示标记了 `pi-package` 的包。添加 `video` 或 `image` 字段可显示预览：

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**：仅支持 MP4 格式。在桌面端，鼠标悬停时自动播放。点击可打开全屏播放器。
- **image**：支持 PNG、JPEG、GIF 或 WebP 格式。显示为静态预览。

如果同时设置了二者，video 优先。

## 包结构

### 约定目录

如果没有 `pi` 清单，pi 会从以下目录自动发现资源：

- `extensions/` 加载 `.ts` 和 `.js` 文件
- `skills/` 递归查找 `SKILL.md` 文件夹，并将顶层 `.md` 文件加载为技能
- `prompts/` 加载 `.md` 文件
- `themes/` 加载 `.json` 文件

## 依赖管理

第三方运行时依赖应放在 `package.json` 的 `dependencies` 中。不注册扩展、技能、提示模板或主题的依赖也放在 `dependencies` 中。当 pi 从 npm 或 git 安装包时，会运行 `npm install`，因此这些依赖会自动安装。

Pi 为扩展和技能捆绑了核心包。如果你导入了以下任何包，请将其列在 `peerDependencies` 中，版本范围使用 `"*"`，不要将其捆绑：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。

其他 pi 包必须捆绑在你的 tarball 中。将它们添加到 `dependencies` 和 `bundledDependencies`，然后通过 `node_modules/` 路径引用其资源。Pi 以独立的模块根目录加载包，因此独立的安装不会冲突或共享模块。

示例：

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## 包过滤

使用设置中的对象形式来过滤包的加载内容：

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` 和 `-path` 是相对于包根目录的精确路径。

- 省略某个键表示加载该类型的所有资源。
- 使用 `[]` 表示不加载该类型的任何资源。
- `!pattern` 排除匹配项。
- `+path` 强制包含一个精确路径。
- `-path` 强制排除一个精确路径。
- 过滤器是在清单之上叠加的。它们会进一步缩小已允许的范围。

## 启用和禁用资源

使用 `pi config` 来启用或禁用已安装包和本地目录中的扩展、技能、提示模板和主题。支持全局（`~/.pi/agent`）和项目（`.pi/`）两种作用域。

## 作用域与去重

包可以同时出现在全局设置和项目设置中。如果同一个包同时出现在两者中，项目条目优先。标识由以下因素决定：

- npm：包名
- git：不包含引用的仓库 URL
- 本地：解析后的绝对路径
