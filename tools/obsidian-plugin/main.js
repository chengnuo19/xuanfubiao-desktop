/**
 * 悬浮标的 Obsidian 插件。
 *
 * 在笔记里选中一段文字，按命令发给已经登录好的 ChatGPT / Gemini，
 * 回答直接插在选区下面。走的是本机悬浮标的会话，不需要 API key。
 *
 * **零构建**，和浏览器扩展同一个理由：逻辑就是「读选区 → 发 HTTP → 插文本」，
 * 上一整套打包工具链只会多出一处会坏的地方。这个文件可以直接扔进
 * 库的插件目录里用。
 *
 * 只能在桌面版用（manifest 里标了 isDesktopOnly）：它要连 127.0.0.1，
 * 而悬浮标是个 Windows 桌面程序。手机上没有那个东西可连。
 */

const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView } = require('obsidian');

const API_PORT = 47616;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

const DEFAULT_SETTINGS = {
  /** 留空则自动去悬浮标的数据目录里找。 */
  token: '',
  target: 'chatgpt-web',
  /** 回答用 callout 包起来，和自己写的正文区分开。 */
  wrapInCallout: true,
};

/**
 * 自动找密钥。
 *
 * Obsidian 桌面版跑在 Electron 里，能用 Node 的 fs，所以可以直接去
 * 悬浮标的数据目录里取——用户在托盘里打开接口时文件就已经在那儿了，
 * 没必要让人再复制粘贴一遍。失败了就退回设置里手填，不报错。
 */
function autoToken() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const appData = process.env.APPDATA;
    if (!appData) return '';
    const file = path.join(appData, 'XuanFuBiao', 'api-token.txt');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

module.exports = class XuanFuBiaoPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new XfbSettingTab(this.app, this));

    this.addCommand({
      id: 'ask-selection',
      name: '问 AI（选中的内容）',
      editorCallback: (editor, view) => this.askSelection(editor, view),
    });

    this.addCommand({
      id: 'ask-chatgpt',
      name: '问 ChatGPT（选中的内容）',
      editorCallback: (editor, view) => this.askSelection(editor, view, 'chatgpt-web'),
    });

    this.addCommand({
      id: 'ask-gemini',
      name: '问 Gemini（选中的内容）',
      editorCallback: (editor, view) => this.askSelection(editor, view, 'gemini-web'),
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  token() {
    return this.settings.token.trim() || autoToken();
  }

  async askSelection(editor, view, targetOverride) {
    const selection = editor.getSelection().trim();
    if (!selection) {
      new Notice('先选中一段文字');
      return;
    }

    const token = this.token();
    if (!token) {
      new Notice('没找到调用密钥：确认悬浮标在运行，且托盘里已打开「允许本机程序调用」');
      return;
    }

    const target = targetOverride ?? this.settings.target;

    /*
      先把选区末尾的位置记下来。

      生成要等几十秒，这期间用户完全可能在别处继续编辑，光标早就不在
      原地了。等回答到了再去读光标位置，那段文字会插到一个莫名其妙的
      地方——而且是在用户正专心写别的东西的时候。
    */
    const anchor = editor.getCursor('to');

    const notice = new Notice(`正在问 ${target}…`, 0);
    try {
      const answer = await this.ask(selection, target, token);
      notice.hide();
      if (!answer) {
        new Notice('送到了，但没取回回答正文（多半是站点改版）');
        return;
      }
      this.insertAnswer(editor, view, anchor, answer, target);
      new Notice('回答已插入');
    } catch (err) {
      notice.hide();
      new Notice(`失败：${err.message}`, 8000);
    }
  }

  async ask(text, target, token) {
    let res;
    try {
      res = await fetch(`${API_BASE}/ask`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, target, client: 'obsidian', timeoutMs: 300000 }),
      });
    } catch (err) {
      throw new Error(`连不上悬浮标（${API_BASE}），它在运行吗？`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error ?? `悬浮标返回 ${res.status}`);
    return (body.answers ?? []).map((a) => a.answer).filter(Boolean).join('\n\n');
  }

  insertAnswer(editor, view, anchor, answer, target) {
    const label = target === 'gemini-web' ? 'Gemini' : 'ChatGPT';
    const body = this.settings.wrapInCallout
      ? [`> [!quote] ${label}`, ...answer.split('\n').map((line) => `> ${line}`)].join('\n')
      : answer;
    const block = `\n\n${body}\n`;

    /*
      插在记下来的锚点处，而不是当前光标处。理由见 askSelection 里那段：
      等待期间光标可能已经跑到别的地方了。
    */
    editor.replaceRange(block, anchor);
  }
};

class XfbSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('调用密钥')
      .setDesc(
        autoToken()
          ? '已自动从悬浮标的数据目录里读到密钥，这里留空即可。'
          : '没能自动读到。请在悬浮标托盘菜单里点「复制调用密钥」，粘贴到这里。',
      )
      .addText((text) =>
        text
          .setPlaceholder('留空则自动读取')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('默认发给')
      .setDesc('「问 AI」这个命令用哪个目标。另外两个命令各自指定，不受这里影响。')
      .addDropdown((drop) =>
        drop
          .addOption('chatgpt-web', 'ChatGPT（网页端）')
          .addOption('gemini-web', 'Gemini（网页端）')
          .setValue(this.plugin.settings.target)
          .onChange(async (value) => {
            this.plugin.settings.target = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('回答用引用块包起来')
      .setDesc('插进来的是 AI 写的，和自己写的正文分开更清楚。关掉则插入纯文本。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.wrapInCallout).onChange(async (value) => {
          this.plugin.settings.wrapInCallout = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('p', {
      text: '需要悬浮标正在运行，并且托盘菜单里的「允许本机程序调用」已经打开。一次只能跑一个请求，第二个会排队。',
      cls: 'setting-item-description',
    });
  }
}
