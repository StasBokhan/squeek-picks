// Squeek Picks Telegram announcer.
// Runs right after the payout bot (every hour from GitHub Actions) and posts to one
// Telegram channel or group:
//   - the night's results once they're in: distance, the diary write-up, busiest 3 hours,
//     blocks, records he set, and who won the pot and the points game
//   - a last call about an hour before picks close
// It only reads (the Squeekchain API, the pots on Sepolia, the points game) and holds no
// wallet key. What it already posted is kept in a small state file between runs.
//
// Settings (environment variables):
//   TELEGRAM_BOT_TOKEN  the bot's token from @BotFather (a secret; without it nothing is posted)
//   TELEGRAM_CHAT_ID    the channel or group, e.g. @squeekpicks or -1001234567890
//   TIME_ZONE           time zone for the times in posts (optional, Europe/Zurich by default)
//   STATE_FILE          where to remember what was posted (optional)
//   SEPOLIA_RPC_URL, POT_ADDRESS, API_BASE, CONFIG_FILE  as for the payout bot
//   TELEGRAM_API        Telegram's address (optional, for tests)
//   MAINNET_RPC_URL     for ENS names (optional; empty to skip them)
//   DRY_RUN=1           print the posts instead of sending them
//   NOW_MS              override the clock, for tests only

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const L = require("../src/logic.js");
const ABI = {
  1: JSON.parse(readFileSync(new URL("../contracts/SqueekPotV1.json", import.meta.url), "utf8")).abi,
  2: JSON.parse(readFileSync(new URL("../contracts/SqueekPot.json", import.meta.url), "utf8")).abi,
};

const env = process.env;
const TOKEN = (env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT = (env.TELEGRAM_CHAT_ID || "").trim();
const TG_API = env.TELEGRAM_API || "https://api.telegram.org";
const TZ = env.TIME_ZONE || "Europe/Zurich";
const RPC_URL = env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const MAINNET_RPC_URL = env.MAINNET_RPC_URL == null ? "https://ethereum-rpc.publicnode.com" : env.MAINNET_RPC_URL;
const API_BASE = env.API_BASE || "https://api.squeekchain.com";
const CONFIG_FILE = env.CONFIG_FILE || new URL("../config.js", import.meta.url);
const STATE_FILE = env.STATE_FILE || fileURLToPath(new URL("../.bot-state/announce.json", import.meta.url));
const DRY_RUN = env.DRY_RUN === "1";
const NOW = env.NOW_MS ? Number(env.NOW_MS) : Date.now();
const BPS = 10000n;
// Results are posted until this long after a night ends; older ones are skipped, not posted late.
const RESULTS_UNTIL = 12 * L.HOUR;
// The last call goes out between 100 and 5 minutes before picks close.
const CALL_FROM = 100 * 60e3, CALL_UNTIL = 5 * 60e3;

process.on("unhandledRejection", (e) => { console.error(`::error::${e && e.message || e}`); process.exit(1); });

if (!DRY_RUN && (!TOKEN || !CHAT)) {
  console.log("Telegram isn't set up (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID), so nothing to post.");
  process.exit(0);
}

// ----- helpers -----
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const zoneFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, timeZoneName: "short" });
const fmtTime = (ms) => timeFmt.format(new Date(ms));
const zone = (ms) => (zoneFmt.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName") || {}).value || TZ;
const fmtNight = (night) => new Date(night + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const slotTime = (night, i) => fmtTime(L.nightStart(night) + i * 30 * 60e3);
const windowLabel = (night, w) => slotTime(night, w * 6) + "–" + slotTime(night, w * 6 + 6);
const fmtEth = (wei) => {
  const n = Number(wei) / 1e18;
  return n.toLocaleString("en-GB", { maximumFractionDigits: n > 0 && n < 0.01 ? 6 : 4 });
};
const fmtInt = (n) => Math.round(n).toLocaleString("en-GB");
const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

function readConfig() {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(readFileSync(CONFIG_FILE, "utf8"), sandbox, { timeout: 1000 });
    return sandbox.window.SQUEEK_CONFIG || {};
  } catch (e) {
    console.log(`::warning::Couldn't read config.js (${e.message}).`);
    return {};
  }
}
const CONFIG = readConfig();
const SITE = (CONFIG.SITE_URL || env.SITE_URL || "https://squeekpicks.xyz/").replace(/\/?$/, "/");

async function getJson(url, headers) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: Object.assign({ accept: "application/json", "user-agent": "SqueekPicks-announcer/1.0 (+https://squeekpicks.xyz)" }, headers || {}) });
    if ((res.status === 429 || res.status === 503 || res.status === 403) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * Number(res.headers.get("retry-after") || 5 * (attempt + 1))));
      continue;
    }
    if (!res.ok) throw new Error(`${url.split("?")[0]}: HTTP ${res.status}`);
    return res.json();
  }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}
function saveState(st) {
  // Keep two weeks of memory.
  const cutoff = L.addDays(L.liveNightAt(NOW), -14);
  for (const k of ["results", "calls"]) for (const n of Object.keys(st[k] || {})) if (n < cutoff) delete st[k][n];
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 1) + "\n");
}

async function send(text) {
  if (DRY_RUN) { console.log("---- would post ----\n" + text + "\n--------------------"); return; }
  const res = await fetch(`${TG_API}/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    // Never print the token: Telegram's own description only.
    throw new Error(`Telegram refused the post: ${body.description || "HTTP " + res.status}. Check TELEGRAM_CHAT_ID and that the bot is an admin of the channel.`);
  }
}

// ----- data -----
async function loadHamster() {
  const [statsRaw, setRaw] = await Promise.all([
    getJson(API_BASE + "/v1/measurement/stats?range=30d"),
    getJson(API_BASE + "/v1/settlements?range=30d").catch(() => null),
  ]);
  const s = L.parseStats(statsRaw), b = L.parseSettlements(setRaw);
  if (!s) throw new Error("The Squeekchain API returned no activity data.");
  return {
    raw: statsRaw, stats: s, blocks: b,
    data: {
      nights: s.nights, statsAt: s.at, statsFrom: s.from, firstAt: s.firstAt,
      blocks: b ? b.blocks : new Map(), blocksAt: b ? b.at : 0, blocksFrom: b ? b.from : 0, settledTs: b ? b.settledTs : 0,
    },
  };
}

// Each pot's record for a night: status, pot size and tickets.
async function loadPots(nights) {
  const seen = new Set(), out = [];
  const list = [env.POT_ADDRESS, CONFIG.POT_ADDRESS].concat(Array.isArray(CONFIG.OLD_POTS) ? CONFIG.OLD_POTS : []);
  const addresses = [];
  for (const a of list) {
    if (!a || !ethers.isAddress(a)) continue;
    const addr = ethers.getAddress(a);
    if (!seen.has(addr)) { seen.add(addr); addresses.push(addr); }
  }
  if (!addresses.length) return out;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  for (const addr of addresses) {
    if ((await provider.getCode(addr)) === "0x") continue;
    let version = 1;
    try { version = Number(await new ethers.Contract(addr, ["function VERSION() view returns (uint256)"], provider).VERSION()); } catch { /* version 1 */ }
    if (!ABI[version]) continue;
    const pot = new ethers.Contract(addr, ABI[version], provider);
    for (const night of nights) {
      const n = await pot.getNight(L.nightToDay(night));
      out.push({ addr, version, night, price: BigInt(n.price), pot: BigInt(n.pot), status: Number(n.status), tickets: L.potTickets(version, n) });
    }
  }
  return out;
}

// Names: ENS for wallets, when a mainnet RPC is set; else short addresses.
const ensCache = new Map();
let ensProvider = null;
async function walletName(addr) {
  if (ensCache.has(addr)) return ensCache.get(addr);
  let name = null;
  if (MAINNET_RPC_URL) {
    try {
      ensProvider = ensProvider || new ethers.JsonRpcProvider(MAINNET_RPC_URL, "mainnet", { staticNetwork: true });
      name = await Promise.race([ensProvider.lookupAddress(addr), new Promise((r) => setTimeout(() => r(null), 8000))]);
    } catch { name = null; }
  }
  const label = name || shortAddr(addr);
  ensCache.set(addr, label);
  return label;
}

// The points game's picks for a night, and the nicknames, from Supabase (public once locked).
async function loadPoints(night) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return null;
  const h = { apikey: CONFIG.SUPABASE_ANON_KEY, authorization: "Bearer " + CONFIG.SUPABASE_ANON_KEY };
  const base = CONFIG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/";
  const picks = await getJson(base + "picks?select=player_id,distance_km,peak_block,more_blocks&night=eq." + night + "&limit=10000", h);
  if (!picks.length) return { picks: [], names: new Map() };
  const ids = [...new Set(picks.map((p) => p.player_id))];
  const players = await getJson(base + "players?select=id,nickname&id=in.(" + ids.map(encodeURIComponent).join(",") + ")", h);
  return {
    picks: picks.map((p) => ({ player_id: p.player_id, distance_km: Number(p.distance_km), peak_block: Number(p.peak_block), more_blocks: !!p.more_blocks })),
    names: new Map(players.map((p) => [p.id, p.nickname])),
  };
}

// ----- the posts -----
async function resultsPost(night, H, pots, points) {
  const res = L.resolveNight(night, NOW, H.data);
  const markets = [res.distance, res.peak, res.blocks];
  if (markets.some((m) => m.state === "wait" || m.state === "live")) return { wait: "the night's results aren't all in yet" };

  // Pots: wait for the payout bot unless it's been a while.
  const recs = pots.filter((p) => p.night === night && p.tickets.length);
  for (const p of recs) {
    const out = L.potPayouts(res, p.tickets);
    if (p.status === 0 && out.action !== "wait" && NOW < L.nightEnd(night) + 6 * L.HOUR) return { wait: "the pot isn't paid out yet" };
  }

  // The diary write-up, as the site shows it.
  const recRaw = H.raw.records || {};
  const recNight = (r) => (r && Date.parse(r.occurredAt) ? L.liveNightAt(Date.parse(r.occurredAt)) : null);
  const finished = [];
  for (const [k, n] of H.stats.nights) {
    if (NOW < L.nightEnd(k) || (!n.coverageBps && !n.work)) continue;
    finished.push({ night: k, km: n.distanceKm, coverageBps: n.coverageBps, slots: n.slots, blocks: null, prevBlocks: null });
  }
  finished.sort((a, b) => (a.night < b.night ? -1 : 1));
  finished.forEach((n) => { n.facts = L.nightFacts(n); });
  const me = finished.find((n) => n.night === night);
  const firstAt = Date.parse((H.raw.lifetime || {}).firstObservedAt) || H.stats.firstAt;
  const ctx = {
    habits: L.diaryHabits(finished.filter((n) => n.night <= night)),
    firstNight: firstAt ? L.liveNightAt(firstAt) : finished[0] && finished[0].night,
    rec: { run: recNight(recRaw.longestActiveWindowMinutes), halfHour: recNight(recRaw.mostWorkHalfHour),
      halfHourAt: recRaw.mostWorkHalfHour && Date.parse(recRaw.mostWorkHalfHour.occurredAt) },
  };

  const lines = [];
  const km = res.distance.state === "resolved" ? res.distance.km : me ? me.km : null;
  lines.push(`🐹 <b>${esc(fmtNight(night))}</b>: Squeektoshi ran <b>${km != null ? km.toFixed(1) + " km" : "an unknown distance"}</b>`);
  if (me) lines.push(esc(L.describeNight(me, ctx, (i) => slotTime(night, i), fmtTime)));
  lines.push("");
  if (res.peak.state === "resolved") lines.push(`Busiest 3 hours: <b>${esc(res.peak.winners.map((w) => windowLabel(night, w)).join(", "))}</b> (${esc(zone(L.nightStart(night)))})`);
  else if (res.peak.state === "void") lines.push(`Busiest 3 hours: no call (${esc(res.peak.reason)})`);
  if (res.blocks.state === "resolved") lines.push(`Squeek blocks: <b>${fmtInt(res.blocks.cur)}</b>, ${res.blocks.more ? "more" : "fewer"} than the night before (${fmtInt(res.blocks.prev)})`);
  else if (res.blocks.state === "void") lines.push(`Squeek blocks: no call (${esc(res.blocks.reason)})`);

  // Records set that night.
  const recs2 = [];
  if (recNight(recRaw.maximumDailyDistanceMm) === night) recs2.push(`farthest night (${(Number(recRaw.maximumDailyDistanceMm.value) / 1e6).toFixed(1)} km)`);
  if (recNight(recRaw.longestActiveWindowMinutes) === night) {
    const m = Number(recRaw.longestActiveWindowMinutes.value);
    recs2.push(`longest non-stop run (${m >= 60 ? (m % 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : plural(m / 60, "hour", "hours")) : m + " min"})`);
  }
  if (recNight(recRaw.mostWorkHalfHour) === night) recs2.push(`busiest half hour (${fmtInt(Number(recRaw.mostWorkHalfHour.value))} spins)`);
  if (recNight(recRaw.peakObservedSpeedMmPerSecond) === night) recs2.push(`top speed (${(Number(recRaw.peakObservedSpeedMmPerSecond.value) * 0.0036).toFixed(1)} km/h)`);
  if (recs2.length) lines.push(`🏆 New record${recs2.length > 1 ? "s" : ""}: ${esc(recs2.join(", "))}`);

  // Who won.
  const won = [];
  for (const p of recs) {
    const out = L.potPayouts(res, p.tickets);
    if (p.status === 2 || out.action === "void") { won.push(`Pot: cancelled, ${plural(p.tickets.length, "ticket", "tickets")} can be refunded`); continue; }
    if (out.action !== "settle") continue;
    const byId = new Map(p.tickets.map((t) => [t.player_id, t]));
    const best = out.ranking[0], t = byId.get(best.player_id);
    const prize = p.pot * BigInt(out.bps[0]) / BPS;
    won.push(`Pot: <b>${esc(await walletName(t.address))}</b> won ${fmtEth(prize)} ETH with ${best.points} points (${plural(p.tickets.length, "ticket", "tickets")}, ${fmtEth(p.pot)} ETH)` +
      (p.status === 1 ? "" : ", paying out now"));
  }
  if (points && points.picks.length) {
    const rows = L.liveStandings(res, points.picks);
    if (rows.length && rows[0].score.counted && rows[0].score.total > 0) {
      const tops = rows.filter((r) => r.place === 1);
      won.push(`Points game: ${tops.length > 1 ? plural(tops.length, "player", "players") + " shared the top" : "<b>" + esc(points.names.get(rows[0].entry.player_id) || "a player") + "</b> on top"} with ${rows[0].score.total} points (${plural(points.picks.length, "player", "players")})`);
    }
  }
  if (won.length) { lines.push(""); won.forEach((w) => lines.push(w)); }
  lines.push("");
  lines.push(`His diary: ${SITE}diary`);
  lines.push(`Call tonight's run: ${SITE}`);
  return { text: lines.join("\n") };
}

async function lastCallPost(open, H, pots) {
  const close = L.nightStart(open);
  const left = Math.max(1, Math.round((close - NOW) / 60e3));
  const p = pots.find((x) => x.night === open && x.tickets.length) || pots.find((x) => x.night === open);
  const lines = [`⏰ <b>Last call:</b> picks for the night of ${esc(fmtNight(open))} close at ${esc(fmtTime(close))} ${esc(zone(close))}, in ${left >= 60 ? Math.floor(left / 60) + " h " + (left % 60) + " min" : left + " minutes"}.`];
  if (p && p.tickets.length) lines.push(`Pot so far: <b>${fmtEth(p.pot)} ETH</b> from ${plural(p.tickets.length, "ticket", "tickets")}.`);
  // One hint from his recent nights.
  const finished = [];
  for (const [k, n] of H.stats.nights) if (NOW >= L.nightEnd(k) && (n.coverageBps || n.work)) finished.push({ night: k, km: n.distanceKm, slots: n.slots, facts: L.nightFacts({ slots: n.slots }) });
  finished.sort((a, b) => (a.night < b.night ? -1 : 1));
  const h = L.diaryHabits(finished);
  if (h.topIdx >= 0) lines.push(`Hint: ${esc(windowLabel(open, h.topIdx))} was his busiest on ${h.top} of his last ${plural(h.ran, "night", "nights")}, and he ran ${h.kmMin.toFixed(1)} to ${h.kmMax.toFixed(1)} km.`);
  lines.push(`Free for points, or a ticket in the test-ETH pot: ${SITE}`);
  return { text: lines.join("\n") };
}

// ----- main -----
const state = loadState();
state.results = state.results || {};
state.calls = state.calls || {};
const live = L.liveNightAt(NOW), last = L.addDays(live, -1), open = L.addDays(live, 1);
const wantResults = !state.results[last] && NOW < L.nightEnd(last) + RESULTS_UNTIL;
const toClose = L.nightStart(open) - NOW;
const wantCall = !state.calls[open] && toClose <= CALL_FROM && toClose >= CALL_UNTIL;

if (!wantResults && !wantCall) {
  console.log("Nothing to post right now.");
} else {
  const H = await loadHamster();
  const pots = await loadPots([last, open]);
  if (wantResults) {
    let points = null;
    try { points = await loadPoints(last); } catch (e) { console.log(`::warning::Points game unavailable (${e.message}).`); }
    const r = await resultsPost(last, H, pots, points);
    if (r.wait) console.log(`Results for ${last}: waiting, ${r.wait}.`);
    else {
      await send(r.text);
      state.results[last] = new Date(NOW).toISOString();
      console.log(`::notice::Posted the results for ${last} to Telegram.`);
    }
  }
  if (wantCall) {
    const r = await lastCallPost(open, H, pots);
    await send(r.text);
    state.calls[open] = new Date(NOW).toISOString();
    console.log(`::notice::Posted the last call for ${open} to Telegram.`);
  }
  if (!DRY_RUN) saveState(state);
}
