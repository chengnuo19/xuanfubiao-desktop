/**
 * 回答历史的读写。
 *
 * 结构照搬 clipboard/store.ts：json 存在 userData，每次现读不做内存缓存，
 * 文件坏了按空库继续跑。理由也一样——这是锦上添花的功能，
 * 没有任何理由因为它挂掉整个悬浮标。
 */

import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ANSWER_HISTORY_LIMIT, EMPTY_ANSWER_STORE, type AnswerItem, type AnswerStore } from '@xfb/shared';

function storePath(): string {
  return path.join(app.getPath('userData'), 'answers.json');
}

function readStore(): AnswerStore {
  const file = storePath();
  if (!existsSync(file)) return { ...EMPTY_ANSWER_STORE, items: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AnswerStore>;
    return {
      ...EMPTY_ANSWER_STORE,
      ...parsed,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (err) {
    console.warn('[回答] answers.json 解析失败，本次按空库处理：', err);
    return { ...EMPTY_ANSWER_STORE, items: [] };
  }
}

function writeStore(store: AnswerStore): void {
  try {
    writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('[回答] 写入失败：', err);
  }
}

export type NewAnswer = Omit<AnswerItem, 'id' | 'answeredAt'>;

/**
 * 记一条。
 *
 * 不做去重：同一个问题问两遍、拿到两份不同的回答，是这个功能最主要的
 * 使用场景之一（「答得不好，再问一遍」），去重会把后一份直接吃掉。
 */
export function addAnswer(entry: NewAnswer): AnswerItem {
  const store = readStore();
  const item: AnswerItem = { ...entry, id: `ans-${randomUUID()}`, answeredAt: Date.now() };
  store.items = [item, ...store.items].slice(0, ANSWER_HISTORY_LIMIT);
  writeStore(store);
  return item;
}

export function listAnswers(): AnswerItem[] {
  return readStore().items;
}

export function countAnswers(): number {
  return readStore().items.length;
}

/**
 * 清空。
 *
 * 和剪贴板历史一样要有一个一直摆在明面上的入口：这里躺着的是
 * 完整的问答正文，比剪贴板历史更值得让用户能随手抹掉。
 */
export function clearAnswers(): void {
  writeStore({ ...EMPTY_ANSWER_STORE, items: [] });
}
