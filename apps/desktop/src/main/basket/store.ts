/**
 * 临时篮子的磁盘存储。
 *
 * 和 Tokri 一样，篮子里的每一项都是真实文件：重启不会丢，拖出时也能直接交给
 * Windows 的原生拖放。这里不另建索引，目录本身就是唯一事实来源。
 */

import { app, nativeImage, shell } from 'electron';
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readSettings, type BasketShakeSensitivity } from '../settings.js';

export type BasketItemKind = 'file' | 'directory' | 'text' | 'url' | 'image';

export interface BasketItem {
  id: string;
  name: string;
  kind: BasketItemKind;
  size: number;
  createdAt: number;
  thumbnail?: string;
}

export interface EmbeddedImage {
  name: string;
  mimeType: string;
  base64: string;
}

export interface BasketCopyPayload {
  kind: BasketItemKind;
  path: string;
  text?: string;
}

export interface BasketAddResult {
  added: number;
  duplicates: number;
  overCapacity: number;
  failed: number;
}

export interface BasketStatus {
  count: number;
  totalBytes: number;
  retentionDays: 0 | 1 | 7 | 30;
  capacityMb: 0 | 100 | 500 | 1024 | 5120;
  removeOnDragOut: boolean;
  shakeEnabled: boolean;
  shakeSensitivity: BasketShakeSensitivity;
  suppressInFullscreen: boolean;
}

export interface BasketRemovalResult {
  removed: number;
  failed: number;
}

export interface BasketPreview {
  id: string;
  name: string;
  renameBase: string;
  kind: BasketItemKind;
  size: number;
  modifiedAt: number;
  text?: string;
  textTruncated?: boolean;
  imageDataUrl?: string;
}

export interface BasketRenameResult {
  ok: boolean;
  name?: string;
  message?: string;
}

interface Fingerprint {
  type: 'file' | 'directory';
  size: number;
  digest: string;
}

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp',
]);

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

function basketDir(): string {
  // 只给运行时自检用，正常启动永远落在 userData。测试目录由启动命令显式提供。
  if (process.env['XFB_BASKET_TEST_DIR']) return path.resolve(process.env['XFB_BASKET_TEST_DIR']);
  return path.join(app.getPath('userData'), 'basket');
}

async function ensureBasketDir(): Promise<string> {
  const dir = basketDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}

function safeName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || fallback;
}

async function uniquePath(dir: string, requestedName: string): Promise<string> {
  const parsed = path.parse(requestedName);
  for (let suffix = 0; ; suffix++) {
    const name = suffix === 0 ? requestedName : `${parsed.name} (${suffix})${parsed.ext}`;
    const candidate = path.join(dir, name);
    try {
      await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw err;
    }
  }
}

const emptyAddResult = (): BasketAddResult => ({ added: 0, duplicates: 0, overCapacity: 0, failed: 0 });

/**
 * 按「路径 + 大小 + 修改时间」缓存的派生数据。
 *
 * 每放进一样东西都要查重，查重要给篮子里所有文件算 SHA-256；缩略图也是每次刷新都
 * 重新解码缩放。篮子里的文件放进来之后基本不变，算一次就够了。
 */
interface CacheEntry<T> { size: number; mtimeMs: number; value: T }
const fileDigestCache = new Map<string, CacheEntry<string>>();
const thumbnailCache = new Map<string, CacheEntry<string | null>>();

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string, info: { size: number; mtimeMs: number }): T | undefined {
  const hit = cache.get(key);
  return hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs ? hit.value : undefined;
}

/** 只缓存篮子里的文件；外部来源随时可能被改，每次都老实重算。 */
function insideBasket(target: string): boolean {
  const relative = path.relative(basketDir(), target);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 清掉已经不在篮子里的缓存项（含文件夹内的子文件），免得反复增删后越攒越多。 */
function pruneCaches(aliveNames: Set<string>): void {
  for (const cache of [fileDigestCache, thumbnailCache] as Map<string, unknown>[]) {
    for (const key of cache.keys()) {
      const top = path.relative(basketDir(), key).split(path.sep)[0] ?? '';
      if (!aliveNames.has(top)) cache.delete(key);
    }
  }
}

async function fingerprint(target: string): Promise<Fingerprint> {
  const info = await lstat(target);
  if (!info.isDirectory()) {
    const cacheable = insideBasket(target);
    const hit = cacheable ? cached(fileDigestCache, target, info) : undefined;
    if (hit !== undefined) return { type: 'file', size: info.size, digest: hit };
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
    const digest = hash.digest('hex');
    if (cacheable) fileDigestCache.set(target, { size: info.size, mtimeMs: info.mtimeMs, value: digest });
    return { type: 'file', size: info.size, digest };
  }

  const hash = createHash('sha256');
  let size = 0;
  const entries = (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = await fingerprint(path.join(target, entry.name));
    size += child.size;
    hash.update(`${entry.name}\0${child.type}\0${child.size}\0${child.digest}\0`);
  }
  return { type: 'directory', size, digest: hash.digest('hex') };
}

async function basketFingerprints(dir: string): Promise<Fingerprint[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const fingerprints: Fingerprint[] = [];
  for (const entry of entries) {
    try {
      fingerprints.push(await fingerprint(path.join(dir, entry.name)));
    } catch (err) {
      console.warn(`[临时篮子] 无法检查重复项 ${entry.name}：`, err);
    }
  }
  return fingerprints;
}

function isDuplicate(candidate: Fingerprint, existing: Fingerprint[]): boolean {
  return existing.some((item) => (
    item.type === candidate.type && item.size === candidate.size && item.digest === candidate.digest
  ));
}

function capacityBytes(): number {
  const testLimit = Number(process.env['XFB_BASKET_TEST_CAPACITY_BYTES']);
  if (Number.isFinite(testLimit) && testLimit >= 0) return testLimit;
  const megabytes = readSettings().basketCapacityMb ?? 1024;
  return megabytes === 0 ? Number.POSITIVE_INFINITY : megabytes * 1024 * 1024;
}

function totalSize(items: Fingerprint[]): number {
  return items.reduce((sum, item) => sum + item.size, 0);
}

/** 只允许访问篮子根目录下的直接子项，IPC 传进来的 id 不能借机越界。 */
export async function resolveBasketItem(id: string): Promise<string | null> {
  if (!id || path.basename(id) !== id) return null;
  const dir = await ensureBasketDir();
  const target = path.join(dir, id);
  if (path.dirname(target) !== dir) return null;
  try {
    await lstat(target);
    return target;
  } catch {
    return null;
  }
}

/** 原生 startDrag 必须在 dragstart 的同步链路里调用，不能先等异步磁盘查询。 */
export function resolveBasketItemSync(id: string): string | null {
  if (!id || path.basename(id) !== id) return null;
  const dir = basketDir();
  const target = path.join(dir, id);
  if (path.dirname(target) !== dir || !existsSync(target)) return null;
  return target;
}

function kindFor(name: string, isDirectory: boolean): BasketItemKind {
  if (isDirectory) return 'directory';
  if (name.endsWith('.url.txt')) return 'url';
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.txt' || ext === '.md') return 'text';
  return 'file';
}

function protectedExtension(name: string, kind: BasketItemKind): string {
  if (kind === 'directory') return '';
  if (kind === 'url' && name.endsWith('.url.txt')) return '.url.txt';
  return path.extname(name);
}

export async function listBasketItems(): Promise<BasketItem[]> {
  const dir = await ensureBasketDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (entry): Promise<BasketItem | null> => {
    const itemPath = path.join(dir, entry.name);
    try {
      const info = await stat(itemPath);
      const kind = kindFor(entry.name, entry.isDirectory());
      const item: BasketItem = {
        id: entry.name,
        name: entry.name,
        kind,
        size: entry.isDirectory() ? 0 : info.size,
        createdAt: info.birthtimeMs || info.mtimeMs,
      };

      if (kind === 'image') {
        const thumbnail = await thumbnailFor(itemPath, info);
        if (thumbnail) item.thumbnail = thumbnail;
      }
      return item;
    } catch (err) {
      console.warn(`[临时篮子] 无法读取 ${entry.name}：`, err);
      return null;
    }
  }));

  pruneCaches(new Set(entries.map((entry) => entry.name)));
  return items
    .filter((item): item is BasketItem => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 优先用系统缩略图接口：它是异步的，大图不会卡住主进程（悬浮标和输入条都跑在这个进程里）。
 * SVG 这类系统不给缩略图的格式再退回同步解码。结果按修改时间缓存。
 */
async function thumbnailFor(itemPath: string, info: { size: number; mtimeMs: number }): Promise<string | null> {
  const hit = cached(thumbnailCache, itemPath, info);
  if (hit !== undefined) return hit;
  let image: Electron.NativeImage | null = null;
  try {
    image = await nativeImage.createThumbnailFromPath(itemPath, { width: 128, height: 96 });
  } catch {
    image = null;
  }
  if (!image || image.isEmpty()) {
    const full = nativeImage.createFromPath(itemPath);
    image = full.isEmpty() ? null : full.resize({ width: 128, height: 96, quality: 'good' });
  }
  const value = image ? image.toDataURL() : null;
  thumbnailCache.set(itemPath, { size: info.size, mtimeMs: info.mtimeMs, value });
  return value;
}

/** 只量大小，不读内容。状态栏刷新得很勤，犯不着为了一个总数把整篮文件哈希一遍。 */
async function diskSize(target: string): Promise<number> {
  const info = await lstat(target);
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(target);
  let total = 0;
  for (const name of entries) total += await diskSize(path.join(target, name));
  return total;
}

export async function basketStatus(): Promise<BasketStatus> {
  const dir = await ensureBasketDir();
  const entries = await readdir(dir, { withFileTypes: true });
  let totalBytes = 0;
  for (const entry of entries) {
    try {
      totalBytes += await diskSize(path.join(dir, entry.name));
    } catch (err) {
      console.warn(`[临时篮子] 无法统计 ${entry.name} 的大小：`, err);
    }
  }
  const settings = readSettings();
  return {
    count: entries.length,
    totalBytes,
    retentionDays: settings.basketRetentionDays ?? 0,
    capacityMb: settings.basketCapacityMb ?? 1024,
    removeOnDragOut: settings.basketRemoveOnDragOut === true,
    shakeEnabled: settings.basketShakeEnabled !== false,
    shakeSensitivity: settings.basketShakeSensitivity ?? 'medium',
    suppressInFullscreen: settings.basketSuppressInFullscreen !== false,
  };
}

async function removeBasketItems(
  predicate: (target: string) => Promise<boolean>,
  dispose: (target: string) => Promise<void> = (target) => shell.trashItem(target),
): Promise<BasketRemovalResult> {
  const dir = await ensureBasketDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const result: BasketRemovalResult = { removed: 0, failed: 0 };
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    try {
      if (!(await predicate(target))) continue;
      await dispose(target);
      result.removed++;
    } catch (err) {
      result.failed++;
      console.warn(`[临时篮子] 无法移除 ${entry.name}：`, err);
    }
  }
  return result;
}

/** 清空操作统一进入系统回收站，避免不可恢复删除。 */
export async function clearBasketItems(
  dispose?: (target: string) => Promise<void>,
): Promise<BasketRemovalResult> {
  return removeBasketItems(async () => true, dispose);
}

/** 按设置清理过期内容；0 天表示关闭。 */
export async function cleanupExpiredBasketItems(
  now = Date.now(),
  dispose?: (target: string) => Promise<void>,
): Promise<BasketRemovalResult> {
  const testDays = Number(process.env['XFB_BASKET_TEST_RETENTION_DAYS']);
  const days = Number.isFinite(testDays) && testDays >= 0
    ? testDays
    : (readSettings().basketRetentionDays ?? 0);
  if (days === 0) return { removed: 0, failed: 0 };
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return removeBasketItems(async (target) => {
    const info = await stat(target);
    return (info.birthtimeMs || info.mtimeMs) < cutoff;
  }, dispose);
}

export async function previewBasketItem(id: string): Promise<BasketPreview | null> {
  const target = await resolveBasketItem(id);
  if (!target) return null;
  const info = await stat(target);
  const kind = kindFor(path.basename(target), info.isDirectory());
  const extension = protectedExtension(id, kind);
  const preview: BasketPreview = {
    id,
    name: id,
    renameBase: extension ? id.slice(0, -extension.length) : id,
    kind,
    size: info.isDirectory() ? (await fingerprint(target)).size : info.size,
    modifiedAt: info.mtimeMs,
  };

  if (kind === 'text' || kind === 'url') {
    const limit = 128 * 1024;
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size, limit));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      preview.text = new TextDecoder().decode(buffer.subarray(0, bytesRead));
      preview.textTruncated = info.size > limit;
    } finally {
      await handle.close();
    }
  } else if (kind === 'image') {
    const image = nativeImage.createFromPath(target);
    if (!image.isEmpty()) {
      const { width, height } = image.getSize();
      const scale = Math.min(1, 720 / width, 480 / height);
      const display = scale < 1
        ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
        : image;
      preview.imageDataUrl = display.toDataURL();
    }
  }
  return preview;
}

export async function renameBasketItem(id: string, requestedBase: string): Promise<BasketRenameResult> {
  const target = await resolveBasketItem(id);
  if (!target) return { ok: false, message: '项目已不存在' };

  const info = await lstat(target);
  const kind = kindFor(id, info.isDirectory());
  const base = requestedBase.trim();
  if (!base) return { ok: false, message: '名称不能为空' };
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(base) || /[. ]$/.test(base)) {
    return { ok: false, message: '名称包含 Windows 不允许的字符' };
  }

  const extension = protectedExtension(id, kind);
  const nextName = `${base}${extension}`;
  if (nextName === id) return { ok: true, name: id };
  const dir = await ensureBasketDir();
  const destination = path.join(dir, nextName);
  if (path.dirname(destination) !== dir || existsSync(destination)) {
    return { ok: false, message: '同名项目已存在' };
  }

  try {
    await rename(target, destination);
    return { ok: true, name: nextName };
  } catch (err) {
    console.warn(`[临时篮子] 重命名 ${id} 失败：`, err);
    return { ok: false, message: '重命名失败' };
  }
}

export async function addPathsToBasket(paths: string[]): Promise<BasketAddResult> {
  const dir = await ensureBasketDir();
  const result = emptyAddResult();
  const existing = await basketFingerprints(dir);
  let used = totalSize(existing);

  for (const source of [...new Set(paths)]) {
    try {
      const info = await lstat(source);
      const sourceResolved = path.resolve(source);
      if (path.dirname(sourceResolved) === dir) continue;

      const sourceFingerprint = await fingerprint(sourceResolved);
      if (isDuplicate(sourceFingerprint, existing)) {
        result.duplicates++;
        continue;
      }
      if (used + sourceFingerprint.size > capacityBytes()) {
        result.overCapacity++;
        continue;
      }

      const name = safeName(path.basename(source), info.isDirectory() ? '文件夹' : '文件');
      const destination = await uniquePath(dir, name);
      if (info.isDirectory()) {
        await cp(sourceResolved, destination, { recursive: true, errorOnExist: true, force: false });
      } else {
        await copyFile(sourceResolved, destination);
      }
      result.added++;
      used += sourceFingerprint.size;
      existing.push(sourceFingerprint);
    } catch (err) {
      console.warn(`[临时篮子] 接收路径失败：${source}`, err);
      result.failed++;
    }
  }
  return result;
}

export async function addTextToBasket(text: string): Promise<BasketAddResult> {
  const result = emptyAddResult();
  const content = text.trim();
  if (!content) return result;

  const dir = await ensureBasketDir();
  const bytes = Buffer.from(content, 'utf8');
  const existing = await basketFingerprints(dir);
  const contentFingerprint: Fingerprint = {
    type: 'file',
    size: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
  if (isDuplicate(contentFingerprint, existing)) {
    result.duplicates++;
    return result;
  }
  if (totalSize(existing) + bytes.length > capacityBytes()) {
    result.overCapacity++;
    return result;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = isHttpUrl(content);
  let base = url ? new URL(content).hostname : '文本';
  base = safeName(base, url ? '链接' : '文本');
  const destination = await uniquePath(dir, `${base}-${stamp}${url ? '.url' : ''}.txt`);
  await writeFile(destination, content, 'utf8');
  result.added++;
  return result;
}

export async function addImagesToBasket(images: EmbeddedImage[]): Promise<BasketAddResult> {
  const dir = await ensureBasketDir();
  const result = emptyAddResult();
  const existing = await basketFingerprints(dir);
  let used = totalSize(existing);

  for (const image of images) {
    try {
      const bytes = Buffer.from(image.base64, 'base64');
      if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) continue;
      const imageFingerprint: Fingerprint = {
        type: 'file',
        size: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
      if (isDuplicate(imageFingerprint, existing)) {
        result.duplicates++;
        continue;
      }
      if (used + bytes.length > capacityBytes()) {
        result.overCapacity++;
        continue;
      }
      const extFromMime = IMAGE_MIME_EXTENSIONS[image.mimeType.toLowerCase()] ?? 'png';
      const requested = safeName(image.name, `图片.${extFromMime}`);
      const requestedExtension = path.extname(requested).toLowerCase();
      const withExtension = IMAGE_EXTENSIONS.has(requestedExtension)
        ? requested
        : `${requested}.${extFromMime}`;
      const destination = await uniquePath(dir, withExtension);
      await writeFile(destination, bytes);
      result.added++;
      used += bytes.length;
      existing.push(imageFingerprint);
    } catch (err) {
      console.warn(`[临时篮子] 接收图片失败：${image.name}`, err);
      result.failed++;
    }
  }
  return result;
}

export async function openBasketItem(id: string): Promise<boolean> {
  const target = await resolveBasketItem(id);
  if (!target) return false;

  if (target.endsWith('.url.txt')) {
    const url = (await readFile(target, 'utf8')).trim();
    if (!isHttpUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  }

  return (await shell.openPath(target)) === '';
}

export async function revealBasketItem(id: string): Promise<boolean> {
  const target = await resolveBasketItem(id);
  if (!target) return false;
  shell.showItemInFolder(target);
  return true;
}

/** 返回复制所需的最小数据；文本类复制内容，其余类型由主进程按原生格式写入剪贴板。 */
export async function basketCopyPayload(id: string): Promise<BasketCopyPayload | null> {
  const target = await resolveBasketItem(id);
  if (!target) return null;

  const info = await lstat(target);
  const kind = kindFor(path.basename(target), info.isDirectory());
  if (kind === 'text' || kind === 'url') {
    return { kind, path: target, text: await readFile(target, 'utf8') };
  }
  return { kind, path: target };
}

export async function trashBasketItem(id: string): Promise<boolean> {
  const target = await resolveBasketItem(id);
  if (!target) return false;
  await shell.trashItem(target);
  return true;
}

/* ---------- 可撤销的移除 ---------- */

export interface BasketStagedRemoval {
  token: string;
  count: number;
  failed: number;
}

/**
 * 移除先挪进暂存区，几秒后才真正送进回收站。
 *
 * 系统回收站里的东西没法由程序可靠地还原，所以「撤销」只能在送进去之前做。
 * 暂存区放在篮子目录旁边（同一个卷，rename 是瞬间的），不会被列进篮子。
 */
function pendingDir(): string {
  return `${basketDir()}-pending`;
}

function pendingGroupDir(token: string): string | null {
  if (!/^[0-9a-f-]{36}$/.test(token)) return null;
  return path.join(pendingDir(), token);
}

export async function stageBasketRemoval(ids: string[]): Promise<BasketStagedRemoval> {
  const token = randomUUID();
  const group = pendingGroupDir(token)!;
  await mkdir(group, { recursive: true });
  const result: BasketStagedRemoval = { token, count: 0, failed: 0 };
  for (const id of [...new Set(ids)]) {
    const target = await resolveBasketItem(id);
    if (!target) continue;
    try {
      await rename(target, path.join(group, id));
      result.count++;
    } catch (err) {
      // 常见原因是文件正被别的程序占用（比如刚拖出去、对方还在读）。
      result.failed++;
      console.warn(`[临时篮子] 无法移除 ${id}：`, err);
    }
  }
  if (result.count === 0) await rm(group, { recursive: true, force: true });
  return result;
}

export async function stageAllBasketItems(): Promise<BasketStagedRemoval> {
  const dir = await ensureBasketDir();
  return stageBasketRemoval(await readdir(dir));
}

/** 撤销：挪回篮子。期间若出现同名项，自动加序号，不覆盖。返回挪回的数量。 */
export async function undoBasketRemoval(token: string): Promise<number> {
  const group = pendingGroupDir(token);
  if (!group || !existsSync(group)) return 0;
  const dir = await ensureBasketDir();
  let restored = 0;
  for (const name of await readdir(group)) {
    try {
      await rename(path.join(group, name), await uniquePath(dir, name));
      restored++;
    } catch (err) {
      console.warn(`[临时篮子] 撤销移除 ${name} 失败：`, err);
    }
  }
  await rm(group, { recursive: true, force: true }).catch(() => undefined);
  return restored;
}

/** 撤销窗口过了：把这一组送进系统回收站。 */
export async function commitBasketRemoval(token: string): Promise<void> {
  const group = pendingGroupDir(token);
  if (!group || !existsSync(group)) return;
  for (const name of await readdir(group)) {
    try {
      await shell.trashItem(path.join(group, name));
    } catch (err) {
      console.warn(`[临时篮子] 送入回收站失败，保留在暂存区下次再试：${name}`, err);
    }
  }
  if ((await readdir(group)).length === 0) await rm(group, { recursive: true, force: true });
}

/** 上次退出前没来得及处理的暂存组，启动时补送回收站。 */
export async function commitAllPendingRemovals(): Promise<void> {
  if (!existsSync(pendingDir())) return;
  for (const token of await readdir(pendingDir())) await commitBasketRemoval(token);
}
