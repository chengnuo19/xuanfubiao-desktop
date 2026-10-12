import { describe, expect, it } from 'vitest';
import {
  INITIAL_AGENTS_SNAPSHOT,
  isBusyAgentState,
  summarizeClawdSnapshot,
} from './agents.js';

describe('summarizeClawdSnapshot', () => {
  it('returns empty array when raw input is not an object, null, missing sessions, or sessions is not an array', () => {
    expect(summarizeClawdSnapshot(null)).toEqual([]);
    expect(summarizeClawdSnapshot(undefined)).toEqual([]);
    expect(summarizeClawdSnapshot('string')).toEqual([]);
    expect(summarizeClawdSnapshot(123)).toEqual([]);
    expect(summarizeClawdSnapshot(true)).toEqual([]);
    expect(summarizeClawdSnapshot({})).toEqual([]);
    expect(summarizeClawdSnapshot({ sessions: null })).toEqual([]);
    expect(summarizeClawdSnapshot({ sessions: 'not-an-array' })).toEqual([]);
    expect(summarizeClawdSnapshot({ sessions: { id: 's1' } })).toEqual([]);
  });

  it('maps normal session entry with all fields correctly', () => {
    const raw = {
      sessions: [
        {
          id: 's1',
          agentId: 'claude-code',
          agentName: 'Claude Code',
          state: 'working',
          badge: 'running',
          displayTitle: '修 bug',
          displayFolder: 'demo',
          updatedAt: 123,
        },
      ],
    };

    expect(summarizeClawdSnapshot(raw)).toEqual([
      {
        id: 's1',
        agentId: 'claude-code',
        agentName: 'Claude Code',
        state: 'working',
        badge: 'running',
        title: '修 bug',
        folder: 'demo',
        updatedAt: 123,
      },
    ]);
  });

  it('skips entries with hiddenFromHud: true', () => {
    const raw = {
      sessions: [
        {
          id: 's1',
          agentId: 'claude-code',
          hiddenFromHud: true,
        },
        {
          id: 's2',
          agentId: 'codex',
          displayTitle: 'visible task',
        },
      ],
    };

    const result = summarizeClawdSnapshot(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('s2');
  });

  it('skips entries missing id or agentId and handles non-object array items without throwing', () => {
    const raw = {
      sessions: [
        null,
        undefined,
        'string',
        42,
        [],
        {},
        { id: 's-no-agent' },
        { agentId: 'a-no-id' },
        { id: '', agentId: 'a1' },
        { id: 's1', agentId: '' },
        { id: 's-valid', agentId: 'claude-code' },
      ],
    };

    const result = summarizeClawdSnapshot(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('s-valid');
    expect(result[0]?.agentId).toBe('claude-code');
  });

  it('falls back to defaults when agentName, state, badge, or updatedAt are missing', () => {
    const raw = {
      sessions: [
        {
          id: 's1',
          agentId: 'claude-code',
        },
      ],
    };

    expect(summarizeClawdSnapshot(raw)).toEqual([
      {
        id: 's1',
        agentId: 'claude-code',
        agentName: 'claude-code',
        state: 'idle',
        badge: null,
        title: 'claude-code',
        folder: null,
        updatedAt: 0,
      },
    ]);
  });

  it('resolves title fallback: displayTitle -> displayFolder -> agentId', () => {
    const rawWithTitle = {
      sessions: [
        {
          id: 's1',
          agentId: 'agent-1',
          displayTitle: 'Custom Title',
          displayFolder: 'folder-1',
        },
      ],
    };
    expect(summarizeClawdSnapshot(rawWithTitle)[0]?.title).toBe('Custom Title');

    const rawWithFolderOnly = {
      sessions: [
        {
          id: 's2',
          agentId: 'agent-2',
          displayFolder: 'folder-2',
        },
      ],
    };
    expect(summarizeClawdSnapshot(rawWithFolderOnly)[0]?.title).toBe('folder-2');

    const rawWithNeither = {
      sessions: [
        {
          id: 's3',
          agentId: 'agent-3',
        },
      ],
    };
    expect(summarizeClawdSnapshot(rawWithNeither)[0]?.title).toBe('agent-3');
  });

  it('treats whitespace-only strings as missing values', () => {
    const raw = {
      sessions: [
        {
          id: 's1',
          agentId: 'claude-code',
          agentName: '   ',
          state: '  \t  ',
          badge: '   ',
          displayTitle: '   ',
          displayFolder: '   ',
        },
        {
          id: 's2',
          agentId: 'codex',
          displayTitle: '   ',
          displayFolder: 'demo-repo',
        },
      ],
    };

    expect(summarizeClawdSnapshot(raw)).toEqual([
      {
        id: 's1',
        agentId: 'claude-code',
        agentName: 'claude-code',
        state: 'idle',
        badge: null,
        title: 'claude-code',
        folder: null,
        updatedAt: 0,
      },
      {
        id: 's2',
        agentId: 'codex',
        agentName: 'codex',
        state: 'idle',
        badge: null,
        title: 'demo-repo',
        folder: 'demo-repo',
        updatedAt: 0,
      },
    ]);
  });
});

describe('isBusyAgentState', () => {
  it('returns true for busy agent states (thinking, working, juggling, sweeping, carrying)', () => {
    const busyStates = ['thinking', 'working', 'juggling', 'sweeping', 'carrying'];
    for (const state of busyStates) {
      expect(isBusyAgentState(state)).toBe(true);
    }
  });

  it('returns false for non-busy agent states and unknown states', () => {
    const nonBusyStates = ['idle', 'attention', 'notification', 'error', 'sleeping', '', 'unknown'];
    for (const state of nonBusyStates) {
      expect(isBusyAgentState(state)).toBe(false);
    }
  });
});

describe('INITIAL_AGENTS_SNAPSHOT', () => {
  it('has status.kind as off, visual as null, and sessions as empty array', () => {
    expect(INITIAL_AGENTS_SNAPSHOT.status.kind).toBe('off');
    expect(INITIAL_AGENTS_SNAPSHOT.visual).toBeNull();
    expect(INITIAL_AGENTS_SNAPSHOT.sessions).toEqual([]);
  });
});
