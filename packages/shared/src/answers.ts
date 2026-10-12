/**
 * 回答历史的数据模型。
 *
 * 和剪贴板历史是两件事，别混在一起：剪贴板记的是「我复制过什么」，
 * 这里记的是「我问过什么、对面答了什么」。两者的用途、生命周期
 * 和敏感程度都不一样，共用一个库只会让清空入口变得说不清楚。
 *
 * 条数上限同样定得不高。这不是聊天记录归档——真要长期留存的内容，
 * 它本来就还在 ChatGPT 或 Gemini 自己的对话里，那边才是权威。
 * 这里只负责接住「刚问完的那几个」。
 */

/** 一条问答记录。 */
export interface AnswerItem {
  id: string;
  /** 送出去的原文。 */
  question: string;
  /** 取回来的回答正文。取不到时不会有这条记录。 */
  answer: string;
  /** 哪个目标答的。 */
  targetId: string;
  /** 回答落库的时刻。 */
  answeredAt: number;
  /**
   * 这一问是谁发起的。
   *
   * 'app' 是用户自己在输入条里打的；'api' 是本机其它程序通过
   * 本地接口借用过来的。必须分得清——第二种情况下用户可能
   * 根本不在电脑前，事后要能一眼看出哪些问题不是自己问的。
   */
  origin: 'app' | 'api';
  /** origin 为 'api' 时，调用方自报的名字（比如 claude-code、obsidian）。 */
  client?: string;
}

/**
 * 回答历史的条数上限。
 *
 * 比剪贴板的 15 条多，是因为单条价值更高、产生速率更低：
 * 剪贴板一天能被按几十次，而问 AI 一天十几次已经算高频了。
 */
export const ANSWER_HISTORY_LIMIT = 30;

export interface AnswerStore {
  version: 1;
  items: AnswerItem[];
}

export const EMPTY_ANSWER_STORE: AnswerStore = { version: 1, items: [] };
