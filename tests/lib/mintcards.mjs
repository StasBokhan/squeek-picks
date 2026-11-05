// node lib/mintcards.mjs <rpc> <to>: deploys Night Cards (owner account 0, minter account 1),
// records two real nights of Squeektoshi's running, and mints 2 cards to <to>. Prints the address.
import { ethers } from "ethers";
import { createRequire } from "node:module";
import { ROOT } from "./common.mjs";
const require = createRequire(import.meta.url);
const art = require(ROOT + "/contracts/SqueekNightCards.json");
// Work units per half hour, from noon (copied from the diary, so the tests don't depend on it).
const SLOTS = {
  "2026-10-29": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 155, 260, 1776, 1648, 1628, 1643, 1596, 1094, 1438, 0, 0, 0, 0, 1394, 466, 0, 0, 0, 0, 0, 0, 199, 0, 0, 0, 0, 0, 0, 0, 0],
  "2026-10-27": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 714, 907, 1827, 198, 0, 0, 0, 1148, 1723, 1502, 92, 1274, 0, 0, 0, 0, 0, 898, 608, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
const [rpc, to] = process.argv.slice(2);
const p = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
const owner = await p.getSigner(0), bot = await p.getSigner(1);
const c = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(await bot.getAddress()); await c.waitForDeployment();
const day = (n) => Math.round(Date.parse(n + "T00:00:00Z") / 86400e3);
for (const [n, km, peak, blocks, more] of [["2026-10-29", 117, 3, 1141, 1], ["2026-10-27", 96, 4, 980, 0]]) {
  await (await c.connect(bot).recordNight(day(n), "0x" + SLOTS[n].map((v) => v.toString(16).padStart(4, "0")).join(""), km, peak, blocks, more)).wait();
}
const key = (n, id) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint32", "string"], [day(n), id]));
await (await c.connect(bot).mint(to, day("2026-10-29"), 1, 62, key("2026-10-29", "me"))).wait();
await (await c.connect(bot).mint(to, day("2026-10-27"), 3, 75, key("2026-10-27", "me"))).wait();
console.log(c.target);
process.exit(0);
