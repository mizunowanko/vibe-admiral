import type { ClientMessage, ServerMessage } from "@/types";

type MessageHandler = (msg: ServerMessage) => void;

const ENGINE_PORT = import.meta.env.VITE_ENGINE_PORT ?? "9721";
const ENGINE_URL = `ws://localhost:${ENGINE_PORT}`;

type ConnectHandler = () => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private connectHandlers = new Set<ConnectHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(ENGINE_URL);

      this.ws.onopen = () => {
        this._connected = true;
        console.log("Connected to engine");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        for (const handler of this.connectHandlers) {
          handler();
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          for (const handler of this.handlers) {
            handler(msg);
          }
        } catch (err) {
          console.error("Failed to parse message:", err);
        }
      };

      this.ws.onclose = () => {
        this._connected = false;
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
    this.ws?.close();
    this.ws = null;
    this._connected = false;
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

// Singleton instance
export const wsClient = new WSClient();
