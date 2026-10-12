/**
 * 输入条的渲染逻辑。
 *
 * 基本交互：Enter 送出，Shift+Enter 换行，Esc 收起，Tab 切目标。
 * 提示词：行首打 `/` 唤出列表，Enter 填入；带变量的会停在第一个变量上，Tab 逐个跳。
 * 笔记：行首打 `。` 唤出笔记本，Enter 复制到剪贴板；Ctrl+Shift+S 把当前内容存成笔记。
 * 剪贴板：Ctrl+Shift+V 唤出最近复制过的内容，Enter 插到光标处。
 * Ctrl+S 把当前内容存成提示词。
 *
 * 送出后窗口立刻收起——用户的注意力应该回到手头的事上，
 * 后续进度由悬浮标身上的圆环负责表达。
 */

import {
  expandPrompt,
  categoryLabel,
  PROMPT_CATEGORIES,
  noteQueryOf,
  UNGROUPED_LABEL,
} from '@xfb/shared';
import type { PromptBrowseOrder, PromptCategoryId } from '@xfb/shared';
import type {
  ClipSummary,
  NoteSummary,
  PetState,
  PromptSummary,
  TargetSummary,
} from './env.js';
import './surface.js';

/** 变量填空的落点。位置会随用户编辑平移，见 shiftSlotsAfterEdit。 */
interface Slot {
  name: string;
  start: number;
  end: number;
}

const field = document.getElementById('field') as HTMLTextAreaElement | null;
const targetBtn = document.getElementById('targetBtn');
const targetLabel = document.getElementById('targetLabel');
const targetDot = document.getElementById('targetDot');
const targetIcon = document.getElementById('targetIcon');
const targetIconImg = document.getElementById('targetIconImg') as HTMLImageElement | null;
const picker = document.getElementById('picker');
const promptList = document.getElementById('prompts');
const promptToolbar = document.getElementById('promptToolbar');
const promptFilters = document.getElementById('promptFilters');
const promptSummary = document.getElementById('promptSummary');
const hint = document.getElementById('hint');
/* 工具条分左右两块：左边归状态文字，右边归键帽。 */
const hintMain = document.getElementById('hintMain');
const hintKeys = document.getElementById('hintKeys');
const bar = document.getElementById('bar');

if (
  !field ||
  !targetBtn ||
  !targetLabel ||
  !targetDot ||
  !targetIcon ||
  !targetIconImg ||
  !picker ||
  !promptList ||
  !promptToolbar ||
  !promptFilters ||
  !promptSummary ||
  !hint ||
  !hintMain ||
  !hintKeys ||
  !bar
) {
  throw new Error('输入条的 DOM 结构不完整');
}

let targets: TargetSummary[] = [];
/**
 * 这次要投给哪些目标，第一个是主目标。
 * 多于一个是在目标面板里 Ctrl+点击加出来的，同一个问题会同时送往几家。
 */
let selectedIds: string[] = [];
/** 主目标。图标、状态点这些只容得下一个目标的地方都看它。 */
let currentId = '';

function setSelected(ids: string[]): void {
  selectedIds = ids;
  currentId = ids[0] ?? '';
}

/*
  每个目标现在发不发得过去，由主进程的 checkAllTargets 推来（和目标面板同一份）。
  查不到 = 还没检测完，这时状态点显示「检测中」而不是猜一个。
*/
const targetAvailability = new Map<string, boolean>();
/** 不可用的人话原因，挂在按钮的悬停提示里。 */
const targetReason = new Map<string, string>();

/**
 * 输入条的模式。
 * 'naming' 时输入框里装的是标题而不是正文，按键含义整体改变，所以单独成一个模式。
 */
type Mode = 'normal' | 'prompts' | 'naming' | 'clips' | 'notes';
let mode: Mode = 'normal';

/** prompts 模式的状态 */
let results: PromptSummary[] = [];
type PromptView = 'frequent' | 'recent' | 'category' | 'search';
let promptView: PromptView = 'frequent';
let activeCategory: PromptCategoryId | null = null;
/** 每次发请求递增；较早的响应回来时发现编号过期就直接丢弃。 */
let promptRequestId = 0;
/** clips 模式的状态。和 results 共用 activeIndex 与同一个列表容器。 */
let clips: ClipSummary[] = [];
/** notes 模式的状态。与 results、clips 共用 activeIndex 与同一个列表容器。 */
let notes: NoteSummary[] = [];
let noteGroupsList: string[] = [];
let activeNoteGroup: string | null = null;
let noteRequestId = 0;
let activeIndex = 0;

/** 变量填空的状态。slots 非空即表示正处在填空过程中。 */
let slots: Slot[] = [];
let slotIndex = -1;
let activePromptId: string | null = null;
let lastLength = 0;

/** naming 模式下暂存的正文。 */
let pendingContent = '';
let namingKind: 'prompt' | 'note' = 'prompt';

/** 工具条右侧常驻的那排键帽。 */
const DEFAULT_KEYS =
  '<kbd>Enter</kbd> 送出 · <kbd>Tab</kbd> 换目标 · <kbd>/</kbd> 提示词 · <kbd>。</kbd> 笔记 · <kbd>Ctrl+Shift+V</kbd> 剪贴板';

/** 列表开着的时候换成跟列表有关的那几个——那会儿 Tab 换目标已经不是当前该做的事了。 */
const LIST_KEYS = '<kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 使用 · <kbd>Esc</kbd> 关闭';

/** 笔记列表开着的时候底栏显示的键帽。 */
const NOTE_KEYS = '<kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 复制 · <kbd>Esc</kbd> 关闭';

/**
 * 当前是否有非说不可的状态文字（送出中、出错、正在填变量、命名中）。
 * 有的话提示行必须留着，不能被「打字了就让位」的规则收掉。
 */
let stickyHint = false;

/**
 * 没有状态文字时的提示行去留。
 *
 * 那排快捷键用几次就记住了，一直挂在输入框下面是纯噪音。
 * 规则定成「输入框为空才显示」：每次唤起都还能照面一次，
 * 一开始打字就把地方让给正文。
 */
function applyDefaultHint(): void {
  if (stickyHint) return;
  hintMain!.replaceChildren();
  hintKeys!.innerHTML = DEFAULT_KEYS;
  hintKeys!.hidden = false;
  delete hint!.dataset['tone'];
  hint!.hidden = field!.value.length > 0;
  syncWindowHeight();
}

function setHint(text: string | null, tone?: 'error' | 'busy' | 'ok'): void {
  if (!text) {
    stickyHint = false;
    applyDefaultHint();
    return;
  }
  stickyHint = true;
  hintMain!.replaceChildren(document.createTextNode(text));
  // 有话要说的时候键帽让位：一行里两边各说各的会互相干扰。
  hintKeys!.hidden = true;
  hint!.hidden = false;
  if (tone) hint!.dataset['tone'] = tone;
  else delete hint!.dataset['tone'];
  // 提示文字可能换行，高度跟着变，要同步给窗口。
  syncWindowHeight();
}

/** 提示词模式下，底栏只解释当前列表的键盘操作。 */
function showPromptKeys(): void {
  stickyHint = true;
  delete hint!.dataset['tone'];
  hintMain!.replaceChildren();
  hintKeys!.innerHTML = LIST_KEYS;
  hintKeys!.hidden = false;
  hint!.hidden = false;
  syncWindowHeight();
}

/** 笔记模式下，底栏只解释当前笔记列表的键盘操作。 */
function showNoteKeys(): void {
  stickyHint = true;
  delete hint!.dataset['tone'];
  hintMain!.replaceChildren();
  hintKeys!.innerHTML = NOTE_KEYS;
  hintKeys!.hidden = false;
  hint!.hidden = false;
  syncWindowHeight();
}

/* ---------- 尺寸 ---------- */

/**
 * textarea 按内容增高，并把整条的高度同步给主进程。
 * 先把高度归零再读 scrollHeight，否则内容变少时高度不会回落。
 */
function autoGrow(): void {
  field!.style.height = 'auto';
  field!.style.height = `${field!.scrollHeight}px`;
  syncWindowHeight();
}

/**
 * 把整条的高度同步给主进程。
 *
 * 必须等到下一帧再量：同步调用时刚改过的 DOM 还没重新布局，
 * offsetHeight 读到的是旧值，窗口就会比内容矮一截（底部被切掉）。
 * rAF 顺带起到去抖作用——一次交互里多处调用只会真正量一次。
 */
/*
  本体四周留给投影的透明边，单边。

  只有伪玻璃那条路有：投影是 CSS 画的，不留边会被窗口边缘切掉。
  走亚克力时投影归 DWM，窗口本身就是面板，一点余量都不留。
  这个值必须和主进程的 CARD_MARGIN 一致（见 windows.ts），
  对不上的话窗口会比内容高一截或矮一截。
*/
const CARD_MARGIN = document.documentElement.dataset['material'] === 'acrylic' ? 0 : 8;

let heightSyncQueued = false;
function syncWindowHeight(): void {
  if (heightSyncQueued) return;
  heightSyncQueued = true;
  requestAnimationFrame(() => {
    heightSyncQueued = false;
    window.xfb.resizeInput(bar!.offsetHeight + CARD_MARGIN * 2);
  });
}

/* ---------- 目标 ---------- */

/**
 * 目标图标与目标面板共用同一批文件，文件名就是目标 id。
 * 两处认同一个视觉，切目标时不用重新辨认。
 */
function iconFor(targetId: string): string {
  return `icons/${targetId}.png`;
}

/** 图标文件缺失时的文字占位，按品牌给。 */
function fallbackLetter(targetId: string): string {
  if (targetId.startsWith('chatgpt')) return 'GPT';
  if (targetId.startsWith('gemini')) return 'G';
  return '?';
}

function paintTarget(): void {
  const t = targets.find((x) => x.id === currentId);
  /*
    按钮很窄，用短名；完整名字留给悬停提示。
    同时发给多个目标时补一个 +N——否则「这条要发去两个地方」这件事
    在按下回车之前完全看不出来，而它恰恰是按之前最该知道的。
  */
  const extra = selectedIds.length - 1;
  targetLabel!.textContent = t ? (extra > 0 ? `${t.shortLabel} +${extra}` : t.shortLabel) : '未选择';

  /*
    状态点走**真实**检测结果。

    这里以前是 `delivery === 'web' ? 'offline' : 'online'`——桌面端一律显示
    「能发」、网页端一律显示「不能发」，一次都没查过。于是它和目标面板会对同一个
    目标给出相反的答案：面板说 ChatGPT 网页可用（绿点），输入条上同时是灰的。
    这个点的全部意义就是回答「现在发过去能不能成」，答错还不如不显示。

    检测是异步的，没回来之前是 'unknown'（轻轻呼吸），别假装已经知道了。
  */
  const available = t ? targetAvailability.get(t.id) : undefined;
  targetDot!.dataset['state'] =
    available === true ? 'online' : available === false ? 'offline' : 'unknown';

  const reason = t ? targetReason.get(t.id) : undefined;
  const others = selectedIds
    .slice(1)
    .map((id) => targets.find((x) => x.id === id)?.shortLabel ?? id)
    .join('、');
  targetBtn!.title = t
    ? `当前目标：${t.label}（Tab 切换）${others ? `
同时发给：${others}` : ''}${
        available === false ? `\n现在发不过去：${reason ?? '不可用'}` : ''
      }`
    : '切换投递目标';

  if (!t) return;
  /*
    每次切目标都要先清掉上一次的兜底标记，否则一旦有哪个图标加载失败过，
    后面所有目标都会卡在那个占位字母上——img 被 CSS 隐藏了，换了 src 也看不见。
  */
  delete targetIcon!.dataset['fallback'];
  targetIconImg!.src = iconFor(t.id);
}

/*
  可用性回来了。每次唤起输入条都会重新检测一轮——窗口开没开、扩展连没连，
  随时都在变，缓存一次就不准了。
*/
window.xfb.onTargetStatus((list) => {
  for (const t of list) {
    if (t.available === null) targetAvailability.delete(t.id);
    else targetAvailability.set(t.id, t.available);
    if (t.reason) targetReason.set(t.id, t.reason);
    else targetReason.delete(t.id);
  }
  /*
    记一笔。状态点只有 6px，肉眼分不出「确定不可用」（静止的灰）和
    「还在检测」（呼吸的灰）——而这两者的含义差很远。
    用户报「点是灰的，可应用明明开着」时，这一行直接给出程序当时的判断和理由。
  */
  console.log(
    `[输入条] 可用性 ${list
      .map((t) => `${t.shortLabel}=${t.available === null ? '检测中' : t.available ? '可用' : `不可用(${t.reason ?? '未说明'})`}`)
      .join('  ')}`,
  );
  paintTarget();
});

targetIconImg.addEventListener('error', () => {
  const t = targets.find((x) => x.id === currentId);
  targetIcon!.dataset['fallback'] = fallbackLetter(t?.id ?? '');
});

function closePicker(): void {
  picker!.setAttribute('hidden', '');
  syncWindowHeight();
}

function openPicker(): void {
  picker!.innerHTML = '';
  for (const t of targets) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'picker-item';
    item.setAttribute('aria-selected', String(t.id === currentId));

    const icon = document.createElement('img');
    icon.className = 'picker-icon';
    icon.src = iconFor(t.id);
    icon.alt = '';
    // 加载失败就整个撤掉图标位，留一个破图标比没图标更难看。
    icon.addEventListener('error', () => icon.remove());

    item.append(icon, t.label);
    item.addEventListener('click', () => {
      void selectTarget(t.id);
      closePicker();
      field!.focus();
    });
    picker!.appendChild(item);
  }
  picker!.removeAttribute('hidden');
  syncWindowHeight();
}

async function selectTarget(id: string): Promise<void> {
  setSelected(await window.xfb.selectTarget(id));
  paintTarget();
}

function cycleTarget(backwards: boolean): void {
  if (targets.length === 0) return;
  const idx = targets.findIndex((t) => t.id === currentId);
  const next = (idx + (backwards ? -1 : 1) + targets.length) % targets.length;
  const target = targets[next];
  if (!target) return;

  /*
    先在本地落定再异步告诉主进程。
    否则连按 Tab 时，第二次会读到上一次 IPC 还没写回的旧 currentId，
    于是原地打转——连按三下只前进了一格。
  */
  setSelected([target.id]);
  paintTarget();
  void window.xfb.selectTarget(target.id);
}

/* ---------- 提示词列表 ---------- */

function enterPromptMode(): void {
  if (mode === 'prompts') return;
  closePicker();
  if (mode === 'clips') closeClips();
  if (mode === 'notes') closeNotes(true);

  mode = 'prompts';
  clearSlots();
  promptView = 'frequent';
  activeCategory = null;
  bar!.dataset['mode'] = 'prompts';
  field!.placeholder = '搜索提示词名称、用途或关键词';
  promptToolbar!.removeAttribute('hidden');
  promptList!.setAttribute('role', 'listbox');
  promptList!.setAttribute('aria-label', '提示词结果');
  renderPromptToolbar();
  showPromptKeys();
}

function closePrompts(clearQuery = false): void {
  mode = 'normal';
  results = [];
  promptRequestId++;
  promptView = 'frequent';
  activeCategory = null;
  delete bar!.dataset['mode'];
  field!.placeholder = '说点什么，回车送出；打 / 找提示词';
  promptToolbar!.setAttribute('hidden', '');
  promptFilters!.replaceChildren();
  promptSummary!.textContent = '';
  promptList!.setAttribute('hidden', '');
  promptList!.removeAttribute('role');
  promptList!.removeAttribute('aria-label');
  if (clearQuery) {
    field!.value = '';
    lastLength = 0;
    autoGrow();
  }
  setHint(null);
  syncWindowHeight();
}

function appendPromptFilter(
  label: string,
  pressed: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'cat-chip';
  chip.textContent = label;
  chip.setAttribute('aria-pressed', String(pressed));
  chip.setAttribute('aria-controls', 'prompts');
  chip.addEventListener('click', () => {
    onClick();
    field!.focus();
  });
  promptFilters!.appendChild(chip);
  return chip;
}

/** 分类表是唯一来源；新增分类会自动出现在这排筛选里。 */
function renderPromptToolbar(): void {
  promptFilters!.replaceChildren();

  appendPromptFilter('常用', promptView === 'frequent', () => {
    activatePromptView('frequent');
  });
  appendPromptFilter('最近', promptView === 'recent', () => {
    activatePromptView('recent');
  });

  for (const category of PROMPT_CATEGORIES) {
    appendPromptFilter(
      category.label,
      promptView === 'category' && activeCategory === category.id,
      () => activatePromptView('category', category.id),
    );
  }
}

function activatePromptView(view: 'frequent' | 'recent'): void;
function activatePromptView(view: 'category', category: PromptCategoryId): void;
function activatePromptView(view: Exclude<PromptView, 'search'>, category?: PromptCategoryId): void {
  promptView = view;
  activeCategory = view === 'category' ? (category ?? null) : null;

  if (view === 'category' && activeCategory) {
    field!.value = categoryLabel(activeCategory);
  } else {
    field!.value = '';
  }
  lastLength = field!.value.length;

  autoGrow();
  renderPromptToolbar();
  showPromptKeys();

  const query = activeCategory ? categoryLabel(activeCategory) : '';
  const order: PromptBrowseOrder = view === 'recent' ? 'recent' : 'frequent';
  void refreshPrompts(query, order);
}

/**
 * 按分类把结果分组，组的先后按 PROMPT_CATEGORIES 的定义顺序。
 *
 * 组内保持传入的原顺序（也就是打分顺序），不要再排一次——
 * 那是搜索结果的相关度，比分类内部的任何顺序都更该被尊重。
 * 没有 category 的是用户自建的，统一落到末尾一组。
 */
function groupPrompts(list: PromptSummary[]): { label: string; items: PromptSummary[] }[] {
  const groups = new Map<string, PromptSummary[]>();
  for (const p of list) {
    const label = categoryLabel(p.category);
    const bucket = groups.get(label);
    if (bucket) bucket.push(p);
    else groups.set(label, [p]);
  }

  const ordered: { label: string; items: PromptSummary[] }[] = [];
  for (const c of PROMPT_CATEGORIES) {
    const items = groups.get(c.label);
    if (items) {
      ordered.push({ label: c.label, items });
      groups.delete(c.label);
    }
  }
  // 剩下的只可能是「我的」，放最后。
  for (const [label, items] of groups) ordered.push({ label, items });
  return ordered;
}

function appendPromptItem(p: PromptSummary, index: number): void {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'prompt-item';
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', String(index === activeIndex));
  item.dataset['index'] = String(index);

  const title = document.createElement('div');
  title.className = 'prompt-title';
  title.append(p.title);
  if (p.hasVariables) {
    const badge = document.createElement('span');
    badge.className = 'prompt-var-badge';
    badge.textContent = '含变量';
    title.appendChild(badge);
  }

  const preview = document.createElement('div');
  preview.className = 'prompt-preview';
  preview.textContent = p.content.replace(/\s+/g, ' ').slice(0, 60);

  item.append(title, preview);
  item.addEventListener('click', () => void usePrompt(p));
  promptList!.appendChild(item);
}

function promptSummaryLabel(): string {
  if (promptView === 'frequent') return '常用提示词';
  if (promptView === 'recent') return '最近使用';
  if (promptView === 'category') return categoryLabel(activeCategory ?? undefined);
  return '搜索结果';
}

function renderPrompts(): void {
  promptList!.innerHTML = '';
  promptSummary!.textContent = `${promptSummaryLabel()} · ${results.length} 条`;

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'prompt-empty';
    empty.setAttribute('role', 'status');
    empty.textContent =
      promptView === 'recent' ? '还没有最近使用的提示词' : '没有匹配的提示词';
    promptList!.appendChild(empty);
  } else if (promptView === 'search') {
    let i = 0;
    for (const group of groupPrompts(results)) {
      const heading = document.createElement('div');
      heading.className = 'prompt-group';
      heading.textContent = group.label;
      promptList!.appendChild(heading);

      for (const p of group.items) {
        appendPromptItem(p, i);
        i++;
      }
    }
  } else {
    results.forEach((prompt, index) => appendPromptItem(prompt, index));
  }

  promptList!.removeAttribute('hidden');
  syncWindowHeight();
}

/**
 * 上下移动选中项。prompts 与 clips 共用一个容器，所以也共用这一套。
 *
 * activeIndex 是数据数组里的下标，不是 DOM 下标——提示词列表里夹着组标题，
 * 两者对不上，所以统一靠 data-index 反查元素。
 */
function moveActive(delta: number): void {
  const total =
    mode === 'clips' ? clips.length : mode === 'notes' ? notes.length : results.length;
  if (total === 0) return;
  activeIndex = (activeIndex + delta + total) % total;
  if (mode === 'clips') renderClips();
  else if (mode === 'notes') renderNotes();
  else renderPrompts();
  promptList!
    .querySelector(`[data-index="${activeIndex}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

async function refreshPrompts(
  query: string,
  order: PromptBrowseOrder = 'frequent',
): Promise<void> {
  const requestId = ++promptRequestId;
  promptSummary!.textContent = '加载中…';
  const found = await window.xfb.searchPrompts(query, order);
  if (requestId !== promptRequestId || mode !== 'prompts') return;

  // 搜索结果带分组标题，因此数据顺序也按同一分组函数铺平，保证 Enter 不会取错条目。
  results = promptView === 'search' ? groupPrompts(found).flatMap((group) => group.items) : found;
  activeIndex = 0;
  renderPrompts();
}

/* ---------- 笔记本（笔记模式） ---------- */

function enterNotesMode(): void {
  if (mode === 'notes') return;
  closePicker();
  if (mode === 'clips') closeClips();
  if (mode === 'prompts') closePrompts(true);

  mode = 'notes';
  clearSlots();
  activeNoteGroup = null;
  bar!.dataset['mode'] = 'notes';
  field!.placeholder = '搜索笔记标题、分组或内容';
  promptToolbar!.removeAttribute('hidden');
  promptList!.setAttribute('role', 'listbox');
  promptList!.setAttribute('aria-label', '笔记结果');
  showNoteKeys();
}

function closeNotes(clearQuery = false): void {
  mode = 'normal';
  notes = [];
  noteGroupsList = [];
  noteRequestId++;
  activeNoteGroup = null;
  delete bar!.dataset['mode'];
  field!.placeholder = '说点什么，回车送出；打 / 找提示词';
  promptToolbar!.setAttribute('hidden', '');
  promptFilters!.replaceChildren();
  promptSummary!.textContent = '';
  promptList!.setAttribute('hidden', '');
  promptList!.removeAttribute('role');
  promptList!.removeAttribute('aria-label');
  if (clearQuery) {
    field!.value = '';
    lastLength = 0;
    autoGrow();
  }
  setHint(null);
  syncWindowHeight();
}

function renderNoteToolbar(): void {
  promptFilters!.replaceChildren();
  appendPromptFilter('全部', activeNoteGroup === null, () => {
    activeNoteGroup = null;
    field!.value = '';
    lastLength = 0;
    autoGrow();
    renderNoteToolbar();
    void refreshNotes('');
  });

  for (const g of noteGroupsList) {
    appendPromptFilter(g, activeNoteGroup === g, () => {
      activeNoteGroup = g;
      field!.value = '';
      lastLength = 0;
      autoGrow();
      renderNoteToolbar();
      void refreshNotes('', g);
    });
  }
}

/**
 * 按分组对笔记进行归类。
 * 无分组的归 UNGROUPED_LABEL，放最后。
 */
function groupNotes(list: NoteSummary[]): { label: string; items: NoteSummary[] }[] {
  const groups = new Map<string, NoteSummary[]>();
  const ungrouped: NoteSummary[] = [];
  for (const n of list) {
    const g = n.group?.trim();
    if (g) {
      const bucket = groups.get(g);
      if (bucket) bucket.push(n);
      else groups.set(g, [n]);
    } else {
      ungrouped.push(n);
    }
  }

  const ordered: { label: string; items: NoteSummary[] }[] = [];
  for (const [label, items] of groups) {
    ordered.push({ label, items });
  }
  if (ungrouped.length > 0) {
    ordered.push({ label: UNGROUPED_LABEL, items: ungrouped });
  }
  return ordered;
}

function appendNoteItem(n: NoteSummary, index: number): void {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'prompt-item note-item';
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', String(index === activeIndex));
  item.dataset['index'] = String(index);

  const title = document.createElement('div');
  title.className = 'prompt-title';
  title.textContent = n.title;

  const preview = document.createElement('div');
  preview.className = 'prompt-preview';
  preview.textContent = n.content.replace(/\s+/g, ' ').slice(0, 60);

  item.append(title, preview);
  item.addEventListener('click', () => void useNote(n));
  promptList!.appendChild(item);
}

function renderNotes(): void {
  promptList!.innerHTML = '';
  promptSummary!.textContent = activeNoteGroup
    ? `${activeNoteGroup} · ${notes.length} 条`
    : `笔记 · ${notes.length} 条`;

  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'prompt-empty';
    empty.setAttribute('role', 'status');
    const query = field!.value.trim();
    const isLibraryEmpty =
      noteGroupsList.length === 0 && !query && !activeNoteGroup;
    empty.textContent = isLibraryEmpty
      ? '还没有笔记 · 写好内容按 Ctrl+Shift+S 存成笔记'
      : '没有匹配的笔记';
    promptList!.appendChild(empty);
  } else {
    let i = 0;
    for (const group of groupNotes(notes)) {
      const heading = document.createElement('div');
      heading.className = 'prompt-group';
      heading.textContent = group.label;
      promptList!.appendChild(heading);

      for (const n of group.items) {
        appendNoteItem(n, i);
        i++;
      }
    }
  }

  promptList!.removeAttribute('hidden');
  syncWindowHeight();
}

async function refreshNotes(query: string, group?: string): Promise<void> {
  const requestId = ++noteRequestId;
  promptSummary!.textContent = '加载中…';
  const res = await window.xfb.searchNotes(query, group);
  if (requestId !== noteRequestId || mode !== 'notes') return;

  noteGroupsList = res.groups;
  renderNoteToolbar();

  const grouped = groupNotes(res.notes);
  notes = grouped.flatMap((g) => g.items);
  activeIndex = 0;
  renderNotes();
}

async function useNote(n: NoteSummary): Promise<void> {
  const ok = await window.xfb.copyNote(n.id);
  if (ok) {
    closeNotes(true);
    window.xfb.closeInput();
  } else {
    setHint('复制失败，这条笔记可能已被删掉', 'error');
  }
}

/* ---------- 剪贴板历史 ---------- */

/*
  刻意复用提示词那个列表容器（#prompts）和它的样式。
  这样窗口高度同步、滚动条、INPUT_MAX_HEIGHT 封顶全都零改动，
  视觉上两个列表也天然一致——它们本来就是同一种东西：一份可选的素材。

  唤起键用 Ctrl+Shift+V 而不是 //：现有规则是「整条内容以 / 开头就进 prompts 模式」，
  打第二个斜杠时早就进去了。
*/

function relativeTime(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86_400)} 天前`;
}

function closeClips(): void {
  mode = 'normal';
  clips = [];
  promptList!.setAttribute('hidden', '');
  syncWindowHeight();
}

function renderClips(): void {
  promptList!.innerHTML = '';

  if (clips.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'prompt-empty';
    empty.textContent = '剪贴板历史是空的（复制点什么，这里就会有）';
    promptList!.appendChild(empty);
  } else {
    clips.forEach((c, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'prompt-item clip-item';
      item.setAttribute('aria-selected', String(i === activeIndex));
      // 这个列表不分组，下标本来就对得上，但 moveActive 是两边共用的。
      item.dataset['index'] = String(i);

      if (c.kind === 'image' && c.thumbnail) {
        const thumb = document.createElement('img');
        thumb.className = 'clip-thumb';
        thumb.src = c.thumbnail;
        thumb.alt = '';
        item.appendChild(thumb);
      }

      const body = document.createElement('div');
      body.className = 'clip-body';

      const title = document.createElement('div');
      title.className = 'prompt-title clip-title';
      title.textContent =
        c.kind === 'image' ? `图片 ${c.width ?? '?'}×${c.height ?? '?'}` : c.preview;

      const meta = document.createElement('div');
      meta.className = 'prompt-preview';
      /*
        图片那条要把「送不进去」这件事说在前面。
        两条投递链路都只吃文本，选中它只能把图片放回剪贴板——
        与其让用户按了 Enter 才发现，不如在列表里就写明。
      */
      meta.textContent =
        c.kind === 'image'
          ? `${relativeTime(c.copiedAt)} · 只能放回剪贴板，再自己 Ctrl+V`
          : relativeTime(c.copiedAt);

      body.append(title, meta);
      item.appendChild(body);
      item.addEventListener('click', () => void useClip(c));
      promptList!.appendChild(item);
    });
  }

  promptList!.removeAttribute('hidden');
  syncWindowHeight();
}

async function refreshClips(): Promise<void> {
  clips = await window.xfb.listClips();
  if (activeIndex >= clips.length) activeIndex = 0;
  renderClips();
}

async function openClips(): Promise<void> {
  // 打开剪贴板列表前先退掉其它浮层，免得两个列表抢同一个容器。
  closePicker();
  if (mode === 'prompts') closePrompts(true);
  if (mode === 'notes') closeNotes(true);
  mode = 'clips';
  activeIndex = 0;
  await refreshClips();
}

/**
 * 把一段文字插到光标处。
 *
 * 和提示词的「整体替换」不同是故意的：剪贴板里的东西通常是要贴进
 * 一句已经写了一半的话里的（「这段报错什么意思：<贴在这儿>」）。
 * 输入框为空时光标在 0，效果与填入完全一样。
 */
function insertAtCaret(text: string): void {
  const start = field!.selectionStart;
  const end = field!.selectionEnd;
  const value = field!.value;
  field!.value = value.slice(0, start) + text + value.slice(end);
  const caret = start + text.length;
  // 插入打乱了变量填空的所有位置，没法再推断，直接退出填空模式。
  clearSlots();
  lastLength = field!.value.length;
  field!.focus();
  field!.setSelectionRange(caret, caret);
  autoGrow();
}

async function useClip(c: ClipSummary): Promise<void> {
  if (c.kind === 'image') {
    /*
      图片没法「填进输入条」——两条投递链路（win32 闪切粘贴、扩展操作 DOM）
      都只吃文本。能做的只有把它放回系统剪贴板，剩下的 Ctrl+V 交给用户。
      所以这里**不关输入条**：那句提示得让人看见。
    */
    const ok = await window.xfb.putClipImage(c.id);
    closeClips();
    if (ok) setHint('图片已放回剪贴板 · 切到目标窗口按 Ctrl+V 粘贴', 'ok');
    else setHint('图片文件读不出来了，可能已被清理', 'error');
    field!.focus();
    return;
  }

  closeClips();
  insertAtCaret(c.text);
  setHint(null);
}

/* ---------- 变量填空 ---------- */

function clearSlots(): void {
  slots = [];
  slotIndex = -1;
  activePromptId = null;
}

function focusSlot(i: number): void {
  const s = slots[i];
  if (!s) return;
  slotIndex = i;
  field!.focus();
  field!.setSelectionRange(s.start, s.end);
  setHint(`填写「${s.name}」· Tab 到下一个 · Enter 送出`);
}

/**
 * 用户在当前变量里打字后，把后面的变量位置整体平移。
 *
 * 只在光标确实落在当前变量范围内时才平移——用户点到别处编辑时
 * 位置无从推断，这时直接退出填空模式，宁可不跳也不要跳错。
 */
function shiftSlotsAfterEdit(): void {
  const delta = field!.value.length - lastLength;
  lastLength = field!.value.length;
  if (slotIndex < 0 || delta === 0) return;

  const current = slots[slotIndex];
  if (!current) return;

  const caret = field!.selectionStart;
  if (caret < current.start || caret > current.end + delta) {
    clearSlots();
    setHint(null);
    return;
  }

  current.end += delta;
  for (let i = slotIndex + 1; i < slots.length; i++) {
    const s = slots[i];
    if (!s) continue;
    s.start += delta;
    s.end += delta;
  }
}

/** 收集各变量当前的值，供记忆下次预填。 */
function collectVariableValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of slots) {
    const value = field!.value.slice(s.start, s.end).trim();
    if (value) out[s.name] = value;
  }
  return out;
}

async function usePrompt(p: PromptSummary): Promise<void> {
  const remembered = await window.xfb.rememberedValues(p.id);
  const { text, slots: expanded } = expandPrompt(p.content, remembered);

  field!.value = text;
  lastLength = text.length;
  slots = expanded.map((s) => ({ ...s }));
  activePromptId = p.id;

  closePrompts();
  autoGrow();

  if (slots.length > 0) {
    focusSlot(0);
  } else {
    field!.focus();
    field!.setSelectionRange(text.length, text.length);
    setHint(null);
  }
}

/* ---------- 命名模式（Ctrl+S / Ctrl+Shift+S） ---------- */

function enterNaming(kind: 'prompt' | 'note' = 'prompt'): void {
  const content = field!.value.trim();
  if (!content) return;
  pendingContent = content;
  mode = 'naming';
  namingKind = kind;
  clearSlots();
  field!.value = '';
  if (kind === 'note') {
    field!.placeholder = '笔记标题，可写成 分组/标题，回车保存';
    setHint('正在存为笔记 · Esc 取消', 'busy');
  } else {
    field!.placeholder = '给这条提示词起个名字，回车保存';
    setHint('正在保存为提示词 · Esc 取消', 'busy');
  }
  autoGrow();
}

function exitNaming(restore: boolean): void {
  mode = 'normal';
  field!.placeholder = '说点什么，回车送出；打 / 找提示词';
  field!.value = restore ? pendingContent : '';
  pendingContent = '';
  lastLength = field!.value.length;
  autoGrow();
  setHint(null);
}

async function confirmNaming(): Promise<void> {
  const title = field!.value.trim();
  if (!title) {
    // 静默返回会让人以为程序卡住了，明确说一句。
    setHint('名字不能为空 · Esc 取消', 'error');
    return;
  }
  if (namingKind === 'note') {
    await window.xfb.saveNote(title, pendingContent);
    const saved = title;
    exitNaming(true);
    setHint(`已存为笔记「${saved}」`, 'ok');
  } else {
    await window.xfb.savePrompt(title, pendingContent);
    const saved = title;
    exitNaming(true);
    setHint(`已存为「${saved}」`, 'ok');
  }
}

/* ---------- 送出 ---------- */

async function submit(): Promise<void> {
  const text = field!.value.trim();
  if (!text) return;

  if (activePromptId) {
    window.xfb.recordPromptUsage(activePromptId, collectVariableValues());
  }

  field!.value = '';
  lastLength = 0;
  clearSlots();
  autoGrow();
  setHint(null);
  /*
    失败时文本由主进程随「输入条再次打开」一起还回来（见 restoreInput），
    所以这里照常清空、照常隐藏，不在渲染层另留一份副本等着——
    留副本的话两边就都成了「文本在哪」的真源，迟早对不上。
  */
  await window.xfb.submit(text, selectedIds);
}

/* ---------- 输入与按键 ---------- */

field.addEventListener('input', () => {
  autoGrow();

  if (mode === 'naming') return;

  const value = field!.value;
  if (mode === 'prompts') {
    showPromptKeys();
    if (!value) {
      promptView = 'frequent';
      activeCategory = null;
      renderPromptToolbar();
      void refreshPrompts('', 'frequent');
    } else {
      promptView = 'search';
      activeCategory = null;
      renderPromptToolbar();
      void refreshPrompts(value, 'frequent');
    }
    return;
  }

  if (mode === 'notes') {
    showNoteKeys();
    activeNoteGroup = null;
    renderNoteToolbar();
    void refreshNotes(value);
    return;
  }

  // 仅当整条内容以 / 开头才当作提示词搜索，避免正文里的斜杠误触发。
  if (value.startsWith('/')) {
    const query = value.slice(1);
    enterPromptMode();
    field!.value = query;
    lastLength = query.length;
    autoGrow();
    showPromptKeys();

    if (!query) {
      promptView = 'frequent';
      activeCategory = null;
      renderPromptToolbar();
      void refreshPrompts('', 'frequent');
    } else {
      promptView = 'search';
      activeCategory = null;
      renderPromptToolbar();
      void refreshPrompts(query, 'frequent');
    }
    return;
  }

  const noteQuery = noteQueryOf(value);
  if (noteQuery !== null) {
    enterNotesMode();
    field!.value = noteQuery;
    lastLength = noteQuery.length;
    autoGrow();
    showNoteKeys();
    activeNoteGroup = null;
    renderNoteToolbar();
    void refreshNotes(noteQuery);
    return;
  }

  // 打字就把列表让开。15 条以内不需要搜索，更不该去动用户正在写的内容。
  if (mode === 'clips') closeClips();
  shiftSlotsAfterEdit();
  // 空 ⇄ 非空的切换要让提示行跟着进退。
  applyDefaultHint();
});

field.addEventListener('keydown', (e) => {
  // Enter 留在输入框上处理：需要 isComposing 才能正确避开中文输入法的候选确认。
  if (e.key !== 'Enter' || e.isComposing) return;

  // Shift+Enter 换行，交给 textarea 默认行为。
  if (e.shiftKey) return;

  e.preventDefault();
  if (mode === 'prompts') {
    const chosen = results[activeIndex];
    if (chosen) void usePrompt(chosen);
    return;
  }
  if (mode === 'notes') {
    const chosen = notes[activeIndex];
    if (chosen) void useNote(chosen);
    return;
  }
  if (mode === 'clips') {
    const chosen = clips[activeIndex];
    if (chosen) void useClip(chosen);
    return;
  }
  if (mode === 'naming') {
    void confirmNaming();
    return;
  }
  void submit();
});

/*
  Tab / Esc / ↑↓ 挂在文档级，而不是只挂在输入框上。

  Tab 的默认行为是把焦点移到下一个可聚焦元素（这里是目标按钮）。
  只挂在输入框上的话，第一次 Tab 之后焦点就离开了它，
  后面再按 Tab 就再也进不到这个处理器——表现为「连按三下只前进一格」。
*/
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    // 填空进行中时，Tab 优先用于跳下一个变量。
    if (slots.length > 0 && slotIndex < slots.length - 1) {
      focusSlot(slotIndex + 1);
      return;
    }
    if (mode === 'prompts' || mode === 'clips' || mode === 'notes') {
      moveActive(e.shiftKey ? -1 : 1);
      return;
    }
    cycleTarget(e.shiftKey);
    field!.focus();
    return;
  }

  if (
    (mode === 'prompts' || mode === 'clips' || mode === 'notes') &&
    (e.key === 'ArrowDown' || e.key === 'ArrowUp')
  ) {
    e.preventDefault();
    moveActive(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    // 逐层退出：先关浮层，最后才收起窗口。
    if (!picker!.hasAttribute('hidden')) {
      closePicker();
      field!.focus();
    } else if (mode === 'prompts') {
      closePrompts(true);
      field!.focus();
    } else if (mode === 'notes') {
      closeNotes(true);
      field!.focus();
    } else if (mode === 'clips') {
      closeClips();
      field!.focus();
    } else if (mode === 'naming') {
      exitNaming(true);
      field!.focus();
    } else if (slots.length > 0) {
      clearSlots();
      setHint(null);
      field!.focus();
    } else {
      window.xfb.closeInput();
    }
    return;
  }

  /*
    Ctrl+Shift+V 唤出剪贴板历史。

    挂在文档级而不是输入框上，理由同上面的 Tab：焦点一旦离开输入框
    就再也触发不到。命名模式下不抢这个键——那时输入框里装的是标题。
  */
  if (e.key.toLowerCase() === 'v' && (e.ctrlKey || e.metaKey) && e.shiftKey && mode !== 'naming') {
    e.preventDefault();
    if (mode === 'clips') {
      closeClips();
      field!.focus();
    } else {
      console.log('[输入条] Ctrl+Shift+V 打开剪贴板历史');
      void openClips();
    }
    return;
  }

  // Ctrl+Shift+S 把当前输入存成笔记（仅 normal 模式、输入非空）。
  if (
    e.key.toLowerCase() === 's' &&
    (e.ctrlKey || e.metaKey) &&
    e.shiftKey &&
    mode === 'normal'
  ) {
    e.preventDefault();
    console.log('[输入条] Ctrl+Shift+S 进入笔记命名模式');
    enterNaming('note');
    return;
  }

  // Ctrl+S 存成提示词。搜索状态下不抢这个键。
  if (
    e.key.toLowerCase() === 's' &&
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    mode === 'normal'
  ) {
    e.preventDefault();
    console.log('[输入条] Ctrl+S 进入命名模式');
    enterNaming('prompt');
    return;
  }
});

targetBtn.addEventListener('click', () => {
  if (picker!.hasAttribute('hidden')) openPicker();
  else closePicker();
});

// 窗口每次被唤起都清空并聚焦，保证是一个干净的起点。
window.xfb.onOpened(({ targetIds, restore }) => {
  setSelected(targetIds);
  paintTarget();
  closePicker();
  closePrompts(true);
  closeNotes(true);
  closeClips();
  clearSlots();
  mode = 'normal';
  field!.placeholder = '说点什么，回车送出；打 / 找提示词';

  /*
    平时唤起要清空；但这一次是上条投递一个都没送到、
    主进程把文本还回来了，那就填回去——重打一遍
    是这个工具最不该让人做的事。
  */
  field!.value = restore?.text ?? '';
  lastLength = field!.value.length;
  autoGrow();
  setHint(restore ? `${restore.message}，内容已经还给你` : null, restore ? 'error' : undefined);
  field!.focus();
  /*
    光标放末尾，不全选。还回来的文本多半是要改一两个字
    （或者先把目标窗口打开）再发，全选之后随手一敲就全没了。
  */
  if (restore) field!.setSelectionRange(field!.value.length, field!.value.length);
});

/*
  剪贴板历史变了（用户又复制了东西、或从托盘清空了）。
  列表正开着才有必要重画——没开的话下次打开自然是新的。
*/
window.xfb.onClipsChanged(() => {
  if (mode === 'clips') void refreshClips();
});

// 输入条开着的时候也同步状态，主要是为了立刻看到失败原因。
window.xfb.onState((state: PetState) => {
  if (state.phase === 'error') setHint(state.errorMessage ?? '出错了', 'error');
  else if (state.phase === 'sending') setHint('正在送出…', 'busy');
});

void window.xfb.listTargets().then((res) => {
  targets = res.targets;
  setSelected(res.currentTargetIds);
  paintTarget();
  autoGrow();
  field!.focus();
});
