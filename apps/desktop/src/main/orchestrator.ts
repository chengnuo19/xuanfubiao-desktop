/**
 * 宠物状态的唯一真源。
 *
 * 把「投递」和「进度跟踪」串成一条链，对外只暴露一个 PetState 流。
 * 渲染层不关心消息去了桌面端还是网页端、进度是怎么探出来的，
 * 只认这里广播的状态。
 *
 * 一次提交可以同时送往多个目标（拿两家的回答对照着看），每个目标一轨，
 * 各自跑自己的投递与探测；对外仍然只有一个聚合出来的 PetState，
 * 因为悬浮标只有一个圆环，它必须对「现在算什么状态」给一个说法。
 */

import {
  DONE_LINGER_MS,
  ERROR_LINGER_MS,
  INITIAL_PET_STATE,
  THINKING_TIMEOUT_MS,
  aggregate,
  findTarget,
  type PetState,
  type ProbeConfidence,
  type TargetDef,
  type TrackState,
} from '@xfb/shared';
import { wantsAnswer } from './settings.js';
import { deliverToWin32 } from './win32/deliver.js';
import { win32Helper } from './win32/helper.js';
import type { BridgeServer } from './bridge/server.js';
import { trackProgress } from './probe/tracker.js';

type Listener = (state: PetState) => void;

/** 完成之后怎么跳回去看回复。 */
type RevealHandle = { kind: 'win32'; hwnd: number } | { kind: 'web'; tabId: number };

interface RunningTrack {
  state: TrackState;
  /** 停掉这一轨的进度跟踪。 */
  stop: () => void;
  reveal: RevealHandle | null;
  /** 取回来的回答正文。没开启取回、或没取到，就一直是 null。 */
  answer: string | null;
}

/** 这一问是谁发起的。 */
export type SubmitOrigin = 'app' | 'api';

export interface SubmitOptions {
  origin?: SubmitOrigin;
  /** origin 为 'api' 时调用方自报的名字，用于事后审计。 */
  client?: string;
  /**
   * 强制要不要取回答案，不传则按用户设置。
   *
   * 只有本地接口会传 true：外部程序调过来就是为了拿答案，
   * 拿不到的话这次调用完全没有意义。而用户打开那个接口这件事本身
   * 就已经表示同意了——所以这不是绕过设置，是另一条独立的授权。
   */
  captureAnswer?: boolean;
}

/** 一轮提交结束后，每个目标的结果。 */
export interface RunResult {
  targetId: string;
  ok: boolean;
  answer: string | null;
  errorMessage: string | null;
}

/** 一条回答落定时广播出去的事件。 */
export interface AnswerEvent {
  targetId: string;
  question: string;
  answer: string;
  origin: SubmitOrigin;
  client?: string;
  /**
   * 本轮一共发给了几个目标。
   *
   * 「答案自动进剪贴板」在多目标时没有唯一解——写谁的？
   * 所以这个数字要带出去，让上层能据此决定不写。
   */
  targetCount: number;
}

export interface SubmitOutcome {
  ok: boolean;
  /** 全都没送到时的原因。调用方据此把文本还给用户。 */
  message?: string;
  /** 这次是第几轮。要同步等结果的调用方靠它锁定自己那一轮。 */
  seq?: number;
}

export class PetOrchestrator {
  private state: PetState = { ...INITIAL_PET_STATE };
  private listeners = new Set<Listener>();
  private tracks = new Map<string, RunningTrack>();
  /** 目标顺序。Map 的插入序够用，但排序语义还是显式记一份更稳。 */
  private order: string[] = [];
  private lingerTimer: NodeJS.Timeout | null = null;
  private bridge: BridgeServer | null = null;
  /** 连点绿环时在多个已完成目标之间轮换的游标。 */
  private revealCursor = 0;
  /** 本轮要不要取回答案。投递时下发给扩展。 */
  private captureAnswer = false;
  /**
   * 轮次编号。每次 submit 自增。
   *
   * 外部接口要同步等一轮跑完，而「跑完」这件事必须锁定到**这一轮**：
   * 等待期间用户完全可能自己又发了一条，把旧轮顶掉。
   * 没有这个编号的话，那次等待会挂在新轮上，返回别人的答案。
   */
  private runSeq = 0;
  /** 本轮的问题原文，落库时要跟回答存在一起。 */
  private question = '';
  private origin: SubmitOrigin = 'app';
  private client: string | undefined;
  private answerListeners = new Set<(e: AnswerEvent) => void>();
  /** 在等某一轮结束的人。key 是轮次编号。 */
  private runWaiters = new Map<number, ((results: RunResult[]) => void)[]>();

  /** 接入扩展桥。没接的话，网页目标会如实报告不可用。 */
  attachBridge(bridge: BridgeServer): void {
    this.bridge = bridge;
  }

  getState(): PetState {
    return this.state;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 订阅「取回了一条回答」。
   *
   * 落库和写剪贴板都不在这里做：编排器只管把状态跑对，
   * 至于这段文字要进历史、进剪贴板还是两个都不进，是主进程按设置决定的。
   */
  onAnswer(fn: (e: AnswerEvent) => void): () => void {
    this.answerListeners.add(fn);
    return () => this.answerListeners.delete(fn);
  }

  /** 本轮各目标的结果快照，供等待者取用。 */
  private snapshotResults(): RunResult[] {
    return this.order.map((id) => {
      const track = this.tracks.get(id);
      return {
        targetId: id,
        ok: track?.state.phase === 'done',
        answer: track?.answer ?? null,
        errorMessage: track?.state.errorMessage ?? null,
      };
    });
  }

  /**
   * 等某一轮全部跑完（含生成结束），拿到每个目标的结果。
   *
   * 轮次已经被新的提交顶掉时立刻返回当时的快照——绝不能一直挂着，
   * 那会让调用方的 HTTP 请求永远收不到响应。
   */
  private waitForRun(seq: number): Promise<RunResult[]> {
    if (seq !== this.runSeq) return Promise.resolve(this.snapshotResults());
    return new Promise((resolve) => {
      const list = this.runWaiters.get(seq) ?? [];
      list.push(resolve);
      this.runWaiters.set(seq, list);
    });
  }

  /** 叫醒等这一轮的人。 */
  private settleWaiters(): void {
    const waiters = this.runWaiters.get(this.runSeq);
    if (!waiters) return;
    this.runWaiters.delete(this.runSeq);
    const results = this.snapshotResults();
    for (const fn of waiters) fn(results);
  }

  /**
   * 把各轨聚合成整体状态并广播。
   *
   * 所有状态变更都要经过这里——分轨改完自己那份，整体永远是算出来的，
   * 不允许谁单独去改聚合字段，否则两者迟早对不上。
   */
  private publish(): void {
    const tracks = this.order
      .map((id) => this.tracks.get(id)?.state)
      .filter((t): t is TrackState => t !== undefined);

    const agg = aggregate(tracks);

    /*
      进度条只在「单轨且真拿得到比例」时才有意义。多轨时两个目标各走各的，
      合成一个百分比就是编造——和圆环不画假进度是同一条原则。
    */
    const progress = tracks.length === 1 ? (tracks[0]?.progress ?? null) : null;

    this.state = {
      phase: agg.phase,
      targetId: this.order[0] ?? null,
      confidence: agg.confidence,
      progress,
      elapsedMs: agg.elapsedMs,
      errorMessage: agg.errorMessage,
      tracks,
    };

    for (const fn of this.listeners) fn(this.state);

    // 全部走完了才开始倒计时回待机：还有一轨在转就不能收。
    const settled =
      tracks.length > 0 && tracks.every((t) => t.phase === 'done' || t.phase === 'error');
    if (settled && !this.lingerTimer) {
      const linger = agg.phase === 'error' ? ERROR_LINGER_MS : DONE_LINGER_MS;
      this.lingerTimer = setTimeout(() => this.toIdle(), linger);
      // 圆环还要在屏幕上停留几秒，但对等着要答案的调用方来说这一轮已经结束了。
      this.settleWaiters();
    }
  }

  private patchTrack(targetId: string, next: Partial<TrackState>): void {
    const track = this.tracks.get(targetId);
    if (!track) return;
    track.state = { ...track.state, ...next };
    this.publish();
  }

  private clearLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  private stopAll(): void {
    for (const track of this.tracks.values()) track.stop();
    this.tracks.clear();
    this.order = [];
  }

  /** 回到待机。所有轨走完并停留一段时间后自动调用。 */
  private toIdle(): void {
    this.clearLinger();
    this.stopAll();
    this.state = { ...INITIAL_PET_STATE };
    for (const fn of this.listeners) fn(this.state);
  }

  /**
   * 提交一条消息。
   *
   * 新的提交会打断上一轮还在跟踪的进度——用户又发问了，
   * 旧那一轮的圆环就没意义了。
   *
   * 返回值是给调用方用来决定「要不要把文本还给用户」的：全都没送到时，
   * 用户刚打的那段话必须能拿回来，否则一次失败就白打了。
   */
  async submit(targetIds: string[], text: string, options: SubmitOptions = {}): Promise<SubmitOutcome> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, message: '内容是空的' };

    // 去重：面板多选和「当前目标」可能指向同一个，发两遍就重复了。
    const targets = [...new Set(targetIds)]
      .map((id) => findTarget(id))
      .filter((t): t is TargetDef => t !== undefined);

    if (targets.length === 0) return { ok: false, message: '没有可投递的目标' };

    // 旧轮要被顶掉了：先把还在等它的人放走，拿当时的快照，
    // 否则那个 HTTP 请求会一直挂到超时。
    this.settleWaiters();

    this.stopAll();
    this.clearLinger();
    this.revealCursor = 0;
    this.runSeq += 1;
    const seq = this.runSeq;
    this.question = trimmed;
    this.origin = options.origin ?? 'app';
    this.client = options.client;
    this.captureAnswer = options.captureAnswer ?? wantsAnswer();
    this.order = targets.map((t) => t.id);

    for (const target of targets) {
      this.tracks.set(target.id, {
        state: {
          targetId: target.id,
          phase: 'sending',
          confidence: null,
          progress: null,
          elapsedMs: 0,
          errorMessage: null,
          revealable: false,
        },
        stop: () => {},
        reveal: null,
        answer: null,
      });
    }
    this.publish();

    /*
      web 的可以一起发，win32 的必须一个一个来。

      win32 那条链是「抢前台 → 粘贴 → 回车 → 还原焦点」，两个同时跑会互相
      抢焦点：第二个把前台夺走时，第一个的 Ctrl+V 正好落进第二个的输入框，
      于是一条消息发了两遍、另一条一个字都没有。这种事不报错，
      只是结果莫名其妙。而网页端由扩展直接操作 DOM，压根不碰焦点，
      所以先把它们放出去，再排队走桌面端。
    */
    const web = targets.filter((t) => t.delivery === 'web');
    const win32 = targets.filter((t) => t.delivery !== 'web');

    const webRuns = web.map((t) => this.runWeb(t, trimmed));
    const winResults: boolean[] = [];
    for (const target of win32) winResults.push(await this.runWin32(target, trimmed));
    const webResults = await Promise.all(webRuns);

    const delivered = [...webResults, ...winResults].filter(Boolean).length;
    if (delivered === 0) {
      return { ok: false, message: this.state.errorMessage ?? '投递失败', seq };
    }
    return { ok: true, seq };
  }

  /**
   * 提交并一直等到生成结束，拿回每个目标的答案。
   *
   * 这是本地接口专用的入口：外部程序调过来是要一个答案的，
   * 「已送达」对它毫无用处。
   *
   * 注意这条路会**一直等**，而生成可能要一两分钟。超时由调用方决定，
   * 不在这里设——不同调用方的耐心差别很大，而编排器没有立场替它们决定。
   */
  async submitAndWait(
    targetIds: string[],
    text: string,
    options: SubmitOptions = {},
  ): Promise<{ ok: boolean; message?: string; results: RunResult[] }> {
    const outcome = await this.submit(targetIds, text, options);
    if (!outcome.ok || outcome.seq === undefined) {
      return { ok: false, message: outcome.message, results: this.snapshotResults() };
    }
    const results = await this.waitForRun(outcome.seq);
    return { ok: results.some((r) => r.ok), results };
  }

  /** 桌面端一轨：闪切投递，再挂上三档探测。返回是否送达。 */
  private async runWin32(target: TargetDef, text: string): Promise<boolean> {
    let outcome;
    try {
      outcome = await deliverToWin32(target, text);
    } catch (err) {
      this.failTrack(target.id, err instanceof Error ? err.message : '投递时发生未知错误');
      return false;
    }

    if (!outcome.ok || outcome.hwnd === undefined) {
      this.failTrack(target.id, outcome.message ?? '投递失败');
      return false;
    }

    const hwnd = outcome.hwnd;
    // 像素差分要靠窗口标题在 desktopCapturer 里认窗口。
    const windowTitle = outcome.title ?? target.processName ?? '';

    const track = this.tracks.get(target.id);
    if (!track) return true; // 这一轮已经被新的提交顶掉了
    track.reveal = { kind: 'win32', hwnd };
    this.patchTrack(target.id, {
      phase: 'thinking',
      confidence: null,
      progress: null,
      revealable: true,
    });

    const tracker = trackProgress({
      target,
      hwnd,
      windowTitle,
      onUpdate: (update) => {
        if (update.phase === 'thinking') {
          this.patchTrack(target.id, {
            phase: 'thinking',
            confidence: update.confidence,
            // 桌面端两档都给不出比例，UI 一律画不确定动画，不伪造。
            progress: null,
            elapsedMs: update.elapsedMs,
          });
        } else {
          this.doneTrack(target.id, update.confidence, update.elapsedMs);
        }
      },
    });
    track.stop = () => tracker.stop();
    return true;
  }

  /**
   * 网页目标一轨：投递和进度探测都由扩展负责。
   * 扩展能直接读 DOM，所以结束时刻是准的——但仍然拿不到完成百分比
   * （不知道回复总长），progress 因此保持为空，UI 照常转圈。
   */
  private async runWeb(target: TargetDef, text: string): Promise<boolean> {
    const bridge = this.bridge;
    if (!bridge) {
      this.failTrack(target.id, '网页端需要配合浏览器扩展，当前没有连接');
      return false;
    }

    // 每轨自己记开始时刻：多轨的 elapsed 各不相同，不能共用一个。
    const startedAt = Date.now();

    // 超时兜底：扩展可能在生成中途被浏览器回收，进度就再也回不来了。
    const timeout = setTimeout(() => {
      const track = this.tracks.get(target.id);
      if (track?.state.phase === 'thinking') {
        this.doneTrack(target.id, 'exact', THINKING_TIMEOUT_MS);
      }
    }, THINKING_TIMEOUT_MS);

    const pending = this.tracks.get(target.id);
    if (pending) pending.stop = () => clearTimeout(timeout);

    const outcome = await bridge.deliver(
      target.id,
      text,
      (update) => {
        if (update.phase === 'thinking') {
          this.patchTrack(target.id, {
            phase: 'thinking',
            confidence: update.confidence,
            progress: update.progress,
            elapsedMs: Date.now() - startedAt,
          });
        } else {
          clearTimeout(timeout);
          this.doneTrack(target.id, update.confidence, Date.now() - startedAt, update.answer);
        }
      },
      this.captureAnswer,
    );

    if (!outcome.ok) {
      clearTimeout(timeout);
      this.failTrack(target.id, outcome.message ?? '网页端投递失败');
      return false;
    }

    const live = this.tracks.get(target.id);
    if (live && outcome.tabId !== undefined) live.reveal = { kind: 'web', tabId: outcome.tabId };
    this.patchTrack(target.id, {
      phase: 'thinking',
      confidence: 'exact',
      progress: null,
      revealable: outcome.tabId !== undefined,
    });
    return true;
  }

  private failTrack(targetId: string, message: string): void {
    this.patchTrack(targetId, {
      phase: 'error',
      errorMessage: message,
      confidence: null,
      progress: null,
      revealable: false,
    });
  }

  private doneTrack(
    targetId: string,
    confidence: ProbeConfidence,
    elapsedMs: number,
    answer?: string,
  ): void {
    const track = this.tracks.get(targetId);
    if (track) {
      track.stop = () => {};
      if (answer) track.answer = answer;
    }
    this.patchTrack(targetId, { phase: 'done', confidence, progress: 1, elapsedMs });

    /*
      先 patchTrack 再广播回答：patchTrack 会触发 publish，
      而 publish 在全部走完时要给等待者发快照——那份快照必须
      已经包含这条回答，否则同步等结果的调用方会拿到一个空答案。
    */
    if (!answer) return;
    const event: AnswerEvent = {
      targetId,
      question: this.question,
      answer,
      origin: this.origin,
      client: this.client,
      targetCount: this.order.length,
    };
    for (const fn of this.answerListeners) fn(event);
  }

  /** 这一轮里还能跳过去看的目标，按投递顺序。 */
  revealable(): string[] {
    return this.order.filter((id) => {
      const track = this.tracks.get(id);
      return track?.reveal != null && track.state.phase !== 'sending';
    });
  }

  /**
   * 跳到目标窗口去看回复。
   *
   * 不指定目标时按顺序轮换：同时发给两家时，点一下看这个、再点一下看那个。
   * 圆环只有 52px，分不出可点击的扇区，轮换是这里唯一说得通的交互。
   */
  async reveal(targetId?: string): Promise<{ ok: boolean; targetId?: string }> {
    const candidates = this.revealable();
    if (candidates.length === 0) return { ok: false };

    const id = targetId ?? candidates[this.revealCursor % candidates.length];
    if (!targetId) this.revealCursor += 1;
    if (!id) return { ok: false };

    const handle = this.tracks.get(id)?.reveal;
    if (!handle) return { ok: false };

    try {
      if (handle.kind === 'win32') {
        const res = await win32Helper.send('focus', { hwnd: handle.hwnd });
        console.log(`[跳转] ${id} → hwnd ${handle.hwnd}：${res.ok ? '成功' : '失败'}`);
        return { ok: res.ok === true, targetId: id };
      }
      const ok = await this.bridge?.activate(handle.tabId);
      console.log(`[跳转] ${id} → 标签页 ${handle.tabId}：${ok ? '成功' : '失败'}`);
      return { ok: ok === true, targetId: id };
    } catch (err) {
      // 跳转失败不值得打断用户：回复就在那儿，自己切过去也能看。
      console.warn(`[跳转] ${id} 失败：`, err);
      return { ok: false, targetId: id };
    }
  }

  dispose(): void {
    this.stopAll();
    this.clearLinger();
    this.listeners.clear();
  }
}

export const orchestrator = new PetOrchestrator();
