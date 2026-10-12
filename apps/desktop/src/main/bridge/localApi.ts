/**
 * 本机 HTTP 接口：让其它程序借用已经登录好的 AI 客户端。
 *
 * 动机很直接——你已经为 ChatGPT 付过钱了，但那笔钱现在只能在它自己那个
 * 窗口里花。这个接口把它接出来：Claude Code、Obsidian、一段 shell 脚本，
 * 都可以发一句话进来，拿一段回答回去，不需要 API key，不计 token。
 *
 * 为什么是 HTTP 而不是复用桥的 WebSocket：桥是给扩展用的长连接，
 * 有心跳、有重连、有 service worker 的一堆讲究。而外部调用方要的是
 * 「发一句、等一句」——那是 HTTP 的形状。一行 curl 就能验通，
 * 也不必让每个接入方都去实现一遍握手。
 *
 * 三条安全边界，每条都不能少：
 *
 *   1. **只监听 127.0.0.1**，不接受任何外部网卡的连接。
 *   2. **必须带密钥**，而且是独立于扩展密钥的另一把。两把钥匙发给的是
 *      不同的东西（浏览器扩展 / 本机程序），泄露一把不该连坐。
 *   3. **默认根本不监听**。不是监听了再拒绝——对一个能用你的账号
 *      发消息的接口，「关着」必须意味着端口不存在。
 *
 * 还有一条不那么显眼但同样关键：本机任何网页都能往 127.0.0.1 发请求。
 * 挡住它们靠两道——带自定义头的跨域请求要先过预检，而这里对预检
 * 一律不回 CORS 头；再加上 Origin 与 Host 头校验，把网页和
 * DNS rebinding 一起挡在外面。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { BUILTIN_TARGETS, findTarget } from '@xfb/shared';
import { orchestrator, type RunResult } from '../orchestrator.js';

/** 接口端口。挨着桥的 47615，好记。 */
export const LOCAL_API_PORT = 47616;

/** 单次请求最长等多久。生成一两分钟是常事，但不能无上限地挂着。 */
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;

/** 请求体大小上限。防一个失控的调用方把内存吃光。 */
const MAX_BODY_BYTES = 256 * 1024;

/** 允许的 Host 头。挡 DNS rebinding：攻击者的域名解析到 127.0.0.1 也进不来。 */
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${LOCAL_API_PORT}`,
  `localhost:${LOCAL_API_PORT}`,
  `[::1]:${LOCAL_API_PORT}`,
]);

/** 读取或生成接口密钥。独立于扩展密钥，单独一个文件。 */
export function loadOrCreateApiToken(): string {
  const file = path.join(app.getPath('userData'), 'api-token.txt');
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, 'utf8');
  return token;
}

interface AskBody {
  text?: string;
  /** 目标 id。不填则用当前默认目标。可以是数组，一次发给多家。 */
  target?: string | string[];
  /** 调用方自报名字，会记进回答历史，供事后审计。 */
  client?: string;
  timeoutMs?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // 明确不给任何跨域许可：网页即使发得出请求，也读不到回应。
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class LocalApiServer {
  private server: Server | null = null;

  /**
   * @param token 接口密钥
   * @param fallbackTargets 调用方没指定目标时用哪些，跟托盘里当前选的保持一致
   */
  constructor(
    private readonly token: string,
    private readonly fallbackTargets: () => string[],
  ) {}

  get running(): boolean {
    return this.server !== null;
  }

  start(): void {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        console.warn('[接口] 处理请求出错：', err);
        if (!res.headersSent) json(res, 500, { ok: false, error: String(err?.message ?? err) });
      });
    });

    server.on('error', (err) => {
      console.error('[接口] 监听失败：', err.message);
      this.server = null;
    });

    server.listen(LOCAL_API_PORT, '127.0.0.1', () => {
      console.log(`[接口] 已在 127.0.0.1:${LOCAL_API_PORT} 开放`);
    });
    this.server = server;
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    console.log('[接口] 已关闭');
  }

  /** 鉴权 + 防跨站。任何一条不过就当这个接口不存在。 */
  private authorize(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    if (!ALLOWED_HOSTS.has(host)) {
      console.warn(`[接口] 拒绝：Host 头不对（${host}）`);
      return false;
    }
    /*
      网页发过来的请求一律挡掉。浏览器给跨源请求强制带上 Origin 头，
      而正常的本机程序（curl、Node、Python）不会带——
      所以「带了 Origin」本身就是「这是个网页」的充分信号。
    */
    if (req.headers.origin) {
      console.warn(`[接口] 拒绝：请求来自网页（${req.headers.origin}）`);
      return false;
    }
    const auth = req.headers.authorization ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!given || given !== this.token) {
      console.warn('[接口] 拒绝：密钥不匹配');
      return false;
    }
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${LOCAL_API_PORT}`);

    if (!this.authorize(req)) {
      json(res, 401, { ok: false, error: '未授权' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, name: '悬浮标', version: app.getVersion() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/targets') {
      json(res, 200, {
        ok: true,
        /*
          只报网页端。桌面端要闪切焦点，被一个后台程序随时驱动的话，
          用户正在打字时会毫无预兆地被抢走键盘——那不该是一个
          后台接口能干的事。这条限制是故意的，不是没做完。
        */
        targets: BUILTIN_TARGETS.filter((t) => t.delivery === 'web').map((t) => ({
          id: t.id,
          label: t.label,
        })),
        default: this.fallbackTargets(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/ask') {
      await this.handleAsk(req, res);
      return;
    }

    json(res, 404, { ok: false, error: '没有这个接口' });
  }

  /**
   * 排队用的尾巴。
   *
   * 一次只能跑一个，这是被下层的物理限制逼出来的：投递要占剪贴板，
   * 桌面端还要抢前台焦点。两个请求同时进来，轻则互相覆盖，
   * 重则 A 的文本落进 B 的输入框——而且不报任何错，
   * 只是结果莫名其妙。所以宁可排队，也不并发。
   */
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    // 队列本身不能因为某一次失败就断掉，所以这里把异常吞掉；
    // 真正的错误由 next 交回给调用方。
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: AskBody;
    try {
      body = JSON.parse(await readBody(req)) as AskBody;
    } catch (err) {
      json(res, 400, { ok: false, error: `请求体解析失败：${String((err as Error).message)}` });
      return;
    }

    const text = (body.text ?? '').trim();
    if (!text) {
      json(res, 400, { ok: false, error: 'text 是空的' });
      return;
    }

    const requested = body.target
      ? Array.isArray(body.target)
        ? body.target
        : [body.target]
      : this.fallbackTargets();

    const targets = requested.filter((id) => findTarget(id)?.delivery === 'web');
    if (targets.length === 0) {
      json(res, 400, {
        ok: false,
        error: `没有可用的网页端目标（收到 ${requested.join(', ') || '空'}）。桌面端不对外开放，因为它会抢走你的焦点。`,
      });
      return;
    }

    const timeoutMs = Math.min(body.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const client = (body.client ?? '').slice(0, 64) || '未具名程序';

    console.log(`[接口] ${client} 提问（${text.length} 字）→ ${targets.join(', ')}`);

    const outcome = await this.enqueue(async () => {
      const run = orchestrator.submitAndWait(targets, text, {
        origin: 'api',
        client,
        // 外部调用就是来拿答案的，拿不到这次调用毫无意义。
        // 用户打开这个接口本身即为授权，与「取回答案」那个设置无关。
        captureAnswer: true,
      });
      const timer = new Promise<{ ok: false; message: string; results: RunResult[] }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              message: `等待超时（${Math.round(timeoutMs / 1000)} 秒）`,
              results: [],
            }),
          timeoutMs,
        ),
      );
      return Promise.race([run, timer]);
    });

    if (!outcome.ok) {
      json(res, 502, { ok: false, error: outcome.message ?? '投递失败', answers: [] });
      return;
    }

    const answers = outcome.results
      .filter((r) => r.ok)
      .map((r) => ({ target: r.targetId, answer: r.answer ?? '' }));

    /*
      送到了但一个字都没取回来，要如实说，不能假装成功返回空串——
      调用方多半会把空串当成「AI 说了句空话」，然后一脸困惑地去查自己那边。
      最常见的原因是站点改版导致 answer 选择器失配。
    */
    if (answers.every((a) => !a.answer)) {
      json(res, 502, {
        ok: false,
        error:
          '消息已送达，但没能取回回答正文。多半是站点改版，检查扩展 adapters.js 里的 answer 选择器。',
        answers,
      });
      return;
    }

    json(res, 200, { ok: true, answers });
  }
}
