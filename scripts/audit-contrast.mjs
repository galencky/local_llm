import { chromium } from "playwright-core";

const AUDIT = `(() => {
  // Resolve ANY css colour (oklab, alpha, named) to rgba via a 1x1 canvas.
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    cx.clearRect(0,0,1,1); cx.fillStyle = "#000"; cx.fillStyle = css;
    cx.clearRect(0,0,1,1); cx.fillRect(0,0,1,1);
    const d = cx.getImageData(0,0,1,1).data;
    return [d[0], d[1], d[2], d[3]/255];
  };
  const over = (fg, bg) => fg[3] >= 1 ? fg :
    [0,1,2].map(i => Math.round(fg[i]*fg[3] + bg[i]*(1-fg[3]))).concat(1);
  const lum = ([r,g,b]) => { const f = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const cr = (f,b) => { const a=lum(f), c=lum(b); const [hi,lo]=a>c?[a,c]:[c,a]; return +((hi+0.05)/(lo+0.05)).toFixed(2); };

  const bgOf = (el) => {
    let acc = [0,0,0,0], n = el;
    const stack = [];
    while (n && n !== document.documentElement) { stack.push(getComputedStyle(n).backgroundColor); n = n.parentElement; }
    stack.push(getComputedStyle(document.documentElement).backgroundColor || "#fff");
    let base = rgba(stack[stack.length-1]); if (base[3] < 1) base = [255,255,255,1];
    for (let i = stack.length - 2; i >= 0; i--) base = over(rgba(stack[i]), base);
    return base;
  };

  const out = [];
  document.querySelectorAll("button, a[href], select, [role='button']").forEach(el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width < 6 || r.height < 6 || s.visibility === "hidden" || s.display === "none") return;
    const text = (el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g," ").slice(0,30);
    if (!text) return;
    const op = parseFloat(s.opacity);
    let fg = rgba(s.color);
    const bg = bgOf(el);
    if (op < 1) fg = over([fg[0],fg[1],fg[2],fg[3]*op], bg);
    const size = parseFloat(s.fontSize);
    const bold = parseInt(s.fontWeight,10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const ratio = cr(over(fg,bg), bg);
    out.push({ text, ratio, need, pass: ratio >= need, size, disabled: el.disabled === true, op });
  });
  return out;
})()`;

const b = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });

async function survey(scheme, open) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto("http://localhost:3000/signin", { waitUntil: "domcontentloaded" });
  await p.evaluate((s) => { try { localStorage.setItem("airlock-theme", s); } catch {} }, scheme);
  await p.reload({ waitUntil: "domcontentloaded" });

  if (open === "signin") {
    await p.waitForSelector("text=PROJECT AIRLOCK");
  } else {
    await p.fill('input[type="password"]', "llm");
    await p.click('button:has-text("Enter")');
    await p.waitForSelector("text=RAW NARRATIVE", { timeout: 30000 });
    await p.fill("textarea", "病歷號 2246018，患者張宥恩。BT 38.4°C。");
    if (open && open !== "main") { await p.click(`button:has-text("${open}")`); await p.waitForTimeout(600); }
  }
  await p.waitForTimeout(500);
  const rows = await p.evaluate(AUDIT);
  await ctx.close();
  return rows;
}

const views = [["signin","sign-in"],["main","main"],["History","History drawer"],["Prompts","Prompts drawer"],["How it works","How-it-works"],["Manage","Routines drawer"]];
let bad = 0;
for (const scheme of ["light","dark"]) {
  console.log(`\n===== ${scheme.toUpperCase()} =====`);
  for (const [open,label] of views) {
    const rows = await survey(scheme, open);
    const fails = rows.filter(r => !r.pass);
    console.log(`  ${label.padEnd(16)} ${rows.length} controls, ${fails.length} below AA`);
    for (const f of fails) { bad++; console.log(`     LOW ${String(f.ratio).padStart(5)}:1 (need ${f.need}) ${f.size}px${f.disabled?" disabled":""} "${f.text}"`); }
  }
}
console.log(`\n${bad === 0 ? "All controls pass AA in both themes." : bad + " control(s) below AA"}`);
await b.close();
