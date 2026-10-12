/**
 * 编码代理设置页面的交互逻辑。
 *
 * 负责列出所有编码代理、展示监听状态与活跃会话数、
 * 切换各代理功能开关，以及执行 hooks 安装与卸载。
 */

import type {
  AgentCatalogEntry,
  AgentGateKey,
  AgentInstallResult,
  AgentsSnapshot,
} from './env.js';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const agentList = document.getElementById('agentList');

if (!statusDot || !statusText || !agentList) {
  throw new Error('页面缺少核心 DOM 节点');
}

/** 缓存当前最新快照，供更新会话数和状态条使用。 */
let currentSnapshot: AgentsSnapshot | null = null;

/** 缓存当前代理卡片 DOM 节点引用，方便局部刷新会话数与状态。 */
interface AgentCardRecord {
  entry: AgentCatalogEntry;
  cardElement: HTMLElement;
  sessionBadge: HTMLElement;
  installBadge: HTMLElement;
  actionButton: HTMLButtonElement;
  errorBox: HTMLElement;
  switchInputs: Map<AgentGateKey, HTMLInputElement>;
  gateRows: Map<AgentGateKey, HTMLElement>;
}

const cardRecords = new Map<string, AgentCardRecord>();

/**
 * 排序逻辑：
 * `gates.enabled && gates.integrationInstalled` 的排最前，
 * 其余按 `name` 的中文 localeCompare 排序。
 */
function sortAgents(list: AgentCatalogEntry[]): AgentCatalogEntry[] {
  return [...list].sort((a, b) => {
    const aPinned = a.gates.enabled && a.gates.integrationInstalled;
    const bPinned = b.gates.enabled && b.gates.integrationInstalled;
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

/**
 * 更新顶部监听状态条。
 */
function updateStatusBar(status: AgentsSnapshot['status']): void {
  if (status.kind === 'listening') {
    statusDot!.dataset['kind'] = 'listening';
    statusText!.textContent = `正在监听 127.0.0.1:${status.port}`;
  } else if (status.kind === 'clawd-running') {
    statusDot!.dataset['kind'] = 'clawd-running';
    statusText!.textContent = 'clawd 正在运行，悬浮标没有监听。退出 clawd 后在托盘里点「重试」。';
  } else if (status.kind === 'failed') {
    statusDot!.dataset['kind'] = 'failed';
    statusText!.textContent = `没能开始监听：${status.message}`;
  } else {
    statusDot!.dataset['kind'] = 'off';
    statusText!.textContent = '监听已关闭（托盘「编码代理」里可以打开）';
  }
}

/**
 * 计算某个代理当前的会话数。
 */
function countSessions(agentId: string): number {
  if (!currentSnapshot || !Array.isArray(currentSnapshot.sessions)) return 0;
  return currentSnapshot.sessions.filter((session) => session.agentId === agentId).length;
}

/**
 * 刷新单张卡片的会话数徽标。
 */
function refreshCardSessionCount(record: AgentCardRecord): void {
  const count = countSessions(record.entry.id);
  if (count > 0) {
    record.sessionBadge.textContent = `${count} 个会话`;
    record.sessionBadge.style.display = '';
  } else {
    record.sessionBadge.textContent = '';
    record.sessionBadge.style.display = 'none';
  }
}

/**
 * 更新卡片的安装/卸载状态展示。
 */
function refreshCardIntegrationState(record: AgentCardRecord): void {
  const isInstalled = record.entry.gates.integrationInstalled;
  record.installBadge.dataset['installed'] = String(isInstalled);
  record.installBadge.textContent = isInstalled ? '已装 hooks' : '未装';
  record.actionButton.textContent = isInstalled ? '卸载' : '安装';
  record.actionButton.dataset['action'] = isInstalled ? 'uninstall' : 'install';
}

/**
 * 更新单张卡片内所有开关的勾选与禁用联动状态。
 */
function refreshCardGates(record: AgentCardRecord): void {
  const isMasterEnabled = record.entry.gates.enabled;
  record.cardElement.dataset['disabled'] = String(!isMasterEnabled);

  for (const [key, input] of record.switchInputs) {
    input.checked = record.entry.gates[key];
    if (key === 'enabled') {
      input.disabled = false;
    } else {
      input.disabled = !isMasterEnabled;
      const row = record.gateRows.get(key);
      if (row) {
        row.dataset['disabled'] = String(!isMasterEnabled);
      }
    }
  }

  refreshCardIntegrationState(record);
}

/**
 * 切换某一项开关的处理逻辑。
 */
async function handleToggleGate(
  record: AgentCardRecord,
  key: AgentGateKey,
  input: HTMLInputElement,
): Promise<void> {
  const targetValue = input.checked;

  // 调用期间禁用该开关以防连点
  input.disabled = true;
  record.errorBox.textContent = '';

  try {
    const updatedEntry = await window.xfb.setAgentGate(record.entry.id, key, targetValue);
    record.entry = updatedEntry;
    refreshCardGates(record);
  } catch (error) {
    // 失败时拨回原状并在卡片底部提示错误
    input.checked = !targetValue;
    const isMasterEnabled = record.entry.gates.enabled;
    input.disabled = key === 'enabled' ? false : !isMasterEnabled;
    const message = error instanceof Error ? error.message : '保存开关失败，请重试';
    record.errorBox.textContent = message;
  }
}

/**
 * 安装或卸载 hooks。
 */
async function handleInstallAction(record: AgentCardRecord): Promise<void> {
  const isInstalled = record.entry.gates.integrationInstalled;

  // 期间按钮显示「处理中…」并禁用
  record.actionButton.disabled = true;
  record.actionButton.textContent = '处理中…';
  record.errorBox.textContent = '';

  try {
    const result: AgentInstallResult = isInstalled
      ? await window.xfb.uninstallAgent(record.entry.id)
      : await window.xfb.installAgent(record.entry.id);

    if (result.cancelled) {
      // 用户取消时静默恢复
      refreshCardIntegrationState(record);
      record.actionButton.disabled = false;
      return;
    }

    if (!result.ok) {
      // 失败时卡片底部显示红字错误
      record.errorBox.textContent = result.message || (isInstalled ? '卸载失败' : '安装失败');
      refreshCardIntegrationState(record);
      record.actionButton.disabled = false;
      return;
    }

    // 成功后重新刷新整个代理列表
    await reloadAgentList();
  } catch (error) {
    const message = error instanceof Error ? error.message : '操作异常，请重试';
    record.errorBox.textContent = message;
    refreshCardIntegrationState(record);
    record.actionButton.disabled = false;
  }
}

/**
 * 创建单张代理卡片 DOM 结构。
 */
function createAgentCard(entry: AgentCatalogEntry): HTMLElement {
  const card = document.createElement('div');
  card.className = 'agent-card';
  card.dataset['agentId'] = entry.id;

  // 1. 卡片头部
  const header = document.createElement('div');
  header.className = 'card-header';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'card-title-group';

  const nameEl = document.createElement('span');
  nameEl.className = 'agent-name';
  nameEl.textContent = entry.name;

  const sessionBadge = document.createElement('span');
  sessionBadge.className = 'session-badge';
  sessionBadge.style.display = 'none';

  titleGroup.append(nameEl, sessionBadge);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const installBadge = document.createElement('span');
  installBadge.className = 'install-badge';

  const actionButton = document.createElement('button');
  actionButton.type = 'button';
  actionButton.className = 'btn-action';

  actions.append(installBadge, actionButton);
  header.append(titleGroup, actions);

  // 2. 开关列表
  const gatesList = document.createElement('div');
  gatesList.className = 'gates-list';

  const switchInputs = new Map<AgentGateKey, HTMLInputElement>();
  const gateRows = new Map<AgentGateKey, HTMLElement>();

  interface GateOption {
    key: AgentGateKey;
    label: string;
    visible: boolean;
  }

  const gateOptions: GateOption[] = [
    {
      key: 'enabled',
      label: '接收这个代理的状态',
      visible: true,
    },
    {
      key: 'permissionsEnabled',
      label: '弹出权限气泡',
      visible: entry.supports.permission,
    },
    {
      key: 'subagentPermissionsEnabled',
      label: '子代理的权限也弹气泡',
      visible: entry.supports.subagent,
    },
    {
      key: 'notificationHookEnabled',
      label: '需要你回复时提醒',
      visible: entry.supports.notification,
    },
  ];

  for (const option of gateOptions) {
    if (!option.visible) continue;

    const row = document.createElement('div');
    row.className = 'gate-row';

    const label = document.createElement('span');
    label.className = 'gate-label';
    label.textContent = option.label;

    const switchBox = document.createElement('label');
    switchBox.className = 'switch-container';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch-input';
    input.checked = entry.gates[option.key];

    const track = document.createElement('span');
    track.className = 'switch-track';

    switchBox.append(input, track);
    row.append(label, switchBox);
    gatesList.appendChild(row);

    switchInputs.set(option.key, input);
    gateRows.set(option.key, row);
  }

  // 3. 错误信息显示区
  const errorBox = document.createElement('div');
  errorBox.className = 'card-error';

  card.append(header, gatesList, errorBox);

  const record: AgentCardRecord = {
    entry,
    cardElement: card,
    sessionBadge,
    installBadge,
    actionButton,
    errorBox,
    switchInputs,
    gateRows,
  };

  cardRecords.set(entry.id, record);

  // 绑定事件监听
  for (const [key, input] of switchInputs) {
    input.addEventListener('change', () => {
      void handleToggleGate(record, key, input);
    });
  }

  actionButton.addEventListener('click', () => {
    void handleInstallAction(record);
  });

  // 初始化卡片显示状态
  refreshCardGates(record);
  refreshCardSessionCount(record);

  return card;
}

/**
 * 从主进程拉取代理列表并全量渲染。
 */
async function reloadAgentList(): Promise<void> {
  const agents = await window.xfb.listAgents();
  const sorted = sortAgents(agents);

  cardRecords.clear();
  agentList!.innerHTML = '';

  for (const agent of sorted) {
    const cardEl = createAgentCard(agent);
    agentList!.appendChild(cardEl);
  }
}

/**
 * 页面入口初始化。
 */
async function initialize(): Promise<void> {
  try {
    currentSnapshot = await window.xfb.getAgents();
    updateStatusBar(currentSnapshot.status);
  } catch {
    updateStatusBar({ kind: 'off' });
  }

  // 监听快照更新：只更新状态条和各卡片的会话数，不要重建整个列表
  window.xfb.onAgents((snapshot) => {
    currentSnapshot = snapshot;
    updateStatusBar(snapshot.status);
    for (const record of cardRecords.values()) {
      refreshCardSessionCount(record);
    }
  });

  // 渲染代理卡片列表
  await reloadAgentList();
}

void initialize();
