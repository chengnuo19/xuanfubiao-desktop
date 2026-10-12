/**
 * 浮层窗口（输入条、目标面板、临时篮子）统一的出入场节奏。
 *
 * `win.hide()` 是瞬间消失的，出现时却各有动画，一硬一软很割裂。
 * 这里先让页面自己淡出，再真正隐藏；期间若又被唤出，就取消隐藏并淡入回来。
 * 页面那一侧的样式见 renderer/surface.ts。
 */

import type { BrowserWindow } from 'electron';

/** 比页面里的淡出动画略长一点，保证最后一帧已经画完再藏窗口。 */
const LEAVE_MS = 140;

const leaving = new WeakMap<BrowserWindow, NodeJS.Timeout>();

/** 窗口正在淡出的途中。对使用者来说它已经“关了”，切换逻辑应把它当作不可见。 */
export function isSurfaceLeaving(win: BrowserWindow): boolean {
  return leaving.has(win);
}

/** 看得见且没在淡出。给“再按一次就收起”这类切换判断用。 */
export function isSurfaceShown(win: BrowserWindow): boolean {
  return !win.isDestroyed() && win.isVisible() && !leaving.has(win);
}

export function fadeOutAndHide(win: BrowserWindow): void {
  if (win.isDestroyed() || !win.isVisible() || leaving.has(win)) return;
  win.webContents.send('surface:phase', 'leave');
  leaving.set(win, setTimeout(() => {
    leaving.delete(win);
    if (!win.isDestroyed()) win.hide();
  }, LEAVE_MS));
}

/**
 * 每次显示前调用：取消还没执行的隐藏，并让页面淡入。
 * `animate: false` 给自带入场动画的页面（临时篮子）用，只复位不重播。
 */
export function prepareSurfaceShow(win: BrowserWindow, animate = true): void {
  if (win.isDestroyed()) return;
  const timer = leaving.get(win);
  if (timer) {
    clearTimeout(timer);
    leaving.delete(win);
  }
  win.webContents.send('surface:phase', animate ? 'enter' : 'reset');
}
