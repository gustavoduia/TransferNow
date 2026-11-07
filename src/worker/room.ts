import { DurableObject } from "cloudflare:workers";
import type { ClientToRoom, Role, RoomErrorCode, RoomToClient } from "../shared/code";
import type { Env } from "./env";
import { log } from "./log";

type Status = "waiting" | "paired";

interface Meta {
  status: Status;
  createdAt: number;
  expiresAt: number;
  roomHash: string;
  senderPaid: boolean;
  pairedAt?: number;
}

interface Attachment {
  role: Role;
  ipHash: string;
}

const MAX_MESSAGE_BYTES = 64 * 1024;
const PAIRED_MAX_MS = 12 * 60 * 60 * 1000; // sala pareada vive no máximo 12h

/**
 * Uma sala por código de portal. Só faz a apresentação entre os dois navegadores
 * (troca de SDP/ICE). Nenhum byte de arquivo passa por aqui.
 * Usa a WebSocket Hibernation API: a sala não fica cobrando tempo enquanto espera.
 */
export class PortalRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(JSON.stringify({ type: "ping" }), JSON.stringify({ type: "pong" })),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      const { ttlSeconds, roomHash, senderPaid } = (await request.json()) as { ttlSeconds: number; roomHash: string; senderPaid?: boolean };
      const existing = await this.ctx.storage.get<Meta>("meta");
      if (existing && existing.expiresAt > Date.now()) return new Response("taken", { status: 409 });
      const now = Date.now();
      const meta: Meta = { status: "waiting", createdAt: now, expiresAt: now + ttlSeconds * 1000, roomHash, senderPaid: !!senderPaid };
      await this.ctx.storage.put("meta", meta);
      await this.ctx.storage.setAlarm(meta.expiresAt);
      return Response.json({ expiresAt: meta.expiresAt }, { status: 201 });
    }

    if (url.pathname === "/status") {
      const meta = await this.ctx.storage.get<Meta>("meta");
      return Response.json({ active: !!meta && (meta.status === "paired" || meta.expiresAt > Date.now()) });
    }

    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role") as Role | null;
      const ipHash = url.searchParams.get("ip") ?? "unknown";
      if (role !== "sender" && role !== "receiver") return new Response("bad role", { status: 400 });
      return this.acceptPeer(role, ipHash);
    }

    return new Response("not found", { status: 404 });
  }

  private async acceptPeer(role: Role, ipHash: string): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, ipHash } satisfies Attachment);

    const meta = await this.ctx.storage.get<Meta>("meta");
    const reject = (code: RoomErrorCode, message: string) => {
      this.send(server, { type: "error", code, message });
      server.close(4000, code);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!meta) return reject("not_found", "Código não encontrado.");
    if (meta.status === "waiting" && meta.expiresAt <= Date.now()) return reject("expired", "Código expirado.");

    const senders = this.ctx.getWebSockets("sender").filter((ws) => ws !== server);
    const receivers = this.ctx.getWebSockets("receiver").filter((ws) => ws !== server);

    if (role === "sender") {
      if (senders.length > 0 || meta.status !== "waiting") return reject("taken", "Este portal já está em uso.");
      this.send(server, { type: "hello", role, expiresAt: meta.expiresAt });
      log("audit", "portal_opened", { room: meta.roomHash, ip: ipHash });
      return new Response(null, { status: 101, webSocket: client });
    }

    // receiver: uso único — o primeiro que entra fecha a sala para os demais.
    if (meta.status !== "waiting" || receivers.length > 0) return reject("taken", "Este código já foi usado.");
    if (senders.length === 0) return reject("not_found", "Quem abriu este portal já saiu.");

    meta.status = "paired";
    meta.pairedAt = Date.now();
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(meta.pairedAt + PAIRED_MAX_MS);

    this.send(server, { type: "hello", role, expiresAt: meta.expiresAt, senderPaid: meta.senderPaid });
    this.send(server, { type: "peer-joined" });
    for (const ws of senders) this.send(ws, { type: "peer-joined" });
    log("audit", "portal_paired", {
      room: meta.roomHash,
      ip: ipHash,
      waitMs: meta.pairedAt - meta.createdAt,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (size > MAX_MESSAGE_BYTES || typeof raw !== "string") {
      ws.close(1009, "message too big");
      return;
    }
    let msg: ClientToRoom;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() as Attachment;

    if (msg.type === "signal") {
      const other = this.ctx.getWebSockets(me.role === "sender" ? "receiver" : "sender");
      for (const peer of other) this.send(peer, { type: "signal", data: msg.data });
      return;
    }

    if (msg.type === "event") {
      const meta = await this.ctx.storage.get<Meta>("meta");
      const allowed = ["transfer_start", "transfer_done", "transfer_error", "transfer_rejected"];
      if (!allowed.includes(msg.name)) return;
      log("audit", msg.name, {
        room: meta?.roomHash,
        role: me.role,
        ip: me.ipHash,
        bytes: num(msg.bytes),
        files: num(msg.files),
        durationMs: num(msg.durationMs),
        relay: msg.relay === true,
        reason: typeof msg.reason === "string" ? msg.reason.slice(0, 80) : undefined,
      });
      // Resultado da transferência para o BI. Só quem envia informa, e só para a reserva dele.
      const ref = typeof msg.ref === "string" && /^[0-9a-f-]{36}$/.test(msg.ref) ? msg.ref : null;
      const status = { transfer_done: "done", transfer_error: "failed", transfer_rejected: "rejected" }[msg.name as string];
      if (ref && status && me.role === "sender") {
        await this.env.DB.prepare("UPDATE transfers SET status = ?, relay = ?, completed_at = ? WHERE id = ? AND kind = 'p2p' AND status = 'started'")
          .bind(status, msg.relay === true ? 1 : 0, Date.now(), ref)
          .run()
          .catch(() => {});
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleLeave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleLeave(ws);
  }

  private async handleLeave(ws: WebSocket): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me) return;
    const meta = await this.ctx.storage.get<Meta>("meta");
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    for (const peer of remaining) this.send(peer, { type: "peer-left" });

    const senderGoneWhileWaiting = meta?.status === "waiting" && me.role === "sender";
    if (remaining.length === 0 || senderGoneWhileWaiting) {
      if (meta) log("audit", "portal_closed", { room: meta.roomHash, lifetimeMs: Date.now() - meta.createdAt });
      for (const peer of remaining) peer.close(4001, "closed");
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    }
  }

  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>("meta");
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { type: "error", code: "expired", message: "O portal expirou." });
      ws.close(4002, "expired");
    }
    if (meta) log("audit", "portal_expired", { room: meta.roomHash, status: meta.status });
    await this.ctx.storage.deleteAll();
  }

  private send(ws: WebSocket, msg: RoomToClient): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket já fechado */
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}
