import { PAID_PLANS, PLANS, type PlanId } from "../shared/plans";
import type { User } from "./auth";
import type { Env } from "./env";
import { error, json, readJson } from "./http";
import { log } from "./log";

const MP_API = "https://api.mercadopago.com";

interface Preapproval {
  id: string;
  status: string; // pending | authorized | paused | cancelled
  external_reference?: string;
  next_payment_date?: string;
  init_point?: string;
  auto_recurring?: { transaction_amount?: number };
}

export function prices(env: Env): Record<Exclude<PlanId, "free">, number | null> {
  const p = (v?: string) => {
    const n = Number(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  };
  return { starter: p(env.PRICE_STARTER), scale: p(env.PRICE_SCALE), pro: p(env.PRICE_PRO) };
}

async function mp<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${MP_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mercadopago ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** POST /api/billing/checkout { plan } — cria a assinatura e devolve o link de pagamento. */
export async function checkout(request: Request, env: Env, user: User): Promise<Response> {
  if (!env.MP_ACCESS_TOKEN) return error("billing_unavailable", "As assinaturas ainda não estão abertas.", 503);
  const body = await readJson<{ plan?: PlanId }>(request);
  const plan = body?.plan;
  if (!plan || !PAID_PLANS.includes(plan)) return error("bad_plan", "Plano inválido.");
  const amount = prices(env)[plan as Exclude<PlanId, "free">];
  if (!amount) return error("price_missing", "O preço deste plano ainda não foi definido.", 503);

  const origin = new URL(request.url).origin;
  try {
    const pre = await mp<Preapproval>(env, "/preapproval", {
      method: "POST",
      body: JSON.stringify({
        reason: `TransferNow ${PLANS[plan].name}`,
        external_reference: `${user.id}|${plan}`,
        payer_email: user.email,
        auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: amount, currency_id: "BRL" },
        back_url: `${origin}/?assinatura=retorno`,
        status: "pending",
      }),
    });
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, user_id, plan, status, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(pre.id, user.id, plan, pre.status ?? "pending", amount, now, now)
      .run();
    log("audit", "checkout_started", { plan, amount });
    return json({ url: pre.init_point });
  } catch (err) {
    log("app", "checkout_failed", { level: "error", message: String(err).slice(0, 300) });
    return error("checkout_failed", "O Mercado Pago não respondeu. Tente de novo em instantes.", 502);
  }
}

/** Consulta a assinatura no Mercado Pago (fonte da verdade) e grava o estado. */
export async function syncPreapproval(env: Env, id: string): Promise<void> {
  const pre = await mp<Preapproval>(env, `/preapproval/${encodeURIComponent(id)}`);
  const [userId, plan] = String(pre.external_reference ?? "").split("|") as [string, PlanId];
  if (!userId || !PAID_PLANS.includes(plan)) return;
  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
  if (!user) return;
  const next = pre.next_payment_date ? Date.parse(pre.next_payment_date) : null;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, plan, status, amount, next_payment_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, amount = excluded.amount,
       next_payment_date = excluded.next_payment_date, updated_at = excluded.updated_at`,
  )
    .bind(pre.id, userId, plan, pre.status, pre.auto_recurring?.transaction_amount ?? null, next, now, now)
    .run();
  // Ao ativar um plano novo, cancela assinaturas antigas autorizadas (troca de plano).
  if (pre.status === "authorized") {
    const { results } = await env.DB.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'authorized' AND id != ?")
      .bind(userId, pre.id)
      .all<{ id: string }>();
    for (const old of results) await cancelPreapproval(env, old.id).catch(() => {});
  }
  log("audit", "subscription_sync", { plan, status: pre.status });
}

async function cancelPreapproval(env: Env, id: string): Promise<void> {
  await mp(env, `/preapproval/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
  await syncPreapproval(env, id);
}

/**
 * POST /api/billing/webhook — aviso do Mercado Pago. O aviso só diz "algo mudou":
 * o estado real sempre vem de uma consulta à API com o nosso token.
 */
export async function webhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.MP_ACCESS_TOKEN) return new Response("ok");
  const url = new URL(request.url);
  const body = (await readJson<{ type?: string; topic?: string; data?: { id?: string } }>(request)) ?? {};
  const type = body.type ?? body.topic ?? url.searchParams.get("type") ?? url.searchParams.get("topic") ?? "";
  const dataId = body.data?.id ?? url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? "";
  if (!dataId) return new Response("ok");

  if (env.MP_WEBHOOK_SECRET) {
    const valid = await validSignature(request, env.MP_WEBHOOK_SECRET, dataId);
    if (!valid) log("app", "webhook_signature_mismatch", { level: "warn", type });
  }

  ctx.waitUntil(
    (async () => {
      try {
        if (type.includes("authorized_payment")) {
          const pay = await mp<{ preapproval_id?: string }>(env, `/authorized_payments/${encodeURIComponent(dataId)}`);
          if (pay.preapproval_id) await syncPreapproval(env, pay.preapproval_id);
        } else if (type.includes("preapproval")) {
          await syncPreapproval(env, dataId);
        }
      } catch (err) {
        log("app", "webhook_sync_failed", { level: "error", type, message: String(err).slice(0, 200) });
      }
    })(),
  );
  return new Response("ok");
}

/** GET /api/billing/sync — ao voltar do checkout, confere as assinaturas pendentes do usuário. */
export async function syncMine(env: Env, user: User): Promise<Response> {
  if (!env.MP_ACCESS_TOKEN) return json({ ok: false });
  const { results } = await env.DB.prepare(
    "SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('pending','authorized','paused') ORDER BY created_at DESC LIMIT 5",
  )
    .bind(user.id)
    .all<{ id: string }>();
  for (const r of results) await syncPreapproval(env, r.id).catch(() => {});
  return json({ ok: true });
}

/** POST /api/billing/cancel — cancela a renovação; o plano vale até o fim do período pago. */
export async function cancel(env: Env, user: User): Promise<Response> {
  if (!env.MP_ACCESS_TOKEN) return error("billing_unavailable", "As assinaturas ainda não estão abertas.", 503);
  const { results } = await env.DB.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('authorized','paused')")
    .bind(user.id)
    .all<{ id: string }>();
  if (results.length === 0) return error("no_subscription", "Você não tem assinatura ativa.", 404);
  try {
    for (const r of results) await cancelPreapproval(env, r.id);
  } catch (err) {
    log("app", "cancel_failed", { level: "error", message: String(err).slice(0, 200) });
    return error("cancel_failed", "Não conseguimos cancelar agora. Tente de novo em instantes.", 502);
  }
  return json({ ok: true });
}

export async function subscriptionView(env: Env, user: User) {
  return env.DB.prepare(
    "SELECT plan, status, amount, next_payment_date FROM subscriptions WHERE user_id = ? AND status != 'pending' ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(user.id)
    .first<{ plan: PlanId; status: string; amount: number | null; next_payment_date: number | null }>();
}

/** Assinatura x-signature: ts=..,v1=HMAC-SHA256("id:<id>;request-id:<x-request-id>;ts:<ts>;"). */
async function validSignature(request: Request, secret: string, dataId: string): Promise<boolean> {
  const header = request.headers.get("x-signature") ?? "";
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=") as [string, string]));
  if (!parts.ts || !parts.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${request.headers.get("x-request-id") ?? ""};ts:${parts.ts};`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === parts.v1;
}
