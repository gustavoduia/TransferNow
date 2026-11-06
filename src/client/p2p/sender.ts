import { createSHA256 } from "hash-wasm";
import { BUFFER_HIGH, BUFFER_LOW, CHUNK_SIZE, decode, encode, type FileMeta, type Progress } from "./protocol";

export class TransferRejected extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

/** Envia uma leva de arquivos pelo DataChannel, com controle de fluxo e hash SHA-256. */
export async function sendFiles(
  dc: RTCDataChannel,
  files: File[],
  onProgress: (p: Progress) => void,
  maxMessageSize = CHUNK_SIZE,
): Promise<void> {
  const metas: FileMeta[] = files.map((f, id) => ({
    id,
    name: f.name,
    size: f.size,
    type: f.type || "application/octet-stream",
  }));
  const totalBytes = metas.reduce((s, m) => s + m.size, 0);

  const inbox = new Inbox(dc);
  try {
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.send(encode({ t: "manifest", files: metas, totalBytes }));

    const answer = await inbox.next((m) => m.t === "accept" || m.t === "reject");
    if (answer.t === "reject") throw new TransferRejected(answer.reason);

    const maxChunk = Math.max(16 * 1024, Math.min(CHUNK_SIZE, maxMessageSize));
    let sentTotal = 0;

    for (const [index, file] of files.entries()) {
      dc.send(encode({ t: "file-start", id: index }));
      const hasher = await createSHA256();
      hasher.init();
      const reader = file.stream().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (let off = 0; off < value.byteLength; off += maxChunk) {
          const piece = value.subarray(off, Math.min(off + maxChunk, value.byteLength));
          if (dc.bufferedAmount > BUFFER_HIGH) await drained(dc);
          if (dc.readyState !== "open") throw new Error("channel_closed");
          dc.send(piece);
          hasher.update(piece);
          sentTotal += piece.byteLength;
          onProgress({
            bytesDone: Math.max(0, sentTotal - dc.bufferedAmount),
            totalBytes,
            fileIndex: index,
            fileCount: files.length,
            fileName: file.name,
          });
        }
      }
      dc.send(encode({ t: "file-end", id: index, sha256: hasher.digest("hex") }));
    }

    // Espera a outra ponta confirmar a integridade de cada arquivo.
    for (let i = 0; i < files.length; i++) {
      const v = await inbox.next((m) => m.t === "verified");
      if (v.t === "verified" && !v.ok) throw new Error("integrity_failed");
    }
    onProgress({ bytesDone: totalBytes, totalBytes, fileIndex: files.length - 1, fileCount: files.length, fileName: "" });
  } finally {
    inbox.dispose();
  }
}

function drained(dc: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("channel_closed"));
    };
    const cleanup = () => {
      dc.removeEventListener("bufferedamountlow", onLow);
      dc.removeEventListener("close", onClose);
    };
    dc.addEventListener("bufferedamountlow", onLow);
    dc.addEventListener("close", onClose);
  });
}

/** Fila simples de mensagens de controle recebidas pelo canal. */
export class Inbox {
  private queue: ReturnType<typeof decode>[] = [];
  private waiters: { match: (m: NonNullable<ReturnType<typeof decode>>) => boolean; resolve: (m: any) => void; reject: (e: Error) => void }[] = [];
  private handler = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    const msg = decode(ev.data);
    if (!msg) return;
    if (msg.t === "cancel") {
      for (const w of this.waiters.splice(0)) w.reject(new TransferRejected("cancelled"));
      return;
    }
    const i = this.waiters.findIndex((w) => w.match(msg));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
    else this.queue.push(msg);
  };
  private onClose = () => {
    for (const w of this.waiters.splice(0)) w.reject(new Error("channel_closed"));
  };

  constructor(private dc: RTCDataChannel) {
    dc.addEventListener("message", this.handler);
    dc.addEventListener("close", this.onClose);
  }

  next(match: (m: NonNullable<ReturnType<typeof decode>>) => boolean) {
    const i = this.queue.findIndex((m) => m && match(m));
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]!);
    return new Promise<NonNullable<ReturnType<typeof decode>>>((resolve, reject) => {
      this.waiters.push({ match, resolve, reject });
    });
  }

  dispose() {
    this.dc.removeEventListener("message", this.handler);
    this.dc.removeEventListener("close", this.onClose);
  }
}
