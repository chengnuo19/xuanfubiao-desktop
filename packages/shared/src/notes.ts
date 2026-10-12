/**
 * 笔记本的数据模型与检索。
 *
 * 笔记是常用命令、代码片段这类「拿来复制」的东西，和提示词分开存：
 * 提示词是填进输入条发给 AI 的，带变量、分类固定；笔记选中就进剪贴板，
 * 分组是用户随手起的名字。混在一个库里两边都得到处判分支。
 */

import { usageBonus, type PromptUsage } from './prompts.js';

export interface Note {
  id: string;
  title: string;
  content: string;
  /** 分组。没有就归「未分组」。 */
  group?: string;
  /** 同提示词：不持久化在 notes 数组里，读取时从 store.usage 合并进来。 */
  usage?: PromptUsage;
}

export interface NoteStore {
  schemaVersion: 1;
  notes: Note[];
  usage: Record<string, PromptUsage>;
}

export const EMPTY_NOTE_STORE: NoteStore = {
  schemaVersion: 1,
  notes: [],
  usage: {},
};

export const UNGROUPED_LABEL = '未分组';

/**
 * 把「分组/标题」拆开。只切第一个斜杠——标题里本来就可能带路径。
 * 全角斜杠也认，理由同提示词变量里的全角冒号：中文输入法下太容易打出来。
 */
export function parseNoteName(input: string): { group?: string; title: string } {
  const m = /^([^/／]*)[/／](.*)$/s.exec(input);
  if (!m) return { title: input.trim() };
  const group = (m[1] ?? '').trim();
  const title = (m[2] ?? '').trim();
  return group ? { group, title } : { title };
}

/**
 * 进笔记模式的行首字符。`。` 是中文输入法下按句号键打出来的，
 * `.` 留给切不回中文的时候——和 `/` 进提示词模式同一套规则：整条内容以它开头才算。
 */
export const NOTE_PREFIXES = ['。', '.'] as const;

/** 以笔记前缀开头就返回去掉前缀后的查询，否则 null。 */
export function noteQueryOf(value: string): string | null {
  for (const prefix of NOTE_PREFIXES) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

/** 全库出现过的分组，按首次出现的顺序去重。给筛选 chip 用，不含「未分组」。 */
export function noteGroups(notes: readonly Note[]): string[] {
  const seen = new Set<string>();
  for (const n of notes) {
    const g = n.group?.trim();
    if (g) seen.add(g);
  }
  return [...seen];
}

/**
 * 打分：标题 > 分组 > 正文，再叠使用热度。返回 null 表示不匹配。
 * 空查询时人人 0 分起步，排序全看热度。
 */
export function scoreNote(note: Note, query: string): number | null {
  const q = query.trim().toLowerCase();
  const title = note.title.toLowerCase();
  const group = (note.group ?? '').toLowerCase();

  let base: number;
  if (!q) base = 0;
  else if (title === q) base = 1000;
  else if (title.startsWith(q)) base = 800;
  else if (title.includes(q)) base = 600;
  else if (group && (group.includes(q) || q.includes(group))) base = 400;
  else if (note.content.toLowerCase().includes(q)) base = 200;
  else return null;

  return base + usageBonus(note.usage);
}

/** 纯函数排序，同分保持原顺序。limit 省略即不截断。 */
export function rankNotes(notes: readonly Note[], query: string, limit?: number): Note[] {
  const ranked = notes
    .map((note, index) => ({ note, index, score: scoreNote(note, query) }))
    .filter((e): e is { note: Note; index: number; score: number } => e.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ note }) => note);
  return limit === undefined ? ranked : ranked.slice(0, limit);
}
