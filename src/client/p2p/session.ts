import type { AuditEventName } from "../../shared/code";
import { fetchIceConfig, PeerLink } from "./peer";
import type { Progress } from "./protocol";
import { Receiver, type IncomingOffer } from "./receiver";
import { sendFiles, TransferRejected } from "./sender";
import { Signaling } from "./signaling";

export interface SessionEvents {
  onPeerReady(): void;
  onPeerLeft(): void;
  onError(code: string, message: string): void;
}

abstract class BaseSession {
  protected signaling: Signaling | null = null;
  protected peer: PeerLink | null = null;
  protected closed = false;

  protected audit(name: AuditEventName, fields: { bytes?: number; files?: number; durationMs?: number; relay?: boolean; reason?: string }) {
    this.signaling?.send({ type: "event", name, ...fields });
  }

  close() {
    this.closed = true;
    this.peer?.close();
    this.signaling?.close();
  }
}

export interface SenderEvents extends SessionEvents {
  onCode(code: string, expiresAt: number): void;
}

export class SenderSession extends BaseSession {
  private dc: RTCDataChannel | null = null;
  private busy = false;

  constructor(private events: SenderEvents) {
    super();
  }

  async open(): Promise<void> {
    const res = await fetch("/api/rooms", { method: "POST" });
    if (res.status === 429) throw new SessionError("rate_limited", "Muitos portais abertos em pouco tempo. Aguarde um minuto.");
    if (!res.ok) throw new SessionError("create_failed", "Não foi possível abrir o portal agora. Tente de novo.");
    const { code, expiresAt } = (await res.json()) as { code: string; expiresAt: number };
    const ice = await fetchIceConfig();

    this.signaling = new Signaling(code, "sender", {
      onHello: () => this.events.onCode(code, expiresAt),
      onPeerJoined: () => {
        this.peer = new PeerLink(ice, true, (data) => this.signaling?.signal(data));
        this.peer.onFailed(() => this.events.onError("connection_failed", "Os portais não conseguiram se conectar nesta rede."));
        this.peer.channel.then((dc) => {
          this.dc = dc;
          dc.addEventListener("close", () => !this.closed && this.events.onPeerLeft());
          this.events.onPeerReady();
        });
      },
      onSignal: (data) => void this.peer?.handleSignal(data),
      onPeerLeft: () => !this.closed && this.events.onPeerLeft(),
      onError: (c, m) => this.events.onError(c, m),
    });
  }

  get ready() {
    return this.dc?.readyState === "open" && !this.busy;
  }

  async send(files: File[], onProgress: (p: Progress) => void): Promise<"done" | "declined" | "too_large"> {
    if (!this.dc || this.busy) throw new SessionError("not_ready", "A outra ponta ainda não está pronta.");
    this.busy = true;
    const started = performance.now();
    const bytes = files.reduce((s, f) => s + f.size, 0);
    const relay = (await this.peer?.usesRelay()) ?? false;
    this.audit("transfer_start", { bytes, files: files.length, relay });
    try {
      const maxMsg = this.peer?.pc.sctp?.maxMessageSize;
      await sendFiles(this.dc, files, onProgress, maxMsg || undefined);
      this.audit("transfer_done", { bytes, files: files.length, durationMs: performance.now() - started, relay });
      return "done";
    } catch (err) {
      if (err instanceof TransferRejected && (err.reason === "declined" || err.reason === "too_large")) {
        this.audit("transfer_rejected", { files: files.length, reason: err.reason });
        return err.reason;
      }
      this.audit("transfer_error", { bytes, files: files.length, reason: String((err as Error).message) });
      throw err;
    } finally {
      this.busy = false;
    }
  }
}

export interface ReceiverSessionEvents extends SessionEvents {
  onOffer(offer: IncomingOffer): void;
  onProgress(p: Progress): void;
  onBatchDone(offer: IncomingOffer, ok: boolean): void;
  onCancelled(): void;
}

export class ReceiverSession extends BaseSession {
  private receiver: Receiver | null = null;
  /** O servidor informa se quem abriu o portal é assinante (assinante não gera anúncio para quem recebe). */
  senderPaid = false;

  constructor(
    private events: ReceiverSessionEvents,
    private maxFileBytes: number,
  ) {
    super();
  }

  async join(code: string): Promise<void> {
    const ice = await fetchIceConfig();
    this.peer = new PeerLink(ice, false, (data) => this.signaling?.signal(data));
    this.peer.onFailed(() => this.events.onError("connection_failed", "Os portais não conseguiram se conectar nesta rede."));
    this.peer.channel.then((dc) => {
      dc.addEventListener("close", () => !this.closed && this.events.onPeerLeft());
      this.receiver = new Receiver(
        dc,
        {
          onOffer: (o) => this.events.onOffer(o),
          onProgress: (p) => this.events.onProgress(p),
          onFileDone: () => {},
          onBatchDone: (o, ok) => this.events.onBatchDone(o, ok),
          onCancelled: () => this.events.onCancelled(),
        },
        this.maxFileBytes,
      );
      this.events.onPeerReady();
    });

    this.signaling = new Signaling(code, "receiver", {
      onHello: (_expiresAt, senderPaid) => (this.senderPaid = !!senderPaid),
      onSignal: (data) => void this.peer?.handleSignal(data),
      onPeerLeft: () => !this.closed && this.events.onPeerLeft(),
      onError: (c, m) => this.events.onError(c, m),
    });
  }

  accept() {
    this.receiver?.accept();
  }

  decline() {
    this.receiver?.decline();
  }
}

export class SessionError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
