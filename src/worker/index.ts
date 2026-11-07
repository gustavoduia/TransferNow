import { isValidCode } from "../shared/code";
import { ACCESS_LOG_RETENTION_MS, logAccess } from "./accesslog";
import { adEvent, adminRoute, unsubscribe } from "./admin";
import { currentUser, googleCallback, googleStart, isAdmin, logout, requestEmailLink, verifyEmailLink, type User } from "./auth";
import { cancel, subscriptionView, syncMine, webhook } from "./billing";
import { passMaintenance, passStatus, payOnce, payWithCard } from "./checkout";
import { createCloud, describeByCode, downloadByCode, expireTransfers, isCloudCode, listMine, uploadRoute } from "./cloud";
import { cloudCodeInUse, randomCode } from "./codes";
import type { Env } from "./env";
import { clientIp, error, json, readJson, sameOrigin } from "./http";
import { log, shortHash } from "./log";
import { getAds, getPlans, putSetting, systemEvent } from "./platform";
import { activePlan, bannedVisitor, reserve, usageView } from "./quota";

export { PortalRoom } from "./room";

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const STUN_ONLY: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      const pub = (env.ADSENSE_PUB_ID ?? "").trim().replace(/^ca-/, "");
      // ads.txt: autoriza o Google a vender anúncios neste domínio (vale para duia.com.br e subdomínios).
      if (path === "/ads.txt") {
        if (!/^pub-\d{10,20}$/.test(pub)) return new Response("", { status: 404 });
        return new Response(`google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        });
      }
      // Domínio principal (duia.com.br) ou outro apontado para cá: leva para o endereço do site.
      const siteHost = env.SITE_HOST ?? "transfernow.duia.com.br";
      if (url.hostname !== siteHost && !url.hostname.endsWith(".workers.dev") && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        return Response.redirect(`https://${siteHost}${path}${url.search}`, 301);
      }
      if (!path.startsWith("/api/")) {
        const res = await env.ASSETS.fetch(request);
        // Tag de verificação do AdSense na página inicial.
        if (/^pub-\d{10,20}$/.test(pub) && (res.headers.get("Content-Type") ?? "").includes("text/html")) {
          return new HTMLRewriter()
            .on("head", { element: (el) => void el.append(`<meta name="google-adsense-account" content="ca-${pub}" />`, { html: true }) })
            .transform(res);
        }
        return res;
      }

      // Webhook do Mercado Pago vem de fora; todo o resto que escreve precisa vir do próprio site.
      if (path === "/api/billing/webhook" && method === "POST") return await webhook(request, env, ctx);
      if (path === "/api/unsubscribe") return await unsubscribe(request, env);
      if (method !== "GET" && method !== "HEAD" && !sameOrigin(request)) return error("forbidden", "Origem não permitida.", 403);

      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/config" && method === "GET") return await config(env);
      if (path === "/api/ads/event" && method === "POST") {
        if (!(await allow(env.JOIN_LIMITER, request))) return json({ ok: false }, 429);
        return await adEvent(request, env);
      }
      if (path === "/api/ice" && method === "GET") return await iceServers(env);

      // ── contas ──
      if (path === "/api/auth/email" && method === "POST") {
        if (!(await allow(env.AUTH_LIMITER, request))) return error("rate_limited", "Muitas tentativas. Aguarde um minuto.", 429);
        return await requestEmailLink(request, env);
      }
      if (path === "/api/auth/verify" && method === "GET") return await verifyEmailLink(request, env);
      if (path === "/api/auth/google" && method === "GET") return googleStart(request, env);
      if (path === "/api/auth/google/callback" && method === "GET") return await googleCallback(request, env);
      if (path === "/api/auth/logout" && method === "POST") return await logout(request, env);

      const user = await currentUser(request, env);
      if (user && path === "/api/me") {
        logAccess(env, ctx, request, "session", user.id);
        const now = Date.now();
        ctx.waitUntil(
          env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)").bind(now, user.id, now - 3600_000).run().catch(() => {}),
        );
      }

      if (path === "/api/me" && method === "GET") return await me(request, env, user);
      if (path.startsWith("/api/admin/")) {
        if (user) logAccess(env, ctx, request, "admin", user.id, path.slice(0, 80));
        return await adminRoute(request, env, ctx, user);
      }

      // ── P2P ──
      if (path === "/api/rooms" && method === "POST") return await createRoom(request, env, ctx, user);
      const ws = path.match(/^\/api\/rooms\/([^/]+)\/ws$/);
      if (ws) return await connectRoom(request, env, ctx, ws[1], user);
      const lookup = path.match(/^\/api\/lookup\/([^/]+)$/);
      if (lookup && method === "GET") {
        const code = lookup[1].toUpperCase();
        if (!isValidCode(code)) return error("bad_request", "Código inválido.");
        if (!(await allow(env.JOIN_LIMITER, request))) return error("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto.", 429);
        return json({ kind: (await isCloudCode(env, code)) ? "cloud" : "p2p" });
      }
      if (path === "/api/transfers/reserve" && method === "POST") return await reserveP2P(request, env, user);

      // ── nuvem ──
      const byCode = path.match(/^\/api\/cloud\/code\/([^/]+)(?:\/files\/(\d+))?$/);
      if (byCode && method === "GET") {
        const code = byCode[1].toUpperCase();
        if (!(await allow(env.JOIN_LIMITER, request))) return error("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto.", 429);
        return byCode[2] === undefined ? await describeByCode(request, env, ctx, code) : await downloadByCode(request, env, ctx, code, Number(byCode[2]));
      }
      if (path.startsWith("/api/cloud") || path.startsWith("/api/billing")) {
        if (!user) return error("login_required", "Entre na sua conta para continuar.", 401);
        if (path === "/api/cloud" && method === "POST") return await createCloud(request, env, ctx, user, await activePlan(env, user.id));
        if (path === "/api/cloud/mine" && method === "GET") return await listMine(env, user);
        const up = path.match(/^\/api\/cloud\/([0-9a-f-]{36})(?:\/(.*))?$/);
        if (up) return await uploadRoute(request, env, user, up[1], up[2] ?? "");
        if (path === "/api/billing/card" && method === "POST") return await payWithCard(request, env, user);
        if (path === "/api/billing/pix" && method === "POST") return await payOnce(request, env, user, "pix");
        if (path === "/api/billing/boleto" && method === "POST") return await payOnce(request, env, user, "boleto");
        const pass = path.match(/^\/api\/billing\/pass\/([0-9a-f-]{36})$/);
        if (pass && method === "GET") return await passStatus(env, user, pass[1]);
        if (path === "/api/billing/sync" && method === "GET") return await syncMine(env, user);
        if (path === "/api/billing/cancel" && method === "POST") return await cancel(env, user);
      }

      return error("not_found", "Rota não encontrada.", 404);
    } catch (err) {
      log("app", "unhandled_error", { level: "error", path, message: String(err).slice(0, 300) });
      systemEvent(env, ctx, "error", "unhandled_error", `${method} ${path}: ${String(err).slice(0, 300)}`);
      return error("internal", "Algo deu errado do nosso lado. Tente de novo.", 500);
    }
  },

  /** De hora em hora: expira arquivos da nuvem e limpa registros vencidos. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      const expired = await expireTransfers(env);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM access_log WHERE ts < ?").bind(now - ACCESS_LOG_RETENTION_MS),
        env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
        env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?").bind(now - 86400_000),
        env.DB.prepare("DELETE FROM system_events WHERE ts < ?").bind(now - 30 * 86400_000),
        // P2P que nunca terminou (aba fechada no meio) vira "abandonada" depois de 12h.
        env.DB.prepare("UPDATE transfers SET status = 'abandoned' WHERE kind = 'p2p' AND status = 'started' AND ts < ?").bind(now - 12 * 3600_000),
      ]);
      const passes = await passMaintenance(env, env.SITE_URL ?? "https://transfernow.duia.com.br");
      await putSetting(env, "cron_last", { ts: now, expired, ...passes });
    } catch (err) {
      await systemEvent(env, null, "error", "cron_failed", String(err).slice(0, 300));
    }
  },
} satisfies ExportedHandler<Env>;

async function allow(limiter: Env["JOIN_LIMITER"], request: Request): Promise<boolean> {
  if (!limiter) return true;
  return (await limiter.limit({ key: clientIp(request) })).success;
}

async function config(env: Env): Promise<Response> {
  const [plans, ads] = await Promise.all([getPlans(env), getAds(env)]);
  return json(
    {
      roomTtlSeconds: ttl(env),
      plans,
      prices: { starter: plans.starter.price, scale: plans.scale.price, pro: plans.pro.price },
      ads: {
        rewardedUnit: ads.enabled ? ads.rewardedUnit : null,
        onReceive: ads.enabled && ads.onReceive,
        everyN: ads.everyN,
      },
      login: { email: !!env.EMAIL, google: !!env.GOOGLE_CLIENT_ID },
      billing: !!env.MP_ACCESS_TOKEN,
      mpPublicKey: env.MP_PUBLIC_KEY || null,
    },
    200,
    { "Cache-Control": "public, max-age=60" },
  );
}

async function me(request: Request, env: Env, user: User | null): Promise<Response> {
  const plan = await activePlan(env, user?.id);
  const { view, setCookie } = await usageView(request, env, user, plan);
  const subscription = user ? await subscriptionView(env, user) : null;
  return json(
    { user: user ? { email: user.email, name: user.name, admin: isAdmin(user, env) } : null, plan, usage: view, subscription },
    200,
    setCookie ? { "Set-Cookie": setCookie } : {},
  );
}

async function reserveP2P(request: Request, env: Env, user: User | null): Promise<Response> {
  const body = await readJson<{ sizes?: number[] }>(request);
  const sizes = (body?.sizes ?? []).slice(0, 2000).map((n) => Math.max(0, Math.floor(Number(n) || 0)));
  if (sizes.length === 0) return error("bad_request", "Nenhum arquivo informado.");
  const plan = await activePlan(env, user?.id);
  const r = await reserve(request, env, user, plan, sizes, "p2p");
  const headers: Record<string, string> = r.setCookie ? { "Set-Cookie": r.setCookie } : {};
  if (!r.ok) return json({ ok: false, ...r.denial, plan }, 403, headers);
  return json({ ok: true, plan, ads: r.ads, transferId: r.transferId }, 200, headers);
}

async function iceServers(env: Env): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: STUN_ONLY, turn: false });
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 6 * 60 * 60 }),
  });
  if (!res.ok) {
    log("app", "turn_credentials_failed", { level: "error", status: res.status });
    return json({ iceServers: STUN_ONLY, turn: false });
  }
  const data = (await res.json()) as { iceServers: IceServer[] };
  // A porta 53 é bloqueada pelos navegadores e só causa espera; removemos.
  const servers = data.iceServers.map((s) => ({
    ...s,
    urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
  }));
  return json({ iceServers: servers, turn: true });
}

async function createRoom(request: Request, env: Env, ctx: ExecutionContext, user: User | null): Promise<Response> {
  const ip = clientIp(request);
  const salt = env.LOG_SALT ?? "transfernow";
  const ipHash = await shortHash(ip, salt);
  if (!(await allow(env.CREATE_LIMITER, request))) {
    log("audit", "rate_limited", { action: "create", ip: ipHash });
    return error("rate_limited", "Muitos portais abertos em pouco tempo. Aguarde um minuto.", 429);
  }
  if (!user && (await bannedVisitor(request, env))) return error("banned", "O acesso deste aparelho ou rede ao TransferNow foi bloqueado.", 403);
  const plan = await activePlan(env, user?.id);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    if (await cloudCodeInUse(env, code)) continue;
    const roomHash = await shortHash(code, salt);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const res = await stub.fetch("https://room/init", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: ttl(env), roomHash, senderPaid: plan !== "free" }),
    });
    if (res.status === 201) {
      const { expiresAt } = (await res.json()) as { expiresAt: number };
      log("audit", "room_created", { room: roomHash, ip: ipHash, plan, country: request.cf?.country });
      logAccess(env, ctx, request, "room_created", user?.id, roomHash);
      return json({ code, expiresAt }, 201);
    }
  }
  log("app", "room_code_collision", { level: "error" });
  return error("try_again", "Não foi possível abrir o portal agora. Tente de novo.", 503);
}

async function connectRoom(request: Request, env: Env, ctx: ExecutionContext, rawCode: string, user: User | null): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("expected_websocket", "Use WebSocket.", 426);
  const code = rawCode.toUpperCase();
  const role = new URL(request.url).searchParams.get("role");
  if (!isValidCode(code) || (role !== "sender" && role !== "receiver")) return error("bad_request", "Código inválido.");
  const ipHash = await shortHash(clientIp(request), env.LOG_SALT ?? "transfernow");

  if (role === "receiver" && !(await allow(env.JOIN_LIMITER, request))) {
    log("audit", "rate_limited", { action: "join", ip: ipHash });
    return error("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto.", 429);
  }
  if (!user && (await bannedVisitor(request, env))) return error("banned", "O acesso deste aparelho ou rede ao TransferNow foi bloqueado.", 403);
  logAccess(env, ctx, request, role === "receiver" ? "room_join" : "room_open", user?.id, await shortHash(code, env.LOG_SALT ?? "transfernow"));

  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const target = new URL("https://room/ws");
  target.searchParams.set("role", role);
  target.searchParams.set("ip", ipHash);
  return stub.fetch(new Request(target, request));
}

function ttl(env: Env): number {
  const n = Number.parseInt(env.ROOM_TTL_SECONDS ?? "600", 10);
  return Number.isFinite(n) && n >= 60 ? n : 600;
}
