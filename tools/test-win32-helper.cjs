const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const repo = require('node:path').resolve(__dirname, '..');
const ts = createRequire(repo + '/apps/desktop/package.json')('typescript');
const source = fs.readFileSync(process.argv[2] || repo + '/apps/desktop/src/main/win32/helper.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function fixture() {
  const timers = new Set(), children = [];
  let exists = true;
  const fake = { exports: {} };
  const req = (name) => name === 'electron' ? { app: { isPackaged: false, getAppPath: () => repo + '/apps/desktop' } } : name === 'node:fs' ? { existsSync: () => exists } : name === 'node:child_process' ? { spawn: () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.writes = []; child.killed = false;
    child.stdin = { write(line, encoding, cb) {
      child.writes.push(JSON.parse(line));
      cb?.();
      const msg = child.writes.at(-1);
      if (msg.cmd === 'shake-config') queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: msg.id, ok: true }) + '\n'));
      return true;
    }, end() {} };
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', 1)); return true; };
    children.push(child); return child;
  } } : require(name);
  vm.runInNewContext(code, { require: req, exports: fake.exports, process: { resourcesPath: '/unused' }, console: { error() {}, warn() {} }, setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; }, clearTimeout: (timer) => timers.delete(timer), Buffer });
  return { helper: new fake.exports.Win32Helper(), children, timers, setExists: (v) => exists = v,
    fire(ms) { const timer = [...timers].find((t) => t.ms === ms); assert.ok(timer, 'missing deadline ' + ms); timers.delete(timer); timer.fn(); },
    ready() { children.at(-1).stdout.emit('data', '{"id":0,"type":"helper-ready"}\n'); } };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
(async () => {
  {
    const f = fixture(); const p = f.helper.start(); const rejection = assert.rejects(p, /启动超时/);
    f.fire(5000); await rejection; await flush(); assert.ok(f.children[0].killed); f.helper.dispose();
  }
  {
    const f = fixture(); f.setExists(false); await assert.rejects(f.helper.start(), /找不到/);
    f.setExists(true); const p = f.helper.start(); f.ready(); await p; f.helper.dispose(); await flush();
  }
  {
    const f = fixture(); const p = f.helper.send('shake-config', { enabled: false, sensitivity: 'low', suppressFullscreen: false }); f.ready(); await p;
    const first = f.children[0]; first.stdout.emit('data', '{"unfinished":'); first.kill(); await flush(); f.fire(1000); f.ready(); await flush();
    assert.equal(f.children[1].writes[0].cmd, 'shake-config'); assert.equal(f.children[1].writes[0].enabled, false);
    assert.equal(f.children[1].writes[0].sensitivity, 'low'); f.helper.dispose(); await flush();
  }
  {
    const f = fixture(); const startup = f.helper.start(); f.ready(); await startup;
    const p = f.helper.send('uia-probe', {}, 40), q = f.helper.send('clip-state', {}, 50);
    const a = assert.rejects(p, /超时/), b = assert.rejects(q, /已退出/); await flush(); f.fire(40); await Promise.all([a, b]);
    assert.ok(f.children[0].killed); f.helper.dispose(); await flush();
  }
  {
    const f = fixture(); const p = f.helper.start(); const a = assert.rejects(p, /启动失败/); f.helper.dispose(); await a;
    await assert.rejects(f.helper.start(), /已关闭/); assert.equal(f.timers.size, 0);
  }
  {
    const f = fixture(); const p = f.helper.start(); f.ready(); await p;
    const pending = f.helper.send('ping'); const a = assert.rejects(pending, /已关闭/); await flush(); f.helper.dispose(); await a; await flush();
    assert.equal(f.timers.size, 0);
  }
  console.log('PASS: 6 helper lifecycle checks (startup deadline, missing-script recovery, config/buffer restoration, blocked-command recovery, startup disposal, pending disposal)');
})().catch((err) => { console.error(err); process.exitCode = 1; });
