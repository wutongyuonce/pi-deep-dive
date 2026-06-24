# Summary

[前言](./preface.md)

---

# 序章

- [不是又一个 LLM 包装器](./ch01-prologue.md)

# 第一篇：分层的纪律

- [七个包不是七个项目](./ch02-packages.md)
- [怎样高效阅读这个仓库](./ch03-reading-map.md)

# 第二篇：统一调用面 — pi-ai 的设计

- [Provider 不是 Adapter](./ch04-provider-registry.md)
- [消息变换：跨模型交接的隐藏复杂度](./ch05-message-transform.md)
- [统一事件流设计](./ch06-event-stream.md)
- [OAuth — 统一认证的隐藏复杂度](./ch07-oauth.md)

# 第三篇：Agent Runtime — 循环引擎的设计

- [agentLoop — 发动机只管转](./ch08-agent-loop.md)
- [工具执行不是插件调用](./ch09-tool-execution.md)
- [Agent — 循环之上的有状态壳](./ch10-agent-class.md)

# 第四篇：从 Runtime 到产品

- [会话树：比"聊天记录"更好的数据模型](./ch11-session-tree.md)
- [Compaction — 把无限对话装进有限窗口](./ch12-compaction.md)
- [三级配置覆盖](./ch13-config-layers.md)
- [System Prompt 是一套装配流程](./ch14-system-prompt.md)

# 第五篇：能力外置

- [Extension 系统 — 让产品长出新器官](./ch15-extensions.md)
- [Skill 机制 — 用文档替代代码](./ch16-skills.md)
- [Resource Loader — 一切外部资源的统一入口](./ch17-resource-loader.md)
- [Model Registry — 模型不只是一个 ID](./ch18-model-registry.md)

# 第六篇：工具设计 — 约束即保护

- [工具设计原则](./ch19-tool-principles.md)
- [edit 的设计 — 为什么不能直接写文件](./ch20-edit-tool.md)
- [read 的设计 — 为什么不是简单的 cat](./ch21-read-tool.md)
- [bash 与外部世界的边界](./ch22-bash-tool.md)
- [find 和 grep — 结构化搜索替代万能 bash](./ch23-search-tools.md)

# 第七篇：UI 层 — 同一颗内核的不同宿主

- [pi-tui — 在终端里做应用](./ch24-tui.md)
- [编辑器组件 — 交互复杂度的集中地](./ch25-editor.md)
- [RPC 模式 — pi 作为后端服务](./ch26-rpc.md)
- [pi-web-ui — 浏览器里的复用](./ch27-web-ui.md)

# 第八篇：产品化实证

- [mom — Slack 里的 Coding Agent](./ch28-mom-slack.md)
- [pods — 为什么这个仓库还要管 GPU](./ch29-pods-gpu.md)

# 第九篇：设计哲学

- [极简核心，能力外置](./ch30-minimal-core.md)
- [反主流选择背后的判断](./ch31-contrarian-choices.md)
- [这套架构的适用边界](./ch32-boundaries.md)

---

[附录](./appendix.md)
