/**
 * Contrast audit for every piece of text on every surface, in both themes.
 *
 *   npm run audit:contrast
 *
 * Earlier versions only read each control's own colour, which missed
 * differently-coloured child spans, and only visited resting states, which
 * missed everything that appears mid-run. This walks every text node, composites
 * through alpha and `opacity` exactly as rendered, and visits the transient
 * states too.
 */
import { chromium } from "playwright-core";

const BASE = process.env.AIRLOCK_URL ?? "http://localhost:3000";
const NOTE = "病歷號 2246018，患者張宥恩，主治醫師廖婉如。Westley croup score 4 分。BT 38.4°C。";

function audit() {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0,0,1,1); cx.fillStyle = "#000"; cx.fillStyle = c;
    cx.clearRect(0,0,1,1); cx.fillRect(0,0,1,1);
    const d = cx.getImageData(0,0,1,1).data; return [d[0],d[1],d[2],d[3]/255]; };
  const over = (f,b) => f[3] >= 1 ? f : [0,1,2].map(i => Math.round(f[i]*f[3] + b[i]*(1-f[3]))).concat(1);
  const lum = ([r,g,b]) => { const f = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
  const cr = (f,b) => { const a=lum(f), c=lum(b); const [hi,lo]=a>c?[a,c]:[c,a]; return +((hi+0.05)/(lo+0.05)).toFixed(2); };
  const bgOf = (el) => { const st=[]; let n=el;
    while (n && n !== document.documentElement) { st.push(getComputedStyle(n).backgroundColor); n = n.parentElement; }
    st.push(getComputedStyle(document.documentElement).backgroundColor || "#fff");
    let base = rgba(st[st.length-1]); if (base[3] < 1) base = [255,255,255,1];
    for (let i = st.length-2; i >= 0; i--) base = over(rgba(st[i]), base);
    return base; };

  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const txt = (node.textContent || "").trim();
    if (!txt) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (el.closest("[aria-hidden='true']") || el.classList.contains("sr-only")) continue;

    let op = 1, n = el;
    while (n && n !== document.body) { op *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; }
    if (op < 0.06) continue; // genuinely hidden

    const bg = bgOf(el);
    let fg = rgba(s.color);
    fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const size = parseFloat(s.fontSize);
    const bold = parseInt(s.fontWeight, 10) >= 700;
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    const ratio = cr(fg, bg);
    // A saturated teal/green FILL — the brand colour used as a surface. Not a
    // neutral grey with a faint cast, and not the pale category tints in the
    // redaction legend, which are a colour key rather than a button.
    const chroma = Math.max(bg[0], bg[1], bg[2]) - Math.min(bg[0], bg[1], bg[2]);
    const greenish = chroma > 25 && bg[1] > bg[0] + 20;
    out.push({
      txt: txt.slice(0, 34), ratio, need, pass: ratio >= need, size,
      fg: `rgb(${fg[0]},${fg[1]},${fg[2]})`, bg: `rgb(${bg[0]},${bg[1]},${bg[2]})`,
      onGreenNotWhite: greenish && !(fg[0] > 240 && fg[1] > 240 && fg[2] > 240),
      cls: (el.className || "").toString().slice(0, 60),
    });
  }
  return out;
}

async function signIn(p, scheme) {
  await p.goto(`${BASE}/signin`, { waitUntil: "domcontentloaded" });
  await p.evaluate((v) => { try { localStorage.setItem("airlock-theme", v); } catch {} }, scheme);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.fill('input[type="password"]', "llm");
  await p.click('button:has-text("Enter")');
  await p.waitForSelector("text=RAW NARRATIVE", { timeout: 30000 });
}

const b = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
let total = 0, failed = 0, greenBad = 0;

for (const scheme of ["light", "dark"]) {
  console.log(`\n===== ${scheme.toUpperCase()} =====`);
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const p = await ctx.newPage();

  const report = async (label) => {
    const rows = await p.evaluate(audit);
    total += rows.length;
    const fails = rows.filter(r => !r.pass);
    const green = rows.filter(r => r.onGreenNotWhite);
    failed += fails.length; greenBad += green.length;
    console.log(`  ${label.padEnd(22)} ${String(rows.length).padStart(3)} text nodes · ${fails.length} below AA · ${green.length} on green not white`);
    const shown = new Set();
    for (const f of fails) {
      const key = f.txt + f.fg + f.bg;
      if (shown.has(key)) continue; shown.add(key);
      console.log(`     LOW ${String(f.ratio).padStart(5)}:1 (need ${f.need}) ${String(f.size)+"px"} "${f.txt}"`);
      console.log(`          ${f.fg} on ${f.bg}  [${f.cls}]`);
    }
    for (const g of green) console.log(`     GREEN "${g.txt}" ${g.fg} on ${g.bg}`);
  };

  // sign-in, before anything else
  await p.goto(`${BASE}/signin`, { waitUntil: "domcontentloaded" });
  await p.evaluate((v) => { try { localStorage.setItem("airlock-theme", v); } catch {} }, scheme);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector("text=PROJECT AIRLOCK");
  await report("sign-in");

  await signIn(p, scheme);
  await report("main · empty");

  await p.fill("textarea", NOTE);
  await p.waitForTimeout(300);
  await report("main · typed");

  await p.click('button:has-text("Encrypt & structure")');
  await p.waitForSelector("text=Local model finds names", { timeout: 30000 });
  await p.waitForTimeout(1200);
  await report("main · processing");

  await p.waitForSelector('button:has-text("Copy note")', { timeout: 240000 });
  await p.waitForTimeout(500);
  await report("main · result");

  for (const [btn, label] of [["redactions","inspector"],["Wire view","wire view"],
                               ["History","history"],["Prompts","prompts · local"],
                               ["How it works","how it works"],["Manage","routines"]]) {
    await p.click(`button:has-text("${btn}")`);
    await p.waitForTimeout(700);
    await report(label);
    if (label === "prompts · local") {
      await p.click('button:has-text("Gemini — formatting")');
      await p.waitForTimeout(500);
      await report("prompts · cloud");
    }
    await p.keyboard.press("Escape").catch(() => {});
    const close = p.locator('aside button[aria-label^="Close"]').first();
    if (await close.count()) await close.click().catch(() => {});
    await p.waitForTimeout(400);
  }
  await ctx.close();
}

console.log(`\n${total} text nodes checked · ${failed} below AA · ${greenBad} on green but not white`);
console.log(failed === 0 && greenBad === 0 ? "PASS" : "FAIL");
await b.close();
process.exit(failed === 0 && greenBad === 0 ? 0 : 1);
