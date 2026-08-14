// Headless-Chromium harness — serves this viewer with the *real* security
// headers (incl. CSP) from `_headers` and drives index.html, per the dev
// standards (§15) and the File Viewer Kit spec (§12/§13). Exit 1 on failure.
//
// CI has no ffmpeg, so the audio fixtures are generated right here in Node:
// a PCM-sine WAV (playable in stock Chromium) plus a hand-crafted ID3v2.3
// MP3 whose *tag* must render even where the MPEG decoder is missing.
// Codec-dependent playback checks stay on open formats only.
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8099;

const H = {};
for (const line of readFileSync(join(ROOT, "_headers"), "utf8").split("\n")) {
  const m = line.match(/^[ \t]+([A-Za-z0-9-]+):[ \t]*(.+?)\s*$/);
  if (m && !line.trim().startsWith("#")) H[m[1]] = m[2];
}
if (!H["Content-Security-Policy"]) {
  console.error("FAIL: no Content-Security-Policy found in _headers");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain",
};
const mime = (p) => MIME[p.slice(p.lastIndexOf("."))] || "application/octet-stream";

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  let fp = join(ROOT, p);
  if (!fp.startsWith(ROOT) || !existsSync(fp)) fp = join(ROOT, "index.html");
  try {
    res.writeHead(200, { ...H, "Content-Type": mime(fp) });
    res.end(readFileSync(fp));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(PORT, r));

// ---------------------------------------------------------------- fixtures --
const FIX = mkdtempSync(join(tmpdir(), "audio-harness-"));

function makeWav(seconds = 1, rate = 22050, freq = 440) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.6 * 32767), i * 2);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const id3Frame = (id, body) => {
  const h = Buffer.alloc(10);
  h.write(id, 0, "latin1"); h.writeUInt32BE(body.length, 4);   // v2.3: plain BE size
  return Buffer.concat([h, body]);
};
const id3Text = (id, text) => id3Frame(id, Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]));
const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

function makeTaggedMp3() {
  const frames = Buffer.concat([
    id3Text("TIT2", "Sine Song"),
    id3Text("TPE1", "The Test Tones"),
    id3Text("TALB", "Harness Sessions"),
    id3Text("TYER", "2026"),
    id3Frame("APIC", Buffer.concat([
      Buffer.from([0]), Buffer.from("image/png", "latin1"), Buffer.from([0]),
      Buffer.from([3]), Buffer.from([0]), TINY_PNG,
    ])),
  ]);
  const head = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), syncsafe(frames.length)]);
  return Buffer.concat([head, frames, Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(256)]);
}

writeFileSync(join(FIX, "tone.wav"), makeWav());
writeFileSync(join(FIX, "tone2.wav"), makeWav(1, 22050, 660));
writeFileSync(join(FIX, "tagged.mp3"), makeTaggedMp3());
writeFileSync(join(FIX, "fake.wma"), Buffer.from("definitely not decodable windows media"));
writeFileSync(join(FIX, "sample.xyz"), "unmapped type\n");
writeFileSync(join(FIX, "test.json"), '{"hello":"world"}\n');

// ------------------------------------------------------------------- setup --
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const results = [];
const check = (name, ok, detail) => results.push([name, !!ok, detail]);
const errs = [];
const hook = (page) => {
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(String(e)));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- main context: light system scheme, full toggle round-trip
const ctx = await browser.newContext({ colorScheme: "light", viewport: { width: 1240, height: 800 } });
const page = await ctx.newPage();
hook(page);
// Track object-URL lifecycle before any page script runs (§17.2: revoke on replace/Clear).
await page.addInitScript(() => {
  const created = [], revoked = [];
  const mkUrl = URL.createObjectURL.bind(URL), rmUrl = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (o) => { const u = mkUrl(o); created.push(u); return u; };
  URL.revokeObjectURL = (u) => { revoked.push(u); return rmUrl(u); };
  window.__urls = { created, revoked };
});
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => document.fonts.ready);
check("font loads under CSP", await page.evaluate(() => [...document.fonts].some((f) => f.family.includes("JetBrains"))));
check("heading uses JetBrains Mono", await page.evaluate(() => {
  const el = document.querySelector(".doc-title") || document.querySelector(".empty-title");
  return el && getComputedStyle(el).fontFamily.includes("JetBrains Mono");
}));
check("light default with light system scheme", await page.evaluate(() => document.getElementById("bgPicker").value) === "#ffffff");
check("toggle present in toolbar", await page.evaluate(() => {
  const t = document.getElementById("themeToggle");
  return !!t && t.hasAttribute("aria-pressed") && !!t.closest("nav.actions");
}));
check("icons in light mode (sun shown, moon hidden)", await page.evaluate(() => {
  const s = document.getElementById("themeIconSun"), m = document.getElementById("themeIconMoon");
  return !s.hasAttribute("hidden") && m.hasAttribute("hidden");
}));
await page.click("#themeToggle");
check("toggle to dark sets picker #0d1117", await page.evaluate(() => document.getElementById("bgPicker").value) === "#0d1117");
check("aria-pressed true in dark", await page.getAttribute("#themeToggle", "aria-pressed") === "true");
check("icons in dark mode (moon shown, sun hidden)", await page.evaluate(() => {
  const s = document.getElementById("themeIconSun"), m = document.getElementById("themeIconMoon");
  const moonVisible = !m.hasAttribute("hidden") && getComputedStyle(m).display !== "none";
  const sunHidden = s.hasAttribute("hidden") || getComputedStyle(s).display === "none";
  return moonVisible && sunHidden;
}));
check("choice persists (mykk-bg)", await page.evaluate(() => { try { return localStorage.getItem("mykk-bg") === "#0d1117"; } catch (e) { return false; } }));
await page.click("#themeToggle");
check("toggle back to light", await page.evaluate(() => document.getElementById("bgPicker").value) === "#ffffff");

// -- family nav (§6.9): 16 items, Audio active after Home, Video last
check("nav: 16 items, Audio active after Home, Video last", await page.evaluate(() => {
  const items = [...document.querySelectorAll("#navPanel .nav-item")];
  const labels = items.map((a) => a.textContent.trim());
  const active = document.querySelector("#navPanel .nav-item.nav-active");
  return items.length === 16 &&
    labels[0] === "Home" && labels[1] === "Audio" && labels[15] === "Video" &&
    active && active.getAttribute("aria-current") === "page" &&
    active.href === "https://audio-viewer.us/" &&
    items.every((a) => a.querySelector("img.nav-ico"));
}));

// -- WAV: open-format playback (loadedmetadata, duration, viewing state, waveform)
await page.setInputFiles("#fileInput", join(FIX, "tone.wav"));
await page.waitForFunction(() => {
  const a = document.querySelector("#audioMount audio");
  return a && a.duration > 0;
}, null, { timeout: 10000 });
check("wav: body.viewing + duration > 0", await page.evaluate(() => {
  const a = document.querySelector("#audioMount audio");
  return document.body.classList.contains("viewing") && a && a.duration > 0.5 && a.duration < 2;
}));
check("wav: title bar shows the filename", (await page.evaluate(() => document.getElementById("docTitle").textContent)) === "tone.wav"
  && (await page.title()).includes("tone.wav"));
check("wav: meta line shows duration · format · size", await page.evaluate(() => {
  const t = document.getElementById("metaLine").textContent;
  return /0:01/.test(t) && /WAV/.test(t) && /KB|MB/.test(t);
}));
await page.waitForFunction(() => !document.getElementById("wave").hidden, null, { timeout: 10000 }).catch(() => {});
check("wav: waveform canvas paints (non-blank)", await page.evaluate(() => {
  const c = document.getElementById("wave");
  if (c.hidden || !c.width) return false;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
}));

// -- drop-to-replace revokes the previous object URL
const firstUrl = await page.evaluate(() => window.__urls.created[0]);
await page.setInputFiles("#fileInput", join(FIX, "tone2.wav"));
await page.waitForFunction(() => {
  const a = document.querySelector("#audioMount audio");
  return a && a.duration > 0;
}, null, { timeout: 10000 });
check("replace: previous object URL revoked", await page.evaluate(
  (u) => window.__urls.revoked.includes(u), firstUrl));
check("replace: exactly one live audio element", await page.evaluate(
  () => document.querySelectorAll("#audioMount audio").length === 1));

// -- Clear revokes the current URL and restores the empty state
const secondUrl = await page.evaluate(() => window.__urls.created[1]);
await page.click("#btnClear");
check("clear: object URL revoked + empty state back", await page.evaluate((u) =>
  window.__urls.revoked.includes(u) &&
  !document.body.classList.contains("viewing") &&
  !document.getElementById("empty").hidden, secondUrl));

// -- hand-crafted ID3v2.3 MP3: the tag must render even without an MPEG decoder,
//    and a missing decoder must surface the honest hint card (never silence).
await page.setInputFiles("#fileInput", join(FIX, "tagged.mp3"));
await page.waitForFunction(() => document.getElementById("trackTitle").textContent === "Sine Song", null, { timeout: 10000 });
check("id3: title + artist + album/year from the tag", await page.evaluate(() => {
  return document.getElementById("trackTitle").textContent === "Sine Song" &&
    document.getElementById("trackArtist").textContent === "The Test Tones" &&
    /Harness Sessions/.test(document.getElementById("trackAlbum").textContent) &&
    /2026/.test(document.getElementById("trackAlbum").textContent);
}));
check("id3: cover art rendered from APIC as a data: URI", await page.evaluate(() => {
  const img = document.getElementById("coverArt");
  return !img.hidden && img.src.startsWith("data:image/png;base64,");
}));
await sleep(1500);   // give the pipeline time to either load metadata or fail
check("mp3: plays or shows the honest codec-hint card (no silent failure)", await page.evaluate(() => {
  const a = document.querySelector("#audioMount audio");
  const playable = a && a.duration > 0;
  const hinted = !document.getElementById("audioNotice").hidden &&
    /this browser/.test(document.getElementById("audioNotice").textContent);
  return playable || hinted;
}));

// -- accept-with-notice: .wma gets the conversion card, no broken player
await page.setInputFiles("#fileInput", join(FIX, "fake.wma"));
await page.waitForFunction(() => !document.getElementById("audioNotice").hidden, null, { timeout: 5000 });
check("wma: notice card incl. the not-uploaded line", await page.evaluate(() => {
  const n = document.getElementById("audioNotice");
  return !n.hidden &&
    /Can’t play a “\.wma” file/.test(n.textContent) &&
    /Your file was not uploaded anywhere\./.test(n.textContent) &&
    document.getElementById("playerCard").hidden &&
    !document.querySelector("#audioMount audio");
}));
await page.click("#btnClear");

// -- family router (§6.10): sibling type → offer card
await page.setInputFiles("#fileInput", join(FIX, "test.json"));
await page.waitForSelector("#routeCard:not([hidden])", { timeout: 5000 });
check("router: test.json offers Data Viewer, focus on Open", await page.evaluate(() => {
  return /belongs to Data Viewer/.test(document.getElementById("routeMsg").textContent) &&
    /Open data-viewer\.us/.test(document.getElementById("routeGo").textContent) &&
    document.activeElement === document.getElementById("routeGo");
}));
await page.keyboard.press("Tab");
const tab1 = await page.evaluate(() => document.activeElement.id);
await page.keyboard.press("Tab");
const tab2 = await page.evaluate(() => document.activeElement.id);
check("router: Tab wraps between the two buttons", tab1 === "routeDismiss" && tab2 === "routeGo");
await page.keyboard.press("Escape");
check("router: Escape dismisses the card", await page.evaluate(() =>
  document.getElementById("routeCard").hidden && document.getElementById("routeBackdrop").hidden));
await page.setInputFiles("#fileInput", join(FIX, "test.json"));
await page.waitForSelector("#routeCard:not([hidden])", { timeout: 5000 });
await page.click("#routeDismiss");
check("router: Not now dismisses the card", await page.evaluate(() => document.getElementById("routeCard").hidden));

// -- unmapped extension keeps the plain rejection toast
await page.setInputFiles("#fileInput", join(FIX, "sample.xyz"));
await page.waitForSelector("#toast.show", { timeout: 5000 });
check("router: unmapped type gets the rejection toast, no card", await page.evaluate(() => {
  return /isn’t a supported audio file/.test(document.getElementById("toast").textContent) &&
    document.getElementById("routeCard").hidden;
}));

// -- receiver: '#fvh' with a hostile hash boots clean and clears the hash
const p3 = await ctx.newPage();
hook(p3);
await p3.goto(`http://localhost:${PORT}/#fvh=%zz`, { waitUntil: "load", timeout: 30000 });
check("receiver: /#fvh=%zz boots clean and clears the hash", await p3.evaluate(() =>
  location.hash === "" && !document.getElementById("empty").hidden));
await p3.close();

// -- receiver: an opener hand-off shows the “Receiving …” empty-state sub-line
const [pop] = await Promise.all([
  ctx.waitForEvent("page"),
  page.evaluate(() => { window.__w = window.open("/#fvh=Song%20Name.mp3"); }),
]);
await pop.waitForLoadState("load");
check("receiver: 'Receiving' sub-line for an opener hand-off", await pop.evaluate(() =>
  /Receiving/.test(document.querySelector(".empty-sub").textContent) &&
  /Song Name\.mp3/.test(document.querySelector(".empty-sub").textContent) &&
  location.hash === ""));
await pop.close();
await ctx.close();

// -- fresh context with dark system scheme: must default dark
const ctx2 = await browser.newContext({ colorScheme: "dark" });
const p2 = await ctx2.newPage();
hook(p2);
await p2.goto(`http://localhost:${PORT}/`, { waitUntil: "load", timeout: 30000 });
check("system-dark default (#0d1117)", await p2.evaluate(() => document.getElementById("bgPicker").value) === "#0d1117");
await ctx2.close();

// -- static assertions
const sz = (p) => (existsSync(join(ROOT, p)) ? statSync(join(ROOT, p)).size : 0);
check("fonts present", sz("fonts/JetBrainsMono-Bold.subset.woff2") > 10000 && sz("fonts/JetBrainsMono-ExtraBold.subset.woff2") > 10000 && sz("fonts/OFL.txt") > 0);
check("favicon.ico present", sz("favicon.ico") > 2000);
check("og.png + apple-touch-icon.png present", sz("og.png") > 10000 && sz("apple-touch-icon.png") > 1000);
check("site.webmanifest valid", (() => { try { return !!JSON.parse(readFileSync(join(ROOT, "site.webmanifest"), "utf8")).name; } catch (e) { return false; } })());
check("llms/ads/security.txt present", sz("llms.txt") > 0 && sz("ads.txt") > 0 && sz(".well-known/security.txt") > 0);
const csp = H["Content-Security-Policy"];
check("CSP: default-src 'none' + media-src 'self' blob: + img data: + fonts/manifest self",
  /default-src 'none'/.test(csp) &&
  /media-src[^;]*'self'/.test(csp) && /media-src[^;]*blob:/.test(csp) &&
  /img-src[^;]*'self'/.test(csp) && /img-src[^;]*data:/.test(csp) &&
  /font-src[^;]*'self'/.test(csp) && /manifest-src 'self'/.test(csp));
check("CSP: no eval anywhere (script-src is inline + Plausible only)",
  /script-src 'unsafe-inline' https:\/\/plausible\.thompsonblack\.us(;|$)/.test(csp) && !/unsafe-eval/.test(csp));
const idx = readFileSync(join(ROOT, "index.html"), "utf8");
check("head links (manifest + favicon.ico)", idx.includes('rel="manifest"') && idx.includes("/favicon.ico"));

// -- FV-MAP block deep-equals the canonical family map (§6.10 governance)
check("FV-MAP deep-equals canonical family-map (v2)", (() => {
  const i = idx.indexOf("/* FV-MAP-START");
  const j = idx.indexOf("/* FV-MAP-END */");
  if (i < 0 || j < 0) return false;
  const got = new Function(idx.slice(i, j) + "\nreturn { FAMILY, FAMILY_HUB, FAMILY_NAMES, FAMILY_MAP };")();
  const mapJson = JSON.parse(readFileSync(join(ROOT, "test/family-map.json"), "utf8"));
  const stable = (v) => JSON.stringify(v, (k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((kk) => [kk, val[kk]]))
      : val);
  return stable(got.FAMILY) === stable(mapJson.family) &&
    stable(got.FAMILY_HUB) === stable(mapJson.hub) &&
    stable(got.FAMILY_NAMES) === stable(mapJson.names) &&
    stable(got.FAMILY_MAP) === stable(mapJson.map);
})());

// External-resource network noise (analytics offline) is allowed; CSP
// violations are worded "Refused to ..." and still fail. The tagged-MP3
// fixture intentionally has no valid MPEG frames, so the media element's
// own load failure is expected where the decoder is missing.
const ALLOW = [/plausible/i, /thompsonblack/i, /net::ERR/i, /Failed to load resource/i];
const real = errs.filter((e) => !ALLOW.some((re) => re.test(e)));
check("no unexpected console/CSP errors", real.length === 0, real[0]);

await browser.close();
server.close();

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  — " + String(detail).slice(0, 160) : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
