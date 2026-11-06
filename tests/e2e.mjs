// Teste ponta a ponta: dois navegadores independentes trocam um arquivo pelo portal.
// Uso: npm run dev (em outro terminal) e depois `BASE_URL=http://localhost:8787 npm run test:e2e`
import { chromium } from "playwright-core";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const OUT = process.env.OUT_DIR ?? "test-results";
const SIZE_MB = Number(process.env.SIZE_MB ?? 24);
mkdirSync(OUT, { recursive: true });

const executablePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const launch = () =>
  chromium.launch({
    executablePath,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });

const sourcePath = join(OUT, "payload.bin");
writeFileSync(sourcePath, randomBytes(SIZE_MB * 1024 * 1024));
const expected = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");

const [bA, bB] = await Promise.all([launch(), launch()]);
const ctxA = await bA.newContext({ viewport: { width: 1280, height: 800 } });
const ctxB = await bB.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
for (const [name, p] of [["A", A], ["B", B]]) {
  p.on("pageerror", (e) => console.error(`[${name}] pageerror`, e.message));
  p.on("console", (m) => m.type() === "error" && console.error(`[${name}] console`, m.text()));
}

const shot = (p, name) => p.screenshot({ path: join(OUT, `${name}.png`) });

try {
  await Promise.all([A.goto(BASE, { waitUntil: "domcontentloaded" }), B.goto(BASE, { waitUntil: "domcontentloaded" })]);
  console.log("páginas abertas");
  await A.waitForTimeout(1200);
  await shot(A, "01-idle");
  console.log("idle ok");

  await A.click("#btn-open");
  await A.waitForTimeout(900);
  await shot(A, "02-powered");
  await A.click("#btn-send");
  await A.waitForFunction(() => /^[ACEFHJKMNPRTUWY234679]{6}$/.test(document.querySelector("#code-out")?.textContent ?? "") && !document.querySelector("#code-out")?.getAttribute("data-rolling"));
  await A.waitForTimeout(1800);
  const code = await A.textContent("#code-out");
  console.log("código:", code);
  await shot(A, "03-code");
  console.log("code ok");

  await B.click("#btn-open");
  await B.click("#btn-receive");
  await B.waitForTimeout(500);
  await shot(B, "04-code-input");
  await B.keyboard.type(code, { delay: 80 });

  await A.waitForSelector('body[data-state="send-ready"]', { timeout: 20000 });
  await A.waitForTimeout(1800);
  await shot(A, "05-ready");
  await shot(B, "06-recv-wait");

  await A.setInputFiles("#file-input", sourcePath);
  await B.waitForSelector('body[data-state="recv-offer"]', { timeout: 15000 });
  await shot(B, "07-offer");

  const started = Date.now();
  const downloadPromise = B.waitForEvent("download", { timeout: 60000 });
  await B.click("#btn-accept");
  await A.waitForTimeout(700);
  await shot(A, "08-transfer-sender");
  await shot(B, "09-transfer-receiver");
  const download = await downloadPromise;
  const savedPath = join(OUT, "received.bin");
  await download.saveAs(savedPath);
  await B.waitForSelector('body[data-state="recv-done"]', { timeout: 60000 });
  await A.waitForSelector('body[data-state="send-done"]', { timeout: 60000 });
  const secs = (Date.now() - started) / 1000;
  await A.waitForTimeout(600);
  await shot(A, "10-done-sender");
  await shot(B, "11-done-receiver");

  const got = createHash("sha256").update(readFileSync(savedPath)).digest("hex");
  console.log("nome sugerido:", download.suggestedFilename());
  console.log(`tamanho: ${SIZE_MB} MB em ${secs.toFixed(1)} s`);
  console.log(got === expected ? "OK: hash confere" : `FALHA: hash difere\n esperado ${expected}\n recebido ${got}`);

  // código errado deve ser rejeitado com animação de erro
  const C = await ctxB.newPage();
  await C.goto(BASE, { waitUntil: "domcontentloaded" });
  await C.click("#btn-open");
  await C.click("#btn-receive");
  await C.keyboard.type("AAAAAA", { delay: 40 });
  await C.waitForFunction(() => (document.querySelector("#code-error")?.textContent ?? "").length > 0, null, { timeout: 15000 });
  console.log("código inválido:", await C.textContent("#code-error"));
  await shot(C, "12-bad-code");

  process.exitCode = got === expected ? 0 : 1;
} catch (err) {
  console.error(err);
  await shot(A, "fail-A").catch(() => {});
  await shot(B, "fail-B").catch(() => {});
  process.exitCode = 1;
} finally {
  await bA.close();
  await bB.close();
}
