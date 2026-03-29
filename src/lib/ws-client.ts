import type { ClientMessage, ServerMessage } from "@/types";

type MessageHandler = (msg: ServerMessage) => void;

function getEngineWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

type ConnectHandler = () => void;

/** Backoff config for reconnection */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** If no ping is received within this period, consider connection dead */
const PING_TIMEOUT_MS = 45_000; // 1.5x the 30s server ping interval

export class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private connectHandlers = new Set<ConnectHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private reconnectAttempt = 0;

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(getEngineWsUrl());

      this.ws.onopen = () => {
        this._connected = true;
        this.reconnectAttempt = 0;
        console.log("Connected to engine");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.resetPingTimeout();
        for (const handler of this.connectHandlers) {
          handler();
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          if (msg.type === "ping") {
            // Respond with application-level pong and reset ping timeout
            this.send({ type: "pong" });
            this.resetPingTimeout();
            return;
          }
          for (const handler of this.handlers) {
            handler(msg);
          }
        } catch (err) {
          console.error("Failed to parse message:", err);
        }
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.clearPingTimeout();
        console.log("Disconnected from engine");
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this._connected = false;
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearPingTimeout();
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this.reconnectAttempt = 0;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn("WebSocket not connected, message dropped:", msg.type);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onConnect(handler: ConnectHandler): () => void {
    this.connectHandlers.add(handler);
    return () => this.connectHandlers.delete(handler);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempt),
      BACKOFF_MAX_MS,
    );
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      this.connect();
    }, delay);
  }

  private resetPingTimeout(): void {
    this.clearPingTimeout();
    this.pingTimeoutTimer = setTimeout(() => {
      console.log("Ping timeout — closing connection");
      this.ws?.close();
    }, PING_TIMEOUT_MS);
  }

  private clearPingTimeout(): void {
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer);
      this.pingTimeoutTimer = null;
    }
  }
}

// Singleton instance
export const wsClient = new WSClient();
