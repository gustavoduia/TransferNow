export type PlanId = "free" | "starter" | "scale" | "pro";

export interface Plan {
  id: PlanId;
  name: string;
  /** GB por mês; -1 = ilimitado (com uso justo, ver FAIR_USE_GB). */
  monthlyGb: number;
  /** transferências por mês; -1 = ilimitado */
  monthlyTransfers: number;
  /** tamanho máximo por arquivo em GB; -1 = ilimitado */
  maxFileGb: number;
  /** horas que o arquivo fica na nuvem; 0 = sem modo nuvem */
  cloudHours: number;
  ads: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Gratuito", monthlyGb: 5, monthlyTransfers: 10, maxFileGb: 5, cloudHours: 0, ads: true },
  starter: { id: "starter", name: "Starter", monthlyGb: 50, monthlyTransfers: 100, maxFileGb: 10, cloudHours: 24, ads: false },
  scale: { id: "scale", name: "Scale", monthlyGb: 200, monthlyTransfers: 200, maxFileGb: 50, cloudHours: 72, ads: false },
  pro: { id: "pro", name: "Pró", monthlyGb: -1, monthlyTransfers: -1, maxFileGb: -1, cloudHours: 168, ads: false },
};

export const PAID_PLANS: PlanId[] = ["starter", "scale", "pro"];

/** Teto de uso justo do plano Pró, para o serviço não virar backup. */
export const FAIR_USE_GB = 2048;

/** Teto por IP para quem usa sem login (bem acima de um aparelho, por causa do CGNAT). */
export const FREE_IP_MULTIPLIER = 10;

export const GB = 1024 ** 3;

export interface UsageView {
  plan: PlanId;
  period: string;
  bytes: number;
  transfers: number;
  limits: Plan;
}

export function isPaid(plan: PlanId): boolean {
  return plan !== "free";
}
