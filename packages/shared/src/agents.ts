/**
 * 编码代理那一路的状态，主进程推给渲染层的形状。
 *
 * 状态机本身在 clawd-core 里（移植自 clawd-on-desk 的 state.js），
 * 这里只定义悬浮标自己这一侧要用的摘要——渲染层不该知道 clawd 的内部字段。
 */

/** 一个代理会话。字段取自 clawd 的 session snapshot，只留界面用得上的。 */
export interface AgentSessionSummary {
  /** clawd 的会话 key，形如 `s1.<profile>.<rawId>`，只用来区分行。 */
  id: string;
  /** 注册表里的代理 id：claude-code、codex、antigravity-cli…… */
  agentId: string;
  /** 给人看的代理名。 */
  agentName: string;
  /** clawd 的状态名：idle / thinking / working / juggling / attention / notification / error / sleeping…… */
  state: string;
  /** clawd 归纳出的徽标：running / idle / done / waiting…… */
  badge: string | null;
  /** 会话标题；没有时 clawd 用工作目录的末段兜底。 */
  title: string;
  /** 工作目录末段，即「项目名」。 */
  folder: string | null;
  updatedAt: number;
}

export interface AgentsSnapshot {
  /** 监听现在是什么情况。 */
  status: AgentWatchStatus;
  /**
   * clawd 状态机此刻认为桌宠该是什么样子。
   *
   * 已经按它的优先级、最短展示时长、自动回落都算过了，
   * 渲染层拿来就用，不要再自己合并会话状态。
   */
  visual: { state: string; file: string | null } | null;
  sessions: AgentSessionSummary[];
}

export type AgentWatchStatus =
  /** 设置里关掉了。 */
  | { kind: 'off' }
  /** clawd 本体正在运行，端口段让给它，悬浮标不监听。 */
  | { kind: 'clawd-running' }
  | { kind: 'listening'; port: number }
  /** 端口段全被占用，或者宿主核心加载失败。 */
  | { kind: 'failed'; message: string };

export const INITIAL_AGENTS_SNAPSHOT: AgentsSnapshot = {
  status: { kind: 'off' },
  visual: null,
  sessions: [],
};

/** 这些状态表示会话在干活，用来数「忙着的会话」。 */
const BUSY_STATES = new Set(['thinking', 'working', 'juggling', 'sweeping', 'carrying']);

export function isBusyAgentState(state: string): boolean {
  return BUSY_STATES.has(state);
}

/**
 * 把 clawd 的 session snapshot 收窄成摘要。
 *
 * snapshot 来自移植代码，形状由上游决定，这里逐字段做防御：
 * 上游改了字段名，宁可显示得少一点，也不能让主进程抛异常。
 */
export function summarizeClawdSnapshot(raw: unknown): AgentSessionSummary[] {
  const list = raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : null;
  if (!Array.isArray(list)) return [];
  const out: AgentSessionSummary[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (s.hiddenFromHud === true) continue;
    const id = typeof s.id === 'string' ? s.id : null;
    const agentId = typeof s.agentId === 'string' ? s.agentId : null;
    if (!id || !agentId) continue;
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    const folder = str(s.displayFolder);
    out.push({
      id,
      agentId,
      agentName: str(s.agentName) ?? agentId,
      state: str(s.state) ?? 'idle',
      badge: str(s.badge),
      title: str(s.displayTitle) ?? folder ?? agentId,
      folder,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
    });
  }
  return out;
}

/* ---------- 编码代理设置窗口 ---------- */

/**
 * 一个代理的几个开关，和 clawd 设置里 `agents.<id>` 同名同义。
 * 上游的读法是「不是明确的 false 就算开」，所以没写过的代理显示为全开。
 */
export interface AgentGateFlags {
  /** 收不收这个代理的事件。关掉后它发来的状态一律丢弃。 */
  enabled: boolean;
  /** 它要执行命令时弹不弹权限气泡。关掉就回终端里问。 */
  permissionsEnabled: boolean;
  /** 子代理（比如 Claude Code 的 Task）发起的权限请求弹不弹气泡。 */
  subagentPermissionsEnabled: boolean;
  /** 「等你输入」这类通知要不要让桌宠提醒。 */
  notificationHookEnabled: boolean;
  /** 这个代理的 hooks/插件装没装（悬浮标自己记的，装卸时更新）。 */
  integrationInstalled: boolean;
}

/** 设置窗口里能直接切换的那几个开关。integrationInstalled 只能通过装卸改。 */
export type AgentGateKey = 'enabled' | 'permissionsEnabled' | 'subagentPermissionsEnabled' | 'notificationHookEnabled';

export interface AgentCatalogEntry {
  id: string;
  /** 给人看的名字，来自 clawd 的代理注册表。 */
  name: string;
  /** 这个代理支持哪些开关；不支持的开关在界面上不显示。 */
  supports: {
    permission: boolean;
    subagent: boolean;
    notification: boolean;
  };
  gates: AgentGateFlags;
}

export interface AgentInstallResult {
  ok: boolean;
  /** 用户在确认框里点了取消。 */
  cancelled?: boolean;
  message: string;
}
