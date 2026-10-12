/**
 * 预加载脚本：给渲染层开一扇窄门。
 *
 * 渲染层拿不到 Node，也拿不到 ipcRenderer 本体，
 * 只能调用这里显式列出的几个方法。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AgentCatalogEntry, AgentGateKey, AgentInstallResult, AgentsSnapshot, Celebration, SkinInfo, PetState, PromptBrowseOrder, PromptCategoryId } from '@xfb/shared';

export interface TargetSummary {
  id: string;
  label: string;
  delivery: 'win32' | 'web';
}

/** 提示词在列表里需要的字段。正文也带上，填入时不必再往返一次。 */
export interface PromptSummary {
  id: string;
  title: string;
  content: string;
  /** 用于列表分组。用户自建的条目没有这个字段。 */
  category?: PromptCategoryId;
  hasVariables: boolean;
}

/** 笔记在列表里需要的字段。 */
export interface NoteSummary {
  id: string;
  title: string;
  content: string;
  group?: string;
}

/**
 * 剪贴板历史在列表里需要的字段。
 * 文本条目连全文一起带上，填入时不必再往返一次（同 PromptSummary 的取舍）。
 */
export interface ClipSummary {
  id: string;
  kind: 'text' | 'image';
  /** 全文。image 条目为空串。 */
  text: string;
  /** 单行预览。image 条目为空串，由渲染层用尺寸另行拼。 */
  preview: string;
  /** image 条目的缩略图 data URL。 */
  thumbnail?: string;
  width?: number;
  height?: number;
  copiedAt: number;
}

/** 目标面板的一行。available 为 null 表示还在检测。 */
export interface TargetStatus {
  id: string;
  label: string;
  shortLabel: string;
  delivery: 'win32' | 'web';
  available: boolean | null;
  reason?: string;
}

export interface PanelData {
  targets: TargetStatus[];
  /** 这次要投给哪些目标，第一个是主目标。通常只有一个。 */
  currentTargetIds: string[];
}

export interface BasketItem {
  id: string;
  name: string;
  kind: 'file' | 'directory' | 'text' | 'url' | 'image';
  size: number;
  createdAt: number;
  thumbnail?: string;
}

export interface BasketStatus {
  count: number;
  totalBytes: number;
  retentionDays: 0 | 1 | 7 | 30;
  capacityMb: 0 | 100 | 500 | 1024 | 5120;
  removeOnDragOut: boolean;
  shakeEnabled: boolean;
  shakeSensitivity: 'low' | 'medium' | 'high';
  suppressInFullscreen: boolean;
}

export interface BasketRemovedInfo {
  token: string;
  count: number;
  failed: number;
  reason: 'delete' | 'clear' | 'drag';
  undoMs: number;
}

export interface BasketPreview {
  id: string;
  name: string;
  renameBase: string;
  kind: BasketItem['kind'];
  size: number;
  modifiedAt: number;
  text?: string;
  textTruncated?: boolean;
  imageDataUrl?: string;
}

/** 投递全都失败时随 opened 一起回来的文本，见主进程的 restoreInput。 */
export interface InputRestore {
  text: string;
  message: string;
}

const api = {
  /** 取一次当前状态，用于窗口刚加载时的首帧渲染。 */
  getState: (): Promise<PetState> => ipcRenderer.invoke('pet:get-state'),

  /** 订阅状态变化。返回取消订阅的函数。 */
  onState: (cb: (state: PetState) => void): (() => void) => {
    const handler = (_e: unknown, state: PetState) => cb(state);
    ipcRenderer.on('pet:state', handler);
    return () => ipcRenderer.off('pet:state', handler);
  },

  /** 桌宠外观：胶囊，或者某个主题。 */
  getSkin: (): Promise<SkinInfo> => ipcRenderer.invoke('pet:get-skin'),

  onSkin: (cb: (skin: SkinInfo) => void): (() => void) => {
    const handler = (_e: unknown, skin: SkinInfo) => cb(skin);
    ipcRenderer.on('pet:skin', handler);
    return () => ipcRenderer.off('pet:skin', handler);
  },

  /** 光标在悬浮标窗口内的坐标（可在窗口外）。只有角色外观时主进程才发，给眼睛跟随用。 */
  onCursor: (cb: (pos: { x: number; y: number }) => void): (() => void) => {
    const handler = (_e: unknown, pos: { x: number; y: number }) => cb(pos);
    ipcRenderer.on('pet:cursor', handler);
    return () => ipcRenderer.off('pet:cursor', handler);
  },

  /* ---------- 编码代理设置窗口 ---------- */

  /** 全部代理和它们的开关。 */
  listAgents: (): Promise<AgentCatalogEntry[]> => ipcRenderer.invoke('agents:catalog'),
  /** 切一个开关，立即生效。返回改完后的那一条。 */
  setAgentGate: (agentId: string, key: AgentGateKey, value: boolean): Promise<AgentCatalogEntry> =>
    ipcRenderer.invoke('agents:set-gate', agentId, key, value),
  /** 装 / 卸这个代理的 hooks。主进程会先弹确认框；用户取消时 cancelled 为 true。 */
  installAgent: (agentId: string): Promise<AgentInstallResult> => ipcRenderer.invoke('agents:install', agentId),
  uninstallAgent: (agentId: string): Promise<AgentInstallResult> => ipcRenderer.invoke('agents:uninstall', agentId),

  /** 编码代理那一路：clawd 状态机给出的桌宠状态和会话列表。 */
  getAgents: (): Promise<AgentsSnapshot> => ipcRenderer.invoke('agents:get'),

  onAgents: (cb: (snapshot: AgentsSnapshot) => void): (() => void) => {
    const handler = (_e: unknown, snapshot: AgentsSnapshot) => cb(snapshot);
    ipcRenderer.on('pet:agents', handler);
    return () => ipcRenderer.off('pet:agents', handler);
  },

  /**
   * 订阅目标可用性。
   *
   * 和面板走同一份 checkAllTargets 结果——输入条上那个状态点以前是编的
   * （桌面端一律"能发"、网页端一律"不能发"），会和面板对同一个目标各说各话。
   */
  onTargetStatus: (cb: (targets: TargetStatus[]) => void): (() => void) => {
    const handler = (_e: unknown, targets: TargetStatus[]) => cb(targets);
    ipcRenderer.on('input:target-status', handler);
    return () => ipcRenderer.off('input:target-status', handler);
  },

  /**
   * 输入条被唤起时触发，用于聚焦输入框、同步当前目标。
   *
   * `restore` 有值时这次不是普通唤起，而是上一条投递全都没送到、
   * 把文本还回来了——输入框要填回它而不是照常清空。
   */
  onOpened: (
    cb: (payload: { targetIds: string[]; restore?: InputRestore }) => void,
  ): (() => void) => {
    const handler = (_e: unknown, payload: { targetIds: string[]; restore?: InputRestore }) =>
      cb(payload);
    ipcRenderer.on('input:opened', handler);
    return () => ipcRenderer.off('input:opened', handler);
  },

  listTargets: (): Promise<{ targets: TargetSummary[]; currentTargetIds: string[] }> =>
    ipcRenderer.invoke('targets:list'),

  /** 单选：换主目标，丢掉附加的。 */
  selectTarget: (targetId: string): Promise<string[]> =>
    ipcRenderer.invoke('targets:select', targetId),

  /** 多选：把一个目标加进这次投递或取消掉。不会让它变成零个。 */
  toggleTarget: (targetId: string): Promise<string[]> =>
    ipcRenderer.invoke('targets:toggle', targetId),

  submit: (text: string, targetIds?: string[]): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('pet:submit', { text, targetIds }),

  /**
   * 跳到目标窗口去看回复。
   * 同时发给多个目标时连点会依次轮换，详见 orchestrator.reveal。
   */
  revealTarget: (): Promise<{ ok: boolean; targetId?: string }> =>
    ipcRenderer.invoke('pet:reveal'),

  closeInput: (): void => ipcRenderer.send('input:close'),

  /** 点击宠物本体。 */
  activate: (): void => ipcRenderer.send('pet:activate'),

  /** 打开目标选择面板。 */
  openMenu: (): void => ipcRenderer.send('pet:menu'),

  /** 单击本体：展开编码代理会话面板。 */
  revealSessions: (): void => ipcRenderer.send('pet:reveal-sessions'),

  /** 右键本体：弹出和托盘同一份的菜单。 */
  openContextMenu: (): void => ipcRenderer.send('pet:context-menu'),

  /** 打开 Tokri 风格的临时篮子。 */
  openBasket: (): void => ipcRenderer.send('basket:open'),

  /** 按住胶囊拖动：开始后由主进程让窗口跟着光标走，松手时结束。 */
  dragStart: (): void => ipcRenderer.send('pet:drag-start'),
  dragEnd: (): void => ipcRenderer.send('pet:drag-end'),

  /** 上报本体在窗口内的位置，供主进程做鼠标命中判断。 */
  reportHitRect: (rect: { left: number; top: number; width: number; height: number }): void =>
    ipcRenderer.send('pet:hit-rect', rect),

  /**
   * 订阅庆祝事件。
   *
   * 和 onState 分开走是刻意的：state 会被反复推送（thinking 期间 elapsedMs
   * 一直在变），而庆祝是一次性的**转换**。挂在 state 上会变成生成过程中一直撒花。
   */
  onCelebrate: (cb: (c: Celebration) => void): (() => void) => {
    const handler = (_e: unknown, c: Celebration) => cb(c);
    ipcRenderer.on('pet:celebrate', handler);
    return () => ipcRenderer.off('pet:celebrate', handler);
  },

  /** 庆祝演完了，请主进程把撑大的窗口缩回去。 */
  celebrateEnd: (): void => ipcRenderer.send('pet:celebrate-end'),

  /** 订阅「鼠标是否压在本体上」，用于悬停展开。 */
  onHover: (cb: (hovering: boolean) => void): (() => void) => {
    const handler = (_e: unknown, hovering: boolean) => cb(hovering);
    ipcRenderer.on('pet:hover', handler);
    return () => ipcRenderer.off('pet:hover', handler);
  },
  /** 订阅实际生效的输入条快捷键；null 表示候选全被占用。 */
  onHotkey: (cb: (hotkey: string | null) => void): (() => void) => {
    const handler = (_e: unknown, hotkey: string | null) => cb(hotkey);
    ipcRenderer.on('pet:hotkey', handler);
    return () => ipcRenderer.off('pet:hotkey', handler);
  },

  /* ---------- 提示词 ---------- */

  /** 按关键词搜提示词。空串返回最常用的几条。 */
  searchPrompts: (
    query: string,
    order: PromptBrowseOrder = 'frequent',
  ): Promise<PromptSummary[]> => ipcRenderer.invoke('prompts:search', { query, order }),

  /** 取某条提示词上次填过的变量值，用于预填。 */
  rememberedValues: (id: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('prompts:remembered', id),

  /** 记一次使用，并存下这次填的变量值。 */
  recordPromptUsage: (id: string, variableValues?: Record<string, string>): void =>
    ipcRenderer.send('prompts:used', { id, variableValues }),

  /** 把当前输入存成新提示词。 */
  savePrompt: (title: string, content: string): Promise<string> =>
    ipcRenderer.invoke('prompts:save', { title, content }),

  /* ---------- 笔记本 ---------- */

  /** 搜笔记。空串返回全部（按热度）；group 只看那一组。groups 是全库分组。 */
  searchNotes: (
    query: string,
    group?: string,
  ): Promise<{ notes: NoteSummary[]; groups: string[] }> =>
    ipcRenderer.invoke('notes:search', { query, group }),

  /** 存一条笔记。name 可以写成「分组/标题」。 */
  saveNote: (name: string, content: string): Promise<string> =>
    ipcRenderer.invoke('notes:save', { name, content }),

  /** 把笔记内容写进剪贴板（不进剪贴板历史），返回是否成功。 */
  copyNote: (id: string): Promise<boolean> => ipcRenderer.invoke('notes:copy', id),

  /** 请主进程调整输入条窗口高度，用于容纳提示词列表。 */
  resizeInput: (height: number): void => ipcRenderer.send('input:resize', height),

  /* ---------- 剪贴板历史 ---------- */

  /** 取剪贴板历史，新的在前。 */
  listClips: (): Promise<ClipSummary[]> => ipcRenderer.invoke('clips:list'),

  /**
   * 把某条图片放回系统剪贴板，返回是否成功。
   * 图片送不进任何投递目标，只能这样交回给用户自己 Ctrl+V。
   */
  putClipImage: (id: string): Promise<boolean> => ipcRenderer.invoke('clips:put-image', id),

  clearClips: (): Promise<void> => ipcRenderer.invoke('clips:clear'),

  /** 历史有变动（新复制了东西、或被清空）。列表开着时据此重画。 */
  onClipsChanged: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('clips:changed', handler);
    return () => ipcRenderer.off('clips:changed', handler);
  },

  /* ---------- 临时篮子 ---------- */

  listBasketItems: (): Promise<BasketItem[]> => ipcRenderer.invoke('basket:list'),
  getBasketStatus: (): Promise<BasketStatus> => ipcRenderer.invoke('basket:status'),
  setBasketPolicy: (
    retentionDays: BasketStatus['retentionDays'],
    capacityMb: BasketStatus['capacityMb'],
    removeOnDragOut: boolean,
    shakeEnabled?: boolean,
    shakeSensitivity?: BasketStatus['shakeSensitivity'],
    suppressInFullscreen?: boolean,
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('basket:policy', {
      retentionDays,
      capacityMb,
      removeOnDragOut,
      shakeEnabled,
      shakeSensitivity,
      suppressInFullscreen,
    }),
  clearBasket: (): Promise<{ removed: number; failed: number; cancelled: boolean }> => ipcRenderer.invoke('basket:clear'),
  previewBasketItem: (id: string): Promise<BasketPreview | null> => ipcRenderer.invoke('basket:preview', id),
  renameBasketItem: (id: string, baseName: string): Promise<{ ok: boolean; name?: string; message?: string }> =>
    ipcRenderer.invoke('basket:rename', id, baseName),
  copyBasketItem: (id: string): Promise<boolean> => ipcRenderer.invoke('basket:copy', id),
  trashBasketItem: (id: string): Promise<boolean> => ipcRenderer.invoke('basket:trash', id),

  /**
   * Electron 32 起 File.path 已移除，必须在 preload 里用 webUtils 取真实路径。
   * 没有磁盘路径的内存图片（例如网页直接拖出的图片）转成 base64 交给主进程落盘。
   */
  addToBasket: async (
    files: File[],
    text: string,
  ): Promise<{ added: number; message?: string }> => {
    const paths: string[] = [];
    const images: Array<{ name: string; mimeType: string; base64: string }> = [];

    for (const file of files) {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) {
        paths.push(filePath);
      } else if (file.type.startsWith('image/')) {
        const bytes = Buffer.from(await file.arrayBuffer());
        images.push({ name: file.name, mimeType: file.type, base64: bytes.toString('base64') });
      }
    }

    return ipcRenderer.invoke('basket:add', { paths, images, text });
  },

  openBasketItem: (id: string): Promise<boolean> => ipcRenderer.invoke('basket:open-item', id),
  dragBasketItem: (id: string): void => ipcRenderer.send('basket:drag-items', [id]),
  dragBasketItems: (ids: string[]): void => ipcRenderer.send('basket:drag-items', ids),
  removeBasketItems: (ids: string[]): Promise<{ count: number; failed: number }> => ipcRenderer.invoke('basket:remove', ids),
  undoBasketRemoval: (token: string): Promise<number> => ipcRenderer.invoke('basket:undo', token),
  onBasketRemoved: (cb: (info: BasketRemovedInfo) => void): (() => void) => {
    const handler = (_event: unknown, info: BasketRemovedInfo) => cb(info);
    ipcRenderer.on('basket:removed', handler);
    return () => ipcRenderer.off('basket:removed', handler);
  },
  /** 浮层窗口的出入场，见主进程 surface.ts。 */
  onSurfacePhase: (cb: (phase: 'enter' | 'leave' | 'reset') => void): (() => void) => {
    const handler = (_event: unknown, phase: 'enter' | 'leave' | 'reset') => cb(phase);
    ipcRenderer.on('surface:phase', handler);
    return () => ipcRenderer.off('surface:phase', handler);
  },
  showBasketItemMenu: (id: string): void => ipcRenderer.send('basket:item-menu', id),
  closeBasket: (): void => ipcRenderer.send('basket:close'),
  setBasketMode: (mode: 'shelf' | 'full'): void => ipcRenderer.send('basket:set-mode', mode),
  onBasketShown: (cb: (mode: 'shelf' | 'full') => void): (() => void) => {
    const handler = (_event: unknown, mode: 'shelf' | 'full') => cb(mode);
    ipcRenderer.on('basket:shown', handler);
    return () => ipcRenderer.off('basket:shown', handler);
  },
  onBasketChanged: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('basket:changed', handler);
    return () => ipcRenderer.off('basket:changed', handler);
  },
  onBasketToast: (cb: (message: string) => void): (() => void) => {
    const handler = (_event: unknown, message: string) => cb(message);
    ipcRenderer.on('basket:toast', handler);
    return () => ipcRenderer.off('basket:toast', handler);
  },
  onBasketPreviewRequest: (cb: (id: string) => void): (() => void) => {
    const handler = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on('basket:preview-request', handler);
    return () => ipcRenderer.off('basket:preview-request', handler);
  },
  onBasketRenameRequest: (cb: (id: string) => void): (() => void) => {
    const handler = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on('basket:rename-request', handler);
    return () => ipcRenderer.off('basket:rename-request', handler);
  },

  /* ---------- 目标面板 ---------- */

  /** 面板加载完成，取初始数据（可用性随后异步推送）。 */
  panelReady: (): Promise<PanelData> => ipcRenderer.invoke('panel:ready'),

  /** 订阅可用性检测结果。 */
  onPanelData: (cb: (data: PanelData) => void): (() => void) => {
    const handler = (_e: unknown, data: PanelData) => cb(data);
    ipcRenderer.on('panel:data', handler);
    return () => ipcRenderer.off('panel:data', handler);
  },

  closePanel: (): void => ipcRenderer.send('panel:close'),
};

contextBridge.exposeInMainWorld('xfb', api);

export type XfbApi = typeof api;
