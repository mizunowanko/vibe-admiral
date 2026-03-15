import { WebSocketServer, type WebSocket } from "ws";

/**
 * Mock Engine WebSocket server for E2E tests.
 * Simulates the real engine's message protocol.
 */
export class MockEngine {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private fleets: Array<{
    id: string;
    name: string;
    repos: string[];
    createdAt: string;
  }> = [];

  constructor(private port = 9720) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(ws, msg);
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });
    });
  }

  private handleMessage(
    ws: WebSocket,
    msg: { type: string; data?: Record<string, unknown> },
  ) {
    const data = msg.data ?? {};

    switch (msg.type) {
      case "fleet:list": {
        this.sendTo(ws, { type: "fleet:data", data: this.fleets });
        break;
      }
      case "fleet:create": {
        const fleet = {
          id: crypto.randomUUID(),
          name: data.name as string,
          repos: (data.repos as string[]) ?? [],
          createdAt: new Date().toISOString(),
        };
        this.fleets.push(fleet);
        // Send both fleet:created (for #2 fix) and fleet:data (for main compatibility)
        this.sendTo(ws, {
          type: "fleet:created",
          data: { id: fleet.id, fleets: this.fleets },
        });
        this.sendTo(ws, { type: "fleet:data", data: this.fleets });
        break;
      }
      case "fleet:select": {
        this.sendTo(ws, { type: "fleet:data", data: this.fleets });
        break;
      }
      case "fleet:update": {
        const fleet = this.fleets.find((f) => f.id === data.id);
        if (fleet) {
          if (data.name) fleet.name = data.name as string;
          if (data.repos) fleet.repos = data.repos as string[];
        }
        this.sendTo(ws, { type: "fleet:data", data: this.fleets });
        break;
      }
      case "fleet:delete": {
        this.fleets = this.fleets.filter((f) => f.id !== data.id);
        this.sendTo(ws, { type: "fleet:data", data: this.fleets });
        break;
      }
      case "bridge:history": {
        this.sendTo(ws, {
          type: "bridge:stream",
          data: {
            fleetId: data.fleetId,
            message: { type: "history", content: "[]" },
          },
        });
        break;
      }
      case "bridge:send": {
        // Echo back an assistant response after a short delay
        setTimeout(() => {
          this.sendTo(ws, {
            type: "bridge:stream",
            data: {
              fleetId: data.fleetId,
              message: {
                type: "assistant",
                content: `Mock response to: ${data.message}`,
              },
            },
          });
        }, 100);
        break;
      }
      case "ship:sortie": {
        const shipId = crypto.randomUUID();
        this.broadcast({
          type: "ship:status",
          data: {
            id: shipId,
            status: "investigating",
            detail: `Issue #${data.issueNumber}`,
          },
        });
        break;
      }
    }
  }

  private sendTo(ws: WebSocket, msg: Record<string, unknown>) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: Record<string, unknown>) {
    const json = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(json);
      }
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
