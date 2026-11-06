// Logs estruturados em JSON → aparecem no Workers Logs (observability).
// Nunca registramos conteúdo nem nome de arquivos. IPs e códigos entram só como hash.

export type LogKind = "audit" | "app";

export function log(kind: LogKind, event: string, fields: Record<string, unknown> = {}): void {
  const line = { kind, event, ts: new Date().toISOString(), ...fields };
  if (kind === "app" && fields.level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

export async function shortHash(value: string, salt = "transfernow"): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
