/**
 * 桌宠外观：找主题、给渲染层供素材。
 *
 * 主题目录和 clawd-on-desk 的格式一致（`theme.json` + `assets/`），放在
 * `userData/themes/<id>/` 下。素材不随本项目分发（clawd 的角色画不在 AGPL 授权内），
 * 由用户自己放进来，仅供个人使用。
 *
 * 渲染层通过自定义协议 `xfb-theme://<id>/<文件>` 取素材，不走 file://：
 *   - file:// 能读整个磁盘，主题里一个 `../../` 就出去了；协议这层把路径钉死在主题的 assets 目录里。
 *   - SVG 要内联进 DOM 才能让眼睛跟着鼠标转，而内联的 SVG 能带脚本。所以 SVG 一律先过
 *     clawd 自带的消毒器（去掉 script、事件属性、外链），渲染层拿到的已经是干净的。
 */

import { app, net, protocol } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { coreRequire } from './clawd/paths.js';
import { parseTheme, type PetTheme, type SkinInfo } from '@xfb/shared';

export const THEME_SCHEME = 'xfb-theme';

/** 代理监听层自动生成的占位主题，只为驱动状态机，不给用户选。 */
const HIDDEN_THEME_IDS = new Set(['xfb-placeholder']);

export interface ThemeListing {
  id: string;
  name: string;
}

export type { SkinInfo };

export function themesDir(): string {
  return path.join(app.getPath('userData'), 'themes');
}

/** 主题 id 就是目录名；只认安全的名字，免得拼路径时被带出主题目录。 */
function isSafeId(id: string): boolean {
  return /^[\w.-]+$/.test(id) && id !== '.' && id !== '..';
}

function readTheme(id: string): PetTheme | null {
  if (!isSafeId(id)) return null;
  const file = path.join(themesDir(), id, 'theme.json');
  try {
    return parseTheme(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    console.warn(`[外观] 主题 ${id} 读不了：${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function listThemes(): ThemeListing[] {
  const dir = themesDir();
  if (!existsSync(dir)) return [];
  const out: ThemeListing[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || HIDDEN_THEME_IDS.has(ent.name) || !isSafeId(ent.name)) continue;
    const theme = readTheme(ent.name);
    if (theme) out.push({ id: ent.name, name: theme.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 设置里明确选了经典胶囊时存的值。和「没设过」区分开，否则选了胶囊重启又变回默认角色。 */
export const CAPSULE_SKIN_ID = 'capsule';

/**
 * 没设过外观时用的主题：clawd。
 *
 * clawd 的美术不随安装包分发，只有用户自己把它放进 userData/themes 的机器上才有；
 * 没有就退回胶囊。
 */
const DEFAULT_THEME_ID = 'clawd';

function avatarSkin(themeId: string): SkinInfo | null {
  if (HIDDEN_THEME_IDS.has(themeId)) return null;
  const theme = readTheme(themeId);
  if (!theme) return null;
  return { skin: 'avatar', id: themeId, theme, baseUrl: `${THEME_SCHEME}://${themeId}/` };
}

/**
 * 按设置里存的主题 id 给出外观。
 * 没设过就用默认主题；选的主题被删了或读不了，也先试默认主题，再退回胶囊，不报错。
 */
export function resolveSkin(themeId: string | undefined): SkinInfo {
  if (themeId === CAPSULE_SKIN_ID) return { skin: 'capsule' };
  return (themeId ? avatarSkin(themeId) : null) ?? avatarSkin(DEFAULT_THEME_ID) ?? { skin: 'capsule' };
}

/** 随安装包分发的主题（原创角色）所在目录。打包后在 resources/themes，开发时在 apps/desktop/resources/themes。 */
function bundledThemesDir(): string {
  const packaged = path.join(process.resourcesPath, 'themes');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'themes');
}

/** 递归复制。不用 fs.cpSync：Node 在 Windows 上遇到含中文的路径会直接崩掉进程。 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(a, b);
    else if (ent.isFile()) copyFileSync(a, b);
  }
}

function themeVersion(dir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, 'theme.json'), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : null;
  } catch {
    return null;
  }
}

/**
 * 把自带主题装进用户的主题目录。
 *
 * 只在没装过、或者自带的版本号变了时才覆盖——用户自己改过的同名主题，
 * 只要版本号没动就不会被冲掉。
 */
export function installBundledThemes(): void {
  const from = bundledThemesDir();
  if (!existsSync(from)) return;
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    if (!ent.isDirectory() || !isSafeId(ent.name)) continue;
    const src = path.join(from, ent.name);
    const dest = path.join(themesDir(), ent.name);
    const want = themeVersion(src);
    if (existsSync(dest) && themeVersion(dest) === want) continue;
    try {
      copyTree(src, dest);
      console.log(`[外观] 装好自带主题 ${ent.name}（${want ?? '无版本号'}）`);
    } catch (err) {
      console.warn(`[外观] 自带主题 ${ent.name} 装不上：`, err);
    }
  }
}

/** 必须在 app ready 之前调：fetch() 要能读这个协议，得先声明成特权协议。 */
export function registerThemeScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: THEME_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

let sanitizeSvg: ((svg: string) => string) | null = null;
function getSanitizer(): (svg: string) => string {
  if (!sanitizeSvg) {
    sanitizeSvg = coreRequire('src/theme-sanitizer.js').sanitizeSvg;
  }
  return sanitizeSvg!;
}

/** ready 之后调：把 xfb-theme://<id>/<文件> 映射到 themes/<id>/assets/<文件>。 */
export function handleThemeProtocol(): void {
  protocol.handle(THEME_SCHEME, async (req) => {
    const url = new URL(req.url);
    const id = url.hostname;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!isSafeId(id) || !rel) return new Response('bad request', { status: 400 });

    const assetsDir = path.join(themesDir(), id, 'assets');
    const file = path.resolve(assetsDir, rel);
    // 解析后的路径必须还在 assets 目录里——挡住 ..、绝对路径、盘符这些出逃方式。
    if (!file.startsWith(assetsDir + path.sep)) return new Response('forbidden', { status: 403 });
    if (!existsSync(file) || !statSync(file).isFile()) return new Response('not found', { status: 404 });

    if (file.toLowerCase().endsWith('.svg')) {
      try {
        const clean = getSanitizer()(readFileSync(file, 'utf8'));
        return new Response(clean, { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } });
      } catch (err) {
        console.warn(`[外观] SVG 消毒失败，拒绝提供：${rel}`, err);
        return new Response('unsafe svg', { status: 422 });
      }
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}
