// 生成「团子」测试主题（clawd 主题格式，原创）。apps/desktop/resources/themes/xfb-blob 就是用它生成后改了名字和时长。用法：node tools/e2e/make-test-theme.cjs <输出目录>
const fs = require('fs'); const path = require('path');
const out = process.argv[2]; fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
const body = (fill) => `<g id="shadow-js"><ellipse cx="0" cy="17" rx="11" ry="2.2" fill="#000" opacity=".25"/></g>
<g id="body-js"><path d="M-14 6 C-14 -8 -8 -15 0 -15 C8 -15 14 -8 14 6 C14 14 8 16 0 16 C-8 16 -14 14 -14 6Z" fill="${fill}"/>
<ellipse cx="-8" cy="7" rx="3" ry="1.8" fill="#ff8a8a" opacity=".55"/><ellipse cx="8" cy="7" rx="3" ry="1.8" fill="#ff8a8a" opacity=".55"/></g>`;
const openEyes = `<g id="eyes-js"><circle cx="-5" cy="1" r="2.4" fill="#1b1b1f"/><circle cx="5" cy="1" r="2.4" fill="#1b1b1f"/>
<circle cx="-4.2" cy="0.2" r=".8" fill="#fff"/><circle cx="5.8" cy="0.2" r=".8" fill="#fff"/></g>`;
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -24 40 44">${inner}</svg>`;
const files = {
  'idle.svg': svg(body('#7cc4ff') + openEyes),
  'thinking.svg': svg(body('#9db6ff') + openEyes + `<g fill="#fff"><circle cx="9" cy="-19" r="1.6"/><circle cx="13" cy="-21" r="1.6"/><circle cx="17" cy="-23" r="1.6"/></g>`),
  'working.svg': svg(body('#6fd3a8') + openEyes + `<rect x="-9" y="10" width="18" height="5" rx="1.2" fill="#2b2f3a"/><rect x="-7" y="11" width="14" height="1.3" fill="#8be9c3"/>`),
  'juggling.svg': svg(body('#6fd3a8') + openEyes + `<circle cx="-12" cy="-18" r="2.5" fill="#ffd166"/><circle cx="0" cy="-22" r="2.5" fill="#ef476f"/><circle cx="12" cy="-18" r="2.5" fill="#118ab2"/>`),
  'attention.svg': svg(body('#ffd166') + `<g id="eyes-js"><path d="M-8 1 Q-5 -2 -2 1" stroke="#1b1b1f" stroke-width="1.6" fill="none"/><path d="M2 1 Q5 -2 8 1" stroke="#1b1b1f" stroke-width="1.6" fill="none"/></g><text x="10" y="-14" font-size="9">✦</text>`),
  'notification.svg': svg(body('#ffb36b') + openEyes + `<text x="-2" y="-17" font-size="12" font-weight="bold" fill="#ff5d5d">!</text>`),
  'error.svg': svg(body('#ff7b7b') + `<g id="eyes-js" stroke="#1b1b1f" stroke-width="1.5"><path d="M-7 -1 l4 4 M-3 -1 l-4 4"/><path d="M3 -1 l4 4 M7 -1 l-4 4"/></g>`),
  'sleeping.svg': svg(body('#8fa3c7') + `<g id="eyes-js"><path d="M-7 1 h4" stroke="#1b1b1f" stroke-width="1.5"/><path d="M3 1 h4" stroke="#1b1b1f" stroke-width="1.5"/></g><text x="9" y="-12" font-size="7" fill="#cfd8ff">z</text><text x="13" y="-17" font-size="9" fill="#cfd8ff">Z</text>`),
  'yawning.svg': svg(body('#8fb3d9') + openEyes + `<ellipse cx="0" cy="8" rx="2.5" ry="3" fill="#1b1b1f"/>`),
  'wink.svg': svg(body('#ff9fd0') + `<g id="eyes-js"><circle cx="-5" cy="1" r="2.4" fill="#1b1b1f"/><path d="M3 1 Q5 -1.5 7 1" stroke="#1b1b1f" stroke-width="1.6" fill="none"/></g><text x="9" y="-12" font-size="8">♥</text>`),
};
for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(out, 'assets', f), c);
fs.writeFileSync(path.join(out, 'theme.json'), JSON.stringify({
  schemaVersion: 1, name: '测试团子', version: '1.0.0', author: 'xfb test', viewBox: { x: -20, y: -24, width: 40, height: 44 },
  eyeTracking: { enabled: true, states: ['idle', 'working'], ids: { eyes: 'eyes-js', body: 'body-js', shadow: 'shadow-js' } },
  sleepSequence: { mode: 'full' },
  timings: { mouseSleepTimeout: 20000, yawnDuration: 2000, wakeDuration: 1200 },
  reactions: { double: { file: 'wink.svg', duration: 1500 } },
  states: {
    idle: ['idle.svg'], thinking: ['thinking.svg'], working: ['working.svg'], juggling: ['juggling.svg'],
    attention: ['attention.svg'], notification: ['notification.svg'], error: ['error.svg'],
    sleeping: ['sleeping.svg'], yawning: ['yawning.svg'], dozing: { fallbackTo: 'sleeping' }, collapsing: { fallbackTo: 'sleeping' },
  },
}, null, 2));
console.log('ok', out);
