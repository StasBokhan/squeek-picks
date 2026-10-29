// All-time numbers for the page's stats line, saved to data/stats.json once a day:
// pot tickets sold, wallets that played, test ETH paid to winners and refunded, nights
// paid out, plus the points game's players and calls.
//
// Pot numbers come from each pot's own state, night by night (public RPC endpoints only
// keep a few hours of event history, so events can't be counted later). Nights older than
// 30 days are kept as they were saved; newer ones are read again each run, since refunds
// can still come in.
//
// Settings (environment variables):
//   SEPOLIA_RPC_URL, POT_ADDRESS, CONFIG_FILE   as for the payout bot
//   STATS_FILE        where to write (optional, data/stats.json in the repository)
//   FIRST_SCAN_NIGHTS how many nights back a pot's first scan starts (optional, 45)
//   NOW_MS            override the clock, for tests only

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const L = require("../src/logic.js");
const env = process.env;
const RPC_URL = env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CONFIG_FILE = env.CONFIG_FILE || new URL("../config.js", import.meta.url);
const FILE = env.STATS_FILE || fileURLToPath(new URL("../data/stats.json", import.meta.url));
const FIRST_SCAN_NIGHTS = Number(env.FIRST_SCAN_NIGHTS || 45);
const NOW = env.NOW_MS ? Number(env.NOW_MS) : Date.now();
const FROZEN_AFTER = 30; // nights; older ones are final
const ABI = {
  1: JSON.parse(readFileSync(new URL("../contracts/SqueekPotV1.json", import.meta.url), "utf8")).abi,
  2: JSON.parse(readFileSync(new URL("../contracts/SqueekPot.json", import.meta.url), "utf8")).abi,
};

const fail = (m) => { console.log(`::error::${String(m).slice(0, 400)}`); process.exit(1); };
process.on("unhandledRejection", (e) => fail(e && (e.shortMessage || e.message) || e));
process.on("uncaughtException", (e) => fail(e && (e.shortMessage || e.message) || e));

function readConfig() {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(readFileSync(CONFIG_FILE, "utf8"), sandbox, { timeout: 1000 });
    return sandbox.window.SQUEEK_CONFIG || {};
  } catch (e) { return {}; }
}
function load() { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch (e) { return {}; } }

const CONFIG = readConfig();
const old = load();
const provider = new ethers.JsonRpcProvider(RPC_URL);
const live = L.liveNightAt(NOW), frozenBefore = L.addDays(live, -FROZEN_AFTER);

const addrs = [];
for (const a of [env.POT_ADDRESS, CONFIG.POT_ADDRESS].concat(Array.isArray(CONFIG.OLD_POTS) ? CONFIG.OLD_POTS : [])) {
  if (a && ethers.isAddress(a) && !addrs.includes(ethers.getAddress(a))) addrs.push(ethers.getAddress(a));
}

const pots = {};
for (const addr of addrs) {
  if ((await provider.getCode(addr)) === "0x") { console.log(`No contract at ${addr}, skipped.`); continue; }
  let version = 1;
  try { version = Number(await new ethers.Contract(addr, ["function VERSION() view returns (uint256)"], provider).VERSION()); } catch { /* version 1 */ }
  const pot = new ethers.Contract(addr, ABI[version] || ABI[2], provider);
  const prev = (old.pots && old.pots[addr]) || {};
  const nights = Object.assign({}, prev.nights || {});
  const saved = Object.keys(nights).sort();
  // From the earliest saved night (or FIRST_SCAN_NIGHTS back) to tonight; frozen nights stay.
  let night = saved.length ? saved[0] : L.addDays(live, -FIRST_SCAN_NIGHTS);
  for (; night <= live; night = L.addDays(night, 1)) {
    if (night < frozenBefore && nights[night]) continue;
    const n = await pot.getNight(L.nightToDay(night));
    const tickets = L.potTickets(version, n);
    if (!tickets.length) { delete nights[night]; continue; }
    const price = BigInt(n.price);
    nights[night] = {
      status: Number(n.status),
      tickets: tickets.length,
      wallets: [...new Set(tickets.map((t) => t.address.toLowerCase()))],
      potWei: BigInt(n.pot).toString(),
      // A refund pays back each of the wallet's tickets at the night's price.
      refundedWei: (price * BigInt(tickets.filter((t) => t.refunded).length)).toString(),
    };
  }
  const list = Object.values(nights);
  pots[addr] = {
    version,
    tickets: list.reduce((a, x) => a + x.tickets, 0),
    paidWei: list.filter((x) => x.status === 1).reduce((a, x) => a + BigInt(x.potWei), 0n).toString(),
    refundedWei: list.reduce((a, x) => a + BigInt(x.refundedWei), 0n).toString(),
    nightsPaid: list.filter((x) => x.status === 1).length,
    nightsCancelled: list.filter((x) => x.status === 2).length,
    nights: Object.fromEntries(Object.keys(nights).sort().map((k) => [k, nights[k]])),
  };
  console.log(`Pot ${addr} (version ${version}): ${pots[addr].tickets} tickets, ${ethers.formatEther(pots[addr].paidWei)} ETH paid out.`);
}

// The free points game, from Supabase (picks are public once their night has started).
async function count(table) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return null;
  const res = await fetch(CONFIG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + table + "?select=*&limit=1", {
    headers: { apikey: CONFIG.SUPABASE_ANON_KEY, authorization: "Bearer " + CONFIG.SUPABASE_ANON_KEY, prefer: "count=exact" },
  });
  const n = Number((res.headers.get("content-range") || "").split("/")[1]);
  return res.ok && Number.isFinite(n) ? n : null;
}
let players = null, calls = null;
try { [players, calls] = await Promise.all([count("players"), count("picks")]); }
catch (e) { console.log(`::warning::Points game counts unavailable (${e.message}).`); }

const all = Object.values(pots);
const nightsAll = all.flatMap((p) => Object.values(p.nights));
const next = {
  about: "All-time numbers for the stats line on the page, updated once a day. Pot numbers come from each pot's state on Sepolia; players and calls from the points game.",
  players: players != null ? players : old.players != null ? old.players : null,
  calls: calls != null ? calls : old.calls != null ? old.calls : null,
  potTickets: all.reduce((a, p) => a + p.tickets, 0),
  potWallets: new Set(nightsAll.flatMap((x) => x.wallets)).size,
  paidWei: all.reduce((a, p) => a + BigInt(p.paidWei), 0n).toString(),
  refundedWei: all.reduce((a, p) => a + BigInt(p.refundedWei), 0n).toString(),
  nightsPaid: all.reduce((a, p) => a + p.nightsPaid, 0),
  pots,
};
const strip = (o) => JSON.stringify(Object.assign({}, o, { updatedAt: undefined }));
if (strip(old) === strip(next)) {
  console.log("Stats unchanged.");
} else {
  next.updatedAt = new Date(NOW).toISOString();
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 1) + "\n");
  console.log(`Saved: ${next.players} players, ${next.calls} calls, ${next.potTickets} pot tickets, ${ethers.formatEther(next.paidWei)} ETH paid out.`);
}
