import type { Plan, PlanId, UsageView } from "../shared/plans";

export interface PublicConfig {
  roomTtlSeconds: number;
  plans: Record<PlanId, Plan>;
  prices: Record<Exclude<PlanId, "free">, number | null>;
  ads: { rewardedUnit: string | null; onReceive: boolean; everyN: number };
  login: { email: boolean; google: boolean };
  billing: boolean;
}

export interface Me {
  user: { email: string; name: string | null; admin: boolean } | null;
  plan: PlanId;
  usage: UsageView;
  subscription: { plan: PlanId; status: string; amount: number | null; next_payment_date: number | null } | null;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: init.body && typeof init.body === "string" ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init.headers,
    });
  } catch {
    throw new ApiError("network", "Sem conexão com o servidor. Verifique sua internet.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(String(data.error ?? res.status), String(data.message ?? "Algo deu errado. Tente de novo."), res.status, data);
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

const fallbackConfig: PublicConfig = {
  roomTtlSeconds: 600,
  plans: {} as PublicConfig["plans"],
  prices: { starter: null, scale: null, pro: null },
  ads: { rewardedUnit: null, onReceive: false, everyN: 1 },
  login: { email: false, google: false },
  billing: false,
};

export async function fetchConfig(): Promise<PublicConfig> {
  try {
    return await api<PublicConfig>("/api/config");
  } catch {
    return fallbackConfig;
  }
}

export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>("/api/me");
  } catch {
    return null;
  }
}
