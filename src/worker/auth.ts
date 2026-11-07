import type { Env } from "./env";
import { cookie, error, getCookie, json, randomToken, readJson, redirect, sha256Hex } from "./http";
import { log } from "./log";

export interface User {
  id: string;
  email: string;
  name: string | null;
}

const SESSION_COOKIE = "tn_sess";
const SESSION_DAYS = 30;
const LOGIN_TOKEN_MINUTES = 20;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?",
  )
    .bind(await sha256Hex(token), Date.now())
    .first<User>();
  return row ?? null;
}

async function startSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, now + SESSION_DAYS * 86400_000)
    .run();
  return cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400);
}

async function upsertUser(env: Env, email: string, name: string | null, googleSub: string | null): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? OR (google_sub IS NOT NULL AND google_sub = ?)")
    .bind(normalized, googleSub)
    .first<{ id: string }>();
  if (existing) {
    if (googleSub || name) {
      await env.DB.prepare("UPDATE users SET google_sub = COALESCE(google_sub, ?), name = COALESCE(name, ?) WHERE id = ?")
        .bind(googleSub, name, existing.id)
        .run();
    }
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, email, name, google_sub, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, normalized, name, googleSub, Date.now())
    .run();
  log("audit", "user_created", { method: googleSub ? "google" : "email" });
  return id;
}

/** POST /api/auth/email — envia o link de acesso. Responde igual exista a conta ou não. */
export async function requestEmailLink(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ email?: string }>(request);
  const email = body?.email?.trim().toLowerCase() ?? "";
  if (!EMAIL_RE.test(email)) return error("bad_email", "Digite um e-mail válido.");
  if (!env.EMAIL) return error("email_unavailable", "O login por e-mail ainda não está disponível. Use o Google.", 503);

  const token = randomToken();
  await env.DB.prepare("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), email, Date.now() + LOGIN_TOKEN_MINUTES * 60_000)
    .run();

  const origin = new URL(request.url).origin;
  const link = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  try {
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM ?? "transfernow@duia.com.br", name: "TransferNow" },
      to: email,
      subject: "Seu link de acesso ao TransferNow",
      text: `Para entrar no TransferNow, abra este link em até ${LOGIN_TOKEN_MINUTES} minutos:\n\n${link}\n\nSe não foi você, ignore este e-mail.`,
      html: emailHtml(link),
    });
  } catch (err) {
    log("app", "email_send_failed", { level: "error", message: String(err).slice(0, 200) });
    return error("email_failed", "Não conseguimos enviar o e-mail agora. Tente de novo em alguns minutos.", 502);
  }
  return json({ ok: true });
}

/** GET /api/auth/verify?token= — o link do e-mail cai aqui. */
export async function verifyEmailLink(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT email, expires_at, used_at FROM login_tokens WHERE token_hash = ?")
    .bind(hash)
    .first<{ email: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at || row.expires_at < Date.now()) return redirect("/?login=expirado");
  await env.DB.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ?").bind(Date.now(), hash).run();
  const userId = await upsertUser(env, row.email, null, null);
  return redirect("/?login=ok", { "Set-Cookie": await startSession(env, userId) });
}

/** GET /api/auth/google — redireciona para o consentimento do Google. */
export function googleStart(request: Request, env: Env): Response {
  if (!env.GOOGLE_CLIENT_ID) return redirect("/?login=google-indisponivel");
  const origin = new URL(request.url).origin;
  const state = randomToken(18);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/api/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return redirect(url.toString(), { "Set-Cookie": cookie("tn_oauth", state, 600) });
}

/** GET /api/auth/google/callback */
export async function googleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const clear = cookie("tn_oauth", "", 0);
  if (!code || !state || state !== getCookie(request, "tn_oauth") || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return redirect("/?login=falhou", { "Set-Cookie": clear });
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    log("app", "google_token_failed", { level: "error", status: res.status });
    return redirect("/?login=falhou", { "Set-Cookie": clear });
  }
  const { id_token } = (await res.json()) as { id_token?: string };
  // O id_token veio direto do Google por TLS com o nosso segredo: podemos ler o conteúdo.
  const claims = decodeJwt(id_token ?? "");
  if (!claims?.email || claims.email_verified !== true || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub) {
    return redirect("/?login=falhou", { "Set-Cookie": clear });
  }
  const userId = await upsertUser(env, claims.email, claims.name ?? null, claims.sub);
  return redirect("/?login=ok", { "Set-Cookie": [clear, await startSession(env, userId)] });
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
}

function decodeJwt(token: string): Record<string, any> | null {
  try {
    const payload = token.split(".")[1];
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

function emailHtml(link: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0C1233;font-family:Arial,sans-serif;color:#C8D0DB">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
  <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#151729;border:1px solid #2c3046;border-radius:10px">
  <tr><td style="padding:28px 28px 8px;font:italic 900 26px Arial,sans-serif;color:#E8EDF4">TransferNow</td></tr>
  <tr><td style="padding:8px 28px 20px;font-size:15px;line-height:1.6">Clique no botão para entrar na sua conta. O link vale por ${LOGIN_TOKEN_MINUTES} minutos e só funciona uma vez.</td></tr>
  <tr><td style="padding:0 28px 28px"><a href="${link}" style="display:inline-block;background:#FF6A1F;color:#1a0a02;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:6px">Entrar no TransferNow</a></td></tr>
  <tr><td style="padding:0 28px 28px;font-size:12px;color:#8a93a6">Se não foi você que pediu, ignore este e-mail.</td></tr>
  </table></td></tr></table></body></html>`;
}
