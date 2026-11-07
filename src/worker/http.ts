export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function error(code: string, message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, message, ...extra }, status);
}

export async function readJson<T>(request: Request, maxBytes = 64 * 1024): Promise<T | null> {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Só aceita escrita vinda do próprio site (proteção extra contra CSRF, além do SameSite=Lax). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return request.method === "GET";
  return origin === new URL(request.url).origin;
}

export function redirect(location: string, headers: Record<string, string | string[]> = {}): Response {
  const h = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const [k, v] of Object.entries(headers)) for (const item of [v].flat()) h.append(k, item);
  return new Response(null, { status: 302, headers: h });
}
