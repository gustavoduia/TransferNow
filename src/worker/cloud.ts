import { isValidCode } from "../shared/code";
import { PLANS, type PlanId } from "../shared/plans";
import { logAccess } from "./accesslog";
import type { User } from "./auth";
import { cloudCodeInUse, p2pCodeInUse, randomCode } from "./codes";
import type { Env } from "./env";
import { error, json, readJson } from "./http";
import { log } from "./log";
import { activePlan, reserve } from "./quota";

const UPLOAD_WINDOW_MS = 48 * 60 * 60 * 1000;
const MIN_PART = 8 * 1024 * 1024;
const MAX_PART = 90 * 1024 * 1024; // abaixo do limite de 100 MB por requisição
const MAX_PARTS = 9000;

interface TransferRow {
  id: string;
  code: string;
  user_id: string;
  status: string;
  file_count: number;
  total_bytes: number;
  created_at: number;
  expires_at: number;
}

interface FileRow {
  idx: number;
  name: string;
  size: number;
  type: string;
  r2_key: string;
  upload_id: string | null;
  uploaded: number;
  downloaded_at: number | null;
}

/** Tamanho de parte fixo por arquivo (o R2 exige partes iguais, exceto a última). */
export function partSizeFor(size: number): number {
  const needed = Math.ceil(size / MAX_PARTS);
  const mb = 1024 * 1024;
  return Math.min(MAX_PART, Math.max(MIN_PART, Math.ceil(needed / mb) * mb));
}

export const MAX_CLOUD_FILE = MAX_PART * MAX_PARTS;

/** POST /api/cloud — cria a transferência e reserva a cota. */
export async function createCloud(request: Request, env: Env, ctx: ExecutionContext, user: User, plan: PlanId): Promise<Response> {
  const limits = PLANS[plan];
  if (limits.cloudHours <= 0) return error("plan_required", "O modo nuvem faz parte dos planos pagos.", 402);

  const body = await readJson<{ files?: { name?: string; size?: number; type?: string }[] }>(request);
  const files = (body?.files ?? []).slice(0, 500).map((f) => ({
    name: safeName(String(f.name ?? "arquivo")),
    size: Math.max(0, Math.floor(Number(f.size) || 0)),
    type: String(f.type || "application/octet-stream").slice(0, 120),
  }));
  if (files.length === 0) return error("bad_request", "Nenhum arquivo informado.");
  if (files.some((f) => f.size > MAX_CLOUD_FILE)) return error("file_too_large", "Arquivos acima de 790 GB só podem ir pelo modo direto.");

  const quota = await reserve(request, env, user, plan, files.map((f) => f.size));
  if (!quota.ok) return error(quota.denial.code, quota.denial.message, 403);

  let code = "";
  for (let i = 0; i < 6 && !code; i++) {
    const candidate = randomCode();
    if (!(await cloudCodeInUse(env, candidate)) && !(await p2pCodeInUse(env, candidate))) code = candidate;
  }
  if (!code) return error("try_again", "Não foi possível gerar um código agora. Tente de novo.", 503);

  const id = crypto.randomUUID();
  const now = Date.now();
  const total = files.reduce((s, f) => s + f.size, 0);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO cloud_transfers (id, code, user_id, status, file_count, total_bytes, created_at, expires_at) VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?)",
    ).bind(id, code, user.id, files.length, total, now, now + UPLOAD_WINDOW_MS),
    ...files.map((f, idx) =>
      env.DB.prepare("INSERT INTO cloud_files (transfer_id, idx, name, size, type, r2_key) VALUES (?, ?, ?, ?, ?, ?)").bind(
        id, idx, f.name, f.size, f.type, `t/${id}/${idx}`,
      ),
    ),
  ]);
  logAccess(env, ctx, request, "cloud_create", user.id, id);
  log("audit", "cloud_created", { transfer: id.slice(0, 8), files: files.length, bytes: total, plan });
  return json(
    { id, code, hours: limits.cloudHours, files: files.map((f, idx) => ({ idx, size: f.size, partSize: partSizeFor(f.size) })) },
    201,
    quota.setCookie ? { "Set-Cookie": quota.setCookie } : {},
  );
}

async function ownedTransfer(env: Env, id: string, user: User): Promise<TransferRow | null> {
  const t = await env.DB.prepare("SELECT * FROM cloud_transfers WHERE id = ?").bind(id).first<TransferRow>();
  return t && t.user_id === user.id ? t : null;
}

async function fileRow(env: Env, id: string, idx: number): Promise<FileRow | null> {
  return env.DB.prepare("SELECT * FROM cloud_files WHERE transfer_id = ? AND idx = ?").bind(id, idx).first<FileRow>();
}

/** Rotas de upload de quem envia: start, parts/:n, complete, finish, cancel. */
export async function uploadRoute(request: Request, env: Env, user: User, id: string, rest: string): Promise<Response> {
  const t = await ownedTransfer(env, id, user);
  if (!t) return error("not_found", "Transferência não encontrada.", 404);

  if (request.method === "DELETE" && rest === "") {
    await purge(env, t.id);
    await env.DB.prepare("UPDATE cloud_transfers SET status = 'cancelled', completed_at = ? WHERE id = ?").bind(Date.now(), t.id).run();
    return json({ ok: true });
  }
  if (t.status !== "uploading") return error("bad_state", "Esta transferência não está mais recebendo arquivos.", 409);

  if (request.method === "POST" && rest === "finish") {
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_files WHERE transfer_id = ? AND uploaded = 0").bind(t.id).first<{ n: number }>();
    if ((pending?.n ?? 1) > 0) return error("incomplete", "Ainda há arquivos subindo.", 409);
    const plan = await activePlan(env, user.id);
    const hours = Math.max(PLANS[plan].cloudHours, 24);
    const expiresAt = Date.now() + hours * 3600_000;
    await env.DB.prepare("UPDATE cloud_transfers SET status = 'ready', expires_at = ? WHERE id = ?").bind(expiresAt, t.id).run();
    log("audit", "cloud_ready", { transfer: t.id.slice(0, 8), hours });
    return json({ ok: true, code: t.code, expiresAt });
  }

  const m = rest.match(/^files\/(\d+)\/(start|complete|parts\/(\d+))$/);
  if (!m) return error("not_found", "Rota não encontrada.", 404);
  const f = await fileRow(env, t.id, Number(m[1]));
  if (!f) return error("not_found", "Arquivo não encontrado.", 404);

  if (m[2] === "start" && request.method === "POST") {
    const mp = await env.CLOUD.createMultipartUpload(f.r2_key, {
      httpMetadata: { contentType: f.type },
      customMetadata: { transfer: t.id },
    });
    await env.DB.prepare("UPDATE cloud_files SET upload_id = ? WHERE transfer_id = ? AND idx = ?").bind(mp.uploadId, t.id, f.idx).run();
    return json({ uploadId: mp.uploadId, partSize: partSizeFor(f.size) });
  }

  if (m[3] && request.method === "PUT") {
    if (!f.upload_id || !request.body) return error("bad_state", "Upload não iniciado.", 409);
    const partNumber = Number(m[3]);
    const partSize = partSizeFor(f.size);
    const len = Number(request.headers.get("Content-Length") ?? "-1");
    const expected = Math.min(partSize, f.size - (partNumber - 1) * partSize);
    if (partNumber < 1 || partNumber > MAX_PARTS || len !== expected) return error("bad_part", "Parte com tamanho inesperado.");
    const part = await env.CLOUD.resumeMultipartUpload(f.r2_key, f.upload_id).uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }

  if (m[2] === "complete" && request.method === "POST") {
    if (!f.upload_id) return error("bad_state", "Upload não iniciado.", 409);
    const body = await readJson<{ parts?: R2UploadedPart[] }>(request, 1024 * 1024);
    const parts = (body?.parts ?? []).map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }));
    const obj = await env.CLOUD.resumeMultipartUpload(f.r2_key, f.upload_id).complete(parts);
    if (obj.size !== f.size) {
      await env.CLOUD.delete(f.r2_key);
      return error("size_mismatch", "O arquivo chegou incompleto. Envie de novo.", 422);
    }
    await env.DB.prepare("UPDATE cloud_files SET uploaded = 1 WHERE transfer_id = ? AND idx = ?").bind(t.id, f.idx).run();
    return json({ ok: true });
  }

  return error("not_found", "Rota não encontrada.", 404);
}

async function readyTransferByCode(env: Env, code: string): Promise<TransferRow | null> {
  if (!isValidCode(code)) return null;
  const t = await env.DB.prepare("SELECT * FROM cloud_transfers WHERE code = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1")
    .bind(code)
    .first<TransferRow>();
  return t && t.expires_at > Date.now() ? t : null;
}

export async function isCloudCode(env: Env, code: string): Promise<boolean> {
  return !!(await readyTransferByCode(env, code));
}

/** GET /api/cloud/code/:code — o que tem para baixar. */
export async function describeByCode(request: Request, env: Env, ctx: ExecutionContext, code: string): Promise<Response> {
  const t = await readyTransferByCode(env, code);
  if (!t) return error("not_found", "Código não encontrado ou expirado.", 404);
  const { results } = await env.DB.prepare("SELECT idx, name, size, type, downloaded_at FROM cloud_files WHERE transfer_id = ? ORDER BY idx")
    .bind(t.id)
    .all<FileRow>();
  logAccess(env, ctx, request, "cloud_open", null, t.id);
  return json({
    kind: "cloud",
    expiresAt: t.expires_at,
    totalBytes: t.total_bytes,
    files: results.map((f) => ({ id: f.idx, name: f.name, size: f.size, type: f.type, downloaded: !!f.downloaded_at })),
  });
}

/** GET /api/cloud/code/:code/files/:idx — download único; o arquivo some quando termina. */
export async function downloadByCode(request: Request, env: Env, ctx: ExecutionContext, code: string, idx: number): Promise<Response> {
  const t = await readyTransferByCode(env, code);
  if (!t) return error("not_found", "Código não encontrado ou expirado.", 404);
  const f = await fileRow(env, t.id, idx);
  if (!f || !f.uploaded) return error("not_found", "Arquivo não encontrado.", 404);
  if (f.downloaded_at) return error("gone", "Este arquivo já foi baixado e foi apagado.", 410);

  const range = request.headers.get("Range");
  const obj = await env.CLOUD.get(f.r2_key, range ? { range: request.headers } : undefined);
  if (!obj || !("body" in obj)) return error("gone", "Este arquivo não está mais disponível.", 410);

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDisposition(f.name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  });
  logAccess(env, ctx, request, "cloud_download", null, `${t.id}:${idx}`);

  if (range && obj.range && "offset" in obj.range) {
    const start = obj.range.offset ?? 0;
    const length = obj.range.length ?? f.size - start;
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${f.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(f.size));
  let sent = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      if (sent >= f.size) ctx.waitUntil(markDownloaded(env, t, f));
    },
  });
  return new Response(obj.body.pipeThrough(counter), { headers });
}

async function markDownloaded(env: Env, t: TransferRow, f: FileRow): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("UPDATE cloud_files SET downloaded_at = ? WHERE transfer_id = ? AND idx = ? AND downloaded_at IS NULL")
    .bind(now, t.id, f.idx)
    .run();
  await env.CLOUD.delete(f.r2_key);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_files WHERE transfer_id = ? AND downloaded_at IS NULL")
    .bind(t.id)
    .first<{ n: number }>();
  if ((left?.n ?? 1) === 0) {
    await env.DB.prepare("UPDATE cloud_transfers SET status = 'done', completed_at = ? WHERE id = ?").bind(now, t.id).run();
    log("audit", "cloud_done", { transfer: t.id.slice(0, 8), bytes: t.total_bytes, waitMs: now - t.created_at });
  }
}

/** GET /api/cloud/mine — transferências ativas de quem está logado. */
export async function listMine(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, code, status, file_count, total_bytes, created_at, expires_at FROM cloud_transfers WHERE user_id = ? AND status IN ('uploading','ready') ORDER BY created_at DESC LIMIT 50",
  )
    .bind(user.id)
    .all();
  return json({ transfers: results });
}

/** Apaga os objetos de uma transferência e aborta uploads pela metade. */
export async function purge(env: Env, transferId: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT r2_key, upload_id, uploaded FROM cloud_files WHERE transfer_id = ?")
    .bind(transferId)
    .all<{ r2_key: string; upload_id: string | null; uploaded: number }>();
  for (const f of results) {
    if (f.upload_id && !f.uploaded) {
      await env.CLOUD.resumeMultipartUpload(f.r2_key, f.upload_id).abort().catch(() => {});
    }
  }
  const keys = results.map((f) => f.r2_key);
  if (keys.length) await env.CLOUD.delete(keys).catch(() => {});
}

/** Rotina agendada: expira transferências vencidas. */
export async function expireTransfers(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM cloud_transfers WHERE status IN ('uploading','ready') AND expires_at < ? LIMIT 200",
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const t of results) {
    await purge(env, t.id);
    await env.DB.prepare("UPDATE cloud_transfers SET status = 'expired', completed_at = ? WHERE id = ?").bind(Date.now(), t.id).run();
  }
  if (results.length) log("audit", "cloud_expired", { count: results.length });
  return results.length;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "arquivo";
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().slice(0, 200);
  return clean && clean !== "." && clean !== ".." ? clean : "arquivo";
}
