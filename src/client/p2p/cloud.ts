import { api, ApiError, post } from "../api";
import type { FileMeta, Progress } from "./protocol";

interface CreateResponse {
  id: string;
  code: string;
  hours: number;
  files: { idx: number; size: number; partSize: number }[];
}

export interface CloudReady {
  id: string;
  code: string;
  expiresAt: number;
}

const PARALLEL = 3;

/** Sobe os arquivos para a nuvem em partes (com nova tentativa por parte) e devolve o código. */
export async function uploadToCloud(
  files: File[],
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<CloudReady> {
  const created = await post<CreateResponse>("/api/cloud", {
    files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || "application/octet-stream" })),
  });
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  let doneBytes = 0;
  const inflight = new Map<string, number>();
  const report = (index: number) =>
    onProgress({
      bytesDone: doneBytes + [...inflight.values()].reduce((s, n) => s + n, 0),
      totalBytes,
      fileIndex: index,
      fileCount: files.length,
      fileName: files[index]?.name ?? "",
    });

  try {
    for (const [index, file] of files.entries()) {
      const base = `/api/cloud/${created.id}/files/${index}`;
      const { partSize } = await post<{ uploadId: string; partSize: number }>(`${base}/start`);
      const count = Math.max(1, Math.ceil(file.size / partSize));
      const parts: { partNumber: number; etag: string }[] = [];
      let next = 1;

      const worker = async () => {
        while (next <= count) {
          const n = next++;
          const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
          const key = `${index}:${n}`;
          const etag = await withRetry(() =>
            putPart(`${base}/parts/${n}`, blob, signal, (sent) => {
              inflight.set(key, sent);
              report(index);
            }),
          );
          inflight.delete(key);
          doneBytes += blob.size;
          parts.push({ partNumber: n, etag });
          report(index);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
      parts.sort((a, b) => a.partNumber - b.partNumber);
      await post(`${base}/complete`, { parts });
    }
    const ready = await post<{ code: string; expiresAt: number }>(`/api/cloud/${created.id}/finish`);
    return { id: created.id, code: ready.code, expiresAt: ready.expiresAt };
  } catch (err) {
    void api(`/api/cloud/${created.id}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
}

function putPart(url: string, blob: Blob, signal: AbortSignal, onSent: (n: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.etag) resolve(xhr.response.etag);
      else reject(new ApiError(xhr.response?.error ?? "upload_failed", xhr.response?.message ?? "Falha ao enviar uma parte.", xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("network", "A conexão caiu durante o envio.", 0));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.send(blob);
  });
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) throw err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

export interface CloudOffer {
  kind: "cloud";
  expiresAt: number;
  totalBytes: number;
  files: (FileMeta & { downloaded: boolean })[];
}

export function describeCloud(code: string): Promise<CloudOffer> {
  return api<CloudOffer>(`/api/cloud/code/${code}`);
}

/**
 * Baixa cada arquivo pelo próprio gerenciador de downloads do navegador e acompanha
 * até o servidor confirmar que tudo chegou (aí os arquivos são apagados da nuvem).
 */
export async function downloadCloud(code: string, offer: CloudOffer, onStatus: (done: number, total: number) => void): Promise<void> {
  const pending = offer.files.filter((f) => !f.downloaded);
  for (const [i, f] of pending.entries()) {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = `/api/cloud/code/${code}/files/${f.id}`;
    document.body.appendChild(frame);
    window.setTimeout(() => frame.remove(), 10 * 60_000);
    if (i < pending.length - 1) await new Promise((r) => setTimeout(r, 1200));
  }
  const total = offer.files.length;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const now = await describeCloud(code);
      const done = now.files.filter((f) => f.downloaded).length;
      onStatus(done, total);
      if (done === total) return;
    } catch (err) {
      // 404 depois de baixar = transferência concluída e apagada
      if (err instanceof ApiError && err.status === 404) {
        onStatus(total, total);
        return;
      }
    }
  }
}
