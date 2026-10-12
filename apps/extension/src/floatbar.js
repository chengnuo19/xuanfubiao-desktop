/**
 * 网页浮栏：在普通网页右侧提供可收起的应用 Dock；在受管应用弹窗中提供
 * Document Picture-in-Picture 置顶入口。
 */

(() => {
  if (window !== window.top || window.__xfbFloatBarLoaded) return;
  window.__xfbFloatBarLoaded = true;

  const model = globalThis.__xfbFloatBarModel;
  if (!model) {
    console.error('[悬浮标·网页浮栏] 数据模型未先加载');
    return;
  }

  const { createApp, defaultApps, faviconUrlFor, moveApp, sanitizeApps } = model;
  const APPS_KEY = 'xfbFloatbarApps';
  const APP_BOUNDS_KEY = 'xfbFloatbarAppBounds';
  const ROOT_ID = 'xfb-floatbar-root';
  let sidebarController = null;

  function waitForDocumentElement() {
    if (document.documentElement) return Promise.resolve();
    return new Promise((resolve) => document.addEventListener('readystatechange', resolve, { once: true }));
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      console.warn('[悬浮标·网页浮栏] 后台通信失败：', error);
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  function initialNode(name) {
    const span = document.createElement('span');
    span.className = 'app-initial';
    span.textContent = name.trim().charAt(0).toUpperCase() || '?';
    return span;
  }

  function iconNode(app) {
    if (!app.icon) return initialNode(app.name);
    const image = document.createElement('img');
    image.src = app.icon;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.replaceWith(initialNode(app.name)), { once: true });
    return image;
  }

  async function initSidebar() {
    await waitForDocumentElement();
    if (document.getElementById(ROOT_ID)) return null;

    // chrome.storage.local 是 MV3 官方建议的扩展本地持久化区，清浏览器缓存也不会丢。
    // Source: https://developer.chrome.com/docs/extensions/reference/api/storage#storage-areas
    const stored = await chrome.storage.local.get(APPS_KEY);
    let apps = sanitizeApps(stored[APPS_KEY]);
    if (apps.length === 0) {
      apps = defaultApps();
      await chrome.storage.local.set({ [APPS_KEY]: apps });
    }

    const host = document.createElement('div');
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        color-scheme: light dark;
        /* 和桌面端 #79a9ff 同一个色相（218°），浅色底上压深到能过 4.5:1 */
        --xfb-accent: hsl(218 80% 50%);
        --xfb-on-accent: #fff;
        --xfb-bg: rgba(248, 249, 252, .94);
        --xfb-elevated: rgba(255, 255, 255, .96);
        --xfb-fg: #1e2530;
        --xfb-dim: #687386;
        --xfb-line: rgba(29, 38, 52, .12);
        --xfb-hit: rgba(55, 87, 140, .09);
        --xfb-shadow: 0 18px 50px rgba(20, 28, 40, .23);
        font-family: "Segoe UI Variable Text", "Microsoft YaHei UI", system-ui, sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --xfb-accent: #79a9ff;
          /* 浅蓝实底上白字对比度只有 2 出头，深色模式下 accent 上一律用深字 */
          --xfb-on-accent: #16181f;
          --xfb-bg: rgba(24, 27, 34, .94);
          --xfb-elevated: rgba(34, 38, 48, .98);
          --xfb-fg: #eef1f7;
          --xfb-dim: #aab2c0;
          --xfb-line: rgba(255, 255, 255, .11);
          --xfb-hit: rgba(255, 255, 255, .08);
          --xfb-shadow: 0 20px 55px rgba(0, 0, 0, .48);
        }
      }
      * { box-sizing: border-box; }
      button, input { font: inherit; }
      .shell {
        position: fixed;
        top: 50%;
        right: 0;
        width: 78px;
        transform: translate(66px, -50%);
        transition: transform 180ms cubic-bezier(.2, .75, .2, 1);
        pointer-events: auto;
      }
      .shell.open { transform: translate(0, -50%); }
      .handle {
        position: absolute;
        left: 0;
        top: 50%;
        width: 12px;
        height: 76px;
        transform: translateY(-50%);
        padding: 0;
        border: 1px solid var(--xfb-line);
        border-right: 0;
        border-radius: 12px 0 0 12px;
        background: var(--xfb-bg);
        box-shadow: -5px 0 18px rgba(0, 0, 0, .12);
        cursor: pointer;
      }
      .handle::after {
        content: '';
        position: absolute;
        left: 4px;
        top: 27px;
        width: 2px;
        height: 20px;
        border-radius: 2px;
        background: var(--xfb-accent);
        opacity: .75;
      }
      .dock {
        margin-left: 11px;
        width: 67px;
        max-height: min(78vh, 720px);
        padding: 8px 7px;
        border: 1px solid var(--xfb-line);
        border-right: 0;
        border-radius: 18px 0 0 18px;
        background: var(--xfb-bg);
        color: var(--xfb-fg);
        box-shadow: var(--xfb-shadow);
        backdrop-filter: blur(22px) saturate(150%);
        overflow-y: auto;
        scrollbar-width: none;
      }
      .dock::-webkit-scrollbar { display: none; }
      .brand {
        display: grid;
        place-items: center;
        width: 43px;
        height: 28px;
        margin: 0 auto 5px;
        color: var(--xfb-dim);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .06em;
        user-select: none;
      }
      .apps { display: grid; gap: 6px; }
      .app-item { position: relative; width: 51px; min-height: 51px; border-radius: 14px; }
      .launch, .add {
        display: grid;
        place-items: center;
        width: 51px;
        height: 51px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 14px;
        background: transparent;
        color: var(--xfb-fg);
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
      }
      .launch:hover, .launch:focus-visible, .add:hover, .add:focus-visible {
        outline: none;
        background: var(--xfb-hit);
        border-color: var(--xfb-line);
        transform: translateX(-2px);
      }
      .launch img { width: 31px; height: 31px; border-radius: 9px; object-fit: contain; }
      .app-initial {
        display: grid;
        place-items: center;
        width: 31px;
        height: 31px;
        border-radius: 9px;
        background: var(--xfb-accent);
        color: var(--xfb-on-accent);
        font-size: 14px;
        font-weight: 700;
      }
      .tools {
        position: absolute;
        top: -4px;
        right: -4px;
        display: flex;
        gap: 2px;
        opacity: 0;
        transform: translateY(2px);
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .app-item:hover .tools, .app-item:focus-within .tools { opacity: 1; transform: none; }
      .tool {
        display: grid;
        place-items: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 1px solid var(--xfb-line);
        border-radius: 50%;
        background: var(--xfb-elevated);
        color: var(--xfb-dim);
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
      }
      .tool:hover { color: var(--xfb-fg); border-color: var(--xfb-accent); }
      .app-item.dragging { opacity: .38; }
      .app-item.drop-before::before, .app-item.drop-after::after {
        content: '';
        position: absolute;
        left: 7px;
        right: 7px;
        height: 3px;
        border-radius: 3px;
        background: var(--xfb-accent);
      }
      .app-item.drop-before::before { top: -4px; }
      .app-item.drop-after::after { bottom: -4px; }
      .add { margin-top: 6px; color: var(--xfb-accent); font-size: 25px; font-weight: 300; }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        display: none;
        place-items: center;
        padding: 24px;
        background: rgba(8, 11, 16, .38);
        backdrop-filter: blur(4px);
        pointer-events: auto;
      }
      .modal-backdrop.show { display: grid; }
      .modal {
        width: min(420px, calc(100vw - 32px));
        padding: 20px;
        border: 1px solid var(--xfb-line);
        border-radius: 18px;
        background: var(--xfb-elevated);
        color: var(--xfb-fg);
        box-shadow: var(--xfb-shadow);
      }
      .modal h2 { margin: 0 0 5px; font-size: 17px; }
      .modal .lead { margin: 0 0 17px; color: var(--xfb-dim); font-size: 12px; }
      .field { display: grid; gap: 6px; margin-top: 12px; }
      .field label { color: var(--xfb-dim); font-size: 12px; }
      .field input {
        width: 100%;
        padding: 9px 11px;
        border: 1px solid var(--xfb-line);
        border-radius: 9px;
        background: transparent;
        color: var(--xfb-fg);
        font-size: 13px;
      }
      .field input:focus { outline: 2px solid color-mix(in srgb, var(--xfb-accent) 60%, transparent); }
      .modal-status { min-height: 19px; margin-top: 8px; color: #e25757; font-size: 12px; }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .actions button {
        padding: 8px 14px;
        border: 1px solid var(--xfb-line);
        border-radius: 9px;
        background: transparent;
        color: var(--xfb-fg);
        cursor: pointer;
      }
      .actions .primary { border-color: var(--xfb-accent); background: var(--xfb-accent); color: var(--xfb-on-accent); }
      .tooltip {
        position: fixed;
        right: 84px;
        padding: 5px 8px;
        border-radius: 7px;
        background: var(--xfb-elevated);
        color: var(--xfb-fg);
        box-shadow: 0 6px 20px rgba(0,0,0,.2);
        font-size: 11px;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 90ms ease;
      }
      .tooltip.show { opacity: 1; }
      @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
    `;

    const shell = document.createElement('div');
    shell.className = 'shell';
    shell.innerHTML = `
      <button class="handle" type="button" aria-label="打开网页浮栏"></button>
      <aside class="dock" aria-label="网页浮栏">
        <div class="brand">网页</div>
        <div class="apps" role="list"></div>
        <button class="add" type="button" aria-label="添加 Web 应用">+</button>
      </aside>
    `;

    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'modal-backdrop';
    modalBackdrop.innerHTML = `
      <form class="modal">
        <h2>添加 Web 应用</h2>
        <p class="lead">应用会在独立弹窗中打开，可进一步切换为置顶窗口。</p>
        <div class="field"><label for="xfb-app-name">名称</label><input id="xfb-app-name" maxlength="48" autocomplete="off" /></div>
        <div class="field"><label for="xfb-app-url">网址</label><input id="xfb-app-url" inputmode="url" autocomplete="off" /></div>
        <div class="field"><label for="xfb-app-icon">图标网址（可选）</label><input id="xfb-app-icon" inputmode="url" autocomplete="off" /></div>
        <div class="modal-status" role="status"></div>
        <div class="actions"><button class="cancel" type="button">取消</button><button class="primary" type="submit">保存</button></div>
      </form>
    `;

    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    shadow.append(style, shell, modalBackdrop, tooltip);
    document.documentElement.appendChild(host);

    const appsElement = shell.querySelector('.apps');
    const handle = shell.querySelector('.handle');
    const addButton = shell.querySelector('.add');
    const form = modalBackdrop.querySelector('form');
    const modalTitle = modalBackdrop.querySelector('h2');
    const nameInput = modalBackdrop.querySelector('#xfb-app-name');
    const urlInput = modalBackdrop.querySelector('#xfb-app-url');
    const iconInput = modalBackdrop.querySelector('#xfb-app-icon');
    const status = modalBackdrop.querySelector('.modal-status');
    let editingId = null;
    let collapseTimer = null;
    let draggedId = null;

    function setOpen(open) {
      clearTimeout(collapseTimer);
      shell.classList.toggle('open', open);
      handle.setAttribute('aria-label', open ? '收起网页浮栏' : '打开网页浮栏');
    }

    function scheduleCollapse() {
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => {
        if (!modalBackdrop.classList.contains('show')) setOpen(false);
      }, 420);
    }

    function showTooltip(item, text) {
      const rect = item.getBoundingClientRect();
      tooltip.textContent = text;
      tooltip.style.top = `${Math.round(rect.top + rect.height / 2 - 12)}px`;
      tooltip.classList.add('show');
    }

    function hideTooltip() {
      tooltip.classList.remove('show');
    }

    async function saveApps(next) {
      apps = sanitizeApps(next);
      await chrome.storage.local.set({ [APPS_KEY]: apps });
      render();
    }

    function clearDropMarks() {
      for (const item of appsElement.querySelectorAll('.app-item')) {
        item.classList.remove('dragging', 'drop-before', 'drop-after');
      }
    }

    function render() {
      appsElement.replaceChildren();
      for (const app of apps) {
        const item = document.createElement('div');
        item.className = 'app-item';
        item.dataset.appId = app.id;
        item.draggable = true;
        item.setAttribute('role', 'listitem');

        const launch = document.createElement('button');
        launch.className = 'launch';
        launch.type = 'button';
        launch.setAttribute('aria-label', `打开 ${app.name}`);
        launch.append(iconNode(app));
        launch.addEventListener('click', () => {
          if (draggedId) return;
          hideTooltip();
          void send({ type: 'floatbar:open-app', app });
          setOpen(false);
        });
        launch.addEventListener('mouseenter', () => showTooltip(launch, app.name));
        launch.addEventListener('mouseleave', hideTooltip);

        const tools = document.createElement('div');
        tools.className = 'tools';
        const edit = document.createElement('button');
        edit.className = 'tool';
        edit.type = 'button';
        edit.textContent = '✎';
        edit.setAttribute('aria-label', `编辑 ${app.name}`);
        edit.addEventListener('click', () => openEditor(app));
        const remove = document.createElement('button');
        remove.className = 'tool';
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `删除 ${app.name}`);
        remove.addEventListener('click', () => {
          if (confirm(`从网页浮栏移除“${app.name}”？`)) void saveApps(apps.filter((item) => item.id !== app.id));
        });
        tools.append(edit, remove);
        item.append(launch, tools);

        item.addEventListener('dragstart', (event) => {
          draggedId = app.id;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', app.id);
          requestAnimationFrame(() => item.classList.add('dragging'));
        });
        item.addEventListener('dragover', (event) => {
          if (!draggedId || draggedId === app.id) return;
          event.preventDefault();
          const before = event.clientY < item.getBoundingClientRect().top + item.offsetHeight / 2;
          item.classList.toggle('drop-before', before);
          item.classList.toggle('drop-after', !before);
        });
        item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
        item.addEventListener('drop', (event) => {
          event.preventDefault();
          if (!draggedId) return;
          const placement = item.classList.contains('drop-after') ? 'after' : 'before';
          void saveApps(moveApp(apps, draggedId, app.id, placement));
          clearDropMarks();
          draggedId = null;
        });
        item.addEventListener('dragend', () => {
          clearDropMarks();
          setTimeout(() => { draggedId = null; }, 0);
        });
        appsElement.append(item);
      }
    }

    function closeEditor() {
      modalBackdrop.classList.remove('show');
      status.textContent = '';
      editingId = null;
    }

    function openEditor(seed = null) {
      setOpen(true);
      editingId = seed?.id && apps.some((app) => app.id === seed.id) ? seed.id : null;
      modalTitle.textContent = editingId ? '编辑 Web 应用' : '添加 Web 应用';
      nameInput.value = seed?.name ?? '';
      urlInput.value = seed?.url ?? '';
      iconInput.value = seed?.icon ?? '';
      status.textContent = '';
      modalBackdrop.classList.add('show');
      nameInput.focus();
    }

    async function storeEditor() {
      status.textContent = '';
      const id = editingId ?? `app-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let app;
      try {
        app = createApp({ id, name: nameInput.value, url: urlInput.value, icon: iconInput.value });
      } catch (error) {
        status.textContent = String(error?.message ?? error);
        return;
      }
      if (!editingId && apps.some((item) => item.url === app.url)) {
        status.textContent = '这个网址已经在网页浮栏里了';
        return;
      }

      const iconUrl = app.icon || faviconUrlFor(app.url);
      const downloaded = await send({ type: 'floatbar:download-icon', url: iconUrl });
      app = { ...app, icon: downloaded?.dataUrl ?? iconUrl };
      const next = editingId
        ? apps.map((item) => item.id === editingId ? app : item)
        : [...apps, app];
      await saveApps(next);
      closeEditor();
    }

    handle.addEventListener('mouseenter', () => setOpen(true));
    handle.addEventListener('click', () => setOpen(!shell.classList.contains('open')));
    shell.addEventListener('mouseenter', () => clearTimeout(collapseTimer));
    shell.addEventListener('mouseleave', scheduleCollapse);
    addButton.addEventListener('click', () => openEditor());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void storeEditor();
    });
    modalBackdrop.querySelector('.cancel').addEventListener('click', closeEditor);
    modalBackdrop.addEventListener('click', (event) => {
      if (event.target === modalBackdrop) closeEditor();
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeEditor();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[APPS_KEY]) return;
      apps = sanitizeApps(changes[APPS_KEY].newValue);
      render();
    });

    render();

    // 远程图片会受宿主页 CSP 影响；后台取回 data URL 后就完全本地渲染。
    void (async () => {
      let changed = false;
      const hydrated = [];
      for (const app of apps) {
        if (!app.icon || app.icon.startsWith('data:image/')) {
          hydrated.push(app);
          continue;
        }
        const result = await send({ type: 'floatbar:download-icon', url: app.icon });
        if (result?.dataUrl) {
          hydrated.push({ ...app, icon: result.dataUrl });
          changed = true;
        } else {
          hydrated.push(app);
        }
      }
      if (changed) await saveApps(hydrated);
    })();

    return { open: () => setOpen(true), openEditor };
  }

  async function initAppHost(info) {
    await waitForDocumentElement();
    let currentBounds = info.bounds;
    const host = document.createElement('div');
    host.id = `${ROOT_ID}-host-controls`;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; top: 10px; left: 50%; z-index: 2147483647; font-family: "Segoe UI Variable Text", "Microsoft YaHei UI", system-ui, sans-serif; }
      .bar { display: flex; align-items: center; gap: 8px; transform: translateX(-50%); padding: 7px 9px 7px 12px; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; background: rgba(23,26,33,.92); color: #eef1f7; box-shadow: 0 12px 35px rgba(0,0,0,.38); backdrop-filter: blur(18px); font-size: 12px; white-space: nowrap; }
      .label { color: rgba(238,241,247,.68); }
      button { padding: 6px 10px; border: 0; border-radius: 999px; background: #79a9ff; color: #101622; font: inherit; font-weight: 600; cursor: pointer; }
      button.secondary { background: rgba(255,255,255,.09); color: #eef1f7; }
      button:disabled { opacity: .58; cursor: wait; }
      .error { color: #ff9b9b; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '应用弹窗';
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.textContent = '置顶';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'secondary';
    close.textContent = '关闭';
    bar.append(label, pin, close);
    shadow.append(style, bar);
    document.documentElement.appendChild(host);

    // 普通弹窗可能在页面加载后又被用户缩放。监听后台去抖落盘的最新值，
    // 这样点击「置顶」时仍能同步调用 requestWindow（保住用户手势），又不会用旧尺寸。
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[APP_BOUNDS_KEY]) return;
      const latest = changes[APP_BOUNDS_KEY].newValue?.[info.appId];
      if (latest) currentBounds = latest;
    });

    close.addEventListener('click', () => void send({ type: 'floatbar:close-host' }));
    pin.addEventListener('click', async () => {
      // Document PiP 必须由用户手势触发，且它是 Chrome 提供的真正置顶窗口。
      // Source: https://developer.chrome.com/docs/web-platform/document-picture-in-picture#methods
      if (!('documentPictureInPicture' in window)) {
        label.textContent = '当前 Chrome 不支持 Document PiP（需要 116+）';
        label.classList.add('error');
        return;
      }
      pin.disabled = true;
      label.textContent = '正在打开置顶窗口…';
      try {
        const pipWindow = await window.documentPictureInPicture.requestWindow({
          width: currentBounds.width,
          height: currentBounds.height,
        });
        pipWindow.document.title = document.title;
        pipWindow.document.body.style.cssText = 'margin:0;overflow:hidden;background:#111;';
        const iframe = pipWindow.document.createElement('iframe');
        iframe.src = location.href;
        iframe.title = document.title;
        iframe.style.cssText = 'display:block;width:100vw;height:100vh;border:0;background:white;';
        iframe.setAttribute('allow', 'fullscreen; camera; microphone; display-capture; autoplay; encrypted-media; clipboard-read; clipboard-write');
        pipWindow.document.body.appendChild(iframe);

        for (const media of document.querySelectorAll('audio, video')) media.pause?.();
        label.textContent = '已置顶';
        await send({ type: 'floatbar:minimize-host' });

        let resizeTimer = null;
        pipWindow.addEventListener('resize', () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            void send({
              type: 'floatbar:save-pip-size',
              appId: info.appId,
              width: pipWindow.innerWidth,
              height: pipWindow.innerHeight,
            });
          }, 500);
        });
        pipWindow.addEventListener('pagehide', () => {
          void send({ type: 'floatbar:restore-host' }).finally(() => location.reload());
        }, { once: true });
      } catch (error) {
        label.textContent = `置顶失败：${String(error?.message ?? error)}`;
        label.classList.add('error');
        pin.disabled = false;
      }
    });
  }

  const ready = (async () => {
    const info = await send({ type: 'floatbar:is-app-window' });
    if (info?.isAppWindow) {
      await initAppHost(info);
      return;
    }
    sidebarController = await initSidebar();
  })();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'floatbar:open' && message?.type !== 'floatbar:add-current-page') return false;
    void ready.then(() => {
      if (!sidebarController) return { ok: false };
      if (message.type === 'floatbar:open') sidebarController.open();
      else sidebarController.openEditor(message.page ?? {});
      return { ok: true };
    }).then(sendResponse);
    return true;
  });
})();
