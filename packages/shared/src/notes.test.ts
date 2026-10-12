import { describe, expect, it } from 'vitest';
import {
  parseNoteName,
  noteQueryOf,
  noteGroups,
  rankNotes,
  UNGROUPED_LABEL,
  type Note,
} from './notes.js';

describe('parseNoteName', () => {
  it('parses Git/撤销 into group Git and title 撤销', () => {
    expect(parseNoteName('Git/撤销')).toEqual({ group: 'Git', title: '撤销' });
  });

  it('handles full-width slash Git／撤销', () => {
    expect(parseNoteName('Git／撤销')).toEqual({ group: 'Git', title: '撤销' });
  });

  it('handles title without slash', () => {
    expect(parseNoteName('只有标题')).toEqual({ title: '只有标题' });
  });

  it('ignores empty group before slash', () => {
    expect(parseNoteName('/撤销')).toEqual({ title: '撤销' });
    expect(parseNoteName('／撤销')).toEqual({ title: '撤销' });
  });

  it('splits on first slash only', () => {
    expect(parseNoteName('a/b/c')).toEqual({ group: 'a', title: 'b/c' });
  });

  it('trims whitespace around group and title', () => {
    expect(parseNoteName('  Git / 撤销  ')).toEqual({ group: 'Git', title: '撤销' });
  });
});

describe('noteQueryOf', () => {
  it('extracts query after Chinese full stop', () => {
    expect(noteQueryOf('。git')).toBe('git');
    expect(noteQueryOf('。')).toBe('');
  });

  it('extracts query after ascii dot', () => {
    expect(noteQueryOf('.git')).toBe('git');
    expect(noteQueryOf('.')).toBe('');
  });

  it('returns null for non-note prefixes', () => {
    expect(noteQueryOf('/git')).toBeNull();
    expect(noteQueryOf('git')).toBeNull();
    expect(noteQueryOf('')).toBeNull();
  });
});

describe('noteGroups', () => {
  it('deduplicates groups while preserving first occurrence order and ignores ungrouped', () => {
    const testNotes: Note[] = [
      { id: '1', title: 't1', content: 'c1', group: 'Git' },
      { id: '2', title: 't2', content: 'c2', group: 'Docker' },
      { id: '3', title: 't3', content: 'c3' },
      { id: '4', title: 't4', content: 'c4', group: 'Git' },
      { id: '5', title: 't5', content: 'c5', group: '   ' },
      { id: '6', title: 't6', content: 'c6', group: 'Linux' },
    ];
    expect(noteGroups(testNotes)).toEqual(['Git', 'Docker', 'Linux']);
  });
});

describe('rankNotes', () => {
  const notes: Note[] = [
    {
      id: 'frequent',
      title: '常备命令',
      content: 'curl example.com',
      usage: { count: 30, lastUsedAt: 1_700_000_000_000 },
    },
    {
      id: 'recent',
      title: '最近命令',
      content: 'ping example.com',
      usage: { count: 1, lastUsedAt: 1_750_000_000_000 },
    },
    {
      id: 'title-match',
      title: 'reset soft 撤销提交',
      content: '保留工作区修改',
      group: '其他',
    },
    {
      id: 'group-match',
      title: '硬重置',
      content: '回滚所有修改',
      group: '撤销操作',
    },
    {
      id: 'content-match',
      title: 'Git 回退',
      content: '执行撤销未提交的改动',
      group: '版本控制',
    },
    {
      id: 'unmatched',
      title: '无关笔记',
      content: 'npm run test',
      group: 'Node',
    },
  ];

  it('ranks title matches ahead of group matches, and group matches ahead of content matches', () => {
    const result = rankNotes(notes, '撤销');
    expect(result.map((n) => n.id)).toEqual(['title-match', 'group-match', 'content-match']);
  });

  it('filters out non-matching notes', () => {
    const result = rankNotes(notes, '撤销');
    expect(result.some((n) => n.id === 'unmatched')).toBe(false);
  });

  it('orders by usage bonus when query is empty', () => {
    const result = rankNotes(notes, '');
    expect(result[0]?.id).toBe('frequent');
  });

  it('respects the limit argument', () => {
    const result = rankNotes(notes, '', 2);
    expect(result).toHaveLength(2);
  });
});
