import { PAID_PLANS, type PlanId } from "../shared/plans";
import { isValidCpf, onlyDigits } from "../shared/cpf";
import type { User } from "./auth";
import { mp, syncPreapproval } from "./billing";
import type { Env } from "./env";
import { clientIp, error, json, readJson } from "./http";
import { log } from "./log";
import { getPlans, systemEvent } from "./platform";

const DAY = 86400_000;
export type Cycle = "monthly" | "yearly";

interface MpPayment {
  id: number;
  status: string; // pending | approved | authorized | in_process | in_mediation | rejected | cancelled | refunded | charged_back
  status_detail?: string;
  transaction_amount: number;
  external_reference?: string;
  date_approved?: string | null;
  date_of_expiration?: string | null;
  point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } };
  transaction_details?: { external_resource_url?: string; digitable_line?: string; barcode?: { content?: string } };
  barcode?: { content?: string };
}

interface PassRow {
  id: string;
  payment_id: string | null;
  user_id: string;
  plan: PlanId;
  cycle: Cycle;
  method: "pix" | "boleto";
  amount: number;
  status: string;
  qr_code: string | null;
  qr_base64: string | null;
  ticket_url: string | null;
  barcode: string | null;
  pay_until: number | null;
  starts_at: number | null;
  ends_at: number | null;
}

async function priceFor(env: Env, plan: PlanId, cycle: Cycle): Promise<{ amount: number; name: string } | Response> {
  if (!PAID_PLANS.includes(plan)) return error("bad_plan", "Plano inválido.");
  const p = (await getPlans(env))[plan];
  if (!p.forSale) return error("not_for_sale", "Este plano não está disponível para assinatura no momento.", 409);
  const amount = cycle === "yearly" ? p.priceYearly : p.price;
  if (!amount) return error("price_missing", cycle === "yearly" ? "Este plano ainda não tem preço anual." : "O preço deste plano ainda não foi definido.", 409);
  return { amount, name: p.name };
}

function ready(env: Env): Response | null {
  if (!env.MP_ACCESS_TOKEN) return error("billing_unavailable", "As assinaturas ainda não estão abertas.", 503);
  return null;
}

/** Mensagens claras para os motivos de recusa mais comuns do cartão. */
function cardError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("insufficient") || s.includes("saldo")) return "O cartão foi recusado por falta de limite. Tente outro cartão, Pix ou boleto.";
  if (s.includes("security_code") || s.includes("cvv")) return "O código de segurança do cartão não confere.";
  if (s.includes("expiration")) return "A validade do cartão não confere.";
  if (s.includes("high_risk") || s.includes("blacklist")) return "O pagamento foi recusado pela análise de segurança. Tente outro cartão, Pix ou boleto.";
  if (s.includes("card_token") || s.includes("token")) return "Os dados do cartão expiraram. Digite de novo e tente outra vez.";
  if (s.includes("payer_email") || s.includes("email")) return "O e-mail do pagador foi recusado pelo Mercado Pago. Confira o e-mail da sua conta.";
  return "O cartão foi recusado. Confira os dados ou tente outro cartão, Pix ou boleto.";
}

/** POST /api/billing/card — assinatura com renovação automática no cartão. */
export async function payWithCard(request: Request, env: Env, user: User): Promise<Response> {
  const notReady = ready(env);
  if (notReady) return notReady;
  const b = (await readJson<{ plan?: PlanId; cycle?: Cycle; token?: string; deviceId?: string }>(request)) ?? {};
  const cycle: Cycle = b.cycle === "yearly" ? "yearly" : "monthly";
  const price = await priceFor(env, b.plan as PlanId, cycle);
  if (price instanceof Response) return price;
  if (!b.token || !/^[\w-]{10,80}$/.test(b.token)) return error("bad_request", "Dados do cartão inválidos. Digite de novo.");

  const origin = new URL(request.url).origin;
  try {
    const pre = await mp<{ id: string; status: string }>(env, "/preapproval", {
      method: "POST",
      headers: b.deviceId ? { "X-meli-session-id": b.deviceId } : {},
      body: JSON.stringify({
        reason: `TransferNow ${price.name}${cycle === "yearly" ? " (anual)" : ""}`,
        external_reference: `${user.id}|${b.plan}|${cycle}`,
        payer_email: user.email,
        card_token_id: b.token,
        auto_recurring: { frequency: cycle === "yearly" ? 12 : 1, frequency_type: "months", transaction_amount: price.amount, currency_id: "BRL" },
        back_url: `${origin}/`,
        status: "authorized",
      }),
    });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, plan, status, amount, cycle, method, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'card', ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    )
      .bind(pre.id, user.id, b.plan, pre.status, price.amount, cycle, now, now)
      .run();
    await syncPreapproval(env, pre.id).catch(() => {});
    log("audit", "card_subscription", { plan: b.plan, cycle, status: pre.status });
    if (pre.status !== "authorized") return error("card_rejected", cardError(pre.status), 402);
    return json({ ok: true, status: pre.status, plan: b.plan });
  } catch (err) {
    const msg = String(err);
    log("app", "card_subscription_failed", { level: "warn", message: msg.slice(0, 300) });
    if (!/mercadopago 4\d\d/.test(msg)) await systemEvent(env, null, "error", "card_subscription_failed", msg.slice(0, 300));
    return error("card_rejected", cardError(msg), 402);
  }
}

interface PayerInput {
  plan?: PlanId;
  cycle?: Cycle;
  cpf?: string;
  firstName?: string;
  lastName?: string;
  address?: { zip?: string; street?: string; number?: string; neighborhood?: string; city?: string; uf?: string };
  deviceId?: string;
}

/** POST /api/billing/pix e /api/billing/boleto — pagamento avulso que libera 30 ou 365 dias. */
export async function payOnce(request: Request, env: Env, user: User, method: "pix" | "boleto"): Promise<Response> {
  const notReady = ready(env);
  if (notReady) return notReady;
  const b = (await readJson<PayerInput>(request)) ?? {};
  const cycle: Cycle = b.cycle === "yearly" ? "yearly" : "monthly";
  const price = await priceFor(env, b.plan as PlanId, cycle);
  if (price instanceof Response) return price;
  const cpf = onlyDigits(b.cpf ?? "");
  if (!isValidCpf(cpf)) return error("bad_cpf", "CPF inválido.");
  const firstName = (b.firstName ?? "").trim().slice(0, 60);
  const lastName = (b.lastName ?? "").trim().slice(0, 60);

  const payer: Record<string, unknown> = { email: user.email, identification: { type: "CPF", number: cpf } };
  if (firstName) payer.first_name = firstName;
  if (lastName) payer.last_name = lastName;

  const now = Date.now();
  let payUntil: number;
  if (method === "boleto") {
    const a = b.address ?? {};
    const zip = onlyDigits(a.zip ?? "");
    const uf = (a.uf ?? "").trim().toUpperCase();
    if (!firstName || !lastName) return error("bad_name", "Informe nome e sobrenome como no documento.");
    if (zip.length !== 8 || !a.street?.trim() || !a.neighborhood?.trim() || !a.city?.trim() || !/^[A-Z]{2}$/.test(uf)) {
      return error("bad_address", "Preencha o endereço completo para emitir o boleto.");
    }
    payer.address = {
      zip_code: zip,
      street_name: a.street.trim().slice(0, 120),
      street_number: (a.number ?? "").trim().slice(0, 12) || "S/N",
      neighborhood: a.neighborhood.trim().slice(0, 80),
      city: a.city.trim().slice(0, 80),
      federal_unit: uf,
    };
    payUntil = now + 3 * DAY;
  } else {
    payUntil = now + 60 * 60_000; // Pix vale 1 hora
  }

  const passId = crypto.randomUUID();
  const origin = new URL(request.url).origin;
  try {
    const pay = await mp<MpPayment>(env, "/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": passId, ...(b.deviceId ? { "X-meli-session-id": b.deviceId } : {}) },
      body: JSON.stringify({
        transaction_amount: price.amount,
        description: `TransferNow ${price.name} — ${cycle === "yearly" ? "12 meses" : "30 dias"}`,
        payment_method_id: method === "pix" ? "pix" : "bolbradesco",
        external_reference: `pass|${passId}`,
        notification_url: `${origin}/api/billing/webhook`,
        date_of_expiration: brIso(payUntil),
        statement_descriptor: "TRANSFERNOW",
        payer,
        additional_info: { ip_address: clientIp(request) },
      }),
    });
    const td = pay.point_of_interaction?.transaction_data ?? {};
    const barcode = pay.transaction_details?.digitable_line ?? pay.barcode?.content ?? pay.transaction_details?.barcode?.content ?? null;
    await env.DB.prepare(
      `INSERT INTO passes (id, payment_id, user_id, plan, cycle, method, amount, status, qr_code, qr_base64, ticket_url, barcode, pay_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        passId, String(pay.id), user.id, b.plan, cycle, method, price.amount, "pending",
        td.qr_code ?? null, td.qr_code_base64 ?? null,
        td.ticket_url ?? pay.transaction_details?.external_resource_url ?? null, barcode,
        pay.date_of_expiration ? Date.parse(pay.date_of_expiration) : payUntil, now, now,
      )
      .run();
    await applyPayment(env, pay);
    log("audit", "pass_created", { method, plan: b.plan, cycle });
    return json(await passView(env, passId, user.id), 201);
  } catch (err) {
    const msg = String(err);
    log("app", "pass_create_failed", { level: "warn", method, message: msg.slice(0, 300) });
    await systemEvent(env, null, "error", `${method}_create_failed`, msg.slice(0, 300));
    return error("payment_failed", `Não foi possível gerar o ${method === "pix" ? "Pix" : "boleto"} agora. Confira os dados e tente de novo.`, 502);
  }
}

async function passView(env: Env, id: string, userId: string) {
  const p = await env.DB.prepare("SELECT * FROM passes WHERE id = ? AND user_id = ?").bind(id, userId).first<PassRow & { qr_base64: string | null }>();
  if (!p) return null;
  return {
    id: p.id,
    method: p.method,
    plan: p.plan,
    cycle: p.cycle,
    amount: p.amount,
    status: p.status,
    qrCode: p.qr_code,
    qrBase64: p.qr_base64,
    ticketUrl: p.ticket_url,
    barcode: p.barcode,
    payUntil: p.pay_until,
    startsAt: p.starts_at,
    endsAt: p.ends_at,
  };
}

/** GET /api/billing/pass/:id — acompanha o pagamento (consulta o Mercado Pago se ainda pendente). */
export async function passStatus(env: Env, user: User, id: string): Promise<Response> {
  const p = await env.DB.prepare("SELECT payment_id, status FROM passes WHERE id = ? AND user_id = ?").bind(id, user.id).first<{ payment_id: string; status: string }>();
  if (!p) return error("not_found", "Pagamento não encontrado.", 404);
  if (p.status === "pending" && env.MP_ACCESS_TOKEN) {
    await syncPayment(env, p.payment_id).catch(() => {});
  }
  return json(await passView(env, id, user.id));
}

/** Consulta um pagamento no Mercado Pago e aplica o resultado. */
export async function syncPayment(env: Env, paymentId: string): Promise<void> {
  const pay = await mp<MpPayment>(env, `/v1/payments/${encodeURIComponent(paymentId)}`);
  await applyPayment(env, pay);
}

async function applyPayment(env: Env, pay: MpPayment): Promise<void> {
  const ref = pay.external_reference ?? "";
  if (!ref.startsWith("pass|")) return;
  const passId = ref.slice(5);
  const pass = await env.DB.prepare("SELECT * FROM passes WHERE id = ?").bind(passId).first<PassRow>();
  if (!pass) return;
  const now = Date.now();
  const map: Record<string, string> = {
    approved: "approved", authorized: "approved", pending: "pending", in_process: "pending", in_mediation: "pending",
    rejected: "rejected", cancelled: "cancelled", refunded: "refunded", charged_back: "refunded",
  };
  const status = map[pay.status] ?? pay.status;

  const stmts: D1PreparedStatement[] = [];
  if (status === "approved" && pass.status !== "approved") {
    // Renovação antecipada do mesmo plano soma ao período que ainda resta.
    const current = await env.DB.prepare("SELECT MAX(ends_at) AS ends FROM passes WHERE user_id = ? AND plan = ? AND status = 'approved' AND ends_at > ? AND id != ?")
      .bind(pass.user_id, pass.plan, now, pass.id)
      .first<{ ends: number | null }>();
    const start = Math.max(now, current?.ends ?? 0);
    const end = start + (pass.cycle === "yearly" ? 365 : 30) * DAY;
    stmts.push(env.DB.prepare("UPDATE passes SET status = 'approved', payment_id = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?").bind(String(pay.id), start, end, now, pass.id));
    log("audit", "pass_approved", { method: pass.method, plan: pass.plan, cycle: pass.cycle });
  } else if (status !== pass.status && !(pass.status === "approved" && status === "pending")) {
    // Estorno ou contestação depois de aprovado encerra o período na hora.
    const endNow = status === "refunded" && pass.status === "approved" ? now : pass.ends_at;
    stmts.push(env.DB.prepare("UPDATE passes SET status = ?, payment_id = ?, ends_at = ?, updated_at = ? WHERE id = ?").bind(status, String(pay.id), endNow, now, pass.id));
  }
  // Toda cobrança aparece no financeiro.
  stmts.push(
    env.DB.prepare(
      `INSERT INTO payments (id, subscription_id, user_id, plan, amount, status, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, paid_at = COALESCE(excluded.paid_at, payments.paid_at), updated_at = excluded.updated_at`,
    ).bind(
      String(pay.id), `pass:${pass.id}`, pass.user_id, pass.plan, pay.transaction_amount, pay.status,
      pay.status === "approved" ? Date.parse(pay.date_approved ?? "") || now : null, now, now,
    ),
  );
  await env.DB.batch(stmts);
}

/** Rotina: avisa quem pagou com Pix/boleto que o período está acabando; expira cobranças não pagas. */
export async function passMaintenance(env: Env, origin: string): Promise<{ reminded: number; unpaidExpired: number }> {
  const now = Date.now();
  // Pix vence em 1h; boleto pode compensar até 3 dias úteis depois do vencimento.
  const expired = await env.DB.prepare("UPDATE passes SET status = 'expired', updated_at = ? WHERE status = 'pending' AND pay_until < ?")
    .bind(now, now - 5 * DAY)
    .run();
  await env.DB.prepare("UPDATE passes SET status = 'expired', updated_at = ? WHERE status = 'pending' AND method = 'pix' AND pay_until < ?").bind(now, now - DAY).run();

  let reminded = 0;
  if (env.EMAIL) {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.plan, p.ends_at, u.email, u.name FROM passes p JOIN users u ON u.id = p.user_id
       WHERE p.status = 'approved' AND p.reminded_at IS NULL AND p.ends_at BETWEEN ? AND ? AND u.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM passes q WHERE q.user_id = p.user_id AND q.status = 'approved' AND q.ends_at > p.ends_at)
         AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = p.user_id AND s.status = 'authorized')
       LIMIT 50`,
    )
      .bind(now, now + 3 * DAY)
      .all<{ id: string; plan: PlanId; ends_at: number; email: string; name: string | null }>();
    const plans = await getPlans(env);
    const fmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long", timeZone: "America/Sao_Paulo" });
    for (const r of results) {
      const until = fmt.format(r.ends_at);
      const link = `${origin}/?planos=1&utm_source=email&utm_campaign=renovacao`;
      try {
        await env.EMAIL.send({
          from: { email: env.EMAIL_FROM ?? "transfernow@duia.com.br", name: "TransferNow" },
          to: r.email,
          subject: `Seu plano ${plans[r.plan].name} termina em ${until}`,
          text: `Oi${r.name ? ` ${r.name.split(" ")[0]}` : ""},\n\nO seu plano ${plans[r.plan].name} do TransferNow, pago com Pix ou boleto, termina em ${until}. Para continuar sem interrupção, renove pelo site:\n\n${link}\n\nSe preferir não se preocupar com isso, assine com cartão e a renovação passa a ser automática.`,
          html: renewHtml(plans[r.plan].name, until, link),
        });
        await env.DB.prepare("UPDATE passes SET reminded_at = ? WHERE id = ?").bind(now, r.id).run();
        reminded++;
      } catch (err) {
        await systemEvent(env, null, "error", "renewal_email_failed", String(err).slice(0, 200));
        break;
      }
    }
  }
  return { reminded, unpaidExpired: expired.meta.changes ?? 0 };
}

function renewHtml(plan: string, until: string, link: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0C1233;font-family:Arial,sans-serif;color:#C8D0DB">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:36px 16px">
<table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#151729;border:1px solid #2c3046;border-radius:10px">
<tr><td style="padding:26px 28px 6px;font:italic 900 26px Arial,sans-serif;color:#E8EDF4">TransferNow</td></tr>
<tr><td style="padding:12px 28px 6px;font-size:15px;line-height:1.6"><p style="margin:0 0 12px">O seu plano <strong>${plan}</strong>, pago com Pix ou boleto, termina em <strong>${until}</strong>.</p><p style="margin:0">Renove para continuar mandando arquivos maiores, sem anúncios e com a nuvem.</p></td></tr>
<tr><td style="padding:12px 28px 28px"><a href="${link}" style="display:inline-block;background:#FF6A1F;color:#1a0a02;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:6px">Renovar o plano</a></td></tr>
</table></td></tr></table></body></html>`;
}

/** Data no formato que o Mercado Pago aceita, no fuso de Brasília. */
function brIso(ts: number): string {
  return new Date(ts - 3 * 3600_000).toISOString().replace("Z", "-03:00");
}
