/**
 * 桌宠角色：按状态挑主题里的文件播，外加眼睛跟随、睡眠序列、闲置小动作、
 * 拖动 / 单击 / 双击 / 连点的反应，以及按主题算出的精确点击区域。
 *
 * 只管容器里面画什么。容器摆在哪、多大、圆环怎么围着它，归 pet.css；
 * 什么时候换外观、状态从哪来、鼠标事件，归 pet.ts。
 *
 * 主题是 clawd-on-desk 的格式，文件名经主进程的 xfb-theme:// 协议取，
 * SVG 在那边已经消毒过；这里内联前再去一遍脚本和事件属性，两道保险。
 */

import {
  isBusyAgentState,
  petVisualState,
  pickThemeFile,
  resolveHitBox,
  type AgentsSnapshot,
  type PetPhase,
  type PetTheme,
  type SkinInfo,
  type SleepStage,
  type ThemeReaction,
  type ThemeViewBox,
} from '@xfb/shared';

export interface AvatarInput {
  phase: PetPhase;
  agents: AgentsSnapshot;
  hovering: boolean;
}

/** 窗口坐标（CSS 像素），和 hover.ts 的 HitRect 同形。 */
export interface AvatarRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Avatar {
  setSkin(skin: SkinInfo): void;
  update(input: AvatarInput): void;
  /** 光标在窗口内的坐标（可在窗口外）。 */
  lookAt(x: number, y: number): void;
  /** 单击。x 是窗口坐标，用来分左半边还是右半边。 */
  click(x: number): void;
  /** 双击：播一次 reactions.double。 */
  poke(): void;
  /** 拖动中：往哪边拖；null 表示松手了。 */
  setDragging(dir: 'left' | 'right' | 'none' | null): void;
  /** 角色身体实际占的那块（窗口坐标）。主题没写点击区域时是 null，由调用方退回整个本体。 */
  hitRect(): AvatarRect | null;
}

export interface AvatarOptions {
  /** 换图、换外观之后点击区域可能变了，调用方据此重报命中矩形。 */
  onLayoutChange?: () => void;
}

/** 这些 clawd 状态说明代理那边没在干活，不该压过悬浮标自己的状态。 */
const AGENT_RESTING = new Set(['idle', 'sleeping', 'yawning', 'dozing', 'collapsing', 'waking']);

/** 睡眠序列里「打瞌睡」和「倒下」各停多久。主题的 timings 里没有这两项，取 clawd 的观感。 */
const DOZE_MS = 8_000;
const COLLAPSE_MS = 1_500;

/** 眼睛最多偏多少（viewBox 单位，clawd 的约定是 3）；光标离多远时偏到最大。 */
const EYE_MAX = 3;
const EYE_FULL_DISTANCE = 240;

/** 角色占容器的比例。留一点边，免得脚和头顶贴着圆环。 */
const FILL = 0.94;
/** 有落脚点时，脚底踩在容器高度的这个位置。 */
const BASELINE_AT = 0.97;

/**
 * clawd 的 fileOffsets 是它自己窗口里的像素。按它的默认布局，角色高度约占一个
 * 200px 窗口的 58%；拿这个换算成 viewBox 单位，再乘我们这边的比例。
 */
const CLAWD_WINDOW_PX = 200;
const CLAWD_VISIBLE_RATIO = 0.58;

/** 连点多少下、在多长时间内算「不耐烦」。 */
const ANNOY_CLICKS = 4;
const ANNOY_WINDOW_MS = 2_000;

/** 内联前的第二道清理：主进程消毒过，这里只兜底最危险的几样。 */
function scrubSvg(root: Element): void {
  root.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'xlink:href') && value.startsWith('javascript:')) el.removeAttribute(attr.name);
    }
  }
}

/** 一张图按什么尺寸、摆在容器里的哪（容器坐标，像素）。点击区域也用它换算。 */
interface Placement {
  left: number;
  top: number;
  /** 每个 viewBox 单位多少像素。 */
  unit: number;
  vb: ThemeViewBox;
}

export function createAvatar(container: HTMLElement, options: AvatarOptions = {}): Avatar {
  let theme: PetTheme | null = null;
  let baseUrl = '';
  /** 每换一次主题加一，晚到的旧主题文件就不往上贴了。 */
  let generation = 0;

  let last: AvatarInput | null = null;
  let shownFile: string | null = null;
  let shownState: string | null = null;
  let placement: Placement | null = null;
  let eyes: SVGGraphicsElement | null = null;
  let body: SVGGraphicsElement | null = null;
  let shadow: SVGGraphicsElement | null = null;

  const svgCache = new Map<string, Promise<string | null>>();

  // ── 睡眠 ──
  let sleep: SleepStage = 'awake';
  let lastActivity = Date.now();
  let sleepTimer: number | null = null;

  // ── 临时盖在待机图上的东西：反应、闲置小动作 ──
  let overlay: { file: string; until: number; kind: 'reaction' | 'idle-anim' } | null = null;
  let overlayTimer: number | null = null;
  let idleAnimTimer: number | null = null;
  /** 这一段安静期里闲置小动作播过没有。clawd 也是每段安静期只播一次，不然像在抽搐。 */
  let idleAnimPlayed = false;
  let drag: 'left' | 'right' | 'none' | null = null;
  const clickTimes: number[] = [];

  function clearTimer(t: number | null): null {
    if (t !== null) window.clearTimeout(t);
    return null;
  }

  /** 只有真闲着（悬浮标 idle、代理也歇着、鼠标没压上来）才往睡眠走。 */
  function isQuiet(input: AvatarInput | null): boolean {
    if (!input || input.hovering || input.phase !== 'idle') return false;
    const v = input.agents.visual?.state;
    return !v || AGENT_RESTING.has(v);
  }

  function setSleep(next: SleepStage): void {
    if (sleep === next) return;
    sleep = next;
    render();
  }

  function scheduleSleep(): void {
    sleepTimer = clearTimer(sleepTimer);
    if (!theme || !isQuiet(last)) return;
    const t = theme.timings;
    const step = (stage: SleepStage, after: number, then?: () => void) => {
      sleepTimer = window.setTimeout(() => {
        sleepTimer = null;
        setSleep(stage);
        then?.();
      }, after);
    };
    if (sleep === 'awake' || sleep === 'waking') {
      const wait = Math.max(0, lastActivity + t.mouseSleepTimeoutMs - Date.now());
      if (theme.sleepMode === 'direct') {
        step('sleeping', wait);
        return;
      }
      step('yawning', wait, () =>
        step('dozing', t.yawnDurationMs, () => step('collapsing', DOZE_MS, () => step('sleeping', COLLAPSE_MS))),
      );
    }
  }

  /** 安静一阵子就随机播一个闲置小动作，播完回到待机。 */
  function scheduleIdleAnim(): void {
    idleAnimTimer = clearTimer(idleAnimTimer);
    const pool = theme?.idleAnimations ?? [];
    if (!theme || !pool.length || idleAnimPlayed || sleep !== 'awake' || !isQuiet(last)) return;
    const wait = Math.max(0, lastActivity + (theme.mouseIdleTimeoutMs ?? 20_000) - Date.now());
    idleAnimTimer = window.setTimeout(() => {
      idleAnimTimer = null;
      if (!isQuiet(last) || sleep !== 'awake') return;
      const pick = pool[Math.floor(Math.random() * pool.length)]!;
      idleAnimPlayed = true;
      showOverlay(pick.file, pick.durationMs, 'idle-anim');
    }, wait);
  }

  /** 有动静了：睡着的醒过来（播 waking），醒着的重新计时；闲置小动作也重新算一段。 */
  function activity(): void {
    lastActivity = Date.now();
    idleAnimPlayed = false;
    if (overlay?.kind === 'idle-anim') {
      // 动一下鼠标就打断闲置小动作，回到待机——它本来就是「没人理我」时的表演。
      overlay = null;
      overlayTimer = clearTimer(overlayTimer);
      render();
    }
    if (sleep !== 'awake' && sleep !== 'waking') {
      sleepTimer = clearTimer(sleepTimer);
      setSleep('waking');
      sleepTimer = window.setTimeout(() => {
        sleepTimer = null;
        setSleep('awake');
        scheduleSleep();
        scheduleIdleAnim();
      }, theme?.timings.wakeDurationMs ?? 1_500);
      return;
    }
    if (sleep === 'awake') {
      scheduleSleep();
      scheduleIdleAnim();
    }
  }

  function showOverlay(file: string, durationMs: number, kind: 'reaction' | 'idle-anim'): void {
    overlay = { file, until: Date.now() + durationMs, kind };
    overlayTimer = clearTimer(overlayTimer);
    overlayTimer = window.setTimeout(() => {
      overlayTimer = null;
      overlay = null;
      render();
    }, durationMs);
    render();
  }

  function playReaction(r: ThemeReaction | null | undefined): void {
    if (!r) return;
    const file = r.files[Math.floor(Math.random() * r.files.length)]!;
    showOverlay(file, r.durationMs, 'reaction');
  }

  // ── 画 ──

  /**
   * 一张图在容器里怎么摆，照 clawd 的规则：
   *
   *   - 按角色那一块（frame = layout.contentBox）缩放到填满容器；
   *   - 主题给了落脚点（centerX / baselineY）就让角色水平居中、脚踩在容器底部，
   *     不同动作的图换来换去时脚底不跳；没给就按 frame 居中；
   *   - 再叠上这张图自己的 fileScales / fileOffsets / fileViewBoxes。
   *
   * frame 之外的部分（抛起来的球、气泡）照样画，只是溢出容器——容器不裁剪。
   */
  function computePlacement(file: string): Placement | null {
    if (!theme) return null;
    const vb = theme.fileViewBoxes?.[file] ?? theme.viewBox;
    const frame = theme.frame ?? vb;
    const w = container.clientWidth || 96;
    const h = container.clientHeight || 96;
    const fit = Math.min((w * FILL) / frame.width, (h * FILL) / frame.height);
    const unit = fit * (theme.fileScales?.[file] ?? 1);

    let left: number;
    let top: number;
    if (theme.anchor) {
      left = w / 2 - (theme.anchor.centerX - vb.x) * unit;
      top = h * BASELINE_AT - (theme.anchor.baselineY - vb.y) * unit;
    } else {
      left = (w - frame.width * fit) / 2 - (frame.x - vb.x) * unit;
      top = (h - frame.height * fit) / 2 - (frame.y - vb.y) * unit;
    }

    const offset = theme.fileOffsets?.[file];
    if (offset) {
      const clawdUnit = (CLAWD_WINDOW_PX * CLAWD_VISIBLE_RATIO) / frame.height;
      const k = unit / clawdUnit;
      left += offset.x * k;
      // clawd 的 y 偏移是从底边往上量的，换到 top 要反过来。
      top -= offset.y * k;
    }
    return { left, top, unit, vb };
  }

  function placeArt(el: HTMLElement | SVGElement, p: Placement): void {
    Object.assign(el.style, {
      position: 'absolute',
      left: `${p.left.toFixed(1)}px`,
      top: `${p.top.toFixed(1)}px`,
      width: `${(p.vb.width * p.unit).toFixed(1)}px`,
      height: `${(p.vb.height * p.unit).toFixed(1)}px`,
      maxWidth: 'none',
      overflow: 'visible',
    });
  }

  function fetchSvg(url: string): Promise<string | null> {
    let p = svgCache.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.text() : null))
        .catch(() => null);
      svgCache.set(url, p);
    }
    return p;
  }

  async function show(file: string): Promise<void> {
    const gen = generation;
    const url = baseUrl + encodeURI(file);
    const p = computePlacement(file);
    if (!p) return;
    if (/\.svg$/i.test(file)) {
      const text = await fetchSvg(url);
      if (gen !== generation || shownFile !== file) return;
      if (!text) {
        console.warn(`[桌宠] 读不到 ${file}`);
        return;
      }
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc.documentElement;
      if (svg.nodeName.toLowerCase() !== 'svg') {
        console.warn(`[桌宠] ${file} 不是合法的 SVG`);
        return;
      }
      scrubSvg(svg);
      const node = document.importNode(svg, true) as unknown as SVGSVGElement;
      // 文件里自带的 width/height（常见 500×500）不要了，尺寸由 computePlacement 算。
      node.removeAttribute('width');
      node.removeAttribute('height');
      if (!node.hasAttribute('viewBox')) {
        node.setAttribute('viewBox', `${p.vb.x} ${p.vb.y} ${p.vb.width} ${p.vb.height}`);
      }
      node.classList.add('avatar-art');
      placeArt(node, p);
      container.replaceChildren(node);
      const pick = (id: string | null) =>
        id ? (node.querySelector(`#${CSS.escape(id)}`) as SVGGraphicsElement | null) : null;
      eyes = theme ? pick(theme.eyeTracking.eyesId) : null;
      body = theme ? pick(theme.eyeTracking.bodyId) : null;
      shadow = theme ? pick(theme.eyeTracking.shadowId) : null;
      for (const el of [eyes, body, shadow]) {
        if (el) el.style.transition = 'transform 140ms linear';
      }
    } else {
      const img = document.createElement('img');
      img.className = 'avatar-art';
      img.alt = '';
      img.draggable = false;
      img.src = url;
      placeArt(img, p);
      eyes = body = shadow = null;
      container.replaceChildren(img);
    }
    placement = p;
    options.onLayoutChange?.();
  }

  function render(): void {
    if (!theme || !last) return;
    const busy = last.agents.sessions.filter((s) => isBusyAgentState(s.state)).length;
    const subagents = last.agents.sessions.filter((s) => s.state === 'juggling').length;
    const agentState = last.agents.visual?.state;

    const wanted = petVisualState({
      phase: last.phase,
      agents: { states: agentState && !AGENT_RESTING.has(agentState) ? [agentState] : [], subagents },
      sleep,
    });

    let { state, file } = pickThemeFile(theme, wanted, { sessions: busy, subagents });

    /*
      临时的图盖在哪些状态上：
        - 拖动反应：除了「要你批权限 / 出错」，什么状态都盖——被拎起来就该有被拎起来的样子；
        - 单击、双击、闲置小动作：只盖待机，正在干活时戳它不该打断它的动作。
    */
    const dragFile =
      drag !== null && theme.dragReaction
        ? (drag === 'left' ? theme.dragReaction.fileLeft : drag === 'right' ? theme.dragReaction.fileRight : null) ??
          theme.dragReaction.file
        : null;
    if (dragFile && state !== 'notification' && state !== 'error') {
      file = dragFile;
      state = 'drag';
    } else if (overlay && Date.now() < overlay.until && state === 'idle') {
      file = overlay.file;
      state = overlay.kind;
    }

    container.dataset['state'] = state;
    shownState = state;
    if (file === shownFile) return;
    shownFile = file;
    void show(file);
  }

  return {
    setSkin(skin) {
      generation++;
      sleepTimer = clearTimer(sleepTimer);
      overlayTimer = clearTimer(overlayTimer);
      idleAnimTimer = clearTimer(idleAnimTimer);
      sleep = 'awake';
      overlay = null;
      idleAnimPlayed = false;
      drag = null;
      shownFile = shownState = null;
      placement = null;
      eyes = body = shadow = null;
      svgCache.clear();
      container.replaceChildren();
      if (skin.skin !== 'avatar') {
        theme = null;
        baseUrl = '';
        options.onLayoutChange?.();
        return;
      }
      theme = skin.theme;
      baseUrl = skin.baseUrl;
      lastActivity = Date.now();
      render();
      scheduleSleep();
      scheduleIdleAnim();
    },

    update(input) {
      const wasQuiet = isQuiet(last);
      last = input;
      if (input.hovering || !isQuiet(input)) activity();
      else if (!wasQuiet) {
        scheduleSleep();
        scheduleIdleAnim();
      }
      render();
    },

    lookAt(x, y) {
      activity();
      if (!theme?.eyeTracking.enabled || !eyes || !shownState) return;
      if (!theme.eyeTracking.states.includes(shownState)) {
        eyes.style.transform = '';
        if (body) body.style.transform = '';
        if (shadow) shadow.style.transform = '';
        return;
      }
      const r = container.getBoundingClientRect();
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return;
      const k = (Math.min(1, dist / EYE_FULL_DISTANCE) * EYE_MAX) / dist;
      const ex = dx * k;
      const ey = dy * k;
      // SVG 元素上的 CSS transform 用的是用户坐标，px 在这里就是 viewBox 单位。
      eyes.style.transform = `translate(${ex.toFixed(2)}px, ${ey.toFixed(2)}px)`;
      if (body) body.style.transform = `translate(${(ex / 3).toFixed(2)}px, ${(ey / 3).toFixed(2)}px)`;
      if (shadow) shadow.style.transform = `translate(${(ex / 6).toFixed(2)}px, 0px)`;
    },

    click(x) {
      activity();
      if (!theme) return;
      const now = Date.now();
      clickTimes.push(now);
      while (clickTimes.length && now - clickTimes[0]! > ANNOY_WINDOW_MS) clickTimes.shift();
      if (clickTimes.length >= ANNOY_CLICKS && theme.annoyedReaction) {
        clickTimes.length = 0;
        playReaction(theme.annoyedReaction);
        return;
      }
      const r = container.getBoundingClientRect();
      const side = x < r.left + r.width / 2 ? 'left' : 'right';
      const clicks = theme.clickReactions;
      playReaction(side === 'left' ? (clicks?.left ?? clicks?.right) : (clicks?.right ?? clicks?.left));
    },

    poke() {
      activity();
      playReaction(theme?.reactions.double ?? theme?.reactions.click);
    },

    setDragging(dir) {
      if (drag === dir) return;
      drag = dir;
      activity();
      render();
    },

    hitRect() {
      if (!theme || !placement || !shownFile) return null;
      const hb = resolveHitBox(theme, shownFile);
      if (!hb) return null;
      const c = container.getBoundingClientRect();
      const { left, top, unit, vb } = placement;
      return {
        left: c.left + left + (hb.x - vb.x) * unit,
        top: c.top + top + (hb.y - vb.y) * unit,
        width: hb.w * unit,
        height: hb.h * unit,
      };
    },
  };
}
