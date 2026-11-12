// Capture key screens at phone and desktop widths with the system Edge/Chrome.
//   BASE_URL=http://localhost:3000 OUT=./shots node scripts/screenshots.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "shots";
const CHANNEL = process.env.BROWSER_CHANNEL ?? "msedge";
fs.mkdirSync(OUT, { recursive: true });

async function login(ctx, user) {
  const res = await ctx.request.post(`${BASE}/api/auth/signin`, { data: { login: user, password: "sidebet-demo" } });
  if (!res.ok()) throw new Error(`login ${user} failed`);
}

async function contestIds(ctx) {
  const html = await (await ctx.request.get(`${BASE}/admin`)).text();
  const ids = {};
  for (const m of html.matchAll(/href="\/admin\/c\/([0-9a-f-]{36})"[^>]*>([^<]+)</g)) ids[m[2]] = m[1];
  return ids;
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const admin = await browser.newContext();
await login(admin, "commish");
const ids = await contestIds(admin);
const chess = ids["Northgate Chess Championship Draft"];
const bet = ids["Comets vs Owls: who wins?"];
const race = ids["Backyard Race Day"];

const pages = [
  ["landing", "/", null],
  ["home", "/", "jordan"],
  ["chess", `/c/${chess}`, "jordan"],
  ["bet", `/c/${bet}`, "casey"],
  ["race", `/c/${race}`, "riley"],
  ["wallet", "/wallet", "jordan"],
  ["profile", "/u/jordan", "jordan"],
  ["private-denied", `/c/${chess}`, "casey"],
  ["admin", "/admin", "commish"],
  ["admin-scoring", `/admin/c/${chess}?tab=scoring`, "commish"],
  ["admin-results", `/admin/c/${race}?tab=results`, "commish"],
  ["admin-settle", `/admin/c/${bet}?tab=settle`, "commish"],
  ...(process.env.EXTRA ? JSON.parse(process.env.EXTRA) : []),
];
const sizes = [
  ["desktop", { width: 1280, height: 900 }],
  ["phone", { width: 390, height: 844 }],
];
const only = process.env.ONLY?.split(",");
for (const [name, url, user] of pages) {
  if (only && !only.includes(name)) continue;
  for (const [sz, viewport] of sizes) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: sz === "phone", hasTouch: sz === "phone" });
    if (user) await login(ctx, user);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(BASE + url, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const file = path.join(OUT, `${name}-${sz}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`${file}${overflow > 0 ? `  HORIZONTAL OVERFLOW ${overflow}px` : ""}${errors.length ? `  ERRORS: ${errors.slice(0, 2).join(" | ")}` : ""}`);
    await ctx.close();
  }
}
await browser.close();
