import { WebSocket, type RawData } from 'ws';
import { controlOutboundMessageSchema, type AgentInboundMessage, type ControlOutboundMessage } from '@channels/shared';

export class ControlPlaneClient {
  private ws: WebSocket | null = null;
  private messageHandler: ((message: ControlOutboundMessage) => Promise<void> | void) | null = null;

  constructor(private readonly url: string) {}

  async connect(query: Record<string, string>): Promise<void> {
    const wsUrl = new URL(this.url);
    for (const [key, value] of Object.entries(query)) {
      wsUrl.searchParams.set(key, value);
    }
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to control plane')), 5000);
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
      const parsed = controlOutboundMessageSchema.parse(JSON.parse(String(raw)));
      await this.messageHandler?.(parsed);
    });
  }

  onMessage(handler: (message: ControlOutboundMessage) => Promise<void> | void): void {
    this.messageHandler = handler;
  }

  send(message: AgentInboundMessage | { type: string; [key: string]: unknown }): void {
    this.ws?.send(JSON.stringify(message));
  }

  sendResponse(requestId: string, ok: boolean, data?: unknown, error?: string): void {
    this.send({ type: 'control.response', requestId, ok, data, error });
  }

  close(): void {
    this.ws?.close();
  }
}
