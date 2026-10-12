/**
 * 桌宠主题：读 clawd-on-desk 的 `theme.json`，决定此刻该播哪个文件。
 *
 * 只认 clawd 格式的一个子集——够悬浮标用的那部分。迷你模式、音效、
 * 闲置动画池、逐文件缩放这些先不认，遇到了也不报错，原样忽略。
 *
 * 素材本身不随仓库分发（clawd 的角色画不在 AGPL 授权范围内），
 * 用户自己把主题目录放进 userData/themes/。这里只管解析和挑文件，
 * 不碰文件系统，所以能在主进程和渲染层两边用，也好测。
 */

import type { PetPhase } from './state.js';

export interface ThemeViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ThemeHitBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一个状态在 theme.json 里的三种写法，解析后统一成这个形状。 */
export interface ThemeStateEntry {
  files: string[];
  fallbackTo: string | null;
}

export interface ThemeReaction {
  files: string[];
  durationMs: number;
}

export interface ThemeTier {
  min: number;
  file: string;
}

export interface PetTheme {
  name: string;
  version: string;
  viewBox: ThemeViewBox;
  /**
   * 角色实际占的那块（viewBox 单位）。
   *
   * clawd 的不少主题画布比角色大得多（四周留着给道具、特效的空），
   * 直接按 viewBox 铺满容器，角色只剩中间一小点。取 layout.contentBox（角色本身），
   * 没有就取 layout.marginBox（角色加一圈留白）；都没写就是 null，按整个 viewBox 铺。
   */
  frame: ThemeViewBox | null;
  states: Record<string, ThemeStateEntry>;
  eyeTracking: {
    enabled: boolean;
    states: string[];
    eyesId: string;
    bodyId: string | null;
    shadowId: string | null;
  };
  sleepMode: 'full' | 'direct';
  timings: {
    mouseSleepTimeoutMs: number;
    yawnDurationMs: number;
    wakeDurationMs: number;
  };
  reactions: {
    double: ThemeReaction | null;
    click: ThemeReaction | null;
  };
  /** 按会话数挑 working 的文件，已按 min 从大到小排好。 */
  workingTiers: ThemeTier[];
  /** 按子代理数挑 juggling 的文件，同上。 */
  jugglingTiers: ThemeTier[];
  hitBoxes: {
    default: ThemeHitBox | null;
    sleeping: ThemeHitBox | null;
  };

  /*
    以下是 clawd 主题的进阶字段。parseTheme 一定会填上；写成可选，
    是为了手搓的测试主题和老代码不必每个都补齐——缺了就当主题不支持这一项。
  */

  /** 落脚点：角色的水平中心和脚底基线（viewBox 单位）。有它就按「脚踩在容器底部」摆，没有就按 frame 居中。 */
  anchor?: { centerX: number; baselineY: number } | null;
  /** 个别文件自带不同的画布。 */
  fileViewBoxes?: Record<string, ThemeViewBox>;
  /** 个别文件要额外放大缩小（objectScale.fileScales）。 */
  fileScales?: Record<string, number>;
  /** 个别文件要额外挪一点（objectScale.fileOffsets，clawd 窗口里的像素）。 */
  fileOffsets?: Record<string, { x: number; y: number }>;
  /** 闲着时偶尔播一下的小动作。 */
  idleAnimations?: Array<{ file: string; durationMs: number }>;
  /** 鼠标多久没动开始播闲置小动作。 */
  mouseIdleTimeoutMs?: number;
  /** 拖动时播的图；往左、往右可以各有一张。 */
  dragReaction?: { file: string; fileLeft: string | null; fileRight: string | null } | null;
  /** 点角色左半边 / 右半边的反应。 */
  clickReactions?: { left: ThemeReaction | null; right: ThemeReaction | null };
  /** 连点好几下之后的「不耐烦」。 */
  annoyedReaction?: ThemeReaction | null;
  /** 精确点击区域的取用规则，和 clawd 的 state-hitbox-resolver 一致。 */
  hitBoxRules?: {
    wide: ThemeHitBox | null;
    files: Record<string, ThemeHitBox>;
    wideFiles: string[];
    sleepingFiles: string[];
  };
}

/** clawd 的默认值。主题不写就用这些。 */
const DEFAULT_TIMINGS = {
  mouseSleepTimeoutMs: 60_000,
  yawnDurationMs: 3_000,
  wakeDurationMs: 1_500,
};

const DEFAULT_REACTION_MS = 2_500;

export class ThemeError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function strList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v] : [];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

/**
 * 文件名只许是主题目录里的相对路径。
 *
 * theme.json 是用户从别处拿来的，不能让它借 `../` 或绝对路径
 * 读到主题目录以外的东西。主进程提供文件时还会再查一遍，这里先挡一道。
 */
export function isSafeThemeFile(file: string): boolean {
  if (!file || file.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(file) || file.startsWith('/') || file.startsWith('\\')) return false;
  return !file.split(/[\\/]/).some((seg) => seg === '..');
}

function parseStateEntry(v: unknown): ThemeStateEntry | null {
  if (typeof v === 'string' || Array.isArray(v)) {
    const files = strList(v).filter(isSafeThemeFile);
    return files.length ? { files, fallbackTo: null } : null;
  }
  if (!isObject(v)) return null;
  const files = strList(v.files ?? v.file).filter(isSafeThemeFile);
  const fallbackTo = str(v.fallbackTo);
  if (!files.length && !fallbackTo) return null;
  return { files, fallbackTo };
}

function parseReaction(v: unknown): ThemeReaction | null {
  if (!isObject(v)) return null;
  const files = strList(v.files ?? v.file).filter(isSafeThemeFile);
  if (!files.length) return null;
  return { files, durationMs: num(v.duration, DEFAULT_REACTION_MS) };
}

function parseTiers(v: unknown, key: 'minSessions' | 'minSubagents'): ThemeTier[] {
  if (!Array.isArray(v)) return [];
  const tiers: ThemeTier[] = [];
  for (const t of v) {
    if (!isObject(t)) continue;
    const file = str(t.file);
    if (!file || !isSafeThemeFile(file)) continue;
    tiers.push({ min: num(t[key] ?? t.minSessions ?? t.min, 1), file });
  }
  return tiers.sort((a, b) => b.min - a.min);
}

/** 把 { 文件名: 值 } 逐项解析，解析不了的、文件名不安全的丢掉。 */
function mapValues<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObject(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (!isSafeThemeFile(k)) continue;
    const parsed = parse(x);
    if (parsed !== null) out[k] = parsed;
  }
  return out;
}

function parseDrag(v: unknown): PetTheme['dragReaction'] {
  if (!isObject(v)) return null;
  const safe = (x: unknown) => {
    const f = str(x);
    return f && isSafeThemeFile(f) ? f : null;
  };
  const file = safe(v.file) ?? safe(v.fileLeft) ?? safe(v.fileRight);
  return file ? { file, fileLeft: safe(v.fileLeft), fileRight: safe(v.fileRight) } : null;
}

function parseBox(v: unknown): ThemeViewBox | null {
  if (!isObject(v)) return null;
  const box = { x: num(v.x, NaN), y: num(v.y, NaN), width: num(v.width, NaN), height: num(v.height, NaN) };
  return Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0 ? box : null;
}

function parseHitBox(v: unknown): ThemeHitBox | null {
  if (!isObject(v)) return null;
  const box = { x: num(v.x, NaN), y: num(v.y, NaN), w: num(v.w, NaN), h: num(v.h, NaN) };
  return Object.values(box).every(Number.isFinite) && box.w > 0 && box.h > 0 ? box : null;
}

/** 解析 theme.json 的内容。缺了必需字段就抛 ThemeError，说清楚缺什么。 */
export function parseTheme(raw: unknown): PetTheme {
  if (!isObject(raw)) throw new ThemeError('theme.json 不是一个对象');

  const vb = raw.viewBox;
  if (!isObject(vb)) throw new ThemeError('缺少 viewBox');
  const viewBox = {
    x: num(vb.x, 0),
    y: num(vb.y, 0),
    width: num(vb.width, 0),
    height: num(vb.height, 0),
  };
  if (viewBox.width <= 0 || viewBox.height <= 0) throw new ThemeError('viewBox 的宽高必须大于 0');

  if (!isObject(raw.states)) throw new ThemeError('缺少 states');
  const states: Record<string, ThemeStateEntry> = {};
  for (const [name, entry] of Object.entries(raw.states)) {
    const parsed = parseStateEntry(entry);
    if (parsed) states[name] = parsed;
  }
  if (!states.idle?.files.length) throw new ThemeError('states.idle 至少要有一个文件');

  const layout = isObject(raw.layout) ? raw.layout : {};
  const objectScale = isObject(raw.objectScale) ? raw.objectScale : {};
  const frame = parseBox(layout.contentBox) ?? parseBox(layout.marginBox);

  const eye = isObject(raw.eyeTracking) ? raw.eyeTracking : {};
  const ids = isObject(eye.ids) ? eye.ids : {};
  const timings = isObject(raw.timings) ? raw.timings : {};
  const reactions = isObject(raw.reactions) ? raw.reactions : {};
  const hit = isObject(raw.hitBoxes) ? raw.hitBoxes : {};
  const sleep = isObject(raw.sleepSequence) ? raw.sleepSequence : {};

  return {
    name: str(raw.name) ?? '未命名主题',
    version: str(raw.version) ?? '0.0.0',
    viewBox,
    frame,
    states,
    eyeTracking: {
      enabled: eye.enabled === true,
      states: eye.states === undefined ? ['idle'] : strList(eye.states),
      eyesId: str(ids.eyes) ?? 'eyes-js',
      bodyId: str(ids.body),
      shadowId: str(ids.shadow),
    },
    sleepMode: sleep.mode === 'direct' ? 'direct' : 'full',
    timings: {
      mouseSleepTimeoutMs: num(timings.mouseSleepTimeout, DEFAULT_TIMINGS.mouseSleepTimeoutMs),
      yawnDurationMs: num(timings.yawnDuration, DEFAULT_TIMINGS.yawnDurationMs),
      wakeDurationMs: num(timings.wakeDuration, DEFAULT_TIMINGS.wakeDurationMs),
    },
    reactions: {
      double: parseReaction(reactions.double),
      click: parseReaction(reactions.clickLeft ?? reactions.clickRight),
    },
    workingTiers: parseTiers(raw.workingTiers, 'minSessions'),
    jugglingTiers: parseTiers(raw.jugglingTiers, 'minSubagents'),
    hitBoxes: {
      default: parseHitBox(hit.default),
      sleeping: parseHitBox(hit.sleeping),
    },
    anchor:
      typeof layout.centerX === 'number' && typeof layout.baselineY === 'number' && frame
        ? { centerX: layout.centerX, baselineY: layout.baselineY }
        : null,
    fileViewBoxes: mapValues(raw.fileViewBoxes, parseBox),
    fileScales: mapValues(objectScale.fileScales, (v) => (typeof v === 'number' && v > 0 ? v : null)),
    fileOffsets: mapValues(objectScale.fileOffsets, (v) =>
      isObject(v) ? { x: num(v.x, 0), y: num(v.y, 0) } : null,
    ),
    idleAnimations: (Array.isArray(raw.idleAnimations) ? raw.idleAnimations : [])
      .map((a) => (isObject(a) ? { file: str(a.file), durationMs: num(a.duration, 6_000) } : null))
      .filter((a): a is { file: string; durationMs: number } => !!a && !!a.file && isSafeThemeFile(a.file)),
    mouseIdleTimeoutMs: num(timings.mouseIdleTimeout, 20_000),
    dragReaction: parseDrag(reactions.drag),
    clickReactions: { left: parseReaction(reactions.clickLeft), right: parseReaction(reactions.clickRight) },
    annoyedReaction: parseReaction(reactions.annoyed),
    hitBoxRules: {
      wide: parseHitBox(hit.wide),
      files: mapValues(raw.fileHitBoxes, parseHitBox),
      wideFiles: strList(raw.wideHitboxFiles),
      sleepingFiles: strList(raw.sleepingHitboxFiles),
    },
  };
}

/**
 * 各状态缺席时往哪落。
 *
 * 主题可以只画最少的几张，没画的状态顺着这条链找到一个画了的。
 * 主题自己写的 fallbackTo 优先于这张表。
 */
const IMPLICIT_FALLBACK: Record<string, string> = {
  yawning: 'sleeping',
  dozing: 'sleeping',
  collapsing: 'sleeping',
  waking: 'idle',
  sleeping: 'idle',
  juggling: 'working',
  sweeping: 'working',
  carrying: 'working',
  building: 'working',
  error: 'notification',
  notification: 'attention',
  attention: 'idle',
  happy: 'attention',
  thinking: 'working',
  working: 'idle',
};

/**
 * 把想要的状态解析成一个真有文件的状态名。
 *
 * 顺着 fallbackTo 走，最后兜到 idle（parseTheme 保证它有文件）。
 * 主题里写成环（a→b→a）也不会卡死，走过的不再走。
 */
export function resolveThemeState(theme: PetTheme, wanted: string): string {
  const seen = new Set<string>();
  let cur: string | null = wanted;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const entry: ThemeStateEntry | undefined = theme.states[cur];
    if (entry?.files.length) return cur;
    cur = entry?.fallbackTo ?? IMPLICIT_FALLBACK[cur] ?? null;
  }
  return 'idle';
}

/** 挑这个状态该播的文件。working/juggling 先看分档。 */
export function pickThemeFile(
  theme: PetTheme,
  wanted: string,
  counts: { sessions?: number; subagents?: number } = {},
): { state: string; file: string } {
  if (wanted === 'working' && theme.workingTiers.length && (counts.sessions ?? 0) > 0) {
    const tier = theme.workingTiers.find((t) => (counts.sessions ?? 0) >= t.min);
    if (tier) return { state: 'working', file: tier.file };
  }
  if (wanted === 'juggling' && theme.jugglingTiers.length && (counts.subagents ?? 0) > 0) {
    const tier = theme.jugglingTiers.find((t) => (counts.subagents ?? 0) >= t.min);
    if (tier) return { state: 'juggling', file: tier.file };
  }
  const state = resolveThemeState(theme, wanted);
  // resolveThemeState 只会返回有文件的状态，所以这里一定取得到。
  return { state, file: theme.states[state]!.files[0]! };
}

/**
 * 编码代理那一路送进来的摘要。
 *
 * `states` 是每个活着的会话各自的 clawd 状态名（thinking/working/juggling/…），
 * 由代理监听层算好；这里只管合成。
 */
export interface AgentVisualInput {
  states: string[];
  subagents: number;
}

/** clawd 多会话合并时的优先级，越靠前越压得住。 */
const AGENT_PRIORITY = [
  'error',
  'notification',
  'juggling',
  'working',
  'carrying',
  'sweeping',
  'thinking',
  'attention',
] as const;

/** 睡眠序列走到哪了。由渲染层按时间推进，这里只负责翻译成状态名。 */
export type SleepStage = 'awake' | 'yawning' | 'dozing' | 'collapsing' | 'sleeping' | 'waking';

/**
 * 把悬浮标自己的状态、代理状态、睡眠进度合成一个主题状态名。
 *
 * 优先级：要人处理的（权限/出错）> 代理在干活 > 网页 AI 在生成 > 完成 > 睡眠 > 待机。
 * 两路都在忙时代理优先——它干的活更长，而网页那一路还有外圈圆环在表示。
 */
export function petVisualState(input: {
  phase: PetPhase;
  agents: AgentVisualInput;
  sleep: SleepStage;
}): string {
  const { phase, agents, sleep } = input;

  if (agents.states.includes('notification')) return 'notification';
  if (phase === 'error' || agents.states.includes('error')) return 'error';

  if (agents.subagents > 0 && agents.states.some((s) => s === 'working' || s === 'juggling')) {
    return 'juggling';
  }
  for (const s of AGENT_PRIORITY) {
    if (s === 'error' || s === 'notification' || s === 'attention') continue;
    if (agents.states.includes(s)) return s;
  }

  if (phase === 'sending' || phase === 'thinking') return 'thinking';
  if (phase === 'done' || agents.states.includes('attention')) return 'attention';

  if (sleep !== 'awake') return sleep;
  return 'idle';
}

/**
 * 主进程告诉渲染层「现在是什么外观」。
 *
 * baseUrl 是 `xfb-theme://<id>/`，主题里的文件名直接拼在后面；
 * 主进程那一侧会把路径钉死在主题的 assets 目录里，SVG 也已经消毒过。
 */
export type SkinInfo =
  | { skin: 'capsule' }
  | { skin: 'avatar'; id: string; theme: PetTheme; baseUrl: string };

/**
 * 这张图该用哪个点击区域（viewBox 单位）。规则照 clawd：
 * 单独指定的文件 > 睡觉类文件用 sleeping > 宽图用 wide > default。
 */
export function resolveHitBox(theme: PetTheme, file: string | null): ThemeHitBox | null {
  const rules = theme.hitBoxRules;
  if (file && rules?.files[file]) return rules.files[file]!;
  if (file && rules?.sleepingFiles.includes(file) && theme.hitBoxes.sleeping) return theme.hitBoxes.sleeping;
  if (file && rules?.wideFiles.includes(file) && rules.wide) return rules.wide;
  return theme.hitBoxes.default;
}
