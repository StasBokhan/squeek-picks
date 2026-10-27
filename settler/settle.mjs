// Squeek Picks payout bot.
// Runs every hour from GitHub Actions. For each finished night with tickets that
// isn't paid out yet, it fetches the night's results from the Squeekchain API,
// ranks the tickets with the same rules the page uses (src/logic.js), and then
// pays the winners or voids the night so everyone can refund.
//
// Settings (environment variables):
//   SETTLER_PRIVATE_KEY  key of the bot wallet; must be the pot's resolver (required)
//   POT_ADDRESS          the pot contract address (required)
//   SEPOLIA_RPC_URL      Sepolia RPC endpoint (optional, a public one by default)
//   API_BASE             Squeekchain API (optional)
//   DRY_RUN=1            show what it would do without sending transactions
//   NOW_MS               override the clock, for tests only

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const L = require("../src/logic.js");
const artifact = JSON.parse(readFileSync(new URL("../contracts/SqueekPot.json", import.meta.url), "utf8"));

const env = process.env;
const RPC_URL = env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const API_BASE = env.API_BASE || "https://api.squeekchain.com";
const DRY_RUN = env.DRY_RUN === "1";
const ALLOWED_CHAINS = [11155111n, 31337n];
const STATUS = ["open", "settled", "voided"];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function api(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API_BASE + path, { headers: { accept: "application/json" } });
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after") || 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }
}

async function main() {
  if (!env.POT_ADDRESS || !ethers.isAddress(env.POT_ADDRESS)) fail("POT_ADDRESS is missing or not an address.");
  if (!env.SETTLER_PRIVATE_KEY) fail("SETTLER_PRIVATE_KEY is missing.");

  // No response caching: the bot may send two transactions in a row and needs fresh nonces.
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const { chainId } = await provider.getNetwork();
  if (!ALLOWED_CHAINS.includes(chainId)) fail(`Connected to chain ${chainId}; this bot only runs on Sepolia.`);

  let wallet;
  try { wallet = new ethers.Wallet(env.SETTLER_PRIVATE_KEY.trim(), provider); }
  catch { fail("SETTLER_PRIVATE_KEY is not a valid private key."); }
  const pot = new ethers.Contract(env.POT_ADDRESS, artifact.abi, wallet);

  const resolver = await pot.resolver();
  if (resolver.toLowerCase() !== wallet.address.toLowerCase()) {
    fail(`The bot wallet ${wallet.address} is not the pot's payout wallet (${resolver}). Set it with "Set payout bot" on the admin page.`);
  }
  const gas = await provider.getBalance(wallet.address);
  console.log(`Bot ${wallet.address}, gas balance ${ethers.formatEther(gas)} SepoliaETH`);
  if (gas < ethers.parseEther("0.002")) console.log("::warning::The bot wallet is low on Sepolia ETH for gas. Top it up from a faucet.");

  const chainNow = Number((await provider.getBlock("latest")).timestamp) * 1000;
  const now = env.NOW_MS ? Number(env.NOW_MS) : Date.now();
  const live = L.liveNightAt(chainNow);

  // Finished nights still inside the 3-day payout window.
  const candidates = [];
  for (let k = 1; k <= 3; k++) {
    const night = L.addDays(live, -k);
    const day = L.nightToDay(night);
    const end = L.nightEnd(night);
    if (chainNow < end || chainNow >= end + 3 * L.DAY) continue;
    const n = await pot.getNight(day);
    const status = STATUS[Number(n.status)];
    console.log(`Night ${night}: ${n.players.length} tickets, pot ${ethers.formatEther(n.pot)}, ${status}`);
    if (status !== "open" || n.players.length === 0) continue;
    candidates.push({ night, day, n });
  }
  if (!candidates.length) { console.log("Nothing to pay out."); return; }

  const [stats, settlements] = await Promise.all([
    api("/v1/measurement/stats?range=30d"),
    api("/v1/settlements?range=30d"),
  ]);
  const s = L.parseStats(stats), b = L.parseSettlements(settlements);
  if (!s || !b) { console.log("::warning::The Squeekchain API returned no usable data. Will try again next hour."); return; }
  const data = {
    nights: s.nights, statsAt: s.at, statsFrom: s.from, firstAt: s.firstAt,
    blocks: b.blocks, blocksAt: b.at, blocksFrom: b.from, settledTs: b.settledTs,
  };

  for (const { night, day, n } of candidates) {
    const tickets = n.players.map((addr, i) => ({
      player_id: addr.toLowerCase(),
      address: addr,
      distance_km: Number(n.picks[i].distanceDeci) / 10,
      peak_block: Number(n.picks[i].peakBlock),
      more_blocks: n.picks[i].moreBlocks,
      boughtAt: Number(n.picks[i].boughtAt),
    }));
    const res = L.resolveNight(night, now, data);
    const out = L.potPayouts(res, tickets);
    const answers = `distance ${res.distance.state}${res.distance.km != null ? " " + res.distance.km.toFixed(2) + " km" : ""}, ` +
      `peak ${res.peak.state}${res.peak.winners ? " window " + res.peak.winners.join("/") : ""}, ` +
      `blocks ${res.blocks.state}${res.blocks.state === "resolved" ? (res.blocks.more ? " more" : " fewer") : ""}`;
    console.log(`Night ${night}: ${answers} -> ${out.action}${out.reason ? " (" + out.reason + ")" : ""}`);

    if (out.action === "wait") continue;
    if (out.action === "void") {
      if (DRY_RUN) { console.log("  dry run: would void"); continue; }
      const tx = await pot.voidNight(day);
      await tx.wait();
      console.log(`  voided in ${tx.hash}`);
      continue;
    }
    const byId = new Map(tickets.map((t) => [t.player_id, t.address]));
    const winners = out.winners.map((id) => byId.get(id));
    out.ranking.slice(0, 5).forEach((r) => console.log(`  #${r.place} ${byId.get(r.player_id)} ${r.points} pts, ${r.bps / 100}%`));
    if (DRY_RUN) { console.log("  dry run: would settle"); continue; }
    const tx = await pot.settle(day, winners, out.bps);
    await tx.wait();
    console.log(`  paid out in ${tx.hash}`);
  }
}

main().catch((e) => fail(e.shortMessage || e.message || String(e)));
