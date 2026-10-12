import { describe, expect, it } from 'vitest';
import { BUILTIN_PROMPTS } from './builtinPrompts.js';
import {
  PROMPT_CATEGORIES,
  hasVariables,
  isRememberableValue,
  rankPrompts,
  rememberableValues,
  type Prompt,
} from './prompts.js';

const prompts: Prompt[] = [
  { id: 'unused', title: '未使用', content: '普通正文' },
  {
    id: 'frequent',
    title: '常用项',
    content: '普通正文',
    usage: { count: 50, lastUsedAt: 1_700_000_000_000 },
  },
  {
    id: 'recent',
    title: '最近项',
    content: '普通正文',
    usage: { count: 1, lastUsedAt: 1_750_000_000_000 },
  },
  { id: 'title-hit', title: '错题归因', content: '模型分析', category: 'study' },
  { id: 'body-hit', title: '普通标题', content: '错题归因', category: 'analysis' },
];

describe('rankPrompts', () => {
  it('keeps only the six supported built-in categories', () => {
    expect(PROMPT_CATEGORIES.map((category) => category.id)).toEqual([
      'study',
      'research',
      'analysis',
      'code',
      'writing',
      'image',
    ]);
    expect(BUILTIN_PROMPTS.some((prompt) => prompt.category === 'video')).toBe(false);
    expect(BUILTIN_PROMPTS.some((prompt) => prompt.category === 'commercial')).toBe(false);
  });

  it('orders frequent prompts by existing usage-weighted relevance', () => {
    expect(rankPrompts(prompts, '', 'frequent', 2).map((prompt) => prompt.id)).toEqual([
      'frequent',
      'recent',
    ]);
  });

  it('orders recent prompts by lastUsedAt and excludes unused prompts', () => {
    expect(rankPrompts(prompts, '', 'recent', 12).map((prompt) => prompt.id)).toEqual([
      'recent',
      'frequent',
    ]);
  });

  it('keeps title matches ahead of body matches during search', () => {
    expect(rankPrompts(prompts, '错题归因', 'frequent', 24).map((prompt) => prompt.id)).toEqual([
      'title-hit',
      'body-hit',
    ]);
  });

  it('applies the requested result limit', () => {
    expect(rankPrompts(prompts, '', 'frequent', 1)).toHaveLength(1);
  });
});

describe('built-in prompts', () => {
  it('have unique ids', () => {
    const ids = BUILTIN_PROMPTS.map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /*
    说「下面这段」却没有 {{正文}} 之类的槽位时，选中提示词后光标停在句尾，
    用户粘进来的内容会直接贴在指令最后一个字后面，也分不清哪里是材料。
    要读用户上传图片的那几条例外：图是在目标应用里贴的，不经过输入框。
  */
  it('give every prompt that operates on pasted material a slot for it', () => {
    const refersToMaterial = /下面|这段|这篇|这批|这份|这道题/;
    const missing = BUILTIN_PROMPTS.filter(
      (prompt) =>
        refersToMaterial.test(prompt.content) &&
        !prompt.content.includes('我上传的') &&
        !hasVariables(prompt.content),
    ).map((prompt) => prompt.title);
    expect(missing).toEqual([]);
  });
});

describe('remembered variable values', () => {
  it('keeps short single-line settings', () => {
    expect(isRememberableValue('Nature')).toBe(true);
    expect(isRememberableValue('200')).toBe(true);
  });

  it('drops pasted material so it does not refill the input next time', () => {
    expect(isRememberableValue('第一行\n第二行')).toBe(false);
    expect(isRememberableValue('长'.repeat(41))).toBe(false);
    expect(rememberableValues({ 期刊: 'Nature', 正文: '一段很长的论文\n正文' })).toEqual({
      期刊: 'Nature',
    });
  });
});
