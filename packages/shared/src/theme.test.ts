import { describe, expect, it } from 'vitest';
import {
  isSafeThemeFile,
  parseTheme,
  petVisualState,
  pickThemeFile,
  resolveHitBox,
  resolveThemeState,
  ThemeError,
  type AgentVisualInput,
  type PetTheme,
} from './theme.js';

describe('isSafeThemeFile', () => {
  it('returns true for relative paths inside theme directory', () => {
    expect(isSafeThemeFile('a/b.svg')).toBe(true);
    expect(isSafeThemeFile('idle.png')).toBe(true);
    expect(isSafeThemeFile('assets/idle/frame1.gif')).toBe(true);
  });

  it('returns false for path traversal', () => {
    expect(isSafeThemeFile('../a')).toBe(false);
    expect(isSafeThemeFile('a/../../b')).toBe(false);
    expect(isSafeThemeFile('..\\a')).toBe(false);
  });

  it('returns false for windows drive paths and root paths', () => {
    expect(isSafeThemeFile('C:/a')).toBe(false);
    expect(isSafeThemeFile('C:\\a')).toBe(false);
    expect(isSafeThemeFile('\\a')).toBe(false);
    expect(isSafeThemeFile('/x.gif')).toBe(false);
  });

  it('returns false for empty or null-byte strings', () => {
    expect(isSafeThemeFile('')).toBe(false);
    expect(isSafeThemeFile('a\0b.gif')).toBe(false);
  });
});

describe('parseTheme', () => {
  it('parses minimal valid theme with correct default values', () => {
    const raw = {
      viewBox: { width: 100, height: 100 },
      states: {
        idle: ['idle.png'],
      },
    };

    const theme = parseTheme(raw);

    expect(theme.name).toBe('未命名主题');
    expect(theme.version).toBe('0.0.0');
    expect(theme.viewBox).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(theme.sleepMode).toBe('full');
    expect(theme.timings).toEqual({
      mouseSleepTimeoutMs: 60000,
      yawnDurationMs: 3000,
      wakeDurationMs: 1500,
    });
    expect(theme.eyeTracking).toEqual({
      enabled: false,
      states: ['idle'],
      eyesId: 'eyes-js',
      bodyId: null,
      shadowId: null,
    });
    expect(theme.reactions).toEqual({
      double: null,
      click: null,
    });
    expect(theme.workingTiers).toEqual([]);
    expect(theme.jugglingTiers).toEqual([]);
    expect(theme.hitBoxes).toEqual({
      default: null,
      sleeping: null,
    });
    expect(theme.states.idle).toEqual({
      files: ['idle.png'],
      fallbackTo: null,
    });
  });

  it('parses states written in three formats', () => {
    const raw = {
      viewBox: { width: 80, height: 80 },
      states: {
        idle: ['idle.png'],
        arrayFormat: ['a.gif'],
        objectWithFiles: { files: ['a.gif'] },
        objectWithFallback: { fallbackTo: 'attention' },
        objectWithFileAndFallback: { file: 'b.gif', fallbackTo: 'idle' },
      },
    };

    const theme = parseTheme(raw);

    expect(theme.states.arrayFormat).toEqual({
      files: ['a.gif'],
      fallbackTo: null,
    });
    expect(theme.states.objectWithFiles).toEqual({
      files: ['a.gif'],
      fallbackTo: null,
    });
    expect(theme.states.objectWithFallback).toEqual({
      files: [],
      fallbackTo: 'attention',
    });
    expect(theme.states.objectWithFileAndFallback).toEqual({
      files: ['b.gif'],
      fallbackTo: 'idle',
    });
  });

  it('throws ThemeError when input is not an object', () => {
    expect(() => parseTheme(null)).toThrow(ThemeError);
    expect(() => parseTheme('string')).toThrow(ThemeError);
    expect(() => parseTheme([])).toThrow(ThemeError);
  });

  it('throws ThemeError when missing viewBox or viewBox width/height <= 0', () => {
    expect(() => parseTheme({ states: { idle: ['idle.png'] } })).toThrow(ThemeError);
    expect(() =>
      parseTheme({
        viewBox: { width: 0, height: 100 },
        states: { idle: ['idle.png'] },
      }),
    ).toThrow(ThemeError);
    expect(() =>
      parseTheme({
        viewBox: { width: 100, height: 0 },
        states: { idle: ['idle.png'] },
      }),
    ).toThrow(ThemeError);
  });

  it('throws ThemeError when missing states or idle has no safe files', () => {
    expect(() =>
      parseTheme({
        viewBox: { width: 100, height: 100 },
      }),
    ).toThrow(ThemeError);

    expect(() =>
      parseTheme({
        viewBox: { width: 100, height: 100 },
        states: { idle: [] },
      }),
    ).toThrow(ThemeError);

    expect(() =>
      parseTheme({
        viewBox: { width: 100, height: 100 },
        states: { idle: ['../unsafe.png'] },
      }),
    ).toThrow(ThemeError);
  });

  it('filters out unsafe paths in state files', () => {
    const raw = {
      viewBox: { width: 100, height: 100 },
      states: {
        idle: ['idle.png'],
        walking: ['../x.gif', 'C:\\x.gif', '/x.gif', 'safe.gif'],
      },
    };

    const theme = parseTheme(raw);
    expect(theme.states.walking?.files).toEqual(['safe.gif']);
  });

  it('sorts workingTiers descending by minSessions and parses reactions.double duration', () => {
    const raw = {
      viewBox: { width: 100, height: 100 },
      states: { idle: ['idle.png'] },
      workingTiers: [
        { minSessions: 2, file: 'w2.gif' },
        { minSessions: 5, file: 'w5.gif' },
        { minSessions: 1, file: 'w1.gif' },
      ],
      reactions: {
        double: { files: ['heart.gif'] },
      },
    };

    const theme = parseTheme(raw);

    expect(theme.workingTiers).toEqual([
      { min: 5, file: 'w5.gif' },
      { min: 2, file: 'w2.gif' },
      { min: 1, file: 'w1.gif' },
    ]);
    expect(theme.reactions.double).toEqual({
      files: ['heart.gif'],
      durationMs: 2500,
    });
  });

  it('parses hitBoxes.default and returns null when w <= 0', () => {
    const validRaw = {
      viewBox: { width: 100, height: 100 },
      states: { idle: ['idle.png'] },
      hitBoxes: {
        default: { x: 5, y: 10, w: 20, h: 30 },
      },
    };
    expect(parseTheme(validRaw).hitBoxes.default).toEqual({
      x: 5,
      y: 10,
      w: 20,
      h: 30,
    });

    const zeroWidthRaw = {
      viewBox: { width: 100, height: 100 },
      states: { idle: ['idle.png'] },
      hitBoxes: {
        default: { x: 5, y: 10, w: 0, h: 30 },
      },
    };
    expect(parseTheme(zeroWidthRaw).hitBoxes.default).toBeNull();
  });
});

describe('resolveThemeState', () => {
  function makeTheme(states: PetTheme['states']): PetTheme {
    return {
      name: 'test',
      version: '1.0.0',
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      frame: null,
      states: {
        idle: { files: ['idle.png'], fallbackTo: null },
        ...states,
      },
      eyeTracking: {
        enabled: false,
        states: ['idle'],
        eyesId: 'eyes-js',
        bodyId: null,
        shadowId: null,
      },
      sleepMode: 'full',
      timings: { mouseSleepTimeoutMs: 60000, yawnDurationMs: 3000, wakeDurationMs: 1500 },
      reactions: { double: null, click: null },
      workingTiers: [],
      jugglingTiers: [],
      hitBoxes: { default: null, sleeping: null },
    };
  }

  it('returns state directly when state has files', () => {
    const theme = makeTheme({
      working: { files: ['working.gif'], fallbackTo: null },
    });
    expect(resolveThemeState(theme, 'working')).toBe('working');
  });

  it('follows explicit fallbackTo chain', () => {
    const theme = makeTheme({
      thinking: { files: [], fallbackTo: 'working' },
      working: { files: ['working.gif'], fallbackTo: null },
    });
    expect(resolveThemeState(theme, 'thinking')).toBe('working');
  });

  it('follows implicit fallback table when no explicit fallback given', () => {
    const themeWithSleeping = makeTheme({
      sleeping: { files: ['sleeping.gif'], fallbackTo: null },
    });
    expect(resolveThemeState(themeWithSleeping, 'dozing')).toBe('sleeping');

    const themeOnlyIdle = makeTheme({});
    expect(resolveThemeState(themeOnlyIdle, 'dozing')).toBe('idle');
  });

  it('breaks circular fallback chain and returns idle without infinite loop', () => {
    const theme = makeTheme({
      stateA: { files: [], fallbackTo: 'stateB' },
      stateB: { files: [], fallbackTo: 'stateA' },
    });
    expect(resolveThemeState(theme, 'stateA')).toBe('idle');
  });

  it('returns idle for unknown state names', () => {
    const theme = makeTheme({});
    expect(resolveThemeState(theme, 'some_unknown_state')).toBe('idle');
  });
});

describe('pickThemeFile', () => {
  const theme: PetTheme = {
    name: 'test',
    version: '1.0.0',
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    frame: null,
    states: {
      idle: { files: ['idle.png'], fallbackTo: null },
      working: { files: ['working-default.gif'], fallbackTo: null },
      juggling: { files: ['juggling-default.gif'], fallbackTo: null },
    },
    eyeTracking: {
      enabled: false,
      states: ['idle'],
      eyesId: 'eyes-js',
      bodyId: null,
      shadowId: null,
    },
    sleepMode: 'full',
    timings: { mouseSleepTimeoutMs: 60000, yawnDurationMs: 3000, wakeDurationMs: 1500 },
    reactions: { double: null, click: null },
    workingTiers: [
      { min: 3, file: 'working-heavy.gif' },
      { min: 2, file: 'working-medium.gif' },
      { min: 1, file: 'working-light.gif' },
    ],
    jugglingTiers: [
      { min: 4, file: 'juggling-many.gif' },
      { min: 2, file: 'juggling-some.gif' },
    ],
    hitBoxes: { default: null, sleeping: null },
  };

  it('picks file by tier when wanted is working and sessions >= tier.min', () => {
    expect(pickThemeFile(theme, 'working', { sessions: 2 })).toEqual({
      state: 'working',
      file: 'working-medium.gif',
    });
  });

  it('falls back to standard states when sessions is 0', () => {
    expect(pickThemeFile(theme, 'working', { sessions: 0 })).toEqual({
      state: 'working',
      file: 'working-default.gif',
    });
  });

  it('picks file by tier when wanted is juggling and subagents >= tier.min', () => {
    expect(pickThemeFile(theme, 'juggling', { subagents: 3 })).toEqual({
      state: 'juggling',
      file: 'juggling-some.gif',
    });
  });
});

describe('petVisualState', () => {
  const baseAgents: AgentVisualInput = { states: [], subagents: 0 };

  it('prioritizes agents notification over phase error', () => {
    expect(
      petVisualState({
        phase: 'error',
        agents: { states: ['notification'], subagents: 0 },
        sleep: 'awake',
      }),
    ).toBe('notification');
  });

  it('returns error when phase is error', () => {
    expect(
      petVisualState({
        phase: 'error',
        agents: baseAgents,
        sleep: 'awake',
      }),
    ).toBe('error');
  });

  it('returns juggling when agents have working and subagents > 0', () => {
    expect(
      petVisualState({
        phase: 'idle',
        agents: { states: ['working'], subagents: 2 },
        sleep: 'awake',
      }),
    ).toBe('juggling');
  });

  it('prioritizes working over thinking according to AGENT_PRIORITY', () => {
    expect(
      petVisualState({
        phase: 'idle',
        agents: { states: ['thinking', 'working'], subagents: 0 },
        sleep: 'awake',
      }),
    ).toBe('working');
  });

  it('returns thinking for phase thinking or sending when agents are inactive', () => {
    expect(
      petVisualState({
        phase: 'thinking',
        agents: baseAgents,
        sleep: 'awake',
      }),
    ).toBe('thinking');

    expect(
      petVisualState({
        phase: 'sending',
        agents: baseAgents,
        sleep: 'awake',
      }),
    ).toBe('thinking');
  });

  it('returns attention for phase done or agents state attention during idle phase', () => {
    expect(
      petVisualState({
        phase: 'done',
        agents: baseAgents,
        sleep: 'awake',
      }),
    ).toBe('attention');

    expect(
      petVisualState({
        phase: 'idle',
        agents: { states: ['attention'], subagents: 0 },
        sleep: 'awake',
      }),
    ).toBe('attention');
  });

  it('handles idle and sleep stages correctly when all else is idle', () => {
    expect(
      petVisualState({
        phase: 'idle',
        agents: baseAgents,
        sleep: 'dozing',
      }),
    ).toBe('dozing');

    expect(
      petVisualState({
        phase: 'idle',
        agents: baseAgents,
        sleep: 'awake',
      }),
    ).toBe('idle');
  });
});

describe('parseTheme frame', () => {
  const base = { viewBox: { x: -15, y: -25, width: 45, height: 45 }, states: { idle: ['idle.svg'] } };
  it('prefers layout.contentBox, falls back to marginBox, else null', () => {
    const both = parseTheme({ ...base, layout: { contentBox: { x: -4, y: -3, width: 23, height: 20 }, marginBox: { x: -8, y: -7, width: 30, height: 24 } } });
    expect(both.frame).toEqual({ x: -4, y: -3, width: 23, height: 20 });
    const margin = parseTheme({ ...base, layout: { marginBox: { x: -8, y: -7, width: 30, height: 24 } } });
    expect(margin.frame).toEqual({ x: -8, y: -7, width: 30, height: 24 });
    expect(parseTheme(base).frame).toBeNull();
    expect(parseTheme({ ...base, layout: { contentBox: { x: 0, y: 0, width: 0, height: 5 } } }).frame).toBeNull();
  });
});

describe('parseTheme advanced fields', () => {
  const base = { viewBox: { x: -15, y: -25, width: 45, height: 45 }, states: { idle: ['idle.svg'] } };

  it('parses anchor when layout has contentBox, centerX, and baselineY, else null', () => {
    const withContentBox = parseTheme({
      ...base,
      layout: {
        contentBox: { x: -5, y: -5, width: 20, height: 20 },
        centerX: 5,
        baselineY: 15,
      },
    });
    expect(withContentBox.anchor).toEqual({ centerX: 5, baselineY: 15 });

    const missingCenterX = parseTheme({
      ...base,
      layout: {
        contentBox: { x: -5, y: -5, width: 20, height: 20 },
        baselineY: 15,
      },
    });
    expect(missingCenterX.anchor).toBeNull();

    const missingContentBox = parseTheme({
      ...base,
      layout: {
        centerX: 5,
        baselineY: 15,
      },
    });
    expect(missingContentBox.anchor).toBeNull();
  });

  it('parses fileViewBoxes, dropping zero-width entries and unsafe paths', () => {
    const theme = parseTheme({
      ...base,
      fileViewBoxes: {
        'a.svg': { x: 0, y: 0, width: 30, height: 30 },
        'zero.svg': { x: 0, y: 0, width: 0, height: 30 },
        '../x.svg': { x: 0, y: 0, width: 30, height: 30 },
      },
    });
    expect(theme.fileViewBoxes).toEqual({
      'a.svg': { x: 0, y: 0, width: 30, height: 30 },
    });
  });

  it('parses fileScales and fileOffsets from objectScale', () => {
    const theme = parseTheme({
      ...base,
      objectScale: {
        fileScales: {
          'pos.svg': 1.5,
          'zero.svg': 0,
          'neg.svg': -1,
        },
        fileOffsets: {
          'offset.svg': { x: 8 },
        },
      },
    });
    expect(theme.fileScales).toEqual({ 'pos.svg': 1.5 });
    expect(theme.fileOffsets).toEqual({ 'offset.svg': { x: 8, y: 0 } });
  });

  it('parses idleAnimations with durationMs, defaulting duration to 6000 and filtering unsafe files', () => {
    const theme = parseTheme({
      ...base,
      idleAnimations: [
        { file: 'look.svg', duration: 6500 },
        { file: 'blink.svg' },
        { file: '../evil.svg', duration: 1000 },
      ],
    });
    expect(theme.idleAnimations).toEqual([
      { file: 'look.svg', durationMs: 6500 },
      { file: 'blink.svg', durationMs: 6000 },
    ]);
  });

  it('parses mouseIdleTimeoutMs from timings.mouseIdleTimeout with default 20000', () => {
    expect(parseTheme(base).mouseIdleTimeoutMs).toBe(20000);
    const custom = parseTheme({
      ...base,
      timings: { mouseIdleTimeout: 12000 },
    });
    expect(custom.mouseIdleTimeoutMs).toBe(12000);
  });

  it('parses dragReaction, falling back file to fileLeft, or null when empty', () => {
    const full = parseTheme({
      ...base,
      reactions: {
        drag: { file: 'd.svg', fileLeft: 'l.svg', fileRight: 'r.svg' },
      },
    });
    expect(full.dragReaction).toEqual({
      file: 'd.svg',
      fileLeft: 'l.svg',
      fileRight: 'r.svg',
    });

    const onlyLeft = parseTheme({
      ...base,
      reactions: {
        drag: { fileLeft: 'l.svg' },
      },
    });
    expect(onlyLeft.dragReaction).toEqual({
      file: 'l.svg',
      fileLeft: 'l.svg',
      fileRight: null,
    });

    const empty = parseTheme({
      ...base,
      reactions: {
        drag: {},
      },
    });
    expect(empty.dragReaction).toBeNull();
  });

  it('parses clickReactions and annoyedReaction from reactions', () => {
    const theme = parseTheme({
      ...base,
      reactions: {
        clickLeft: { file: 'left.svg', duration: 1200 },
        clickRight: { file: 'right.svg' },
        annoyed: { file: 'annoyed.svg', duration: 3200 },
      },
    });
    expect(theme.clickReactions).toEqual({
      left: { files: ['left.svg'], durationMs: 1200 },
      right: { files: ['right.svg'], durationMs: 2500 },
    });
    expect(theme.annoyedReaction).toEqual({
      files: ['annoyed.svg'],
      durationMs: 3200,
    });
  });

  it('parses hitBoxRules including wide, files, wideFiles, and sleepingFiles', () => {
    const theme = parseTheme({
      ...base,
      hitBoxes: {
        wide: { x: 0, y: 0, w: 60, h: 30 },
      },
      fileHitBoxes: {
        'special.svg': { x: 10, y: 10, w: 20, h: 20 },
      },
      wideHitboxFiles: ['wide.svg'],
      sleepingHitboxFiles: ['sleep.svg'],
    });
    expect(theme.hitBoxRules).toEqual({
      wide: { x: 0, y: 0, w: 60, h: 30 },
      files: {
        'special.svg': { x: 10, y: 10, w: 20, h: 20 },
      },
      wideFiles: ['wide.svg'],
      sleepingFiles: ['sleep.svg'],
    });
  });
});

describe('resolveHitBox', () => {
  const base = { viewBox: { x: -15, y: -25, width: 45, height: 45 }, states: { idle: ['idle.svg'] } };

  it('follows priority: fileHitBoxes > sleeping > wide > default', () => {
    const theme = parseTheme({
      ...base,
      hitBoxes: {
        default: { x: 0, y: 0, w: 10, h: 10 },
        sleeping: { x: 1, y: 1, w: 20, h: 20 },
        wide: { x: 2, y: 2, w: 30, h: 30 },
      },
      fileHitBoxes: {
        'conflict.svg': { x: 3, y: 3, w: 40, h: 40 },
      },
      sleepingHitboxFiles: ['conflict.svg', 'sleeping.svg'],
      wideHitboxFiles: ['conflict.svg', 'sleeping.svg', 'wide.svg'],
    });

    expect(resolveHitBox(theme, 'conflict.svg')).toEqual({ x: 3, y: 3, w: 40, h: 40 });
    expect(resolveHitBox(theme, 'sleeping.svg')).toEqual({ x: 1, y: 1, w: 20, h: 20 });
    expect(resolveHitBox(theme, 'wide.svg')).toEqual({ x: 2, y: 2, w: 30, h: 30 });
    expect(resolveHitBox(theme, 'other.svg')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it('returns default hitBox when file is null', () => {
    const theme = parseTheme({
      ...base,
      hitBoxes: {
        default: { x: 0, y: 0, w: 10, h: 10 },
      },
    });
    expect(resolveHitBox(theme, null)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it('returns null when theme has no hitBoxes', () => {
    const theme = parseTheme(base);
    expect(resolveHitBox(theme, 'idle.svg')).toBeNull();
    expect(resolveHitBox(theme, null)).toBeNull();
  });
});

