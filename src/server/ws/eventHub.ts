import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ProductEvent } from "../../shared/events";

export class EventHub {
  private readonly clients = new Map<string, Set<WebSocket>>();

  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname !== "/ws") return;

      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit("connection", webSocket, request);
      });
    });

    wss.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "", "http://localhost");
      const discussionId = url.searchParams.get("discussionId");
      if (!discussionId) {
        socket.close(1008, "discussionId is required");
        return;
      }

      const clients = this.clients.get(discussionId) ?? new Set<WebSocket>();
      clients.add(socket);
      this.clients.set(discussionId, clients);

      socket.on("close", () => {
        clients.delete(socket);
        if (clients.size === 0) {
          this.clients.delete(discussionId);
        }
      });
    });
  }

  publish(discussionId: string, event: ProductEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients.get(discussionId) ?? []) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }
}
