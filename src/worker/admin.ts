import { AD_OUTCOMES, GB, PAID_PLANS, type AdsSettings, type PlanId } from "../shared/plans";
import { isAdmin, type User } from "./auth";
import { cancelPreapproval, repricePreapproval, syncPreapproval } from "./billing";
import { purge, setStatus } from "./cloud";
import type { Env } from "./env";
import { error, json, readJson, sha256Hex } from "./http";
import { brDay, getAds, getPlans, getSetting, invalidatePlans, putSetting, systemEvent } from "./platform";
import { activePlan, period } from "./quota";

const DAY = 86400_000;
const PAGE = 50;

interface Ctx {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  admin: User;
  url: URL;
}

/** Registro de tudo o que um administrador faz no painel. */
async function audit(c: Ctx, action: string, target?: string | null, detail?: unknown) {
  await c.env.DB.prepare("INSERT INTO admin_audit (ts, admin, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(Date.now(), c.admin.email, action, target ?? null, detail == null ? null : JSON.stringify(detail).slice(0, 2000))
    .run();
}

function days(url: URL, def = 30, max = 365): number {
  const n = Number(url.searchParams.get("days") ?? def);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.round(n))) : def;
}

function page(url: URL): number {
  return Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
}

function csv(rows: Record<string, unknown>[], filename: string): Response {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = "\ufeff" + [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : "");

// ───────────────────────────── roteador ─────────────────────────────

export async function adminRoute(request: Request, env: Env, ctx: ExecutionContext, user: User | null): Promise<Response> {
  if (!user) return error("login_required", "Entre com uma conta de administrador.", 401);
  if (!isAdmin(user, env)) return error("forbidden", "Esta conta não tem acesso ao painel.", 403);
  const url = new URL(request.url);
  const c: Ctx = { request, env, ctx, admin: user, url };
  const path = url.pathname.replace(/^\/api\/admin/, "") || "/";
  const m = request.method;

  if (path === "/me") return json({ email: user.email });
  if (path === "/overview" && m === "GET") return overview(c);

  if (path === "/users" && m === "GET") return listUsers(c);
  let r = path.match(/^\/users\/([0-9a-f-]{36})$/);
  if (r && m === "GET") return userDetail(c, r[1]);
  r = path.match(/^\/users\/([0-9a-f-]{36})\/action$/);
  if (r && m === "POST") return userAction(c, r[1]);

  if (path === "/finance" && m === "GET") return finance(c);
  if (path === "/subscriptions" && m === "GET") return subscriptions(c);
  if (path === "/payments" && m === "GET") return payments(c);
  if (path === "/billing/sync" && m === "POST") return syncBilling(c);

  if (path === "/plans" && m === "GET") return json({ plans: await getPlans(env) });
  r = path.match(/^\/plans\/(free|starter|scale|pro)$/);
  if (r && m === "PUT") return updatePlan(c, r[1] as PlanId);

  if (path === "/ads" && m === "GET") return adsOverview(c);
  if (path === "/ads" && m === "PUT") return updateAds(c);

  if (path === "/segments" && m === "GET") return segmentCounts(c);
  r = path.match(/^\/segments\/([a-z_]+)\.csv$/);
  if (r && m === "GET") return segmentCsv(c, r[1]);
  if (path === "/campaigns" && m === "GET") return listCampaigns(c);
  if (path === "/campaigns" && m === "POST") return createCampaign(c);
  r = path.match(/^\/campaigns\/([0-9a-f-]{36})\/(send|test)$/);
  if (r && m === "POST") return r[2] === "send" ? sendCampaignBatch(c, r[1]) : testCampaign(c, r[1]);

  if (path === "/lookup" && m === "GET") return lookupCode(c);
  r = path.match(/^\/cloud\/([0-9a-f-]{36})\/remove$/);
  if (r && m === "POST") return removeCloud(c, r[1]);
  if (path === "/access-log" && m === "GET") return accessLog(c);
  if (path === "/bans" && m === "GET") return listBans(c);
  if (path === "/bans" && m === "POST") return addBan(c);
  r = path.match(/^\/bans\/([0-9a-f-]{36})$/);
  if (r && m === "DELETE") return removeBan(c, r[1]);
  if (path === "/system" && m === "GET") return system(c);
  if (path === "/audit" && m === "GET") return auditLog(c);

  return error("not_found", "Rota não encontrada.", 404);
}

// ───────────────────────────── BI ─────────────────────────────

const COMPLETED = "((kind = 'p2p' AND status = 'done') OR (kind = 'cloud' AND status IN ('ready','done','expired','removed')))";

async function overview(c: Ctx): Promise<Response> {
  const { env, url } = c;
  const n = days(url);
  const now = Date.now();
  const from = now - n * DAY;
  const fromDay = brDay(from);
  const prevFrom = from - n * DAY;
  const prevFromDay = brDay(prevFrom);
  const db = env.DB;

  const [usersTotal, usersNew, usersPrevNew, activeSubs, grants, perDay, prevTotals, p2pStats, countries, newUsersDay, revenue, revenuePrev, cloudNow, adsTotals, planMix, senders] =
    await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>(),
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?").bind(from).first<{ n: number }>(),
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?").bind(prevFrom, from).first<{ n: number }>(),
      db.prepare("SELECT plan, COUNT(*) AS n, COALESCE(SUM(amount),0) AS mrr FROM subscriptions WHERE status = 'authorized' GROUP BY plan").all<{ plan: string; n: number; mrr: number }>(),
      db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM plan_grants WHERE revoked_at IS NULL AND starts_at <= ? AND ends_at > ?").bind(now, now).first<{ n: number }>(),
      db.prepare(`SELECT day, kind, COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM transfers WHERE day >= ? AND ${COMPLETED} GROUP BY day, kind ORDER BY day`).bind(fromDay).all<{ day: string; kind: string; n: number; bytes: number }>(),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM transfers WHERE day >= ? AND day < ? AND ${COMPLETED}`).bind(prevFromDay, fromDay).first<{ n: number; bytes: number }>(),
      db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(relay),0) AS relay FROM transfers WHERE kind = 'p2p' AND day >= ? GROUP BY status").bind(fromDay).all<{ status: string; n: number; relay: number }>(),
      db.prepare(`SELECT COALESCE(country,'??') AS country, COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM transfers WHERE day >= ? AND ${COMPLETED} GROUP BY country ORDER BY n DESC LIMIT 10`).bind(fromDay).all<{ country: string; n: number; bytes: number }>(),
      db.prepare("SELECT date((created_at - 10800000) / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day ORDER BY day").bind(from).all<{ day: string; n: number }>(),
      db.prepare("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payments WHERE status = 'approved' AND paid_at >= ?").bind(from).first<{ total: number; n: number }>(),
      db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE status = 'approved' AND paid_at >= ? AND paid_at < ?").bind(prevFrom, from).first<{ total: number }>(),
      db.prepare("SELECT COUNT(DISTINCT t.id) AS transfers, COALESCE(SUM(f.size),0) AS bytes FROM cloud_transfers t JOIN cloud_files f ON f.transfer_id = t.id WHERE t.status IN ('uploading','ready') AND f.downloaded_at IS NULL").first<{ transfers: number; bytes: number }>(),
      db.prepare("SELECT outcome, COALESCE(SUM(count),0) AS n FROM ad_stats WHERE day >= ? GROUP BY outcome").bind(fromDay).all<{ outcome: string; n: number }>(),
      db.prepare(`SELECT CASE WHEN plan = 'free' THEN 'free' ELSE 'paid' END AS tier, COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM transfers WHERE day >= ? AND ${COMPLETED} GROUP BY tier`).bind(fromDay).all<{ tier: string; n: number; bytes: number }>(),
      db.prepare("SELECT COUNT(DISTINCT COALESCE(user_id, subject)) AS n FROM transfers WHERE day >= ?").bind(fromDay).first<{ n: number }>(),
    ]);

  const series: { day: string; p2p: number; cloud: number; bytes: number; newUsers: number }[] = [];
  for (let d = 0; d < n; d++) {
    const day = brDay(from + (d + 1) * DAY);
    series.push({ day, p2p: 0, cloud: 0, bytes: 0, newUsers: 0 });
  }
  const byDay = new Map(series.map((s) => [s.day, s]));
  for (const row of perDay.results) {
    const s = byDay.get(row.day);
    if (!s) continue;
    if (row.kind === "p2p") s.p2p += row.n;
    else s.cloud += row.n;
    s.bytes += row.bytes;
  }
  for (const row of newUsersDay.results) {
    const s = byDay.get(row.day);
    if (s) s.newUsers = row.n;
  }

  const p2p = Object.fromEntries(p2pStats.results.map((r) => [r.status, r]));
  const done = p2p.done?.n ?? 0;
  const failed = p2p.failed?.n ?? 0;
  const totalTransfers = series.reduce((s, d) => s + d.p2p + d.cloud, 0);
  const totalBytes = series.reduce((s, d) => s + d.bytes, 0);
  const ads = Object.fromEntries(adsTotals.results.map((r) => [r.outcome, r.n]));

  return json({
    days: n,
    kpis: {
      usersTotal: usersTotal?.n ?? 0,
      usersNew: usersNew?.n ?? 0,
      usersNewPrev: usersPrevNew?.n ?? 0,
      subscribers: activeSubs.results.reduce((s, r) => s + r.n, 0),
      grants: grants?.n ?? 0,
      mrr: activeSubs.results.reduce((s, r) => s + r.mrr, 0),
      revenue: revenue?.total ?? 0,
      revenuePrev: revenuePrev?.total ?? 0,
      transfers: totalTransfers,
      transfersPrev: prevTotals?.n ?? 0,
      bytes: totalBytes,
      bytesPrev: prevTotals?.bytes ?? 0,
      activeSenders: senders?.n ?? 0,
      p2pSuccessRate: done + failed > 0 ? done / (done + failed) : null,
      relayShare: done > 0 ? (p2p.done?.relay ?? 0) / done : null,
      cloudStoredBytes: cloudNow?.bytes ?? 0,
      cloudStoredTransfers: cloudNow?.transfers ?? 0,
      adsGranted: ads.granted ?? 0,
    },
    series,
    subscribersByPlan: activeSubs.results,
    countries: countries.results,
    tiers: planMix.results,
  });
}

// ───────────────────────────── usuários ─────────────────────────────

async function listUsers(c: Ctx): Promise<Response> {
  const { env, url } = c;
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const status = url.searchParams.get("status") ?? "";
  const tier = url.searchParams.get("tier") ?? "";
  const now = Date.now();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push("(u.email LIKE ? OR u.name LIKE ? OR u.id = ?)");
    binds.push(`%${q}%`, `%${q}%`, q);
  }
  if (["active", "blocked", "banned"].includes(status)) {
    where.push("u.status = ?");
    binds.push(status);
  }
  if (status === "admin") where.push("u.role = 'admin'");
  const paidExists = `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND (s.status = 'authorized' OR (s.status IN ('cancelled','paused') AND s.next_payment_date > ${now})))`;
  const grantExists = `EXISTS (SELECT 1 FROM plan_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL AND g.starts_at <= ${now} AND g.ends_at > ${now})`;
  if (tier === "paid") where.push(paidExists);
  if (tier === "grant") where.push(grantExists);
  if (tier === "free") where.push(`NOT ${paidExists} AND NOT ${grantExists}`);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const p = page(url);
  const per = period();

  const [rows, total] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_seen_at,
        (SELECT s.plan FROM subscriptions s WHERE s.user_id = u.id AND (s.status = 'authorized' OR (s.status IN ('cancelled','paused') AND s.next_payment_date > ${now})) ORDER BY s.updated_at DESC LIMIT 1) AS sub_plan,
        (SELECT s.status FROM subscriptions s WHERE s.user_id = u.id ORDER BY s.updated_at DESC LIMIT 1) AS sub_status,
        (SELECT g.plan FROM plan_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL AND g.starts_at <= ${now} AND g.ends_at > ${now} LIMIT 1) AS grant_plan,
        (SELECT us.bytes FROM usage us WHERE us.subject = 'u:' || u.id AND us.period = ?) AS month_bytes,
        (SELECT us.transfers FROM usage us WHERE us.subject = 'u:' || u.id AND us.period = ?) AS month_transfers
       FROM users u ${w} ORDER BY u.created_at DESC LIMIT ${PAGE} OFFSET ${p * PAGE}`,
    )
      .bind(per, per, ...binds)
      .all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${w}`).bind(...binds).first<{ n: number }>(),
  ]);
  return json({ users: rows.results, total: total?.n ?? 0, page: p, pageSize: PAGE });
}

async function userDetail(c: Ctx, id: string): Promise<Response> {
  const { env } = c;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!user) return error("not_found", "Usuário não encontrado.", 404);
  const plans = await getPlans(env);
  const per = period();
  const [plan, subs, pays, grants, transfers, notes, usage, sessions, cloud] = await Promise.all([
    activePlan(env, id, plans),
    env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC").bind(id).all(),
    env.DB.prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(id).all(),
    env.DB.prepare("SELECT * FROM plan_grants WHERE user_id = ? ORDER BY created_at DESC").bind(id).all(),
    env.DB.prepare("SELECT id, ts, kind, plan, bytes, files, status, country, relay FROM transfers WHERE user_id = ? ORDER BY ts DESC LIMIT 30").bind(id).all(),
    env.DB.prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC").bind(id).all(),
    env.DB.prepare("SELECT bytes, transfers FROM usage WHERE subject = ? AND period = ?").bind(`u:${id}`, per).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?").bind(id, Date.now()).first<{ n: number }>(),
    env.DB.prepare("SELECT id, code, status, file_count, total_bytes, created_at, expires_at FROM cloud_transfers WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all(),
  ]);
  return json({
    user,
    admin: isAdmin(user as unknown as User, env),
    plan,
    limits: plans[plan],
    usage: usage ?? { bytes: 0, transfers: 0 },
    sessions: sessions?.n ?? 0,
    subscriptions: subs.results,
    payments: pays.results,
    grants: grants.results,
    transfers: transfers.results,
    cloud: cloud.results,
    notes: notes.results,
  });
}

async function userAction(c: Ctx, id: string): Promise<Response> {
  const { env } = c;
  const body = (await readJson<{ action?: string; reason?: string; plan?: PlanId; days?: number; grantId?: string; body?: string }>(c.request)) ?? {};
  const user = await env.DB.prepare("SELECT id, email, role, status FROM users WHERE id = ?").bind(id).first<{ id: string; email: string; role: string; status: string }>();
  if (!user) return error("not_found", "Usuário não encontrado.", 404);
  const reason = (body.reason ?? "").trim().slice(0, 500) || null;
  const now = Date.now();
  if (user.id === c.admin.id && ["block", "ban", "remove_admin", "delete"].includes(body.action ?? "")) {
    return error("self", "Você não pode fazer isso com a sua própria conta.");
  }

  switch (body.action) {
    case "block":
    case "ban": {
      const status = body.action === "block" ? "blocked" : "banned";
      const stmts = [
        env.DB.prepare("UPDATE users SET status = ?, status_reason = ? WHERE id = ?").bind(status, reason, id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
      ];
      if (status === "banned") {
        stmts.push(
          env.DB.prepare("INSERT INTO bans (id, kind, value, label, reason, created_by, created_at) VALUES (?, 'email', ?, ?, ?, ?, ?)").bind(
            crypto.randomUUID(), user.email, user.email, reason, c.admin.email, now,
          ),
        );
      }
      await env.DB.batch(stmts);
      await audit(c, `user_${body.action}`, user.email, { reason });
      return json({ ok: true });
    }
    case "unblock":
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET status = 'active', status_reason = NULL WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM bans WHERE kind = 'email' AND value = ?").bind(user.email),
      ]);
      await audit(c, "user_unblock", user.email);
      return json({ ok: true });
    case "grant": {
      const plan = body.plan;
      const d = Math.min(3650, Math.max(1, Math.round(Number(body.days) || 0)));
      if (!plan || !PAID_PLANS.includes(plan) || !d) return error("bad_request", "Escolha o plano e a quantidade de dias.");
      await env.DB.prepare("INSERT INTO plan_grants (id, user_id, plan, starts_at, ends_at, reason, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, plan, now, now + d * DAY, reason, c.admin.email, now)
        .run();
      await audit(c, "grant_plan", user.email, { plan, days: d, reason });
      return json({ ok: true });
    }
    case "revoke_grant":
      await env.DB.prepare("UPDATE plan_grants SET revoked_at = ? WHERE id = ? AND user_id = ?").bind(now, body.grantId ?? "", id).run();
      await audit(c, "revoke_grant", user.email, { grantId: body.grantId });
      return json({ ok: true });
    case "reset_usage":
      await env.DB.prepare("DELETE FROM usage WHERE subject = ? AND period = ?").bind(`u:${id}`, period()).run();
      await audit(c, "reset_usage", user.email, { reason });
      return json({ ok: true });
    case "logout_all":
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
      await audit(c, "logout_all", user.email);
      return json({ ok: true });
    case "make_admin":
    case "remove_admin":
      await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(body.action === "make_admin" ? "admin" : "user", id).run();
      await audit(c, body.action, user.email);
      return json({ ok: true });
    case "note": {
      const text = (body.body ?? "").trim().slice(0, 4000);
      if (!text) return error("bad_request", "Escreva a anotação.");
      await env.DB.prepare("INSERT INTO notes (id, user_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, c.admin.email, text, now)
        .run();
      await audit(c, "note", user.email);
      return json({ ok: true });
    }
    case "cancel_subscription":
    case "sync_billing": {
      if (!env.MP_ACCESS_TOKEN) return error("billing_unavailable", "O Mercado Pago ainda não está configurado.", 503);
      const { results } = await env.DB.prepare("SELECT id, status FROM subscriptions WHERE user_id = ?").bind(id).all<{ id: string; status: string }>();
      try {
        for (const s of results) {
          if (body.action === "cancel_subscription" && (s.status === "authorized" || s.status === "paused")) await cancelPreapproval(env, s.id);
          else await syncPreapproval(env, s.id, true);
        }
      } catch (err) {
        return error("billing_failed", `Mercado Pago: ${String(err).slice(0, 200)}`, 502);
      }
      await audit(c, body.action, user.email, { reason });
      return json({ ok: true });
    }
    case "delete": {
      // Pedido de exclusão (LGPD): apaga conta, sessões, arquivos na nuvem e cancela cobranças.
      if (env.MP_ACCESS_TOKEN) {
        const { results } = await env.DB.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('authorized','paused')").bind(id).all<{ id: string }>();
        for (const s of results) await cancelPreapproval(env, s.id).catch(() => {});
      }
      const { results: cloud } = await env.DB.prepare("SELECT id FROM cloud_transfers WHERE user_id = ? AND status IN ('uploading','ready')").bind(id).all<{ id: string }>();
      for (const t of cloud) await purge(env, t.id);
      await env.DB.batch([
        env.DB.prepare("UPDATE transfers SET user_id = NULL WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM usage WHERE subject = ?").bind(`u:${id}`),
        env.DB.prepare("DELETE FROM campaign_sends WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
      ]);
      await audit(c, "user_delete", user.email, { reason });
      return json({ ok: true });
    }
  }
  return error("bad_request", "Ação desconhecida.");
}

// ───────────────────────────── financeiro ─────────────────────────────

function subState(now: number) {
  return {
    active: "s.status = 'authorized'",
    cancelling: `s.status IN ('cancelled','paused') AND s.next_payment_date > ${now}`,
    expired: `s.status IN ('cancelled','paused') AND (s.next_payment_date IS NULL OR s.next_payment_date <= ${now})`,
    pending: "s.status = 'pending'",
  } as Record<string, string>;
}

async function finance(c: Ctx): Promise<Response> {
  const { env } = c;
  const now = Date.now();
  const st = subState(now);
  const monthStart = Date.parse(`${period()}-01T03:00:00Z`);
  const prevMonthStart = Date.parse(`${period(new Date(monthStart - DAY))}-01T03:00:00Z`);
  const yearAgo = now - 365 * DAY;
  const db = env.DB;
  const [counts, mrr, revMonth, revPrev, byMonth, rejected, churned, abandoned] = await Promise.all([
    Promise.all(Object.entries(st).map(async ([k, cond]) => [k, (await db.prepare(`SELECT COUNT(*) AS n FROM subscriptions s WHERE ${cond}`).first<{ n: number }>())?.n ?? 0] as const)),
    db.prepare("SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM subscriptions WHERE status = 'authorized'").first<{ v: number; n: number }>(),
    db.prepare("SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM payments WHERE status = 'approved' AND paid_at >= ?").bind(monthStart).first<{ v: number; n: number }>(),
    db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE status = 'approved' AND paid_at >= ? AND paid_at < ?").bind(prevMonthStart, monthStart).first<{ v: number }>(),
    db.prepare("SELECT strftime('%Y-%m', (paid_at - 10800000) / 1000, 'unixepoch') AS month, COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM payments WHERE status = 'approved' AND paid_at >= ? GROUP BY month ORDER BY month").bind(yearAgo).all<{ month: string; v: number; n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status IN ('rejected','cancelled') AND created_at >= ?").bind(monthStart).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'cancelled' AND updated_at >= ?").bind(monthStart).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'pending' AND created_at < ?").bind(now - DAY).first<{ n: number }>(),
  ]);
  const months: { month: string; revenue: number; payments: number }[] = [];
  const map = new Map(byMonth.results.map((r) => [r.month, r]));
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now - 3 * 3600_000);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = d.toISOString().slice(0, 7);
    months.push({ month: key, revenue: map.get(key)?.v ?? 0, payments: map.get(key)?.n ?? 0 });
  }
  const active = mrr?.n ?? 0;
  const lost = churned?.n ?? 0;
  return json({
    counts: Object.fromEntries(counts),
    mrr: mrr?.v ?? 0,
    arpu: active ? (mrr?.v ?? 0) / active : 0,
    revenueMonth: revMonth?.v ?? 0,
    paymentsMonth: revMonth?.n ?? 0,
    revenuePrevMonth: revPrev?.v ?? 0,
    rejectedMonth: rejected?.n ?? 0,
    churnMonth: active + lost > 0 ? lost / (active + lost) : null,
    abandoned: abandoned?.n ?? 0,
    months,
    billingConfigured: !!env.MP_ACCESS_TOKEN,
  });
}

async function subscriptions(c: Ctx): Promise<Response> {
  const { env, url } = c;
  const now = Date.now();
  const state = url.searchParams.get("state") ?? "active";
  const cond = subState(now)[state] ?? "1=1";
  const p = page(url);
  const sql = `SELECT s.id, s.plan, s.status, s.amount, s.next_payment_date, s.created_at, s.updated_at, u.email, u.id AS user_id,
     (SELECT COALESCE(SUM(amount),0) FROM payments pa WHERE pa.subscription_id = s.id AND pa.status = 'approved') AS paid_total
     FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id WHERE ${cond} ORDER BY s.updated_at DESC`;
  if (url.searchParams.get("format") === "csv") {
    const { results } = await env.DB.prepare(sql).all<Record<string, number | string | null>>();
    await audit(c, "export_subscriptions", state, { rows: results.length });
    return csv(
      results.map((r) => ({ email: r.email, plano: r.plan, status: r.status, valor: r.amount, proxima_cobranca: iso(r.next_payment_date as number), criada_em: iso(r.created_at as number), total_pago: r.paid_total })),
      `assinaturas-${state}.csv`,
    );
  }
  const [rows, total] = await Promise.all([
    env.DB.prepare(`${sql} LIMIT ${PAGE} OFFSET ${p * PAGE}`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM subscriptions s WHERE ${cond}`).first<{ n: number }>(),
  ]);
  return json({ subscriptions: rows.results, total: total?.n ?? 0, page: p, pageSize: PAGE });
}

async function payments(c: Ctx): Promise<Response> {
  const { env, url } = c;
  const status = url.searchParams.get("status") ?? "";
  const p = page(url);
  const where = status ? "WHERE p.status = ?" : "";
  const binds = status ? [status] : [];
  const sql = `SELECT p.id, p.subscription_id, p.plan, p.amount, p.status, p.paid_at, p.created_at, u.email, u.id AS user_id FROM payments p LEFT JOIN users u ON u.id = p.user_id ${where} ORDER BY p.created_at DESC`;
  if (url.searchParams.get("format") === "csv") {
    const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, number | string | null>>();
    await audit(c, "export_payments", status || "todas", { rows: results.length });
    return csv(
      results.map((r) => ({ id: r.id, email: r.email, plano: r.plan, valor: r.amount, status: r.status, pago_em: iso(r.paid_at as number), criado_em: iso(r.created_at as number), assinatura: r.subscription_id })),
      "transacoes.csv",
    );
  }
  const [rows, total] = await Promise.all([
    env.DB.prepare(`${sql} LIMIT ${PAGE} OFFSET ${p * PAGE}`).bind(...binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM payments p ${where}`).bind(...binds).first<{ n: number }>(),
  ]);
  return json({ payments: rows.results, total: total?.n ?? 0, page: p, pageSize: PAGE });
}

/** Reconsulta no Mercado Pago as assinaturas não finalizadas (em lotes). */
async function syncBilling(c: Ctx): Promise<Response> {
  const { env } = c;
  if (!env.MP_ACCESS_TOKEN) return error("billing_unavailable", "O Mercado Pago ainda não está configurado.", 503);
  const offset = Math.max(0, Number(c.url.searchParams.get("offset") ?? 0) || 0);
  const { results } = await env.DB.prepare(
    "SELECT id FROM subscriptions WHERE status IN ('pending','authorized','paused') OR (status = 'cancelled' AND next_payment_date > ?) ORDER BY created_at LIMIT 20 OFFSET ?",
  )
    .bind(Date.now() - 40 * DAY, offset)
    .all<{ id: string }>();
  let failed = 0;
  for (const s of results) await syncPreapproval(env, s.id, true).catch(() => failed++);
  if (offset === 0) await audit(c, "billing_sync");
  return json({ processed: results.length, failed, next: results.length === 20 ? offset + 20 : null });
}

// ───────────────────────────── planos ─────────────────────────────

async function updatePlan(c: Ctx, id: PlanId): Promise<Response> {
  const { env } = c;
  const b = (await readJson<Record<string, unknown>>(c.request)) ?? {};
  const int = (v: unknown, min: number, max: number) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return n < 0 ? -1 : Math.min(max, Math.max(min, n));
  };
  const before = (await getPlans(env))[id];
  const name = String(b.name ?? before.name).trim().slice(0, 40) || before.name;
  const monthlyGb = int(b.monthlyGb, 1, 1_000_000);
  const monthlyTransfers = int(b.monthlyTransfers, 1, 1_000_000);
  const maxFileGb = int(b.maxFileGb, 1, 1_000_000);
  const cloudHours = Math.max(0, int(b.cloudHours, 0, 24 * 30) ?? 0);
  const priceNum = b.price === null || b.price === "" ? null : Number(String(b.price).replace(",", "."));
  if (monthlyGb == null || monthlyTransfers == null || maxFileGb == null) return error("bad_request", "Preencha os limites com números (-1 para ilimitado).");
  if (priceNum != null && (!Number.isFinite(priceNum) || priceNum < 1)) return error("bad_request", "Preço inválido. Use um valor a partir de R$ 1,00.");
  if (id !== "free" && cloudHours > 0 && cloudHours > 192) return error("bad_request", "O prazo da nuvem vai até 8 dias (192 horas), o limite da regra de limpeza do armazenamento.");
  if (id === "free" && cloudHours > 0) return error("bad_request", "O plano gratuito não tem modo nuvem.");
  const price = priceNum == null ? null : Math.round(priceNum * 100) / 100;
  const ads = !!b.ads;
  const forSale = id === "free" ? false : !!b.forSale;

  await env.DB.prepare(
    "UPDATE plans SET name = ?, monthly_gb = ?, monthly_transfers = ?, max_file_gb = ?, cloud_hours = ?, ads = ?, price = ?, for_sale = ?, updated_at = ? WHERE id = ?",
  )
    .bind(name, monthlyGb, monthlyTransfers, maxFileGb, cloudHours, ads ? 1 : 0, price, forSale ? 1 : 0, Date.now(), id)
    .run();
  invalidatePlans();
  await audit(c, "plan_update", id, { before, after: { name, monthlyGb, monthlyTransfers, maxFileGb, cloudHours, ads, price, forSale } });

  // Opcional: levar o novo preço às assinaturas ativas no Mercado Pago (próximas cobranças).
  let repriced = 0;
  let repriceFailed = 0;
  if (b.applyToActive === true && price && id !== "free" && env.MP_ACCESS_TOKEN) {
    const { results } = await env.DB.prepare("SELECT id FROM subscriptions WHERE plan = ? AND status = 'authorized' AND (amount IS NULL OR amount != ?) LIMIT 40")
      .bind(id, price)
      .all<{ id: string }>();
    for (const s of results) {
      try {
        await repricePreapproval(env, s.id, price);
        repriced++;
      } catch {
        repriceFailed++;
      }
    }
    await audit(c, "plan_reprice_active", id, { price, repriced, repriceFailed });
  }
  return json({ ok: true, plans: await getPlans(env), repriced, repriceFailed });
}

// ───────────────────────────── anúncios ─────────────────────────────

async function adsOverview(c: Ctx): Promise<Response> {
  const { env, url } = c;
  const n = days(url);
  const fromDay = brDay(Date.now() - n * DAY);
  const [settings, rows] = await Promise.all([
    getAds(env),
    env.DB.prepare("SELECT day, moment, outcome, count FROM ad_stats WHERE day > ? ORDER BY day").bind(fromDay).all<{ day: string; moment: string; outcome: string; count: number }>(),
  ]);
  const totals: Record<string, number> = Object.fromEntries(AD_OUTCOMES.map((o) => [o, 0]));
  const byMoment: Record<string, Record<string, number>> = { send: { ...totals }, receive: { ...totals } };
  const series = new Map<string, { day: string; granted: number; unavailable: number }>();
  for (let d = 0; d < n; d++) {
    const day = brDay(Date.now() - (n - 1 - d) * DAY);
    series.set(day, { day, granted: 0, unavailable: 0 });
  }
  for (const r of rows.results) {
    totals[r.outcome] = (totals[r.outcome] ?? 0) + r.count;
    if (byMoment[r.moment]) byMoment[r.moment][r.outcome] = (byMoment[r.moment][r.outcome] ?? 0) + r.count;
    const s = series.get(r.day);
    if (s && (r.outcome === "granted" || r.outcome === "unavailable")) s[r.outcome] += r.count;
  }
  const requests = totals.granted + totals.unavailable + totals.aborted + totals.closed_early;
  return json({
    days: n,
    settings,
    totals,
    byMoment,
    fillRate: requests ? (requests - totals.unavailable) / requests : null,
    completionRate: totals.shown ? totals.granted / totals.shown : null,
    estimatedRevenue: settings.ecpmBrl ? (totals.granted / 1000) * settings.ecpmBrl : null,
    series: [...series.values()],
  });
}

async function updateAds(c: Ctx): Promise<Response> {
  const b = (await readJson<Partial<AdsSettings>>(c.request)) ?? {};
  const unit = typeof b.rewardedUnit === "string" ? b.rewardedUnit.trim() : "";
  if (unit && !/^\/\d+(\/[\w.\-]+)+$/.test(unit)) return error("bad_request", "O bloco deve ter o formato /1234567/nome_do_bloco.");
  const ecpm = b.ecpmBrl == null || (b.ecpmBrl as unknown) === "" ? null : Number(String(b.ecpmBrl).replace(",", "."));
  const next: AdsSettings = {
    enabled: !!b.enabled,
    rewardedUnit: unit || null,
    onSend: !!b.onSend,
    onReceive: !!b.onReceive,
    everyN: Math.min(50, Math.max(1, Math.round(Number(b.everyN) || 1))),
    ecpmBrl: ecpm != null && Number.isFinite(ecpm) && ecpm >= 0 ? Math.round(ecpm * 100) / 100 : null,
  };
  const before = await getAds(c.env);
  await putSetting(c.env, "ads", next);
  await audit(c, "ads_update", null, { before, after: next });
  return json({ ok: true, settings: next });
}

// ───────────────────────────── retenção e campanhas ─────────────────────────────

export const SEGMENTS: Record<string, { label: string; sql: (now: number) => string }> = {
  expired: {
    label: "Assinatura expirada",
    sql: (now) => `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status IN ('cancelled','paused') AND (s.next_payment_date IS NULL OR s.next_payment_date <= ${now}))
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND (s.status = 'authorized' OR (s.status IN ('cancelled','paused') AND s.next_payment_date > ${now})))`,
  },
  cancelling: {
    label: "Cancelou, ainda no período pago",
    sql: (now) => `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status IN ('cancelled','paused') AND s.next_payment_date > ${now})
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'authorized')`,
  },
  abandoned: {
    label: "Começou a assinar e não pagou",
    sql: (now) => `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'pending' AND s.created_at < ${now - DAY})
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status IN ('authorized','cancelled','paused'))`,
  },
  free_heavy: {
    label: "Contas gratuitas perto do limite este mês",
    sql: (now) => `NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status != 'pending')
      AND EXISTS (SELECT 1 FROM usage us WHERE us.subject = 'u:' || u.id AND us.period = '${period(new Date(now))}' AND (us.transfers >= 8 OR us.bytes >= ${4 * GB}))`,
  },
  free_accounts: {
    label: "Contas que nunca assinaram",
    sql: () => "NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status != 'pending')",
  },
  paying: {
    label: "Assinantes ativos",
    sql: () => "EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'authorized')",
  },
};

function segmentWhere(id: string, now: number): string | null {
  const seg = SEGMENTS[id];
  if (!seg) return null;
  return `u.status = 'active' AND u.marketing_opt_out = 0 AND ${seg.sql(now)}`;
}

async function segmentCounts(c: Ctx): Promise<Response> {
  const now = Date.now();
  const out = await Promise.all(
    Object.entries(SEGMENTS).map(async ([id, s]) => {
      const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${segmentWhere(id, now)}`).first<{ n: number }>();
      return { id, label: s.label, count: row?.n ?? 0 };
    }),
  );
  const optedOut = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE marketing_opt_out = 1").first<{ n: number }>();
  return json({ segments: out, optedOut: optedOut?.n ?? 0 });
}

async function segmentCsv(c: Ctx, id: string): Promise<Response> {
  const where = segmentWhere(id, Date.now());
  if (!where) return error("not_found", "Segmento não encontrado.", 404);
  const { results } = await c.env.DB.prepare(
    `SELECT u.email, u.name, u.created_at, u.last_seen_at,
      (SELECT s.plan FROM subscriptions s WHERE s.user_id = u.id ORDER BY s.updated_at DESC LIMIT 1) AS ultimo_plano,
      (SELECT s.next_payment_date FROM subscriptions s WHERE s.user_id = u.id ORDER BY s.updated_at DESC LIMIT 1) AS fim_periodo
     FROM users u WHERE ${where} ORDER BY u.created_at DESC`,
  ).all<Record<string, string | number | null>>();
  await audit(c, "export_segment", id, { rows: results.length });
  return csv(
    results.map((r) => ({ email: r.email, nome: r.name ?? "", ultimo_plano: r.ultimo_plano ?? "", fim_periodo: iso(r.fim_periodo as number), cadastro: iso(r.created_at as number), ultimo_acesso: iso(r.last_seen_at as number) })),
    `segmento-${id}.csv`,
  );
}

async function listCampaigns(c: Ctx): Promise<Response> {
  const { results } = await c.env.DB.prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 50").all();
  return json({ campaigns: results, emailReady: !!c.env.EMAIL });
}

async function createCampaign(c: Ctx): Promise<Response> {
  const b = (await readJson<{ name?: string; segment?: string; subject?: string; body?: string; ctaLabel?: string }>(c.request)) ?? {};
  const name = (b.name ?? "").trim().slice(0, 80);
  const subject = (b.subject ?? "").trim().slice(0, 140);
  const text = (b.body ?? "").trim().slice(0, 8000);
  const segment = b.segment ?? "";
  const where = segmentWhere(segment, Date.now());
  if (!name || !subject || !text || !where) return error("bad_request", "Preencha nome, segmento, assunto e mensagem.");
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO campaigns (id, name, segment, subject, body, cta_label, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
  )
    .bind(id, name, segment, subject, text, (b.ctaLabel ?? "").trim().slice(0, 40) || "Ver os planos", c.admin.email, now)
    .run();
  // Foto do segmento no momento da criação: quem entrar depois não recebe esta campanha.
  await c.env.DB.prepare(`INSERT INTO campaign_sends (campaign_id, user_id, email, status) SELECT ?, u.id, u.email, 'queued' FROM users u WHERE ${where}`).bind(id).run();
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM campaign_sends WHERE campaign_id = ?").bind(id).first<{ n: number }>();
  await c.env.DB.prepare("UPDATE campaigns SET total = ? WHERE id = ?").bind(total?.n ?? 0, id).run();
  await audit(c, "campaign_create", name, { segment, total: total?.n });
  return json({ ok: true, id, total: total?.n ?? 0 });
}

export async function unsubscribeToken(env: Env, userId: string): Promise<string> {
  return (await sha256Hex(`${env.LOG_SALT ?? "transfernow"}:unsub:${userId}`)).slice(0, 32);
}

async function campaignEmail(c: Ctx, camp: { id: string; subject: string; body: string; cta_label: string | null }, to: { id: string; email: string; name: string | null }) {
  const origin = c.url.origin;
  const unsub = `${origin}/api/unsubscribe?u=${to.id}&t=${await unsubscribeToken(c.env, to.id)}`;
  const first = (to.name ?? "").split(" ")[0] || "";
  const text = camp.body.replace(/\{\{\s*nome\s*\}\}/gi, first).replace(/^,\s*/, "");
  const cta = `${origin}/?planos=1&utm_source=email&utm_campaign=${camp.id}`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  return {
    from: { email: c.env.EMAIL_FROM ?? "transfernow@duia.com.br", name: "TransferNow" },
    to: to.email,
    subject: camp.subject,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    text: `${text}\n\n${camp.cta_label ?? "Ver os planos"}: ${cta}\n\nNão quer mais receber? ${unsub}`,
    html: `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0C1233;font-family:Arial,sans-serif;color:#C8D0DB">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:36px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#151729;border:1px solid #2c3046;border-radius:10px">
<tr><td style="padding:26px 28px 6px;font:italic 900 26px Arial,sans-serif;color:#E8EDF4">TransferNow</td></tr>
<tr><td style="padding:12px 28px 6px;font-size:15px;line-height:1.6">${paragraphs}</td></tr>
<tr><td style="padding:4px 28px 28px"><a href="${cta}" style="display:inline-block;background:#FF6A1F;color:#1a0a02;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:6px">${esc(camp.cta_label ?? "Ver os planos")}</a></td></tr>
</table>
<p style="font-size:12px;color:#8a93a6;margin:16px 0 0">Você recebeu este e-mail porque tem uma conta no TransferNow. <a href="${unsub}" style="color:#8a93a6">Não quero mais receber</a>.</p>
</td></tr></table></body></html>`,
  };
}

/** Envia o próximo lote (o painel chama em sequência até terminar). */
async function sendCampaignBatch(c: Ctx, id: string): Promise<Response> {
  const { env } = c;
  if (!env.EMAIL) return error("email_unavailable", "O envio de e-mail não está configurado.", 503);
  const camp = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<{ id: string; subject: string; body: string; cta_label: string | null; status: string; name: string }>();
  if (!camp) return error("not_found", "Campanha não encontrada.", 404);
  if (camp.status === "draft") {
    await env.DB.prepare("UPDATE campaigns SET status = 'sending' WHERE id = ?").bind(id).run();
    await audit(c, "campaign_send", camp.name);
  }
  const { results } = await env.DB.prepare(
    "SELECT cs.user_id AS id, cs.email, u.name, u.marketing_opt_out, u.status FROM campaign_sends cs LEFT JOIN users u ON u.id = cs.user_id WHERE cs.campaign_id = ? AND cs.status = 'queued' LIMIT 20",
  )
    .bind(id)
    .all<{ id: string; email: string; name: string | null; marketing_opt_out: number | null; status: string | null }>();
  let sent = 0;
  let failed = 0;
  for (const r of results) {
    let status = "sent";
    if (r.marketing_opt_out || r.status !== "active") status = "skipped";
    else {
      try {
        await env.EMAIL.send(await campaignEmail(c, camp, r));
        sent++;
      } catch (err) {
        status = "failed";
        failed++;
        if (failed === 1) await systemEvent(env, null, "error", "campaign_send_failed", String(err).slice(0, 300));
      }
    }
    await env.DB.prepare("UPDATE campaign_sends SET status = ?, sent_at = ? WHERE campaign_id = ? AND user_id = ?").bind(status, Date.now(), id, r.id).run();
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM campaign_sends WHERE campaign_id = ? AND status = 'queued'").bind(id).first<{ n: number }>();
  const done = (left?.n ?? 0) === 0;
  await env.DB.prepare(`UPDATE campaigns SET sent = sent + ?, failed = failed + ?, status = ?, finished_at = ? WHERE id = ?`)
    .bind(sent, failed, done ? "done" : "sending", done ? Date.now() : null, id)
    .run();
  // Se tudo do lote falhou, para: provavelmente o envio de e-mail ainda não foi ativado.
  if (results.length && failed === results.length) return error("email_failed", "O envio falhou. Confira se o domínio foi ativado no Email Service da Cloudflare.", 502);
  return json({ sent, failed, remaining: left?.n ?? 0, done });
}

async function testCampaign(c: Ctx, id: string): Promise<Response> {
  if (!c.env.EMAIL) return error("email_unavailable", "O envio de e-mail não está configurado.", 503);
  const camp = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<{ id: string; subject: string; body: string; cta_label: string | null }>();
  if (!camp) return error("not_found", "Campanha não encontrada.", 404);
  try {
    await c.env.EMAIL.send(await campaignEmail(c, { ...camp, subject: `[Teste] ${camp.subject}` }, { id: c.admin.id, email: c.admin.email, name: c.admin.name }));
  } catch (err) {
    return error("email_failed", `O envio falhou: ${String(err).slice(0, 160)}`, 502);
  }
  return json({ ok: true, to: c.admin.email });
}

// ───────────────────────────── suporte e plataforma ─────────────────────────────

async function lookupCode(c: Ctx): Promise<Response> {
  const code = (c.url.searchParams.get("code") ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return error("bad_request", "Digite um código de 6 caracteres.");
  const [cloud, room] = await Promise.all([
    c.env.DB.prepare(
      "SELECT t.*, u.email FROM cloud_transfers t LEFT JOIN users u ON u.id = t.user_id WHERE t.code = ? ORDER BY t.created_at DESC LIMIT 5",
    )
      .bind(code)
      .all<Record<string, unknown> & { id: string }>(),
    c.env.ROOMS.get(c.env.ROOMS.idFromName(code)).fetch("https://room/status").then((r) => r.json() as Promise<{ active: boolean }>).catch(() => ({ active: false })),
  ]);
  const withFiles = await Promise.all(
    cloud.results.map(async (t) => ({
      ...t,
      files: (await c.env.DB.prepare("SELECT idx, name, size, uploaded, downloaded_at FROM cloud_files WHERE transfer_id = ? ORDER BY idx").bind(t.id).all()).results,
    })),
  );
  await audit(c, "lookup_code", code);
  return json({ code, p2pActive: room.active, cloud: withFiles });
}

async function removeCloud(c: Ctx, id: string): Promise<Response> {
  const reason = ((await readJson<{ reason?: string }>(c.request))?.reason ?? "").slice(0, 500);
  const t = await c.env.DB.prepare("SELECT id, code FROM cloud_transfers WHERE id = ?").bind(id).first<{ id: string; code: string }>();
  if (!t) return error("not_found", "Transferência não encontrada.", 404);
  await purge(c.env, id);
  await setStatus(c.env, id, "removed");
  await audit(c, "cloud_remove", t.code, { id, reason });
  return json({ ok: true });
}

/** Registros de acesso do Marco Civil. Toda consulta fica na auditoria. */
async function accessLog(c: Ctx): Promise<Response> {
  const { env, url } = c;
  const ip = (url.searchParams.get("ip") ?? "").trim();
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  const from = Date.parse(url.searchParams.get("from") ?? "") || Date.now() - 30 * DAY;
  const to = Date.parse(url.searchParams.get("to") ?? "") || Date.now();
  const reason = (url.searchParams.get("reason") ?? "").trim();
  if (!ip && !email) return error("bad_request", "Informe um IP ou um e-mail.");
  if (reason.length < 5) return error("bad_request", "Informe o motivo da consulta (fica registrado na auditoria).");
  let userId: string | null = null;
  if (email) {
    userId = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())?.id ?? null;
    if (!userId && !ip) return json({ rows: [] });
  }
  const where = ["ts BETWEEN ? AND ?"];
  const binds: unknown[] = [from, to];
  if (ip) {
    where.push("ip = ?");
    binds.push(ip);
  }
  if (userId) {
    where.push("user_id = ?");
    binds.push(userId);
  }
  const { results } = await env.DB.prepare(`SELECT ts, ip, port, event, user_id, ref FROM access_log WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT 2000`)
    .bind(...binds)
    .all<{ ts: number; ip: string; port: string | null; event: string; user_id: string | null; ref: string | null }>();
  await audit(c, "access_log_query", ip || email, { from: iso(from), to: iso(to), reason, rows: results.length });
  if (url.searchParams.get("format") === "csv") {
    return csv(results.map((r) => ({ data_hora_utc: iso(r.ts), ip: r.ip, porta: r.port ?? "", evento: r.event, usuario: r.user_id ?? "", referencia: r.ref ?? "" })), "registros-de-acesso.csv");
  }
  return json({ rows: results.slice(0, 500), total: results.length });
}

async function listBans(c: Ctx): Promise<Response> {
  const { results } = await c.env.DB.prepare("SELECT * FROM bans WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC LIMIT 200").bind(Date.now()).all();
  return json({ bans: results });
}

async function addBan(c: Ctx): Promise<Response> {
  const b = (await readJson<{ kind?: string; value?: string; reason?: string; days?: number }>(c.request)) ?? {};
  const kind = b.kind;
  const raw = (b.value ?? "").trim();
  if (!kind || !["ip", "device", "email"].includes(kind) || !raw) return error("bad_request", "Escolha o tipo e informe o valor.");
  let value = raw;
  if (kind === "ip") {
    if (!/^[0-9a-f:.]{3,45}$/i.test(raw)) return error("bad_request", "IP inválido.");
    value = (await sha256Hex(`${c.env.LOG_SALT ?? "transfernow"}:${raw}`)).slice(0, 24);
  }
  if (kind === "device") value = raw.replace(/^d:/, "");
  if (kind === "email") value = raw.toLowerCase();
  const d = Number(b.days) > 0 ? Math.min(3650, Math.round(Number(b.days))) : null;
  await c.env.DB.prepare("INSERT INTO bans (id, kind, value, label, reason, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), kind, value, raw, (b.reason ?? "").slice(0, 500) || null, d ? Date.now() + d * DAY : null, c.admin.email, Date.now())
    .run();
  await audit(c, "ban_add", `${kind}:${raw}`, { reason: b.reason, days: d });
  return json({ ok: true });
}

async function removeBan(c: Ctx, id: string): Promise<Response> {
  const ban = await c.env.DB.prepare("SELECT kind, label FROM bans WHERE id = ?").bind(id).first<{ kind: string; label: string }>();
  await c.env.DB.prepare("DELETE FROM bans WHERE id = ?").bind(id).run();
  await audit(c, "ban_remove", ban ? `${ban.kind}:${ban.label}` : id);
  return json({ ok: true });
}

async function system(c: Ctx): Promise<Response> {
  const { env } = c;
  const now = Date.now();
  const [events, errors24, cron, counts, ads] = await Promise.all([
    env.DB.prepare("SELECT ts, level, event, detail FROM system_events ORDER BY ts DESC LIMIT 100").all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM system_events WHERE level = 'error' AND ts > ?").bind(now - DAY).first<{ n: number }>(),
    getSetting<{ ts: number; expired: number }>(env, "cron_last"),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sessions WHERE expires_at > ${now}) AS sessions,
        (SELECT COUNT(*) FROM access_log) AS access_log, (SELECT COUNT(*) FROM transfers) AS transfers,
        (SELECT COUNT(*) FROM cloud_transfers WHERE status IN ('uploading','ready')) AS cloud_active`,
    ).first(),
    getAds(env),
  ]);
  return json({
    config: {
      "Mercado Pago (token)": !!env.MP_ACCESS_TOKEN,
      "Mercado Pago (assinatura do webhook)": !!env.MP_WEBHOOK_SECRET,
      "Login com Google": !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      "Envio de e-mail ligado ao Worker (o domínio precisa estar ativado no Email Service)": !!env.EMAIL,
      "Anúncios (bloco definido)": !!ads.rewardedUnit,
      "TURN (retransmissor)": !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN),
      "Sal dos logs": !!env.LOG_SALT,
    },
    cron,
    errors24h: errors24?.n ?? 0,
    counts,
    events: events.results,
  });
}

async function auditLog(c: Ctx): Promise<Response> {
  const p = page(c.url);
  const { results } = await c.env.DB.prepare(`SELECT * FROM admin_audit ORDER BY ts DESC LIMIT ${PAGE} OFFSET ${p * PAGE}`).all();
  return json({ rows: results, page: p, pageSize: PAGE });
}

// ───────────────────────────── rotas públicas ligadas ao painel ─────────────────────────────

/** POST /api/ads/event { moment, outcome } — resultado do vídeo recompensado. */
export async function adEvent(request: Request, env: Env): Promise<Response> {
  const b = (await readJson<{ moment?: string; outcome?: string }>(request, 1024)) ?? {};
  if (!["send", "receive"].includes(b.moment ?? "") || !(AD_OUTCOMES as readonly string[]).includes(b.outcome ?? "")) return error("bad_request", "Evento inválido.");
  await env.DB.prepare("INSERT INTO ad_stats (day, moment, outcome, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, moment, outcome) DO UPDATE SET count = count + 1")
    .bind(brDay(), b.moment, b.outcome)
    .run();
  return json({ ok: true });
}

/** GET /api/unsubscribe?u=&t= — sair da lista de e-mails de campanha (um clique). */
export async function unsubscribe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const u = url.searchParams.get("u") ?? "";
  const t = url.searchParams.get("t") ?? "";
  const ok = /^[0-9a-f-]{36}$/.test(u) && t === (await unsubscribeToken(env, u));
  if (ok) await env.DB.prepare("UPDATE users SET marketing_opt_out = 1 WHERE id = ?").bind(u).run();
  const msg = ok ? "Pronto. Você não vai mais receber nossos e-mails de novidades e ofertas." : "Link inválido.";
  if (request.method === "POST") return new Response(ok ? "ok" : "invalid", { status: ok ? 200 : 400 });
  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TransferNow</title><link rel="stylesheet" href="/legal.css"><body><div class="wrap"><header class="top"><a class="logo" href="/">TransferNow</a></header><h1>Descadastro</h1><p>${msg}</p></div></body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
