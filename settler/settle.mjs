// Squeek Picks payout bot.
// Runs every hour from GitHub Actions. For each finished night with tickets that
// isn't paid out yet, it fetches the night's results from the Squeekchain API,
// ranks the tickets with the same rules the page uses (src/logic.js), and then
// pays the winners or voids the night so everyone can refund.
//
// It looks after every pot it knows: POT_ADDRESS and OLD_POTS from config.js, plus
// the POT_ADDRESS setting below. Old pots keep getting paid out until their last
// nights are done. Each pot's version is read from the chain:
//   version 1  one ticket per wallet, winners paid by wallet address
//   version 2  up to 5 tickets per wallet, winners paid by ticket number
//
// Settings (environment variables):
//   SETTLER_PRIVATE_KEY  key of the bot wallet; must be the pots' resolver (required)
//   POT_ADDRESS          a pot address, added to the ones in config.js (optional)
//   SEPOLIA_RPC_URL      Sepolia RPC endpoint (optional, a public one by default)
//   API_BASE             Squeekchain API (optional)
//   CONFIG_FILE          path of config.js (optional, the repository's by default)
//   DRY_RUN=1            show what it would do without sending transactions
//   NOW_MS               override the clock, for tests only

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const L = require("../src/logic.js");
// Version 3 keeps every function and event of version 2 that the bots use, so its ABI reads both.
const POT_ABI = JSON.parse(readFileSync(new URL("../contracts/SqueekPot.json", import.meta.url), "utf8")).abi;
const ABI = {
  1: JSON.parse(readFileSync(new URL("../contracts/SqueekPotV1.json", import.meta.url), "utf8")).abi,
  2: POT_ABI,
  3: POT_ABI,
};

const env = process.env;
const RPC_URL = env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const API_BASE = env.API_BASE || "https://api.squeekchain.com";
const CONFIG_FILE = env.CONFIG_FILE || new URL("../config.js", import.meta.url);
const DRY_RUN = env.DRY_RUN === "1";
const ALLOWED_CHAINS = [11155111n, 31337n];
const STATUS = ["open", "settled", "voided"];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function api(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API_BASE + path, { headers: { accept: "application/json", "user-agent": "SqueekPicks-payout/1.0 (+https://squeekpicks.xyz)" } });
    // 403 too: the API has refused a request now and then and answered the next one.
    if ((res.status === 429 || res.status === 503 || res.status === 403) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after") || 5 * (attempt + 1));
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }
}

// The pot addresses in config.js: the current one and any old ones still finishing.
function configPots() {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(readFileSync(CONFIG_FILE, "utf8"), sandbox, { timeout: 1000 });
    const c = sandbox.window.SQUEEK_CONFIG || {};
    return [c.POT_ADDRESS].concat(Array.isArray(c.OLD_POTS) ? c.OLD_POTS : []);
  } catch (e) {
    console.log(`::warning::Couldn't read config.js (${e.message}). Using POT_ADDRESS only.`);
    return [];
  }
}

async function main() {
  if (!env.SETTLER_PRIVATE_KEY) fail("SETTLER_PRIVATE_KEY is missing.");
  const seen = new Set(), addresses = [];
  for (const a of [env.POT_ADDRESS].concat(configPots())) {
    if (!a || !ethers.isAddress(a)) continue;
    const addr = ethers.getAddress(a);
    if (!seen.has(addr)) { seen.add(addr); addresses.push(addr); }
  }
  if (!addresses.length) fail("No pot address. Put POT_ADDRESS in config.js.");

  // No response caching: the bot may send several transactions in a row and needs fresh nonces.
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const { chainId } = await provider.getNetwork();
  if (!ALLOWED_CHAINS.includes(chainId)) fail(`Connected to chain ${chainId}; this bot only runs on Sepolia.`);

  let wallet;
  try { wallet = new ethers.Wallet(env.SETTLER_PRIVATE_KEY.trim(), provider); }
  catch { fail("SETTLER_PRIVATE_KEY is not a valid private key."); }
  const gas = await provider.getBalance(wallet.address);
  console.log(`Bot ${wallet.address}, gas balance ${ethers.formatEther(gas)} SepoliaETH`);
  if (gas < ethers.parseEther("0.002")) console.log("::warning::The bot wallet is low on Sepolia ETH for gas. Top it up from a faucet.");

  const chainNow = Number((await provider.getBlock("latest")).timestamp) * 1000;
  const now = env.NOW_MS ? Number(env.NOW_MS) : Date.now();
  const live = L.liveNightAt(chainNow);
  const problems = [];

  // Every pot's finished nights still inside the 3-day payout window.
  const candidates = [];
  for (const addr of addresses) {
    if ((await provider.getCode(addr)) === "0x") { problems.push(`No contract at ${addr}.`); continue; }
    let version = 1;
    try { version = Number(await new ethers.Contract(addr, ["function VERSION() view returns (uint256)"], provider).VERSION()); }
    catch { /* version 1 has no VERSION() */ }
    if (!ABI[version]) { problems.push(`Pot ${addr} is version ${version}, which this bot doesn't know.`); continue; }
    const pot = new ethers.Contract(addr, ABI[version], wallet);
    const resolver = await pot.resolver();
    if (resolver.toLowerCase() !== wallet.address.toLowerCase()) {
      problems.push(`The bot wallet ${wallet.address} is not the payout wallet of pot ${addr} (${resolver}). Set it with "Set payout bot" on the admin page.`);
      continue;
    }
    console.log(`Pot ${addr} (version ${version})`);
    const seen = [];
    for (let k = 1; k <= 3; k++) {
      const night = L.addDays(live, -k);
      const day = L.nightToDay(night);
      const end = L.nightEnd(night);
      if (chainNow < end || chainNow >= end + 3 * L.DAY) continue;
      const n = await pot.getNight(day);
      const tickets = L.potTickets(version, n);
      const status = STATUS[Number(n.status)];
      console.log(`  Night ${night}: ${tickets.length} tickets, pot ${ethers.formatEther(n.pot)}, ${status}`);
      seen.push(`${night} ${tickets.length} tickets ${tickets.length ? status : ""}`.trim());
      if (status !== "open" || tickets.length === 0) continue;
      candidates.push({ addr, version, pot, night, day, tickets });
    }
    // Shown on the run's page in GitHub Actions, so you can see each night's state at a glance.
    if (seen.length) console.log(`::notice::Pot ${addr.slice(0, 8)}… (version ${version}): ${seen.join("; ")}`);
  }

  if (candidates.length) {
    const [stats, settlements] = await Promise.all([
      api("/v1/measurement/stats?range=30d"),
      api("/v1/settlements?range=30d"),
    ]);
    const s = L.parseStats(stats), b = L.parseSettlements(settlements);
    if (!s || !b) {
      console.log("::warning::The Squeekchain API returned no usable data. Will try again next hour.");
    } else {
      const data = {
        nights: s.nights, statsAt: s.at, statsFrom: s.from, firstAt: s.firstAt,
        blocks: b.blocks, blocksAt: b.at, blocksFrom: b.from, settledTs: b.settledTs,
      };
      for (const c of candidates) {
        const res = L.resolveNight(c.night, now, data);
        const out = L.potPayouts(res, c.tickets);
        const answers = `distance ${res.distance.state}${res.distance.km != null ? " " + res.distance.km.toFixed(2) + " km" : ""}, ` +
          `peak ${res.peak.state}${res.peak.winners ? " window " + res.peak.winners.join("/") : ""}, ` +
          `blocks ${res.blocks.state}${res.blocks.state === "resolved" ? (res.blocks.more ? " more" : " fewer") : ""}`;
        console.log(`Pot ${c.addr.slice(0, 8)}… night ${c.night}: ${answers} -> ${out.action}${out.reason ? " (" + out.reason + ")" : ""}`);

        if (out.action === "wait") { console.log(`::notice::Night ${c.night} on pot ${c.addr.slice(0, 8)}… is waiting: ${out.reason}`); continue; }
        if (out.action === "void") {
          if (DRY_RUN) { console.log("  dry run: would void"); continue; }
          const tx = await c.pot.voidNight(c.day);
          await tx.wait();
          console.log(`  voided in ${tx.hash}`);
          console.log(`::notice::Night ${c.night} cancelled on pot ${c.addr.slice(0, 8)}…, tickets can be refunded (${tx.hash})`);
          continue;
        }
        const byId = new Map(c.tickets.map((t) => [t.player_id, t]));
        out.ranking.slice(0, 5).forEach((r) => {
          const t = byId.get(r.player_id);
          console.log(`  #${r.place} ${t.address}${c.version >= 2 ? " ticket " + t.index : ""}: ${r.points} pts, ${r.bps / 100}%`);
        });
        // Version 1 pays wallets; version 2 pays ticket numbers.
        const winners = out.winners.map((id) => (c.version >= 2 ? byId.get(id).index : byId.get(id).address));
        if (DRY_RUN) { console.log("  dry run: would settle"); continue; }
        const tx = await c.pot.settle(c.day, winners, out.bps);
        await tx.wait();
        console.log(`  paid out in ${tx.hash}`);
        console.log(`::notice::Night ${c.night} settled on pot ${c.addr.slice(0, 8)}…, winners sent their share (${tx.hash})`);
      }
    }
  } else {
    console.log("Nothing to pay out.");
    console.log("::notice::Nothing to pay out: every finished night with tickets is already settled.");
  }

  if (problems.length) {
    problems.forEach((p) => console.error(`::error::${p}`));
    process.exit(1);
  }
}

main().catch((e) => fail(e.shortMessage || e.message || String(e)));
