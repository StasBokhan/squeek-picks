// Small chain chores for the page tests, against the local chain on 127.0.0.1:8545:
//   node lib/chain.mjs deploy                 a pot like today's (version 3); prints its address
//   node lib/chain.mjs deploy2                a version 2 pot, the one live before version 3
//   node lib/chain.mjs deploy1                a version 1 pot, the one live before the upgrade
//   node lib/chain.mjs buy <pot> <night> <account index> <tenths of km> <peak> <more>
//   node lib/chain.mjs night <pot> <night>    the night's pot and tickets, as JSON
//   node lib/chain.mjs resolver <pot>         who settles it, as JSON
// The owner is account 0 and the payout bot account 1 (hardhat's usual test accounts).
import { ethers } from "ethers";
import { createRequire } from "node:module";
import { ROOT, TESTS } from "./common.mjs";
const require = createRequire(import.meta.url);
const art = require(ROOT + "/contracts/SqueekPot.json");
const art1 = require(ROOT + "/contracts/SqueekPotV1.json");
const L = require(ROOT + "/src/logic.js");
const p = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
const [cmd, ...a] = process.argv.slice(2);
async function version(addr) {
  try { return Number(await new ethers.Contract(addr, ["function VERSION() view returns (uint256)"], p).VERSION()); } catch { return 1; }
}
if (cmd === "deploy") {
  const owner = await p.getSigner(0), bot = await p.getSigner(1);
  const c = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(ethers.parseEther("0.01"), await bot.getAddress());
  await c.waitForDeployment();
  console.log(await c.getAddress());
} else if (cmd === "deploy2") {
  const owner = await p.getSigner(0), bot = await p.getSigner(1);
  const v2 = require(TESTS + "/fixtures/SqueekPotV2.json");
  const c = await new ethers.ContractFactory(v2.abi, v2.bytecode, owner).deploy(ethers.parseEther("0.01"), await bot.getAddress());
  await c.waitForDeployment();
  console.log(await c.getAddress());
} else if (cmd === "deploy1") {
  const owner = await p.getSigner(0), bot = await p.getSigner(1);
  const c = await new ethers.ContractFactory(art1.abi, art1.bytecode, owner).deploy(ethers.parseEther("0.01"));
  await c.waitForDeployment();
  await (await c.setResolver(await bot.getAddress())).wait();
  console.log(await c.getAddress());
} else if (cmd === "buy") {
  const [addr, night, idx, deci, peak, more] = a;
  const s = await p.getSigner(Number(idx));
  const c = new ethers.Contract(addr, (await version(addr)) >= 2 ? art.abi : art1.abi, s);
  await (await c.buyTicket(L.nightToDay(night), Number(deci), Number(peak), more === "true", { value: ethers.parseEther("0.01") })).wait();
  console.log("bought", night, idx);
} else if (cmd === "night") {
  const [addr, night] = a;
  const v = await version(addr);
  const c = new ethers.Contract(addr, v >= 2 ? art.abi : art1.abi, p);
  const n = await c.getNight(L.nightToDay(night));
  const t = L.potTickets(v, n);
  console.log(JSON.stringify({ version: v, pot: n.pot.toString(), status: Number(n.status), players: t.map((x) => x.address), picks: t.map((x) => [Math.round(x.distance_km * 10), x.peak_block, x.more_blocks]) }));
} else if (cmd === "resolver") {
  const c = new ethers.Contract(a[0], art.abi, p);
  console.log(JSON.stringify({ version: await version(a[0]), resolver: await c.resolver() }));
} else {
  console.error("unknown command: " + cmd);
  process.exit(2);
}
process.exit(0);
