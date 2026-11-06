import { CODE_ALPHABET } from "../../shared/code";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const typing = new WeakMap<HTMLElement, number>();

/** Escreve o texto letra a letra, com cursor piscando no fim. */
export function typewrite(el: HTMLElement, text: string, opts: { speed?: number; ready?: boolean } = {}) {
  window.clearInterval(typing.get(el));
  el.classList.toggle("is-ready", !!opts.ready);
  el.setAttribute("aria-label", text);
  if (reduced) {
    el.textContent = text;
    return;
  }
  let i = 0;
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = " ";
  const render = () => {
    el.textContent = text.slice(0, i);
    el.appendChild(caret);
  };
  render();
  const id = window.setInterval(() => {
    i++;
    render();
    if (i >= text.length) {
      window.clearInterval(id);
      window.setTimeout(() => caret.remove(), 1600);
    }
  }, opts.speed ?? 32);
  typing.set(el, id);
}

/** Cada caractere do código "rola" pelo alfabeto até travar, da esquerda para a direita. */
export function rollCode(el: HTMLElement, code: string): Promise<void> {
  el.setAttribute("aria-label", code.split("").join(" "));
  if (reduced) {
    el.textContent = code;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const start = performance.now();
    const step = () => {
      const elapsed = performance.now() - start;
      let out = "";
      let done = true;
      for (let i = 0; i < code.length; i++) {
        const lockAt = 380 + i * 170;
        if (elapsed >= lockAt) out += code[i];
        else {
          done = false;
          out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
        }
      }
      el.textContent = out;
      if (done) resolve();
      else requestAnimationFrame(step);
    };
    step();
  });
}

const fmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${fmt.format(v)} ${units[u]}`;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
