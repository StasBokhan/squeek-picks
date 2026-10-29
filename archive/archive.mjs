// Saves Squeektoshi's finished nights to data/diary.json, once a day from GitHub Actions.
// The Squeekchain API only keeps the last 30 days, so this is how the diary keeps nights
// for longer. Nights still inside the API's 30 days are refreshed on every run (late data
// can fill a gap); older nights stay as they were saved.
//
// Needs no packages and no secrets: it only reads the public API and writes one file.
//
// Settings (environment variables):
//   API_BASE     Squeekchain API (optional)
//   DIARY_FILE   where to write (optional, data/diary.json in the repository by default)
//   NOW_MS       override the clock, for tests only

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const L = require("../src/logic.js");
const env = process.env;
const API_BASE = env.API_BASE || "https://api.squeekchain.com";
const FILE = env.DIARY_FILE || fileURLToPath(new URL("../data/diary.json", import.meta.url));
const NOW = env.NOW_MS ? Number(env.NOW_MS) : Date.now();
// A night's block count is final about 20 minutes after it ends.
const BLOCKS_FINAL_AFTER = 20 * 60e3;

// Errors show up as annotations on the Actions run.
process.on("uncaughtException", (e) => { console.error(`::error::${e.message}`); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(`::error::${e && e.message || e}`); process.exit(1); });

async function api(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API_BASE + path, { headers: { accept: "application/json", "user-agent": "SqueekPicks-diary/1.0 (+https://squeekpicks.xyz)" } });
    if ((res.status === 429 || res.status === 503 || res.status === 403) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after") || 5 * (attempt + 1));
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`${path}: HTTP ${res.status} ${body}`);
    }
    return res.json();
  }
}

function load() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); }
  catch (e) { return { nights: {} }; }
}

const raw = await api("/v1/measurement/stats?range=30d");
const stats = L.parseStats(raw);
if (!stats) throw new Error("The stats answer had no activity data.");
let settlements = null;
try { settlements = L.parseSettlements(await api("/v1/settlements?range=30d")); }
catch (e) { console.log(`Block counts not available this time (${e.message}); keeping the saved ones.`); }

// Days before Squeekchain started recording come back empty; they aren't nights he had.
function empty(n) { return !n || (!n.coverageBps && !n.work); }
const old = load();
const nights = {};
for (const [k, v] of Object.entries(old.nights || {})) if (!empty(v)) nights[k] = v;
let added = 0, refreshed = 0;
for (const [night, n] of stats.nights) {
  if (NOW < L.nightEnd(night)) continue;            // still running
  if (empty(n)) continue;                            // no data at all for that day
  const prev = nights[night];
  const blocksFinal = NOW >= L.nightEnd(night) + BLOCKS_FINAL_AFTER;
  const blocks = settlements && blocksFinal && settlements.blocks.has(night) ? settlements.blocks.get(night) : prev ? prev.blocks : null;
  const rec = {
    km: Math.round(n.distanceKm * 1000) / 1000,
    coverageBps: n.coverageBps,
    work: n.work,
    // Wheel work per half hour, 12:00 UTC first. null where the API has no reading.
    slots: n.slots.map((v) => (v == null ? null : Math.round(v))),
    blocks: blocks == null ? null : blocks,
  };
  if (!prev) added++;
  else if (JSON.stringify(prev) !== JSON.stringify(rec)) refreshed++;
  nights[night] = rec;
}

const sorted = Object.fromEntries(Object.keys(nights).sort().map((k) => [k, nights[k]]));
const next = {
  about: "Squeektoshi's finished nights, saved once a day from the Squeekchain API. A night runs 12:00 to 12:00 UTC and is named by its first day. km is the distance run, slots the wheel work per half hour from 12:00 UTC, blocks the Squeek blocks settled that night.",
  firstObservedAt: raw.lifetime && raw.lifetime.firstObservedAt || old.firstObservedAt || null,
  lifetime: raw.lifetime || old.lifetime || null,
  records: raw.records || old.records || null,
  nights: sorted,
};
const same = JSON.stringify(Object.assign({}, old, { updatedAt: undefined })) === JSON.stringify(Object.assign({}, next, { updatedAt: undefined }));
if (same) {
  console.log(`Nothing new. ${Object.keys(sorted).length} nights saved.`);
} else {
  next.updatedAt = new Date(NOW).toISOString();
  mkdirSync(dirname(FILE), { recursive: true });
  // One night per line, so each day's commit shows as one added line.
  const body = Object.entries(sorted).map(([k, v]) => "  " + JSON.stringify(k) + ": " + JSON.stringify(v)).join(",\n");
  const text = JSON.stringify(Object.assign({}, next, { nights: "@@NIGHTS@@" }), null, 1)
    .replace('"@@NIGHTS@@"', body ? "{\n" + body + "\n }" : "{}");
  writeFileSync(FILE, text + "\n");
  console.log(`Saved ${Object.keys(sorted).length} nights (${added} new, ${refreshed} updated).`);
}
