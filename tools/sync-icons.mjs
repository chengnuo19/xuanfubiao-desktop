/**
 * 把渲染层 HTML 里的图标同步成 Tabler Icons（outline）的原样路径。
 *
 * 以前三个窗口的图标是各自手画的：线宽 1.65 / 1.7 / 1.9 各不相同，
 * 篮子的齿轮还是拿 scale(.83 1) 硬压扁出来的。现在一律从 Tabler 取，
 * 手不再碰路径数据。
 *
 * 用法：在 <svg> 或 <symbol> 上写 data-tabler="图标名"（名字见 tabler.io/icons），
 * 然后跑 `node tools/sync-icons.mjs`，标签里面的内容会被替换成那个图标的路径。
 * 线宽不跟 Tabler 的 2，由 tokens.css 的 --icon-stroke 统一给。
 *
 * 加 --check 只检查不写：有任何一处和 Tabler 原样不一致就以非零退出。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 不走 require.resolve：这个包的 exports 字段把子路径都映射走了，解析不到目录本身。
const iconDir = path.join(root, 'apps/desktop/node_modules/@tabler/icons/icons/outline');

const FILES = ['apps/desktop/src/renderer/pet.html', 'apps/desktop/src/renderer/basket.html'];
const check = process.argv.includes('--check');

/** Tabler 每个图标开头都有一条不可见的 24×24 占位框，丢掉它。 */
function iconBody(name) {
  const svg = readFileSync(path.join(iconDir, `${name}.svg`), 'utf8');
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'));
  return inner
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('d="M0 0h24v24H0z"'))
    .join('');
}

let stale = 0;
for (const rel of FILES) {
  const file = path.join(root, rel);
  const before = readFileSync(file, 'utf8');
  const after = before.replace(
    /<(svg|symbol)(\b[^>]*?\bdata-tabler="([\w-]+)"[^>]*)>([\s\S]*?)<\/\1>/g,
    (_m, tag, attrs, name) => `<${tag}${attrs}>${iconBody(name)}</${tag}>`,
  );
  if (after === before) continue;
  stale++;
  if (check) console.error(`${rel}：图标和 Tabler 原样不一致，跑一遍 node tools/sync-icons.mjs`);
  else {
    writeFileSync(file, after);
    console.log(`已同步 ${rel}`);
  }
}
if (check && stale) process.exit(1);
if (!stale) console.log('图标都已是最新');
