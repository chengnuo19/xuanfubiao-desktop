/**
 * 笔记本的读写。
 *
 * 数据在 userData/notes.json。结构和提示词库一个样（见 prompts.ts），
 * 但单独成文件：笔记是拿来复制的，和发给 AI 的提示词不是一回事。
 */

import { app, shell } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  EMPTY_NOTE_STORE,
  noteGroups,
  parseNoteName,
  rankNotes,
  type Note,
  type NoteStore,
} from '@xfb/shared';

export function notesFilePath(): string {
  return path.join(app.getPath('userData'), 'notes.json');
}

/** 同 prompts.ts：不缓存，用户拿编辑器改完立刻生效。 */
function readStore(): NoteStore {
  const file = notesFilePath();
  if (!existsSync(file)) return { ...EMPTY_NOTE_STORE, notes: [], usage: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<NoteStore>;
    return {
      ...EMPTY_NOTE_STORE,
      ...parsed,
      notes: parsed.notes ?? [],
      usage: parsed.usage ?? {},
    };
  } catch (err) {
    // 手改出语法错误时当空库继续跑，别让应用起不来。
    console.warn('[笔记] notes.json 解析失败，本次按空库处理：', err);
    return { ...EMPTY_NOTE_STORE, notes: [], usage: {} };
  }
}

function writeStore(store: NoteStore): void {
  try {
    writeFileSync(notesFilePath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('[笔记] 写入失败：', err);
  }
}

function withUsage(store: NoteStore): Note[] {
  return store.notes.map((n) => {
    const usage = store.usage[n.id];
    return usage ? { ...n, usage } : n;
  });
}

/**
 * 搜笔记。空查询返回全部、按热度排——笔记是用户自己一条条攒的，
 * 数量有限，不像提示词那样需要截断。group 给了就只看那一组。
 */
export function searchNotes(query: string, group?: string): { notes: Note[]; groups: string[] } {
  const all = withUsage(readStore());
  const pool = group ? all.filter((n) => n.group?.trim() === group) : all;
  return { notes: rankNotes(pool, query), groups: noteGroups(all) };
}

/** 新建一条笔记。name 可以写成「分组/标题」。返回 id。 */
export function saveNote(name: string, content: string): string {
  const store = readStore();
  const { group, title } = parseNoteName(name);
  const id = `note-${randomUUID()}`;
  store.notes.push(group ? { id, title: title || '未命名', content, group } : { id, title: title || '未命名', content });
  writeStore(store);
  return id;
}

export function findNote(id: string): Note | undefined {
  return readStore().notes.find((n) => n.id === id);
}

export function recordNoteUsage(id: string): void {
  const store = readStore();
  const prev = store.usage[id];
  store.usage[id] = { count: (prev?.count ?? 0) + 1, lastUsedAt: Date.now() };
  writeStore(store);
}

export function countNotes(): number {
  return readStore().notes.length;
}

/** 用系统默认编辑器打开笔记文件，不存在就先写一份空的。 */
export async function openNotesFile(): Promise<void> {
  const file = notesFilePath();
  if (!existsSync(file)) writeStore({ ...EMPTY_NOTE_STORE, notes: [], usage: {} });
  await shell.openPath(file);
}
