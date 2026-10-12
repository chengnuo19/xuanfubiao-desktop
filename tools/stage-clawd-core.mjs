/**
 * 打包前把 clawd-core 整理成一个能独立运行的目录：apps/desktop/.staging/clawd-core。
 *
 * 为什么不让 electron-builder 自己收依赖：
 *   - clawd-core 必须在 asar **外面**。hook 脚本是各代理用系统的 node 启动的，要磁盘上的真文件；
 *     koffi 的 .node 也不能从 asar 里加载。所以它走 extraResources，而 extraResources 只会原样拷目录。
 *   - pnpm 的 node_modules 全是符号链接，原样拷过去装到别人机器上就是一堆断链。
 * 所以用 `pnpm deploy --config.node-linker=hoisted` 产出一份平铺、没有符号链接的依赖。
 *
 * 然后裁掉 koffi 用不上的平台：它自带十几个平台的预编译库，占 26MB，Windows 版只要 win32_x64。
 *
 * 用法（dist 脚本会自动调）：node tools/stage-clawd-core.mjs
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'apps', 'desktop', '.staging', 'clawd-core');

/** 只留这些平台的 koffi 预编译库。以后要出 ARM 版就加 win32_arm64。 */
const KEEP_KOFFI = new Set(['win32_x64']);

rmSync(out, { recursive: true, force: true });

/*
  pnpm deploy 会把它自己的「--prod、hoisted」写进主工作区的状态文件。
  之后主工作区里随便跑个 pnpm 命令，它都以为依赖不同步、要按生产模式重装（删掉开发依赖），
  没终端时直接报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY——typecheck、dist 全挂。
  所以 deploy 前后把这个文件存一份、原样还回去。
*/
const stateFile = path.join(root, 'node_modules', '.pnpm-workspace-state-v1.json');
const savedState = existsSync(stateFile) ? readFileSync(stateFile) : null;
try {
  // pnpm 在 Windows 上是 .cmd，得走 shell；参数都是常量，只有输出路径要加引号。
  execSync(`pnpm --filter @xfb/clawd-core deploy --legacy --prod --config.node-linker=hoisted "${out}"`, {
    cwd: root,
    stdio: 'inherit',
  });
} finally {
  if (savedState) writeFileSync(stateFile, savedState);
}

const koffi = path.join(out, 'node_modules', 'koffi');
const builds = path.join(koffi, 'build', 'koffi');
if (!existsSync(builds)) throw new Error(`没找到 koffi 的预编译库：${builds}`);
for (const name of readdirSync(builds)) {
  if (!KEEP_KOFFI.has(name)) rmSync(path.join(builds, name), { recursive: true, force: true });
}
// C++ 源码和文档运行时用不到。
for (const name of ['src', 'vendor', 'doc']) rmSync(path.join(koffi, name), { recursive: true, force: true });
// pnpm deploy 留下的虚拟仓库索引，平铺模式下用不到。
rmSync(path.join(out, 'node_modules', '.pnpm'), { recursive: true, force: true });

// 自检：裁完以后 koffi 还能加载、上游的两个核心模块还能 require。
const req = createRequire(path.join(out, 'package.json'));
const k = req('koffi');
if (typeof k.load !== 'function') throw new Error('koffi 加载后不对');
req(path.join(out, 'agents', 'registry.js'));
req(path.join(out, 'hooks', 'server-config.js'));
console.log(`[stage-clawd-core] 就绪：${out}`);
