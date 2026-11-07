/**
 * Gráficos em SVG puro. Barras finas com ponta arredondada no topo, grade discreta,
 * dica ao passar o mouse e tabela com os dados ao lado (acessibilidade).
 * Cores validadas contra o fundo do painel (#151729) com o validador de paleta.
 */

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

export interface BarDatum {
  label: string;
  /** rótulo longo para a dica e a tabela */
  full?: string;
  values: number[];
}

export interface ChartOptions {
  title: string;
  series: string[];
  format: (n: number) => string;
  /** mostra um rótulo a cada N barras no eixo X */
  labelEvery?: number;
  /** valores inteiros (contagens): a escala usa só números inteiros */
  integer?: boolean;
  height?: number;
}

const NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Escala com passos redondos (1, 2, 5 × 10ⁿ) e de 2 a 5 divisões. */
function niceScale(v: number, integer: boolean): { max: number; step: number } {
  if (v <= 0) return { max: integer ? 4 : 1, step: integer ? 1 : 0.25 };
  const raw = v / 4;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = [1, 2, 5, 10].map((f) => f * exp).find((s) => s >= raw)!;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { max: Math.ceil(v / step) * step, step };
}

/** Barras verticais (empilhadas quando há mais de uma série). */
export function barChart(data: BarDatum[], opt: ChartOptions): HTMLElement {
  const root = document.createElement("figure");
  root.className = "chart";
  const head = document.createElement("figcaption");
  head.className = "chart__head";
  const title = document.createElement("h3");
  title.textContent = opt.title;
  head.appendChild(title);
  if (opt.series.length > 1) {
    const legend = document.createElement("ul");
    legend.className = "legend";
    opt.series.forEach((name, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="legend__swatch" style="background:${SERIES[i]}"></span>`;
      li.append(name);
      legend.appendChild(li);
    });
    head.appendChild(legend);
  }
  root.appendChild(head);

  const W = 640;
  const H = opt.height ?? 200;
  const pad = { t: 10, r: 8, b: 26, l: 52 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const totals = data.map((d) => d.values.reduce((s, v) => s + v, 0));
  const { max, step } = niceScale(Math.max(0, ...totals), !!opt.integer);
  const ticks = Math.round(max / step);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart__svg", role: "img", "aria-label": opt.title });

  for (let i = 0; i <= ticks; i++) {
    const y = pad.t + plotH - (plotH * i) / ticks;
    s.appendChild(svg("line", { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: i === 0 ? "axis" : "grid" }));
    const t = svg("text", { x: pad.l - 8, y: y + 4, class: "tick", "text-anchor": "end" });
    t.textContent = opt.format(step * i);
    s.appendChild(t);
  }

  const slot = plotW / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const every = opt.labelEvery ?? Math.ceil(data.length / 8);
  const tip = document.createElement("div");
  tip.className = "chart__tip";
  tip.hidden = true;

  data.forEach((d, i) => {
    const x = pad.l + slot * i + (slot - bw) / 2;
    let base = pad.t + plotH;
    const g = svg("g", { class: "bar" });
    const nonZero = d.values.map((v, k) => [v, k] as const).filter(([v]) => v > 0);
    nonZero.forEach(([v, k], idx) => {
      const h = (v / max) * plotH;
      const top = base - h;
      const isTop = idx === nonZero.length - 1;
      const r = isTop ? Math.min(4, bw / 2, h) : 0;
      // ponta arredondada só no topo; 2px de folga entre segmentos empilhados
      const gap = idx > 0 ? 2 : 0;
      const y0 = base - gap;
      const hh = Math.max(0, h - gap);
      const path = `M${x},${y0} V${y0 - hh + r} Q${x},${y0 - hh} ${x + r},${y0 - hh} H${x + bw - r} Q${x + bw},${y0 - hh} ${x + bw},${y0 - hh + r} V${y0} Z`;
      g.appendChild(svg("path", { d: path, fill: SERIES[k] }));
      base = top;
    });
    // área de toque maior que a barra
    const hit = svg("rect", { x: pad.l + slot * i, y: pad.t, width: slot, height: plotH, class: "hit" });
    g.appendChild(hit);
    const show = () => {
      tip.hidden = false;
      const rows = opt.series.length > 1 ? d.values.map((v, k) => `<span><i style="background:${SERIES[k]}"></i>${opt.series[k]}: <b>${opt.format(v)}</b></span>`).join("") : "";
      tip.innerHTML = `<strong>${d.full ?? d.label}</strong>${rows}${opt.series.length > 1 ? `<span>Total: <b>${opt.format(totals[i])}</b></span>` : `<span><b>${opt.format(totals[i])}</b></span>`}`;
      const pct = ((pad.l + slot * i + slot / 2) / W) * 100;
      tip.style.left = `${pct}%`;
      tip.classList.toggle("is-right", pct > 70);
      g.classList.add("is-hover");
    };
    const hide = () => {
      tip.hidden = true;
      g.classList.remove("is-hover");
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerleave", hide);
    s.appendChild(g);
    if (i % every === 0) {
      const t = svg("text", { x: pad.l + slot * i + slot / 2, y: H - 8, class: "tick", "text-anchor": "middle" });
      t.textContent = d.label;
      s.appendChild(t);
    }
  });

  const wrap = document.createElement("div");
  wrap.className = "chart__plot";
  wrap.append(s, tip);
  root.appendChild(wrap);
  root.appendChild(dataTable(data, opt, totals));
  return root;
}

/** Barras horizontais ordenadas (comparação entre categorias). */
export function rankBars(rows: { label: string; value: number; note?: string }[], opt: { title: string; format: (n: number) => string; empty?: string }): HTMLElement {
  const root = document.createElement("figure");
  root.className = "chart";
  root.innerHTML = `<figcaption class="chart__head"><h3></h3></figcaption>`;
  root.querySelector("h3")!.textContent = opt.title;
  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = opt.empty ?? "Sem dados no período.";
    root.appendChild(p);
    return root;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  const list = document.createElement("ol");
  list.className = "rank";
  for (const r of rows) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="rank__label"></span><span class="rank__track"><span class="rank__bar"></span></span><span class="rank__value"></span>`;
    li.querySelector<HTMLElement>(".rank__label")!.textContent = r.label;
    li.querySelector<HTMLElement>(".rank__bar")!.style.width = r.value > 0 ? `${Math.max(1.5, (r.value / max) * 100)}%` : "0";
    li.querySelector<HTMLElement>(".rank__value")!.textContent = r.note ? `${opt.format(r.value)} · ${r.note}` : opt.format(r.value);
    list.appendChild(li);
  }
  root.appendChild(list);
  return root;
}

function dataTable(data: BarDatum[], opt: ChartOptions, totals: number[]): HTMLElement {
  const det = document.createElement("details");
  det.className = "chart__table";
  det.innerHTML = `<summary>Ver os dados</summary>`;
  const table = document.createElement("table");
  const head = opt.series.length > 1 ? [...opt.series, "Total"] : [opt.title];
  table.innerHTML = `<thead><tr><th>Período</th>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
  const tb = document.createElement("tbody");
  data.forEach((d, i) => {
    const tr = document.createElement("tr");
    const cells = opt.series.length > 1 ? [...d.values, totals[i]] : [totals[i]];
    tr.innerHTML = `<td>${d.full ?? d.label}</td>${cells.map((v) => `<td>${opt.format(v)}</td>`).join("")}`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  det.appendChild(table);
  return det;
}
