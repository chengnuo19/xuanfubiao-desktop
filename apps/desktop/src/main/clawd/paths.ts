/**
 * clawd-core 在哪。
 *
 * 开发时就是 packages/clawd-core（经 workspace 链接解析）。打包后它作为 extraResources
 * 放在 resources/clawd-core，**不进 asar**：hook 脚本是由各代理用系统的 node 启动的，
 * 必须是磁盘上的真文件；koffi 的 .node 也不能从 asar 里加载。
 */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const nodeRequire = createRequire(__filename);

let cached: string | null = null;

export function clawdCoreDir(): string {
  if (cached) return cached;
  const packaged = path.join(process.resourcesPath, 'clawd-core');
  cached =
    app.isPackaged && existsSync(path.join(packaged, 'package.json'))
      ? packaged
      : path.dirname(nodeRequire.resolve('@xfb/clawd-core/package.json'));
  return cached;
}

/** 按真实路径加载 clawd-core 里的模块（CommonJS，必须走运行时 require）。 */
export function coreRequire(rel: string): any {
  return nodeRequire(path.join(clawdCoreDir(), rel));
}

/** 按 clawd-core 自己的依赖解析 npm 包（koffi 只装在它名下）。 */
export function coreDepRequire(id: string): any {
  return createRequire(path.join(clawdCoreDir(), 'package.json'))(id);
}
