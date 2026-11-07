import { CODE_ALPHABET, CODE_LENGTH } from "../shared/code";
import type { Env } from "./env";

export function randomCode(): string {
  // Amostragem por rejeição: distribuição uniforme no alfabeto.
  const out: string[] = [];
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < CODE_LENGTH) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
    }
  }
  return out.join("");
}

/** Código ativo na nuvem? (os códigos P2P vivem nos Durable Objects) */
export async function cloudCodeInUse(env: Env, code: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM cloud_transfers WHERE code = ? AND status IN ('uploading','ready') LIMIT 1")
    .bind(code)
    .first();
  return !!row;
}

export async function p2pCodeInUse(env: Env, code: string): Promise<boolean> {
  const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch("https://room/status");
  return res.ok && ((await res.json()) as { active: boolean }).active;
}
