/**
 * clawd-on-desk 宿主核心的组合根。
 *
 * packages/clawd-core 里是从 clawd 原样搬来的代码：HTTP 接收端（server.js）、
 * 会话状态机（state.js）、代理运行时（agent-runtime-main.js）、权限气泡（permission.js）、
 * 会话面板（session-hud.js）、跳回终端（focus.js）。它们全靠一个 ctx 对象拿到宿主的能力——
 * clawd 自己的 main.js 是怎么喂的，这里就照着喂，只把「桌宠窗口」那一侧换成悬浮标。
 *
 * ctx 字段分两类：
 *   1. 悬浮标真有的能力：悬浮标窗口与本体位置、光标、日志、会话快照的出口。
 *   2. 悬浮标不做的功能（迷你模式、远程审批、按会话自动批准、Discord、配额环……）：
 *      给安全的空值。上游对这些字段都先做了 typeof 检查，缺了就走默认分支。
 *      其中「自动批准」相关的一律回答「不可用」——权限只能由人在气泡上点。
 *
 * 为什么不改上游代码而是全部走 ctx：上游迭代很快（三十多个代理的协议细节），
 * 只要不改它的文件，跟进更新就是重跑 tools/sync-clawd.mjs。
 */

import { app, ipcMain, screen, shell, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { clawdCoreDir, coreDepRequire, coreRequire } from './paths.js';
import { summarizeClawdSnapshot, type AgentSessionSummary, type AgentWatchStatus } from '@xfb/shared';


/** 开着这个环境变量才打 clawd 自己那几份很啰嗦的日志，并记录上游读了哪些我们没给的 ctx 字段。 */
const DEBUG = process.env['XFB_CLAWD_DEBUG'] === '1';

/** 气泡、面板的文案语言。clawd 自带简体中文。 */
const LANG = 'zh';

/**
 * 占位主题。
 *
 * state.js 必须有一个主题才能工作：它按主题声明了哪些状态来决定收不收某个状态
 * （没声明的状态直接回 400），还按主题挑每个状态播哪个文件。
 * 用户没选桌宠外观时就给它这个——每个状态一张空 SVG，只为让状态机跑起来，
 * 悬浮标的胶囊外观本来也不看文件名。
 *
 * 不能用 clawd 的内置主题：那是它的美术素材，不随本项目分发。
 */
const PLACEHOLDER_THEME_ID = 'xfb-placeholder';
const PLACEHOLDER_STATES = [
  'idle', 'thinking', 'working', 'juggling', 'error', 'attention', 'notification',
  'sweeping', 'carrying', 'sleeping', 'yawning', 'dozing', 'collapsing', 'waking',
];

function ensurePlaceholderTheme(themesDir: string): void {
  const dir = path.join(themesDir, PLACEHOLDER_THEME_ID);
  const marker = path.join(dir, 'theme.json');
  if (existsSync(marker)) return;
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="eyes-js"/></svg>';
  for (const s of PLACEHOLDER_STATES) writeFileSync(path.join(dir, 'assets', `${s}.svg`), svg);
  writeFileSync(
    marker,
    JSON.stringify(
      {
        schemaVersion: 1,
        name: '悬浮标占位主题',
        version: '1.0.0',
        description: '悬浮标自动生成，只为驱动状态机，不会显示出来。',
        viewBox: { x: 0, y: 0, width: 10, height: 10 },
        eyeTracking: { enabled: false, states: [] },
        sleepSequence: { mode: 'direct' },
        miniMode: { supported: false },
        states: Object.fromEntries(PLACEHOLDER_STATES.map((s) => [s, [`${s}.svg`]])),
      },
      null,
      2,
    ),
  );
}

/** clawd 本体在不在跑。它和悬浮标抢同一个端口段和同一份 runtime.json，不能同时监听。 */
export function isClawdRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  // 自检用：配合隔离的 USERPROFILE 跑端到端测试时，不必先退出真的 clawd。
  if (process.env['XFB_CLAWD_IGNORE_RUNNING'] === '1') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq Clawd on Desk.exe', '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 5_000 },
      (err, stdout) => resolve(!err && /"Clawd on Desk\.exe"/i.test(stdout)),
    );
  });
}

/**
 * 开调试时，把上游读到但我们没提供的 ctx 字段记下来。
 * 这些字段多数是可选注入点（上游有默认实现），但新版本上游加了必需字段时，
 * 这里是第一个能看出来的地方。
 */
function traced<T extends object>(name: string, target: T): T {
  if (!DEBUG) return target;
  const seen = new Set<string>();
  return new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key === 'string' && !(key in t) && !seen.has(key) && key !== 'then' && key !== 'toJSON') {
        seen.add(key);
        console.log(`[clawd] ${name} ctx 缺字段：${key}`);
      }
      return Reflect.get(t, key, receiver);
    },
  });
}

/** 窗口内的本体位置（CSS 像素，等同 DIP），和 hover.ts 的 HitRect 同形。 */
export interface PetHitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ClawdHostOptions {
  getPetWindow(): BrowserWindow | null;
  getPetHitRect(): PetHitRect | null;
  /** 各代理的开关（clawd 设置里 agents 那一块的形状）。每次读都取最新的。 */
  getAgentGates(): Record<string, unknown>;
  /** clawd 状态机切换了桌宠该显示的状态。file 是当前主题里的文件名。 */
  onVisual(state: string, file: string | null): void;
  /** 会话列表变了。 */
  onSessions(sessions: AgentSessionSummary[]): void;
}

export interface ClawdHost {
  readonly status: AgentWatchStatus;
  /** 开始监听。clawd 在跑、端口全被占、核心加载失败，都会体现在返回的状态里而不是抛异常。 */
  start(): Promise<AgentWatchStatus>;
  stop(): void;
  /** 悬浮标挪了位置或本体变了大小：权限气泡和会话面板跟着挪。 */
  repositionFloating(): void;
  /** 鼠标压到悬浮标上：有会话时把会话面板亮出来（没固定时，移开会自己收起）。 */
  revealSessions(): void;
  /** 会话面板常驻显示。 */
  setSessionsPinned(pinned: boolean): void;
  /** 跳到某个会话所在的终端。 */
  focusSession(sessionId: string): boolean;
  /** 已启用的代理里，哪些装过集成（hooks/插件），即「改指向」会碰到的那些。 */
  hookTargets(): string[];
  /**
   * 把这些代理的 hooks 重新装一遍，命令改指向悬浮标自带的 hook 脚本。
   * 只在用户点托盘时调用；会改写各代理的配置文件（上游会先备份）。
   */
  repointHooks(): Promise<Array<{ agentId: string; ok: boolean; message: string }>>;
  /** clawd 注册表里的全部代理：id、名字、支持哪些开关。不依赖监听在不在跑。 */
  agentDescriptors(): Array<{ id: string; name: string; permission: boolean; subagent: boolean; notification: boolean }>;
  /** 给一个代理装 hooks / 插件（指向悬浮标自带的脚本）。会改写它的配置文件。 */
  installIntegration(agentId: string): Promise<{ ok: boolean; message: string }>;
  /** 卸掉一个代理的 hooks / 插件。 */
  uninstallIntegration(agentId: string): Promise<{ ok: boolean; message: string }>;
}

export function createClawdHost(options: ClawdHostOptions): ClawdHost {
  let status: AgentWatchStatus = { kind: 'off' };
  let server: any = null;
  let state: any = null;
  let perm: any = null;
  let hud: any = null;
  let focus: any = null;
  let permIpc: { dispose(): void } | null = null;
  let sessionsPinned = false;
  /**
   * 只有用户在托盘里点了「改指向」的那一会儿才放行写代理配置。
   * 平时上游的自动同步、settings.json 守护都看这个开关，一律不动用户的配置文件。
   */
  let allowHookWrites = false;
  const ipcDisposers: Array<() => void> = [];

  const log = (msg: string) => {
    if (DEBUG) console.log(`[clawd] ${msg}`);
  };

  const { i18n, createTranslator } = coreRequire('src/i18n.js');
  const t: (key: string) => string = createTranslator(() => LANG);

  /**
   * 代理开关。clawd 的设置里每个代理有「启用 / 权限气泡 / 子代理气泡 / 通知」几个开关，
   * 悬浮标沿用同一份（第一次启动从 clawd 的设置里搬过来）：没启用的代理发来的事件直接丢掉。
   */
  const { createRuntimeAgentGate } = coreRequire('src/agent-gate.js');
  const gate = createRuntimeAgentGate({ getSnapshot: () => ({ agents: options.getAgentGates() }) });

  /** 气泡开关和自动关闭时长：空设置快照 = clawd 的默认值（权限气泡开、不自动关）。 */
  const { getBubblePolicy } = coreRequire('src/bubble-policy.js');
  const bubblePolicy = (kind: string) => getBubblePolicy({}, kind);

  // ── 几何：气泡和面板都要贴着悬浮标的本体摆 ──

  function petWindow(): BrowserWindow | null {
    return options.getPetWindow();
  }

  function getPetWindowBounds() {
    const win = petWindow();
    return win ? win.getBounds() : null;
  }

  function getHitRectScreen(bounds?: Electron.Rectangle | null): ScreenRect | null {
    const b = bounds ?? getPetWindowBounds();
    if (!b) return null;
    const r = options.getPetHitRect();
    if (!r) return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
    const left = b.x + r.left;
    const top = b.y + r.top;
    return { left, top, right: left + r.width, bottom: top + r.height };
  }

  function getNearestWorkArea(cx: number, cy: number) {
    return screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).workArea;
  }

  function getBubbleWorkArea(followPet: boolean, petBounds?: Electron.Rectangle | null) {
    const b = petBounds ?? getPetWindowBounds();
    if (followPet && b) return getNearestWorkArea(b.x + b.width / 2, b.y + b.height / 2);
    return screen.getPrimaryDisplay().workArea;
  }

  /** 浮层要和悬浮标处在同一个置顶层级，否则会被它压在下面。 */
  function guardAlwaysOnTop(win: BrowserWindow | null | undefined) {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
  }

  function repositionFloating(): void {
    try {
      perm?.repositionBubbles?.();
      hud?.repositionSessionHud?.();
    } catch (err) {
      console.error('[编码代理] 重新摆放浮层出错：', err);
    }
  }

  // ── 跳回终端：照 clawd main.js 的 focusDashboardSession ──

  function focusSession(sessionId: string, opts: { requestSource?: string; fallbackEntry?: object } = {}): boolean {
    if (!focus || !state || !sessionId) return false;
    const requestSource = opts.requestSource ?? 'session-hud';
    const id = String(sessionId);
    const session = state.sessions?.get(id);
    const fallback = opts.fallbackEntry && typeof opts.fallbackEntry === 'object' ? opts.fallbackEntry : null;
    if (!session && !fallback) return false;

    const entry = { ...(session ?? {}), ...(fallback ?? {}), id };
    const { getSessionFocusTarget } = coreRequire('src/session-focus.js');
    const target = getSessionFocusTarget(entry, { osPlatform: process.platform });
    const focusTerminalSession = (s: any, sid: string, source: string) => {
      if (!s || (!s.sourcePid && !s.orcaPaneKey)) return false;
      return focus.focusTerminalWindow({
        sourcePid: s.sourcePid,
        wtHwnd: s.wtHwnd,
        cwd: s.cwd,
        editor: s.editor,
        pidChain: s.pidChain,
        tmuxSocket: s.tmuxSocket,
        tmuxClient: s.tmuxClient,
        orcaPaneKey: s.orcaPaneKey,
        ghosttyTerminalId: s.ghosttyTerminalId,
        sessionId: sid,
        agentId: s.agentId,
        requestSource: source,
      });
    };
    if (target.type === 'codex-thread' && target.url) {
      const { focusCodexThreadTarget } = coreRequire('src/session-focus-handoff.js');
      focusCodexThreadTarget({
        shell,
        focusEntry: entry,
        sessionId: id,
        requestSource,
        url: target.url,
        focusLog: log,
        focusTerminalSession,
      });
      return true;
    }
    if (target.type === 'terminal') return !!focusTerminalSession(entry, id, requestSource);
    return false;
  }

  /** Windows 上前台窗口切换要先「授权」目标进程，clawd 用 koffi 直接调 user32。 */
  function loadAllowSetForeground(): ((pid: number) => boolean) | null {
    if (process.platform !== 'win32') return null;
    try {
      const koffi = coreDepRequire('koffi');
      const user32 = koffi.load('user32.dll');
      return user32.func('bool __stdcall AllowSetForegroundWindow(int dwProcessId)');
    } catch (err) {
      console.warn('[编码代理] AllowSetForegroundWindow 不可用，跳回终端可能失败：', err);
      return null;
    }
  }

  // ── 会话面板的 IPC：clawd 里这几条在 session-ipc.js，那个模块牵扯整个 Dashboard，这里只接面板要的 ──

  function registerHudIpc(): void {
    const handle = (channel: string, fn: (...args: any[]) => unknown) => {
      ipcMain.handle(channel, fn);
      ipcDisposers.push(() => ipcMain.removeHandler(channel));
    };
    const on = (channel: string, fn: (...args: any[]) => void) => {
      ipcMain.on(channel, fn);
      ipcDisposers.push(() => ipcMain.removeListener(channel, fn));
    };
    handle('session-hud:get-i18n', () => ({ lang: LANG, translations: { ...(i18n[LANG] ?? i18n.en) } }));
    on('session-hud:focus-session', (_e, sessionId: unknown) => {
      if (typeof sessionId === 'string') focusSession(sessionId, { requestSource: 'session-hud' });
    });
    handle('session-hud:open-session-folder', async (_e, sessionId: unknown) => {
      if (typeof sessionId !== 'string') return { status: 'error', message: 'sessionId must be a string' };
      const cwd = state?.sessions?.get(sessionId)?.cwd;
      if (typeof cwd !== 'string' || !cwd) return { status: 'error', message: 'session has no cwd' };
      const err = await shell.openPath(cwd);
      return err ? { status: 'error', message: err } : { status: 'ok' };
    });
    // 悬浮标没有 Dashboard，面板上那个入口点了什么也不做。
    on('session-hud:open-dashboard', () => {});
    on('session-hud:set-pinned', (_e, value: unknown) => setSessionsPinned(!!value));
    handle('session:ack-completion', (_e, sessionId: unknown) => {
      if (typeof sessionId !== 'string') return { status: 'error', message: 'sessionId must be a string' };
      return state?.ackSessionCompletion?.(sessionId) ?? { status: 'error', message: 'not running' };
    });
  }

  function loadTheme(): any {
    const userData = app.getPath('userData');
    const themesDir = path.join(userData, 'themes');
    ensurePlaceholderTheme(themesDir);
    const themeLoader = coreRequire('src/theme-loader.js');
    // 第一个参数是「内置主题目录的兄弟目录」；悬浮标没有内置主题，指向核心目录即可（找不到就跳过）。
    themeLoader.init(path.join(clawdCoreDir(), 'src'), userData);
    return themeLoader.loadTheme(PLACEHOLDER_THEME_ID, { strict: true });
  }

  async function start(): Promise<AgentWatchStatus> {
    if (status.kind === 'listening') return status;

    if (await isClawdRunning()) {
      status = { kind: 'clawd-running' };
      return status;
    }

    try {
      const theme = loadTheme();

      // ── 权限气泡 ──
      const initPermission = coreRequire('src/permission.js');
      const permCtx = traced('permission', {
        get win() {
          return petWindow();
        },
        lang: LANG,
        get sessions() {
          return state?.sessions ?? new Map();
        },
        bubbleFollowPet: true,
        bubbleFollowPreference: true,
        bubbleFixedCorner: 'bottom-right',
        permDebugLog: null,
        doNotDisturb: false,
        hideBubbles: false,
        petHidden: false,
        getBubblePolicy: bubblePolicy,
        getPetWindowBounds,
        getNearestWorkArea,
        getBubbleWorkArea,
        getHitRectScreen,
        getHudReservedOffset: () => hud?.getHudReservedOffset?.() ?? 0,
        getSessionHudBounds: () => {
          const w = hud?.getWindow?.();
          return w && !w.isDestroyed() && w.isVisible() ? w.getBounds() : null;
        },
        getTextScale: () => 1,
        guardAlwaysOnTop,
        reapplyMacVisibility: () => {},
        syncImeEditingPetDodge: () => {},
        isAgentEnabled: (id: string) => gate.isAgentEnabled(id),
        isAgentPermissionsEnabled: (id: string) => gate.isAgentPermissionsEnabled(id),
        isAgentSubagentPermissionsEnabled: (id: string) => gate.isAgentSubagentPermissionsEnabled(id),
        isCodexPermissionInterceptEnabled: () => gate.isCodexPermissionInterceptEnabled(),
        // 不做任何形式的自动批准：每一条都要人在气泡上点。
        getPermissionAutomationMode: () => 'off',
        getEffectivePermissionAutomationMode: () => 'off',
        hasSessionAutomationOverride: () => false,
        canOfferSessionTrust: () => false,
        canOfferRemoteSessionTrust: () => false,
        requestSessionTrust: () => Promise.resolve({ status: 'unavailable' }),
        requestRemoteSessionTrust: () => Promise.resolve({ status: 'unavailable' }),
        cancelSessionTrustCandidate: () => false,
        isDestructiveReminderEnabled: () => false,
        translate: t,
        focusTerminalForSession: (sessionId: string, opts: { requestSource?: string; fallbackEntry?: object } = {}) =>
          focusSession(sessionId, { requestSource: opts.requestSource ?? 'permission-bubble', fallbackEntry: opts.fallbackEntry }),
        // 快捷键用 clawd 的默认值（Ctrl+Shift+Y 允许、Ctrl+Shift+N 拒绝），只在有待批请求时注册。
        getSettingsSnapshot: () => ({}),
        subscribeShortcuts: () => () => {},
        reportShortcutFailure: (actionId: string, reason: string) =>
          console.warn(`[编码代理] 审批快捷键注册失败：${actionId}（${reason}）`),
        clearShortcutFailure: () => {},
        repositionFloatingBubbles: () => repositionFloating(),
        repositionUpdateBubble: () => {},
        repositionSessionHud: () => hud?.repositionQuotaRing?.(),
        getTelegramApprovalClient: () => null,
        getRemoteApprovalClients: () => [],
        onPermissionResolved: (entry: { sessionId?: string } | null, opts: object = {}) =>
          state?.clearPermissionNotification?.(entry?.sessionId, opts),
        notifySlackPermission: () => {},
      });
      perm = initPermission(permCtx);
      permIpc = initPermission.registerPermissionIpc({ ipcMain, permission: perm });

      // ── 状态机 ──
      const stateCtx = traced('state', {
        get theme() {
          return theme;
        },
        get win() {
          return petWindow();
        },
        doNotDisturb: false,
        miniMode: false,
        miniTransitioning: false,
        miniPeeked: false,
        miniSleepPeeked: false,
        mouseOverPet: false,
        idlePaused: false,
        forceEyeResend: false,
        get mouseStillSince() {
          return Date.now();
        },
        get pendingPermissions() {
          return perm.pendingPermissions;
        },
        getCursorScreenPoint: () => screen.getCursorScreenPoint(),
        sendToRenderer: (channel: string, ...args: unknown[]) => {
          if (channel === 'state-change') {
            const [visualState, file] = args;
            if (typeof visualState === 'string') {
              options.onVisual(visualState, typeof file === 'string' ? file : null);
            }
          }
        },
        sendToHitWin: () => {},
        syncHitWin: () => {},
        playSound: () => {},
        flashTaskbar: () => {},
        t,
        debugLog: log,
        broadcastSessionSnapshot: (snapshot: unknown) => {
          options.onSessions(summarizeClawdSnapshot(snapshot));
          try {
            hud?.broadcastSessionSnapshot?.(snapshot);
          } catch (err) {
            console.error('[编码代理] 会话面板更新出错：', err);
          }
          repositionFloating();
        },
        focusTerminalWindow: (...args: unknown[]) => focus?.focusTerminalWindow?.(...args),
        resolvePermissionEntry: (...args: unknown[]) => perm.resolvePermissionEntry(...args),
        dismissPermissionsForDnd: (...args: unknown[]) => perm.dismissPermissionsForDnd(...args),
        showKimiNotifyBubble: (...args: unknown[]) => perm.showKimiNotifyBubble(...args),
        clearKimiNotifyBubbles: (...args: unknown[]) => perm.clearKimiNotifyBubbles(...args),
        isAgentEnabled: (id: string) => gate.isAgentEnabled(id),
        hasAnyEnabledAgent: () => true,
        isAgentPermissionsEnabled: (id: string) => gate.isAgentPermissionsEnabled(id),
        isAgentNotificationHookEnabled: (id: string) => gate.isAgentNotificationHookEnabled(id),
        resolveAgentDisplayName: (id: string) => id,
        getStaleConfig: () => ({}),
        getSessionAliases: () => ({}),
        getSessionAutomationRecords: () => [],
        getPermissionAutomationMode: () => 'off',
        isOneshotDisabled: () => false,
        getIdleVisualChoice: () => null,
        hasReplyableCompletionMapping: () => false,
        sessionHudCleanupDetached: false,
        buildContextMenu: () => {},
        buildTrayMenu: () => {},
      });
      state = coreRequire('src/state.js')(stateCtx);

      // ── 会话面板 ──
      hud = coreRequire('src/session-hud.js')(
        traced('session-hud', {
          get win() {
            return petWindow();
          },
          petHidden: false,
          sessionHudEnabled: true,
          sessionHudShowStateLabels: true,
          sessionHudShowElapsed: true,
          sessionHudShowContextUsage: false,
          sessionHudShowQuota: false,
          quotaRingDisplayMode: 'off',
          quotaRingHiddenProviders: [],
          get sessionHudPinned() {
            return sessionsPinned;
          },
          lowPowerIdleMode: false,
          getMiniMode: () => false,
          getMiniTransitioning: () => false,
          getSessionSnapshot: () => state.buildSessionSnapshot(),
          getI18n: () => ({ lang: LANG, translations: { ...(i18n[LANG] ?? i18n.en) } }),
          getPetWindowBounds,
          getHitRectScreen,
          getSessionHudAnchorRect: () => null,
          getNearestWorkArea,
          getTextScale: () => 1,
          getPermissionBubbleBounds: () => perm.getVisibleBubbleBounds(),
          getUpdateBubbleWindow: () => null,
          guardAlwaysOnTop,
          reapplyMacVisibility: () => {},
          onReservedOffsetChange: () => repositionFloating(),
        }),
      );
      registerHudIpc();

      // ── 跳回终端 ──
      focus = coreRequire('src/focus.js')({ _allowSetForeground: loadAllowSetForeground(), focusLog: log });
      focus.initFocusHelper?.();

      // ── 接收端 ──
      const createAgentRuntimeMain = coreRequire('src/agent-runtime-main.js');
      const agentRuntime = createAgentRuntimeMain({
        getServer: () => server,
        getStateRuntime: () => state,
        getPermissionRuntime: () => perm,
        isAgentEnabled: (id: string) => gate.isAgentEnabled(id),
        updateSession: (...args: unknown[]) => state.updateSession(...args),
        debugLog: log,
        captureGhosttyTerminalId: (...args: unknown[]) => focus?.captureGhosttyTerminalId?.(...args),
        clearCodexNotifyBubbles: (...args: unknown[]) => perm.clearCodexNotifyBubbles(...args),
        showCodexUserInputBubble: (...args: unknown[]) => perm.showCodexUserInputBubble(...args),
        clearCodexUserInputBubbles: (...args: unknown[]) => perm.clearCodexUserInputBubbles(...args),
      });

      const serverCtx = traced('server', {
        // 平时不自动改写 ~/.claude/settings.json，只有用户点了「改指向」那一会儿放行。
        get manageClaudeHooksAutomatically() {
          return allowHookWrites;
        },
        autoStartWithClaude: false,
        claudeQuotaCollectionEnabled: false,
        doNotDisturb: false,
        shouldDropForDnd: () => (state.shouldDropForDnd ? state.shouldDropForDnd() : false),
        hideBubbles: false,
        getBubblePolicy: bubblePolicy,
        get pendingPermissions() {
          return perm.pendingPermissions;
        },
        get PASSTHROUGH_TOOLS() {
          return perm.PASSTHROUGH_TOOLS;
        },
        get STATE_SVGS() {
          return state.STATE_SVGS;
        },
        get sessions() {
          return state.sessions;
        },
        getCustomAgentIds: () => [],
        onHookEventRecorded: () => {},
        debugLog: log,
        isAgentEnabled: (id: string) => gate.isAgentEnabled(id),
        // 同上：只在「改指向」期间、且对已启用的代理才同步集成配置。
        shouldSyncAgentIntegration: (id: string) => allowHookWrites && gate.shouldSyncAgentIntegration(id),
        isAgentPermissionsEnabled: (id: string) => gate.isAgentPermissionsEnabled(id),
        isAgentSubagentPermissionsEnabled: (id: string) => gate.isAgentSubagentPermissionsEnabled(id),
        isCodexNativeNotificationSoundEnabled: () => gate.isCodexNativeNotificationSoundEnabled(),
        isCodexPermissionInterceptEnabled: () => gate.isCodexPermissionInterceptEnabled(),
        codexSubagentClassifier: agentRuntime.getCodexSubagentClassifier(),
        setState: (...args: unknown[]) => state.setState(...args),
        updateSession: agentRuntime.updateSessionFromServer,
        updateSessionMetadata: agentRuntime.updateSessionMetadataFromServer,
        shouldSuppressCodexArchive: (rawSessionId: string, opts: unknown) =>
          agentRuntime.shouldSuppressCodexArchive(rawSessionId, opts),
        clearClaudeStatuslineAuthority: (profileId: unknown) => state.clearClaudeStatuslineAuthority(profileId),
        clearLocalClaudeQuota: () => state.clearLocalClaudeQuota(),
        updateAccountQuota: (host: unknown, quotas: unknown) => state.updateAccountQuota(host, quotas),
        resolvePermissionEntry: (...args: unknown[]) => perm.resolvePermissionEntry(...args),
        sendPermissionResponse: (...args: unknown[]) => perm.sendPermissionResponse(...args),
        addPendingPermission: (...args: unknown[]) => perm.addPendingPermission(...args),
        removePendingPermission: (...args: unknown[]) => perm.removePendingPermission(...args),
        isPermissionEntryLive: (...args: unknown[]) => perm.isPermissionEntryLive(...args),
        canAutoResolvePendingPermission: (...args: unknown[]) => perm.canAutoResolvePendingPermission(...args),
        // 按会话自动放行要先由人「信任这个会话」，悬浮标不提供这个入口，所以永远不自动放行。
        maybeAutoResolveSessionPermission: () => false,
        showPermissionBubble: (...args: unknown[]) => perm.showPermissionBubble(...args),
        showCodexUserInputBubble: (...args: unknown[]) => perm.showCodexUserInputBubble(...args),
        clearCodexUserInputBubbles: (...args: unknown[]) => perm.clearCodexUserInputBubbles(...args),
        handleTestResult: () => {},
        maybeStartRemoteApproval: (...args: unknown[]) => perm.maybeStartRemoteApproval(...args),
        replyOpencodeFamilyPermission: (...args: unknown[]) => perm.replyOpencodeFamilyPermission(...args),
        dismissOpencodeFamilyPermissionResolvedExternally: (...args: unknown[]) =>
          perm.dismissOpencodeFamilyPermissionResolvedExternally(...args),
        syncPermissionShortcuts: (...args: unknown[]) => perm.syncPermissionShortcuts(...args),
        permLog: (...args: unknown[]) => perm.permLog(...args),
        notifySuspiciousShrink: () => {},
      });
      server = coreRequire('src/server.js')(serverCtx);

      const port: number | null = await server.startHttpServer();
      if (!port) {
        stop();
        status = { kind: 'failed', message: '端口 23333–23337 全被占用' };
        return status;
      }
      state.startStaleCleanup?.();
      hud.syncSessionHud?.();
      status = { kind: 'listening', port };
      console.log(`[编码代理] 监听 127.0.0.1:${port}`);
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[编码代理] 宿主核心启动失败：', err);
      stop();
      status = { kind: 'failed', message };
      return status;
    }
  }

  /** 每一步单独兜住：收尾时一处出错不能让后面的资源泄漏（尤其端口和 runtime.json）。 */
  function attempt(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[编码代理] ${label}出错：`, err);
    }
  }

  function stop(): void {
    attempt('关闭接收端', () => server?.cleanup?.());
    attempt('关闭权限气泡', () => perm?.cleanup?.());
    attempt('注销权限气泡 IPC', () => permIpc?.dispose());
    attempt('关闭会话面板', () => hud?.cleanup?.());
    attempt('注销会话面板 IPC', () => {
      while (ipcDisposers.length) ipcDisposers.pop()!();
    });
    attempt('关闭终端跳转助手', () => focus?.killFocusHelper?.());
    attempt('清理状态机', () => state?.cleanup?.());
    server = state = perm = hud = focus = null;
    permIpc = null;
    status = { kind: 'off' };
    options.onSessions([]);
    options.onVisual('idle', null);
  }

  function setSessionsPinned(pinned: boolean): void {
    if (sessionsPinned === pinned) return;
    sessionsPinned = pinned;
    attempt('切换会话面板固定', () => hud?.handlePinnedChanged?.(pinned));
  }

  function hookTargets(): string[] {
    const gates = options.getAgentGates();
    return Object.entries(gates)
      .filter(([, v]) => {
        const e = v as { enabled?: unknown; integrationInstalled?: unknown } | null;
        return !!e && e.enabled === true && e.integrationInstalled === true;
      })
      .map(([id]) => id);
  }

  /** 上游各安装器的返回值五花八门（false、{status:'error'}、{ok:false}、带 message 的对象），统一成一个形状。 */
  function normalizeResult(r: any, okText: string): { ok: boolean; message: string } {
    const failed = r === false || (r && typeof r === 'object' && (r.status === 'error' || r.ok === false));
    const message =
      r && typeof r === 'object' && typeof r.message === 'string' ? r.message : failed ? '上游拒绝了这次操作' : okText;
    return { ok: !failed, message };
  }

  /** 放行写配置，同步一个代理的集成。调用方负责先确认、并保证它在开关里是「启用 + 已装」。 */
  async function syncOne(agentId: string, okText: string): Promise<{ ok: boolean; message: string }> {
    if (!server) return { ok: false, message: '编码代理监听没有在运行' };
    allowHookWrites = true;
    try {
      return normalizeResult(await server.syncIntegrationForAgent(agentId, { source: 'xfb', automatic: false }), okText);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      allowHookWrites = false;
    }
  }

  async function repointHooks(): Promise<Array<{ agentId: string; ok: boolean; message: string }>> {
    if (!server) throw new Error('编码代理监听没有在运行');
    const results: Array<{ agentId: string; ok: boolean; message: string }> = [];
    for (const agentId of hookTargets()) results.push({ agentId, ...(await syncOne(agentId, '已改指向')) });
    for (const r of results) console.log(`[编码代理] 改指向 ${r.agentId}：${r.ok ? '成功' : '失败'}（${r.message}）`);
    return results;
  }

  function agentDescriptors() {
    const { getAllAgents } = coreRequire('agents/registry.js');
    return (getAllAgents() as any[]).map((a) => {
      const c = (a && a.capabilities) || {};
      return {
        id: String(a.id),
        name: typeof a.name === 'string' && a.name ? a.name : String(a.id),
        permission: c.permissionApproval === true,
        subagent: c.subagent === true,
        notification: c.notificationHook === true,
      };
    });
  }

  async function uninstallIntegration(agentId: string): Promise<{ ok: boolean; message: string }> {
    if (!server) return { ok: false, message: '编码代理监听没有在运行' };
    try {
      return normalizeResult(await server.uninstallIntegrationForAgent(agentId), '已卸载');
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    get status() {
      return status;
    },
    start,
    stop,
    repositionFloating,
    revealSessions: () => attempt('展开会话面板', () => hud?.revealFromPet?.()),
    setSessionsPinned,
    hookTargets,
    repointHooks,
    agentDescriptors,
    installIntegration: (agentId) => syncOne(agentId, '已安装'),
    uninstallIntegration,
    focusSession: (sessionId) => {
      try {
        return focusSession(sessionId);
      } catch (err) {
        console.error('[编码代理] 跳回终端出错：', err);
        return false;
      }
    },
  };
}
