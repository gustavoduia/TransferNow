// TransferNow — Service Worker de download em streaming.
// Os pedaços recebidos pelo WebRTC são entregues aqui e viram um download normal
// do navegador, gravado direto no disco, sem acumular o arquivo inteiro na memória.

const pending = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "tn-ping") return;
  if (data.type !== "tn-register" || !event.ports[0]) return;

  const port = event.ports[0];
  let controller;
  const stream = new ReadableStream(
    {
      start(c) {
        controller = c;
      },
      cancel() {
        port.postMessage({ type: "cancelled" });
        pending.delete(data.id);
      },
    },
    { highWaterMark: 64 },
  );

  port.onmessage = (msg) => {
    const m = msg.data || {};
    if (m.type === "chunk") controller.enqueue(new Uint8Array(m.chunk));
    else if (m.type === "end") controller.close();
    else if (m.type === "abort") controller.error(new Error("aborted"));
  };

  pending.set(data.id, { stream, name: data.name, size: data.size, mime: data.mime });
  port.postMessage({ type: "ready" });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/__tn_dl/")) return;
  const id = url.pathname.split("/")[2];
  const entry = pending.get(id);
  if (!entry) {
    event.respondWith(new Response("Download expirado.", { status: 404 }));
    return;
  }
  pending.delete(id);

  const ascii = entry.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    "X-Content-Type-Options": "nosniff",
  });
  if (entry.size >= 0) headers.set("Content-Length", String(entry.size));
  event.respondWith(new Response(entry.stream, { headers }));
});
