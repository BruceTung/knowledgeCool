import type { MouseEvent } from 'react';

/**
 * 编辑器里按钮的"按下即执行"处理器 —— 让**鼠标与键盘都能触发**。
 *
 * ## 为什么需要它
 *
 * 工具栏、表格菜单、链接气泡里的按钮**一律挂在 `onMouseDown`** 上,
 * 而且都调了 `preventDefault()`:点按钮会先把焦点从编辑器抢走、选区随之丢失,
 * 于是"选中一段文字再点加粗"会变成"什么都没加粗"。这个理由是对的,
 * 所以那套写法必须留着。
 *
 * 但**键盘激活一个 <button> 只会派发 `click`,`mousedown` 永远不会发生**
 * (回车 / 空格都是)。于是加粗、标题、列表、代码块、撤销、插图、链接、表格
 * —— 全部**键盘不可达**:焦点能移上去,按下去毫无反应。
 * 这是 WCAG 2.1.1(Keyboard,Level A)那一档的问题,不是"体验优化"。
 *
 * ## 怎么判断"这次点击是键盘来的"
 *
 * 用 `event.detail === 0`。UI Events 规范规定:由**键盘**触发的合成 click,
 * `detail` 一律是 **0**;真实鼠标点击则带点击数(1、2、3…)。
 * 照这个判据分开处理,就不会出现"鼠标点一次执行两遍"
 * —— 那正是"无脑同时挂 onClick 和 onMouseDown"的后果。
 *
 * 所以本文件提供的是**一对**互补的处理器:
 *   · `onMouseDown` 分支:鼠标路径,照旧 `preventDefault()` 保住选区。
 *   · `onClick` 分支:**只在 detail === 0 时**执行,补上键盘路径。
 *
 * ⚠️ 两个分支**不要**同时判定同一个事件:鼠标点击会依次派发
 * `mousedown` 与 `click`(后者 detail >= 1),前者执行、后者被 detail 判定挡掉;
 * 键盘则只派发 `click`(detail === 0),被前者漏掉、由后者补上。
 * 两条路径正好互斥且完整。
 */

/** 键盘触发的 click 一律带 `detail === 0`(UI Events 规范)。 */
export function isKeyboardActivation(event: MouseEvent<HTMLElement>): boolean {
  return event.detail === 0;
}

/**
 * 生成一对处理器,交给 `<button {...pressHandlers(fn)} />` 展开使用。
 *
 * `preventDefault()` **只在鼠标路径**调用:键盘路径下焦点本来就在按钮上,
 * 没有"选区被抢走"的问题,而且阻止默认行为反而可能干扰按钮自身的语义。
 */
export function pressHandlers(action: () => void): {
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
} {
  return {
    onMouseDown: (event) => {
      event.preventDefault();
      action();
    },
    onClick: (event) => {
      if (!isKeyboardActivation(event)) return;
      action();
    },
  };
}
