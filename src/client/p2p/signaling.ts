import type { ClientToRoom, Role, RoomToClient } from "../../shared/code";

export interface SignalingHandlers {
  onHello?(expiresAt: number, senderPaid?: boolean): void;
  onPeerJoined?(): void;
  onPeerLeft?(): void;
  onSignal?(data: unknown): void;
  onError?(code: string, message: string): void;
  onClose?(): void;
}

/** WebSocket com a sala do portal. Só carrega a "apresentação" WebRTC, nunca o arquivo. */
export class Signaling {
  private ws: WebSocket;
  private pingTimer: number | undefined;
  private closedByUs = false;

  constructor(code: string, role: Role, private handlers: SignalingHandlers) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${scheme}://${location.host}/api/rooms/${code}/ws?role=${role}`);
    this.ws.addEventListener("open", () => {
      this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 25_000);
    });
    this.ws.addEventListener("message", (ev) => this.dispatch(ev.data));
    this.ws.addEventListener("close", (ev) => {
      window.clearInterval(this.pingTimer);
      if (!this.closedByUs) {
        // 1006 sem mensagem de erro antes: falha de rede ou limite de tentativas.
        if (ev.code === 1006) this.handlers.onError?.("network", "A conexão com o portal caiu.");
        this.handlers.onClose?.();
      }
    });
  }

  private dispatch(raw: unknown) {
    if (typeof raw !== "string") return;
    let msg: RoomToClient;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        return this.handlers.onHello?.(msg.expiresAt, msg.senderPaid);
      case "peer-joined":
        return this.handlers.onPeerJoined?.();
      case "peer-left":
        return this.handlers.onPeerLeft?.();
      case "signal":
        return this.handlers.onSignal?.(msg.data);
      case "error":
        this.closedByUs = true;
        return this.handlers.onError?.(msg.code, msg.message);
    }
  }

  send(msg: ClientToRoom) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  signal(data: unknown) {
    this.send({ type: "signal", data });
  }

  close() {
    this.closedByUs = true;
    window.clearInterval(this.pingTimer);
    this.ws.close(1000, "bye");
  }
}
