/**
 * TUI 会话选择器 -- 用于 --resume/-r 命令行参数
 *
 * 【文件定位】
 * 此文件是 CLI 层的会话恢复模块，负责创建一个基于终端的交互式 TUI 列表，
 * 让用户从历史会话中选择一个来恢复。它是 "resume" 功能的入口界面。
 *
 * 【在调用链中的位置】
 * 用户执行 `pi --resume` 或 `pi -r`
 *   → main.ts 检测到 parsed.resume === true
 *     → selectSession(currentSessionsLoader, allSessionsLoader)
 *       → 创建 TUI 实例和 KeybindingsManager
 *       → 实例化 SessionSelectorComponent（交互式会话列表组件）
 *       → 用户通过 TUI 选择会话或取消
 *       → 返回选中的会话文件路径或 null
 *     → main.ts 使用返回的路径恢复会话或退出
 *
 * 【提供的能力】
 * selectSession(): 启动 TUI 会话选择器，返回用户选择的会话路径
 *
 * 【与其他文件的关系】
 * - 被 main.ts 调用（用户指定 --resume/-r 时）
 * - 调用 modes/interactive/components/session-selector.ts 的 SessionSelectorComponent 渲染 UI
 * - 调用 core/keybindings.ts 的 KeybindingsManager 管理快捷键配置
 * - 使用 @earendil-works/pi-tui 的 TUI/ProcessTerminal/setKeybindings 框架
 * - 使用 core/session-manager.ts 的 SessionInfo/SessionListProgress 类型定义
 */

import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";

/**
 * 会话加载器函数类型
 *
 * 用于异步加载会话列表，支持通过回调函数报告加载进度。
 * 有两种使用场景：
 * - currentSessionsLoader: 加载当前工作目录相关的会话
 * - allSessionsLoader: 加载所有历史会话
 *
 * @param onProgress - 可选的进度回调函数，在发现每个新会话时触发
 * @returns 会话信息数组的 Promise
 */
type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/**
 * 启动 TUI 会话选择器，让用户交互式选择要恢复的历史会话
 *
 * 创建一个基于终端的全屏 TUI 界面，展示可选的历史会话列表。
 * 用户可以通过键盘导航和选择会话，也可以取消操作。
 *
 * 内部通过 Promise 包装 TUI 的异步交互流程：
 * 1. 初始化 TUI 框架和快捷键系统
 * 2. 创建 SessionSelectorComponent 并注册回调
 * 3. 启动 TUI 事件循环
 * 4. 用户操作后通过回调 resolve Promise 并停止 TUI
 *
 * 【被谁调用】
 * - main.ts 在用户指定 --resume/-r 参数时调用
 *   调用方式：
 *   ```
 *   const selectedPath = await selectSession(
 *     (onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
 *     SessionManager.listAll,
 *   );
 *   ```
 *
 * 【调用了谁】
 * - TUI: pi-tui 框架的终端 UI 管理器，负责渲染和事件循环
 * - ProcessTerminal: 基于 Node.js process 的终端适配器
 * - KeybindingsManager.create(): 创建默认快捷键配置
 * - setKeybindings(): 设置全局快捷键绑定
 * - SessionSelectorComponent: 交互式会话列表 UI 组件
 *   - getSessionList(): 获取内部的会话列表组件（用于设置焦点）
 *
 * @param currentSessionsLoader - 加载当前目录相关会话的函数
 * @param allSessionsLoader - 加载所有历史会话的函数
 * @returns 用户选中的会话文件路径，若用户取消则返回 null
 */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
): Promise<string | null> {
	// 使用 Promise 包装 TUI 的异步交互流程
	return new Promise((resolve) => {
		// 创建 TUI 实例，使用 ProcessTerminal 作为底层终端适配器
		const ui = new TUI(new ProcessTerminal());

		// 创建快捷键管理器并设置为全局快捷键绑定
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);

		// 防止多次 resolve 的标志位
		// 用户可能在快速操作中触发多个回调，确保 Promise 只 resolve 一次
		let resolved = false;

		// 创建会话选择器组件，传入各种回调函数
		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			// 用户选中某个会话时的回调：停止 TUI 并返回会话路径
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			// 用户取消选择时的回调：停止 TUI 并返回 null
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			// 用户强制退出时的回调：停止 TUI 并直接退出进程
			() => {
				ui.stop();
				process.exit(0);
			},
			// 请求重新渲染的回调：当组件状态变化时触发界面更新
			() => ui.requestRender(),
			// 组件配置选项：不显示重命名提示，传入快捷键配置
			{ showRenameHint: false, keybindings },
		);

		// 将选择器组件添加为 TUI 的子组件
		ui.addChild(selector);

		// 将焦点设置到会话列表，使用户可以立即用键盘导航
		ui.setFocus(selector.getSessionList());

		// 启动 TUI 事件循环，开始监听用户输入
		ui.start();
	});
}
