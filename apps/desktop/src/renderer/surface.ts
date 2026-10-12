/**
 * 浮层窗口的出入场动画，主进程那一侧见 main/surface.ts。
 *
 * 主进程在隐藏前发 leave、显示前发 enter；这里只负责给根元素挂类名，
 * 动画本身写在 surface.css 里，三个页面共用。
 */

import './surface.css';

const root = document.documentElement;

window.xfb.onSurfacePhase((phase) => {
  root.classList.remove('surface-entering');
  root.classList.toggle('surface-leaving', phase === 'leave');
  if (phase === 'enter') {
    // 强制重排一次，连续两次 enter 时动画才会重播。
    void root.offsetWidth;
    root.classList.add('surface-entering');
  }
});
