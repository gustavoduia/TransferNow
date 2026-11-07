import { FAIR_USE_GB, FREE_IP_MULTIPLIER, GB, PLANS, type PlanId, type UsageView } from "../shared/plans";
import type { User } from "./auth";
import type { Env } from "./env";
import { clientIp, cookie, getCookie, randomToken, sha256Hex } from "./http";

const DEVICE_COOKIE = "tn_dev";

export function period(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Plano ativo: assinatura autorizada, ou cancelada/pausada ainda dentro do período pago. */
export async function activePlan(env: Env, userId: string | null | undefined): Promise<PlanId> {
  if (!userId) return "free";
  const { results } = await env.DB.prepare(
    "SELECT plan, status, next_payment_date FROM subscriptions WHERE user_id = ? AND status IN ('authorized','cancelled','paused')",
  )
    .bind(userId)
    .all<{ plan: PlanId; status: string; next_payment_date: number | null }>();
  const rank: Record<PlanId, number> = { free: 0, starter: 1, scale: 2, pro: 3 };
  let best: PlanId = "free";
  const now = Date.now();
  for (const s of results) {
    const active = s.status === "authorized" || (s.next_payment_date ?? 0) > now;
    if (active && PLANS[s.plan] && rank[s.plan] > rank[best]) best = s.plan;
  }
  return best;
}

/** Identificador do aparelho para o plano gratuito (cookie HttpOnly criado pelo servidor). */
export async function deviceSubject(request: Request): Promise<{ subject: string; setCookie?: string }> {
  let id = getCookie(request, DEVICE_COOKIE);
  let setCookie: string | undefined;
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = randomToken(18);
    setCookie = cookie(DEVICE_COOKIE, id, 400 * 86400);
  }
  return { subject: `d:${id}`, setCookie };
}

async function ipSubject(request: Request, env: Env): Promise<string> {
  return `i:${(await sha256Hex(`${env.LOG_SALT ?? "transfernow"}:${clientIp(request)}`)).slice(0, 24)}`;
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
  const p = period();
  if (user) {
    const u = await readUsage(env, `u:${user.id}`, p);
    return { view: { plan, period: p, ...u, limits: PLANS[plan] } };
  }
  const dev = await deviceSubject(request);
  const u = await readUsage(env, dev.subject, p);
  return { view: { plan, period: p, ...u, limits: PLANS[plan] }, setCookie: dev.setCookie };
}

export type QuotaDenial =
  | { code: "file_too_large"; message: string; limitBytes: number }
  | { code: "monthly_bytes"; message: string }
  | { code: "monthly_transfers"; message: string };

/**
 * Confere e consome a cota de uma transferência (uma leva de arquivos).
 * Gratuito: conta por aparelho e, com teto bem maior, por IP. Pagos: conta por usuário.
 */
export async function reserve(
  request: Request,
  env: Env,
  user: User | null,
  plan: PlanId,
  fileSizes: number[],
): Promise<{ ok: true; setCookie?: string } | { ok: false; denial: QuotaDenial; setCookie?: string }> {
  const limits = PLANS[plan];
  const bytes = fileSizes.reduce((s, n) => s + Math.max(0, n), 0);
  const p = period();

  let maxFile = limits.maxFileGb > 0 ? limits.maxFileGb * GB : -1;
  if (plan === "free") {
    const override = Number.parseInt(env.MAX_FILE_SIZE_MB ?? "-1", 10);
    if (Number.isFinite(override) && override > 0) maxFile = Math.min(maxFile > 0 ? maxFile : Infinity, override * 1024 * 1024);
  }

  const subjects: { subject: string; gb: number; transfers: number }[] = [];
  let setCookie: string | undefined;
  if (user) {
    const gb = limits.monthlyGb > 0 ? limits.monthlyGb : FAIR_USE_GB;
    subjects.push({ subject: `u:${user.id}`, gb, transfers: limits.monthlyTransfers });
  } else {
    const dev = await deviceSubject(request);
    setCookie = dev.setCookie;
    subjects.push({ subject: dev.subject, gb: limits.monthlyGb, transfers: limits.monthlyTransfers });
    subjects.push({
      subject: await ipSubject(request, env),
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

  for (const s of subjects) {
    const u = await readUsage(env, s.subject, p);
    if (s.transfers > 0 && u.transfers + 1 > s.transfers) {
      return { ok: false, setCookie, denial: { code: "monthly_transfers", message: `Você usou as ${limits.monthlyTransfers} transferências do mês no plano ${limits.name}.` } };
    }
    if (s.gb > 0 && u.bytes + bytes > s.gb * GB) {
      const left = Math.max(0, s.gb * GB - u.bytes);
      return { ok: false, setCookie, denial: { code: "monthly_bytes", message: `Restam ${fmtBytes(left)} no seu plano ${limits.name} este mês.` } };
    }
  }

  await env.DB.batch(
    subjects.map((s) =>
      env.DB.prepare(
        "INSERT INTO usage (subject, period, bytes, transfers) VALUES (?, ?, ?, 1) ON CONFLICT(subject, period) DO UPDATE SET bytes = bytes + excluded.bytes, transfers = transfers + 1",
      ).bind(s.subject, p, bytes),
    ),
  );
  return { ok: true, setCookie };
}

function fmtBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(n % GB === 0 ? 0 : 1).replace(".", ",")} GB`;
  return `${Math.round(n / 1024 / 1024)} MB`;
}
