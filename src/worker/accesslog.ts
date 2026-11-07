import type { Env } from "./env";
import { clientIp } from "./http";

/**
 * Registro de acesso exigido pelo art. 15 do Marco Civil da Internet:
 * IP, data e hora do uso da aplicação, guardados em sigilo por 6 meses.
 * Nada sobre o conteúdo ou o nome dos arquivos entra aqui.
 */
export function logAccess(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  event: string,
  userId?: string | null,
  ref?: string,
): void {
  ctx.waitUntil(
    env.DB.prepare("INSERT INTO access_log (ts, ip, port, event, user_id, ref) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(Date.now(), clientIp(request), request.headers.get("CF-Connecting-Port"), event, userId ?? null, ref ?? null)
      .run()
      .catch(() => {}),
  );
}

export const ACCESS_LOG_RETENTION_MS = 183 * 24 * 60 * 60 * 1000;
