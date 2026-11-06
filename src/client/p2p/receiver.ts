import { createSHA256, type IHasher } from "hash-wasm";
import { openSink, type Sink } from "./download";
import { decode, encode, type FileMeta, type PortalMessage, type Progress } from "./protocol";

export interface IncomingOffer {
  files: FileMeta[];
  totalBytes: number;
}

export interface ReceiverEvents {
  onOffer(offer: IncomingOffer): void;
  onProgress(p: Progress): void;
  onFileDone(meta: FileMeta, ok: boolean): void;
  onBatchDone(offer: IncomingOffer, allOk: boolean): void;
  onCancelled(): void;
}

/**
 * Recebe levas de arquivos. Cada mensagem passa por uma fila serial, para que a
 * abertura do download (assíncrona) nunca embaralhe a ordem dos pedaços.
 */
export class Receiver {
  private queue: Promise<void> = Promise.resolve();
  private offer: IncomingOffer | null = null;
  private current: { meta: FileMeta; sink: Sink; hasher: IHasher; index: number } | null = null;
  private bytesDone = 0;
  private results: boolean[] = [];

  constructor(
    private dc: RTCDataChannel,
    private events: ReceiverEvents,
    private maxFileBytes: number,
  ) {
    dc.addEventListener("message", (ev) => {
      const data = ev.data;
      this.queue = this.queue.then(() => this.handle(data)).catch((err) => console.error(err));
    });
    dc.addEventListener("close", () => this.current?.sink.abort());
  }

  accept() {
    this.dc.send(encode({ t: "accept" }));
  }

  decline() {
    this.offer = null;
    this.dc.send(encode({ t: "reject", reason: "declined" }));
  }

  private async handle(data: unknown) {
    if (data instanceof ArrayBuffer) {
      if (!this.current || !this.offer) return;
      this.current.hasher.update(new Uint8Array(data));
      this.bytesDone += data.byteLength;
      this.current.sink.write(data);
      this.events.onProgress({
        bytesDone: this.bytesDone,
        totalBytes: this.offer.totalBytes,
        fileIndex: this.current.index,
        fileCount: this.offer.files.length,
        fileName: this.current.meta.name,
      });
      return;
    }
    if (typeof data !== "string") return;
    const msg = decode(data);
    if (msg) await this.onControl(msg);
  }

  private async onControl(msg: PortalMessage) {
    switch (msg.t) {
      case "manifest": {
        const files = msg.files.map((f) => ({ ...f, name: safeName(f.name) }));
        if (this.maxFileBytes > 0 && files.some((f) => f.size > this.maxFileBytes)) {
          this.dc.send(encode({ t: "reject", reason: "too_large" }));
          return;
        }
        this.offer = { files, totalBytes: msg.totalBytes };
        this.bytesDone = 0;
        this.results = [];
        this.events.onOffer(this.offer);
        return;
      }
      case "file-start": {
        const meta = this.offer?.files.find((f) => f.id === msg.id);
        if (!meta) return;
        const hasher = await createSHA256();
        hasher.init();
        const sink = await openSink(meta);
        this.current = { meta, sink, hasher, index: this.offer!.files.indexOf(meta) };
        return;
      }
      case "file-end": {
        if (!this.current || this.current.meta.id !== msg.id) return;
        const ok = this.current.hasher.digest("hex") === msg.sha256;
        if (ok) await this.current.sink.close();
        else this.current.sink.abort();
        this.dc.send(encode({ t: "verified", id: msg.id, ok }));
        this.results.push(ok);
        this.events.onFileDone(this.current.meta, ok);
        this.current = null;
        if (this.offer && this.results.length === this.offer.files.length) {
          this.events.onBatchDone(this.offer, this.results.every(Boolean));
          this.offer = null;
        }
        return;
      }
      case "cancel":
        this.current?.sink.abort();
        this.current = null;
        this.offer = null;
        this.events.onCancelled();
        return;
    }
  }
}

/** Remove caminhos e caracteres de controle de nomes vindos da outra ponta. */
function safeName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? "arquivo";
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().slice(0, 200);
  return clean && clean !== "." && clean !== ".." ? clean : "arquivo";
}
