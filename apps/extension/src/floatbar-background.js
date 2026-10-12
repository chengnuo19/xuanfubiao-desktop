/**
 * 网页浮栏的 MV3 后台能力：管理应用弹窗、记住窗口边界、下载站点图标，
 * 并提供工具栏按钮与页面右键菜单入口。
 */

import './floatbar-model.js';

const { createApp } = globalThis.__xfbFloatBarModel;

const OPEN_WINDOWS_KEY = 'xfbFloatbarOpenWindows';
const APP_BOUNDS_KEY = 'xfbFloatbarAppBounds';
const MENU_ADD = 'xfb-floatbar-add-page';
const MENU_OPEN = 'xfb-floatbar-open-page';
const DEFAULT_BOUNDS = Object.freeze({ width: 420, height: 640 });
const MAX_ICON_BYTES = 1024 * 1024;

let openWindowsCache = null;
let appBoundsCache = null;
let boundsWriteTimer = null;

async function getOpenWindows() {
  if (openWindowsCache) return openWindowsCache;
  const stored = await chrome.storage.local.get(OPEN_WINDOWS_KEY);
  openWindowsCache = stored[OPEN_WINDOWS_KEY] ?? {};
  return openWindowsCache;
}

async function saveOpenWindows(map) {
  openWindowsCache = map;
  await chrome.storage.local.set({ [OPEN_WINDOWS_KEY]: map });
}

async function getAppBounds() {
  if (appBoundsCache) return appBoundsCache;
  const stored = await chrome.storage.local.get(APP_BOUNDS_KEY);
  appBoundsCache = stored[APP_BOUNDS_KEY] ?? {};
  return appBoundsCache;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizedBounds(value) {
  const bounds = value && typeof value === 'object' ? value : {};
  const result = {
    width: clampInteger(bounds.width, 320, 1800, DEFAULT_BOUNDS.width),
    height: clampInteger(bounds.height, 360, 1400, DEFAULT_BOUNDS.height),
  };
  if (Number.isFinite(bounds.left)) result.left = Math.round(bounds.left);
  if (Number.isFinite(bounds.top)) result.top = Math.round(bounds.top);
  return result;
}

function queueBoundsWrite(map) {
  appBoundsCache = map;
  clearTimeout(boundsWriteTimer);
  boundsWriteTimer = setTimeout(() => {
    void chrome.storage.local.set({ [APP_BOUNDS_KEY]: appBoundsCache });
  }, 500);
}

async function appIdForWindow(windowId) {
  const windows = await getOpenWindows();
  return Object.keys(windows).find((appId) => windows[appId] === windowId) ?? null;
}

async function focusExistingWindow(windowId, appUrl) {
  try {
    const existing = await chrome.windows.get(windowId, { populate: true });
    await chrome.windows.update(windowId, { focused: true, state: 'normal' });

    const tab = existing.tabs?.[0];
    if (tab?.id !== undefined && tab.url) {
      const currentOrigin = new URL(tab.url).origin;
      const requestedOrigin = new URL(appUrl).origin;
      if (currentOrigin !== requestedOrigin) await chrome.tabs.update(tab.id, { url: appUrl });
    }
    return true;
  } catch {
    return false;
  }
}

async function openAppWindow(rawApp) {
  const app = createApp(rawApp);
  const openWindows = await getOpenWindows();
  const existingWindowId = openWindows[app.id];
  if (Number.isInteger(existingWindowId) && await focusExistingWindow(existingWindowId, app.url)) {
    return { ok: true, reused: true };
  }

  if (Number.isInteger(existingWindowId)) {
    delete openWindows[app.id];
    await saveOpenWindows(openWindows);
  }

  const boundsMap = await getAppBounds();
  const bounds = normalizedBounds(boundsMap[app.id]);
  // popup 类型和窗口边界来自 Chrome windows API。
  // Source: https://developer.chrome.com/docs/extensions/reference/api/windows
  const created = await chrome.windows.create({
    url: 'about:blank',
    type: 'popup',
    focused: true,
    ...bounds,
  });
  if (created.id === undefined || created.tabs?.[0]?.id === undefined) {
    throw new Error('Chrome 没有返回新窗口标识');
  }

  // 先记窗口身份，再导航到远程站点。这样 content script 首次执行时就能可靠识别
  // 自己是应用宿主窗，不需要把内部标记塞进目标网址并发送给远端服务器。
  openWindows[app.id] = created.id;
  await saveOpenWindows(openWindows);
  await chrome.tabs.update(created.tabs[0].id, { url: app.url });
  return { ok: true, reused: false };
}

async function updateSenderWindow(sender, update) {
  const windowId = sender.tab?.windowId;
  if (!Number.isInteger(windowId) || !(await appIdForWindow(windowId))) return false;
  await chrome.windows.update(windowId, update);
  return true;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function downloadIcon(rawUrl) {
  const url = new URL(String(rawUrl ?? ''));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const response = await fetch(url.href, { credentials: 'omit', redirect: 'follow' });
  if (!response.ok) return null;
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!contentType.startsWith('image/')) return null;
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > MAX_ICON_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return null;
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

async function sendToTabWithInjection(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/floatbar-model.js', 'src/floatbar.js'],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('floatbar:')) {
    return false;
  }

  void (async () => {
    switch (message.type) {
      case 'floatbar:open-app':
        return openAppWindow(message.app);

      case 'floatbar:is-app-window': {
        const windowId = sender.tab?.windowId;
        if (!Number.isInteger(windowId)) return { isAppWindow: false };
        const appId = await appIdForWindow(windowId);
        if (!appId) return { isAppWindow: false };
        const bounds = normalizedBounds((await getAppBounds())[appId]);
        return { isAppWindow: true, appId, bounds };
      }

      case 'floatbar:minimize-host':
        return { ok: await updateSenderWindow(sender, { state: 'minimized' }) };

      case 'floatbar:restore-host':
        return { ok: await updateSenderWindow(sender, { state: 'normal', focused: true }) };

      case 'floatbar:close-host': {
        const windowId = sender.tab?.windowId;
        if (!Number.isInteger(windowId) || !(await appIdForWindow(windowId))) return { ok: false };
        await chrome.windows.remove(windowId);
        return { ok: true };
      }

      case 'floatbar:save-pip-size': {
        const windowId = sender.tab?.windowId;
        if (!Number.isInteger(windowId)) return { ok: false };
        const appId = await appIdForWindow(windowId);
        if (!appId || appId !== message.appId) return { ok: false };
        const map = await getAppBounds();
        const previous = normalizedBounds(map[appId]);
        map[appId] = normalizedBounds({
          ...previous,
          width: message.width,
          height: message.height,
        });
        queueBoundsWrite(map);
        return { ok: true };
      }

      case 'floatbar:download-icon':
        return { dataUrl: await downloadIcon(message.url).catch(() => null) };

      default:
        return { ok: false, reason: '未知的网页浮栏操作' };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, reason: String(error?.message ?? error) }));

  return true;
});

chrome.windows.onBoundsChanged.addListener((window) => {
  if (window.id === undefined) return;
  void (async () => {
    const appId = await appIdForWindow(window.id);
    if (!appId || window.state === 'minimized') return;
    const map = await getAppBounds();
    map[appId] = normalizedBounds(window);
    queueBoundsWrite(map);
  })();
});

chrome.windows.onRemoved.addListener((windowId) => {
  void (async () => {
    const map = await getOpenWindows();
    const appId = Object.keys(map).find((id) => map[id] === windowId);
    if (!appId) return;
    delete map[appId];
    await saveOpenWindows(map);
  })();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[OPEN_WINDOWS_KEY]) openWindowsCache = changes[OPEN_WINDOWS_KEY].newValue ?? {};
  if (changes[APP_BOUNDS_KEY]) appBoundsCache = changes[APP_BOUNDS_KEY].newValue ?? {};
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void sendToTabWithInjection(tab.id, { type: 'floatbar:open' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    for (const id of [MENU_ADD, MENU_OPEN]) {
      await new Promise((resolve) => {
        chrome.contextMenus.remove(id, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    }
    chrome.contextMenus.create({ id: MENU_ADD, title: '将当前页面加入网页浮栏', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_OPEN, title: '在置顶窗口打开当前页面', contexts: ['page'] });
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.url || !/^https?:/i.test(tab.url)) return;

  if (info.menuItemId === MENU_ADD && tab.id !== undefined) {
    void sendToTabWithInjection(tab.id, {
      type: 'floatbar:add-current-page',
      page: { name: tab.title ?? new URL(tab.url).hostname, url: tab.url, icon: tab.favIconUrl ?? '' },
    }).catch(() => {});
    return;
  }

  if (info.menuItemId === MENU_OPEN) {
    const hostname = new URL(tab.url).hostname.replace(/[^a-z\d.-]/gi, '-');
    void openAppWindow({
      id: `page-${hostname}`,
      name: tab.title ?? hostname,
      url: tab.url,
      icon: tab.favIconUrl ?? '',
    }).catch(() => {});
  }
});
