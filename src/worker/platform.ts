import { DEFAULT_ADS, PLANS, type AdsSettings, type Plan, type PlanId, type PlanMap } from "../shared/plans";
import type { Env } from "./env";

/** Dia no fuso de Brasília (UTC-3), formato AAAA-MM-DD. */
export function brDay(ts = Date.now()): string {
  return new Date(ts - 3 * 3600_000).toISOString().slice(0, 10);
}

let planCache: { at: number; plans: PlanMap } | null = null;
let adsCache: { at: number; ads: AdsSettings } | null = null;
const TTL = 30_000;

interface PlanRow {
  id: PlanId;
  name: string;
  monthly_gb: number;
  monthly_transfers: number;
  max_file_gb: number;
  cloud_hours: number;
  ads: number;
  price: number | null;
  for_sale: number;
  sort: number;
}

/** Planos vindos do banco (editáveis no painel), com cache curto por instância. */
export async function getPlans(env: Env): Promise<PlanMap> {
  if (planCache && Date.now() - planCache.at < TTL) return planCache.plans;
  const plans: PlanMap = structuredClone(PLANS);
  try {
    const { results } = await env.DB.prepare("SELECT * FROM plans").all<PlanRow>();
    for (const r of results) {
      if (!(r.id in plans)) continue;
      plans[r.id] = {
        id: r.id,
        name: r.name,
        monthlyGb: r.monthly_gb,
        monthlyTransfers: r.monthly_transfers,
        maxFileGb: r.max_file_gb,
        cloudHours: r.cloud_hours,
        ads: !!r.ads,
        price: r.price,
        forSale: !!r.for_sale,
        sort: r.sort,
      };
    }
  } catch {
    /* tabela ainda não migrada: usa os padrões */
  }
  // Compatibilidade: preço por variável de ambiente enquanto o painel não definir um.
  const envPrice: Partial<Record<PlanId, string | undefined>> = { starter: env.PRICE_STARTER, scale: env.PRICE_SCALE, pro: env.PRICE_PRO };
  for (const id of Object.keys(envPrice) as PlanId[]) {
    const n = Number(String(envPrice[id] ?? "").replace(",", "."));
    if (plans[id].price == null && Number.isFinite(n) && n > 0) plans[id].price = n;
  }
  planCache = { at: Date.now(), plans };
  return plans;
}

export function invalidatePlans() {
  planCache = null;
}

export async function getSetting<T>(env: Env, key: string): Promise<T | null> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}

export async function putSetting(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
  if (key === "ads") adsCache = null;
}

export async function getAds(env: Env): Promise<AdsSettings> {
  if (adsCache && Date.now() - adsCache.at < TTL) return adsCache.ads;
  const stored = await getSetting<Partial<AdsSettings>>(env, "ads");
  const ads: AdsSettings = { ...DEFAULT_ADS, rewardedUnit: env.ADS_REWARDED_UNIT || null, ...(stored ?? {}) };
  adsCache = { at: Date.now(), ads };
  return ads;
}

/** Erros e marcos do sistema para a tela de saúde do painel. */
export function systemEvent(env: Env, ctx: ExecutionContext | null, level: "info" | "warn" | "error", event: string, detail?: unknown) {
  const p = env.DB.prepare("INSERT INTO system_events (ts, level, event, detail) VALUES (?, ?, ?, ?)")
    .bind(Date.now(), level, event, detail == null ? null : String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1000))
    .run()
    .catch(() => {});
  if (ctx) ctx.waitUntil(p);
  return p;
}

export function planRank(plans: PlanMap, id: PlanId): number {
  return plans[id]?.sort ?? 0;
}

export type { Plan };
