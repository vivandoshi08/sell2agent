#!/usr/bin/env node
// Renders the framed stage for the demo's live segments from the dashboard's /video page (src/video).
//
//   node apps/dashboard/video/render.mjs [coldopen|negotiate|close|transact ...] [--buyer ChatGPT] [--cues 3,6,9.5] [--zoom 0.5,0.4,1.35|off]
//
// Per segment, into apps/dashboard/video/out/<seg>/:
//   <seg>-green.mp4   the CapCut layout: panes pure #00FF00 (chroma-key your recording under it)   ← deliverable
//   coords.json       pane pixel rects + timings (compose.sh reads this)                          ← deliverable
//   layout.png        a still of the green layout at the end of the segment
//   bg.mp4, fg.mov, mask.png   layers compose.sh uses (stage + chips; ring + dim with alpha; rounded pane mask)
//
// Needs Google Chrome and ffmpeg. Installs playwright-core into video/.tools on first run (outside the lockfile).
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH = join(HERE, "..");
const OUT = join(HERE, "out");
const TOOLS = join(HERE, ".tools");
const FPS = 30, W = 1920, H = 1080;

// ---- args ----
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const extra = new URLSearchParams();
for (const k of ["buyer", "cues", "zoom"]) { const v = flag(k) ?? process.env[k.toUpperCase()]; if (v) extra.set(k, v); }
const segs = argv.length ? argv : ["negotiate", "close", "transact"];
for (const s of segs) if (!["coldopen", "negotiate", "close", "transact"].includes(s)) { console.error(`unknown segment "${s}"`); process.exit(2); }

// ---- playwright-core, kept out of the workspace lockfile ----
if (!existsSync(join(TOOLS, "node_modules", "playwright-core"))) {
  console.log("installing playwright-core into video/.tools (one time)…");
  execFileSync("npm", ["i", "--no-audit", "--no-fund", "--prefix", TOOLS, "playwright-core@1.56.1"], { stdio: "inherit" });
}
const { chromium } = createRequire(join(TOOLS, "package.json"))("playwright-core");

// ---- the dashboard's own dev server, on a free port ----
const { createServer } = await import(createRequire(join(DASH, "package.json")).resolve("vite"));
const server = await createServer({ root: DASH, configFile: join(DASH, "vite.config.ts"), logLevel: "warn", server: { port: 0, strictPort: false } });
await server.listen();
const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ?? `http://localhost:${server.config.server.port}`;

const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(seg, mode) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  if (mode !== "mask") await page.clock.install({ time: 0 });
  const q = new URLSearchParams(extra); q.set("seg", seg); q.set("mode", mode);
  await page.goto(`${base}/video?${q}`);
  for (let i = 0; i < 200; i++) { if (await page.evaluate(() => window.__ready === true && !!window.__seek)) break; await sleep(50); }
  return page;
}

function encoder(file, kind) {
  const args = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-"];
  if (kind === "alpha") args.push("-c:v", "qtrle", "-pix_fmt", "argb");
  else args.push("-c:v", "libx264", "-preset", "medium", "-crf", kind === "key" ? "12" : "14", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart");
  args.push(file);
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c} for ${file}`)))));
  return {
    write: (buf) => new Promise((res) => (ff.stdin.write(buf) ? res() : ff.stdin.once("drain", res))),
    end: () => { ff.stdin.end(); return done; },
  };
}

// Cold open: drawn in code, so it renders straight to the final clip, plus a green-pane version for keying real chats.
async function renderCold(dir) {
  const layers = [
    { mode: "bg", file: join(dir, "coldopen.mp4") },
    { mode: "green", file: join(dir, "coldopen-green.mp4") },
  ];
  for (const L of layers) { L.page = await open("coldopen", L.mode); L.enc = encoder(L.file, "key"); }
  const s = await layers[0].page.evaluate(() => window.__segment);
  writeFileSync(join(dir, "coords.json"), JSON.stringify({ segment: "coldopen", window: s.window, duration: s.duration, fps: FPS, width: W, height: H, radius: 20,
    panes: Object.fromEntries(["grok", "claude", "chatgpt"].map((k, i) => [k, s.panes[i]])),
    note: "Green panes are on screen 2.6–7.0 s (they rise in over 0.5 s, staggered 0.08 s)." }, null, 2) + "\n");
  const frames = Math.round(s.duration * FPS);
  for (let n = 0; n < frames; n++) {
    await Promise.all(layers.map(async (L) => {
      if (n > 0) await L.page.clock.runFor(1000 / FPS);
      await L.page.evaluate((t) => window.__seek(t), n / FPS);
      await L.enc.write(await L.page.screenshot({ type: "png" }));
    }));
    if (n % 30 === 0) console.log(`coldopen: frame ${n}/${frames}`);
  }
  for (const L of layers) { await L.enc.end(); await L.page.close(); }
}

try {
  for (const seg of segs) {
    const dir = join(OUT, seg);
    mkdirSync(dir, { recursive: true });
    const t0 = Date.now();

    if (seg === "coldopen") { await renderCold(dir); console.log(`coldopen: ${((Date.now() - t0) / 1000).toFixed(0)} s → ${dir}`); continue; }

    // mask + coords
    const mp = await open(seg, "mask");
    await mp.screenshot({ path: join(dir, "mask.png") });
    const s = await mp.evaluate(() => window.__segment);
    await mp.close();
    const coords = {
      segment: s.id, window: s.window, duration: s.duration, fps: FPS, width: W, height: H,
      radius: 20, slide_in: { seconds: 0.55, dx: 48, easing: "ease-out cubic; left pane from the left, right from the right; bg fades in linearly" },
      panes: s.panes, labels: s.labels, highlight: s.highlight, dim_others: s.dimOthers, chips: s.chips, steps: s.steps ?? null, zoom: s.zoom ?? null,
      overrides: Object.fromEntries(extra),
    };
    writeFileSync(join(dir, "coords.json"), JSON.stringify(coords, null, 2) + "\n");

    // bg / fg / green, stepped together on a fake clock so every frame is exact
    const layers = [
      { mode: "bg", file: join(dir, "bg.mp4"), kind: "opaque" },
      { mode: "fg", file: join(dir, "fg.mov"), kind: "alpha" },
      { mode: "green", file: join(dir, `${seg}-green.mp4`), kind: "key" },
    ];
    for (const L of layers) { L.page = await open(seg, L.mode); L.enc = encoder(L.file, L.kind); }
    const frames = Math.round(s.duration * FPS);
    for (let n = 0; n < frames; n++) {
      await Promise.all(layers.map(async (L) => {
        if (n > 0) await L.page.clock.runFor(1000 / FPS);
        await L.page.evaluate((t) => window.__seek(t), n / FPS);
        const png = await L.page.screenshot({ type: "png", omitBackground: L.mode === "fg" });
        await L.enc.write(png);
        if (L.mode === "green" && n === frames - 1) writeFileSync(join(dir, "layout.png"), png);
      }));
      if (n % 90 === 0) process.stdout.write(`\r${seg}: ${n}/${frames} frames`);
    }
    for (const L of layers) { await L.enc.end(); await L.page.close(); }
    console.log(`\r${seg}: ${frames}/${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s → ${dir}`);
  }
} finally {
  await browser.close();
  await server.close();
}
