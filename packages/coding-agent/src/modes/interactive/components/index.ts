/**
 * @fileoverview 交互模式 UI 组件的桶导出文件（barrel export）。
 *
 * 文件定位：
 *   位于交互模式的 components 子目录下，是所有 TUI 组件的统一导出入口。
 *   路径：packages/coding-agent/src/modes/interactive/components/index.ts
 *
 * 在调用链中的位置：
 *   - 被 interactive-mode.ts 导入，用于组装交互模式的完整 UI 界面
 *   - 被其他需要使用交互模式 UI 组件的模块统一导入
 *
 * 提供的能力：
 *   聚合导出约 30 个 TUI 组件和辅助函数，涵盖：
 *   - 消息渲染组件（AssistantMessage、UserMessage、CustomMessage 等）
 *   - 工具执行组件（ToolExecution、BashExecution、Diff 渲染等）
 *   - 选择器组件（ModelSelector、ThemeSelector、SettingsSelector 等）
 *   - 编辑器组件（CustomEditor、ExtensionEditor 等）
 *   - 布局/装饰组件（DynamicBorder、BorderedLoader、Footer 等）
 *   - 键绑定提示工具（keyHint、keyText）
 *   - 辅助工具（truncateToVisualLines、renderDiff）
 *
 * 与其他文件的关系：
 *   - 本文件仅做重导出，不包含业务逻辑，所有实现在各自的组件文件中
 *   - 每个导出项对应同目录下的一个 .ts 组件文件
 */

// 消息渲染组件
export { ArminComponent } from "./armin.ts";
export { AssistantMessageComponent } from "./assistant-message.ts";
export { BranchSummaryMessageComponent } from "./branch-summary-message.ts";
export { CompactionSummaryMessageComponent } from "./compaction-summary-message.ts";
export { CustomMessageComponent } from "./custom-message.ts";
export { SkillInvocationMessageComponent } from "./skill-invocation-message.ts";
export { UserMessageComponent } from "./user-message.ts";

// 工具执行与 Diff 组件
export { BashExecutionComponent } from "./bash-execution.ts";
export { type RenderDiffOptions, renderDiff } from "./diff.ts";
export { ToolExecutionComponent, type ToolExecutionOptions } from "./tool-execution.ts";

// 选择器组件
export { AuthSelectorComponent } from "./auth-selector.ts";
export { ExtensionSelectorComponent } from "./extension-selector.ts";
export { ModelSelectorComponent } from "./model-selector.ts";
export { type ModelsCallbacks, type ModelsConfig, ScopedModelsSelectorComponent } from "./scoped-models-selector.ts";
export { SessionSelectorComponent } from "./session-selector.ts";
export { type SettingsCallbacks, type SettingsConfig, SettingsSelectorComponent } from "./settings-selector.ts";
export { ShowImagesSelectorComponent } from "./show-images-selector.ts";
export { ThemeSelectorComponent } from "./theme-selector.ts";
export { ThinkingSelectorComponent } from "./thinking-selector.ts";
export { TreeSelectorComponent } from "./tree-selector.ts";
export { UserMessageSelectorComponent } from "./user-message-selector.ts";

// 编辑器组件
export { CustomEditor } from "./custom-editor.ts";
export { ExtensionEditorComponent } from "./extension-editor.ts";
export { ExtensionInputComponent } from "./extension-input.ts";

// 认证与登录
export { LoginDialogComponent } from "./login-dialog.ts";

// 布局与装饰组件
export { BorderedLoader } from "./bordered-loader.ts";
export { DynamicBorder } from "./dynamic-border.ts";
export { FooterComponent } from "./footer.ts";

// 键绑定提示与辅助工具
export { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";
export { truncateToVisualLines, type VisualTruncateResult } from "./visual-truncate.ts";
