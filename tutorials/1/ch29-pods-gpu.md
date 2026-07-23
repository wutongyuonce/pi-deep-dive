# 第 29 章：`pods` — 为什么这个仓库还要管 GPU

> **定位**：本章解释 pi-mono 为什么同时覆盖"模型供给侧"和"代理消费侧"。
> 前置依赖：第 4 章（Provider Registry）。
> 适用场景：当你想理解端到端 agent 系统为什么需要管模型部署。

## 端到端可控

pods 是 pi-mono 中最"奇怪"的包 — 一个 coding agent 的仓库为什么要管 GPU pod 编排和 vLLM 部署？

答案是**端到端可控**。如果 agent 只依赖第三方 API（OpenAI、Anthropic），那么模型的可用性、延迟、成本都不在自己掌控中。pods 让用户可以在 DataCrunch、RunPod、Vast.ai 等平台上部署自己的 vLLM 实例，暴露 OpenAI-compatible endpoint。部署完成后，用户在 pi 的 `models.json` 中配置自定义模型（指定 `baseUrl` 指向 pod 的 endpoint），pi 通过已有的 `openai-responses` 或 `openai-completions` API provider（第 4 章）即可调用 — pods 本身不注册新 provider，它只负责让 endpoint 可用。

pods 的代码量很小（~1773 行），功能也很聚焦：SSH 配置 GPU 机器、启动/停止 vLLM、管理模型权重。它不是一个通用的 GPU 编排系统，而是一个让 pi 用户快速获得自有模型推理能力的快捷方式。

## pods.ts：Pod 管理命令

pods 的命令结构很直接。`pods.ts` 提供四个操作：

```typescript
// packages/pods/src/commands/pods.ts:14-39
export const listPods = () => {
  const config = loadConfig();
  const podNames = Object.keys(config.pods);
  if (podNames.length === 0) {
    console.log("No pods configured. Use 'pi pods setup' to add.");
    return;
  }
  for (const name of podNames) {
    const pod = config.pods[name];
    const isActive = config.active === name;
    const marker = isActive ? chalk.green("*") : " ";
    const gpuCount = pod.gpus?.length || 0;
    const gpuInfo = gpuCount > 0
      ? `${gpuCount}x ${pod.gpus[0].name}` : "no GPUs detected";
    console.log(`${marker} ${chalk.bold(name)} - ${gpuInfo} - ${pod.ssh}`);
  }
};
```

完整命令清单：

| 命令 | 函数 | 作用 |
|------|------|------|
| `pi pods list` | `listPods()` | 列出所有 pod，标记 active |
| `pi pods setup <name> <ssh>` | `setupPod()` | 配置新 pod（SSH + 环境安装） |
| `pi pods switch <name>` | `switchActivePod()` | 切换 active pod |
| `pi pods remove <name>` | `removePodCommand()` | 从配置中移除 pod |

以及 `models.ts` 中的模型管理命令：

| 命令 | 函数 | 作用 |
|------|------|------|
| `pi start <model>` | `startModel()` | 启动 vLLM 实例 |
| `pi stop <name>` | `stopModel()` | 停止模型 |
| `pi stop --all` | `stopAllModels()` | 停止所有模型 |
| `pi models` | `listModels()` | 列出运行中的模型 |
| `pi logs <name>` | `viewLogs()` | 查看 vLLM 日志 |
| `pi models known` | `showKnownModels()` | 列出预配置的模型 |

## SSH Setup Flow：从零到可用

`setupPod()` 是最复杂的命令，它自动化了 GPU 机器的完整配置流程：

```typescript
// packages/pods/src/commands/pods.ts:44-172
export const setupPod = async (
  name: string,
  sshCmd: string,
  options: {
    mount?: string;
    modelsPath?: string;
    vllm?: "release" | "nightly" | "gpt-oss"
  },
) => {
  // 1. 验证环境变量
  const hfToken = process.env.HF_TOKEN;
  const vllmApiKey = process.env.PI_API_KEY;
  if (!hfToken) { /* 提示用户设置 HF_TOKEN */ }
  if (!vllmApiKey) { /* 提示用户设置 PI_API_KEY */ }

  // 2. 测试 SSH 连接
  const testResult = await sshExec(sshCmd, "echo 'SSH OK'");

  // 3. 复制安装脚本到远程机器
  const scriptPath = join(__dirname, "../../scripts/pod_setup.sh");
  await scpFile(sshCmd, scriptPath, "/tmp/pod_setup.sh");

  // 4. 远程执行安装脚本（2-5 分钟）
  let setupCmd = `bash /tmp/pod_setup.sh ` +
    `--models-path '${modelsPath}' ` +
    `--hf-token '${hfToken}' ` +
    `--vllm-api-key '${vllmApiKey}'`;
  await sshExecStream(sshCmd, setupCmd, { forceTTY: true });

  // 5. 检测 GPU 配置
  const gpuResult = await sshExec(sshCmd,
    "nvidia-smi --query-gpu=index,name,memory.total " +
    "--format=csv,noheader");
  // 解析 GPU 信息...

  // 6. 保存 pod 配置
  addPod(name, { ssh: sshCmd, gpus, models: {}, modelsPath });
};
```

整个流程的设计思路是**一条命令完成所有事**：

1. **环境变量检查**。HF_TOKEN（Hugging Face 下载模型权重）和 PI_API_KEY（vLLM 端点认证）是必需的
2. **SSH 连通性测试**。在开始耗时操作前先确认连接可用
3. **SCP 脚本传输**。用 `pod_setup.sh` 在远程机器上安装 Python、CUDA 工具链、vLLM
4. **流式输出**。`sshExecStream` 带 `forceTTY: true`，让用户看到安装进度
5. **GPU 自动检测**。通过 `nvidia-smi` 获取 GPU 数量、型号、显存
6. **配置持久化**。保存到本地 `~/.pi/pods.json`，后续操作引用

### SSH 抽象层

pods 没有使用任何 SSH 库 — 它直接调用系统的 `ssh` 和 `scp` 命令：

```typescript
// packages/pods/src/ssh.ts:12-68
export const sshExec = async (
  sshCmd: string,   // 如 "ssh user@host"
  command: string,  // 要执行的远程命令
): Promise<{ stdout: string; stderr: string; exitCode: number }>

export const sshExecStream = async (
  sshCmd: string,
  command: string,
  options?: { forceTTY?: boolean },
): Promise<number>  // 返回 exit code

export const scpFile = async (
  sshCmd: string,
  localPath: string,
  remotePath: string,
): Promise<boolean>
```

这是一个刻意的简化选择。`sshCmd` 参数接受完整的 SSH 命令（如 `ssh -i ~/.ssh/id_rsa user@host`），用户可以自由配置 SSH 代理、跳板机、端口转发等。pods 不需要理解 SSH 配置的细节。

## vLLM 管理：模型启停

`startModel()` 是 pods 的核心功能 — 在远程 GPU 机器上启动一个 vLLM 实例：

```typescript
// packages/pods/src/commands/models.ts:78-197
export const startModel = async (
  modelId: string,
  name: string,
  options: {
    pod?: string;
    vllmArgs?: string[];
    memory?: string;   // GPU 显存使用比例
    context?: string;  // 上下文长度（4k/8k/16k...）
    gpus?: number;     // GPU 数量
  },
) => {
  const { name: podName, pod } = getPod(options.pod);

  // 自动选择 GPU 配置
  if (isKnownModel(modelId)) {
    // 预配置模型：自动选择最优 GPU 数量和参数
    for (let gpuCount = pod.gpus.length; gpuCount >= 1; gpuCount--) {
      modelConfig = getModelConfig(modelId, pod.gpus, gpuCount);
      if (modelConfig) {
        gpus = selectGPUs(pod, gpuCount);
        vllmArgs = [...(modelConfig.args || [])];
        break;
      }
    }
  } else {
    // 未知模型：默认单 GPU
    gpus = selectGPUs(pod, 1);
  }
  // ... 启动 vLLM screen session
};
```

GPU 分配策略：

1. **预配置模型**：`model-configs.ts` 为常用模型（Llama、Qwen、Mistral 等）维护了经过测试的 vLLM 参数。根据 pod 的 GPU 型号和数量自动选择最优配置
2. **GPU 数量覆盖**：`--gpus N` 让用户强制指定 GPU 数量，pods 验证是否有对应配置
3. **显存/上下文覆盖**：`--memory 90%` 和 `--context 32k` 覆盖默认值
4. **自定义参数**：`--vllm <args>` 完全绕过自动配置，直接传递 vLLM 参数
5. **未知模型**：默认单 GPU，不做任何假设

### OpenAI-Compatible Endpoint

vLLM 启动后会暴露 OpenAI-compatible API。这是 pods 和 pi 连接的关键 — pi 的 provider registry（第 4 章）天然支持 OpenAI API 格式：

```
用户 → pi CLI → Provider Registry → OpenAI-compatible API → vLLM → GPU
                                      ↑
                                  pods 部署的端点
```

pods 启动时配置的 `PI_API_KEY` 就是 vLLM 端点的认证 key。用户在 pi 中配置 provider 时，只需要指向远程机器的 IP 和端口。

### 模型生命周期管理

```
pi pods setup  →  配置 SSH + 安装环境
      ↓
pi start model →  启动 vLLM（screen session）
      ↓
pi models      →  查看运行状态
      ↓
pi logs model  →  查看 vLLM 日志
      ↓
pi stop model  →  停止 vLLM
```

vLLM 运行在 `screen` session 中（不是 Docker），这样 SSH 断开后进程继续运行。模型权重存储在 `modelsPath`（通常是挂载的 NFS/SFS），多个模型可以共享权重缓存。

## 本地 pi 如何连接远程 pod

连接流程分三步：

**Step 1：部署模型**
```bash
export HF_TOKEN=hf_xxx
export PI_API_KEY=my-secret-key
pi pods setup my-a100 "ssh root@1.2.3.4" \
  --models-path /mnt/models
pi start deepseek-ai/DeepSeek-V3 --name ds-v3
```

**Step 2：配置 provider**

pods 启动 vLLM 后，打印端点地址（如 `http://1.2.3.4:8000`）。用户在 pi 的 provider 配置中添加这个端点，指向 OpenAI-compatible API。

**Step 3：在 pi 中使用**

pi CLI 的模型选择器（第 4 章的 `getModel()`）现在可以选择自部署的模型。对 agent 循环来说，自部署模型和第三方 API 没有任何区别 — 都是通过 `StreamFunction` 接口调用。

## vLLM 版本选择

pods 支持三种 vLLM 版本：

| 版本 | 适用场景 |
|------|---------|
| `release` | 默认。稳定版 vLLM |
| `nightly` | 需要最新功能（如新模型支持） |
| `gpt-oss` | 专门为 GPT-OSS 模型优化的 fork |

版本选择在 `setupPod()` 时确定，记录在 pod 配置中。`listPods()` 会显示 vLLM 版本信息，对 `gpt-oss` 版本额外警告其兼容性限制。

## 配置管理

pods 的配置存储在 `~/.pi/pods.json`：

```typescript
// packages/pods/src/config.ts
export const loadConfig = (): Config => { /* 读取 JSON */ };
export const saveConfig = (config: Config): void => { /* 写入 JSON */ };
export const getActivePod = (): { name: string; pod: Pod } | null;
export const addPod = (name: string, pod: Pod): void;
export const removePod = (name: string): void;
export const setActivePod = (name: string): void;
```

配置包含：所有 pod 的 SSH 命令、GPU 信息、已部署的模型列表、模型路径、vLLM 版本。`active` 字段标记默认使用的 pod，大多数命令不需要显式指定 `--pod`。

## 取舍分析

### 得到了什么

**模型自主权**。用户可以运行自己的模型，不受第三方 API 的价格和策略变化影响。DataCrunch 上一台 4xA100 的月费可能只是调用 Claude API 一周费用的零头。

**一键部署**。从裸机 GPU 到可用的 OpenAI-compatible endpoint，一条命令搞定。这对不熟悉 vLLM、CUDA、模型部署的开发者来说，降低了巨大的门槛。

**无缝集成**。因为 vLLM 暴露标准 OpenAI API，pi 的 provider registry 无需修改就能对接。自部署模型和第三方 API 在 agent 层完全透明。

### 放弃了什么

**职责边界模糊**。把部署工具放在 agent 仓库里，让 monorepo 的范围从"agent 开发"扩展到了"模型运维"。但对于需要端到端控制的用户，这种"职责越界"反而是便利。

**没有 GPU 编排能力**。pods 不做多机调度、自动扩缩容、健康检查。它假设用户手动管理 GPU 机器的生命周期。对于需要生产级 GPU 集群管理的场景，应该使用 Kubernetes + GPU Operator 等专业工具。

**SSH 依赖**。直接调用系统 `ssh` 命令意味着用户必须先配置好 SSH 密钥和连接。这对有 SSH 经验的开发者很自然，但对新手可能是障碍。

---

### 版本演化说明
> 本章核心分析基于 pi-mono v0.66.0。Pods 是 pi-mono 中变化最少的包 —
> 它的核心功能（SSH 配置 + vLLM 管理）自引入以来保持稳定。
> 近期添加了 `gpt-oss` vLLM 版本支持和更多预配置模型。
