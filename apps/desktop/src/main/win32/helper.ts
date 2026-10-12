/**
 * PowerShell 助手进程的客户端封装。
 *
 * 助手常驻运行，用 JSON 行协议收发。这里负责：
 * 进程生命周期、请求/响应配对、超时、以及崩溃后自动重启。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { app } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';

export interface HelperResponse {
  id: number;
  ok?: boolean;
  reason?: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (value: HelperResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 单次请求的默认超时。deliver 涉及窗口切换和等待，需要更长，调用方另行指定。 */
const DEFAULT_TIMEOUT_MS = 5_000;

function resolveScriptPath(): string {
  // 打包后脚本随 extraResources 走；开发时直接读源码目录。
  const packaged = path.join(process.resourcesPath, 'win32-helper.ps1');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'win32-helper.ps1');
}

export class Win32Helper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private readyPromise: Promise<void> | null = null;
  private disposed = false;
  private shakeConfig: Record<string, unknown> | null = null;

  /** 启动助手进程，等它报告 ready。重复调用是安全的。 */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('助手已关闭'));
    if (this.readyPromise) return this.readyPromise;

    const script = resolveScriptPath();
    if (!existsSync(script)) return Promise.reject(new Error(`找不到助手脚本：${script}`));

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true },
      );
      this.child = child;
      this.buffer = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      let settled = false;
      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('助手进程启动超时'));
        child.kill();
      }, DEFAULT_TIMEOUT_MS);
      const onReady = () => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          // 助手重建后先恢复配置，再让调用方开始轮询，避免退回默认灵敏度和开关。
          if (this.shakeConfig) {
            child.stdin.write(JSON.stringify({ id: this.nextId++, cmd: 'shake-config', ...this.shakeConfig }) + '\n');
          }
          resolve();
        }
      };

      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          this.handleLine(line, onReady);
        }
      });

      child.stderr.on('data', (chunk: string) => {
        // 助手的 stderr 只当日志，不影响协议。
        console.error('[win32-helper]', chunk.trimEnd());
      });

      child.on('close', (code) => {
        clearTimeout(startupTimer);
        if (this.child !== child) return;
        this.child = null;
        this.readyPromise = null;
        // 所有在途请求都失败掉，避免调用方永久挂起。
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('助手进程已退出'));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(new Error(`助手进程启动失败，退出码 ${code}`));
        }
        // 非主动关闭则自动拉起，保证长时间运行的稳定性。
        if (!this.disposed) {
          setTimeout(() => {
            if (!this.disposed) void this.start().catch(() => {});
          }, 1_000);
        }
      });

      child.on('error', (err) => {
        clearTimeout(startupTimer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });

    return this.readyPromise;
  }

  private handleLine(line: string, onReady: () => void): void {
    let msg: HelperResponse;
    try {
      msg = JSON.parse(line) as HelperResponse;
    } catch {
      console.error('[win32-helper] 无法解析的输出：', line);
      return;
    }

    if (msg['type'] === 'helper-ready') {
      onReady();
      return;
    }

    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve(msg);
  }

  /** 发一条命令并等响应。 */
  async send(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<HelperResponse> {
    if (cmd === 'shake-config') this.shakeConfig = { ...this.shakeConfig, ...params };
    await this.start();
    const child = this.child;
    if (!child) throw new Error('助手进程不可用');

    const id = this.nextId++;
    const payload = JSON.stringify({ id, cmd, ...params });

    return new Promise<HelperResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`助手命令 ${cmd} 超时`));
        // 仅拒绝 Promise 不会中断 PowerShell 内的 UIA / Win32 调用。
        // 重建卡住的助手，并由 close 统一失败掉其余请求；不自动重试投递。
        console.warn(`[win32-helper] 命令 ${cmd} 超时，重建助手进程`);
        child.kill();
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload + '\n', 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('助手已关闭'));
    }
    this.pending.clear();
    this.child?.stdin.end();
    this.child?.kill();
  }
}

export const win32Helper = new Win32Helper();
