// All-time numbers for the page's stats line, saved to data/stats.json once a day:
// pot tickets sold, wallets that played, test ETH paid to winners and refunded, nights
// paid out. It reads each pot's events from the chain, picking up where the last run
// stopped, so every run only reads the newest blocks.
//
// Settings (environment variables):
//   SEPOLIA_RPC_URL, POT_ADDRESS, CONFIG_FILE   as for the payout bot
//   STATS_FILE   where to write (optional, data/stats.json in the repository)
//   FIRST_SCAN_DAYS  how far back a pot's first scan starts (optional, 45)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ethers } from "ethers";

const env = process.env;
const RPC_URL = env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CONFIG_FILE = env.CONFIG_FILE || new URL("../config.js", import.meta.url);
const FILE = env.STATS_FILE || fileURLToPath(new URL("../data/stats.json", import.meta.url));
const FIRST_SCAN_DAYS = Number(env.FIRST_SCAN_DAYS || 45);
const BLOCKS_PER_DAY = 7200; // Sepolia: a block every 12 seconds
const ABI = {
  1: JSON.parse(readFileSync(new URL("../contracts/SqueekPotV1.json", import.meta.url), "utf8")).abi,
  2: JSON.parse(readFileSync(new URL("../contracts/SqueekPot.json", import.meta.url), "utf8")).abi,
};

process.on("unhandledRejection", (e) => { console.error(`::error::${e && e.message || e}`); process.exit(1); });
process.on("uncaughtException", (e) => { console.error(`::error::${e && e.message || e}`); process.exit(1); });

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
const pots = Object.assign({}, old.pots || {});
// Some RPC plans limit event reads; the public endpoint is the fallback for those.
const PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const publicProvider = RPC_URL === PUBLIC_RPC ? null : new ethers.JsonRpcProvider(PUBLIC_RPC);
let provider = new ethers.JsonRpcProvider(RPC_URL);
let latest;
try { latest = await provider.getBlockNumber(); }
catch (e) { console.log(`::error::Couldn't reach the Sepolia RPC: ${(e.shortMessage || e.message || e).toString().slice(0, 300)}`); process.exit(1); }

const addrs = [];
for (const a of [env.POT_ADDRESS, CONFIG.POT_ADDRESS].concat(Array.isArray(CONFIG.OLD_POTS) ? CONFIG.OLD_POTS : [])) {
  if (a && ethers.isAddress(a) && !addrs.includes(ethers.getAddress(a))) addrs.push(ethers.getAddress(a));
}

for (const addr of addrs) {
  if ((await provider.getCode(addr)) === "0x") { console.log(`No contract at ${addr}, skipped.`); continue; }
  let version = 1;
  try { version = Number(await new ethers.Contract(addr, ["function VERSION() view returns (uint256)"], provider).VERSION()); } catch { /* version 1 */ }
  const iface = new ethers.Interface(ABI[version] || ABI[2]);
  const p = pots[addr] || { version, scannedTo: Math.max(0, latest - FIRST_SCAN_DAYS * BLOCKS_PER_DAY), tickets: 0, wallets: [], paidWei: "0", refundedWei: "0", nightsPaid: 0, nightsCancelled: 0 };
  const wallets = new Set(p.wallets.map((w) => w.toLowerCase()));
  let paid = BigInt(p.paidWei), refunded = BigInt(p.refundedWei), chunk = 10000;
  let from = p.scannedTo + 1;
  while (from <= latest) {
    const to = Math.min(latest, from + chunk - 1);
    let logs;
    try { logs = await provider.getLogs({ address: addr, fromBlock: from, toBlock: to }); }
    catch (e) {
      if (chunk <= 500) {
        const why = JSON.stringify((e.info && (e.info.error || e.info.responseBody)) || e.error || e.shortMessage || e.message || String(e)).slice(0, 400);
        if (publicProvider && provider !== publicProvider) { console.log(`Event reads failed on SEPOLIA_RPC_URL (${why}); using the public endpoint.`); provider = publicProvider; chunk = 10000; continue; }
        console.log(`::error::Reading pot ${addr} events failed: ${why}`); process.exit(1);
      }
      chunk = Math.floor(chunk / 4); continue;
    }
    for (const log of logs) {
      let ev;
      try { ev = iface.parseLog(log); } catch { continue; }
      if (!ev) continue;
      if (ev.name === "TicketBought") { p.tickets++; wallets.add(String(ev.args.player).toLowerCase()); }
      else if (ev.name === "NightSettled") { p.nightsPaid++; for (const a of ev.args.amounts) paid += BigInt(a); }
      else if (ev.name === "NightVoided") p.nightsCancelled++;
      else if (ev.name === "Refunded") refunded += BigInt(ev.args.amount);
    }
    p.scannedTo = to;
    from = to + 1;
  }
  p.version = version;
  p.wallets = [...wallets].sort();
  p.paidWei = paid.toString();
  p.refundedWei = refunded.toString();
  pots[addr] = p;
  console.log(`Pot ${addr} (version ${version}): ${p.tickets} tickets, ${ethers.formatEther(paid)} ETH paid, scanned to block ${p.scannedTo}.`);
}

// The free points game, from Supabase (only picks for nights that have started are public).
async function count(table) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return null;
  const res = await fetch(CONFIG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + table + "?select=*&limit=1", {
    headers: { apikey: CONFIG.SUPABASE_ANON_KEY, authorization: "Bearer " + CONFIG.SUPABASE_ANON_KEY, prefer: "count=exact" },
  });
  const range = res.headers.get("content-range") || "";
  const n = Number(range.split("/")[1]);
  return res.ok && Number.isFinite(n) ? n : null;
}
let players = null, calls = null;
try { [players, calls] = await Promise.all([count("players"), count("picks")]); }
catch (e) { console.log(`::warning::Points game counts unavailable (${e.message}).`); }

const all = Object.values(pots);
const wallets = new Set(all.flatMap((p) => p.wallets));
const next = {
  about: "All-time numbers for the stats line on the page, updated once a day. Pot numbers come from the pots' events on Sepolia; players and calls from the points game.",
  players: players != null ? players : old.players != null ? old.players : null,
  calls: calls != null ? calls : old.calls != null ? old.calls : null,
  potTickets: all.reduce((a, p) => a + p.tickets, 0),
  potWallets: wallets.size,
  paidWei: all.reduce((a, p) => a + BigInt(p.paidWei), 0n).toString(),
  refundedWei: all.reduce((a, p) => a + BigInt(p.refundedWei), 0n).toString(),
  nightsPaid: all.reduce((a, p) => a + p.nightsPaid, 0),
  pots,
};
const strip = (o) => JSON.stringify(Object.assign({}, o, { updatedAt: undefined, pots: Object.fromEntries(Object.entries(o.pots || {}).map(([k, v]) => [k, Object.assign({}, v, { scannedTo: 0 })])) }));
if (strip(old) === strip(next)) {
  console.log("Stats unchanged.");
} else {
  next.updatedAt = new Date().toISOString();
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 1) + "\n");
  console.log(`Saved: ${next.players} players, ${next.calls} calls, ${next.potTickets} pot tickets, ${ethers.formatEther(next.paidWei)} ETH paid out.`);
}
