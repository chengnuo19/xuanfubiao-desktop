#!/usr/bin/env node
/**
 * 悬浮标的 MCP 服务：让 Claude Code 能借用你已经登录好的 ChatGPT / Gemini。
 *
 * 用途很具体——写代码卡在某个判断上时，让另一家模型出个第二意见，
 * 再跟自己的结论对一下。走的是你已经付过钱的那个订阅，不花 API 的钱。
 *
 * **零依赖，不需要构建，也不需要 npm install。** MCP 在 stdio 上就是
 * 一行一条的 JSON-RPC，协议里真正用到的只有三个方法，手写比拉一整个
 * SDK 进来更合适——这和扩展不做构建是同一个判断：逻辑不复杂的时候，
 * 少一层工具链就少一处会坏的地方。
 *
 * 密钥默认从悬浮标自己的数据目录里读，所以正常情况下不用配任何东西。
 * 要覆盖就设环境变量 XFB_API_TOKEN。
 */

const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const API_PORT = 47616;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

/** 协议版本。挑一个双方都认的稳定版本，不追最新。 */
const PROTOCOL_VERSION = '2024-11-05';

/* ---------- 密钥 ---------- */

/**
 * 找到调用密钥。
 *
 * 优先环境变量，其次悬浮标的数据目录。后者是默认路径：
 * 用户在托盘里打开「允许本机程序调用」时，文件就已经在那儿了，
 * 不该再让人手动复制一遍粘进配置里。
 */
function loadToken() {
  const fromEnv = (process.env.XFB_API_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;

  const appData = process.env.APPDATA;
  if (!appData) return '';
  const file = path.join(appData, 'XuanFuBiao', 'api-token.txt');
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/* ---------- 调悬浮标 ---------- */

async function callApi(pathname, init = {}) {
  const token = loadToken();
  if (!token) {
    throw new Error(
      '没找到调用密钥。请确认悬浮标正在运行，并且托盘菜单里的「允许本机程序调用」已经打开。',
    );
  }
  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    // 连不上几乎总是同一个原因，直接把话说完，省掉一轮来回。
    throw new Error(
      `连不上悬浮标（${API_BASE}）。它在运行吗？托盘菜单里的「允许本机程序调用」打开了吗？原始错误：${err.message}`,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(body.error ?? `悬浮标返回 ${res.status}`);
  }
  return body;
}

/**
 * 问一句，等回答。
 *
 * 超时给得比接口默认值更长：这边等的是一个人类尺度的生成过程，
 * 而 MCP 调用方通常愿意等——真正难受的是等到一半被切断，
 * 那样消息已经发出去了，答案却没拿到。
 */
async function ask(question, targets) {
  const body = await callApi('/ask', {
    method: 'POST',
    body: JSON.stringify({
      text: question,
      target: targets,
      client: 'claude-code',
      timeoutMs: 300_000,
    }),
  });
  return body.answers ?? [];
}

function formatAnswers(answers) {
  if (answers.length === 0) return '（没有取回任何回答）';
  if (answers.length === 1) return answers[0].answer;
  // 多家一起问时要标清楚谁说的，否则两段话糊在一起就失去了对比的意义。
  return answers.map((a) => `## ${a.target}\n\n${a.answer}`).join('\n\n---\n\n');
}

/* ---------- 工具定义 ---------- */

const TOOLS = [
  {
    name: 'ask_chatgpt',
    description:
      '把一个问题发给用户已登录的 ChatGPT 网页端，等它生成完，返回回答正文。用于需要第二意见、或想对照另一个模型的判断时。会真实占用用户的 ChatGPT 会话，一次只能跑一个，通常要等几十秒。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的完整问题。上下文要自带，对面看不到这边的对话。' },
      },
      required: ['question'],
    },
    run: async ({ question }) => formatAnswers(await ask(question, ['chatgpt-web'])),
  },
  {
    name: 'ask_gemini',
    description:
      '把一个问题发给用户已登录的 Gemini 网页端，等它生成完，返回回答正文。同 ask_chatgpt。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的完整问题。上下文要自带，对面看不到这边的对话。' },
      },
      required: ['question'],
    },
    run: async ({ question }) => formatAnswers(await ask(question, ['gemini-web'])),
  },
  {
    name: 'ask_both',
    description:
      '同一个问题同时发给 ChatGPT 和 Gemini，两份回答一起返回，便于对照。适合有分歧风险的判断题。耗时与单家相当（两边并行）。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的完整问题。' },
      },
      required: ['question'],
    },
    run: async ({ question }) => formatAnswers(await ask(question, ['chatgpt-web', 'gemini-web'])),
  },
  {
    name: 'list_ai_targets',
    description: '列出悬浮标当前能投递的网页端目标，以及默认会发给谁。连不上时也用它来确认悬浮标状态。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const body = await callApi('/targets');
      const lines = (body.targets ?? []).map((t) => `- ${t.id}：${t.label}`);
      return [`可用目标：`, ...lines, ``, `默认发给：${(body.default ?? []).join('、') || '（未设置）'}`].join('\n');
    },
  },
];

/* ---------- JSON-RPC over stdio ---------- */

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, message) {
  write({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'xuanfubiao', version: '0.3.0' },
    });
    return;
  }

  // 通知类消息没有 id，也不该有响应。回了反而会让对端报协议错误。
  if (method === 'notifications/initialized' || id === undefined) return;

  if (method === 'tools/list') {
    reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
    return;
  }

  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      replyError(id, `没有这个工具：${params?.name}`);
      return;
    }
    try {
      const text = await tool.run(params.arguments ?? {});
      reply(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      /*
        失败要作为工具结果返回（isError），不能走 JSON-RPC 的 error——
        后者会被当成协议级故障，调用方看不到原因，只知道"工具挂了"。
        而这里的失败几乎都是可操作的（悬浮标没开、接口没打开、站点改版），
        那句话必须原样送到对面。
      */
      reply(id, { content: [{ type: 'text', text: `调用失败：${err.message}` }], isError: true });
    }
    return;
  }

  replyError(id, `不支持的方法：${method}`);
}

/*
  按行读 stdin。MCP 的 stdio 传输就是一行一条 JSON，
  不带 Content-Length 头（那是 LSP 的做法，两者容易记混）。
*/
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 半截数据，丢掉就是
    }
    void handle(msg).catch((err) => {
      if (msg.id !== undefined) replyError(msg.id, String(err?.message ?? err));
    });
  }
});

process.stdin.on('end', () => process.exit(0));
