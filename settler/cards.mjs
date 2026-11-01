// Night Cards bot: after each season night's results are final, records his run on the Night
// Cards contract and mints each player's card to the wallet they linked. After a season ends,
// the champion gets the Legendary card. Safe to run as often as you like: a card is minted
// once per player and night, and the contract refuses a second one.
//
// Settings (environment variables):
//   SETTLER_PRIVATE_KEY  the payout bot's key, which is also the cards' minter
//   SEPOLIA_RPC_URL      as for the payout bot (optional)
//   CARDS_ADDRESS        the Night Cards contract (optional; else config.js CARDS_ADDRESS)
//   CONFIG_FILE, API_BASE, NOW_MS, DRY_RUN   as for the other bots

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const L = require("../src/logic.js");
const env = process.env;
const RPC_URL = env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const API_BASE = env.API_BASE || "https://api.squeekchain.com";
const CONFIG_FILE = env.CONFIG_FILE || new URL("../config.js", import.meta.url);
const NOW = env.NOW_MS ? Number(env.NOW_MS) : Date.now();
const DRY_RUN = env.DRY_RUN === "1";
const ABI = JSON.parse(readFileSync(new URL("../contracts/SqueekNightCards.json", import.meta.url), "utf8")).abi;
const SETTLE_AFTER = 30 * 60e3;   // results are final a while after the night ends

const fail = (m) => { console.log(`::error::${String(m).slice(0, 400)}`); process.exit(1); };
process.on("unhandledRejection", (e) => fail(e && (e.shortMessage || e.message) || e));

function readConfig() {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(readFileSync(CONFIG_FILE, "utf8"), sandbox, { timeout: 1000 });
    return sandbox.window.SQUEEK_CONFIG || {};
  } catch (e) { return {}; }
}
const CONFIG = readConfig();
const SEASONS = Array.isArray(CONFIG.SEASONS) ? CONFIG.SEASONS : [];
const CARDS = (env.CARDS_ADDRESS || CONFIG.CARDS_ADDRESS || "").trim();
if (!CARDS || !ethers.isAddress(CARDS)) { console.log("No Night Cards contract set (CARDS_ADDRESS), nothing to do."); process.exit(0); }
if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) { console.log("No points game database set, nothing to do."); process.exit(0); }

// The season nights whose results should be final by now.
const nights = [], seasonsDone = [];
for (const x of SEASONS) {
  const s = x && x.start ? L.seasonOf(x.start, SEASONS) : null;
  if (!s) continue;
  for (let k = 0; k < s.nights; k++) {
    const n = L.addDays(s.start, k);
    if (NOW >= L.nightEnd(n) + SETTLE_AFTER && NOW < L.nightEnd(n) + 30 * L.DAY) nights.push(n);
  }
  if (NOW >= L.nightEnd(s.last) + SETTLE_AFTER && NOW < L.nightEnd(s.last) + 30 * L.DAY) seasonsDone.push(s);
}
if (!nights.length) { console.log("No finished season nights to mint for."); process.exit(0); }

// ----- data -----
async function getJson(url, headers) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: Object.assign({ "user-agent": "squeek-picks-cards/1.0" }, headers || {}) });
    if (res.ok) return res.json();
    if (i < 2 && (res.status === 403 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 2000 * (i + 1))); continue; }
    throw new Error(`${url.split("?")[0]} answered ${res.status}`);
  }
}
const [statsRaw, setRaw] = await Promise.all([
  getJson(API_BASE + "/v1/measurement/stats?range=30d"),
  getJson(API_BASE + "/v1/settlements?range=30d").catch(() => null),
]);
const st = L.parseStats(statsRaw), sb = L.parseSettlements(setRaw);
if (!st) fail("The Squeekchain API returned no activity data.");
const H = {
  nights: st.nights, statsAt: st.at, statsFrom: st.from, firstAt: st.firstAt,
  blocks: sb ? sb.blocks : new Map(), blocksAt: sb ? sb.at : 0, blocksFrom: sb ? sb.from : 0, settledTs: sb ? sb.settledTs : 0,
};
let DIARY = null;
try { DIARY = JSON.parse(readFileSync(new URL("../data/diary.json", import.meta.url), "utf8")).nights || null; } catch (e) { DIARY = null; }
const slotsOf = (date) => {
  const d = DIARY && DIARY[date];
  if (d && d.slots) return d.slots.map((x) => (x == null ? null : Number(x)));
  const n = H.nights.get(date);
  return n ? n.slots : null;
};

const SB = CONFIG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/";
const sbH = { apikey: CONFIG.SUPABASE_ANON_KEY, authorization: "Bearer " + CONFIG.SUPABASE_ANON_KEY };
const sbGet = (path) => getJson(SB + path, sbH);
async function pointsNight(night) {
  const picks = (await sbGet("picks?select=*&night=eq." + night + "&limit=10000")).map((p) => ({
    player_id: p.player_id, distance_km: Number(p.distance_km), peak_block: Number(p.peak_block), more_blocks: !!p.more_blocks, double_market: p.double_market || null,
  }));
  let answers = [];
  try { answers = (await sbGet("call_answers?select=player_id,call_no,over&night=eq." + night + "&limit=10000")).map((a) => ({ player_id: a.player_id, call_no: Number(a.call_no), over: !!a.over })); }
  catch (e) { answers = []; }
  return { picks, answers };
}
// Linked wallets, only where the signature proves the wallet asked for the cards.
const wallets = new Map();
try {
  for (const w of await sbGet("wallet_links?select=player_id,wallet,message,signature&limit=10000")) {
    try {
      if (w.message !== L.linkMessage(w.wallet, w.player_id)) continue;
      if (ethers.verifyMessage(w.message, w.signature).toLowerCase() !== String(w.wallet).toLowerCase()) continue;
      wallets.set(w.player_id, ethers.getAddress(w.wallet));
    } catch (e) { /* a bad signature: no cards to that wallet */ }
  }
} catch (e) { console.log(`::warning::Couldn't read linked wallets (${e.message}).`); }
console.log(`${wallets.size} players linked a wallet.`);
if (!wallets.size) { console.log("Nobody to send cards to yet."); process.exit(0); }

// ----- chain -----
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
let signer = null;
if (!DRY_RUN) {
  try { signer = new ethers.Wallet(String(env.SETTLER_PRIVATE_KEY || "").trim(), provider); }
  catch { fail("SETTLER_PRIVATE_KEY is not a valid private key."); }
}
const cards = new ethers.Contract(CARDS, ABI, signer || provider);
if ((await provider.getCode(CARDS)) === "0x") fail(`No contract at ${CARDS}.`);
if (signer) {
  const minter = await cards.minter();
  if (minter.toLowerCase() !== signer.address.toLowerCase()) fail(`The bot wallet ${signer.address} is not the cards' minter (${minter}). Set it with "Minter" on the admin page.`);
}
const keyOf = (night, tag) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint32", "string"], [L.nightToDay(night), tag]));

async function recordIfNeeded(night, res) {
  const day = L.nightToDay(night);
  if ((await cards.run(day)).set) return true;
  const slots = slotsOf(night), n = H.nights.get(night);
  if (!slots || !n) { console.log(`  ${night}: no half-hour data, can't draw the card yet.`); return false; }
  const vals = slots.map((x) => Number(x || 0)), max = Math.max(...vals) || 1;
  const spokes = "0x" + vals.map((v) => Math.round((v / max) * 255).toString(16).padStart(2, "0")).join("");
  const km = Math.min(999, Math.round(n.distanceKm * 10));
  const peak = res.peak.state === "resolved" ? res.peak.winners[0] : 255;
  const blocks = Math.min(65535, H.blocks.get(night) || 0);
  const more = res.blocks.state === "resolved" ? (res.blocks.more ? 1 : 0) : 2;
  if (DRY_RUN) { console.log(`  ${night}: would record his run (${(km / 10).toFixed(1)} km).`); return true; }
  await (await cards.recordNight(day, spokes, km, peak, blocks, more)).wait();
  console.log(`  ${night}: recorded his run (${(km / 10).toFixed(1)} km).`);
  return true;
}
async function mintIfNeeded(to, night, kind, points, key, label) {
  if (Number(await cards.cardFor(key)) !== 0) return false;
  if (DRY_RUN) { console.log(`  would mint ${L.CARD_RARITY[kind]} "${L.CARD_KINDS[kind]}" (${points} pts) to ${to} for ${label}`); return true; }
  await (await cards.mint(to, L.nightToDay(night), kind, points, key)).wait();
  console.log(`::notice::Minted ${L.CARD_RARITY[kind]} "${L.CARD_KINDS[kind]}" for ${label} to ${to}.`);
  return true;
}

let minted = 0;
const seasonPoints = new Map();   // season start -> Map(player -> { points, best: { night, points } })
for (const night of nights) {
  const res = L.resolveNight(night, NOW, H);
  const lines = {}, callResults = {};
  for (const c of L.CALLS) { lines[c.no] = L.callLine(night, c.no, slotsOf); callResults[c.no] = L.resolveCall(night, c.no, NOW, H); }
  const pending = [res.distance, res.peak, res.blocks].some((m) => m.state === "wait" || m.state === "live") ||
    L.CALLS.some((c) => lines[c.no] != null && ["open", "live", "wait"].includes(callResults[c.no].state));
  if (pending) { console.log(`${night}: results not final yet.`); continue; }
  const { picks, answers } = await pointsNight(night);
  const earned = L.nightCards(res, picks, answers, lines, callResults);
  const s = L.seasonOf(night, SEASONS), tally = seasonPoints.get(s.start) || new Map();
  seasonPoints.set(s.start, tally);
  // Season totals (every player, for the champion), from the same scoring as the page.
  const scores = L.scoreGame(res, picks, SEASONS), calls = L.scoreCalls(answers, lines, callResults);
  new Set([...scores.keys(), ...calls.keys()]).forEach((id) => {
    const p = (scores.get(id) && scores.get(id).counted ? scores.get(id).total : 0) + (calls.get(id) ? calls.get(id).points : 0);
    const t = tally.get(id) || { points: 0, best: null };
    t.points += p;
    if (!t.best || p > t.best.points) t.best = { night, points: p };
    tally.set(id, t);
  });
  const mine = [...earned].filter(([id]) => wallets.has(id));
  console.log(`${night}: ${earned.size} cards earned, ${mine.length} with a linked wallet.`);
  if (!mine.length) continue;
  if (!(await recordIfNeeded(night, res))) continue;
  for (const [id, c] of mine) if (await mintIfNeeded(wallets.get(id), night, c.kind, c.points, keyOf(night, id), night)) minted++;
}

// Champions: once a season's last night is final, the top player gets the Legendary card,
// showing their best night of the season.
for (const s of seasonsDone) {
  const tally = seasonPoints.get(s.start);
  const lastIn = nights.indexOf(s.last) >= 0 && tally;
  if (!lastIn) continue;
  const rows = [...tally.entries()].filter(([, t]) => t.points > 0).sort((a, b) => b[1].points - a[1].points);
  if (!rows.length) continue;
  const top = rows.filter(([, t]) => t.points === rows[0][1].points);
  for (const [id, t] of top) {
    if (!wallets.has(id)) { console.log(`${s.name} champion hasn't linked a wallet yet.`); continue; }
    const res = L.resolveNight(t.best.night, NOW, H);
    if (!(await recordIfNeeded(t.best.night, res))) continue;
    if (await mintIfNeeded(wallets.get(id), t.best.night, 4, Math.min(t.points, 65535), keyOf(s.start, "champion:" + id), s.name + " champion")) minted++;
  }
}
console.log(minted ? `Done: ${minted} card${minted === 1 ? "" : "s"} ${DRY_RUN ? "would be " : ""}minted.` : "No new cards to mint.");
