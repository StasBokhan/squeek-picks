// Checks a pot before the page switches to it, and shows where every pot stands.
// Reads only; holds no wallet key. Run it from the Actions tab ("Check a pot").
//
// For each pot (the one given, plus POT_ADDRESS and OLD_POTS from config.js) it reports
// the version, owner, payout bot, ticket price and the tickets for the running night and
// the night on sale. For the pot given, it also checks the code on chain is exactly what
// contracts/SqueekPot.json deploys, and that its payout bot matches the current pot's.
//
// Settings (environment variables):
//   SEPOLIA_RPC_URL   the RPC to read from (optional, a public one by default)
//   CHECK_ADDRESS     the pot to check (optional)
//   CHECK_CARDS       a Night Cards contract to check before config.js points at it (optional):
//                     its code must be exactly what contracts/SqueekNightCards.json deploys, its
//                     owner the pot's owner and its minter the pot's payout bot
//   CONFIG_FILE       config.js (optional, the repository's)
//   NOW_MS            override the clock, for tests only

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const L = require("../src/logic.js");
const env = process.env;
const RPC_URL = env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CONFIG_FILE = env.CONFIG_FILE || new URL("../config.js", import.meta.url);
const NOW = env.NOW_MS ? Number(env.NOW_MS) : Date.now();
const ART = JSON.parse(readFileSync(new URL("../contracts/SqueekPot.json", import.meta.url), "utf8"));
const ABI = {
  1: JSON.parse(readFileSync(new URL("../contracts/SqueekPotV1.json", import.meta.url), "utf8")).abi,
  2: ART.abi,
  3: ART.abi,
};
const STATUS = ["open", "settled", "voided"];

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
const provider = new ethers.JsonRpcProvider(RPC_URL);
const { chainId } = await provider.getNetwork();
const live = L.liveNightAt(NOW), open = L.openNightAt(NOW);
console.log(`Chain ${chainId}. Running night ${live}, on sale ${open}.`);

const check = env.CHECK_ADDRESS && ethers.isAddress(env.CHECK_ADDRESS.trim()) ? ethers.getAddress(env.CHECK_ADDRESS.trim()) : null;
if (env.CHECK_ADDRESS && !check) fail(`${env.CHECK_ADDRESS} isn't an address.`);
const current = CONFIG.POT_ADDRESS && ethers.isAddress(CONFIG.POT_ADDRESS) ? ethers.getAddress(CONFIG.POT_ADDRESS) : null;
const list = [];
for (const a of [check, current].concat(Array.isArray(CONFIG.OLD_POTS) ? CONFIG.OLD_POTS : [])) {
  if (a && ethers.isAddress(a) && !list.includes(ethers.getAddress(a))) list.push(ethers.getAddress(a));
}

const info = {};
for (const addr of list) {
  const code = await provider.getCode(addr);
  if (code === "0x") { console.log(`::warning::No contract at ${addr}.`); continue; }
  let version = 1;
  try { version = Number(await new ethers.Contract(addr, ["function VERSION() view returns (uint256)"], provider).VERSION()); } catch { /* version 1 */ }
  const pot = new ethers.Contract(addr, ABI[version] || ART.abi, provider);
  const [owner, resolver, price, held] = await Promise.all([pot.owner(), pot.resolver(), pot.ticketPrice(), provider.getBalance(addr)]);
  const pending = version >= 3 ? await pot.pendingOwner() : null;
  const nights = [];
  for (const night of [live, open]) {
    const n = await pot.getNight(L.nightToDay(night));
    const tickets = L.potTickets(version, n);
    nights.push(`${night} ${tickets.length} tickets${tickets.length ? " " + STATUS[Number(n.status)] : ""}`);
  }
  info[addr] = { version, owner, resolver, code, openTickets: Number(nights[1].split(" ")[1]) };
  const role = addr === check ? "checked" : addr === current ? "current" : "old";
  console.log(`::notice::Pot ${addr} (${role}, version ${version}): owner ${owner}${pending && pending !== ethers.ZeroAddress ? `, offered to ${pending}` : ""}, payout bot ${resolver}, price ${ethers.formatEther(price)} ETH, holds ${ethers.formatEther(held)} ETH. Nights: ${nights.join("; ")}.`);
}

if (check && info[check]) {
  const c = info[check], problems = [];
  // An eth_call that creates the contract returns the code it would leave on chain.
  let expected = null;
  try {
    const args = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address"], [1n, c.resolver]);
    expected = await provider.call({ data: ART.bytecode + args.slice(2) });
  } catch (e) { console.log(`::warning::Couldn't simulate the deployment to compare code (${e.shortMessage || e.message}).`); }
  if (expected && expected !== c.code) problems.push("its code is not what contracts/SqueekPot.json deploys");
  if (c.version !== 3) problems.push(`it is version ${c.version}, not 3`);
  if (current && info[current] && current !== check) {
    if (c.resolver !== info[current].resolver) problems.push(`its payout bot ${c.resolver} isn't the current pot's (${info[current].resolver})`);
    if (c.owner !== info[current].owner) problems.push(`its owner ${c.owner} isn't the current pot's (${info[current].owner})`);
  }
  if (problems.length) fail(`Pot ${check}: ${problems.join("; ")}.`);
  const others = current && info[current] && current !== check ? info[current].openTickets : 0;
  console.log(`::notice::Pot ${check} checks out: version 3${expected ? ", code identical to contracts/SqueekPot.json" : ""}, same owner and payout bot as the current pot. ` +
    (others ? `The current pot already has ${others} tickets for ${open}: switch after picks close, so that night isn't split.` : `The current pot has no tickets for ${open}, so the page can switch now.`));
}

const cardsAt = env.CHECK_CARDS && env.CHECK_CARDS.trim();
if (cardsAt) {
  if (!ethers.isAddress(cardsAt)) fail(`${cardsAt} isn't an address.`);
  const addr = ethers.getAddress(cardsAt), CARDS = JSON.parse(readFileSync(new URL("../contracts/SqueekNightCards.json", import.meta.url), "utf8"));
  const code = await provider.getCode(addr);
  if (code === "0x") fail(`No contract at ${addr}.`);
  const cards = new ethers.Contract(addr, CARDS.abi, provider);
  const [owner, minter, name, minted] = await Promise.all([cards.owner(), cards.minter(), cards.name(), cards.totalMinted()]);
  const problems = [];
  let expected = null;
  try { expected = await provider.call({ data: CARDS.bytecode + ethers.AbiCoder.defaultAbiCoder().encode(["address"], [minter]).slice(2) }); }
  catch (e) { console.log(`::warning::Couldn't simulate the deployment to compare code (${e.shortMessage || e.message}).`); }
  if (expected && expected !== code) problems.push("its code is not what contracts/SqueekNightCards.json deploys (an older page version?)");
  const pot = current && info[current];
  if (pot && owner !== pot.owner) problems.push(`its owner ${owner} isn't the pot's owner (${pot.owner})`);
  if (pot && minter !== pot.resolver) problems.push(`its minter ${minter} isn't the payout bot (${pot.resolver})`);
  if (problems.length) fail(`Night Cards ${addr}: ${problems.join("; ")}.`);
  console.log(`::notice::Night Cards ${addr} checks out: "${name}"${expected ? ", code identical to contracts/SqueekNightCards.json" : ""}, owner ${owner}, minter ${minter} (the payout bot), ${minted} cards minted so far.`);
}
