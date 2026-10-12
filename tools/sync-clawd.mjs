/**
 * 把 clawd-on-desk 的代理接入层原样搬进 packages/clawd-core/。
 *
 * 为什么原样搬而不是重写：clawd 对三十多个代理各有一套协议细节
 * （Codex 的 turn fence、opencode v2 的应答格式、plan review 的原样回填……），
 * 重写一定会丢边角。原样搬、不改一个字节，以后跟上游只要重跑这个脚本。
 *
 * 搬哪些：
 *   - agents/、hooks/ 整个目录（hook 脚本由各代理进程自己启动，
 *     安装器还会把 hooks/ 下的插件目录整个拷到代理的配置目录里，所以不能按 require 裁剪）；
 *   - src/ 只搬宿主核心的 require 闭包，外加它们运行时按路径加载的 html/css/preload。
 *
 * 目录结构保持和上游一致，文件里那些 `require("../hooks/server-config")` 才不用改。
 *
 * 用法：先把上游克隆到 tools/clawd-upstream（见 README），再
 *   node tools/sync-clawd.mjs
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = path.join(here, 'clawd-upstream');
const target = path.join(here, '..', 'packages', 'clawd-core');

/** 宿主核心的入口。闭包从这里往下按 require 收。 */
const SRC_ENTRIES = [
  'src/server.js',
  'src/state.js',
  'src/permission.js',
  'src/agent-runtime-main.js',
  'src/integration-sync.js',
  'src/agent-gate.js',
  'src/focus.js',
  'src/session-hud.js',
  // 点会话跳回终端：focusDashboardSession 在 clawd 的 main.js 里，它用到的这两个模块要单独点名。
  'src/session-focus.js',
  'src/session-focus-handoff.js',
  // 气泡开关和自动关闭时长的默认值。clawd 的 main.js 从设置快照里算，这里给空快照取默认。
  'src/bubble-policy.js',
  // 下面这些是按文件路径加载进窗口的，require 收不到，要点名。
  'src/preload-bubble.js',
  'src/bubble-renderer.js',
  'src/preload-permission-queue.js',
  'src/permission-queue-renderer.js',
  'src/preload-session-hud.js',
  'src/session-hud-renderer.js',
];

/** 同上，静态文件。 */
const SRC_STATIC = [
  'src/bubble.html',
  'src/bubble.css',
  'src/permission-queue.html',
  'src/permission-queue.css',
  'src/session-hud.html',
];

if (!existsSync(path.join(upstream, 'hooks', 'server-config.js'))) {
  console.error('没找到 tools/clawd-upstream，先按 README 克隆上游。');
  process.exit(1);
}

/**
 * 递归复制。不用 fs.cpSync：Node 24 在 Windows 上遇到含中文的路径会直接崩掉进程（退出码 127，没有任何报错）。
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(a, b);
    else if (ent.isFile()) copyFileSync(a, b);
  }
}

const seen = new Set();
const external = new Set();

function visit(rel) {
  const norm = rel.split(path.sep).join('/');
  if (seen.has(norm)) return;
  const abs = path.join(upstream, norm);
  if (!existsSync(abs)) {
    console.warn(`  缺文件：${norm}`);
    return;
  }
  seen.add(norm);
  // 页面用 <script src>/<link href> 引的文件 require 收不到，要从 html 里扫出来。
  if (norm.endsWith('.html')) {
    const html = readFileSync(abs, 'utf8');
    for (const m of html.matchAll(/\b(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(norm), m[1])));
    }
    return;
  }
  if (!norm.endsWith('.js')) return;
  const code = readFileSync(abs, 'utf8');
  for (const m of code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) {
      external.add(spec.startsWith('node:') ? spec : spec.split('/')[0]);
      continue;
    }
    let next = path.posix.normalize(path.posix.join(path.posix.dirname(norm), spec));
    if (!/\.(js|json)$/.test(next)) next += '.js';
    visit(next);
  }
}

for (const e of SRC_ENTRIES) visit(e);
for (const s of SRC_STATIC) visit(s);

/*
  只删上游那几样，package.json 和 node_modules 是我们自己的，不碰。

  以前是整个目录删掉重建：悬浮标开着时 koffi 的 .node 被占用，删到一半报 EPERM，
  package.json 和 node_modules 已经先没了。所以同步前要先退出悬浮标。
*/
for (const name of ['agents', 'hooks', 'src', 'LICENSE', 'UPSTREAM.md']) {
  rmSync(path.join(target, name), { recursive: true, force: true });
}
mkdirSync(target, { recursive: true });

// agents/、hooks/ 整目录。
for (const dir of ['agents', 'hooks']) {
  copyTree(path.join(upstream, dir), path.join(target, dir));
}
// src/ 只要闭包。闭包里落到 agents/、hooks/ 的已经整目录拷过了。
const srcFiles = [...seen].filter((f) => f.startsWith('src/')).sort();
for (const f of srcFiles) {
  const dest = path.join(target, f);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(upstream, f), dest);
}
copyFileSync(path.join(upstream, 'LICENSE'), path.join(target, 'LICENSE'));

const commit = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const builtins = new Set(['fs', 'http', 'https', 'crypto', 'os', 'path', 'child_process', 'util', 'url',
  'string_decoder', 'events', 'net', 'stream', 'zlib', 'readline', 'electron', 'assert', 'tty', 'module']);
const npmDeps = [...external].filter((d) => !d.startsWith('node:') && !builtins.has(d)).sort();

writeFileSync(
  path.join(target, 'UPSTREAM.md'),
  [
    '# 上游来源',
    '',
    '本目录由 `tools/sync-clawd.mjs` 从 clawd-on-desk 原样复制，**不要手改**；',
    '需要改行为请在 `apps/desktop/src/main/clawd/` 的组合根里通过 ctx 注入。',
    '',
    `- 仓库：https://github.com/rullerzhou-afk/clawd-on-desk`,
    `- commit：\`${commit}\``,
    '- 许可证：AGPL-3.0（见同目录 LICENSE）',
    '- 版权：Copyright (c) clawd-on-desk contributors（@rullerzhou-afk 等）',
    '- 美术素材不在此目录，也不随本项目分发。',
    '',
    `src/ 收录 ${srcFiles.length} 个文件；需要的 npm 依赖：${npmDeps.join('、')}`,
    '',
  ].join('\n'),
);

console.log(`commit ${commit}`);
console.log(`src ${srcFiles.length} 个文件，agents/ hooks/ 整目录`);
console.log(`npm 依赖：${npmDeps.join(' ')}`);
