import { FAIR_USE_GB, FREE_IP_MULTIPLIER, GB, type PlanId, type PlanMap, type UsageView } from "../shared/plans";
import type { User } from "./auth";
import type { Env } from "./env";
import { clientIp, cookie, getCookie, randomToken, sha256Hex } from "./http";
import { brDay, getAds, getPlans, planRank } from "./platform";

const DEVICE_COOKIE = "tn_dev";

export function period(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Plano ativo: maior entre assinatura vigente e cortesia vigente. */
export async function activePlan(env: Env, userId: string | null | undefined, plans?: PlanMap): Promise<PlanId> {
  if (!userId) return "free";
  plans ??= await getPlans(env);
  const now = Date.now();
  const [subs, grants] = await Promise.all([
    env.DB.prepare("SELECT plan, status, next_payment_date FROM subscriptions WHERE user_id = ? AND status IN ('authorized','cancelled','paused')")
      .bind(userId)
      .all<{ plan: PlanId; status: string; next_payment_date: number | null }>(),
    env.DB.prepare("SELECT plan FROM plan_grants WHERE user_id = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?")
      .bind(userId, now, now)
      .all<{ plan: PlanId }>()
      .catch(() => ({ results: [] as { plan: PlanId }[] })),
  ]);
  let best: PlanId = "free";
  const consider = (p: PlanId) => {
    if (plans![p] && planRank(plans!, p) > planRank(plans!, best)) best = p;
  };
  for (const s of subs.results) if (s.status === "authorized" || (s.next_payment_date ?? 0) > now) consider(s.plan);
  for (const g of grants.results) consider(g.plan);
  return best;
}

/** Identificador do aparelho para o plano gratuito (cookie HttpOnly criado pelo servidor). */
export async function deviceSubject(request: Request): Promise<{ id: string; subject: string; setCookie?: string }> {
  let id = getCookie(request, DEVICE_COOKIE);
  let setCookie: string | undefined;
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = randomToken(18);
    setCookie = cookie(DEVICE_COOKIE, id, 400 * 86400);
  }
  return { id, subject: `d:${id}`, setCookie };
}

export async function ipHash(request: Request, env: Env): Promise<string> {
  return (await sha256Hex(`${env.LOG_SALT ?? "transfernow"}:${clientIp(request)}`)).slice(0, 24);
}

/** O IP ou o aparelho foram banidos pelo painel? */
export async function bannedVisitor(request: Request, env: Env): Promise<string | null> {
  const ip = await ipHash(request, env);
  const dev = getCookie(request, DEVICE_COOKIE) ?? "";
  try {
    const row = await env.DB.prepare(
      "SELECT reason FROM bans WHERE ((kind = 'ip' AND value = ?) OR (kind = 'device' AND value = ?)) AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
    )
      .bind(ip, dev, Date.now())
      .first<{ reason: string | null }>();
    return row ? (row.reason ?? "bloqueado") : null;
  } catch {
    return null;
  }
}

async function readUsage(env: Env, subject: string, p: string) {
  return (
    (await env.DB.prepare("SELECT bytes, transfers FROM usage WHERE subject = ? AND period = ?").bind(subject, p).first<{ bytes: number; transfers: number }>()) ?? {
      bytes: 0,
      transfers: 0,
    }
  );
}

export async function usageView(request: Request, env: Env, user: User | null, plan: PlanId): Promise<{ view: UsageView; setCookie?: string }> {
  const plans = await getPlans(env);
  const p = period();
  if (user) {
    const u = await readUsage(env, `u:${user.id}`, p);
    return { view: { plan, period: p, ...u, limits: plans[plan] } };
  }
  const dev = await deviceSubject(request);
  const u = await readUsage(env, dev.subject, p);
  return { view: { plan, period: p, ...u, limits: plans[plan] }, setCookie: dev.setCookie };
}

export type QuotaDenial =
  | { code: "file_too_large"; message: string; limitBytes: number }
  | { code: "monthly_bytes"; message: string }
  | { code: "monthly_transfers"; message: string }
  | { code: "banned"; message: string };

export interface Reservation {
  ok: true;
  transferId: string;
  /** mostrar vídeo recompensado neste envio */
  ads: boolean;
  setCookie?: string;
}

/**
 * Confere e consome a cota de uma transferência (uma leva de arquivos) e registra a
 * transferência para o BI. Gratuito: conta por aparelho e, com teto maior, por IP.
 */
export async function reserve(
  request: Request,
  env: Env,
  user: User | null,
  plan: PlanId,
  fileSizes: number[],
  kind: "p2p" | "cloud",
  transferId: string = crypto.randomUUID(),
): Promise<Reservation | { ok: false; denial: QuotaDenial; setCookie?: string }> {
  const plans = await getPlans(env);
  const limits = plans[plan];
  const bytes = fileSizes.reduce((s, n) => s + Math.max(0, n), 0);
  const p = period();

  let maxFile = limits.maxFileGb > 0 ? limits.maxFileGb * GB : -1;
  if (plan === "free") {
    const override = Number.parseInt(env.MAX_FILE_SIZE_MB ?? "-1", 10);
    if (Number.isFinite(override) && override > 0) maxFile = Math.min(maxFile > 0 ? maxFile : Infinity, override * 1024 * 1024);
  }

  const subjects: { subject: string; gb: number; transfers: number }[] = [];
  let setCookie: string | undefined;
  let device: string | null = null;
  if (user) {
    const gb = limits.monthlyGb > 0 ? limits.monthlyGb : FAIR_USE_GB;
    subjects.push({ subject: `u:${user.id}`, gb, transfers: limits.monthlyTransfers });
  } else {
    const ban = await bannedVisitor(request, env);
    if (ban) return { ok: false, denial: { code: "banned", message: "O acesso deste aparelho ou rede ao TransferNow foi bloqueado." } };
    const dev = await deviceSubject(request);
    setCookie = dev.setCookie;
    device = dev.subject;
    subjects.push({ subject: dev.subject, gb: limits.monthlyGb, transfers: limits.monthlyTransfers });
    subjects.push({
      subject: `i:${await ipHash(request, env)}`,
      gb: limits.monthlyGb * FREE_IP_MULTIPLIER,
      transfers: limits.monthlyTransfers * FREE_IP_MULTIPLIER,
    });
  }

  if (maxFile > 0 && fileSizes.some((s) => s > maxFile)) {
    return {
      ok: false,
      setCookie,
      denial: { code: "file_too_large", message: `O plano ${limits.name} aceita arquivos de até ${fmtBytes(maxFile)}.`, limitBytes: maxFile },
    };
  }

  let primaryCount = 0;
  for (const [i, s] of subjects.entries()) {
    const u = await readUsage(env, s.subject, p);
    if (i === 0) primaryCount = u.transfers;
    if (s.transfers > 0 && u.transfers + 1 > s.transfers) {
      return { ok: false, setCookie, denial: { code: "monthly_transfers", message: `Você usou as ${limits.monthlyTransfers} transferências do mês no plano ${limits.name}.` } };
    }
    if (s.gb > 0 && u.bytes + bytes > s.gb * GB) {
      const left = Math.max(0, s.gb * GB - u.bytes);
      return { ok: false, setCookie, denial: { code: "monthly_bytes", message: `Restam ${fmtBytes(left)} no seu plano ${limits.name} este mês.` } };
    }
  }

  const now = Date.now();
  await env.DB.batch([
    ...subjects.map((s) =>
      env.DB.prepare(
        "INSERT INTO usage (subject, period, bytes, transfers) VALUES (?, ?, ?, 1) ON CONFLICT(subject, period) DO UPDATE SET bytes = bytes + excluded.bytes, transfers = transfers + 1",
      ).bind(s.subject, p, bytes),
    ),
    env.DB.prepare(
      "INSERT INTO transfers (id, ts, day, kind, plan, user_id, subject, bytes, files, status, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      transferId, now, brDay(now), kind, plan, user?.id ?? null, device, bytes, fileSizes.length,
      kind === "p2p" ? "started" : "uploading", (request.cf?.country as string | undefined) ?? null,
    ),
  ]);

  const ads = await getAds(env);
  const showAd = limits.ads && ads.enabled && ads.onSend && !!ads.rewardedUnit && (primaryCount + 1) % Math.max(1, ads.everyN) === 0;
  return { ok: true, transferId, ads: showAd, setCookie };
}

export function fmtBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(n % GB === 0 ? 0 : 1).replace(".", ",")} GB`;
  return `${Math.round(n / 1024 / 1024)} MB`;
}
