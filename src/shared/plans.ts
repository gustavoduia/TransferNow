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
  /** preço mensal em reais; null = sem preço definido */
  price: number | null;
  /** preço anual em reais; null = sem opção anual */
  priceYearly: number | null;
  /** aparece para assinatura */
  forSale: boolean;
  sort: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Gratuito", monthlyGb: 5, monthlyTransfers: 10, maxFileGb: 5, cloudHours: 0, ads: true, price: null, priceYearly: null, forSale: false, sort: 0 },
  starter: { id: "starter", name: "Starter", monthlyGb: 50, monthlyTransfers: 100, maxFileGb: 10, cloudHours: 24, ads: false, price: null, priceYearly: null, forSale: true, sort: 1 },
  scale: { id: "scale", name: "Scale", monthlyGb: 200, monthlyTransfers: 200, maxFileGb: 50, cloudHours: 72, ads: false, price: null, priceYearly: null, forSale: true, sort: 2 },
  pro: { id: "pro", name: "Pró", monthlyGb: -1, monthlyTransfers: -1, maxFileGb: -1, cloudHours: 168, ads: false, price: null, priceYearly: null, forSale: true, sort: 3 },
};

export const PAID_PLANS: PlanId[] = ["starter", "scale", "pro"];

/** Teto de uso justo do plano Pró, para o serviço não virar backup. */
export const FAIR_USE_GB = 2048;

/** Teto por IP para quem usa sem login (bem acima de um aparelho, por causa do CGNAT). */
export const FREE_IP_MULTIPLIER = 10;

export const GB = 1024 ** 3;

export type PlanMap = Record<PlanId, Plan>;

export interface AdsSettings {
  /** liga/desliga os vídeos no plano gratuito */
  enabled: boolean;
  /** caminho do bloco rewarded no Google Ad Manager */
  rewardedUnit: string | null;
  onSend: boolean;
  onReceive: boolean;
  /** mostra o vídeo a cada N transferências (1 = todas) */
  everyN: number;
  /** eCPM estimado em reais, só para estimar receita no painel */
  ecpmBrl: number | null;
}

export const DEFAULT_ADS: AdsSettings = {
  enabled: true,
  rewardedUnit: null,
  onSend: true,
  onReceive: true,
  everyN: 1,
  ecpmBrl: null,
};

export const AD_OUTCOMES = ["shown", "granted", "unavailable", "aborted", "closed_early"] as const;
export type AdOutcome = (typeof AD_OUTCOMES)[number];

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
