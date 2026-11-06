import type { FileMeta } from "./protocol";

export interface Sink {
  write(chunk: ArrayBuffer): void;
  close(): Promise<void>;
  abort(): void;
}

let swReady: Promise<ServiceWorker | null> | null = null;

/** Registra o Service Worker de download. Sem ele, cai para download em memória. */
export function prepareDownloads(): Promise<ServiceWorker | null> {
  swReady ??= (async () => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
      // primeira visita: espera o SW assumir a página (clients.claim)
      return await new Promise<ServiceWorker | null>((resolve) => {
        const t = window.setTimeout(() => resolve(null), 3000);
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            window.clearTimeout(t);
            resolve(navigator.serviceWorker.controller);
          },
          { once: true },
        );
      });
    } catch {
      return null;
    }
  })();
  return swReady;
}

export async function openSink(meta: FileMeta): Promise<Sink> {
  const sw = await prepareDownloads();
  if (sw) {
    try {
      return await streamSink(sw, meta);
    } catch {
      /* cai para memória */
    }
  }
  return blobSink(meta);
}

async function streamSink(sw: ServiceWorker, meta: FileMeta): Promise<Sink> {
  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  const ready = new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("sw_timeout")), 2000);
    channel.port1.onmessage = (ev) => {
      if (ev.data?.type === "ready") {
        window.clearTimeout(t);
        resolve();
      }
    };
  });
  sw.postMessage({ type: "tn-register", id, name: meta.name, size: meta.size, mime: meta.type }, [channel.port2]);
  await ready;

  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = `/__tn_dl/${id}/${encodeURIComponent(meta.name)}`;
  document.body.appendChild(frame);

  // mantém o SW acordado durante arquivos longos
  const keepAlive = window.setInterval(() => sw.postMessage({ type: "tn-ping" }), 10_000);
  const cleanup = () => {
    window.clearInterval(keepAlive);
    window.setTimeout(() => frame.remove(), 60_000);
  };

  return {
    write(chunk) {
      channel.port1.postMessage({ type: "chunk", chunk }, [chunk]);
    },
    async close() {
      channel.port1.postMessage({ type: "end" });
      cleanup();
    },
    abort() {
      channel.port1.postMessage({ type: "abort" });
      cleanup();
    },
  };
}

function blobSink(meta: FileMeta): Sink {
  let parts: ArrayBuffer[] = [];
  return {
    write(chunk) {
      parts.push(chunk);
    },
    async close() {
      const url = URL.createObjectURL(new Blob(parts, { type: meta.type }));
      parts = [];
      const a = document.createElement("a");
      a.href = url;
      a.download = meta.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort() {
      parts = [];
    },
  };
}
