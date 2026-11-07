// Modo nuvem ponta a ponta: assinante sobe arquivos, outra pessoa (sem conta) baixa pelo código.
// Uso: SESSION=<cookie tn_sess de um assinante> BASE_URL=http://localhost:8787 node tests/e2e-cloud.mjs
import { chromium } from "playwright-core";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const OUT = process.env.OUT_DIR ?? "test-results";
const SESSION = process.env.SESSION;
const SIZE_MB = Number(process.env.SIZE_MB ?? 30);
if (!SESSION) throw new Error("defina SESSION com o cookie tn_sess de um assinante");
mkdirSync(OUT, { recursive: true });

const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

const src = join(OUT, "cloud-payload.bin");
writeFileSync(src, randomBytes(SIZE_MB * 1024 * 1024));
const expected = createHash("sha256").update(readFileSync(src)).digest("hex");

const [bA, bB] = await Promise.all([launch(), launch()]);
const host = new URL(BASE).hostname;
const ctxA = await bA.newContext({ viewport: { width: 1280, height: 800 } });
await ctxA.addCookies([{ name: "tn_sess", value: SESSION, domain: host, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
const ctxB = await bB.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
for (const [n, p] of [["A", A], ["B", B]]) p.on("pageerror", (e) => console.error(`[${n}]`, e.message));
const shot = (p, name) => p.screenshot({ path: join(OUT, `${name}.png`) });

try {
  await A.goto(BASE, { waitUntil: "domcontentloaded" });
  await A.waitForFunction(() => document.body.dataset.plan && document.body.dataset.plan !== "free", null, { timeout: 15000 });
  await A.waitForTimeout(800);
  await A.click("#btn-open");
  await A.waitForTimeout(600);
  await shot(A, "c01-powered-paid");
  await A.click("#btn-cloud");
  await A.waitForSelector('body[data-state="cloud-pick"]');
  await A.waitForTimeout(1200);
  await shot(A, "c02-cloud-pick");

  await A.setInputFiles("#cloud-input", src);
  await A.waitForSelector('body[data-state="cloud-upload"]');
  await A.waitForTimeout(400);
  await shot(A, "c03-uploading");
  await A.waitForSelector('body[data-state="cloud-ready"]', { timeout: 120000 });
  await A.waitForTimeout(2500);
  const code = (await A.textContent("#code-out")).trim();
  console.log("código da nuvem:", code);
  await shot(A, "c04-cloud-ready");
  await A.close(); // quem enviou pode sair: o arquivo fica na nuvem

  await B.goto(`${BASE}/#${code}`, { waitUntil: "domcontentloaded" });
  await B.waitForSelector('body[data-state="recv-offer"]', { timeout: 20000 });
  await shot(B, "c05-offer");
  const dl = B.waitForEvent("download", { timeout: 60000 });
  await B.click("#btn-accept");
  const download = await dl;
  const saved = join(OUT, "cloud-received.bin");
  await download.saveAs(saved);
  await B.waitForSelector('body[data-state="recv-done"]', { timeout: 60000 });
  await shot(B, "c06-done");

  const got = createHash("sha256").update(readFileSync(saved)).digest("hex");
  console.log("nome:", download.suggestedFilename());
  console.log(got === expected ? "OK: hash confere" : "FALHA: hash difere");

  const again = await fetch(`${BASE}/api/cloud/code/${code}`);
  console.log("depois do download, consulta ao código →", again.status, "(esperado 404: apagado)");
  process.exitCode = got === expected && again.status === 404 ? 0 : 1;
} catch (err) {
  console.error(err);
  await shot(B, "c-fail-B").catch(() => {});
  process.exitCode = 1;
} finally {
  await bA.close();
  await bB.close();
}
