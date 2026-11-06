export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  JOIN_LIMITER?: RateLimiter;
  CREATE_LIMITER?: RateLimiter;
  ROOM_TTL_SECONDS?: string;
  MAX_FILE_SIZE_MB?: string;
  LOG_SALT?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}
