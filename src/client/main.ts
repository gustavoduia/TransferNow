import "./style.css";
import { isValidCode, normalizeCode } from "../shared/code";
import { prepareDownloads } from "./p2p/download";
import type { Progress } from "./p2p/protocol";
import type { IncomingOffer } from "./p2p/receiver";
import { fetchConfig, ReceiverSession, SenderSession, SessionError, type PublicConfig } from "./p2p/session";
import { formatBytes, formatClock, rollCode, typewrite } from "./ui/effects";

type State =
  | "idle" | "powered"
  | "send-waiting" | "send-ready" | "send-transfer" | "send-done"
  | "recv-code" | "recv-connecting" | "recv-wait" | "recv-offer" | "recv-transfer" | "recv-done"
  | "error";

/** Interface mínima da cena; um substituto vazio entra se o WebGL falhar. */
interface Scene {
  powerOn(): void;
  open(): void;
  signalReady(): void;
  clearReady(): void;
  setHover(on: boolean): void;
  teleport(dir: "in" | "out"): void;
  setProgress(p: number): void;
  complete(): void;
  error(): void;
  close(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const noop: Scene = {
  powerOn() {}, open() {}, signalReady() {}, clearReady() {}, setHover() {},
  teleport() {}, setProgress() {}, complete() {}, error() {}, close() {},
};

let scene: Scene = noop;
let state: State = "idle";
let config: PublicConfig = { maxFileSizeMb: -1, roomTtlSeconds: 600 };
let sender: SenderSession | null = null;
let receiver: ReceiverSession | null = null;
let currentCode = "";
let countdownTimer: number | undefined;
let pendingOffer: IncomingOffer | null = null;
let interacted = false; // só move o foco depois que a pessoa usou a página
addEventListener("pointerdown", () => (interacted = true), { once: true });
addEventListener("keydown", () => (interacted = true), { once: true });

// ───────────────────────────── estado e painéis ─────────────────────────────

function setState(next: State) {
  state = next;
  document.body.dataset.state = next;
  document.querySelectorAll<HTMLElement>("[data-for]").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.for!.split(" ").includes(next));
  });
  document.querySelectorAll<HTMLElement>("[data-show-in]").forEach((el) => {
    el.classList.toggle("is-hidden", !el.dataset.showIn!.split(" ").includes(next));
  });
  document.querySelectorAll<HTMLElement>("[data-hide-in]").forEach((el) => {
    el.classList.toggle("is-hidden", el.dataset.hideIn!.split(" ").includes(next));
  });
  const focusable = document.querySelector<HTMLElement>(".panel.is-active .switch--primary, .panel.is-active .cell");
  if (next === "recv-code") window.setTimeout(() => $("#code-0").focus(), 60);
  else if (focusable && interacted && !document.activeElement?.closest(".panel.is-active")) focusable.focus({ preventScroll: true });
}

function fail(message: string) {
  scene.error();
  window.setTimeout(() => scene.close(), 900);
  teardown();
  typewrite($("#error-status"), message);
  setState("error");
}

function teardown() {
  window.clearInterval(countdownTimer);
  sender?.close();
  receiver?.close();
  sender = null;
  receiver = null;
  pendingOffer = null;
  currentCode = "";
}

function resetToIdle() {
  teardown();
  scene.close();
  history.replaceState(null, "", location.pathname);
  setState("idle");
}

const errorText: Record<string, string> = {
  not_found: "Código não encontrado. Confira com quem enviou e digite de novo.",
  expired: "Este código expirou. Peça para quem envia abrir um novo portal.",
  taken: "Este código já foi usado. Peça um novo para quem envia.",
  rate_limited: "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.",
  connection_failed: "Os portais não conseguiram se conectar nestas redes. Tente outra rede ou desative a VPN.",
  network: "A conexão com o portal caiu. Verifique sua internet e abra um novo portal.",
};

// ───────────────────────────── quem envia ─────────────────────────────

async function startSending() {
  setState("send-waiting");
  $("#code-out").textContent = "";
  typewrite($("#send-status"), "Abrindo o portal…");
  sender = new SenderSession({
    onCode: async (code, expiresAt) => {
      currentCode = code;
      scene.open();
      await rollCode($("#code-out"), code);
      typewrite($("#send-status"), "Envie este código para quem vai receber.");
      startCountdown(expiresAt);
    },
    onPeerReady: () => {
      window.clearInterval(countdownTimer);
      scene.signalReady();
      setState("send-ready");
      $("#pick-label").textContent = "Escolher arquivos";
      typewrite($("#send-status"), "Pode jogar seu arquivo", { ready: true, speed: 55 });
    },
    onPeerLeft: () => fail("A outra ponta fechou o portal."),
    onError: (code, message) => fail(errorText[code] ?? message),
  });
  try {
    await sender.open();
  } catch (err) {
    fail(err instanceof SessionError ? err.message : "Não foi possível abrir o portal agora. Tente de novo.");
  }
}

function startCountdown(expiresAt: number) {
  window.clearInterval(countdownTimer);
  const tick = () => {
    const left = expiresAt - Date.now();
    $("#countdown").textContent = formatClock(left);
    if (left <= 0) window.clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = window.setInterval(tick, 500);
}

async function sendBatch(files: File[]) {
  if (!sender?.ready || files.length === 0) return;
  const limit = maxFileBytes();
  const big = limit > 0 ? files.find((f) => f.size > limit) : undefined;
  if (big) {
    scene.error();
    typewrite($("#send-status"), `“${big.name}” passa do limite de ${formatBytes(limit)} por arquivo.`);
    return;
  }

  scene.teleport("in");
  setState("send-transfer");
  const meter = startMeter(files.length === 1 ? files[0].name : `${files.length} arquivos`);
  typewrite($("#send-status"), "Aguardando a outra ponta aceitar…");
  try {
    let started = false;
    const result = await sender.send(files, (p) => {
      if (!started && p.bytesDone > 0) {
        started = true;
        typewrite($("#send-status"), "Teletransportando…");
      }
      meter.update(p);
    });
    meter.stop();
    if (result === "done") {
      scene.complete();
      setState("send-done");
      $("#pick-label").textContent = "Enviar mais arquivos";
      typewrite($("#send-status"), files.length === 1 ? "Chegou do outro lado." : `${files.length} arquivos chegaram do outro lado.`, { ready: true });
    } else {
      scene.clearReady();
      window.setTimeout(() => scene.signalReady(), 400);
      setState("send-ready");
      typewrite(
        $("#send-status"),
        result === "too_large" ? "O arquivo passa do limite permitido." : "A outra ponta recusou. Você pode jogar outro arquivo.",
      );
    }
  } catch {
    meter.stop();
    fail("A transmissão foi interrompida. Abra um novo portal e tente de novo.");
  }
}

function maxFileBytes() {
  return config.maxFileSizeMb > 0 ? config.maxFileSizeMb * 1024 * 1024 : -1;
}

// ───────────────────────────── quem recebe ─────────────────────────────

const cells = [...document.querySelectorAll<HTMLInputElement>("#code-input .cell")];

function readCode() {
  return cells.map((c) => c.value).join("");
}

function fillCode(raw: string) {
  const code = normalizeCode(raw);
  cells.forEach((c, i) => {
    c.value = code[i] ?? "";
    c.classList.toggle("is-filled", !!code[i]);
  });
  return code;
}

function setupCodeInput() {
  cells.forEach((cell, i) => {
    cell.addEventListener("input", () => {
      const v = normalizeCode(cell.value);
      if (v.length > 1) {
        // colagem/autocompletar em uma célula só
        const code = fillCode(readCode().slice(0, i) + v);
        cells[Math.min(code.length, cells.length - 1)].focus();
      } else {
        cell.value = v;
        cell.classList.toggle("is-filled", !!v);
        if (v && i < cells.length - 1) cells[i + 1].focus();
      }
      $("#code-error").textContent = "";
      maybeSubmitCode();
    });
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !cell.value && i > 0) {
        cells[i - 1].value = "";
        cells[i - 1].classList.remove("is-filled");
        cells[i - 1].focus();
        e.preventDefault();
      } else if (e.key === "ArrowLeft" && i > 0) cells[i - 1].focus();
      else if (e.key === "ArrowRight" && i < cells.length - 1) cells[i + 1].focus();
    });
    cell.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text") ?? "";
      const code = fillCode(text.includes("#") ? text.split("#").pop()! : text);
      cells[Math.min(code.length, cells.length - 1)].focus();
      maybeSubmitCode();
    });
    cell.addEventListener("focus", () => cell.select());
  });
}

function maybeSubmitCode() {
  const code = readCode();
  if (code.length === 6 && isValidCode(code) && state === "recv-code") void joinPortal(code);
}

function rejectCode(message: string) {
  const box = $("#code-input");
  box.classList.remove("is-shaking");
  void box.offsetWidth;
  box.classList.add("is-shaking");
  $("#code-error").textContent = message;
  fillCode("");
  window.setTimeout(() => {
    box.classList.remove("is-shaking");
    cells[0].focus();
  }, 420);
}

async function joinPortal(code: string) {
  currentCode = code;
  scene.open();
  setState("recv-connecting");
  typewrite($("#recv-status"), "Abrindo o portal…");
  void prepareDownloads();

  receiver = new ReceiverSession(
    {
      onPeerReady: () => {
        setState("recv-wait");
        typewrite($("#recv-status"), "Portal conectado. Esperando o arquivo chegar.");
      },
      onOffer: (offer) => {
        pendingOffer = offer;
        showOffer(offer);
      },
      onProgress: (p) => meter?.update(p),
      onBatchDone: (offer, ok) => {
        meter?.stop();
        meter = null;
        if (ok) {
          scene.complete();
          setState("recv-done");
          typewrite(
            $("#recv-status"),
            offer.files.length === 1
              ? "Arquivo recebido e conferido. Ele está nos seus downloads."
              : `${offer.files.length} arquivos recebidos e conferidos. Estão nos seus downloads.`,
            { ready: true },
          );
        } else {
          scene.error();
          setState("recv-done");
          typewrite($("#recv-status"), "Um arquivo chegou corrompido e foi descartado. Peça para enviar de novo.");
        }
      },
      onCancelled: () => {
        meter?.stop();
        meter = null;
        setState("recv-wait");
        typewrite($("#recv-status"), "A outra ponta cancelou o envio.");
      },
      onPeerLeft: () => fail("A outra ponta fechou o portal."),
      onError: (errCode, message) => {
        if (["not_found", "expired", "taken"].includes(errCode) && state === "recv-connecting") {
          receiver?.close();
          receiver = null;
          scene.error();
          setState("recv-code");
          rejectCode(errorText[errCode] ?? message);
          return;
        }
        fail(errorText[errCode] ?? message);
      },
    },
    maxFileBytes(),
  );
  try {
    await receiver.join(code);
  } catch {
    fail(errorText.network);
  }
}

function showOffer(offer: IncomingOffer) {
  const list = $("#offer-list");
  list.replaceChildren(
    ...offer.files.map((f) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = f.name;
      const size = document.createElement("span");
      size.textContent = formatBytes(f.size);
      li.append(name, size);
      return li;
    }),
  );
  $("#offer-title").textContent =
    offer.files.length === 1
      ? `Chegando pelo portal: ${formatBytes(offer.totalBytes)}`
      : `Chegando pelo portal: ${offer.files.length} arquivos, ${formatBytes(offer.totalBytes)}`;
  setState("recv-offer");
}

let meter: ReturnType<typeof startMeter> | null = null;

function acceptOffer() {
  if (!pendingOffer || !receiver) return;
  const offer = pendingOffer;
  pendingOffer = null;
  receiver.accept();
  scene.teleport("out");
  setState("recv-transfer");
  meter = startMeter(offer.files.length === 1 ? offer.files[0].name : `${offer.files.length} arquivos`);
}

function declineOffer() {
  receiver?.decline();
  pendingOffer = null;
  setState("recv-wait");
  typewrite($("#recv-status"), "Envio recusado. O portal continua aberto.");
}

// ───────────────────────────── medidor de progresso ─────────────────────────────

function startMeter(label: string) {
  $("#transfer-file").textContent = label;
  const fill = $("#transfer-fill");
  const bar = $("#transfer-bar");
  const pct = $("#transfer-pct");
  const bytes = $("#transfer-bytes");
  const speedEl = $("#transfer-speed");
  pct.textContent = "0";
  fill.style.width = "0%";
  bytes.textContent = "";
  speedEl.textContent = "";

  let last = { t: performance.now(), b: 0 };
  let speed = 0;
  let latest: Progress | null = null;
  const timer = window.setInterval(() => {
    if (!latest) return;
    const now = performance.now();
    const inst = ((latest.bytesDone - last.b) * 1000) / Math.max(1, now - last.t);
    speed = speed ? speed * 0.7 + inst * 0.3 : inst;
    last = { t: now, b: latest.bytesDone };
    speedEl.textContent = speed > 0 ? `${formatBytes(speed)}/s` : "";
  }, 500);

  let raf = 0;
  return {
    update(p: Progress) {
      latest = p;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const ratio = p.totalBytes ? p.bytesDone / p.totalBytes : 1;
        const value = Math.min(100, Math.floor(ratio * 100));
        pct.textContent = String(value);
        fill.style.width = `${value}%`;
        bar.setAttribute("aria-valuenow", String(value));
        bytes.textContent = `${formatBytes(p.bytesDone)} de ${formatBytes(p.totalBytes)}`;
        if (p.fileCount > 1 && p.fileName) $("#transfer-file").textContent = `${p.fileIndex + 1}/${p.fileCount} ${p.fileName}`;
        scene.setProgress(ratio);
      });
    },
    stop() {
      window.clearInterval(timer);
      cancelAnimationFrame(raf);
      scene.setProgress(0);
    },
  };
}

// ───────────────────────────── arrastar e soltar ─────────────────────────────

function setupDrop() {
  let depth = 0;
  const canDrop = () => state === "send-ready" || state === "send-done";
  addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    depth++;
    if (canDrop()) {
      document.body.classList.add("is-dragging");
      scene.setHover(true);
    }
  });
  addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = canDrop() ? "copy" : "none";
  });
  addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      document.body.classList.remove("is-dragging");
      scene.setHover(false);
    }
  });
  addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("is-dragging");
    scene.setHover(false);
    if (!canDrop()) return;
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type);
    void sendBatch(files);
  });
  $<HTMLInputElement>("#file-input").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    void sendBatch(files);
  });
}

// ───────────────────────────── inicialização ─────────────────────────────

async function copy(text: string, btn: HTMLElement, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = done;
    btn.classList.add("is-done");
    window.setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("is-done");
    }, 1800);
  } catch {
    btn.textContent = text;
  }
}

function bind() {
  $("#btn-open").addEventListener("click", () => {
    scene.powerOn();
    setState("powered");
  });
  $("#btn-send").addEventListener("click", () => void startSending());
  $("#btn-receive").addEventListener("click", () => {
    fillCode("");
    $("#code-error").textContent = "";
    setState("recv-code");
  });
  $("#btn-copy-code").addEventListener("click", (e) => void copy(currentCode, e.currentTarget as HTMLElement, "Código copiado"));
  $("#btn-copy-link").addEventListener(
    "click",
    (e) => void copy(`${location.origin}/#${currentCode}`, e.currentTarget as HTMLElement, "Link copiado"),
  );
  $("#btn-accept").addEventListener("click", acceptOffer);
  $("#btn-decline").addEventListener("click", declineOffer);
  $("#btn-restart").addEventListener("click", () => {
    resetToIdle();
    scene.powerOn();
    setState("powered");
  });
  $("#btn-close").addEventListener("click", resetToIdle);
  $("#btn-privacy").addEventListener("click", () => $<HTMLDialogElement>("#privacy").showModal());
  addEventListener("beforeunload", (e) => {
    if (state === "send-transfer" || state === "recv-transfer") e.preventDefault();
  });
  setupCodeInput();
  setupDrop();
}

async function loadScene() {
  try {
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2") && !probe.getContext("webgl")) throw new Error("no webgl");
    const { PortalScene } = await import("./scene/portal");
    scene = new PortalScene($<HTMLCanvasElement>("#scene"));
  } catch {
    document.body.classList.add("no-webgl");
    scene = noop;
  }
}

async function main() {
  bind();
  setState("idle");
  const [cfg] = await Promise.all([fetchConfig(), loadScene()]);
  config = cfg;

  // Link compartilhado (https://…/#CODIGO): já abre o portal no modo de receber.
  const fromHash = normalizeCode(location.hash.slice(1));
  if (isValidCode(fromHash)) {
    history.replaceState(null, "", location.pathname);
    scene.powerOn();
    setState("recv-code");
    fillCode(fromHash);
    window.setTimeout(maybeSubmitCode, 700);
  }
}

void main();
