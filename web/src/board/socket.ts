export type ServerMessage = { type: string } & Record<string, unknown>;
export type ConnectionState = "connecting" | "online" | "offline";

/** WebSocket to one board room, with automatic reconnection and a send queue while offline. */
export class BoardSocket {
  readonly clientId = crypto.randomUUID();
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private retries = 0;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private boardId: string,
    private onMessage: (message: ServerMessage) => void,
    private onState: (state: ConnectionState) => void,
    private onFatal: (code: number) => void,
  ) {
    this.connect();
  }

  private connect() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${location.host}/ws?board=${this.boardId}&client=${this.clientId}`;
    this.onState("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.onState("online");
      for (const data of this.queue.splice(0)) ws.send(data);
    };
    ws.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = (event) => {
      this.ws = null;
      if (this.closed) return;
      if (event.code === 4004) {
        this.onFatal(event.code);
        return;
      }
      this.onState("offline");
      const delay = Math.min(1000 * 2 ** this.retries, 15_000);
      this.retries += 1;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  /** `volatile` messages (cursor moves) are dropped instead of queued while offline. */
  send(message: Record<string, unknown>, volatile = false) {
    const data = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (!volatile) this.queue.push(data);
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
