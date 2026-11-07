import type { PlanId } from "../../shared/plans";
import { formatCpf, isValidCpf, onlyDigits } from "../../shared/cpf";
import { api, ApiError, post, type PublicConfig } from "../api";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

type Cycle = "monthly" | "yearly";
type Method = "card" | "pix" | "boleto";

interface PassView {
  id: string;
  method: "pix" | "boleto";
  status: string;
  amount: number;
  qrCode: string | null;
  qrBase64: string | null;
  ticketUrl: string | null;
  barcode: string | null;
  payUntil: number | null;
  endsAt: number | null;
}

declare global {
  interface Window {
    MercadoPago?: any;
    MP_DEVICE_SESSION_ID?: string;
  }
}

let config: PublicConfig;
let userEmail = "";
let plan: PlanId = "starter";
let cycle: Cycle = "monthly";
let method: Method = "card";
let cardForm: any = null;
let poll = 0;
let onPaid: () => Promise<void> = async () => {};

function loadScript(src: string, attrs: Record<string, string> = {}): Promise<void> {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`falhou ao carregar ${src}`));
    document.head.appendChild(s);
  });
}

function price(c: Cycle = cycle): number | null {
  const p = config.plans[plan];
  return c === "yearly" ? p.priceYearly : p.price;
}

function setError(msg = "") {
  $("#co-error").textContent = msg;
}

function busy(btn: HTMLButtonElement, on: boolean, label?: string) {
  btn.disabled = on;
  if (label) btn.lastElementChild!.textContent = label;
}

// ───────────────────────────── abertura ─────────────────────────────

export function initCheckout(cfg: PublicConfig, paid: () => Promise<void>) {
  config = cfg;
  onPaid = paid;
  const dlg = $<HTMLDialogElement>("#dlg-checkout");
  dlg.addEventListener("close", teardown);
  dlg.querySelectorAll<HTMLButtonElement>("[data-cycle]").forEach((b) =>
    b.addEventListener("click", () => {
      cycle = b.dataset.cycle as Cycle;
      render();
    }),
  );
  dlg.querySelectorAll<HTMLButtonElement>("[data-method]").forEach((b) =>
    b.addEventListener("click", () => {
      method = b.dataset.method as Method;
      render();
    }),
  );
  for (const id of ["#pix-cpf", "#bol-cpf", "#form-checkout__identificationNumber"]) {
    $<HTMLInputElement>(id).addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement;
      el.value = formatCpf(el.value);
    });
  }
  $<HTMLInputElement>("#bol-zip").addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const d = onlyDigits(el.value).slice(0, 8);
    el.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
    if (d.length === 8) void fillAddress(d);
  });
  $<HTMLFormElement>("#pix-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void createPass("pix");
  });
  $<HTMLFormElement>("#bol-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void createPass("boleto");
  });
  dlg.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const src = $<HTMLInputElement>(b.dataset.copy!);
      try {
        await navigator.clipboard.writeText(src.value);
        b.textContent = "Copiado";
        window.setTimeout(() => (b.textContent = "Copiar"), 1800);
      } catch {
        src.select();
      }
    }),
  );
}

export function openCheckout(p: PlanId, email: string) {
  plan = p;
  userEmail = email;
  cycle = "monthly";
  method = "card";
  setError();
  $("#co-done").hidden = true;
  $("#co-body").hidden = false;
  $("#pix-result").hidden = true;
  $("#bol-result").hidden = true;
  $("#pix-form").hidden = false;
  $("#bol-form").hidden = false;
  $<HTMLDialogElement>("#dlg-checkout").showModal();
  // impressão digital do aparelho do Mercado Pago: melhora a aprovação dos pagamentos
  void loadScript("https://www.mercadopago.com/v2/security.js", { view: "checkout" }).catch(() => {});
  render();
}

function teardown() {
  window.clearInterval(poll);
  try {
    cardForm?.unmount();
  } catch {
    /* ok */
  }
  cardForm = null;
}

function render() {
  const p = config.plans[plan];
  const monthly = p.price ?? 0;
  const yearly = p.priceYearly;
  $("#co-title").textContent = `Assinar o ${p.name}`;
  const cyc = $("#co-cycle");
  cyc.hidden = !yearly;
  if (!yearly) cycle = "monthly";
  $("#co-cycle-monthly").textContent = `${money.format(monthly)}/mês`;
  if (yearly) {
    const save = monthly * 12 - yearly;
    $("#co-cycle-yearly").textContent = `${money.format(yearly)}/ano${save > 0 ? ` · economize ${money.format(save)}` : ""}`;
  }
  cyc.querySelectorAll("[data-cycle]").forEach((b) => b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.cycle === cycle)));
  $("#dlg-checkout").querySelectorAll("[data-method]").forEach((b) => b.setAttribute("aria-selected", String((b as HTMLElement).dataset.method === method)));
  for (const m of ["card", "pix", "boleto"] as Method[]) $(`#co-${m}`).hidden = m !== method;

  const amount = price() ?? 0;
  const per = cycle === "yearly" ? "ano" : "mês";
  $("#co-card-submit").lastElementChild!.textContent = `Assinar por ${money.format(amount)}/${per}`;
  $("#co-card-note").textContent =
    cycle === "yearly"
      ? `Cobrado agora e renovado automaticamente a cada 12 meses. Cancele quando quiser em Minha conta.`
      : `Cobrado agora e renovado automaticamente todo mês. Cancele quando quiser em Minha conta.`;
  $("#co-pix-note").textContent = `Pagamento único de ${money.format(amount)} que libera o plano por ${cycle === "yearly" ? "12 meses" : "30 dias"}. Avisamos por e-mail antes de vencer.`;
  $("#co-bol-note").textContent = `Pagamento único de ${money.format(amount)} que libera o plano por ${cycle === "yearly" ? "12 meses" : "30 dias"}. O boleto vence em 3 dias e compensa em até 2 dias úteis depois de pago.`;
  setError();
  if (method === "card") void mountCard(amount);
  else teardown();
}

// ───────────────────────────── cartão (campos seguros do Mercado Pago) ─────────────────────────────

async function mountCard(amount: number) {
  if (!config.mpPublicKey) {
    setError("O pagamento com cartão ainda está sendo configurado. Use Pix ou boleto por enquanto.");
    $<HTMLButtonElement>("#co-card-submit").disabled = true;
    return;
  }
  teardown();
  const btn = $<HTMLButtonElement>("#co-card-submit");
  btn.disabled = true;
  $<HTMLInputElement>("#form-checkout__cardholderEmail").value = userEmail;
  try {
    await loadScript("https://sdk.mercadopago.com/js/v2");
  } catch {
    setError("Não foi possível carregar o pagamento com cartão. Verifique sua conexão ou use Pix.");
    return;
  }
  const mp = new window.MercadoPago(config.mpPublicKey, { locale: "pt-BR" });
  const style = { color: "#14161f", placeholderColor: "#6b7180", fontSize: "16px", fontFamily: "Arial, sans-serif" };
  cardForm = mp.cardForm({
    amount: String(amount.toFixed(2)),
    iframe: true,
    form: {
      id: "form-checkout",
      cardNumber: { id: "form-checkout__cardNumber", placeholder: "0000 0000 0000 0000", style },
      expirationDate: { id: "form-checkout__expirationDate", placeholder: "MM/AA", style },
      securityCode: { id: "form-checkout__securityCode", placeholder: "CVV", style },
      cardholderName: { id: "form-checkout__cardholderName", placeholder: "Como está no cartão" },
      issuer: { id: "form-checkout__issuer", placeholder: "Banco emissor" },
      installments: { id: "form-checkout__installments", placeholder: "Parcelas" },
      identificationType: { id: "form-checkout__identificationType", placeholder: "Documento" },
      identificationNumber: { id: "form-checkout__identificationNumber", placeholder: "000.000.000-00" },
      cardholderEmail: { id: "form-checkout__cardholderEmail", placeholder: "E-mail" },
    },
    callbacks: {
      onFormMounted: (err: unknown) => {
        if (err) setError("Não foi possível abrir o formulário do cartão. Tente de novo.");
      },
      onReady: () => {
        btn.disabled = false;
      },
      onSubmit: async (event: Event) => {
        event.preventDefault();
        setError();
        const data = cardForm.getCardFormData();
        if (!isValidCpf(data.identificationNumber ?? "")) return setError("CPF do titular inválido.");
        if (!data.token) return setError("Confira os dados do cartão.");
        busy(btn, true, "Processando…");
        try {
          await post("/api/billing/card", { plan, cycle, token: data.token, deviceId: window.MP_DEVICE_SESSION_ID });
          await success(`Pagamento aprovado. O plano ${config.plans[plan].name} já está ativo.`);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "Não foi possível concluir. Tente de novo.");
          busy(btn, false);
          render(); // o token do cartão só vale uma vez: monta o formulário de novo
        }
      },
      onError: (errors: unknown) => {
        const list = Array.isArray(errors) ? errors : [errors];
        const msg = list.map((e: any) => e?.message ?? "").join(" ").toLowerCase();
        if (msg) setError(msg.includes("card") || msg.includes("cart") ? "Confira os dados do cartão." : "Confira os dados preenchidos.");
      },
    },
  });
}

// ───────────────────────────── Pix e boleto ─────────────────────────────

async function fillAddress(zip: string) {
  try {
    const r = await fetch(`https://viacep.com.br/ws/${zip}/json/`);
    const d = (await r.json()) as { erro?: boolean; logradouro?: string; bairro?: string; localidade?: string; uf?: string };
    if (d.erro) return;
    const set = (id: string, v?: string) => {
      const el = $<HTMLInputElement>(id);
      if (v && !el.value) el.value = v;
    };
    set("#bol-street", d.logradouro);
    set("#bol-neighborhood", d.bairro);
    set("#bol-city", d.localidade);
    set("#bol-uf", d.uf);
    $<HTMLInputElement>("#bol-number").focus();
  } catch {
    /* preenchimento manual */
  }
}

async function createPass(kind: "pix" | "boleto") {
  setError();
  const form = $<HTMLFormElement>(kind === "pix" ? "#pix-form" : "#bol-form");
  const f = new FormData(form);
  const cpf = String(f.get("cpf") ?? "");
  if (!isValidCpf(cpf)) return setError("CPF inválido.");
  const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const label = btn.lastElementChild!.textContent ?? "";
  busy(btn, true, kind === "pix" ? "Gerando Pix…" : "Gerando boleto…");
  const fullName = String(f.get("name") ?? "").trim().replace(/\s+/g, " ");
  const [firstName, ...rest] = fullName.split(" ");
  try {
    const pass = await post<PassView>(`/api/billing/${kind}`, {
      plan,
      cycle,
      cpf,
      firstName,
      lastName: rest.join(" "),
      deviceId: window.MP_DEVICE_SESSION_ID,
      address:
        kind === "boleto"
          ? { zip: f.get("zip"), street: f.get("street"), number: f.get("number"), neighborhood: f.get("neighborhood"), city: f.get("city"), uf: f.get("uf") }
          : undefined,
    });
    form.hidden = true;
    showPass(pass);
  } catch (err) {
    setError(err instanceof ApiError ? err.message : "Não foi possível gerar o pagamento.");
  } finally {
    busy(btn, false, label);
  }
}

function showPass(p: PassView) {
  if (p.status === "approved") return void success(`Pagamento confirmado. O plano ${config.plans[plan].name} já está ativo.`);
  if (p.method === "pix") {
    $("#pix-result").hidden = false;
    const img = $<HTMLImageElement>("#pix-qr");
    img.src = p.qrBase64 ? `data:image/png;base64,${p.qrBase64}` : "";
    img.hidden = !p.qrBase64;
    $<HTMLInputElement>("#pix-code").value = p.qrCode ?? "";
    const until = p.payUntil ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(p.payUntil) : "";
    $("#pix-status").textContent = `Aguardando o pagamento${until ? ` (vale até ${until})` : ""}…`;
  } else {
    $("#bol-result").hidden = false;
    $<HTMLAnchorElement>("#bol-link").href = p.ticketUrl ?? "#";
    $<HTMLInputElement>("#bol-code").value = p.barcode ?? "";
    $("#bol-code-row").hidden = !p.barcode;
  }
  window.clearInterval(poll);
  const started = Date.now();
  poll = window.setInterval(async () => {
    // Pix confirma em segundos; boleto leva até 2 dias úteis, então paramos de olhar depois de 15 min.
    if (p.method === "boleto" && Date.now() - started > 15 * 60_000) return window.clearInterval(poll);
    try {
      const now = await api<PassView>(`/api/billing/pass/${p.id}`);
      if (now.status === "approved") {
        window.clearInterval(poll);
        await success(`Pagamento confirmado. O plano ${config.plans[plan].name} já está ativo.`);
      } else if (["rejected", "cancelled", "expired"].includes(now.status)) {
        window.clearInterval(poll);
        setError("O pagamento não foi concluído. Gere um novo para tentar de novo.");
      }
    } catch {
      /* tenta de novo no próximo ciclo */
    }
  }, p.method === "pix" ? 4000 : 20000);
}

async function success(message: string) {
  teardown();
  $("#co-body").hidden = true;
  $("#co-done").hidden = false;
  $("#co-done-msg").textContent = message;
  await onPaid();
}
