export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  DB: D1Database;
  CLOUD: R2Bucket;
  EMAIL?: SendEmail;
  JOIN_LIMITER?: RateLimiter;
  CREATE_LIMITER?: RateLimiter;
  AUTH_LIMITER?: RateLimiter;

  ROOM_TTL_SECONDS?: string;
  /** Limite extra por arquivo no plano gratuito, em MB. -1 = usa o limite do plano. */
  MAX_FILE_SIZE_MB?: string;
  LOG_SALT?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;

  EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  MP_ACCESS_TOKEN?: string;
  MP_WEBHOOK_SECRET?: string;
  PRICE_STARTER?: string;
  PRICE_SCALE?: string;
  PRICE_PRO?: string;

  /** Caminho do bloco rewarded no Google Ad Manager, ex.: /1234567/transfernow_rewarded */
  ADS_REWARDED_UNIT?: string;
}
