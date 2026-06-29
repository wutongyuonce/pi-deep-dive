/**
 * @file TUI 配置选择器，用于 `pi config` 命令
 *
 * 文件定位：CLI 子命令入口，提供基于终端 UI 的交互式配置界面。
 * 调用链位置：用户执行 `pi config` -> ../cli.ts -> selectConfig() -> ConfigSelectorComponent
 *
 * 提供的能力：
 *   - 创建 TUI（终端用户界面）实例并启动配置选择组件
 *   - 管理主题初始化与销毁的生命周期
 *   - 允许用户通过 TUI 界面启用/禁用包资源（package resources）
 *
 * 与其他文件的关系：
 *   - 被 ../cli.ts 在用户执行 `pi config` 命令时调用
 *   - 调用 ConfigSelectorComponent（来自 modes/interactive/components/config-selector.ts）渲染配置选择 UI
 *   - 调用 initTheme/stopThemeWatcher（来自 modes/interactive/theme/theme.ts）管理主题生命周期
 *   - 依赖 @earendil-works/pi-tui 库提供 TUI 渲染引擎
 */

import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import type { ResolvedPaths } from "../core/package-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";

/**
 * 配置选择器的选项接口
 */
export interface ConfigSelectorOptions {
	/** 已解析的包路径信息（包含资源路径等） */
	resolvedPaths: ResolvedPaths;
	/** 设置管理器，用于读取和保存用户配置 */
	settingsManager: SettingsManager;
	/** 当前工作目录 */
	cwd: string;
	/** agent 配置目录路径 */
	agentDir: string;
}

/**
 * 启动 TUI 配置选择器，在用户关闭界面后返回。
 *
 * 创建一个基于终端的交互式界面，让用户可以浏览和修改包资源配置。
 * 使用 Promise 包装 TUI 生命周期，当用户退出时自动清理资源并 resolve。
 *
 * 调用者：../cli.ts（在用户执行 `pi config` 命令时调用）
 * 调用了：
 *   - initTheme() - 初始化 TUI 主题样式
 *   - ConfigSelectorComponent - 渲染配置选择列表
 *   - stopThemeWatcher() - 停止主题文件监听
 *   - TUI / ProcessTerminal - pi-tui 库的终端渲染引擎
 *
 * @param options - 配置选择器选项
 * @param options.resolvedPaths - 已解析的包资源路径
 * @param options.settingsManager - 设置管理器实例
 * @param options.cwd - 当前工作目录
 * @param options.agentDir - agent 配置目录
 * @returns Promise<void> - 用户关闭配置界面后 resolve
 */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// 在显示 TUI 之前初始化主题，第二个参数 true 表示启用主题文件监听
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		// 创建 TUI 实例，绑定到当前进程的标准终端
		const ui = new TUI(new ProcessTerminal());
		// 防止重复 resolve 的标志位（用户可能同时触发关闭和退出）
		let resolved = false;

		// 创建配置选择组件，传入所有必要参数和回调
		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			// onDone 回调：用户正常完成配置时调用
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop(); // 停止 TUI 渲染循环
					stopThemeWatcher(); // 停止主题文件监听
					resolve(); // 解除 Promise，恢复调用者的执行流
				}
			},
			// onQuit 回调：用户选择退出程序时调用
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0); // 直接退出进程
			},
			// requestRender 回调：组件内容变化时触发重新渲染
			() => ui.requestRender(),
			ui.terminal.rows, // 传入终端行数，用于组件布局计算
		);

		// 将配置组件挂载到 TUI 树中
		ui.addChild(selector);
		// 将焦点设置到资源列表，使用户可以立即用键盘操作
		ui.setFocus(selector.getResourceList());
		// 启动 TUI 渲染循环，开始响应终端事件
		ui.start();
	});
}
