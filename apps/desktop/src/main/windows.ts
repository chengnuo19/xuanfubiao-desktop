/**
 * 四个窗口：常驻桌面的悬浮标本体、输入条、目标选择面板，以及临时篮子。
 */

import { BrowserWindow, screen, shell } from 'electron';
import { readPetPosition, savePetPosition } from './settings.js';
import { fadeOutAndHide } from './surface.js';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 能不能用 Win11 的亚克力材质。
 *
 * 两个条件缺一不可：
 *
 * 1. **Win11 22H2（build 22621）以上** —— `backgroundMaterial` 的门槛。
 * 2. **用户没关掉「透明效果」** —— 关掉之后 DWM 会把 backdrop 画成一块
 *    不透明纯色，比我们自己画的伪玻璃还难看，那还不如直接走伪玻璃。
 *
 * 只在启动时判一次，而且必须在建窗之前判完：`transparent` 是建窗时定死的，
 * 运行期改不了。窗口选项和渲染层的 CSS 得在同一时刻选定**同一条**路，
 * 否则会出现「窗口是方角不透明的，CSS 却在里面画圆角卡片」——四角露底。
 */
function detectAcrylic(): boolean {
  /*
    强制走伪玻璃。

    回落那条路平时根本跑不到：要么机器太旧，要么得去系统设置里关掉
    「透明效果」再重启——而那是台机器全局的设置，改完忘了关回来
    整个系统的观感都跟着变。没有这个开关，回落路径就只能靠想象，
    坏了也发现不了（它不报错，只是圆角和边距全错）。
  */
  if (process.env['XFB_FALLBACK']) {
    console.log('[材质] XFB_FALLBACK 已设置，强制用伪玻璃');
    return false;
  }

  if (process.platform !== 'win32') return false;

  // os.release() 形如 "10.0.26200"，第三段才是 build 号。
  const build = Number(os.release().split('.')[2] ?? 0);
  if (!Number.isFinite(build) || build < 22621) {
    console.log(`[材质] Windows build ${build} 不足 22621，用伪玻璃`);
    return false;
  }

  /*
    注册表里读不到这个值，意味着用户从没动过它，而透明效果默认是**开**的。
    所以读不到要按开启算——按关闭算的话，一台全新的机器会白白吃不到亚克力。
  */
  try {
    const out = execSync(
      'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v EnableTransparency',
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    );
    const matched = /EnableTransparency\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    if (matched && Number.parseInt(matched[1] ?? '1', 16) === 0) {
      console.log('[材质] 用户关了「透明效果」，用伪玻璃');
      return false;
    }
  } catch {
    /* 键不存在、或 reg 跑不起来：按默认的「开启」处理 */
  }

  console.log('[材质] 亚克力可用');
  return true;
}

/** 启动时判一次，之后全程读这个值。窗口层和渲染层必须认同一个结论。 */
export const acrylicAvailable = detectAcrylic();

/**
 * 两个矩形窗口（输入条、目标面板）的背景配置。
 *
 * 亚克力和 `transparent: true` 是**互斥**的，不是叠加关系：
 * 透明窗口自带 alpha 通道，DWM 画在窗口底下的 backdrop 根本透不上来。
 * 所以要真模糊就必须让窗口自己不透明，再把底色交给系统。
 *
 * `backgroundColor` 必须是全透明的 `#00000000`，否则这层窗口底色会
 * 严严实实盖在 backdrop 上面，忙活半天还是一块纯色。
 *
 * 悬浮标窗口用不了这套——它要不规则形状和鼠标穿透，只能保持透明。
 */
function surfaceOptions(): Electron.BrowserWindowConstructorOptions {
  if (!acrylicAvailable) return { transparent: true, hasShadow: false };
  return {
    transparent: false,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    // 圆角和投影这时都归 DWM 管，CSS 那边要相应归零
    hasShadow: true,
  };
}

/**
 * 宠物窗口尺寸。
 *
 * 本体是一条 177×52 的横向胶囊，四周留出余量给投影和状态气泡。
 * 刻意不做大：这是个常驻置顶的透明窗口，多出来的透明区域一样会挡住桌面点击。
 * 目标面板因此独立成窗口，不占这里的空间。
 */
const PET_SIZE = { width: 216, height: 110 };

/**
 * 桌宠外观时的窗口尺寸。
 *
 * 角色本体 120×120（角色 96 + 外圈进度环），上方留出状态气泡，
 * 下方留出 hover 时浮出的那排按钮。宽度和胶囊一样，庆祝时的撑大逻辑不用改。
 */
const PET_AVATAR_SIZE = { width: 216, height: 196 };

export type PetSkin = 'capsule' | 'avatar';

function petSizeFor(skin: PetSkin): { width: number; height: number } {
  return skin === 'avatar' ? PET_AVATAR_SIZE : PET_SIZE;
}

/**
 * 换外观时改窗口尺寸，**底边和水平中心不动**。
 *
 * 悬浮标常年贴在屏幕右下角，按左上角不动去改高度的话，
 * 胶囊换成角色那一下窗口会往下长出屏幕。
 */
export function setPetWindowSkin(win: BrowserWindow, skin: PetSkin): void {
  if (win.isDestroyed()) return;
  // 庆祝撑大期间不改，等它缩回来（restorePetWindow 用的是撑大前存下的矩形）。
  if (petRestoreBounds) return;
  const b = win.getBounds();
  const size = petSizeFor(skin);
  if (b.width === size.width && b.height === size.height) return;
  const { workArea } = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  let x = Math.round(b.x + (b.width - size.width) / 2);
  let y = b.y + b.height - size.height;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height));
  win.setBounds({ x, y, ...size }, false);
}

/**
 * 输入条本体四周留给投影的透明边，单边。
 *
 * 只有伪玻璃那条路需要：投影是 CSS 画的，画在窗口内部，
 * 不留边就会被窗口边缘齐齐切掉。走亚克力时投影归 DWM，
 * 窗口本身就是面板，一点余量都不用留。
 *
 * 渲染层的 `.bar` 用同一个值做 margin，两边必须一致——
 * 渲染层量出的内容高度是加上这两份 margin 才等于窗口高度的。
 */
export const CARD_MARGIN = acrylicAvailable ? 0 : 8;

/**
 * 输入条的初始内容高度（不含上面那两份 margin）。
 *
 * 只用来定建窗时的第一帧，页面一起来就会按真实内容重新报一次。
 * 取得接近是为了别让用户看见窗口在显示的瞬间跳一下高度。
 */
const INPUT_CONTENT_HEIGHT = 90;

const INPUT_SIZE = { width: 620, height: INPUT_CONTENT_HEIGHT + CARD_MARGIN * 2 };

/**
 * 输入条窗口的高度范围。展开提示词列表时在这之间伸缩。
 *
 * 下限是**防塌**用的，不是「正常高度」——它一旦顶到真实内容高度，
 * 就会把底边裁掉几像素，而且裁得毫无征兆（日志里只会写「117 → 116」
 * 这种看着像四舍五入的行）。所以要明显地留出余量，
 * 字体或 DPI 让内容长高几像素时不会撞上来。
 */
export const INPUT_MIN_HEIGHT = 84 + CARD_MARGIN * 2;
export const INPUT_MAX_HEIGHT = 420;

/** 拖拽会密集触发 moved，攒够这么久没有新动作再落盘。 */
const POSITION_SAVE_DEBOUNCE_MS = 500;

/**
 * 庆祝动画时窗口临时撑到多大。
 *
 * 待机只有 216×110，而本体是 52 的圆——粒子最远只能从 50px 外飞进来，
 * 太局促，"汇聚"看着像"抖了一下"。撑到这里能从 128px 外卷进来。
 */
const PET_CELEBRATION_SIZE = { width: 360, height: 260 };

/**
 * 庆祝期间挂起位置保存。
 *
 * 撑大和缩回都走 setBounds，而 setBounds 会触发 `moved`——那上面挂着
 * 去抖的位置落盘。不挂起的话，去抖会稳稳地把**撑大时**的坐标存成
 * 「用户拖到的位置」，于是悬浮标每庆祝一次就往左上挪一点，
 * 下次开机在新地方。这类 bug 不报错，只会让窗口一天天爬走。
 */
let suspendPositionSave = false;

/** 撑大前的窗口矩形，缩回时原样还回去。 */
let petRestoreBounds: Electron.Rectangle | null = null;

/** 四个渲染页面：悬浮标本体、输入条、目标面板、临时篮子。 */
type RendererPage = 'pet' | 'input' | 'panel' | 'basket' | 'agents';

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

/**
 * 载入页面，并把当前材质一并告诉渲染层。
 *
 * 用 query 传而不是等页面起来再走 IPC：材质决定圆角、投影和外边距，
 * IPC 到达时页面已经画完第一帧了，会看见一次明显的跳变。
 *
 * 打包后走的是 `loadFile`，它不认路径里拼的 `?`，query 得从 options 走。
 */
function loadPage(win: BrowserWindow, page: RendererPage): void {
  const query = { material: acrylicAvailable ? 'acrylic' : 'fallback' };
  if (isDev) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}.html?material=${query.material}`);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${page}.html`), { query });
  }
}

const preloadPath = path.join(__dirname, '../preload/index.js');

/**
 * 浮动窗口在 Windows 上做成工具窗口（WS_EX_TOOLWINDOW）。
 *
 * `skipTaskbar` 只是把窗口从任务栏摘掉，Alt+Tab 里照样有它。
 * MyDockFinder 的台前调度这类工具按 Alt+Tab 的规则认「应用窗口」，
 * 于是用户一切到别的程序，悬浮标就被当成一个应用收进侧边缩略图里。
 * 工具窗口不进 Alt+Tab，这些工具也就不管它了。
 */
const floatingType: Electron.BrowserWindowConstructorOptions =
  process.platform === 'win32' ? { type: 'toolbar' } : {};

export function createPetWindow(skin: PetSkin = 'capsule'): BrowserWindow {
  const size = petSizeFor(skin);
  const { workArea } = screen.getPrimaryDisplay();

  // 上次拖到的位置优先；没存过或已不在任何屏幕内，就回到右下角。
  const saved = readPetPosition();
  const origin = saved ?? {
    x: workArea.x + workArea.width - size.width - 24,
    y: workArea.y + workArea.height - size.height - 24,
  };

  const win = new BrowserWindow({
    ...size,
    x: origin.x,
    y: origin.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    ...floatingType,
    alwaysOnTop: true,
    hasShadow: false,
    /*
      这里**不能**设 focusable: false。
      它在 Windows 上会加 WS_EX_NOACTIVATE，实测连鼠标点击也一并挡掉——
      胶囊上的按钮会完全点不动，而且毫无报错，极难查。
      不进任务栏由 skipTaskbar 保证，已经够了。
    */
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'screen-saver' 层级能压过绝大多数应用窗口，包括全屏的播放器。
  win.setAlwaysOnTop(true, 'screen-saver');
  // 跟随用户切换虚拟桌面，避免「宠物不见了」。
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  /*
    默认让鼠标穿透。

    窗口有 216×110，而本体只占中间一小块，其余都是透明区域。
    不穿透的话，那一大片看不见的地方会一直挡着桌面图标和下层窗口的点击。

    何时恢复可交互，由 hover.ts 里的主进程轮询决定。
    不要指望 forward: true——它承诺的「穿透时仍转发 mousemove」在 Windows 上
    实测收不到，渲染层完全静默，没法靠它自己发现鼠标压了上来。
  */
  win.setIgnoreMouseEvents(true, { forward: true });

  loadPage(win, 'pet');

  /*
    记住用户拖到哪儿了。
    拖拽期间 moved 会密集触发，必须去抖——否则一次拖动就是几十次磁盘写入。
  */
  let saveTimer: NodeJS.Timeout | null = null;
  win.on('moved', () => {
    // 庆祝动画自己搬的窗口不算用户拖的，见 suspendPositionSave。
    if (suspendPositionSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      // 挂起是在排队之后才置上的话，这一发还在队列里，所以出口再拦一道。
      if (suspendPositionSave) return;
      // 用 getBounds 而不是 getPosition：后者返回数组，
      // 在 noUncheckedIndexedAccess 下解构出来是可选类型，得额外做判空。
      const { x, y } = win.getBounds();
      savePetPosition({ x, y });
    }, POSITION_SAVE_DEBOUNCE_MS);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

/**
 * 把悬浮标窗口临时撑大，给庆祝动画腾地方。
 *
 * 朝四周扩，但**每一边能扩多少要单独算**：悬浮标常年待在屏幕右下角，
 * 右边和下边基本没有余量。扩不动的那一边就少扩，缺口也不转嫁给对边——
 * 那样窗口会整个朝一侧长出去，本体偏得更远。
 *
 * 代价是扩出来的框不再以本体为中心，于是返回一个偏移量交给渲染层，
 * 让本体自己往回挪，**保证本体的屏幕坐标一动不动**。
 * 不修正的话本体会随窗口一起平移，看着像它自己蹦了一下再弹回来。
 *
 * 多出来的透明区域不会挡桌面点击：命中判断用的是渲染层上报的**本体**矩形，
 * 不是窗口矩形（见 hover.ts）。但渲染层必须在窗口变尺寸后重报一次，
 * 本体在窗口内的位置变了。
 */
export function expandPetWindow(win: BrowserWindow): { offsetX: number; offsetY: number } {
  const b = win.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: b.x, y: b.y });

  const wantX = Math.max(0, PET_CELEBRATION_SIZE.width - b.width) / 2;
  const wantY = Math.max(0, PET_CELEBRATION_SIZE.height - b.height) / 2;

  const left = Math.min(wantX, Math.max(0, b.x - workArea.x));
  const right = Math.min(wantX, Math.max(0, workArea.x + workArea.width - (b.x + b.width)));
  const top = Math.min(wantY, Math.max(0, b.y - workArea.y));
  const bottom = Math.min(wantY, Math.max(0, workArea.y + workArea.height - (b.y + b.height)));

  // 重复触发时保住**最早**那次的原始矩形，否则第二次会把撑大的尺寸当原始值存下来。
  petRestoreBounds ??= { ...b };
  suspendPositionSave = true;

  win.setBounds(
    {
      x: Math.round(b.x - left),
      y: Math.round(b.y - top),
      width: Math.round(b.width + left + right),
      height: Math.round(b.height + top + bottom),
    },
    false,
  );

  // 本体应在的位置减去新窗口的中心 = 本体要往回挪多少。
  return {
    offsetX: Math.round((left - right) / 2),
    offsetY: Math.round((top - bottom) / 2),
  };
}

/** 庆祝演完，把窗口还回原来的尺寸和位置。 */
export function restorePetWindow(win: BrowserWindow): void {
  if (!petRestoreBounds) return;
  win.setBounds(petRestoreBounds, false);
  petRestoreBounds = null;

  /*
    再多压一会儿才放开保存：刚才这次 setBounds 触发的 moved 还躺在去抖队列里，
    立刻放开的话，它醒来时读到的就是缩回前的坐标。
  */
  setTimeout(() => {
    suspendPositionSave = false;
  }, POSITION_SAVE_DEBOUNCE_MS * 2);
}

/**
 * 目标选择面板。
 *
 * 原先用系统原生菜单，但那东西的布局和配色全归系统管，
 * 加不了图标、显示不了「这个目标现在能不能用」。自己画一个窗口才控制得住。
 */
/*
  高度要放得下全部 5 个目标：图标 36px、每行约 52px，加标题与内外边距约 320。
  列表本身还加了 overflow 兜底，以后目标变多也不会被裁掉。
*/
const PANEL_SIZE = { width: 268, height: 330 };

export function createTargetPanel(): BrowserWindow {
  const win = new BrowserWindow({
    ...PANEL_SIZE,
    ...surfaceOptions(),
    frame: false,
    resizable: false,
    skipTaskbar: true,
    ...floatingType,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadPage(win, 'panel');

  // 点到别处就收起。这里不需要输入条那套宽限期——
  // 面板没有输入内容，误关一次的代价只是再点一下。
  win.on('blur', () => {
    fadeOutAndHide(win);
  });

  return win;
}

/* ---------- 编码代理设置 ---------- */

/**
 * 编码代理设置窗口。
 *
 * 和弹出就收的面板不同，这是个正经的设置窗口：带系统标题栏、能拖能关、进任务栏，
 * 失焦也不收——用户可能一边看终端一边来回切开关。
 */
export function createAgentsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 400,
    minHeight: 420,
    title: '悬浮标 · 编码代理',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#16181f',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  loadPage(win, 'agents');
  win.once('ready-to-show', () => win.show());
  return win;
}

/* ---------- 临时篮子 ---------- */

/** 完整管理器：只在投放架里点「放大」才展开，不必做成一整个主窗口那么大。 */
const BASKET_SIZE = { width: 640, height: 440 };
const BASKET_MIN = { width: 480, height: 360 };
/** 拖放时摇出来的小投放架：只管“放下”，完整管理器按需再展开。 */
const SHELF_SIZE = { width: 300, height: 380 };
const BASKET_GAP = 18;

export type BasketMode = 'shelf' | 'full';

/**
 * Tokri 风格的临时篮子窗口。
 *
 * 不在 blur 时自动隐藏：外部拖放期间焦点仍属于来源应用，若沿用目标面板的
 * blur 规则，窗口会在用户还没把文件拖进来前自行消失。
 */
export function createBasketWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...BASKET_SIZE,
    /*
      篮子不走亚克力：它的圆角卡片是 CSS 画的，铺满整个窗口，
      窗口一旦铺上亚克力，就成了一层毛玻璃外壳套在卡片外面。
    */
    transparent: true,
    hasShadow: false,
    frame: false,
    resizable: true,
    minWidth: BASKET_MIN.width,
    minHeight: BASKET_MIN.height,
    skipTaskbar: true,
    ...floatingType,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadPage(win, 'basket');
  return win;
}

/** 把篮子摆到鼠标旁边，并夹在当前屏幕工作区内。 */
export function showBasketNearCursor(win: BrowserWindow, activate: boolean, mode: BasketMode): void {
  if (win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const size = applyBasketSizeLimits(win, mode);

  let x = cursor.x + BASKET_GAP;
  let y = cursor.y + BASKET_GAP;
  if (x + size.width > workArea.x + workArea.width) x = cursor.x - size.width - BASKET_GAP;
  if (y + size.height > workArea.y + workArea.height) y = cursor.y - size.height - BASKET_GAP;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height));

  win.setBounds({ x: Math.round(x), y: Math.round(y), ...size }, false);
  if (activate) win.show();
  else win.showInactive();
  win.moveTop();
}

/**
 * 在已显示的窗口上切换投放架 / 完整管理器。
 *
 * 以离屏幕中心更远的那一角为锚点缩放：贴在右下角的投放架展开时向左上长，
 * 看上去是“原地展开”，而不是整个窗口跳到别处。
 */
export function setBasketMode(win: BrowserWindow, mode: BasketMode): void {
  if (win.isDestroyed()) return;
  const current = win.getBounds();
  const { workArea } = screen.getDisplayMatching(current);
  const size = applyBasketSizeLimits(win, mode);

  const anchorRight = current.x + current.width / 2 > workArea.x + workArea.width / 2;
  const anchorBottom = current.y + current.height / 2 > workArea.y + workArea.height / 2;
  let x = anchorRight ? current.x + current.width - size.width : current.x;
  let y = anchorBottom ? current.y + current.height - size.height : current.y;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height));

  win.setBounds({ x: Math.round(x), y: Math.round(y), ...size }, false);
}

/** 投放架不能受完整管理器的最小尺寸约束，先放开限制再改尺寸。 */
function applyBasketSizeLimits(win: BrowserWindow, mode: BasketMode): { width: number; height: number } {
  if (mode === 'shelf') {
    win.setMinimumSize(SHELF_SIZE.width, SHELF_SIZE.height);
    return { ...SHELF_SIZE };
  }
  win.setMinimumSize(BASKET_MIN.width, BASKET_MIN.height);
  return { ...BASKET_SIZE };
}

/**
 * 把面板摆在悬浮标旁边。
 *
 * 悬浮标常年待在屏幕右下角，面板要是一律朝右下展开就会出界，
 * 所以两个方向都判一下，哪边放得下就往哪边。
 */
export function positionTargetPanel(panel: BrowserWindow, anchor: BrowserWindow): void {
  const pet = anchor.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: pet.x, y: pet.y });
  const gap = 8;

  // 水平：默认与悬浮标左对齐，放不下就贴着工作区右边。
  let x = pet.x;
  if (x + PANEL_SIZE.width > workArea.x + workArea.width) {
    x = workArea.x + workArea.width - PANEL_SIZE.width - gap;
  }
  x = Math.max(workArea.x + gap, x);

  // 垂直：优先放在下方，下面不够就翻到上方。
  let y = pet.y + pet.height + gap;
  if (y + PANEL_SIZE.height > workArea.y + workArea.height) {
    y = pet.y - PANEL_SIZE.height - gap;
  }
  y = Math.max(workArea.y + gap, y);

  panel.setPosition(Math.round(x), Math.round(y));
}

export function createInputWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...INPUT_SIZE,
    ...surfaceOptions(),
    frame: false,
    resizable: false,
    skipTaskbar: true,
    ...floatingType,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadPage(win, 'input');

  /*
    点到别处就收起，符合「随手唤起、随手消失」的预期。但不能一收到 blur 就关：

    1. 刚显示的那一小段时间里焦点还在切换途中，这时的 blur 是假信号——
       强抢前台的过程本身就会触发一次，窗口会刚弹出来就被自己关掉。
    2. 系统通知、剪贴板访问之类会造成极短暂的失焦，随即焦点就回来了。
       立刻隐藏会让用户正在敲的内容平白消失。

    所以延迟一小会儿再判定，其间若焦点回来了就取消。
  */
  let blurTimer: NodeJS.Timeout | null = null;

  win.on('blur', () => {
    const since = Date.now() - lastShownAt;
    if (since < FOCUS_SETTLE_MS) {
      console.log(`[输入条] 忽略稳定期内的 blur（显示后 ${since}ms）`);
      return;
    }
    console.log(`[输入条] 失焦（显示后 ${since}ms），${BLUR_GRACE_MS}ms 后若未回焦则收起`);
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = null;
      if (win.isVisible() && !win.isFocused()) {
        console.log('[输入条] 焦点未回来，收起');
        fadeOutAndHide(win);
      }
    }, BLUR_GRACE_MS);
  });

  win.on('focus', () => {
    if (blurTimer) {
      console.log('[输入条] 焦点回来了，取消收起');
      clearTimeout(blurTimer);
      blurTimer = null;
    }
  });

  return win;
}

/** 输入条最近一次被显示的时刻，用于过滤抢焦点途中的假 blur。 */
let lastShownAt = 0;

/** 焦点稳定期：这段时间内的 blur 一律忽略。 */
const FOCUS_SETTLE_MS = 800;

/** 失焦后等这么久再真正收起，其间焦点回来就取消。 */
const BLUR_GRACE_MS = 400;

/** 显示输入条前调用，开启焦点稳定期。 */
export function markInputShown(): void {
  lastShownAt = Date.now();
}

/**
 * 输入条窗口变高时，钉住的是上边还是下边。
 *
 * 贴着悬浮标弹出时，输入条就落在悬浮标正上方一点点的地方。
 * 这时若按老规矩往下长，展开提示词列表会一路盖过悬浮标、戳出屏幕底边，
 * 用户看到的是「列表只露出前两条」。所以那种摆法必须钉住下边往上长。
 * 居中弹出时上方空间足够，往下长即可。
 */
let inputGrowsUpward = false;

/** 输入条与悬浮标之间、以及与工作区边缘之间留的余量。 */
const INPUT_GAP = 10;

/**
 * 摆放输入条。
 *
 * 位置取决于怎么唤起的，传 anchor 就是「贴着它」：
 *
 * - **点悬浮标上的铅笔**（anchor = 悬浮标窗口）——手和视线都在悬浮标那儿，
 *   输入条要是飞到屏幕正中，等于让人横跨大半个屏幕去找自己刚点出来的东西。
 * - **按全局热键**（anchor = null）——这时鼠标可能在任何地方，没有可跟随的锚点，
 *   屏幕中间偏上是这类唤起式输入框的通用落点，眼睛找得最快。
 */
export function positionInputWindow(win: BrowserWindow, anchor?: BrowserWindow | null): void {
  if (!anchor || anchor.isDestroyed()) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    inputGrowsUpward = false;
    const x = Math.round(workArea.x + (workArea.width - INPUT_SIZE.width) / 2);
    const y = Math.round(workArea.y + workArea.height * 0.32);
    win.setPosition(x, y);
    console.log(`[输入条] 居中摆放 → ${x},${y}`);
    return;
  }

  const pet = anchor.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: pet.x, y: pet.y });
  const height = win.getBounds().height;

  // 水平：与悬浮标居中对齐，再夹回工作区内。悬浮标常年在右下角，
  // 不夹的话输入条有一大半会落到屏幕外面。
  let x = pet.x + pet.width / 2 - INPUT_SIZE.width / 2;
  x = Math.min(x, workArea.x + workArea.width - INPUT_SIZE.width - INPUT_GAP);
  x = Math.max(workArea.x + INPUT_GAP, x);

  // 垂直：优先放上方。悬浮标默认待在屏幕底部，下方基本放不开。
  const above = pet.y - INPUT_GAP - height;
  if (above >= workArea.y + INPUT_GAP) {
    inputGrowsUpward = true;
    win.setPosition(Math.round(x), Math.round(above));
    console.log(`[输入条] 贴悬浮标上方 → ${Math.round(x)},${Math.round(above)}（悬浮标 ${pet.x},${pet.y} ${pet.width}×${pet.height}）`);
    return;
  }

  inputGrowsUpward = false;
  const below = Math.max(
    workArea.y + INPUT_GAP,
    Math.min(pet.y + pet.height + INPUT_GAP, workArea.y + workArea.height - height - INPUT_GAP),
  );
  win.setPosition(Math.round(x), Math.round(below));
  console.log(`[输入条] 贴悬浮标下方 → ${Math.round(x)},${Math.round(below)}（悬浮标 ${pet.x},${pet.y} ${pet.width}×${pet.height}）`);
}

/**
 * 按渲染层算出的内容高度调整窗口，并按当前摆法钉住对应的那条边。
 *
 * 高度没变化时直接返回，不做任何事——每次按键都会触发一遍同步。
 *
 * 日志打的是**请求值**而不是事后回读的 getBounds()。系统缩放不是 100% 时，
 * 逻辑高度要先换算成物理像素再取整，回读值可能比请求值差 1px；
 * 拿回读值打日志会打出「133 → 133」这种看着像 bug 的行。
 */
export function resizeInputWindow(win: BrowserWindow, height: number): void {
  const bounds = win.getBounds();
  const next = Math.max(INPUT_MIN_HEIGHT, Math.min(Math.round(height), INPUT_MAX_HEIGHT));
  if (next === bounds.height) return;

  let y = bounds.y;
  if (inputGrowsUpward) {
    // 钉住下边：向上长，不去压下面的悬浮标。
    const { workArea } = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    y = Math.max(workArea.y + INPUT_GAP, bounds.y + bounds.height - next);
  }

  win.setBounds({ ...bounds, y, height: next }, false);
  const how = inputGrowsUpward ? `钉下边，y ${bounds.y} → ${y}` : '钉上边';
  console.log(`[输入条] 调整高度 ${bounds.height} → ${next}（${how}）`);
}
