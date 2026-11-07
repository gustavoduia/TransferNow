// Alfabeto legível no display de 14 segmentos: sem pares que se confundem
// (0/O/D/Q, 1/I/L, 2/Z, 5/S, 6/G, 8/B, X, V). 21 símbolos → 21^6 ≈ 85 milhões de códigos,
// com validade de 10 minutos, uso único e limite de tentativas por IP.
export const CODE_ALPHABET = "ACEFHJKMNPRTUWY234679";
export const CODE_LENGTH = 6;
export const CODE_REGEX = /^[ACEFHJKMNPRTUWY234679]{6}$/;

export function normalizeCode(raw: string): string {
  return [...raw.toUpperCase()]
    .filter((ch) => CODE_ALPHABET.includes(ch))
    .join("")
    .slice(0, CODE_LENGTH);
}

export function isValidCode(code: string): boolean {
  return CODE_REGEX.test(code);
}

/** Mensagens trocadas entre navegador e sala (WebSocket de sinalização). */
export type ClientToRoom =
  | { type: "signal"; data: unknown }
  | { type: "event"; name: AuditEventName; ref?: string; bytes?: number; files?: number; durationMs?: number; relay?: boolean; reason?: string }
  | { type: "ping" };

export type RoomToClient =
  | { type: "hello"; role: Role; expiresAt: number; senderPaid?: boolean }
  | { type: "peer-joined" }
  | { type: "peer-left" }
  | { type: "signal"; data: unknown }
  | { type: "error"; code: RoomErrorCode; message: string }
  | { type: "pong" };

export type Role = "sender" | "receiver";
export type RoomErrorCode = "not_found" | "expired" | "taken" | "rate_limited" | "bad_request";
export type AuditEventName = "transfer_start" | "transfer_done" | "transfer_error" | "transfer_rejected";
