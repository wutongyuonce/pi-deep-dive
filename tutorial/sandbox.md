# OS-level sandbox 沙箱

> - `anthropic sandbox-runtime` 底层主要用：
>
>   - macOS: `sandbox-exec` + Seatbelt profile
>   - Linux: `bubblewrap` + network namespace + host proxy + `socat` + 部分 `seccomp`
>
>   核心思想是：**不改你的程序，只在程序启动前，用操作系统原生隔离机制把这个进程和它的子进程树限制住**。
>
> - 它的核心是：
>
>   - 限制文件读写
>   - 限制网络访问
>   - 限制整个进程树
>
> - 和 Docker 的最大区别：
>
>   - 它是“给现有进程加隔离边界”
>   - Docker 是“运行完整容器环境”
>

**第 1 层：sandbox 扩展层** `sandbox/index.ts`

负责：

- 注册扩展
- 判断沙箱是否启用
- 覆盖 bash 工具
- 把默认 `operations` 换成沙箱版 `operations`

**第 2 层：bash 工具层** `bash.ts`

负责：

- 接受工具参数
- 组织命令执行上下文
- 收集和渲染输出
- 节流更新 UI
- 处理截断、临时文件、退出码、错误文案

**第 3 层：sandbox 执行层** `sandbox/index.ts`

负责：

- 把命令包进沙箱
- `spawn` 真正的 bash 子进程
- 监听 stdout/stderr
- 处理 timeout / abort / close
- 返回 `exitCode`

最简理解：

- bash 工具层 `createBashTool()` 负责造“bash 工具壳”
- sandbox 执行层 `createSandboxedBashOps()` 负责造“沙箱执行引擎”
- 真执行时是：`bash 工具壳 -> 沙箱执行引擎 -> spawn 子进程 -> 输出回流 -> 工具层收尾`

```ts
第一层：sandbox 扩展接管 bash 工具
1. session_start
   -> 读取 sandbox 配置
   -> SandboxManager.initialize(...)
   -> 设置 sandboxEnabled / sandboxInitialized

2、用户或模型调用 bash
   -> 命中扩展注册的 bash 工具 execute(...)

3. 扩展判断沙箱状态
   -> 未启用：localBash.execute(...)
   -> 已启用：createBashTool(cwd, { operations: createSandboxedBashOps() })

第二层：bash 工具层
4. 进入 bash 工具 execute(...)
   -> 计算 resolvedCommand
   -> resolveSpawnContext(...)
   -> 创建 OutputAccumulator
   -> 创建 handleData / finishOutput / formatOutput

5. bash 工具调用底层 ops.exec(...)
   -> 传入 command / cwd / onData / signal / timeout / env

第三层：sandbox 执行层
6. 进入 sandbox 版 exec(...)
   -> 检查 cwd
   -> wrappedCommand = SandboxManager.wrapWithSandbox(command)
   -> return new Promise(...)

7. Promise 内部启动子进程
   -> spawn("bash", ["-c", wrappedCommand], { cwd, detached, stdio })

8. 运行期控制
   -> stdout/stderr -> onData
   -> timeout -> kill 进程组
   -> abort -> kill 进程组
   -> error -> reject(err)
   -> close -> resolve(exitCode) 或 reject(aborted/timeout)

9. 回到 bash 工具层
   -> finishOutput()
   -> 截断 / 临时文件 / 友好错误信息
   -> 返回最终工具结果
```

1、**扩展先把 bash 工具“包一层”**：向 pi 注册了一个新的 `bash` 工具

```ts
pi.registerTool({
  ...localBash,
  label: "bash (sandboxed)",
  async execute(id, params, signal, onUpdate, _ctx) {
    if (!sandboxEnabled || !sandboxInitialized) {
      return localBash.execute(id, params, signal, onUpdate);
    }

    const sandboxedBash = createBashTool(localCwd, {
      operations: createSandboxedBashOps(),
    });
    return sandboxedBash.execute(id, params, signal, onUpdate);
  },
});
```

（1）先判断这次会话沙箱到底开没开 `if (!sandboxEnabled || !sandboxInitialized)`

这里有两个状态位：

- `sandboxEnabled`
- `sandboxInitialized`

它们是在 `session_start` 时初始化的：

```json
pi.on("session_start", async (_event, ctx) => {
    ...
}
```

意思是：

- 如果命令行传了 `--no-sandbox`
- 或配置里关闭了
- 或平台不支持
- 或底层 `SandboxManager.initialize(...)` 失败

那这次就**不走沙箱**，直接回退到普通 bash。

（2）如果启用了沙箱，就临时造一个“沙箱版 bash 工具”

```ts
const sandboxedBash = createBashTool(localCwd, {
  operations: createSandboxedBashOps(),
});
```

- `createBashTool(...)` 负责创建一个完整的 bash 工具外壳，对应定义在 bash.ts：

  ```json
  export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
    return wrapToolDefinition(createBashToolDefinition(cwd, options));
  }
  
  export interface BashToolOptions {
    operations?: BashOperations;
    commandPrefix?: string;
    shellPath?: string;
    spawnHook?: BashSpawnHook;
  }
  ```

- 默认情况下，它会用本地 shell 执行

- 但你现在显式传了 `operations`

- 所以它的底层执行后端会被换掉

2、bash.ts 中 `createBashTool()` 最后会生成一个工具定义，它的核心执行函数是：

```ts
async execute(_toolCallId, { command, timeout }, signal?, onUpdate?, _ctx?) {
```

这说明 bash 工具接收到的是：`command`、`timeout`、`signal`、`onUpdate`

（1）然后开始做通用处理：

* 先整理命令、spawn 上下文、输出缓冲

  ```ts
  const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
  const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
  const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
  ```

  `resolvedCommand`：如果有统一前缀命令，就先拼进去

  `spawnContext`：统一整理出最终的 `command / cwd / env`

  `output`：创建输出累积器，后面要用来收集 stdout/stderr

* 准备流式输出更新机制

  - `emitOutputUpdate()`：真正把当前输出快照推给 UI
  - `scheduleOutputUpdate()`：节流，不要每来一字节就刷新 UI

  - `handleData(data)`：收到子进程输出后，先写进 `output`，再安排刷新

    ```ts
    const handleData = (data: Buffer) => { // 只要底层执行器吐出一块数据
      output.append(data); // bash 工具就先把它记下来
      scheduleOutputUpdate(); // 然后让 UI 适时刷新
    };
    ```

（2）真正开始执行命令的地方在 `ops.exec(...)`

```ts
const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
  onData: handleData,
  signal,
  timeout,
  env: spawnContext.env,
});
```

这里的 `ops` 在文件开头就决定了：

```ts
const ops = options?.operations ?? createLocalBashOperations(...)
```

- 普通 bash 工具：`ops` 是默认本地执行器
- sandbox 版 bash 工具：`ops` 是 `createSandboxedBashOps()` 返回的那个对象

也就是说，现在终于从“bash 工具外壳”进入了“底层执行后端”。

（3）bash 工具层接住 `ops.exec` 结果，处理后返回最终结果

这里分两种：

- `ops.exec(...)` 成功返回
- `ops.exec(...)` 抛错

如果抛的是：

- `"aborted"` -> 转成更友好的 `"Command aborted"`
- `"timeout:..."` -> 转成 `"Command timed out after X seconds"`

而且在报错前，仍会先调用 `finishOutput()`，把已经收到的输出整理出来。

```ts
const finishOutput = async () => {
  output.finish(); // 停止继续累计输出
  clearUpdateTimer(); // 把最后一次更新推给 UI
  emitOutputUpdate(); // 拿一个最终输出快照
  const snapshot = output.snapshot({ persistIfTruncated: true });
  await output.closeTempFile(); // 如果有临时文件，也关闭它
  return snapshot;
};
```

后面 `formatOutput(...)` 会决定：

- 最终文本怎么展示
- 如果被截断了，要不要补提示
- 完整输出保存在哪个 temp file

如果命令正常结束，最终会在 [bash.ts](file:///Users/a/Desktop/WorkSpace/ALL/我的Github项目/pi-deep-dive/packages/coding-agent/src/core/tools/bash.ts#L419-L422) 之后收尾并返回结果。

如果退出码非 0，还会包装成错误：

```ts
Command exited with code X
```

也就是说：

- shell 进程正常结束 != 命令语义成功
- 退出码非 0 仍会被 bash 工具层当成失败处理

3、sandbox 版 `exec(...)`，这里的参数就是上一步 `ops.exec(...)` 传进来的

```ts
function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
```

* 先检查 cwd 是否存在

  ```ts
  if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
  }
  ```

* 再把原始命令包上一层沙箱，这是整个沙箱链路最关键的一步

  ```ts
  const wrappedCommand = await SandboxManager.wrapWithSandbox(command);
  ```

  - 原本的 `command` 只是普通 shell 命令

  - `wrapWithSandbox(...)` 会把它改写成“在沙箱中执行”的命令

  本文件自己并不实现内核级隔离，它只是借助 `SandboxManager` 生成这样的包装命令。

* 手动创建一个 Promise，等子进程结束

  ```ts
  return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", wrappedCommand], {
          cwd, // 这个 bash 子进程要在哪个工作目录里运行
          detached: true, // 让这个子进程以“独立进程组”的方式启动，为了后面更好地整组杀进程
          stdio: ["ignore", "pipe", "pipe"], // 程序默认有三条通道 stdin、stdout、stderr，这里是不给这个 bash 提供交互输入，但要把它的输出内容都接到当前程序
      });
      
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
  
      // 若调用方设置了超时，则在超时后直接杀掉整个进程组。
      if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
              timedOut = true;
              if (child.pid) {
                  try {
                      process.kill(-child.pid, "SIGKILL");
                  } catch {
                      child.kill("SIGKILL");
                  }
              }
          }, timeout * 1000);
      }
      
      // 把子进程输出转发给外层 UI / 流式更新逻辑。
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      
      // 子进程出错：启动失败或运行时错误直接向上抛出。
      child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
      });
      
      // 外层主动取消时，同样杀掉整个进程组，避免子进程残留。
      const onAbort = () => {
          if (child.pid) {
              try {
                  process.kill(-child.pid, "SIGKILL");
              } catch {
                  child.kill("SIGKILL");
              }
          }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      
      // 子进程结束：统一归并三类状态：abort / timeout / 正常退出
      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
  
        if (signal?.aborted) {
          reject(new Error("aborted"));
        } else if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
        } else {
          resolve({ exitCode: code });
        }
      });
  }
  ```

  spawn 语句可以理解为：

  - 启动一个系统 `bash`
  - 用 `bash -c` 执行那段已经包好沙箱的 `wrappedCommand`
  - 在 `cwd` 目录下运行
  - `detached: true` 让它有独立进程组，便于整组 kill
  - `stdio: ["ignore", "pipe", "pipe"]`
    - 不给 stdin
    - 但把 stdout/stderr 接回来

  子进程输出数据流：

  ```ts
  子进程 stdout/stderr
  -> sandbox exec 里的 onData
  -> bash 工具里的 handleData
  -> output.append(...)
  -> scheduleOutputUpdate()
  -> UI 收到流式输出
  ```

  子进程结束 close 统一收尾：

  - 如果是 abort 收场 -> `reject("aborted")`
  - 如果是 timeout 收场 -> `reject("timeout:...")`
  - 否则说明正常结束 -> `resolve({ exitCode: code })`
