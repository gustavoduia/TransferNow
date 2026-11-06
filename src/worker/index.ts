import { CODE_ALPHABET, CODE_LENGTH, isValidCode } from "../shared/code";
import type { Env } from "./env";
import { log, shortHash } from "./log";

export { PortalRoom } from "./room";

interface IceServer { urls: string | string[]; username?: string; credential?: string }

const STUN_ONLY: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/config" && request.method === "GET") return config(env);
      if (path === "/api/ice" && request.method === "GET") return await iceServers(env);
      if (path === "/api/rooms" && request.method === "POST") return await createRoom(request, env);
      const ws = path.match(/^\/api\/rooms\/([^/]+)\/ws$/);
      if (ws) return await connectRoom(request, env, ws[1]);
      if (path === "/api/health") return Response.json({ ok: true });
      if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      log("app", "unhandled_error", { level: "error", path, message: String(err) });
      return json({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** Configuração pública do site. MAX_FILE_SIZE_MB = -1 → sem limite. */
function config(env: Env): Response {
  const parsed = Number.parseInt(env.MAX_FILE_SIZE_MB ?? "-1", 10);
  const maxFileSizeMb = Number.isFinite(parsed) && parsed > 0 ? parsed : -1;
  return json(
    { maxFileSizeMb, roomTtlSeconds: ttl(env) },
    200,
    { "Cache-Control": "public, max-age=60" },
  );
}

async function iceServers(env: Env): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return json({ iceServers: STUN_ONLY, turn: false }, 200, { "Cache-Control": "no-store" });
  }
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 60 * 60 }),
    },
  );
  if (!res.ok) {
    log("app", "turn_credentials_failed", { level: "error", status: res.status });
    return json({ iceServers: STUN_ONLY, turn: false }, 200, { "Cache-Control": "no-store" });
  }
  const data = (await res.json()) as { iceServers: IceServer[] };
  // A porta 53 é bloqueada pelos navegadores e só causa espera; removemos.
  const servers = data.iceServers.map((s) => ({
    ...s,
    urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
  }));
  return json({ iceServers: servers, turn: true }, 200, { "Cache-Control": "no-store" });
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const salt = env.LOG_SALT ?? "transfernow";
  const ipHash = await shortHash(ip, salt);

  if (env.CREATE_LIMITER && !(await env.CREATE_LIMITER.limit({ key: ip })).success) {
    log("audit", "rate_limited", { action: "create", ip: ipHash });
    return json({ error: "rate_limited" }, 429);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const roomHash = await shortHash(code, salt);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const res = await stub.fetch("https://room/init", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: ttl(env), roomHash }),
    });
    if (res.status === 201) {
      const { expiresAt } = (await res.json()) as { expiresAt: number };
      log("audit", "room_created", { room: roomHash, ip: ipHash, country: request.cf?.country });
      return json({ code, expiresAt }, 201, { "Cache-Control": "no-store" });
    }
  }
  log("app", "room_code_collision", { level: "error" });
  return json({ error: "try_again" }, 503);
}

async function connectRoom(request: Request, env: Env, rawCode: string): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "expected_websocket" }, 426);
  }
  const code = rawCode.toUpperCase();
  const role = new URL(request.url).searchParams.get("role");
  if (!isValidCode(code) || (role !== "sender" && role !== "receiver")) {
    return json({ error: "bad_request" }, 400);
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const ipHash = await shortHash(ip, env.LOG_SALT ?? "transfernow");

  if (role === "receiver" && env.JOIN_LIMITER && !(await env.JOIN_LIMITER.limit({ key: ip })).success) {
    log("audit", "rate_limited", { action: "join", ip: ipHash });
    return json({ error: "rate_limited" }, 429);
  }

  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const target = new URL("https://room/ws");
  target.searchParams.set("role", role);
  target.searchParams.set("ip", ipHash);
  return stub.fetch(new Request(target, request));
}

function randomCode(): string {
  // Amostragem por rejeição: distribuição uniforme no alfabeto de 31 símbolos.
  const out: string[] = [];
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const b of bytes) {
      if (b < limit && out.length < CODE_LENGTH) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
    }
  }
  return out.join("");
}

function ttl(env: Env): number {
  const n = Number.parseInt(env.ROOM_TTL_SECONDS ?? "600", 10);
  return Number.isFinite(n) && n >= 60 ? n : 600;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
