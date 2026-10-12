import type { BasketItem, BasketPreview, BasketRemovedInfo, BasketStatus } from './env';
import './surface.js';

type Filter = 'all' | 'file' | 'image' | 'text' | 'url';

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`临时篮子的 DOM 结构不完整：${selector}`);
  return element;
}

const basket = required<HTMLElement>('#basket');
const items = required<HTMLElement>('#items');
const empty = required<HTMLElement>('#empty');
const emptyTitle = required<HTMLElement>('#empty h2');
const emptyMessage = required<HTMLElement>('#empty p');
const summary = required<HTMLElement>('#summary');
const navCount = required<HTMLElement>('#navCount');
const searchInput = required<HTMLInputElement>('#searchInput');
const settingsButton = required<HTMLButtonElement>('#settingsButton');
const sidebarSettingsButton = required<HTMLButtonElement>('#sidebarSettingsButton');
const settingsPopover = required<HTMLElement>('#settingsPopover');
const retentionSelect = required<HTMLSelectElement>('#retentionSelect');
const capacitySelect = required<HTMLSelectElement>('#capacitySelect');
const usageText = required<HTMLElement>('#usageText');
const storageText = required<HTMLElement>('#storageText');
const storageBar = required<HTMLElement>('#storageBar');
const clearButton = required<HTMLButtonElement>('#clearButton');
const addButton = required<HTMLButtonElement>('#addButton');
const emptyAddButton = required<HTMLButtonElement>('#emptyAddButton');
const fileInput = required<HTMLInputElement>('#fileInput');
const sortButton = required<HTMLButtonElement>('#sortButton');
const closeButton = required<HTMLButtonElement>('#closeButton');
const statusActions = required<HTMLElement>('#statusActions');
const copyButton = required<HTMLButtonElement>('#copyButton');
const renameButton = required<HTMLButtonElement>('#renameButton');
const deleteButton = required<HTMLButtonElement>('#deleteButton');
const openButton = required<HTMLButtonElement>('#openButton');
const previewButton = required<HTMLButtonElement>('#previewButton');
const inspectorMore = required<HTMLButtonElement>('#inspectorMore');
const inspectorBody = required<HTMLElement>('#inspectorBody');
const contextMenu = required<HTMLElement>('#contextMenu');
const capacityNotice = required<HTMLElement>('#capacityNotice');
const capacityMessage = required<HTMLElement>('#capacityMessage');
const capacitySettingsButton = required<HTMLButtonElement>('#capacitySettingsButton');
const toast = required<HTMLElement>('#toast');
const toastText = required<HTMLElement>('#toastText');
const previewModal = required<HTMLElement>('#previewModal');
const previewTitle = required<HTMLElement>('#previewTitle');
const previewContent = required<HTMLElement>('#previewContent');
const previewMeta = required<HTMLElement>('#previewMeta');
const previewClose = required<HTMLButtonElement>('#previewClose');
const renameModal = required<HTMLElement>('#renameModal');
const renameForm = required<HTMLFormElement>('#renameForm');
const renameInput = required<HTMLInputElement>('#renameInput');
const renameExtension = required<HTMLElement>('#renameExtension');
const renameClose = required<HTMLButtonElement>('#renameClose');
const renameCancel = required<HTMLButtonElement>('#renameCancel');
const toastAction = required<HTMLButtonElement>('#toastAction');
const dragOutSwitch = required<HTMLInputElement>('#dragOutSwitch');
const shakeSwitch = required<HTMLInputElement>('#shakeSwitch');
const sensitivitySelect = required<HTMLSelectElement>('#sensitivitySelect');
const suppressFullscreenSwitch = required<HTMLInputElement>('#suppressFullscreenSwitch');
const sensitivityRow = required<HTMLElement>('#sensitivityRow');
const suppressFullscreenRow = required<HTMLElement>('#suppressFullscreenRow');
const dragAllButton = required<HTMLElement>('#dragAllButton');
const shelfListHead = required<HTMLElement>('#shelfListHead');
const shelfDragAll = required<HTMLElement>('#shelfDragAll');
const collapseButton = required<HTMLButtonElement>('#collapseButton');
const expandButton = required<HTMLButtonElement>('#expandButton');
const shelfCloseButton = required<HTMLButtonElement>('#shelfCloseButton');
const shelfCount = required<HTMLElement>('#shelfCount');
const shelfDrop = required<HTMLElement>('#shelfDrop');
const shelfDropTitle = required<HTMLElement>('#shelfDropTitle');
const shelfDropHint = required<HTMLElement>('#shelfDropHint');
const shelfList = required<HTMLElement>('#shelfList');
const shelfMore = required<HTMLButtonElement>('#shelfMore');

/** 投放架里最多列出的最近项目数，其余的去完整管理器里看。 */
const SHELF_RECENT_LIMIT = 5;
/** 摇出投放架却没放东西、鼠标也不在窗口上，这么久之后自动收起。 */
const SHELF_IDLE_HIDE_MS = 4000;

let allItems: BasketItem[] = [];
let selectedId: string | null = null;
let selectedPreview: BasketPreview | null = null;
let currentFilter: Filter = 'all';
let sortNewestFirst = true;
let previewRequest = 0;
let renamingId: string | null = null;
/** 最近一次可撤销的移除，给 Ctrl+Z 用；过了撤销窗口就清掉。 */
let lastRemoval: { token: string; expiresAt: number } | null = null;
/** 正在从篮子往外拖。自己的拖动经过自己时不该亮起“松手放进来”的遮罩。 */
let draggingOut = false;
/** 列表行按 id 复用：内容没变就不重建，免得每次刷新整表闪一下、丢焦点。 */
const rowCache = new Map<string, { signature: string; row: HTMLElement }>();
/** 右侧预览当前展示的是哪一项的哪个版本；没变就不重新读取。 */
let inspectedKey = '';
let toastTimer: number | null = null;
let shelfIdleTimer: number | null = null;
let shelfDropTimer: number | null = null;
/** 本次唤出后是否已经放进过东西；放过就不再自动收起。 */
let droppedSinceShown = false;
let previewReturnFocus: HTMLElement | null = null;

const isShelf = (): boolean => basket.dataset.mode === 'shelf';

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const iconFor = (kind: BasketItem['kind']): string => ({
  file: 'file',
  directory: 'folder',
  text: 'text',
  url: 'link',
  image: 'image',
})[kind];

const kindLabel = (kind: BasketItem['kind']): string => ({
  file: '文件',
  directory: '文件夹',
  text: '文本',
  url: '链接',
  image: '图片',
})[kind];

function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function detailFor(item: BasketItem): string {
  if (item.kind === 'directory') return '文件夹';
  if (item.kind === 'url') return '网页链接';
  const extension = item.name.includes('.') ? item.name.split('.').pop()?.toUpperCase() : '';
  return extension ? `${extension} ${kindLabel(item.kind)}` : kindLabel(item.kind);
}

interface ToastAction {
  label: string;
  run: () => void;
}

let toastActionHandler: (() => void) | null = null;

function showToast(message: string, action?: ToastAction, durationMs = 2200): void {
  toastText.textContent = message;
  toastActionHandler = action?.run ?? null;
  toastAction.hidden = !action;
  if (action) toastAction.textContent = action.label;
  toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, durationMs);
}

function hideToast(): void {
  toast.hidden = true;
  toastActionHandler = null;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = null;
}

function signatureOf(item: BasketItem): string {
  return `${item.name}|${item.size}|${item.createdAt}|${item.thumbnail?.length ?? 0}`;
}

function removeItems(ids: string[]): void {
  if (ids.length === 0) return;
  void window.xfb.removeBasketItems(ids);
}

async function undoLastRemoval(): Promise<void> {
  if (!lastRemoval || lastRemoval.expiresAt < Date.now()) {
    lastRemoval = null;
    return;
  }
  const { token } = lastRemoval;
  lastRemoval = null;
  const restored = await window.xfb.undoBasketRemoval(token);
  showToast(restored > 0 ? `已恢复 ${restored} 项` : '已经送进回收站，无法撤销');
}

function handleRemoved(info: BasketRemovedInfo): void {
  const verb = info.reason === 'clear' ? '已清空' : info.reason === 'drag' ? '已拖出并移出' : '已移除';
  const failedNote = info.failed > 0 ? `，${info.failed} 项正被占用未移除` : '';
  if (info.count === 0) {
    showToast(`${info.failed} 项正被占用，暂时无法移除`);
    return;
  }
  lastRemoval = { token: info.token, expiresAt: Date.now() + info.undoMs };
  showToast(`${verb} ${info.count} 项${failedNote}`, { label: '撤销', run: () => void undoLastRemoval() }, info.undoMs);
}

/** 原生拖出。必须在 dragstart 的同步链路里发出去，见主进程 basket:drag-items。 */
function startDragOut(event: DragEvent, ids: string[]): void {
  event.preventDefault();
  if (ids.length === 0) return;
  draggingOut = true;
  window.xfb.dragBasketItems(ids);
}

function visibleItems(): BasketItem[] {
  const query = searchInput.value.trim().toLocaleLowerCase('zh-CN');
  return allItems
    .filter((item) => {
      const matchesFilter = currentFilter === 'all'
        || (currentFilter === 'file' && (item.kind === 'file' || item.kind === 'directory'))
        || item.kind === currentFilter;
      return matchesFilter && (!query || item.name.toLocaleLowerCase('zh-CN').includes(query));
    })
    .sort((a, b) => sortNewestFirst ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
}

function renderRows(focusSelected = false): void {
  const visible = visibleItems();
  const rows = visible.map((item) => {
    const signature = signatureOf(item);
    const hit = rowCache.get(item.id);
    const row = hit && hit.signature === signature ? hit.row : createRow(item);
    rowCache.set(item.id, { signature, row });
    const selected = item.id === selectedId;
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
    return row;
  });
  const alive = new Set(allItems.map((item) => item.id));
  for (const id of rowCache.keys()) if (!alive.has(id)) rowCache.delete(id);
  // 顺序和节点都没变时不碰 DOM：重新插入会让正在键盘操作的那一行丢掉焦点。
  const current = [...items.children];
  if (current.length !== rows.length || rows.some((row, index) => current[index] !== row)) {
    items.replaceChildren(...rows);
  }
  dragAllButton.hidden = visible.length < 2;
  empty.hidden = visible.length > 0;
  if (visible.length === 0) {
    const filtered = allItems.length > 0;
    emptyTitle.textContent = filtered ? '没有匹配的内容' : '临时篮子为空';
    emptyMessage.textContent = filtered ? '尝试更换筛选条件或搜索词。' : '将内容拖进窗口，或者从本机选择文件。';
    emptyAddButton.hidden = filtered;
  }
  if (focusSelected && selectedId) {
    document.querySelector<HTMLElement>(`.file-row[data-id="${CSS.escape(selectedId)}"]`)?.focus();
  }
}

function fileVisual(item: BasketItem): HTMLElement {
  const visual = document.createElement('div');
  visual.className = `file-icon ${item.kind === 'directory' ? 'folder' : item.kind}`;
  if (item.thumbnail) {
    const image = document.createElement('img');
    image.src = item.thumbnail;
    image.alt = '';
    visual.append(image);
  } else {
    visual.append(icon(iconFor(item.kind)));
  }
  return visual;
}

/** 投放架只列最近几项，已经在列表里的行不重建，免得每次刷新都重播入场动画。 */
function renderShelf(): void {
  const recent = [...allItems].sort((a, b) => b.createdAt - a.createdAt).slice(0, SHELF_RECENT_LIMIT);
  const existing = new Map([...shelfList.children].map((node) => [(node as HTMLElement).dataset.id, node as HTMLElement]));
  shelfList.replaceChildren(...recent.map((item) => {
    const kept = existing.get(item.id);
    if (kept && kept.dataset.name === item.name) return kept;
    return createShelfItem(item);
  }));
  shelfCount.textContent = String(allItems.length);
  shelfListHead.hidden = recent.length === 0;
  shelfDragAll.hidden = allItems.length < 2;
  shelfDragAll.textContent = `拖出全部 ${allItems.length} 项`;
  shelfMore.hidden = allItems.length <= recent.length;
  shelfMore.textContent = `查看全部 ${allItems.length} 项`;
}

function createShelfItem(item: BasketItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'shelf-item';
  row.dataset.id = item.id;
  row.dataset.name = item.name;
  row.draggable = true;
  row.tabIndex = 0;
  row.setAttribute('role', 'listitem');
  row.title = `${item.name}\n拖出使用 · 双击打开`;
  const copy = document.createElement('div');
  copy.className = 'shelf-item-copy';
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = item.name;
  const detail = document.createElement('span');
  detail.className = 'file-detail';
  detail.textContent = item.kind === 'directory' ? detailFor(item) : `${detailFor(item)} · ${formatSize(item.size)}`;
  copy.append(name, detail);
  row.append(fileVisual(item), copy);
  row.addEventListener('dblclick', () => void window.xfb.openBasketItem(item.id));
  row.addEventListener('keydown', (event) => handleShelfItemKeydown(event, item.id));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.xfb.showBasketItemMenu(item.id);
  });
  row.addEventListener('dragstart', (event) => startDragOut(event, [item.id]));
  return row;
}

function handleShelfItemKeydown(event: KeyboardEvent, id: string): void {
  const rows = [...shelfList.querySelectorAll<HTMLElement>('.shelf-item')];
  const index = rows.findIndex((row) => row.dataset.id === id);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    void window.xfb.openBasketItem(id);
  } else if (event.key === ' ' || event.code === 'Space') {
    event.preventDefault();
    void showPreview(id);
  } else if (event.key === 'Delete') {
    event.preventDefault();
    // 删掉后焦点落到下一项（没有就上一项），连按 Delete 能一路删下去。
    (rows[index + 1] ?? rows[index - 1])?.focus();
    removeItems([id]);
  } else if (event.ctrlKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    void window.xfb.copyBasketItem(id).then((ok) => showToast(ok ? '已复制' : '复制失败'));
  }
}

function playEnterAnimation(): void {
  basket.classList.remove('entering');
  void basket.offsetWidth;
  basket.classList.add('entering');
}

function applyMode(mode: 'shelf' | 'full'): void {
  basket.dataset.mode = mode;
  closeContextMenu();
  closeSettings();
  playEnterAnimation();
  if (mode === 'shelf') {
    droppedSinceShown = false;
    resetShelfDrop();
    armShelfIdleHide();
  } else {
    cancelShelfIdleHide();
  }
}

function armShelfIdleHide(): void {
  cancelShelfIdleHide();
  if (!isShelf() || droppedSinceShown) return;
  shelfIdleTimer = window.setTimeout(() => {
    shelfIdleTimer = null;
    if (isShelf() && !droppedSinceShown) window.xfb.closeBasket();
  }, SHELF_IDLE_HIDE_MS);
}

function cancelShelfIdleHide(): void {
  if (shelfIdleTimer === null) return;
  window.clearTimeout(shelfIdleTimer);
  shelfIdleTimer = null;
}

function resetShelfDrop(): void {
  if (shelfDropTimer !== null) window.clearTimeout(shelfDropTimer);
  shelfDropTimer = null;
  shelfDrop.classList.remove('done');
  shelfDropTitle.textContent = '拖到这里暂存';
  shelfDropHint.textContent = '文件、图片、文本、链接都可以';
}

/** 投放架太小，toast 会盖住列表，所以放入结果直接写在投放区里。 */
function showShelfResult(title: string, hint: string, ok: boolean): void {
  resetShelfDrop();
  shelfDrop.classList.toggle('done', ok);
  shelfDropTitle.textContent = title;
  shelfDropHint.textContent = hint;
  shelfDropTimer = window.setTimeout(resetShelfDrop, 2200);
}

function createRow(item: BasketItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.id = item.id;
  row.tabIndex = 0;
  row.draggable = true;
  row.setAttribute('role', 'option');

  const main = document.createElement('div');
  main.className = 'file-main';
  const visual = fileVisual(item);
  const copy = document.createElement('div');
  copy.className = 'file-copy';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = item.name;
  const detail = document.createElement('div');
  detail.className = 'file-detail';
  detail.textContent = detailFor(item);
  copy.append(name, detail);
  main.append(visual, copy);

  const kind = document.createElement('span');
  kind.className = 'file-kind';
  kind.textContent = kindLabel(item.kind);
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = item.kind === 'directory' ? '—' : formatSize(item.size);
  const time = document.createElement('span');
  time.className = 'file-time';
  time.textContent = formatTime(item.createdAt);
  const more = document.createElement('button');
  more.className = 'icon-button row-more';
  more.type = 'button';
  more.setAttribute('aria-label', `${item.name} 的更多操作`);
  more.append(icon('more'));

  row.append(main, kind, size, time, more);
  row.addEventListener('click', () => selectItem(item.id));
  row.addEventListener('dblclick', () => void window.xfb.openBasketItem(item.id));
  row.addEventListener('keydown', (event) => handleRowKeydown(event, item.id));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    selectItem(item.id);
    openContextMenu(event.clientX, event.clientY);
  });
  row.addEventListener('dragstart', (event) => startDragOut(event, [item.id]));
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    selectItem(item.id);
    const rect = more.getBoundingClientRect();
    openContextMenu(rect.right - 180, rect.bottom + 4);
  });
  return row;
}

function handleRowKeydown(event: KeyboardEvent, id: string): void {
  const visible = visibleItems();
  const index = visible.findIndex((item) => item.id === id);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index + offset))];
    if (next) selectItem(next.id, true);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    void showPreview(id);
  } else if (event.key === ' ' || event.code === 'Space') {
    event.preventDefault();
    void showPreview(id);
  }
}

function selectItem(id: string, focus = false): void {
  const unchanged = selectedId === id && inspectedKey === inspectorKeyFor(id);
  selectedId = id;
  renderRows(focus);
  updateSelectedActions();
  if (!unchanged) {
    selectedPreview = null;
    void renderInspector(id);
  }
}

function inspectorKeyFor(id: string): string {
  const item = allItems.find((candidate) => candidate.id === id);
  return item ? `${id}|${signatureOf(item)}` : '';
}

function updateSelectedActions(): void {
  const hasSelection = selectedId !== null && allItems.some((item) => item.id === selectedId);
  statusActions.hidden = !hasSelection;
  openButton.disabled = !hasSelection;
  previewButton.disabled = !hasSelection;
  inspectorMore.disabled = !hasSelection;
}

/** 预览一般几十毫秒就回来；只有真慢的时候才显示“正在读取”，否则就是白白闪一下。 */
const PREVIEW_PLACEHOLDER_DELAY_MS = 150;

async function renderInspector(id: string): Promise<void> {
  const request = ++previewRequest;
  inspectedKey = inspectorKeyFor(id);
  const placeholderTimer = window.setTimeout(() => {
    if (request !== previewRequest) return;
    inspectorBody.replaceChildren(Object.assign(document.createElement('div'), { className: 'inspector-empty', textContent: '正在读取预览…' }));
  }, PREVIEW_PLACEHOLDER_DELAY_MS);
  const preview = await window.xfb.previewBasketItem(id).finally(() => window.clearTimeout(placeholderTimer));
  if (request !== previewRequest || selectedId !== id) return;
  if (!preview) {
    inspectedKey = '';
    inspectorBody.replaceChildren(Object.assign(document.createElement('div'), { className: 'inspector-empty', textContent: '项目已不存在' }));
    return;
  }
  selectedPreview = preview;
  const visual = document.createElement('div');
  visual.className = 'preview-visual';
  if (preview.imageDataUrl) {
    const image = document.createElement('img');
    image.src = preview.imageDataUrl;
    image.alt = preview.name;
    visual.append(image);
  } else {
    visual.append(icon(iconFor(preview.kind)));
  }
  const copy = document.createElement('div');
  copy.className = 'preview-copy';
  const title = document.createElement('strong');
  title.textContent = preview.name;
  const type = document.createElement('span');
  type.textContent = kindLabel(preview.kind);
  copy.append(title, type);
  const fragment = document.createDocumentFragment();
  fragment.append(visual, copy);
  if (preview.text !== undefined) {
    const text = document.createElement('pre');
    text.className = 'preview-text';
    text.textContent = preview.text;
    fragment.append(text);
  }
  const properties = document.createElement('dl');
  properties.className = 'property-list';
  appendProperty(properties, '大小', formatSize(preview.size));
  appendProperty(properties, '加入时间', new Date(preview.modifiedAt).toLocaleString('zh-CN'));
  appendProperty(properties, '类型', kindLabel(preview.kind));
  fragment.append(properties);
  inspectorBody.replaceChildren(fragment);
}

function appendProperty(list: HTMLDListElement, label: string, value: string): void {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  list.append(row);
}

function updateStatus(status: BasketStatus): void {
  const capacityBytes = status.capacityMb * 1024 * 1024;
  const capacity = status.capacityMb === 0 ? '不限制' : formatSize(capacityBytes);
  const percent = status.capacityMb === 0 ? 0 : Math.min(100, status.totalBytes / capacityBytes * 100);
  summary.textContent = `${status.count} 项 · ${formatSize(status.totalBytes)}`;
  navCount.textContent = String(status.count);
  storageText.textContent = `${formatSize(status.totalBytes)} / ${capacity}`;
  storageBar.style.width = `${percent}%`;
  usageText.textContent = `已用 ${formatSize(status.totalBytes)} / ${capacity}`;
  retentionSelect.value = String(status.retentionDays);
  capacitySelect.value = String(status.capacityMb);
  dragOutSwitch.checked = status.removeOnDragOut;
  shakeSwitch.checked = status.shakeEnabled;
  sensitivitySelect.value = status.shakeSensitivity;
  suppressFullscreenSwitch.checked = status.suppressInFullscreen;
  updateShakeRowsState();
  clearButton.disabled = status.count === 0;
}

async function refresh(): Promise<void> {
  const [result, status] = await Promise.all([window.xfb.listBasketItems(), window.xfb.getBasketStatus()]);
  allItems = result;
  if (selectedId && !allItems.some((item) => item.id === selectedId)) selectedId = null;
  if (!selectedId && allItems.length > 0) selectedId = allItems[0]!.id;
  renderRows();
  renderShelf();
  updateStatus(status);
  updateSelectedActions();
  if (selectedId) {
    if (inspectedKey !== inspectorKeyFor(selectedId)) {
      selectedPreview = null;
      void renderInspector(selectedId);
    }
  } else {
    inspectedKey = '';
    inspectorBody.replaceChildren(Object.assign(document.createElement('div'), { className: 'inspector-empty', textContent: '选择一个项目查看详情' }));
  }
}

function updateShakeRowsState(): void {
  const enabled = shakeSwitch.checked;
  sensitivitySelect.disabled = !enabled;
  suppressFullscreenSwitch.disabled = !enabled;
  sensitivityRow.classList.toggle('disabled', !enabled);
  suppressFullscreenRow.classList.toggle('disabled', !enabled);
}

async function savePolicy(): Promise<void> {
  const retentionDays = Number(retentionSelect.value) as BasketStatus['retentionDays'];
  const capacityMb = Number(capacitySelect.value) as BasketStatus['capacityMb'];
  const sensitivity = sensitivitySelect.value as BasketStatus['shakeSensitivity'];
  const result = await window.xfb.setBasketPolicy(
    retentionDays,
    capacityMb,
    dragOutSwitch.checked,
    shakeSwitch.checked,
    sensitivity,
    suppressFullscreenSwitch.checked,
  );
  showToast(result.ok ? '设置已保存' : '设置无效');
  if (result.ok) await refresh();
}

function openSettings(): void {
  settingsPopover.hidden = false;
  settingsButton.setAttribute('aria-expanded', 'true');
  retentionSelect.focus();
}

function closeSettings(): void {
  settingsPopover.hidden = true;
  settingsButton.setAttribute('aria-expanded', 'false');
}

function toggleSettings(): void {
  if (settingsPopover.hidden) openSettings();
  else closeSettings();
}

function openContextMenu(x: number, y: number): void {
  closeSettings();
  const width = 180;
  const height = 190;
  contextMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  contextMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
  contextMenu.hidden = false;
  contextMenu.querySelector<HTMLButtonElement>('button')?.focus();
}

function closeContextMenu(): void {
  contextMenu.hidden = true;
}

async function showPreview(id: string): Promise<void> {
  previewReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const preview = selectedPreview?.id === id ? selectedPreview : await window.xfb.previewBasketItem(id);
  if (!preview) {
    showToast('项目已不存在');
    return;
  }
  previewTitle.textContent = preview.name;
  previewContent.replaceChildren(previewNode(preview));
  const truncated = preview.textTruncated ? ' · 仅显示前 128 KB' : '';
  previewMeta.textContent = `${formatSize(preview.size)} · ${new Date(preview.modifiedAt).toLocaleString('zh-CN')}${truncated}`;
  previewModal.hidden = false;
  previewClose.focus();
}

function previewNode(preview: BasketPreview): HTMLElement {
  if (preview.imageDataUrl) {
    const image = document.createElement('img');
    image.src = preview.imageDataUrl;
    image.alt = preview.name;
    return image;
  }
  if (preview.text !== undefined) {
    const text = document.createElement('pre');
    text.textContent = preview.text;
    return text;
  }
  const placeholder = document.createElement('div');
  placeholder.className = 'preview-placeholder';
  placeholder.textContent = preview.kind === 'directory' ? '文件夹暂不提供内容预览' : '此文件暂无内容预览';
  return placeholder;
}

async function showRename(id: string): Promise<void> {
  const preview = selectedPreview?.id === id ? selectedPreview : await window.xfb.previewBasketItem(id);
  if (!preview) {
    showToast('项目已不存在');
    return;
  }
  renamingId = id;
  renameInput.value = preview.renameBase;
  const extension = preview.name.slice(preview.renameBase.length);
  renameExtension.textContent = extension ? `扩展名 ${extension} 将保持不变` : '名称不能为空';
  renameModal.hidden = false;
  renameInput.focus();
  renameInput.select();
}

function closeRename(): void {
  renameModal.hidden = true;
  renamingId = null;
}

async function copySelected(): Promise<void> {
  if (!selectedId) return;
  const ok = await window.xfb.copyBasketItem(selectedId);
  showToast(ok ? '已复制' : '复制失败');
}

async function addFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  addButton.disabled = true;
  addButton.setAttribute('aria-busy', 'true');
  try {
    const result = await window.xfb.addToBasket(files, '');
    const message = result.added > 0
      ? `已放入 ${result.added} 项${result.message ? `；${result.message}` : ''}`
      : (result.message ?? '没有可接收的内容');
    showToast(message);
    if (result.message?.includes('超过容量上限')) {
      capacityMessage.textContent = result.message;
      capacityNotice.hidden = false;
    }
  } finally {
    addButton.disabled = false;
    addButton.removeAttribute('aria-busy');
  }
}

async function addDroppedContent(files: File[], text: string): Promise<void> {
  const result = await window.xfb.addToBasket(files, text);
  if (result.added > 0) droppedSinceShown = true;
  if (isShelf()) {
    if (result.added > 0) showShelfResult(`已放入 ${result.added} 项`, result.message ?? '拖出即可使用，双击打开', true);
    else showShelfResult('没有放入', result.message ?? '没有可接收的内容', false);
    return;
  }
  const message = result.added > 0
    ? `已放入 ${result.added} 项${result.message ? `；${result.message}` : ''}`
    : (result.message ?? '没有可接收的内容');
  showToast(message);
  if (result.message?.includes('超过容量上限')) {
    capacityMessage.textContent = result.message;
    capacityNotice.hidden = false;
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    currentFilter = button.dataset.filter as Filter;
    document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-pressed', String(active));
    });
    renderRows();
  });
});

searchInput.addEventListener('input', () => renderRows());
sortButton.addEventListener('click', () => {
  sortNewestFirst = !sortNewestFirst;
  sortButton.classList.toggle('desc', !sortNewestFirst);
  sortButton.setAttribute('aria-label', sortNewestFirst ? '当前最新优先，切换为最早优先' : '当前最早优先，切换为最新优先');
  renderRows();
});

settingsButton.addEventListener('click', (event) => { event.stopPropagation(); toggleSettings(); });
sidebarSettingsButton.addEventListener('click', openSettings);
capacitySettingsButton.addEventListener('click', openSettings);
settingsPopover.addEventListener('click', (event) => event.stopPropagation());
retentionSelect.addEventListener('change', () => void savePolicy());
capacitySelect.addEventListener('change', () => {
  capacityNotice.hidden = true;
  void savePolicy();
});
dragOutSwitch.addEventListener('change', () => void savePolicy());
shakeSwitch.addEventListener('change', () => {
  updateShakeRowsState();
  void savePolicy();
});
sensitivitySelect.addEventListener('change', () => void savePolicy());
suppressFullscreenSwitch.addEventListener('change', () => void savePolicy());

addButton.addEventListener('click', () => fileInput.click());
emptyAddButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  void addFiles([...fileInput.files ?? []]);
  fileInput.value = '';
});

// 结果提示（带撤销）由 onBasketRemoved 统一弹出。
clearButton.addEventListener('click', () => void window.xfb.clearBasket());
toastAction.addEventListener('click', () => {
  const run = toastActionHandler;
  hideToast();
  run?.();
});
dragAllButton.addEventListener('dragstart', (event) => startDragOut(event, visibleItems().map((item) => item.id)));
shelfDragAll.addEventListener('dragstart', (event) => startDragOut(event, allItems.map((item) => item.id)));

copyButton.addEventListener('click', () => void copySelected());
renameButton.addEventListener('click', () => { if (selectedId) void showRename(selectedId); });
deleteButton.addEventListener('click', () => { if (selectedId) removeItems([selectedId]); });
openButton.addEventListener('click', () => { if (selectedId) void window.xfb.openBasketItem(selectedId); });
previewButton.addEventListener('click', () => { if (selectedId) void showPreview(selectedId); });
inspectorMore.addEventListener('click', () => {
  if (!selectedId) return;
  const rect = inspectorMore.getBoundingClientRect();
  openContextMenu(rect.right - 180, rect.bottom + 4);
});

contextMenu.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')?.dataset.action;
  if (!action || !selectedId) return;
  closeContextMenu();
  if (action === 'preview') void showPreview(selectedId);
  else if (action === 'open') void window.xfb.openBasketItem(selectedId);
  else if (action === 'copy') void copySelected();
  else if (action === 'rename') void showRename(selectedId);
  else if (action === 'delete') removeItems([selectedId]);
});

previewClose.addEventListener('click', () => { previewModal.hidden = true; });
previewModal.addEventListener('click', (event) => { if (event.target === previewModal) previewModal.hidden = true; });
renameClose.addEventListener('click', closeRename);
renameCancel.addEventListener('click', closeRename);
renameModal.addEventListener('click', (event) => { if (event.target === renameModal) closeRename(); });
renameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!renamingId) return;
  void window.xfb.renameBasketItem(renamingId, renameInput.value).then((result) => {
    if (!result.ok) {
      showToast(result.message ?? '重命名失败');
      return;
    }
    closeRename();
    showToast('已重命名');
  });
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (draggingOut) return;
  cancelShelfIdleHide();
  dragDepth++;
  basket.dataset.dropping = 'true';
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    delete basket.dataset.dropping;
    armShelfIdleHide();
  }
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  delete basket.dataset.dropping;
  // 拖出去又放回自己身上：什么都不做。
  if (draggingOut) {
    draggingOut = false;
    return;
  }
  if (!event.dataTransfer) return;
  const files = [...event.dataTransfer.files];
  const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  void addDroppedContent(files, text);
});
window.addEventListener('paste', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  const files = [...event.clipboardData?.files ?? []];
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (files.length === 0 && !text.trim()) return;
  event.preventDefault();
  void addDroppedContent(files, text);
});

document.addEventListener('click', (event) => {
  closeContextMenu();
  const target = event.target as Node;
  if (!settingsPopover.contains(target) && !settingsButton.contains(target) && !sidebarSettingsButton.contains(target)) closeSettings();
});

closeButton.addEventListener('click', () => window.xfb.closeBasket());
shelfCloseButton.addEventListener('click', () => window.xfb.closeBasket());
expandButton.addEventListener('click', () => window.xfb.setBasketMode('full'));
shelfMore.addEventListener('click', () => window.xfb.setBasketMode('full'));
collapseButton.addEventListener('click', () => window.xfb.setBasketMode('shelf'));
document.documentElement.addEventListener('mouseenter', cancelShelfIdleHide);
// 原生拖放期间收不到 mousemove；一旦又收到了，说明往外拖已经结束。
window.addEventListener('mousemove', () => { draggingOut = false; });
document.documentElement.addEventListener('mouseleave', armShelfIdleHide);
window.addEventListener('keydown', (event) => {
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (!editing && event.ctrlKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    void undoLastRemoval();
    return;
  }
  if (event.key === 'Escape') {
    if (!renameModal.hidden) closeRename();
    else if (!previewModal.hidden) previewModal.hidden = true;
    else if (!contextMenu.hidden) closeContextMenu();
    else if (!settingsPopover.hidden) closeSettings();
    else window.xfb.closeBasket();
  } else if (!editing && (event.key === ' ' || event.code === 'Space') && !previewModal.hidden) {
    event.preventDefault();
    previewModal.hidden = true;
    previewReturnFocus?.focus();
    previewReturnFocus = null;
  } else if (isShelf()) {
    return;
  } else if (event.ctrlKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (!editing && event.key === 'F2' && selectedId) {
    event.preventDefault();
    void showRename(selectedId);
  } else if (!editing && event.key === 'Delete' && selectedId) {
    event.preventDefault();
    // 删完选中项顺移到下一项，连按 Delete 能一路删下去。
    const visible = visibleItems();
    const index = visible.findIndex((item) => item.id === selectedId);
    const next = visible[index + 1] ?? visible[index - 1];
    removeItems([selectedId]);
    if (next) selectItem(next.id, true);
  } else if (!editing && event.ctrlKey && event.key.toLowerCase() === 'c' && selectedId) {
    event.preventDefault();
    void copySelected();
  }
});

window.xfb.onBasketShown(applyMode);
window.xfb.onBasketChanged(() => {
  draggingOut = false;
  void refresh();
});
window.xfb.onBasketRemoved(handleRemoved);
window.xfb.onBasketToast(showToast);
window.xfb.onBasketPreviewRequest((id) => {
  selectItem(id);
  void showPreview(id);
});
window.xfb.onBasketRenameRequest((id) => {
  selectItem(id);
  void showRename(id);
});
void refresh();
