# 包管理命令入口 `package-manager-cli.ts`

文件定位：`packages/coding-agent/src/package-manager-cli.ts`

这个模块不是 Agent 会话运行时的一部分，而是 `main.ts` 在启动早期优先短路处理的一组产品命令入口。它负责两类事情：

- 包管理命令：`install` / `remove` / `update` / `list`
- 配置命令：`config`

也就是说，这些命令不会进入 `createAgentSessionRuntime()`、不会创建 `AgentSession`，而是在 CLI 外壳层直接完成。

## 模块职责

- 解析包管理命令参数
- 校验命令组合是否合法
- 创建 `SettingsManager` 和 `DefaultPackageManager`
- 调用包管理器执行安装、移除、更新、列出
- 在 `update` 命令里补上一条“更新 pi 自己”的自更新链路
- 在 `config` 命令里启动交互式配置选择器

## 它在总启动链里的位置

```ts
cli.ts
  -> main(args)
    -> handlePackageCommand(args)
       -> true  : 命令已被 package-manager-cli.ts 消费，main 直接 return
       -> false : 不是包管理命令，继续后面的 runtime 创建

    -> handleConfigCommand(args)
       -> true  : 命令已被消费，main 直接 return
       -> false : 继续进入正常的 agent 启动链
```

所以它的定位很明确：

- `main.ts` 负责“要不要把这次启动交给它”
- `package-manager-cli.ts` 负责“如果交给我，我怎么把这类命令完整跑完”

## 对外导出

这个文件真正对外暴露的入口只有两个：

```ts
export async function handleConfigCommand(args: string[]): Promise<boolean>
export async function handlePackageCommand(args: string[]): Promise<boolean>
```

其中：

- `handlePackageCommand()` 是包管理命令总入口
- `handleConfigCommand()` 是 `config` 命令总入口
- 返回 `boolean` 的含义是：
  - `true`：这个模块已经识别并处理了这次命令
  - `false`：这次命令不归它管，调用方继续走别的启动路径

## 文件内的结构分层

```ts
package-manager-cli.ts
├── 类型与显示层
│   ├── PackageCommand
│   ├── UpdateTarget
│   ├── PackageCommandOptions
│   └── SELF_UPDATE_NOTE_MARKDOWN_THEME
│
├── 基础输出与帮助层
│   ├── reportSettingsErrors()
│   ├── getPackageCommandUsage()
│   └── printPackageCommandHelp()
│
├── 参数解析层
│   ├── parsePackageCommand()
│   ├── updateTargetIncludesSelf()
│   └── updateTargetIncludesExtensions()
│
├── 自更新辅助层
│   ├── printSelfUpdateUnavailable()
│   ├── printSelfUpdateFallback()
│   ├── printSelfUpdateNote()
│   ├── getSelfUpdatePlan()
│   ├── runSelfUpdate()
│   └── prepareWindowsNpmSelfUpdate()
│
└── 两个真正入口
    ├── handleConfigCommand()
    └── handlePackageCommand()
```

---

## 一、类型与状态

### `PackageCommand`

```ts
export type PackageCommand = "install" | "remove" | "update" | "list";
```

作用：

- 表示四种包管理命令的离散集合
- 是 `parsePackageCommand()` 和 `handlePackageCommand()` 的主分发键

### `UpdateTarget`

```ts
type UpdateTarget =
  | { type: "all" }
  | { type: "self" }
  | { type: "extensions"; source?: string };
```

作用：

- 把 `update` 命令进一步拆成“更新谁”
- 它不是原始 CLI 参数，而是 `parsePackageCommand()` 解析后的结构化结果

三种含义：

- `{ type: "all" }`：同时更新 pi 自身和扩展包
- `{ type: "self" }`：只更新 pi 自身
- `{ type: "extensions", source?: string }`：更新扩展包；如果有 `source`，就只更新一个扩展

### `PackageCommandOptions`

这个接口是 `parsePackageCommand()` 的产物，用来承载：

- 命令名：`command`
- 位置参数：`source`
- 更新目标：`updateTarget`
- 作用域开关：`local`
- 更新强制开关：`force`
- 帮助开关：`help`
- 各类解析错误：
  - `invalidOption`
  - `invalidArgument`
  - `missingOptionValue`
  - `conflictingOptions`

它的设计思路是：

- 先“只解析、不执行”
- 把所有异常都编码进结构里
- 再由 `handlePackageCommand()` 按统一优先级处理

### `SELF_UPDATE_NOTE_MARKDOWN_THEME`

作用：

- 给 `printSelfUpdateNote()` 渲染更新笔记时提供 Markdown 主题
- 本质只是显示层配置，不参与业务决策

---

## 二、基础输出与帮助层

### `reportSettingsErrors(settingsManager, context)`

作用：

- 读取 `SettingsManager` 在解析配置时累积的错误
- 以 warning 形式输出到 `stderr`

步骤：

```ts
reportSettingsErrors(settingsManager, context)
  -> 调用 settingsManager.drainErrors()
  -> 遍历错误数组
  -> 输出 Warning (context, scope settings): ...
  -> 如果有 stack，再输出 stack
```

调用关系：

- `handleConfigCommand()` 创建完 `SettingsManager` 后调用
- `handlePackageCommand()` 创建完 `SettingsManager` 后调用

### `getPackageCommandUsage(command)`

作用：

- 返回某个命令对应的 usage 字符串
- 用于错误提示和帮助信息

例如：

- `install` -> `pi install <source> [-l]`
- `update` -> `pi update [source|self|pi] [--self] [--extensions] [--extension <source>] [--force]`

被 printPackageCommandHelp 和 handlePackageCommand 的错误分支调用

### `printPackageCommandHelp(command)`

作用：

- 输出某个命令的完整帮助文案
- 包括用法、选项和示例

步骤：

```ts
printPackageCommandHelp(command)
  -> switch(command)
  -> 选择对应的 Usage / Options / Examples 模板
  -> console.log 输出帮助文本
```

---

## 三、参数解析层

### `parsePackageCommand(args)`

这是整个模块最关键的前置函数。它的目标不是执行命令，而是把原始 CLI 数组解析成一个结构化对象。

函数签名：

```ts
function parsePackageCommand(args: string[]): PackageCommandOptions | undefined
```

返回值语义：

- 返回 `undefined`：说明这不是 `install/remove/update/list` 命令，调用方不要继续交给本模块
- 返回 `PackageCommandOptions`：说明命令名已识别，后面进入统一校验和执行阶段

主链路：

```ts
parsePackageCommand(args)
  -> 1、取 args[0] 识别命令名
       -> uninstall 映射成 remove
       -> 不是 install/remove/update/list 就返回 undefined

  -> 2、遍历其余参数 rest[]
       -> -h / --help            设置 help
       -> -l / --local           install/remove 时设置 local
       -> --self                 update 时设置 selfFlag
       -> --extensions           update 时设置 extensionsFlag
       -> --force                update 时设置 force
       -> --extension <source>   update 时读取单个扩展 source
       -> 未知 -flag             记到 invalidOption
       -> 第一个非选项参数        记到 source
       -> 之后多余的位置参数      记到 invalidArgument

  -> 3、如果 command === update
       -> 根据 source / --self / --extensions / --extension
          推导出 updateTarget
       -> 同时记录互斥冲突 conflictingOptions

  -> 4、返回 PackageCommandOptions
```

它特别值得注意的点有两个：

- `uninstall` 在这里被视为 `remove` 的别名
- `update` 的真实执行目标不是靠单个 flag 决定，而是靠 `source + flags` 组合推导成 `UpdateTarget`

### `updateTargetIncludesSelf(target)`

作用：判断这次 `update` 是否包含“更新 pi 自己”

规则：

- `all` 和 `self` 返回 `true`
- `extensions` 返回 `false`

### `updateTargetIncludesExtensions(target)`

作用：判断这次 `update` 是否包含“更新扩展包”

规则：

- `all` 和 `extensions` 返回 `true`
- `self` 返回 `false`

这两个函数的意义是把 `update` 命令拆成两个独立阶段：

- 阶段一：扩展包更新
- 阶段二：pi 自更新

---

## 四、自更新辅助层

这一层只服务 `handlePackageCommand()` 的 `update` 分支。

### `printSelfUpdateUnavailable(npmCommand?, updatePackageName?)`

作用：当当前安装方式不支持自更新时，输出失败原因和手动更新指引

步骤：

```ts
printSelfUpdateUnavailable(...)
  -> 输出 "pi cannot self-update this installation"
  -> 调用 getSelfUpdateUnavailableInstruction(...)
  -> 输出 entrypoint 路径，帮助用户定位当前可执行文件来源
```

依赖：`config.ts:getSelfUpdateUnavailableInstruction()`

### `printSelfUpdateFallback(command)`

作用：当自动执行自更新失败时，提示用户手动运行同样的命令

### `printSelfUpdateNote(note)`

作用：把 release note 以 Markdown 渲染后输出到终端

步骤：

```ts
printSelfUpdateNote(note)
  -> trim note
  -> 空内容直接返回
  -> 使用 Markdown + SELF_UPDATE_NOTE_MARKDOWN_THEME 渲染
  -> 渲染失败则退回原始文本输出
```

### `getSelfUpdatePlan(force)`

作用：

- 决定“要不要更新 pi 自己”
- 决定“更新时应该用哪个包名”
- 可选附带更新笔记 `note`

函数签名：

```ts
async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan>
```

步骤：

```ts
getSelfUpdatePlan(force)
  -> 1、如果 force=true
       -> 直接返回 shouldRun=true

  -> 2、调用 getLatestPiRelease(VERSION)
       -> 查询最新 release 信息

  -> 3、比较 latestRelease.version 和当前 VERSION
       -> 查询失败：容错处理，仍然返回 shouldRun=true
       -> 有新版本：返回 shouldRun=true，并附带 note
       -> 已是最新：输出 already up to date，返回 shouldRun=false
```

依赖：

- `utils/version-check.ts:getLatestPiRelease()`
- `utils/version-check.ts:isNewerPackageVersion()`

这个函数的策略比较偏“产品容错”：

- 版本检查接口失败时，不阻止更新
- 宁可多做一次更新，也不因为检查失败把更新卡死

### `runSelfUpdate(command)`

作用：

- 执行自更新命令
- 支持单步命令，也支持多步命令

步骤：

```ts
runSelfUpdate(command)
  -> 输出 "Updating pi with ..."
  -> 遍历 command.steps；如果没有 steps，就把 command 自己当成唯一一步
  -> 每一步都调用 spawnProcess(step.command, step.args, { stdio: "inherit" })
  -> 监听 child error / close
       -> exit code 0     : resolve
       -> signal 结束     : reject
       -> 非 0 exit code  : reject
```

依赖：`utils/child-process.ts:spawnProcess()`

### `prepareWindowsNpmSelfUpdate()`

作用：

- 只在 Windows + npm 安装方式下，为自更新做前置处理
- 避免原生依赖因文件锁定而更新失败

步骤：

```ts
prepareWindowsNpmSelfUpdate()
  -> 1、如果不是 win32，直接 return
  -> 2、调用 getPackageDir() 找到当前包目录
  -> 3、cleanupWindowsSelfUpdateQuarantine(packageDir)
  -> 4、quarantineWindowsNativeDependencies(packageDir)
```

---

## 五、配置命令入口 `handleConfigCommand(args)`

这是 `config` 命令的总入口。

函数签名：

```ts
export async function handleConfigCommand(args: string[]): Promise<boolean>
```

主链路：

```ts
handleConfigCommand(args)
  -> 1、检查 args[0] 是否是 "config"
       -> 不是：返回 false，表示不归本模块处理

  -> 2、读取 cwd 和 agentDir

  -> 3、创建 SettingsManager
       -> reportSettingsErrors(settingsManager, "config command")

  -> 4、创建 DefaultPackageManager
       -> packageManager.resolve()
       -> 得到当前所有已解析资源路径 resolvedPaths

  -> 5、调用 cli.ts/config-selector.ts 中的 selectConfig({
         resolvedPaths,
         settingsManager,
         cwd,
         agentDir
       })
       -> 进入交互式配置界面

  -> 6、配置完成后 process.exit(0)
```

它和 `handlePackageCommand()` 的区别是：

- `handlePackageCommand()` 偏“执行具体动作”
- `handleConfigCommand()` 偏“打开一个交互式配置 UI”

---

## 六、包管理命令总入口 `handlePackageCommand(args)`

这是整个文件最核心的函数。

函数签名：

```ts
export async function handlePackageCommand(args: string[]): Promise<boolean>
```

你可以把它理解成三段式控制器：

- 第一段：识别并解析命令
- 第二段：统一参数校验
- 第三段：按命令类型分发执行

### 第一段：识别并解析

```ts
handlePackageCommand(args)
  -> 调用 parsePackageCommand(args)
     -> 返回 undefined : 不是包管理命令，return false
     -> 返回 options   : 进入后续统一处理
```

这里的 `false` 很重要，它是 `main.ts` 知道“该继续正常启动 agent”的依据。

### 第二段：统一参数校验

`handlePackageCommand()` 没有把错误校验分散到各分支，而是集中按优先级处理：

```text
1、help
2、invalidOption
3、missingOptionValue
4、invalidArgument
5、conflictingOptions
6、install/remove 缺少 source
```

对应主链路：

```ts
options.help
  -> printPackageCommandHelp(command)
  -> return true

options.invalidOption
  -> 输出 Unknown option
  -> process.exitCode = 1
  -> return true

options.missingOptionValue
  -> 输出 Missing value
  -> process.exitCode = 1
  -> return true

options.invalidArgument
  -> 输出 Unexpected argument
  -> process.exitCode = 1
  -> return true

options.conflictingOptions
  -> 输出冲突描述
  -> process.exitCode = 1
  -> return true

install/remove 且无 source
  -> 输出 Missing source
  -> process.exitCode = 1
  -> return true
```

设计意义：

- 保证所有命令错误都走统一出口
- 保证 `install/remove/update/list` 的 UX 风格一致

### 第三段：初始化执行依赖

完成参数校验后，函数才真正创建依赖：

```ts
handlePackageCommand(args)
  -> 1、读取 cwd / agentDir
  -> 2、创建 SettingsManager
  -> 3、reportSettingsErrors(settingsManager, "package command")
  -> 4、读取 selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand
  -> 5、创建 DefaultPackageManager({ cwd, agentDir, settingsManager })
  -> 6、注册 progress callback
       -> event.type === "start" 时输出事件消息
```

这里的进度回调只关心 `start` 事件，说明 CLI 想展示的是：

- “正在安装什么”
- “正在更新什么”

而不是把底层包管理器的所有细粒度状态都打到屏幕上。

### 第四段：按命令类型分发

真正的执行通过 `switch (options.command)` 分成四个分支。

#### 1. `install`

主链路：

```ts
handlePackageCommand(args)
  -> parsePackageCommand() 得到 command="install"
  -> packageManager.installAndPersist(source, { local })
  -> console.log("Installed <source>")
  -> return true
```

作用：

- 安装包
- 把 source 持久化写回 settings

#### 2. `remove`

主链路：

```ts
handlePackageCommand(args)
  -> parsePackageCommand() 得到 command="remove"
  -> packageManager.removeAndPersist(source, { local })
       -> true  : 输出 Removed <source>
       -> false : 输出 No matching package found
  -> return true
```

作用：

- 移除包
- 从 settings 里删除对应 source

#### 3. `list`

主链路：

```ts
handlePackageCommand(args)
  -> parsePackageCommand() 得到 command="list"
  -> packageManager.listConfiguredPackages()
  -> 按 scope 分成 userPackages / projectPackages
  -> 如果为空：输出 No packages installed.
  -> 否则：
       -> 先输出 User packages
       -> 再输出 Project packages
       -> 每项显示 source
       -> 如果有 installedPath，再显示安装路径
  -> return true
```

作用：

- 列出“配置里声明过的包”
- 不是列出任意磁盘目录，而是列出用户级和项目级 settings 中可见的包源

#### 4. `update`

这是最复杂的分支，因为它实际上由两条链组成：

- 扩展包更新链
- pi 自更新链

##### 4.1 扩展包更新链

```ts
handlePackageCommand(args)
  -> parsePackageCommand() 得到 updateTarget
  -> updateTargetIncludesExtensions(target)
       -> true:
          -> 计算 updateSource
          -> packageManager.update(updateSource)
          -> 输出 Updated packages / Updated <source>
       -> false:
          -> 跳过
```

##### 4.2 pi 自更新链

```ts
handlePackageCommand(args)
  -> updateTargetIncludesSelf(target)
       -> false : 跳过
       -> true  : 进入自更新流程

  -> 1、getSelfUpdatePlan(force)
       -> shouldRun=false : 直接 return true

  -> 2、detectInstallMethod()
       -> 检测当前安装方式

  -> 3、Windows 特判
       -> 如果是 win32 且安装方式不是 npm/pnpm
          -> 报错并退出

  -> 4、getSelfUpdateCommand(PACKAGE_NAME, npmCommand, packageName)
       -> 返回 null : printSelfUpdateUnavailable()，退出
       -> 返回命令 : 继续

  -> 5、如果有 release note
       -> printSelfUpdateNote(note)

  -> 6、如果 installMethod === "npm"
       -> prepareWindowsNpmSelfUpdate()

  -> 7、runSelfUpdate(command)
       -> 成功：输出 Updated pi
       -> 失败：输出 Error + printSelfUpdateFallback(command)
```

这条链路说明一个核心事实：

- `update` 不是单一动作
- 它先更新资源包，再决定要不要更新 CLI 自己

### 第五段：统一异常出口

最外层有一层 `try/catch`：

```ts
switch(command) 执行中抛错
  -> catch(error)
  -> 输出 Error: <message>
  -> process.exitCode = 1
  -> return true
```

设计效果是：

- 只要命令已经被本模块识别，哪怕执行失败，仍然返回 `true`
- 对 `main.ts` 来说，这表示“命令已经由我接管，只是结果失败了”

---

## 七、函数之间的调用关系

核心调用图可以压缩成下面这张：

```ts
main.ts
  -> handlePackageCommand(args)
       -> parsePackageCommand(args)
       -> reportSettingsErrors(settingsManager, "package command")
       -> new DefaultPackageManager(...)
       -> switch(command)
            -> install
               -> packageManager.installAndPersist(...)
            -> remove
               -> packageManager.removeAndPersist(...)
            -> list
               -> packageManager.listConfiguredPackages()
            -> update
               -> updateTargetIncludesExtensions(target)
               -> packageManager.update(source?)
               -> updateTargetIncludesSelf(target)
               -> getSelfUpdatePlan(force)
               -> detectInstallMethod()
               -> getSelfUpdateCommand(...)
               -> printSelfUpdateNote(note)
               -> prepareWindowsNpmSelfUpdate()
               -> runSelfUpdate(command)

  -> handleConfigCommand(args)
       -> reportSettingsErrors(settingsManager, "config command")
       -> new DefaultPackageManager(...)
       -> packageManager.resolve()
       -> selectConfig(...)
```

---

## 八、这个模块和 `core/package-manager.ts` 的分工

两者容易混，但职责并不一样。

### `package-manager-cli.ts`

负责：

- 命令行参数解析
- 帮助文本
- 错误提示
- 命令分发
- 自更新 UX

它更像产品层 CLI 控制器。

### `core/package-manager.ts`

负责：

- 解析 source
- 安装 npm/git/local 包
- 更新包
- 收集资源路径
- 读写包相关设置

它更像底层资源包管理引擎。

一句话概括：

```text
package-manager-cli.ts
  = "用户在命令行里输入 install/remove/update/list/config 之后，产品层怎么接住并分发"

core/package-manager.ts
  = "真正安装、删除、更新、解析资源包的底层实现"
```

