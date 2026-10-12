/**
 * 网页浮栏的纯数据逻辑。
 *
 * 这个文件同时被 Chrome content script 和 Node 的单元测试直接加载，
 * 所以不用 import/export，而是只挂一个冻结后的命名空间。
 */

(() => {
  if (globalThis.__xfbFloatBarModel) return;

  function normalizeHttpUrl(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new Error('网址不能为空');

    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed);
    const candidate = hasScheme ? trimmed : `https://${trimmed}`;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error('网址格式不正确');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('仅支持 HTTP/HTTPS 网址');
    }
    return url.href;
  }

  function normalizeIconUrl(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('data:image/')) return trimmed;
    return normalizeHttpUrl(trimmed);
  }

  function createApp(input) {
    const id = String(input?.id ?? '').trim();
    const name = String(input?.name ?? '').trim();
    if (!id) throw new Error('应用 id 不能为空');
    if (!name) throw new Error('应用名称不能为空');
    return {
      id,
      name,
      url: normalizeHttpUrl(input?.url),
      icon: normalizeIconUrl(input?.icon),
    };
  }

  function faviconUrlFor(rawUrl) {
    const url = new URL(normalizeHttpUrl(rawUrl));
    return new URL('/favicon.ico', url.origin).href;
  }

  function sanitizeApps(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const item of value) {
      try {
        const app = createApp(item);
        if (seen.has(app.id)) continue;
        seen.add(app.id);
        result.push(app);
      } catch {
        // 设置可能被旧版本或人工编辑损坏；坏项跳过，不能拖垮全部侧栏。
      }
    }
    return result;
  }

  function moveApp(apps, draggedId, targetId, placement) {
    if (draggedId === targetId) return [...apps];
    const draggedIndex = apps.findIndex((app) => app.id === draggedId);
    const originalTargetIndex = apps.findIndex((app) => app.id === targetId);
    if (draggedIndex < 0 || originalTargetIndex < 0) return [...apps];

    const next = [...apps];
    const [dragged] = next.splice(draggedIndex, 1);
    if (!dragged) return [...apps];
    const targetIndex = next.findIndex((app) => app.id === targetId);
    next.splice(placement === 'after' ? targetIndex + 1 : targetIndex, 0, dragged);
    return next;
  }

  function defaultApps() {
    return [
      createApp({ id: 'app-chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' }),
      createApp({ id: 'app-gemini', name: 'Gemini', url: 'https://gemini.google.com/' }),
      createApp({ id: 'app-gmail', name: 'Gmail', url: 'https://mail.google.com/' }),
      createApp({ id: 'app-whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com/' }),
      createApp({ id: 'app-telegram', name: 'Telegram', url: 'https://web.telegram.org/k/' }),
      createApp({ id: 'app-youtube', name: 'YouTube', url: 'https://www.youtube.com/' }),
    ].map((app) => ({ ...app, icon: faviconUrlFor(app.url) }));
  }

  globalThis.__xfbFloatBarModel = Object.freeze({
    createApp,
    defaultApps,
    faviconUrlFor,
    moveApp,
    normalizeHttpUrl,
    sanitizeApps,
  });
})();
