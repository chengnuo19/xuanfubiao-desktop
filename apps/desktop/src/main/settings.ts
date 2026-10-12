/**
 * 应用设置的统一读写。
 *
 * 存在 userData/settings.json。刻意不把桥接密钥并进来——
 * 那是凭据，单独放一个文件更清楚，也避免备份设置时顺手泄露。
 */

import { app, screen } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 「取回答案」的三档。
 *
 * 之所以不是一个简单的开关，是因为**写剪贴板本身是有副作用的**，
 * 而这个副作用属于那种当场没感觉、事后才骂人的类型：
 * 你复制了一段报错发出去，转头想把它贴进 issue，
 * 剪贴板已经变成 AI 的回答了，原来那段再也找不回来。
 *
 * 中间那档就是为这件事留的——想试试这个功能的人可以零副作用地用起来。
 */
export type AnswerCapture =
  /** 关。只看进度，不读对话内容。默认。 */
  | 'off'
  /** 取回来存进回答历史，不碰剪贴板。 */
  | 'store'
  /** 取回来并放进剪贴板，绿环亮起时直接 Ctrl+V。 */
  | 'clipboard';

export type BasketRetentionDays = 0 | 1 | 7 | 30;
export type BasketCapacityMb = 0 | 100 | 500 | 1024 | 5120;
export type BasketShakeSensitivity = 'low' | 'medium' | 'high';

export interface Settings {
  /** 悬浮标上次被拖到的位置。 */
  petPosition?: { x: number; y: number };
  /** 是否开机自启。默认关闭，由用户主动打开。 */
  launchAtLogin?: boolean;
  /**
   * 送达与完成时的庆祝动画。默认开。
   *
   * 给开关是因为这是个天天在用的常驻工具：同一段动画看第一百遍时，
   * 当初的惊喜会变成每次发消息都要等它演完的负担。
   */
  celebrations?: boolean;
  /**
   * 生成结束后要不要把回答正文取回来。默认关。
   *
   * 默认关有三个理由，每个都单独成立：
   *
   * 1. 上面说的剪贴板副作用，不该让人第一次用就撞上。
   * 2. 这是**读对话正文**，比原先只读按钮状态是性质上的变化。
   *    一个常驻后台、能看见你全部对话的东西，这种升级必须用户自己点头，
   *    不能装完就默默开始读。
   * 3. 取回成功率因目标而异（见 canCaptureAnswer），默认开会让一部分人
   *    以为程序坏了。
   */
  answerCapture?: AnswerCapture;
  /**
   * 允许本机其它程序通过 HTTP 接口借用已登录的 AI 客户端。默认关。
   *
   * 关着的时候端口根本不监听——不是监听了再拒绝。
   * 对一个能驱动你账号发消息的接口来说，这个区别值得写在这里。
   */
  localApi?: boolean;
  /** 临时篮子自动清理期限；0 表示关闭。 */
  basketRetentionDays?: BasketRetentionDays;
  /** 临时篮子容量上限；0 表示不限制。达到上限时拒绝新内容，不自动删除旧内容。 */
  basketCapacityMb?: BasketCapacityMb;
  /** 从篮子拖出到别处后，把这一项移出篮子（可撤销）。默认关：多数人把篮子当中转站反复取用。 */
  basketRemoveOnDragOut?: boolean;
  /** 是否启用拖动内容时摇晃鼠标唤出临时篮子。默认开。 */
  basketShakeEnabled?: boolean;
  /** 临时篮子摇动手势灵敏度：'low' 迟钝（防误触）、'medium' 适中（默认）、'high' 灵敏。 */
  basketShakeSensitivity?: BasketShakeSensitivity;
  /** 全屏应用或游戏运行时静音摇动手势。默认开。 */
  basketSuppressInFullscreen?: boolean;
  /**
   * 回答生成完时发一条系统通知。默认关。
   *
   * 绿环只在视线落在右下角时才有用；切去干别的事了就会错过。
   * 但通知是打扰，天天在用的工具不该默认弹，所以由用户自己打开。
   */
  notifyOnDone?: boolean;
  /**
   * 监听编码代理（Claude Code、Codex、agy……）。默认开。
   *
   * 接收端是从 clawd-on-desk 移植来的，沿用它的端口段和 ~/.clawd/runtime.json，
   * 所以悬浮标是来**取代** clawd 的：发现 clawd 正在运行就不开端口，只提示。
   * 端口只监听 127.0.0.1，拒绝带 Origin 的请求，网页够不着。
   */
  agentWatch?: boolean;
  /** 代理会话面板常驻显示。默认关：鼠标压到悬浮标上才亮出来，移开自己收起。 */
  agentSessionsPinned?: boolean;
  /**
   * 桌宠外观：userData/themes 下的主题目录名，或 'capsule'（经典胶囊）。
   * 不设就用默认的 clawd 主题（本机没装 clawd 时是胶囊）；主题被删了也不报错，启动时自动退回。
   */
  petSkin?: string;
  /**
   * 各编码代理的开关，形状和 clawd-on-desk 设置里的 `agents` 一样：
   * `{ "claude-code": { enabled, permissionsEnabled, integrationInstalled, … } }`。
   * 第一次启动时从 clawd 的设置里搬过来（见 index.ts 的 loadAgentGates），之后以这里为准。
   */
  clawdAgents?: Record<string, Record<string, unknown>>;
}

const DEFAULTS: Settings = {
  celebrations: true,
  answerCapture: 'off',
  localApi: false,
  basketRetentionDays: 0,
  basketCapacityMb: 1024,
  basketRemoveOnDragOut: false,
  basketShakeEnabled: true,
  basketShakeSensitivity: 'medium',
  basketSuppressInFullscreen: true,
  notifyOnDone: false,
  agentWatch: true,
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

let cache: Settings | null = null;

export function readSettings(): Settings {
  if (cache) return cache;
  const file = settingsPath();
  if (!existsSync(file)) {
    cache = { ...DEFAULTS };
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    cache = { ...DEFAULTS, ...parsed };
  } catch (err) {
    // 文件被改坏了不能让应用起不来，退回默认值继续跑。
    console.warn('[设置] 解析失败，改用默认值：', err);
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function patchSettings(patch: Partial<Settings>): void {
  const next = { ...readSettings(), ...patch };
  cache = next;
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[设置] 写入失败：', err);
  }
}

/**
 * 校验保存的位置现在是否还看得见。
 *
 * 换显示器、改分辨率、拔掉副屏之后，旧坐标可能落在任何屏幕之外。
 * 不校验就会出现「程序在跑但窗口找不到」这种最难自查的故障。
 * 只要窗口左上角落在某块屏幕的工作区内就算可见——不要求完全包含，
 * 否则贴边摆放的窗口会被误判。
 */
export function isPositionVisible(pos: { x: number; y: number }): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    return (
      pos.x >= workArea.x &&
      pos.y >= workArea.y &&
      pos.x < workArea.x + workArea.width &&
      pos.y < workArea.y + workArea.height
    );
  });
}

/** 取可用的悬浮标位置；没存过或已不可见则返回 null，由调用方退回默认位置。 */
export function readPetPosition(): { x: number; y: number } | null {
  const pos = readSettings().petPosition;
  if (!pos) return null;
  if (!isPositionVisible(pos)) {
    console.warn('[设置] 保存的位置已不在任何屏幕内，退回默认位置');
    return null;
  }
  return pos;
}

/** 位置落盘。拖拽会连续触发 moved，调用方需自行去抖。 */
export function savePetPosition(pos: { x: number; y: number }): void {
  patchSettings({ petPosition: pos });
}

/**
 * 设置开机自启，并记进配置。
 *
 * dev 模式下不真的去动注册表：那样注册进去的是 electron.exe 加一串参数，
 * 开机根本起不来，还会在用户的启动项里留一条脏数据。
 */
export function setLaunchAtLogin(enabled: boolean): void {
  patchSettings({ launchAtLogin: enabled });
  if (!app.isPackaged) {
    console.log(`[设置] 开机自启已记为 ${enabled}（开发模式下不写入系统启动项）`);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/**
 * 启动时把系统实际状态与配置对齐。
 * 用户可能在任务管理器的「启动」页里禁用过，那边是权威。
 */
export function syncLaunchAtLogin(): void {
  if (!app.isPackaged) return;
  const actual = app.getLoginItemSettings().openAtLogin;
  if (actual !== (readSettings().launchAtLogin === true)) {
    patchSettings({ launchAtLogin: actual });
  }
}

/* ---------- 取回答案 ---------- */

/** 当前这一档设置要不要让扩展去读回答正文。 */
export function wantsAnswer(): boolean {
  return readSettings().answerCapture !== 'off';
}

/** 取回来之后要不要顺手写进剪贴板。 */
export function wantsClipboard(): boolean {
  return readSettings().answerCapture === 'clipboard';
}

/**
 * 这个目标能不能取回答案，不能的话原因是什么。
 *
 * 在设置里就把话说清楚，而不是让人开了之后发现没反应去翻日志——
 * 和剪贴板历史里图片那条一样：「在列表里就写明了，
 * 不用等按下 Enter 才发现」。
 */
export function canCaptureAnswer(targetId: string): { ok: boolean; reason?: string } {
  if (targetId.endsWith('-web')) return { ok: true };
  // 桌面端要靠 UIA 读正文，而 Gemini 桌面端的可访问性树实测唤不醒；
  // 像素差分只能看出「画面在变」，看不出变的是什么字。
  return { ok: false, reason: '桌面端暂时取不回正文，只有网页端可以' };
}
