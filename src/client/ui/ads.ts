/**
 * Vídeo recompensado (Google Ad Manager / GPT). A pessoa escolhe assistir e, quando o
 * Google confirma a recompensa, a transferência é liberada. Sem anúncio disponível
 * (ou com bloqueador), a transferência segue sem vídeo: ninguém fica preso esperando.
 */

/** aborted = a pessoa preferiu ver os planos; a transferência não segue. */
type Outcome = "granted" | "unavailable" | "skipped" | "aborted";

interface RewardedReadyEvent {
  slot: unknown;
  makeRewardedVisible(): void;
}

declare global {
  interface Window {
    googletag?: any;
  }
}

let gptLoading: Promise<boolean> | null = null;

function loadGpt(): Promise<boolean> {
  gptLoading ??= new Promise((resolve) => {
    window.googletag = window.googletag || { cmd: [] };
    const s = document.createElement("script");
    s.src = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
    window.setTimeout(() => resolve(false), 8000);
  });
  return gptLoading;
}

/** Pré-carrega o script quando a pessoa ainda está escolhendo o arquivo. */
export function warmUpAds(unit: string | null) {
  if (unit) void loadGpt();
}

interface Copy {
  title: string;
  body: string;
  done: string;
}

const COPY: Record<"send" | "receive", Copy> = {
  send: {
    title: "Um vídeo curto libera o seu envio",
    body: "No plano gratuito, cada teletransporte é pago com um vídeo rápido. Quem assina não vê anúncios.",
    done: "Envio liberado.",
  },
  receive: {
    title: "Um vídeo curto libera o seu download",
    body: "Assista até o fim e o arquivo começa a chegar. Quem assina não vê anúncios.",
    done: "Download liberado.",
  },
};

export function showRewarded(unit: string | null, kind: "send" | "receive", onPlans: () => void): Promise<Outcome> {
  if (!unit) return Promise.resolve("skipped");
  const dlg = document.querySelector<HTMLDialogElement>("#dlg-ad")!;
  const title = dlg.querySelector<HTMLElement>("[data-ad=title]")!;
  const body = dlg.querySelector<HTMLElement>("[data-ad=body]")!;
  const watch = dlg.querySelector<HTMLButtonElement>("[data-ad=watch]")!;
  const plans = dlg.querySelector<HTMLButtonElement>("[data-ad=plans]")!;
  const note = dlg.querySelector<HTMLElement>("[data-ad=note]")!;
  const copy = COPY[kind];

  title.textContent = copy.title;
  body.textContent = copy.body;
  note.textContent = "";
  dlg.dataset.phase = "loading";
  watch.disabled = true;
  watch.lastElementChild!.textContent = "Carregando vídeo…";
  dlg.showModal();

  return new Promise<Outcome>((resolve) => {
    let finished = false;
    let slot: any = null;
    let ready: RewardedReadyEvent | null = null;
    let granted = false;
    let timer = 0;
    const listeners: [string, (e: any) => void][] = [];

    const finish = (outcome: Outcome, message?: string) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      const g = window.googletag;
      if (g?.pubads && slot) {
        try {
          for (const [name, fn] of listeners) g.pubads().removeEventListener(name, fn);
          g.destroySlots([slot]);
        } catch {
          /* ignora */
        }
      }
      if (message) {
        dlg.dataset.phase = "done";
        note.textContent = message;
        window.setTimeout(() => {
          dlg.close();
          resolve(outcome);
        }, 1100);
      } else {
        dlg.close();
        resolve(outcome);
      }
    };

    const request = async () => {
      granted = false;
      ready = null;
      dlg.dataset.phase = "loading";
      watch.disabled = true;
      watch.lastElementChild!.textContent = "Carregando vídeo…";
      if (!(await loadGpt())) return finish("unavailable", "Sem vídeo disponível agora. Pode seguir.");
      timer = window.setTimeout(() => finish("unavailable", "Sem vídeo disponível agora. Pode seguir."), 9000);

      window.googletag.cmd.push(() => {
        const g = window.googletag;
        slot = g.defineOutOfPageSlot(unit, g.enums.OutOfPageFormat.REWARDED);
        if (!slot) return finish("unavailable", "Sem vídeo disponível agora. Pode seguir.");
        slot.addService(g.pubads());
        const on = (name: string, fn: (e: any) => void) => {
          listeners.push([name, fn]);
          g.pubads().addEventListener(name, fn);
        };
        on("rewardedSlotReady", (e: RewardedReadyEvent) => {
          if (e.slot !== slot) return;
          window.clearTimeout(timer);
          ready = e;
          dlg.dataset.phase = "ready";
          watch.disabled = false;
          watch.lastElementChild!.textContent = "Assistir vídeo";
        });
        on("rewardedSlotGranted", (e: { slot: unknown }) => {
          if (e.slot === slot) granted = true;
        });
        on("rewardedSlotClosed", (e: { slot: unknown }) => {
          if (e.slot !== slot) return;
          if (granted) return finish("granted", copy.done);
          // fechou antes do fim: a recompensa só vale com o vídeo inteiro
          try {
            g.destroySlots([slot]);
          } catch {
            /* ignora */
          }
          slot = null;
          dlg.showModal();
          note.textContent = "O vídeo precisa ir até o fim para liberar.";
          void request();
        });
        on("slotRenderEnded", (e: { slot: unknown; isEmpty: boolean }) => {
          if (e.slot === slot && e.isEmpty) finish("unavailable", "Sem vídeo disponível agora. Pode seguir.");
        });
        g.enableServices();
        g.display(slot);
      });
    };

    watch.onclick = () => {
      if (!ready) return;
      dlg.dataset.phase = "watching";
      dlg.close(); // o anúncio do Google ocupa a tela
      ready.makeRewardedVisible();
    };
    plans.onclick = () => {
      finished = true;
      window.clearTimeout(timer);
      dlg.close();
      onPlans();
      resolve("aborted");
    };
    dlg.oncancel = (e) => e.preventDefault();
    void request();
  });
}
