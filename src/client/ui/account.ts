import { GB, PAID_PLANS, type PlanId } from "../../shared/plans";
import { api, ApiError, fetchMe, post, type Me, type PublicConfig } from "../api";
import { formatBytes } from "./effects";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long" });

let config: PublicConfig;
let me: Me | null = null;
const listeners: ((me: Me | null) => void)[] = [];
const WANTED_PLAN = "tn_wanted_plan";

export function currentMe(): Me | null {
  return me;
}

export function isPaidUser(): boolean {
  return !!me && me.plan !== "free";
}

export function onMeChange(fn: (me: Me | null) => void) {
  listeners.push(fn);
}

export async function refreshMe(): Promise<Me | null> {
  me = await fetchMe();
  const btn = $("#btn-account");
  btn.textContent = me?.user ? "Minha conta" : "Entrar";
  document.body.dataset.plan = me?.plan ?? "free";
  for (const fn of listeners) fn(me);
  return me;
}

export function toast(message: string) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("is-on");
  window.clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(window.setTimeout(() => el.classList.remove("is-on"), 4200));
}

// ───────────────────────────── planos ─────────────────────────────

function limitText(n: number, unit: string) {
  return n < 0 ? "Ilimitado" : `${n} ${unit}`;
}

function renderPlans() {
  const grid = $("#plans-grid");
  const current = me?.plan ?? "free";
  const order: PlanId[] = ["free", "starter", "scale", "pro"];
  grid.replaceChildren(
    ...order.map((id) => {
      const p = config.plans[id];
      const card = document.createElement("article");
      card.className = "plan";
      card.dataset.plan = id;
      if (id === current) card.classList.add("is-current");

      const price = id === "free" ? "Grátis" : p.price && p.forSale ? `${money.format(p.price)}/mês` : "Em breve";
      const features = [
        id === "free" ? "5 GB por mês" : p.monthlyGb < 0 ? "Volume ilimitado" : `${p.monthlyGb} GB por mês`,
        limitText(p.monthlyTransfers, "transferências por mês").replace("Ilimitado", "Transferências ilimitadas"),
        p.maxFileGb < 0 ? "Arquivos de qualquer tamanho" : `Arquivos de até ${p.maxFileGb} GB`,
        p.cloudHours > 0 ? `Nuvem: a outra ponta tem ${p.cloudHours >= 48 ? `${p.cloudHours / 24} dias` : `${p.cloudHours}h`} para baixar` : "As duas pontas online ao mesmo tempo",
        p.ads ? "Um vídeo curto por envio e por download" : "Sem anúncios",
      ];

      card.innerHTML = `<h3></h3><p class="plan__price"></p><ul></ul><div class="plan__cta"></div>`;
      card.querySelector("h3")!.textContent = p.name;
      card.querySelector(".plan__price")!.textContent = price;
      const ul = card.querySelector("ul")!;
      for (const f of features) {
        const li = document.createElement("li");
        li.textContent = f;
        ul.appendChild(li);
      }
      const cta = card.querySelector(".plan__cta")!;
      if (id === current) {
        cta.innerHTML = `<span class="plan__badge">Seu plano</span>`;
      } else if (id !== "free") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "switch switch--primary switch--small";
        const available = config.billing && !!p.price && p.forSale;
        btn.disabled = !available;
        btn.innerHTML = `<span class="led" aria-hidden="true"></span>`;
        btn.append(available ? `Assinar ${p.name}` : "Em breve");
        btn.addEventListener("click", () => void subscribe(id, btn));
        cta.appendChild(btn);
      }
      return card;
    }),
  );
  $("#plans-note").textContent =
    "O Pró tem uso justo de 2 TB por mês. Arquivos na nuvem são apagados assim que a outra ponta baixa, ou quando o prazo acaba.";
}

async function subscribe(plan: PlanId, btn: HTMLButtonElement) {
  if (!me?.user) {
    sessionStorage.setItem(WANTED_PLAN, plan);
    $<HTMLDialogElement>("#dlg-plans").close();
    openLogin("Entre na sua conta para assinar. É rápido e não precisa de senha.");
    return;
  }
  btn.disabled = true;
  btn.lastChild!.textContent = "Abrindo o Mercado Pago…";
  try {
    const { url } = await post<{ url: string }>("/api/billing/checkout", { plan });
    location.href = url;
  } catch (err) {
    btn.disabled = false;
    btn.lastChild!.textContent = `Assinar ${config.plans[plan].name}`;
    toast(err instanceof ApiError ? err.message : "Não foi possível abrir o pagamento.");
  }
}

export function openPlans() {
  renderPlans();
  $<HTMLDialogElement>("#dlg-plans").showModal();
}

// ───────────────────────────── login ─────────────────────────────

export function openLogin(reason?: string) {
  const dlg = $<HTMLDialogElement>("#dlg-login");
  $("#login-reason").textContent = reason ?? "Entre para assinar um plano e acompanhar o seu uso.";
  $("#login-sent").hidden = true;
  $("#login-form").hidden = !config.login.email;
  $("#login-google").hidden = !config.login.google;
  $("#login-divider").hidden = !(config.login.email && config.login.google);
  $("#login-none").hidden = config.login.email || config.login.google;
  $("#login-error").textContent = "";
  dlg.showModal();
  window.setTimeout(() => $<HTMLInputElement>("#login-email").focus(), 50);
}

function bindLogin() {
  $<HTMLFormElement>("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#login-email");
    const btn = $<HTMLButtonElement>("#login-submit");
    btn.disabled = true;
    $("#login-error").textContent = "";
    try {
      await post("/api/auth/email", { email: input.value });
      $("#login-form").hidden = true;
      $("#login-google").hidden = true;
      $("#login-divider").hidden = true;
      $("#login-sent").hidden = false;
      $("#login-sent-to").textContent = input.value.trim();
    } catch (err) {
      $("#login-error").textContent = err instanceof ApiError ? err.message : "Não foi possível enviar o link.";
    } finally {
      btn.disabled = false;
    }
  });
}

// ───────────────────────────── conta ─────────────────────────────

function meter(el: HTMLElement, used: number, limit: number, label: (n: number) => string) {
  const fill = el.querySelector<HTMLElement>(".bar__fill")!;
  const text = el.querySelector<HTMLElement>(".usage__text")!;
  if (limit < 0) {
    fill.style.width = "4%";
    text.textContent = `${label(used)} usados (ilimitado)`;
  } else {
    fill.style.width = `${Math.min(100, (used / limit) * 100)}%`;
    text.textContent = `${label(used)} de ${label(limit)}`;
  }
}

export function openAccount() {
  if (!me?.user) return openLogin();
  const p = config.plans[me.plan];
  $("#acc-email").textContent = me.user.email;
  $("#acc-plan").textContent = p.name;
  const sub = me.subscription;
  let status = "";
  if (sub && me.plan !== "free") {
    const date = sub.next_payment_date ? dateFmt.format(new Date(sub.next_payment_date)) : null;
    status =
      sub.status === "authorized"
        ? `Renova${date ? ` em ${date}` : " todo mês"}${sub.amount ? ` por ${money.format(sub.amount)}` : ""}.`
        : `Renovação cancelada. O plano vale${date ? ` até ${date}` : " até o fim do período pago"}.`;
  }
  $("#acc-status").textContent = status;
  meter($("#acc-bytes"), me.usage.bytes, p.monthlyGb < 0 ? -1 : p.monthlyGb * GB, formatBytes);
  meter($("#acc-transfers"), me.usage.transfers, p.monthlyTransfers, (n) => `${n}`);
  $("#acc-cancel").hidden = !(sub && sub.status === "authorized");
  $("#acc-admin").hidden = !me.user.admin;
  $<HTMLDialogElement>("#dlg-account").showModal();
}

function bindAccount() {
  $("#acc-change").addEventListener("click", () => {
    $<HTMLDialogElement>("#dlg-account").close();
    openPlans();
  });
  $("#acc-logout").addEventListener("click", async () => {
    await post("/api/auth/logout").catch(() => {});
    $<HTMLDialogElement>("#dlg-account").close();
    await refreshMe();
    toast("Você saiu da conta.");
  });
  $("#acc-cancel").addEventListener("click", async () => {
    if (!confirm("Cancelar a renovação? O plano continua valendo até o fim do período já pago.")) return;
    try {
      await post("/api/billing/cancel");
      await refreshMe();
      openAccount();
      toast("Renovação cancelada.");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Não foi possível cancelar agora.");
    }
  });
}

// ───────────────────────────── inicialização ─────────────────────────────

export async function initAccount(cfg: PublicConfig) {
  config = cfg;
  bindLogin();
  bindAccount();
  $("#btn-plans").addEventListener("click", openPlans);
  $("#btn-account").addEventListener("click", () => (me?.user ? openAccount() : openLogin()));
  for (const dlg of document.querySelectorAll<HTMLDialogElement>("dialog.sheet")) {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close(); // clique fora fecha
    });
  }

  const params = new URLSearchParams(location.search);
  const login = params.get("login");
  const wantsPlans = params.get("planos") === "1";
  const billingReturn = params.get("assinatura") === "retorno";
  if (login || billingReturn || wantsPlans || params.has("utm_campaign")) history.replaceState(null, "", location.pathname + location.hash);

  if (billingReturn) await api("/api/billing/sync").catch(() => {});
  await refreshMe();

  if (login === "ok" && me?.user) {
    toast(`Você entrou como ${me.user.email}.`);
    const wanted = sessionStorage.getItem(WANTED_PLAN) as PlanId | null;
    sessionStorage.removeItem(WANTED_PLAN);
    if (wanted && PAID_PLANS.includes(wanted)) openPlans();
  } else if (login === "bloqueado") {
    toast("Esta conta está bloqueada. Fale com contato@duia.com.br.");
  } else if (login === "expirado") {
    openLogin("Esse link expirou ou já foi usado. Peça um novo.");
  } else if (login === "falhou" || login === "google-indisponivel") {
    openLogin("Não foi possível entrar com o Google agora. Tente pelo e-mail.");
  }
  if (wantsPlans) openPlans();
  if (billingReturn) {
    toast(me && me.plan !== "free" ? `Plano ${config.plans[me.plan].name} ativo. Bons teletransportes.` : "Pagamento em análise. O plano ativa assim que o Mercado Pago confirmar.");
  }
}
