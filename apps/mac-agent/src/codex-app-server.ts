import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, type RawData } from 'ws';

export type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private notificationHandler: ((message: JsonRpcMessage) => Promise<void> | void) | null = null;

  constructor(private readonly url: string, private readonly port: number) {}

  async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) return;
    this.process = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${this.port}`], {
      stdio: 'pipe',
      env: process.env,
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await this.ensureStarted();
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to Codex app-server')), 5000);
      this.ws!.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws!.once('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    this.ws.on('message', async (raw: RawData) => {
      const message = JSON.parse(String(raw)) as JsonRpcMessage;
      if (message.id && (message.result !== undefined || message.error)) {
        const key = String(message.id);
        const pending = this.pending.get(key);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(key);
          if (message.error) {
            pending.reject(new Error(message.error.message ?? 'Unknown Codex app-server error'));
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }
      await this.notificationHandler?.(message);
    });

    await this.request('initialize', {
      clientInfo: { name: 'channels-mac-agent', version: '0.1.0', title: 'Channels Mac Agent' },
      capabilities: { experimentalApi: true },
    });
  }

  onNotification(handler: (message: JsonRpcMessage) => Promise<void> | void): void {
    this.notificationHandler = handler;
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.connect();
    const id = randomUUID();
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.ws!.send(payload);
    });
  }

  sendResponse(id: string | number, result: unknown): void {
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.process?.kill('SIGTERM');
  }
}

export function enrichThreadTitle(thread: { title?: string | null; firstUserMessage?: string | null }, fallback: string): string {
  return (thread.title ?? thread.firstUserMessage ?? fallback).replace(/\s+/g, ' ').trim().slice(0, 120) || fallback;
}

export function defaultHostname(): string {
  return os.hostname();
}

export function normalizeThreadCwd(thread: { cwd?: string | null }): string {
  return thread.cwd ? path.resolve(thread.cwd) : process.cwd();
}
