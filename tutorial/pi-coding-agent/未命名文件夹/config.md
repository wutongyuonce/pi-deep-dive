# `config.ts`  配置中心模块

`config.ts` 不是一个“只放几个常量”的文件，它其实是 `coding-agent` 的**配置与路径基础设施中心**。

它统一解决六类问题：

1. **运行时检测**：当前到底是 `bun build --compile` 生成的二进制，还是普通 Node.js / `bun run` 运行时
2. **安装方式识别**：当前这份 `pi` 是通过 `npm`、`pnpm`、`yarn`、`bun` 还是 Bun 二进制安装的
3. **自更新命令生成**：根据安装方式给出对应的全局升级命令
4. **包内资产路径解析**：主题、导出模板、README、docs、examples、interactive assets 在哪里
5. **应用元信息读取**：`PACKAGE_NAME`、`APP_NAME`、`APP_TITLE`、`VERSION`、环境变量名
6. **用户配置目录路径**：`~/.pi/agent/` 以及其下的 `models.json`、`auth.json`、`sessions/`、`prompts/` 等路径

```ts
config.ts
  -> 1、运行时检测
       -> isBunBinary
       -> isBunRuntime

  -> 2、安装方式检测与自更新能力
       -> detectInstallMethod()
       -> getSelfUpdateCommand()
       -> getSelfUpdateUnavailableInstruction()
       -> getUpdateInstruction()

  -> 3、包资产路径解析
       -> getPackageDir()
       -> getThemesDir()
       -> getExportTemplateDir()
       -> getPackageJsonPath()
       -> getReadmePath()
       -> getDocsPath()
       -> getExamplesPath()
       -> getChangelogPath()
       -> getInteractiveAssetsDir()
       -> getBundledInteractiveAssetPath()

  -> 4、应用元信息常量
       -> PACKAGE_NAME
       -> APP_NAME
       -> APP_TITLE
       -> CONFIG_DIR_NAME
       -> VERSION
       -> ENV_AGENT_DIR
       -> ENV_SESSION_DIR

  -> 5、通用路径辅助与分享 URL
       -> expandTildePath()
       -> getShareViewerUrl()

  -> 6、用户配置目录路径
       -> getAgentDir()
       -> getCustomThemesDir()
       -> getModelsPath()
       -> getAuthPath()
       -> getSettingsPath()
       -> getToolsDir()
       -> getBinDir()
       -> getPromptsDir()
       -> getSessionsDir()
       -> getDebugLogPath()
```

最核心的两个枢纽函数是：

- `getPackageDir()` 统一回答“当前包根目录在哪里”，包内世界的根
- `getAgentDir()` 统一回答“当前用户 agent 配置目录在哪里”，用户世界的根

后面几乎所有路径函数，都是从这两个根再往下推导。

---

## 一、运行时检测：Bun 编译二进制，还是普通脚本运行时

源码先做了 ESM 环境下的路径还原：

```ts
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

因为在 ESM 里没有 CommonJS 的内建 `__filename` / `__dirname`，所以需要手动从 `import.meta.url` 还原。

然后导出两个运行时判断常量：

### `isBunBinary`

```ts
export const isBunBinary =
  import.meta.url.includes("$bunfs") ||
  import.meta.url.includes("~BUN") ||
  import.meta.url.includes("%7EBUN");
```

作用：判断当前是否运行在 **Bun 编译后的单文件二进制** 中

判断依据：Bun 编译后的虚拟文件系统路径里会出现：

- `"$bunfs"`
- `"~BUN"`
- `"%7EBUN"`

这不是业务语义，而是 Bun runtime 形态的底层特征检测。

### `isBunRuntime`

```ts
export const isBunRuntime = !!process.versions.bun;
```

作用：

- 判断当前运行时是不是 Bun

和 `isBunBinary` 的区别：

- `isBunBinary`
  - 更窄，表示“编译后二进制”
- `isBunRuntime`
  - 更宽，表示“只要是 Bun 运行时都算”，包括 `bun run`

这两个布尔值会直接影响后面的：

- 安装方式判断
- 包资产路径解析
- 更新命令生成

## 二、安装方式检测：npm / pnpm / yarn / bun / bun binary

### `InstallMethod`

```ts
export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";
```

这是整个“安装方式系统”的基础枚举。后面所有更新命令和提示语都基于这个类型分支。

### `detectInstallMethod()` 主入口

```ts
detectInstallMethod()
  -> 如果 isBunBinary
       -> "bun-binary"
  -> 拼接 __dirname + process.execPath
       -> 统一转小写
       -> Windows 反斜杠转正斜杠
  -> 按路径特征匹配：
       -> "/pnpm/" 或 "/.pnpm/"         -> "pnpm"
       -> "/yarn/" 或 "/.yarn/"         -> "yarn"
       -> Bun runtime 或 bun 全局路径    -> "bun"
       -> "/npm/" 或 "/node_modules/"   -> "npm"
       -> 都不命中                      -> "unknown"
```

作用：用当前进程路径和模块路径的“路径形状”去推断安装来源

### 辅助函数：`getInferredNpmInstall()`

```ts
getInferredNpmInstall()
  -> packageDir = getPackageDir()
  -> 根据 node_modules 目录结构反推：
       -> root
       -> prefix
  -> 仅对标准 Linux/macOS npm 全局布局有效
```

作用：从当前包目录反推 npm 全局安装的 `root` 和 `prefix`

典型场景：

```text
/usr/lib/node_modules/@scope/pkg
  -> root   = /usr/lib/node_modules
  -> prefix = /usr
```

限制：

- Windows 的全局 npm 前缀无法单靠路径形状可靠推断，所以这里选择保守返回 `undefined`

## 三、自更新命令系统：根据安装方式生成升级命令

这一段是 `config.ts` 里最“产品化”的部分。它不仅知道“你是怎么装的”，还要进一步回答：

> **如果要升级，我应该提示用户执行什么命令？**

### 数据结构：`SelfUpdateCommandStep` 和 `SelfUpdateCommand`

```ts
// 一条可执行 shell 命令
interface SelfUpdateCommandStep {
  command: string;
  args: string[];
  display: string;
}

// 完整更新方案
export interface SelfUpdateCommand extends SelfUpdateCommandStep {
  steps?: SelfUpdateCommandStep[]; // 如果涉及包名变化，可能需要两步：先卸载旧包，再安装新包
}
```

### 构造函数：`makeSelfUpdateCommandStep()`

```ts
makeSelfUpdateCommandStep(command, args)
  -> 生成 { command, args, display }
  -> display 中自动给含空格参数加双引号
```

作用：把底层命令结构转成人类可读的展示文本

### 组合函数：`makeSelfUpdateCommand()`

```ts
makeSelfUpdateCommand(installStep, uninstallStep?)
  -> 若没有 uninstallStep
       -> 直接返回 installStep
  -> 否则
       -> display = "卸载命令 && 安装命令"
       -> steps = [uninstallStep, installStep]
```

作用：把“单步安装”或“先卸载再安装”的两种更新方案统一成一种返回结构

### 核心分发：`getSelfUpdateCommandForMethod()`

这是按安装方式生成命令的核心函数。

```ts
getSelfUpdateCommandForMethod(method, installedPackageName, updatePackageName, npmCommand?)
  -> bun-binary
       -> undefined
  -> pnpm
       -> pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ...
  -> yarn
       -> yarn global add --ignore-scripts ...
  -> bun
       -> bun install -g --ignore-scripts --minimum-release-age=0 ...
  -> npm
       -> npm install -g --ignore-scripts --min-release-age=0 ...
       -> 若可推断 prefix，则自动补 --prefix
  -> unknown
       -> undefined
```

作用：

- 不关心“当前环境是否真的可更新”
- 只负责“如果按这个安装方式更新，命令应该长什么样”

注意点：

- `updatePackageName` 默认等于 `installedPackageName`
- 如果包名发生变化，就会同时生成卸载旧包 + 安装新包两步命令
- `npmCommand` 支持外部传入替代 npm 命令，比如某些 wrapper 场景

### 执行命令读取输出：`readCommandOutput()`

```ts
readCommandOutput(command, args, { requireSuccess? })
  -> spawnProcessSync(...)
  -> exit code = 0
       -> 返回 stdout.trim()
  -> 失败且 requireSuccess = true
       -> throw Error
  -> 否则
       -> undefined
```

作用：给后面的全局包目录检测提供一个统一的“同步执行并拿 stdout”工具

调用方主要是：`getGlobalPackageRoots()`

### 获取全局包根：`getGlobalPackageRoots()`

```ts
getGlobalPackageRoots(method, packageName, npmCommand?)
  -> npm
       -> npm root -g
       -> 或从 getInferredNpmInstall() 回退
  -> pnpm
       -> pnpm root -g
  -> yarn
       -> yarn global dir
       -> 再推导 node_modules
  -> bun
       -> bun pm bin -g
       -> 再推导 install/global/node_modules
  -> bun-binary / unknown
       -> []
```

作用：找出“全局包管理器管理的 node_modules 根目录候选集”

### 路径比较辅助：`normalizeExistingPathForComparison()` 和 `getPathComparisonCandidates()`

这两个函数都是内部工具。

`normalizeExistingPathForComparison(path, resolveSymlinks)`：

```ts
原始路径
  -> resolve(path) 把一个路径字符串变成“规范的绝对路径”
  -> 若不存在，返回 undefined
  -> 可选 realpathSync() 解析符号链接（symlink）
  -> Windows 下统一转小写
```

作用：把路径规整成适合做“是否位于某个根目录下”的比较形式

`getPathComparisonCandidates(path)`：

```ts
path
  -> 非 realpath 版本
  -> realpath 版本
  -> 去重后返回
```

作用：同时保留“原路径”和“解链接路径”两套比较候选，避免符号链接场景误判

### 入口包目录推断：`getEntrypointPackageDir()`

```ts
getEntrypointPackageDir()
  -> 从 process.argv[1] 开始
  -> 向上逐级找 package.json
  -> 找到则返回该目录
```

作用：推断“当前真正入口脚本所属的包目录”

这个函数存在的意义是：有时 `config.ts` 所在包目录和真正的入口脚本包目录不完全一致，做全局管理判断时要把两者都纳入候选。

### 写权限判断：`isSelfUpdatePathWritable()`

```ts
isSelfUpdatePathWritable()
  -> packageDir = getPackageDir()
  -> accessSync(packageDir, W_OK)
  -> accessSync(dirname(packageDir), W_OK)
  -> 两者都可写才返回 true
```

作用：自更新不仅要能写包目录本身，还要能写其父目录（通常是 `node_modules`）

### 是否由全局包管理器托管：`isManagedByGlobalPackageManager()`

```ts
isManagedByGlobalPackageManager(method, packageName, npmCommand?)
  -> packageDirs = [getPackageDir(), getEntrypointPackageDir()]
  -> 把 packageDirs 转成路径候选集
  -> 获取 getGlobalPackageRoots(...)
  -> 判断 packageDir 是否位于某个全局 root 前缀下
```

作用：解决“当前环境是不是全局安装”这个关键判断

因为只有满足这个条件，才能放心提示用户执行全局更新命令。

### 对外主入口：`getSelfUpdateCommand()`

```ts
getSelfUpdateCommand(packageName, npmCommand?, updatePackageName?)
  -> method = detectInstallMethod()
  -> command = getSelfUpdateCommandForMethod(...)
  -> 若 command 不存在
       -> undefined
  -> 若不是全局包管理器托管
       -> undefined
  -> 若路径不可写
       -> undefined
  -> 否则返回 command
```

作用：对外提供“当前安装是否支持自更新，以及如果支持，命令是什么”

这是自更新能力真正推荐外部调用的入口。

### 用户提示：`getSelfUpdateUnavailableInstruction()`

```ts
getSelfUpdateUnavailableInstruction(packageName, npmCommand?, updatePackageName?)
  -> method = detectInstallMethod()
  -> bun-binary
       -> 提示去 GitHub releases 下载
  -> 若 method 对应命令存在
       -> 如果是全局安装但不可写
            -> 提示手动运行 command.display
       -> 否则
            -> 提示“这份安装不是由全局 <method> 管理”
  -> 其他情况
       -> 给出通用手动更新说明
```

作用：当无法自动给出自更新命令时，生成一条尽可能准确的人类提示语

### 最终包装：`getUpdateInstruction()`

```ts
getUpdateInstruction(packageName)
  -> method = detectInstallMethod()
  -> command = getSelfUpdateCommandForMethod(method, packageName)
  -> 有命令
       -> "Run: ..."
  -> 否则
       -> getSelfUpdateUnavailableInstruction(packageName)
```

作用：

- 这是“最面向用户”的更新提示函数
- 它不一定要求当前真能自更新，而是负责给出一条合适的更新说明文本

## 四、包资产路径系统：内置主题、导出模板、文档到底放哪

解决的是：

> **随包分发的静态资源，在 Bun 二进制、Node dist、tsx src 三种形态下分别在哪？**

### 1、主入口：`getPackageDir()`

这是整个“包内路径系统”的根函数。

```text
getPackageDir()
  -> 若存在 PI_PACKAGE_DIR
       -> 直接返回 normalizePath(envDir)
  -> 若 isBunBinary
       -> dirname(process.execPath)
  -> 否则从 __dirname 开始向上找 package.json
  -> 找到 package.json 所在目录就返回
  -> 兜底返回 __dirname
```

作用：

- 找到当前包的根目录

优先级：

1. `PI_PACKAGE_DIR` 环境变量覆盖
2. Bun 二进制场景下用 `process.execPath`
3. 普通 Node/tsx 场景下从当前文件目录向上找 `package.json`

这是因为：

- Bun 编译二进制没有正常的源码目录结构
- tsx 开发态和 dist 产物态目录层级也不一样

所以必须用一个统一入口把差异抹平。

### 2、`getThemesDir()`

```text
getThemesDir()
  -> isBunBinary
       -> <packageDir>/theme
  -> 否则判断 packageDir 下有 src 还是 dist
       -> <packageDir>/<src|dist>/modes/interactive/theme
```

作用：

- 返回内置主题目录

### 3、`getExportTemplateDir()`

```text
getExportTemplateDir()
  -> isBunBinary
       -> <packageDir>/export-html
  -> 否则
       -> <packageDir>/<src|dist>/core/export-html
```

作用：

- 返回 HTML 导出模板目录

### 4、文档与元文件路径

这些函数都比较直接，都是从 `getPackageDir()` 往下拼接：

- `getPackageJsonPath()`
  - `join(getPackageDir(), "package.json")`
- `getReadmePath()`
  - `resolve(join(getPackageDir(), "README.md"))`
- `getDocsPath()`
  - `resolve(join(getPackageDir(), "docs"))`
- `getExamplesPath()`
  - `resolve(join(getPackageDir(), "examples"))`
- `getChangelogPath()`
  - `resolve(join(getPackageDir(), "CHANGELOG.md"))`

作用：

- 为帮助信息、文档跳转、CHANGELOG 展示、示例路径定位提供统一入口

### 5、交互模式静态资源

`getInteractiveAssetsDir()`：

```text
getInteractiveAssetsDir()
  -> isBunBinary
       -> <packageDir>/assets
  -> 否则
       -> <packageDir>/<src|dist>/modes/interactive/assets
```

作用：

- 获取 interactive mode 的静态资源目录

`getBundledInteractiveAssetPath(name)`：

```text
getBundledInteractiveAssetPath(name)
  -> join(getInteractiveAssetsDir(), name)
```

作用：

- 获取某个具体内置资源的完整路径

## 六、应用配置常量：从 `package.json` 读取 pi 的身份信息

这一段不是读用户的 `settings.json`，而是读**包自己的元信息**。

### 1、`PackageJson` 接口与 `pkg`

```ts
interface PackageJson {
  name?: string;
  version?: string;
  piConfig?: {
    name?: string;
    configDir?: string;
  };
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;
```

作用：

- 从包内 `package.json` 读取：
  - npm 包名
  - 版本
  - `piConfig.name`
  - `piConfig.configDir`

也就是说，`config.ts` 里很多导出常量不是写死的，而是通过包元信息动态派生。

### 2、常量：`PACKAGE_NAME`

```ts
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
```

作用：

- 当前 npm 包名
- 主要用于安装、更新、卸载等外部 package manager 语义

### 3、常量：`APP_NAME`

```ts
export const APP_NAME: string = piConfigName || "pi";
```

作用：

- 当前应用名
- 默认是 `"pi"`

它会影响：

- 环境变量前缀
- debug log 文件名
- UI 标题的部分逻辑

### 4、常量：`APP_TITLE`

```ts
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
```

作用：

- UI 或显示层标题

逻辑：

- 如果是自定义应用名，就显示 `APP_NAME`
- 否则默认显示 `"π"`

### 5、常量：`CONFIG_DIR_NAME`

```ts
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
```

作用：

- 用户配置根目录名称
- 默认是 `.pi`

它会直接影响 `getAgentDir()` 这类用户路径函数的拼接结果。

### 6、常量：`VERSION`

```ts
export const VERSION: string = pkg.version || "0.0.0";
```

作用：

- 当前版本号

典型调用方：

- `main.ts` 的 `--version`

### 7、环境变量名常量：`ENV_AGENT_DIR`、`ENV_SESSION_DIR`

```ts
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;
```

作用：

- 统一定义可覆盖目录的环境变量名

例如默认 `APP_NAME = "pi"` 时：

```text
ENV_AGENT_DIR   = PI_CODING_AGENT_DIR
ENV_SESSION_DIR = PI_CODING_AGENT_SESSION_DIR
```

这样做的好处是：

- 应用重命名时，这两个环境变量前缀可以自动跟着变

## 七、通用辅助：路径展开与分享链接

### 1、`expandTildePath(path)`

```ts
export function expandTildePath(path: string): string {
  return normalizePath(path);
}
```

函数名看起来像“展开 `~`”，而它实际委托的是 `normalizePath()`。

作用：

- 统一把传入路径做路径标准化

在当前工程的路径工具约定里，`normalizePath()` 已经承担了 `~` 展开和路径规范化语义，所以这里作为更高层、更语义化的导出入口。

### 2、`DEFAULT_SHARE_VIEWER_URL`

```ts
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";
```

作用：

- 会话分享查看器的默认基地址

### 3、`getShareViewerUrl(gistId)`

```text
getShareViewerUrl(gistId)
  -> baseUrl = PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL
  -> 返回 `${baseUrl}#${gistId}`
```

作用：

- 根据 gist id 生成分享链接

支持：

- 用 `PI_SHARE_VIEWER_URL` 覆盖默认 viewer 地址

## 八、用户配置目录路径系统：`~/.pi/agent/*`

这一段解决的是：

> **用户级数据到底存在哪里？**

### 1、主入口：`getAgentDir()`

```text
getAgentDir()
  -> 读取 process.env[ENV_AGENT_DIR]
       -> 若存在，expandTildePath(envDir)
  -> 否则
       -> join(homedir(), CONFIG_DIR_NAME, "agent")
```

作用：

- 返回用户 agent 配置目录

默认结果通常是：

```text
~/.pi/agent
```

它是整个“用户路径系统”的根函数，地位类似于包内世界里的 `getPackageDir()`。

### 2、从 `getAgentDir()` 派生的所有路径函数

这组函数都非常统一，都是：

```text
getXxxPath() / getXxxDir()
  -> join(getAgentDir(), ...)
```

分别是：

- `getCustomThemesDir()`
  - `~/.pi/agent/themes/`
  - 用户自定义主题目录
- `getModelsPath()`
  - `~/.pi/agent/models.json`
  - 用户模型配置
- `getAuthPath()`
  - `~/.pi/agent/auth.json`
  - 用户认证凭证
- `getSettingsPath()`
  - `~/.pi/agent/settings.json`
  - 用户设置文件
- `getToolsDir()`
  - `~/.pi/agent/tools/`
  - 用户自定义工具目录
- `getBinDir()`
  - `~/.pi/agent/bin/`
  - 托管二进制目录，例如 `fd`、`rg`
- `getPromptsDir()`
  - `~/.pi/agent/prompts/`
  - 用户提示词模板目录
- `getSessionsDir()`
  - `~/.pi/agent/sessions/`
  - 历史会话目录
- `getDebugLogPath()`
  - `~/.pi/agent/<app-name>-debug.log`
  - 调试日志路径

这里有两个典型特征：

1. 所有用户级路径都以 `getAgentDir()` 为根统一派生
2. `getDebugLogPath()` 里会用到 `APP_NAME`，所以应用名变化时日志文件名也会自动变化

## 九、`config.ts` 内部调用关系

如果只看函数列表，容易觉得它们是零散工具。实际上内部有很明显的依赖层次。

### 1、运行时与安装方式链

```text
isBunBinary / isBunRuntime
  -> detectInstallMethod()
       -> getSelfUpdateCommandForMethod()
       -> getSelfUpdateUnavailableInstruction()
       -> getUpdateInstruction()
       -> getSelfUpdateCommand()
```

### 2、自更新可用性判断链

```text
getPackageDir()
  -> getInferredNpmInstall()
  -> isSelfUpdatePathWritable()

readCommandOutput()
  -> getGlobalPackageRoots()

normalizeExistingPathForComparison()
  -> getPathComparisonCandidates()

getPackageDir() + getEntrypointPackageDir() + getGlobalPackageRoots()
  -> isManagedByGlobalPackageManager()

detectInstallMethod() + getSelfUpdateCommandForMethod() + isManagedByGlobalPackageManager() + isSelfUpdatePathWritable()
  -> getSelfUpdateCommand()
```

### 3、包资产路径链

```text
getPackageDir()
  -> getThemesDir()
  -> getExportTemplateDir()
  -> getPackageJsonPath()
  -> getReadmePath()
  -> getDocsPath()
  -> getExamplesPath()
  -> getChangelogPath()
  -> getInteractiveAssetsDir()
       -> getBundledInteractiveAssetPath(name)
```

### 4、应用元信息链

```text
getPackageJsonPath()
  -> readFileSync(...)
  -> pkg
       -> PACKAGE_NAME
       -> APP_NAME
       -> APP_TITLE
       -> CONFIG_DIR_NAME
       -> VERSION
       -> ENV_AGENT_DIR
       -> ENV_SESSION_DIR
```

### 5、用户目录路径链

```text
CONFIG_DIR_NAME + ENV_AGENT_DIR + homedir()
  -> getAgentDir()
       -> getCustomThemesDir()
       -> getModelsPath()
       -> getAuthPath()
       -> getSettingsPath()
       -> getToolsDir()
       -> getBinDir()
       -> getPromptsDir()
       -> getSessionsDir()
       -> getDebugLogPath()
```

## 十、对外部模块的意义

这个文件在工程里的真正价值不是“提供配置项”，而是给整个工程提供一组**不会到处重复实现的基础判断**。

典型地说：

- `main.ts`
  - 会用 `getAgentDir()`、`getPackageDir()`、`VERSION`、`ENV_SESSION_DIR`
- 资源和主题相关逻辑
  - 会用 `getThemesDir()`、`getInteractiveAssetsDir()`
- 导出功能
  - 会用 `getExportTemplateDir()`
- 自更新和包管理逻辑
  - 会用 `detectInstallMethod()`、`getSelfUpdateCommand()`、`getUpdateInstruction()`
- 各种用户配置与数据存取模块
  - 会用 `getModelsPath()`、`getAuthPath()`、`getSettingsPath()`、`getSessionsDir()`

所以它的定位更准确地说是：

```text
config.ts
  = 应用身份信息中心
  + 运行时形态判断中心
  + 安装来源判断中心
  + 包资产路径中心
  + 用户数据根目录中心
```

这也是为什么后面的 `main.ts`、`migrations.ts`、包管理、自更新、主题系统、session 系统几乎都会 import 它。

---

## 十一、怎么理解这一章和后文的关系

这一节讲的是 **“pi 这个程序自己是谁、装在哪里、资源在哪里、用户数据在哪里”**。

而后面的 `main.ts` 章节讲的是：

```text
有了这些基础路径和常量之后，
产品启动流程如何进一步决定
mode / session / runtime。
```

所以顺序上是：

```text
config.ts
  先回答“程序自身与环境”的问题
    ↓
main.ts
  再回答“这次启动如何编排”的问题
```
