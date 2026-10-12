/*
  端到端验证「外部程序问一句 → 拿回答案」这整条链路。

      XFB_API=1 pnpm dev            # 一个终端：主程序，强制打开本机接口
      node tools/api-selftest.js    # 另一个终端

  这个脚本一人分饰两角：

    · 假扮浏览器扩展连上桥，收到投递就回一段**编出来的**回答；
    · 同时以外部程序的身份调 HTTP 接口，检查那段回答有没有原样送回来。

  为什么要假扮扩展而不用真的：真扩展会把测试消息真的发进你自己的
  ChatGPT 对话里，而这里要验的是「答案有没有沿着 扩展 → 桥 → 编排器 →
  HTTP 一路传对」，跟页面里到底聊了什么毫无关系。编一段带随机串的回答，
  反而能证明拿回来的确实是这一次的那一份，而不是别处漏过来的。

  鉴权那三项同样重要：这个接口能用你的账号发消息，
  「没带密钥会被拒」必须是每次改动后都验一遍的事。
*/
const path = require('path');
const fs = require('fs');

const WebSocket = require(path.join(__dirname, '..', 'apps', 'desktop', 'node_modules', 'ws'));

const DATA_DIR = path.join(process.env.APPDATA, 'XuanFuBiao');
const bridgeToken = fs.readFileSync(path.join(DATA_DIR, 'bridge-token.txt'), 'utf8').trim();
const apiToken = fs.readFileSync(path.join(DATA_DIR, 'api-token.txt'), 'utf8').trim();

const API = 'http://127.0.0.1:47616';

/** 编出来的回答。带随机串，确保拿回来的就是这一次的这一份。 */
const NONCE = Math.random().toString(36).slice(2, 10);
const FAKE_ANSWER = `这是假扩展编的回答 · ${NONCE}\n第二行用来验证多行不会被截断。`;
const FAKE_TAB = 515151;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ---------- 假扩展 ---------- */

let ws = null;

function connectBridge() {
  return new Promise((resolve) => {
    const sock = new WebSocket('ws://127.0.0.1:47615');

    sock.on('open', () => {
      sock.send(
        JSON.stringify({
          type: 'ready',
          token: bridgeToken,
          availableTargets: ['chatgpt-web', 'gemini-web'],
        }),
      );
    });

    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'hello') {
        console.log(`[假扩展] 握手${msg.ok ? '成功' : '被拒：' + msg.reason}`);
        ws = sock;
        resolve(sock);
        return;
      }

      if (msg.type === 'deliver') {
        // 接口那条路必须让扩展去取回答案，否则整个功能没有意义。
        check('接口发起的投递带上了 captureAnswer', msg.captureAnswer === true);
        console.log(`[假扩展] 收到 deliver（${msg.targetId}），回报送达`);
        sock.send(
          JSON.stringify({
            type: 'deliver-result',
            requestId: msg.requestId,
            ok: true,
            tabId: FAKE_TAB,
          }),
        );
        setTimeout(() => {
          console.log('[假扩展] 报告生成完成，附上编好的回答');
          sock.send(
            JSON.stringify({
              type: 'progress',
              requestId: msg.requestId,
              phase: 'done',
              progress: null,
              confidence: 'exact',
              answer: FAKE_ANSWER,
            }),
          );
        }, 1200);
        return;
      }
    });

    sock.on('error', () => setTimeout(() => void connectBridge().then(resolve), 800));
  });
}

/* ---------- 调接口 ---------- */

async function api(pathname, init = {}, token = apiToken) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log(`===== 悬浮标本机接口自检（nonce ${NONCE}）=====\n`);

  /* --- 鉴权：先验挡得住，再验放得进 --- */

  const noToken = await api('/health', {}, '');
  check('不带密钥被拒', noToken.status === 401, `状态 ${noToken.status}`);

  const badToken = await api('/health', {}, 'obviously-wrong-token');
  check('密钥不对被拒', badToken.status === 401, `状态 ${badToken.status}`);

  // 网页发来的请求必须挡掉：浏览器会给跨源请求强制带上 Origin。
  const fromPage = await api('/health', { headers: { origin: 'https://evil.example' } });
  check('带 Origin（网页发来的）被拒', fromPage.status === 401, `状态 ${fromPage.status}`);

  const health = await api('/health');
  check('带对密钥能通', health.status === 200 && health.body.ok === true, `状态 ${health.status}`);

  const targets = await api('/targets');
  const ids = (targets.body.targets ?? []).map((t) => t.id);
  check('目标列表只含网页端', ids.length > 0 && ids.every((id) => id.endsWith('-web')), ids.join('、'));

  /* --- 主链路 --- */

  console.log('\n[接口] 提问，等回答…');
  const asked = await api('/ask', {
    method: 'POST',
    body: JSON.stringify({
      text: `自检提问 ${NONCE}`,
      target: 'gemini-web',
      client: 'api-selftest',
      timeoutMs: 20000,
    }),
  });

  check('/ask 返回成功', asked.status === 200 && asked.body.ok === true, JSON.stringify(asked.body).slice(0, 160));

  const answer = asked.body.answers?.[0]?.answer ?? '';
  check('拿回的正是这一次的那份回答', answer.includes(NONCE), `收到 ${answer.length} 字`);
  check('多行回答没有被截断', answer.includes('第二行'), '');

  /* --- 落库与审计 --- */

  // 等一拍，让落库写完。
  await new Promise((r) => setTimeout(r, 600));
  const store = path.join(DATA_DIR, 'answers.json');
  let logged = null;
  try {
    logged = JSON.parse(fs.readFileSync(store, 'utf8')).items?.[0];
  } catch {}
  check('回答已记进 answers.json', !!logged && logged.answer.includes(NONCE));
  check(
    '外部调用被标成 api 并记下了调用方',
    logged?.origin === 'api' && logged?.client === 'api-selftest',
    `origin=${logged?.origin} client=${logged?.client}`,
  );

  /* --- 不指定目标 --- */

  /*
    这一项验的是一个真实踩过的坑：托盘里选的通常是桌面端目标，
    而桌面端不对外开放。如果默认目标直接跟着托盘走，
    那么每一次不带 target 的调用都会报「没有可用的网页端目标」，
    可用户明明什么都没做错。
  */
  const noTarget = await api('/ask', {
    method: 'POST',
    body: JSON.stringify({ text: `不指定目标 ${NONCE}`, client: 'api-selftest', timeoutMs: 20000 }),
  });
  check(
    '不指定目标时自动落到网页端',
    noTarget.status === 200 && noTarget.body.ok === true,
    JSON.stringify(noTarget.body).slice(0, 120),
  );

  const listedDefault = (targets.body.default ?? []).join('、');
  check(
    '/targets 报的默认目标也是网页端',
    (targets.body.default ?? []).every((id) => id.endsWith('-web')),
    listedDefault,
  );

  /* --- 拒绝桌面端 --- */

  const desktop = await api('/ask', {
    method: 'POST',
    body: JSON.stringify({ text: '这条不该被投出去', target: 'chatgpt-classic' }),
  });
  check('桌面端目标被拒绝（会抢焦点）', desktop.status === 400, `状态 ${desktop.status}`);

  /* --- 结果 --- */

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 项通过 =====`);
  if (failed.length > 0) console.log(`未通过：${failed.map((f) => f.name).join('、')}`);
  ws?.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

void connectBridge()
  .then(() => new Promise((r) => setTimeout(r, 400)))
  .then(main)
  .catch((err) => {
    console.error('自检本身出错：', err);
    process.exit(1);
  });
