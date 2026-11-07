import "./admin.css";
import { api, ApiError, post } from "../api";
import { formatBytes } from "../ui/effects";
import { barChart, rankBars, type BarDatum } from "./charts";

// ───────────────────────────── utilidades ─────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const main = () => $("#main");

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const int = new Intl.NumberFormat("pt-BR");
const dtf = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const df = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

const money = (n: number | null | undefined) => (n == null ? "—" : brl.format(n));
const num = (n: number | null | undefined) => (n == null ? "—" : int.format(n));
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1).replace(".", ",")}%`);
const bytes = (n: number | null | undefined) => (n == null ? "—" : n === 0 ? "0 B" : formatBytes(n));
const gb = (n: number) => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: n < 10 ? 1 : 0 }).format(n)} GB`;
const when = (ts: number | null | undefined) => (ts ? dtf.format(ts) : "—");
const day = (ts: number | null | undefined) => (ts ? df.format(ts) : "—");
const e = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function html(markup: string): DocumentFragment {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content;
}

function toast(message: string, kind: "ok" | "err" = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("is-on");
  window.clearTimeout(Number(el.dataset.t));
  el.dataset.t = String(window.setTimeout(() => el.classList.remove("is-on"), 4200));
}

function fail(err: unknown) {
  toast(err instanceof ApiError ? err.message : "Algo deu errado. Tente de novo.", "err");
}

interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "select" | "textarea";
  options?: [string, string][];
  value?: string;
  required?: boolean;
  hint?: string;
}

/** Confirmação com campos (motivo, dias, plano...). Devolve os valores ou null. */
function ask(opts: { title: string; message?: string; fields?: Field[]; confirm?: string; danger?: boolean }): Promise<Record<string, string> | null> {
  const dlg = $<HTMLDialogElement>("#modal");
  $("#modal-title").textContent = opts.title;
  $("#modal-msg").textContent = opts.message ?? "";
  const ok = $<HTMLButtonElement>("#modal-ok");
  ok.textContent = opts.confirm ?? "Confirmar";
  ok.className = `btn ${opts.danger ? "btn--danger" : "btn--primary"}`;
  const box = $("#modal-fields");
  box.replaceChildren();
  for (const f of opts.fields ?? []) {
    const id = `f-${f.name}`;
    let input: string;
    if (f.type === "select") input = `<select id="${id}" name="${f.name}">${(f.options ?? []).map(([v, l]) => `<option value="${e(v)}"${v === f.value ? " selected" : ""}>${e(l)}</option>`).join("")}</select>`;
    else if (f.type === "textarea") input = `<textarea id="${id}" name="${f.name}" rows="4"${f.required ? " required" : ""}>${e(f.value ?? "")}</textarea>`;
    else input = `<input id="${id}" name="${f.name}" type="${f.type ?? "text"}" value="${e(f.value ?? "")}"${f.required ? " required" : ""} />`;
    box.append(html(`<div class="field"><label for="${id}">${e(f.label)}</label>${input}${f.hint ? `<small>${e(f.hint)}</small>` : ""}</div>`));
  }
  dlg.showModal();
  (box.querySelector("input,select,textarea") as HTMLElement | null)?.focus();
  return new Promise((resolve) => {
    dlg.addEventListener(
      "close",
      () => {
        if (dlg.returnValue !== "ok") return resolve(null);
        const out: Record<string, string> = {};
        box.querySelectorAll<HTMLInputElement>("[name]").forEach((i) => (out[i.name] = i.value));
        resolve(out);
      },
      { once: true },
    );
  });
}

function delta(cur: number, prev: number, fmt: (n: number) => string = num) {
  if (!prev && !cur) return "";
  if (!prev) return `<span class="delta delta--up">▲ novo no período</span>`;
  const d = (cur - prev) / prev;
  const cls = d >= 0 ? "delta--up" : "delta--down";
  return `<span class="delta ${cls}">${d >= 0 ? "▲" : "▼"} ${pct(Math.abs(d))} <span class="muted">vs. ${fmt(prev)}</span></span>`;
}

function tile(label: string, value: string, sub = "") {
  return `<div class="tile"><span class="tile__label">${e(label)}</span><span class="tile__value">${value}</span>${sub ? `<span class="tile__sub">${sub}</span>` : ""}</div>`;
}

function status(ok: boolean, yes: string, no: string) {
  return ok ? `<span class="st st--good">✓ ${e(yes)}</span>` : `<span class="st st--bad">✕ ${e(no)}</span>`;
}

const PLAN_NAMES: Record<string, string> = { free: "Gratuito", starter: "Starter", scale: "Scale", pro: "Pró" };
const SUB_STATUS: Record<string, string> = { authorized: "Ativa", pending: "Pendente", paused: "Pausada", cancelled: "Cancelada" };
const PAY_STATUS: Record<string, string> = { approved: "Aprovada", pending: "Pendente", rejected: "Recusada", refunded: "Estornada", cancelled: "Cancelada", in_process: "Em análise", charged_back: "Contestada" };
const TRANSFER_STATUS: Record<string, string> = {
  started: "Em andamento", done: "Concluída", failed: "Falhou", rejected: "Recusada", abandoned: "Abandonada",
  uploading: "Subindo", ready: "Aguardando download", expired: "Expirou", removed: "Removida", cancelled: "Cancelada",
};
const USER_STATUS: Record<string, string> = { active: "Ativa", blocked: "Bloqueada", banned: "Banida" };

function pager(total: number, page: number, size: number, go: (p: number) => void): HTMLElement {
  const pages = Math.max(1, Math.ceil(total / size));
  const nav = html(`<nav class="pager"><button class="btn btn--sm" ${page <= 0 ? "disabled" : ""}>Anterior</button><span>Página ${page + 1} de ${pages} · ${num(total)} no total</span><button class="btn btn--sm" ${page + 1 >= pages ? "disabled" : ""}>Próxima</button></nav>`).firstElementChild as HTMLElement;
  const [prev, next] = nav.querySelectorAll("button");
  prev.addEventListener("click", () => go(page - 1));
  next.addEventListener("click", () => go(page + 1));
  return nav;
}

function getDays(): number {
  try {
    return Number(localStorage.getItem("tn_admin_days")) || 30;
  } catch {
    return 30;
  }
}

function periodPicker(onChange: () => void): string {
  const cur = getDays();
  queueMicrotask(() => {
    document.querySelectorAll<HTMLButtonElement>("[data-days]").forEach((b) =>
      b.addEventListener("click", () => {
        try {
          localStorage.setItem("tn_admin_days", b.dataset.days!);
        } catch {
          /* ok */
        }
        onChange();
      }),
    );
  });
  return `<div class="seg" role="group" aria-label="Período">${[7, 30, 90, 365]
    .map((d) => `<button type="button" data-days="${d}" aria-pressed="${d === cur}">${d === 365 ? "12 meses" : `${d} dias`}</button>`)
    .join("")}</div>`;
}

function header(title: string, lead = "", extra = "") {
  return `<header class="page-head"><div><h1>${e(title)}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}</div>${extra}</header>`;
}

function loading() {
  main().innerHTML = `<div class="loading" aria-busy="true">Carregando…</div>`;
}

// ───────────────────────────── visão geral (BI) ─────────────────────────────

interface Overview {
  days: number;
  kpis: Record<string, number | null>;
  series: { day: string; p2p: number; cloud: number; bytes: number; newUsers: number }[];
  subscribersByPlan: { plan: string; n: number; mrr: number }[];
  countries: { country: string; n: number; bytes: number }[];
  tiers: { tier: string; n: number; bytes: number }[];
}

const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const fullDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const regionName = new Intl.DisplayNames(["pt-BR"], { type: "region" });
const country = (c: string) => {
  try {
    return c === "??" ? "Desconhecido" : regionName.of(c) ?? c;
  } catch {
    return c;
  }
};

async function renderOverview() {
  loading();
  const d = await api<Overview>(`/api/admin/overview?days=${getDays()}`);
  const k = d.kpis as Record<string, number>;
  const m = main();
  m.innerHTML =
    header("Visão geral", `Últimos ${d.days === 365 ? "12 meses" : `${d.days} dias`}, comparado ao período anterior.`, periodPicker(renderOverview)) +
    `<section class="tiles">
      ${tile("Volume transferido", bytes(k.bytes), delta(k.bytes, k.bytesPrev, bytes))}
      ${tile("Transferências concluídas", num(k.transfers), delta(k.transfers, k.transfersPrev))}
      ${tile("Receita no período", money(k.revenue), delta(k.revenue, k.revenuePrev, money))}
      ${tile("Receita recorrente (MRR)", money(k.mrr), `${num(k.subscribers)} assinantes${k.grants ? ` · ${num(k.grants)} cortesias` : ""}`)}
      ${tile("Contas cadastradas", num(k.usersTotal), `${num(k.usersNew)} novas ${delta(k.usersNew, k.usersNewPrev)}`)}
      ${tile("Quem enviou no período", num(k.activeSenders), "contas e aparelhos distintos")}
      ${tile("Sucesso do P2P", pct(k.p2pSuccessRate), `Via retransmissor: ${pct(k.relayShare)}`)}
      ${tile("Guardado na nuvem agora", bytes(k.cloudStoredBytes), `${num(k.cloudStoredTransfers)} transferências aguardando`)}
    </section>
    <section class="grid2" id="charts"></section>
    <p class="muted small">As transferências passaram a ser medidas em 07/11/2026. Volume no P2P é o tamanho informado pelo navegador de quem envia; na nuvem, o medido no servidor.</p>`;

  const grid = $("#charts", m);
  const every = Math.ceil(d.series.length / 8);
  const rows: BarDatum[] = d.series.map((s) => ({ label: shortDay(s.day), full: fullDay(s.day), values: [s.p2p, s.cloud] }));
  grid.append(
    barChart(rows, { title: "Transferências por dia", series: ["Direto (P2P)", "Nuvem"], format: (n) => num(Math.round(n)), labelEvery: every, integer: true }),
    barChart(
      d.series.map((s) => ({ label: shortDay(s.day), full: fullDay(s.day), values: [s.bytes / 1024 ** 3] })),
      { title: "Volume por dia", series: ["Volume"], format: gb, labelEvery: every },
    ),
    barChart(
      d.series.map((s) => ({ label: shortDay(s.day), full: fullDay(s.day), values: [s.newUsers] })),
      { title: "Novas contas por dia", series: ["Contas"], format: (n) => num(Math.round(n)), labelEvery: every, integer: true },
    ),
    rankBars(
      ["starter", "scale", "pro"].map((p) => {
        const r = d.subscribersByPlan.find((x) => x.plan === p);
        return { label: PLAN_NAMES[p], value: r?.n ?? 0, note: money(r?.mrr ?? 0) + "/mês" };
      }),
      { title: "Assinantes por plano", format: num },
    ),
    rankBars(
      d.countries.map((c) => ({ label: country(c.country), value: c.n, note: bytes(c.bytes) })),
      { title: "Transferências por país", format: num },
    ),
    rankBars(
      d.tiers.map((t) => ({ label: t.tier === "free" ? "Gratuito" : "Planos pagos", value: t.bytes, note: `${num(t.n)} transferências` })),
      { title: "Volume: gratuito x pago", format: bytes },
    ),
  );
}

// ───────────────────────────── usuários ─────────────────────────────

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  created_at: number;
  last_seen_at: number | null;
  sub_plan: string | null;
  sub_status: string | null;
  grant_plan: string | null;
  month_bytes: number | null;
  month_transfers: number | null;
}

const userFilters = { q: "", status: "", tier: "", page: 0 };

async function renderUsers() {
  const m = main();
  if (!m.querySelector("#user-filters")) {
    m.innerHTML =
      header("Usuários", "Contas criadas para assinar. Quem usa o gratuito sem login aparece só nos números agregados e em Suporte.") +
      `<form class="filters" id="user-filters">
        <input type="search" name="q" placeholder="Buscar por e-mail ou nome" value="${e(userFilters.q)}" aria-label="Buscar" />
        <select name="status" aria-label="Situação">
          <option value="">Todas as situações</option><option value="active">Ativas</option><option value="blocked">Bloqueadas</option><option value="banned">Banidas</option><option value="admin">Administradores</option>
        </select>
        <select name="tier" aria-label="Plano">
          <option value="">Todos os planos</option><option value="paid">Assinantes</option><option value="grant">Com cortesia</option><option value="free">Gratuito</option>
        </select>
        <button class="btn" type="submit">Filtrar</button>
      </form>
      <div id="user-list"></div>`;
    const form = $<HTMLFormElement>("#user-filters", m);
    (form.elements.namedItem("status") as HTMLSelectElement).value = userFilters.status;
    (form.elements.namedItem("tier") as HTMLSelectElement).value = userFilters.tier;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      Object.assign(userFilters, { q: String(f.get("q") ?? ""), status: String(f.get("status") ?? ""), tier: String(f.get("tier") ?? ""), page: 0 });
      void renderUsers();
    });
  }
  const list = $("#user-list", m);
  list.innerHTML = `<div class="loading">Carregando…</div>`;
  const qs = new URLSearchParams({ q: userFilters.q, status: userFilters.status, tier: userFilters.tier, page: String(userFilters.page) });
  const d = await api<{ users: UserRow[]; total: number; page: number; pageSize: number }>(`/api/admin/users?${qs}`);
  if (d.users.length === 0) {
    list.innerHTML = `<p class="empty">Nenhuma conta encontrada com esses filtros.</p>`;
    return;
  }
  list.innerHTML = `<div class="table-wrap"><table class="table table--click"><thead><tr>
    <th>E-mail</th><th>Plano</th><th>Situação</th><th class="num">Uso no mês</th><th>Cadastro</th><th>Último acesso</th></tr></thead><tbody>${d.users
      .map((u) => {
        const plan = u.sub_plan ? PLAN_NAMES[u.sub_plan] : u.grant_plan ? `${PLAN_NAMES[u.grant_plan]} (cortesia)` : "Gratuito";
        return `<tr data-id="${u.id}" tabindex="0"><td><strong>${e(u.email)}</strong>${u.role === "admin" ? ` <span class="badge">admin</span>` : ""}${u.name ? `<br><span class="muted">${e(u.name)}</span>` : ""}</td>
        <td>${e(plan)}</td><td>${badgeStatus(u.status)}</td>
        <td class="num">${bytes(u.month_bytes ?? 0)}<br><span class="muted">${num(u.month_transfers ?? 0)} transf.</span></td>
        <td>${day(u.created_at)}</td><td>${when(u.last_seen_at)}</td></tr>`;
      })
      .join("")}</tbody></table></div>`;
  list.querySelectorAll<HTMLTableRowElement>("tr[data-id]").forEach((tr) => {
    const open = () => (location.hash = `#/usuarios/${tr.dataset.id}`);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (ev) => ev.key === "Enter" && open());
  });
  list.append(pager(d.total, d.page, d.pageSize, (p) => {
    userFilters.page = p;
    void renderUsers();
  }));
}

function badgeStatus(s: string) {
  const cls = s === "active" ? "st--good" : "st--bad";
  return `<span class="st ${cls}">${s === "active" ? "✓" : "✕"} ${e(USER_STATUS[s] ?? s)}</span>`;
}

interface UserDetail {
  user: Record<string, any>;
  admin: boolean;
  plan: string;
  limits: { monthlyGb: number; monthlyTransfers: number };
  usage: { bytes: number; transfers: number };
  sessions: number;
  subscriptions: Record<string, any>[];
  payments: Record<string, any>[];
  grants: Record<string, any>[];
  transfers: Record<string, any>[];
  cloud: Record<string, any>[];
  notes: Record<string, any>[];
}

async function renderUser(id: string) {
  loading();
  const d = await api<UserDetail>(`/api/admin/users/${id}`);
  const u = d.user;
  const now = Date.now();
  const activeSub = d.subscriptions.some((s) => s.status === "authorized" || s.status === "paused");
  const m = main();
  m.innerHTML = `<a class="back" href="#/usuarios">← Usuários</a>` +
    header(u.email, `${PLAN_NAMES[d.plan]} · ${badgeStatus(u.status)}${d.admin ? ` <span class="badge">admin</span>` : ""}${u.status_reason ? ` · <span class="muted">Motivo: ${e(u.status_reason)}</span>` : ""}`) +
    `<div class="actions" id="actions">
      <button class="btn btn--primary" data-act="grant">Conceder cortesia</button>
      <button class="btn" data-act="reset_usage">Zerar uso do mês</button>
      <button class="btn" data-act="sync_billing">Sincronizar cobrança</button>
      ${activeSub ? `<button class="btn" data-act="cancel_subscription">Cancelar assinatura</button>` : ""}
      <button class="btn" data-act="logout_all">Encerrar sessões (${num(d.sessions)})</button>
      ${u.status === "active" ? `<button class="btn btn--warn" data-act="block">Bloquear</button><button class="btn btn--danger" data-act="ban">Banir</button>` : `<button class="btn" data-act="unblock">Reativar conta</button>`}
      ${u.role === "admin" ? `<button class="btn" data-act="remove_admin">Remover de administrador</button>` : `<button class="btn" data-act="make_admin">Tornar administrador</button>`}
      <button class="btn btn--danger btn--ghost" data-act="delete">Excluir conta (LGPD)</button>
    </div>
    <section class="tiles tiles--4">
      ${tile("Volume no mês", bytes(d.usage.bytes), d.limits.monthlyGb > 0 ? `de ${num(d.limits.monthlyGb)} GB` : "ilimitado")}
      ${tile("Transferências no mês", num(d.usage.transfers), d.limits.monthlyTransfers > 0 ? `de ${num(d.limits.monthlyTransfers)}` : "ilimitadas")}
      ${tile("Cadastro", day(u.created_at), u.google_sub ? "entrou com Google" : "entrou por e-mail")}
      ${tile("Último acesso", when(u.last_seen_at), u.marketing_opt_out ? "não recebe campanhas" : "recebe campanhas")}
    </section>
    <section class="panel"><h2>Assinaturas</h2>${table(d.subscriptions, [
      ["Plano", (s) => PLAN_NAMES[s.plan] ?? s.plan],
      ["Situação", (s) => SUB_STATUS[s.status] ?? s.status],
      ["Valor", (s) => money(s.amount)],
      ["Próxima cobrança / fim", (s) => day(s.next_payment_date)],
      ["Criada", (s) => day(s.created_at)],
      ["ID no Mercado Pago", (s) => `<code>${e(s.id)}</code>`],
    ], "Nenhuma assinatura.")}</section>
    <section class="panel"><h2>Cobranças</h2>${table(d.payments, [
      ["Data", (p) => when(p.paid_at ?? p.created_at)],
      ["Valor", (p) => money(p.amount)],
      ["Situação", (p) => PAY_STATUS[p.status] ?? p.status],
      ["Plano", (p) => PLAN_NAMES[p.plan] ?? "—"],
    ], "Nenhuma cobrança registrada.")}</section>
    <section class="panel"><h2>Cortesias</h2>${table(d.grants, [
      ["Plano", (g) => PLAN_NAMES[g.plan]],
      ["Período", (g) => `${day(g.starts_at)} a ${day(g.ends_at)}`],
      ["Situação", (g) => (g.revoked_at ? "Revogada" : g.ends_at > now ? "Vigente" : "Encerrada")],
      ["Motivo", (g) => e(g.reason ?? "—")],
      ["Por", (g) => e(g.granted_by)],
      ["", (g) => (!g.revoked_at && g.ends_at > now ? `<button class="btn btn--sm" data-revoke="${g.id}">Revogar</button>` : "")],
    ], "Nenhuma cortesia.")}</section>
    <section class="panel"><h2>Transferências recentes</h2>${table(d.transfers, [
      ["Quando", (t) => when(t.ts)],
      ["Tipo", (t) => (t.kind === "p2p" ? "Direto" : "Nuvem")],
      ["Volume", (t) => bytes(t.bytes)],
      ["Arquivos", (t) => num(t.files)],
      ["Situação", (t) => TRANSFER_STATUS[t.status] ?? t.status],
      ["País", (t) => e(t.country ?? "—")],
    ], "Nenhuma transferência.")}</section>
    <section class="panel"><h2>Na nuvem</h2>${table(d.cloud, [
      ["Código", (t) => `<code>${e(t.code)}</code>`],
      ["Situação", (t) => TRANSFER_STATUS[t.status] ?? t.status],
      ["Volume", (t) => bytes(t.total_bytes)],
      ["Criada", (t) => when(t.created_at)],
      ["Expira", (t) => when(t.expires_at)],
    ], "Nada enviado pela nuvem.")}</section>
    <section class="panel"><h2>Anotações do suporte</h2>
      <form class="note-form" id="note-form"><textarea name="body" rows="3" placeholder="O que aconteceu, o que foi combinado com a pessoa…" required></textarea><button class="btn btn--primary" type="submit">Salvar anotação</button></form>
      <ul class="notes">${d.notes.map((n) => `<li><p>${e(n.body).replace(/\n/g, "<br>")}</p><span class="muted small">${e(n.author)} · ${when(n.created_at)}</span></li>`).join("") || `<li class="muted">Sem anotações.</li>`}</ul>
    </section>`;

  const act = async (action: string, body: Record<string, unknown> = {}, okMsg = "Feito.") => {
    try {
      await post(`/api/admin/users/${id}/action`, { action, ...body });
      toast(okMsg);
      if (action === "delete") location.hash = "#/usuarios";
      else void renderUser(id);
    } catch (err) {
      fail(err);
    }
  };

  $("#actions", m).addEventListener("click", async (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
    if (!btn) return;
    const a = btn.dataset.act!;
    const reason: Field = { name: "reason", label: "Motivo (fica na auditoria)", type: "textarea" };
    if (a === "grant") {
      const v = await ask({
        title: "Conceder cortesia",
        message: "A pessoa usa o plano escolhido de graça pelo período. Útil para compensar um problema ou para parcerias.",
        fields: [
          { name: "plan", label: "Plano", type: "select", options: [["starter", "Starter"], ["scale", "Scale"], ["pro", "Pró"]], value: "pro" },
          { name: "days", label: "Dias", type: "number", value: "30", required: true },
          reason,
        ],
        confirm: "Conceder",
      });
      if (v) await act("grant", { plan: v.plan, days: Number(v.days), reason: v.reason }, "Cortesia concedida.");
      return;
    }
    const confirmations: Record<string, { title: string; message: string; confirm: string; danger?: boolean; withReason?: boolean }> = {
      reset_usage: { title: "Zerar o uso deste mês?", message: "Volume e número de transferências do mês voltam a zero.", confirm: "Zerar", withReason: true },
      sync_billing: { title: "Sincronizar com o Mercado Pago?", message: "Busca a situação atual das assinaturas e cobranças desta conta.", confirm: "Sincronizar" },
      cancel_subscription: { title: "Cancelar a assinatura?", message: "A renovação é cancelada no Mercado Pago. O plano vale até o fim do período já pago.", confirm: "Cancelar assinatura", danger: true, withReason: true },
      logout_all: { title: "Encerrar todas as sessões?", message: "A pessoa precisará entrar de novo em todos os aparelhos.", confirm: "Encerrar" },
      block: { title: "Bloquear esta conta?", message: "A pessoa sai de todos os aparelhos e não consegue entrar até você reativar. Assinaturas não são canceladas.", confirm: "Bloquear", danger: true, withReason: true },
      ban: { title: "Banir esta conta?", message: "Bloqueia a conta e o e-mail: não dá para criar outra conta com ele. Cancele a assinatura antes, se houver.", confirm: "Banir", danger: true, withReason: true },
      unblock: { title: "Reativar esta conta?", message: "A pessoa volta a poder entrar. O banimento do e-mail também é removido.", confirm: "Reativar" },
      make_admin: { title: "Tornar administrador?", message: "A pessoa terá acesso total a este painel.", confirm: "Tornar administrador", danger: true },
      remove_admin: { title: "Remover de administrador?", message: "A pessoa perde o acesso ao painel. E-mails listados em ADMIN_EMAILS continuam com acesso.", confirm: "Remover" },
      delete: { title: "Excluir a conta?", message: "Apaga a conta, as sessões e os arquivos na nuvem, e cancela a assinatura. Cobranças e registros de acesso exigidos por lei são mantidos. Não dá para desfazer.", confirm: "Excluir para sempre", danger: true, withReason: true },
    };
    const c = confirmations[a];
    if (!c) return;
    const v = await ask({ title: c.title, message: c.message, confirm: c.confirm, danger: c.danger, fields: c.withReason ? [reason] : [] });
    if (v) await act(a, { reason: v.reason });
  });
  m.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (await ask({ title: "Revogar a cortesia?", message: "O plano volta a ser o da assinatura, ou o gratuito.", confirm: "Revogar", danger: true }))
        await act("revoke_grant", { grantId: b.dataset.revoke }, "Cortesia revogada.");
    }),
  );
  $<HTMLFormElement>("#note-form", m).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = String(new FormData(ev.target as HTMLFormElement).get("body") ?? "");
    await act("note", { body }, "Anotação salva.");
  });
}

function table<T>(rows: T[], cols: [string, (r: T) => string][], empty: string): string {
  if (!rows.length) return `<p class="empty">${e(empty)}</p>`;
  return `<div class="table-wrap"><table class="table"><thead><tr>${cols.map(([h]) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cols.map(([, f]) => `<td>${f(r)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

// ───────────────────────────── financeiro ─────────────────────────────

interface Finance {
  counts: Record<string, number>;
  mrr: number;
  arpu: number;
  revenueMonth: number;
  paymentsMonth: number;
  revenuePrevMonth: number;
  rejectedMonth: number;
  churnMonth: number | null;
  abandoned: number;
  months: { month: string; revenue: number; payments: number }[];
  billingConfigured: boolean;
}

let finTab = "active";
let payStatus = "";
let finPage = 0;

async function renderFinance() {
  loading();
  const d = await api<Finance>("/api/admin/finance");
  const m = main();
  const monthName = (mm: string) => new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(new Date(`${mm}-15T12:00:00Z`));
  m.innerHTML =
    header("Financeiro", "Assinaturas e cobranças do Mercado Pago.", `<button class="btn" id="btn-sync">Sincronizar com o Mercado Pago</button>`) +
    (d.billingConfigured ? "" : `<p class="notice">O Mercado Pago ainda não está configurado (segredo <code>MP_ACCESS_TOKEN</code>). Os números abaixo ficam zerados até as primeiras assinaturas.</p>`) +
    `<section class="tiles">
      ${tile("Receita recorrente (MRR)", money(d.mrr), `Ticket médio ${money(d.arpu)}`)}
      ${tile("Receita do mês", money(d.revenueMonth), `${num(d.paymentsMonth)} cobranças ${delta(d.revenueMonth, d.revenuePrevMonth, money)}`)}
      ${tile("Assinaturas ativas", num(d.counts.active), `${num(d.counts.cancelling)} cancelaram e ainda estão no período`)}
      ${tile("Cancelamento no mês", pct(d.churnMonth), `${num(d.counts.expired)} expiradas no total`)}
      ${tile("Checkout abandonado", num(d.abandoned), "começaram a assinar há mais de 1 dia e não pagaram")}
      ${tile("Cobranças recusadas no mês", num(d.rejectedMonth), "cartão recusado ou sem saldo")}
    </section>
    <section class="grid2"><div id="rev-chart"></div><div id="rev-side" class="panel"></div></section>
    <section class="panel">
      <div class="tabs" role="tablist">
        ${[["active", "Ativas"], ["cancelling", "Cancelando"], ["expired", "Expiradas"], ["pending", "Pendentes"], ["payments", "Transações"]]
          .map(([k, l]) => `<button role="tab" aria-selected="${finTab === k}" data-tab="${k}">${l}${k !== "payments" ? ` <span class="muted">${num(d.counts[k] ?? 0)}</span>` : ""}</button>`)
          .join("")}
      </div>
      <div id="fin-body"></div>
    </section>`;
  $("#rev-chart", m).append(
    barChart(d.months.map((x) => ({ label: monthName(x.month), full: monthName(x.month), values: [x.revenue] })), { title: "Receita por mês", series: ["Receita"], format: (n) => money(n), labelEvery: 2 }),
  );
  const sum12 = d.months.reduce((s, x) => s + x.revenue, 0);
  $("#rev-side", m).innerHTML = `<h2>Últimos 12 meses</h2><p class="big">${money(sum12)}</p><p class="muted">${num(d.months.reduce((s, x) => s + x.payments, 0))} cobranças aprovadas.</p><p class="muted small">Receita bruta, antes das taxas do Mercado Pago.</p>`;
  m.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      finTab = b.dataset.tab!;
      finPage = 0;
      m.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      void renderFinTab();
    }),
  );
  $("#btn-sync", m).addEventListener("click", async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    let offset: number | null = 0;
    let total = 0;
    try {
      while (offset != null) {
        btn.textContent = `Sincronizando… ${total}`;
        const r: { processed: number; next: number | null } = await post(`/api/admin/billing/sync?offset=${offset}`);
        total += r.processed;
        offset = r.next;
      }
      toast(`${total} assinaturas conferidas no Mercado Pago.`);
      void renderFinance();
    } catch (err) {
      fail(err);
      btn.disabled = false;
      btn.textContent = "Sincronizar com o Mercado Pago";
    }
  });
  await renderFinTab();
}

async function renderFinTab() {
  const box = $("#fin-body");
  box.innerHTML = `<div class="loading">Carregando…</div>`;
  if (finTab === "payments") {
    const qs = new URLSearchParams({ status: payStatus, page: String(finPage) });
    const d = await api<{ payments: Record<string, any>[]; total: number; page: number; pageSize: number }>(`/api/admin/payments?${qs}`);
    box.innerHTML = `<div class="row"><select id="pay-status" aria-label="Situação da cobrança"><option value="">Todas</option>${Object.entries(PAY_STATUS)
      .map(([k, l]) => `<option value="${k}"${k === payStatus ? " selected" : ""}>${l}</option>`)
      .join("")}</select><a class="btn btn--sm" href="/api/admin/payments?format=csv&status=${payStatus}">Baixar CSV</a></div>` +
      table(d.payments, [
        ["Data", (p) => when(p.paid_at ?? p.created_at)],
        ["Conta", (p) => (p.user_id ? `<a href="#/usuarios/${p.user_id}">${e(p.email)}</a>` : "—")],
        ["Plano", (p) => PLAN_NAMES[p.plan] ?? "—"],
        ["Valor", (p) => money(p.amount)],
        ["Situação", (p) => e(PAY_STATUS[p.status] ?? p.status)],
        ["ID", (p) => `<code>${e(p.id)}</code>`],
      ], "Nenhuma transação.");
    $<HTMLSelectElement>("#pay-status", box).addEventListener("change", (ev) => {
      payStatus = (ev.target as HTMLSelectElement).value;
      finPage = 0;
      void renderFinTab();
    });
    box.append(pager(d.total, d.page, d.pageSize, (p) => {
      finPage = p;
      void renderFinTab();
    }));
    return;
  }
  const d = await api<{ subscriptions: Record<string, any>[]; total: number; page: number; pageSize: number }>(`/api/admin/subscriptions?state=${finTab}&page=${finPage}`);
  box.innerHTML = `<div class="row"><a class="btn btn--sm" href="/api/admin/subscriptions?state=${finTab}&format=csv">Baixar CSV</a>${
    finTab === "expired" || finTab === "cancelling" || finTab === "pending" ? `<a class="btn btn--sm" href="#/retencao">Criar campanha de retenção</a>` : ""
  }</div>` +
    table(d.subscriptions, [
      ["Conta", (s) => (s.user_id ? `<a href="#/usuarios/${s.user_id}">${e(s.email)}</a>` : "—")],
      ["Plano", (s) => PLAN_NAMES[s.plan] ?? s.plan],
      ["Situação", (s) => SUB_STATUS[s.status] ?? s.status],
      ["Valor", (s) => money(s.amount)],
      [finTab === "active" ? "Próxima cobrança" : "Fim do período", (s) => day(s.next_payment_date)],
      ["Total pago", (s) => money(s.paid_total)],
      ["Início", (s) => day(s.created_at)],
    ], "Nenhuma assinatura nesta situação.");
  box.append(pager(d.total, d.page, d.pageSize, (p) => {
    finPage = p;
    void renderFinTab();
  }));
}

// ───────────────────────────── planos ─────────────────────────────

interface PlanData {
  id: string;
  name: string;
  monthlyGb: number;
  monthlyTransfers: number;
  maxFileGb: number;
  cloudHours: number;
  ads: boolean;
  price: number | null;
  forSale: boolean;
}

async function renderPlans() {
  loading();
  const d = await api<{ plans: Record<string, PlanData> }>("/api/admin/plans");
  const m = main();
  m.innerHTML =
    header("Planos", "Os limites valem na hora para todo mundo. O preço vale para novas assinaturas; para mudar o de quem já assina, marque a opção ao salvar.") +
    `<p class="muted small">Use -1 para ilimitado. O prazo da nuvem vai até 192 horas (8 dias), o limite da limpeza automática do armazenamento.</p>
    <section class="plans-edit">${["free", "starter", "scale", "pro"].map((id) => planForm(d.plans[id])).join("")}</section>`;
  m.querySelectorAll<HTMLFormElement>("form[data-plan]").forEach((form) => {
    const original = d.plans[form.dataset.plan!];
    const priceInput = form.elements.namedItem("price") as HTMLInputElement | null;
    const applyRow = form.querySelector<HTMLElement>(".apply-row");
    priceInput?.addEventListener("input", () => {
      const v = Number(priceInput.value.replace(",", "."));
      if (applyRow) applyRow.hidden = !(v > 0 && v !== original.price);
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      const body = {
        name: f.get("name"),
        price: f.get("price") ?? null,
        forSale: f.get("forSale") === "on",
        monthlyGb: Number(f.get("monthlyGb")),
        monthlyTransfers: Number(f.get("monthlyTransfers")),
        maxFileGb: Number(f.get("maxFileGb")),
        cloudHours: Number(f.get("cloudHours") ?? 0),
        ads: f.get("ads") === "on",
        applyToActive: f.get("applyToActive") === "on",
      };
      if (body.applyToActive) {
        const ok = await ask({
          title: "Mudar o preço de quem já assina?",
          message: "As próximas cobranças das assinaturas ativas deste plano passam a ter o novo valor no Mercado Pago. Pelo Código de Defesa do Consumidor, avise os assinantes com antecedência antes de aplicar.",
          confirm: "Aplicar novo preço",
          danger: true,
        });
        if (!ok) return;
      }
      try {
        const r: { repriced: number; repriceFailed: number } = await api(`/api/admin/plans/${form.dataset.plan}`, { method: "PUT", body: JSON.stringify(body) });
        toast(body.applyToActive ? `Plano salvo. ${r.repriced} assinaturas com novo preço${r.repriceFailed ? `, ${r.repriceFailed} falharam` : ""}.` : "Plano salvo.");
        void renderPlans();
      } catch (err) {
        fail(err);
      }
    });
  });
}

function planForm(p: PlanData): string {
  const isFree = p.id === "free";
  const n = (name: keyof PlanData, label: string, unit: string) =>
    `<div class="field"><label for="${p.id}-${name}">${label}</label><div class="input-unit"><input id="${p.id}-${name}" name="${name}" type="number" step="1" min="-1" value="${p[name]}" required /><span>${unit}</span></div></div>`;
  return `<form class="panel plan-form" data-plan="${p.id}">
    <div class="plan-form__head"><h2>${e(p.name)}</h2>${isFree ? `<span class="muted small">sem login</span>` : status(p.forSale && !!p.price, "À venda", p.price ? "Fora de venda" : "Sem preço")}</div>
    <div class="field"><label for="${p.id}-name">Nome exibido</label><input id="${p.id}-name" name="name" value="${e(p.name)}" maxlength="40" required /></div>
    ${isFree ? "" : `<div class="field"><label for="${p.id}-price">Preço mensal</label><div class="input-unit"><span>R$</span><input id="${p.id}-price" name="price" inputmode="decimal" value="${p.price != null ? p.price.toFixed(2).replace(".", ",") : ""}" placeholder="19,90" /></div></div>`}
    ${n("monthlyGb", "Volume por mês", "GB")}
    ${n("monthlyTransfers", "Transferências por mês", "")}
    ${n("maxFileGb", "Tamanho máximo por arquivo", "GB")}
    ${isFree ? "" : n("cloudHours", "Prazo na nuvem", "horas")}
    <label class="check"><input type="checkbox" name="ads" ${p.ads ? "checked" : ""}/> Mostrar vídeo recompensado</label>
    ${isFree ? "" : `<label class="check"><input type="checkbox" name="forSale" ${p.forSale ? "checked" : ""}/> Disponível para assinatura</label>`}
    ${isFree ? "" : `<label class="check apply-row" hidden><input type="checkbox" name="applyToActive"/> Aplicar o novo preço às assinaturas ativas</label>`}
    <button class="btn btn--primary" type="submit">Salvar ${e(p.name)}</button>
  </form>`;
}

// ───────────────────────────── anúncios ─────────────────────────────

interface AdsData {
  days: number;
  settings: { enabled: boolean; rewardedUnit: string | null; onSend: boolean; onReceive: boolean; everyN: number; ecpmBrl: number | null };
  totals: Record<string, number>;
  byMoment: Record<string, Record<string, number>>;
  fillRate: number | null;
  completionRate: number | null;
  estimatedRevenue: number | null;
  series: { day: string; granted: number; unavailable: number }[];
}

async function renderAds() {
  loading();
  const d = await api<AdsData>(`/api/admin/ads?days=${getDays()}`);
  const s = d.settings;
  const t = d.totals;
  const m = main();
  m.innerHTML =
    header("Anúncios", "Vídeo recompensado do Google Ad Manager no plano gratuito. A receita real aparece nos relatórios do Ad Manager e do AdSense.", periodPicker(renderAds)) +
    (s.rewardedUnit ? "" : `<p class="notice">Nenhum bloco de anúncio configurado: o gratuito está funcionando sem vídeo. Crie um bloco <strong>Rewarded</strong> no Google Ad Manager e cole o caminho abaixo.</p>`) +
    `<section class="tiles">
      ${tile("Vídeos liberados", num(t.granted), "assistidos até o fim")}
      ${tile("Taxa de preenchimento", pct(d.fillRate), `${num(t.unavailable)} vezes sem anúncio disponível`)}
      ${tile("Assistiram até o fim", pct(d.completionRate), `${num(t.shown)} começaram · ${num(t.closed_early)} fecharam antes`)}
      ${tile("Foram ver os planos", num(t.aborted), "clicaram em assinar no lugar do vídeo")}
      ${tile("Receita estimada", money(d.estimatedRevenue), s.ecpmBrl ? `com eCPM de ${money(s.ecpmBrl)}` : "defina o eCPM abaixo para estimar")}
    </section>
    <section class="grid2">
      <div id="ads-chart"></div>
      <form class="panel stack" id="ads-form">
        <h2>Configuração</h2>
        <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}/> Anúncios ligados no plano gratuito</label>
        <div class="field"><label for="ads-unit">Bloco rewarded do Google Ad Manager</label><input id="ads-unit" name="rewardedUnit" value="${e(s.rewardedUnit ?? "")}" placeholder="/1234567/transfernow_rewarded" /><small>Em Ad Manager → Inventário → Blocos de anúncios. Para testar, use /22639388115/rewarded_web_example.</small></div>
        <fieldset class="field"><legend>Quando mostrar</legend>
          <label class="check"><input type="checkbox" name="onSend" ${s.onSend ? "checked" : ""}/> Antes de enviar</label>
          <label class="check"><input type="checkbox" name="onReceive" ${s.onReceive ? "checked" : ""}/> Antes de baixar (quando as duas pontas são do gratuito)</label>
        </fieldset>
        <div class="field"><label for="ads-every">Frequência</label><div class="input-unit"><span>a cada</span><input id="ads-every" name="everyN" type="number" min="1" max="50" value="${s.everyN}" /><span>transferências</span></div><small>1 = em todas. 3 = em uma a cada três, por aparelho.</small></div>
        <div class="field"><label for="ads-ecpm">eCPM estimado (só para a estimativa do painel)</label><div class="input-unit"><span>R$</span><input id="ads-ecpm" name="ecpmBrl" inputmode="decimal" value="${s.ecpmBrl != null ? s.ecpmBrl.toFixed(2).replace(".", ",") : ""}" placeholder="30,00" /></div><small>Quanto o Ad Manager paga por mil vídeos concluídos. Copie do relatório do mês anterior.</small></div>
        <button class="btn btn--primary" type="submit">Salvar configuração</button>
      </form>
    </section>
    <section class="panel"><h2>Por momento</h2>${table(
      [["Antes de enviar", d.byMoment.send], ["Antes de baixar", d.byMoment.receive]] as [string, Record<string, number>][],
      [
        ["Momento", (r) => r[0]],
        ["Começaram", (r) => num(r[1].shown)],
        ["Liberados", (r) => num(r[1].granted)],
        ["Sem anúncio", (r) => num(r[1].unavailable)],
        ["Fecharam antes", (r) => num(r[1].closed_early)],
        ["Foram aos planos", (r) => num(r[1].aborted)],
      ],
      "",
    )}</section>`;
  const every = Math.ceil(d.series.length / 8);
  $("#ads-chart", m).append(
    barChart(d.series.map((x) => ({ label: shortDay(x.day), full: fullDay(x.day), values: [x.granted, x.unavailable] })), {
      title: "Vídeos por dia",
      series: ["Liberados", "Sem anúncio"],
      format: (n) => num(Math.round(n)),
      labelEvery: every,
      integer: true,
    }),
  );
  $<HTMLFormElement>("#ads-form", m).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    try {
      await api("/api/admin/ads", {
        method: "PUT",
        body: JSON.stringify({
          enabled: f.get("enabled") === "on",
          rewardedUnit: f.get("rewardedUnit"),
          onSend: f.get("onSend") === "on",
          onReceive: f.get("onReceive") === "on",
          everyN: Number(f.get("everyN")),
          ecpmBrl: f.get("ecpmBrl"),
        }),
      });
      toast("Configuração dos anúncios salva. Vale para os visitantes em até 1 minuto.");
      void renderAds();
    } catch (err) {
      fail(err);
    }
  });
}

// ───────────────────────────── retenção ─────────────────────────────

async function renderRetention() {
  loading();
  const [seg, camps] = await Promise.all([
    api<{ segments: { id: string; label: string; count: number }[]; optedOut: number }>("/api/admin/segments"),
    api<{ campaigns: Record<string, any>[]; emailReady: boolean }>("/api/admin/campaigns"),
  ]);
  const m = main();
  const segLabel = Object.fromEntries(seg.segments.map((s) => [s.id, s.label]));
  m.innerHTML =
    header("Retenção e remarketing", `Públicos montados a partir das assinaturas e do uso. Contam só contas ativas que aceitam e-mails (${num(seg.optedOut)} pediram para sair da lista).`) +
    `<section class="segments">${seg.segments
      .map(
        (s) => `<article class="panel seg-card"><h2>${e(s.label)}</h2><p class="big">${num(s.count)}</p>
        <div class="row"><a class="btn btn--sm" href="/api/admin/segments/${s.id}.csv">Baixar CSV</a><button class="btn btn--sm btn--primary" data-new="${s.id}" ${s.count ? "" : "disabled"}>Criar campanha</button></div></article>`,
      )
      .join("")}</section>
    <p class="muted small">O CSV serve para qualquer ferramenta de e-mail ou para públicos de remarketing (por exemplo, Correspondência do cliente no Google Ads).</p>
    <section class="panel"><h2>Campanhas por e-mail</h2>
      ${camps.emailReady ? "" : `<p class="notice">O envio de e-mail não está disponível neste ambiente.</p>`}
      <p class="muted small">Cada e-mail sai com link de descadastro. O envio depende do domínio ativado no Email Service da Cloudflare. Para listas grandes, prefira uma ferramenta de e-mail marketing com o CSV.</p>
      ${table(camps.campaigns, [
        ["Campanha", (c) => `<strong>${e(c.name)}</strong><br><span class="muted">${e(c.subject)}</span>`],
        ["Público", (c) => e(segLabel[c.segment] ?? c.segment)],
        ["Situação", (c) => ({ draft: "Rascunho", sending: "Enviando", done: "Enviada" })[c.status as string] ?? c.status],
        ["Enviados", (c) => `${num(c.sent)} de ${num(c.total)}${c.failed ? ` · ${num(c.failed)} falhas` : ""}`],
        ["Criada", (c) => `${when(c.created_at)}<br><span class="muted">${e(c.created_by)}</span>`],
        ["", (c) => (c.status === "done" ? "" : `<button class="btn btn--sm" data-test="${c.id}">Enviar teste</button> <button class="btn btn--sm btn--primary" data-send="${c.id}">${c.status === "draft" ? "Enviar" : "Continuar envio"}</button>`)],
      ], "Nenhuma campanha ainda.")}
    </section>`;

  m.querySelectorAll<HTMLButtonElement>("[data-new]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.new!;
      const preset: Record<string, [string, string]> = {
        expired: ["Sentimos sua falta no TransferNow", "Oi {{nome}},\n\nSua assinatura do TransferNow terminou. Se ainda precisa mandar arquivos grandes sem anúncios, ou deixar arquivos na nuvem para alguém baixar depois, o portal continua aqui.\n\nVolte quando quiser."],
        cancelling: ["Seu plano termina em breve", "Oi {{nome}},\n\nVocê cancelou a renovação do TransferNow, e o plano vale até o fim do período já pago. Se mudou de ideia, dá para reativar em um minuto."],
        abandoned: ["Faltou pouco para terminar sua assinatura", "Oi {{nome}},\n\nVocê começou a assinar o TransferNow e o pagamento não foi concluído. Se teve algum problema, é só responder este e-mail."],
        free_heavy: ["Você está perto do limite do gratuito", "Oi {{nome}},\n\nVocê já usou quase todo o plano gratuito deste mês. Com uma assinatura, você manda arquivos maiores, sem anúncios, e pode deixar arquivos na nuvem."],
        free_accounts: ["Conheça os planos do TransferNow", "Oi {{nome}},\n\nCom uma assinatura do TransferNow você manda arquivos maiores, sem anúncios, e a outra pessoa pode baixar depois, mesmo se não estiver online."],
        paying: ["Novidades no TransferNow", "Oi {{nome}},\n\nObrigado por assinar o TransferNow."],
      };
      const [subject, body] = preset[id] ?? ["", ""];
      const v = await ask({
        title: `Nova campanha: ${segLabel[id]}`,
        message: "O público é fotografado agora. Use {{nome}} para o primeiro nome. O botão leva para a tela de planos.",
        fields: [
          { name: "name", label: "Nome interno", value: `${segLabel[id]} · ${day(Date.now())}`, required: true },
          { name: "subject", label: "Assunto do e-mail", value: subject, required: true },
          { name: "body", label: "Mensagem", type: "textarea", value: body, required: true },
          { name: "ctaLabel", label: "Texto do botão", value: id === "paying" ? "Abrir o TransferNow" : "Ver os planos" },
        ],
        confirm: "Criar rascunho",
      });
      if (!v) return;
      try {
        const r: { total: number } = await post("/api/admin/campaigns", { ...v, segment: id });
        toast(`Rascunho criado para ${num(r.total)} pessoas. Envie um teste antes.`);
        void renderRetention();
      } catch (err) {
        fail(err);
      }
    }),
  );
  m.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r: { to: string } = await post(`/api/admin/campaigns/${b.dataset.test}/test`);
        toast(`Teste enviado para ${r.to}.`);
      } catch (err) {
        fail(err);
      }
    }),
  );
  m.querySelectorAll<HTMLButtonElement>("[data-send]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await ask({ title: "Enviar a campanha?", message: "Os e-mails saem em lotes de 20. Mantenha esta página aberta até terminar.", confirm: "Enviar agora", danger: true });
      if (!ok) return;
      b.disabled = true;
      try {
        for (;;) {
          const r: { sent: number; remaining: number; done: boolean } = await post(`/api/admin/campaigns/${b.dataset.send}/send`);
          b.textContent = `Faltam ${num(r.remaining)}…`;
          if (r.done) break;
        }
        toast("Campanha enviada.");
      } catch (err) {
        fail(err);
      }
      void renderRetention();
    }),
  );
}

// ───────────────────────────── suporte ─────────────────────────────

async function renderSupport() {
  const m = main();
  m.innerHTML =
    header("Suporte", "Investigar um código, atender denúncias, bloquear abuso de quem usa sem conta e responder a ordens judiciais.") +
    `<section class="panel"><h2>Procurar um código</h2>
      <form class="row" id="lookup-form"><input name="code" maxlength="6" placeholder="ABC234" aria-label="Código" style="text-transform:uppercase;max-width:160px" required /><button class="btn btn--primary">Procurar</button></form>
      <div id="lookup-out"></div></section>
    <section class="panel"><h2>Bloqueios de quem usa sem conta</h2>
      <p class="muted small">Contas são bloqueadas na tela de Usuários. Aqui você bloqueia um IP, um aparelho (o identificador aparece nas transferências) ou um e-mail que ainda não tem conta.</p>
      <form class="filters" id="ban-form">
        <select name="kind" aria-label="Tipo"><option value="ip">IP</option><option value="device">Aparelho</option><option value="email">E-mail</option></select>
        <input name="value" placeholder="Valor" aria-label="Valor" required />
        <input name="reason" placeholder="Motivo" aria-label="Motivo" />
        <input name="days" type="number" min="0" placeholder="Dias (vazio = sempre)" aria-label="Dias" />
        <button class="btn btn--danger">Bloquear</button>
      </form>
      <div id="bans"></div></section>
    <section class="panel"><h2>Registros de acesso (Marco Civil)</h2>
      <p class="muted small">IP, data e hora dos acessos, guardados por 6 meses. Consulte só com motivo legítimo, como ordem judicial. Toda consulta fica na auditoria.</p>
      <form class="filters" id="log-form">
        <input name="ip" placeholder="IP" aria-label="IP" />
        <input name="email" type="email" placeholder="ou e-mail da conta" aria-label="E-mail" />
        <input name="from" type="date" aria-label="De" />
        <input name="to" type="date" aria-label="Até" />
        <input name="reason" placeholder="Motivo (ex.: ofício nº …)" aria-label="Motivo" required minlength="5" />
        <button class="btn btn--primary">Consultar</button>
      </form>
      <div id="log-out"></div></section>`;

  const loadBans = async () => {
    const d = await api<{ bans: Record<string, any>[] }>("/api/admin/bans");
    $("#bans", m).innerHTML = table(d.bans, [
      ["Tipo", (b) => ({ ip: "IP", device: "Aparelho", email: "E-mail" })[b.kind as string] ?? b.kind],
      ["Valor", (b) => `<code>${e(b.label ?? b.value)}</code>`],
      ["Motivo", (b) => e(b.reason ?? "—")],
      ["Até", (b) => (b.expires_at ? day(b.expires_at) : "Sem prazo")],
      ["Por", (b) => `${e(b.created_by)}<br><span class="muted">${when(b.created_at)}</span>`],
      ["", (b) => `<button class="btn btn--sm" data-unban="${b.id}">Remover</button>`],
    ], "Nenhum bloqueio ativo.");
    m.querySelectorAll<HTMLButtonElement>("[data-unban]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api(`/api/admin/bans/${b.dataset.unban}`, { method: "DELETE" });
          toast("Bloqueio removido.");
          void loadBans();
        } catch (err) {
          fail(err);
        }
      }),
    );
  };
  void loadBans();

  $<HTMLFormElement>("#ban-form", m).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target as HTMLFormElement));
    try {
      await post("/api/admin/bans", { ...f, days: Number(f.days) || null });
      (ev.target as HTMLFormElement).reset();
      toast("Bloqueado.");
      void loadBans();
    } catch (err) {
      fail(err);
    }
  });

  $<HTMLFormElement>("#lookup-form", m).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = String(new FormData(ev.target as HTMLFormElement).get("code") ?? "").toUpperCase();
    const out = $("#lookup-out", m);
    try {
      const d = await api<{ code: string; p2pActive: boolean; cloud: Record<string, any>[] }>(`/api/admin/lookup?code=${encodeURIComponent(code)}`);
      out.innerHTML = `<p>${status(d.p2pActive, "Portal direto aberto agora com este código", "Nenhum portal direto aberto com este código")}</p>` +
        (d.cloud.length
          ? d.cloud
              .map(
                (t) => `<div class="lookup">
              <p><strong>Nuvem:</strong> ${e(TRANSFER_STATUS[t.status] ?? t.status)} · ${bytes(t.total_bytes)} · criada ${when(t.created_at)} · expira ${when(t.expires_at)}<br>
              Enviado por ${t.user_id ? `<a href="#/usuarios/${t.user_id}">${e(t.email)}</a>` : "conta excluída"}</p>
              ${table(t.files as Record<string, any>[], [["Arquivo", (f) => e(f.name)], ["Tamanho", (f) => bytes(f.size)], ["Baixado", (f) => (f.downloaded_at ? when(f.downloaded_at) : "Não")]], "")}
              ${["uploading", "ready"].includes(t.status) ? `<button class="btn btn--danger btn--sm" data-remove="${t.id}">Remover arquivos (denúncia)</button>` : ""}
            </div>`,
              )
              .join("")
          : `<p class="muted">Nenhuma transferência na nuvem com este código.</p><p class="muted small">Transferências diretas não deixam arquivos: o conteúdo vai de um navegador para o outro.</p>`);
      out.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) =>
        b.addEventListener("click", async () => {
          const v = await ask({ title: "Remover os arquivos?", message: "Os arquivos são apagados na hora e o código deixa de funcionar.", fields: [{ name: "reason", label: "Motivo (denúncia, ordem…)", type: "textarea", required: true }], confirm: "Remover", danger: true });
          if (!v) return;
          try {
            await post(`/api/admin/cloud/${b.dataset.remove}/remove`, v);
            toast("Arquivos removidos.");
            (ev.target as HTMLFormElement).requestSubmit();
          } catch (err) {
            fail(err);
          }
        }),
      );
    } catch (err) {
      fail(err);
    }
  });

  $<HTMLFormElement>("#log-form", m).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    const qs = new URLSearchParams();
    for (const k of ["ip", "email", "reason"]) if (f.get(k)) qs.set(k, String(f.get(k)));
    if (f.get("from")) qs.set("from", `${f.get("from")}T00:00:00-03:00`);
    if (f.get("to")) qs.set("to", `${f.get("to")}T23:59:59-03:00`);
    const out = $("#log-out", m);
    try {
      const d = await api<{ rows: Record<string, any>[]; total: number }>(`/api/admin/access-log?${qs}`);
      out.innerHTML = `<div class="row"><span class="muted">${num(d.total)} registros${d.total > 500 ? " (mostrando 500)" : ""}</span><a class="btn btn--sm" href="/api/admin/access-log?${qs}&format=csv">Baixar CSV</a></div>` +
        table(d.rows, [["Data e hora", (r) => when(r.ts)], ["IP", (r) => `<code>${e(r.ip)}</code>`], ["Porta", (r) => e(r.port ?? "—")], ["Evento", (r) => e(r.event)], ["Conta", (r) => (r.user_id ? `<a href="#/usuarios/${r.user_id}">ver</a>` : "—")]], "Nenhum registro no período.");
    } catch (err) {
      fail(err);
    }
  });
}

// ───────────────────────────── sistema ─────────────────────────────

let auditPage = 0;

async function renderSystem() {
  loading();
  const [d, a] = await Promise.all([
    api<{ config: Record<string, boolean>; cron: { ts: number; expired: number } | null; errors24h: number; counts: Record<string, number>; events: Record<string, any>[] }>("/api/admin/system"),
    api<{ rows: Record<string, any>[]; page: number; pageSize: number }>(`/api/admin/audit?page=${auditPage}`),
  ]);
  const cronOk = !!d.cron && Date.now() - d.cron.ts < 2 * 3600_000;
  const m = main();
  m.innerHTML =
    header("Sistema", "Configuração, rotinas e erros da plataforma, e tudo o que os administradores fizeram.") +
    `<section class="tiles tiles--4">
      ${tile("Erros nas últimas 24h", num(d.errors24h), d.errors24h ? `<span class="st st--bad">✕ ver a lista abaixo</span>` : `<span class="st st--good">✓ tudo certo</span>`)}
      ${tile("Limpeza automática", d.cron ? when(d.cron.ts) : "Ainda não rodou", status(cronOk, `roda de hora em hora · ${num(d.cron?.expired ?? 0)} expiradas na última`, "atrasada"))}
      ${tile("Sessões abertas", num(d.counts.sessions), `${num(d.counts.users)} contas`)}
      ${tile("Registros de acesso", num(d.counts.access_log), "guardados por 6 meses")}
    </section>
    <section class="grid2">
      <div class="panel"><h2>Configuração</h2><ul class="checklist">${Object.entries(d.config)
        .map(([k, v]) => `<li>${status(v, k, `${k}: não configurado`)}</li>`)
        .join("")}</ul><p class="muted small">Segredos e variáveis ficam em Cloudflare → Workers → transfernow → Settings.</p></div>
      <div class="panel"><h2>Eventos recentes</h2>${table(d.events.slice(0, 30), [
        ["Quando", (x) => when(x.ts)],
        ["Nível", (x) => (x.level === "error" ? `<span class="st st--bad">✕ erro</span>` : x.level === "warn" ? `<span class="st st--warn">! aviso</span>` : "info")],
        ["Evento", (x) => `<code>${e(x.event)}</code>`],
        ["Detalhe", (x) => `<span class="small">${e(x.detail ?? "")}</span>`],
      ], "Nenhum evento registrado.")}</div>
    </section>
    <section class="panel"><h2>Auditoria do painel</h2>${table(a.rows, [
      ["Quando", (x) => when(x.ts)],
      ["Administrador", (x) => e(x.admin)],
      ["Ação", (x) => `<code>${e(x.action)}</code>`],
      ["Alvo", (x) => e(x.target ?? "—")],
      ["Detalhe", (x) => `<span class="small">${e(x.detail ?? "")}</span>`],
    ], "Nenhuma ação registrada.")}<div id="audit-pager"></div></section>`;
  $("#audit-pager", m).append(pager(a.rows.length < a.pageSize ? auditPage * a.pageSize + a.rows.length : (auditPage + 2) * a.pageSize, auditPage, a.pageSize, (p) => {
    auditPage = p;
    void renderSystem();
  }));
}

// ───────────────────────────── navegação e acesso ─────────────────────────────

const routes: Record<string, (param?: string) => Promise<void>> = {
  visao: renderOverview,
  usuarios: async (id) => (id ? renderUser(id) : renderUsers()),
  financeiro: renderFinance,
  planos: renderPlans,
  anuncios: renderAds,
  retencao: renderRetention,
  suporte: renderSupport,
  sistema: renderSystem,
};

let lastSection = "";

async function route() {
  const [, section = "visao", param] = location.hash.replace(/^#\/?/, "#/").split("/");
  const key = section in routes ? section : "visao";
  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((a) => a.setAttribute("aria-current", a.dataset.nav === key ? "page" : "false"));
  if (key !== lastSection || param) main().innerHTML = "";
  lastSection = param ? `${key}/${param}` : key;
  try {
    await routes[key](param);
    main().focus({ preventScroll: true });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return gate(err.message);
    main().innerHTML = `<p class="notice">${e(err instanceof ApiError ? err.message : "Não foi possível carregar esta seção.")}</p>`;
  }
}

function gate(message?: string) {
  $("#shell").hidden = true;
  $("#gate").hidden = false;
  if (message) $("#gate-msg").textContent = message;
}

async function start() {
  try {
    const me = await api<{ email: string }>("/api/admin/me");
    $("#me-email").textContent = me.email;
    $("#shell").hidden = false;
    $("#gate").hidden = true;
    addEventListener("hashchange", () => void route());
    await route();
  } catch (err) {
    gate(err instanceof ApiError && err.status === 403 ? "Esta conta não tem acesso ao painel. Entre com uma conta de administrador." : undefined);
  }
}

$<HTMLFormElement>("#gate-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $<HTMLInputElement>("#gate-email").value;
  try {
    await post("/api/auth/email", { email, next: "admin" });
    $("#gate-msg").textContent = `Se ${email} for de um administrador, o link de acesso chega em instantes.`;
    $("#gate-error").textContent = "";
  } catch (err) {
    $("#gate-error").textContent = err instanceof ApiError ? err.message : "Não foi possível enviar o link.";
  }
});

$("#btn-logout").addEventListener("click", async () => {
  await post("/api/auth/logout").catch(() => {});
  location.href = "/";
});

void start();
