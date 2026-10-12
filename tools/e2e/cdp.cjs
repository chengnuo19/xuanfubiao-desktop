/**
 * 用 Chrome 调试协议读写测试实例里的页面（不碰真屏幕、不改产品代码）。
 *
 * 测试实例要带 --remote-debugging-port=9333 启动（见 start.sh）。
 *
 *   node tools/e2e/cdp.cjs <页面名片段> eval "<表达式>"     # 例：pet.html eval "document.getElementById('avatar').dataset.state"
 *   node tools/e2e/cdp.cjs <页面名片段> shot <输出.png>
 *
 * 注意：同一页面里多次 eval 共享全局作用域，别用顶层 const/let（第二次会重复声明报错），包进 IIFE。
 */
const WebSocket = require(require.resolve('ws', { paths: [require('path').join(__dirname, '../../apps/desktop')] }));
const [, , match, mode, arg] = process.argv;
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9333/json')).json();
  const page = pages.find((p) => p.url.includes(match));
  if (!page) {
    console.log('没找到页面', match, '现有：', pages.map((p) => p.url.split('/').pop()).join(' '));
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    pending.get(d.id)?.(d);
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await new Promise((r) => ws.on('open', r));
  if (mode === 'eval') {
    const res = await send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 1));
  } else {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(arg, Buffer.from(res.result.data, 'base64'));
    console.log('saved', arg);
  }
  ws.close();
})();
