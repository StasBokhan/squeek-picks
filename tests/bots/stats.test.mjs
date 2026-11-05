// stats.mjs on a local chain with a fake Supabase.
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import { ROOT, startChain, scratch } from "../lib/common.mjs";

const require = createRequire(import.meta.url);
const TMP = scratch("stats");
const L = require(ROOT + "/src/logic.js");
const art2 = require(ROOT + "/contracts/SqueekPot.json");
const art1 = require(ROOT + "/contracts/SqueekPotV1.json");
const STATS = ROOT + "/settler/stats.mjs";
const CONFIG = TMP + "/config.js";
const FILE = TMP + "/stats.json";
const KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"];
const RPC = "http://127.0.0.1:8547";
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const node = startChain(8547);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
let counts = { players: 41, picks: 230 };
const supa = http.createServer((req, res) => {
  const t = req.url.startsWith("/rest/v1/players") ? "players" : req.url.startsWith("/rest/v1/picks") ? "picks" : null;
  if (!t || req.headers.apikey !== "anon" || req.headers.prefer !== "count=exact") { res.writeHead(400); return res.end(); }
  res.writeHead(200, { "content-type": "application/json", "content-range": "0-0/" + counts[t] }); res.end("[{}]");
}).listen(8795);
let NOW = 0;
const run = () => new Promise((resolve) => {
  const p = spawn("node", [STATS], { env: { ...process.env, SEPOLIA_RPC_URL: RPC, CONFIG_FILE: CONFIG, STATS_FILE: FILE, NOW_MS: String(NOW) } });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("close", (status) => resolve({ status, out }));
});
try {
  const owner = new ethers.Wallet(KEYS[0], provider), bot = new ethers.Wallet(KEYS[1], provider);
  const S = await Promise.all([2, 3, 4].map((i) => provider.getSigner(i)));
  const price = ethers.parseEther("0.01");
  const v1 = await new ethers.ContractFactory(art1.abi, art1.bytecode, owner).deploy(price); await v1.waitForDeployment();
  await (await v1.setResolver(bot.address)).wait();
  const v2 = await new ethers.ContractFactory(art2.abi, art2.bytecode, owner).deploy(price, bot.address); await v2.waitForDeployment();
  writeFileSync(CONFIG, `window.SQUEEK_CONFIG = { SUPABASE_URL: "http://127.0.0.1:8795", SUPABASE_ANON_KEY: "anon", POT_ADDRESS: "${v2.target}", OLD_POTS: ["${v1.target}"] };\n`);
  const t0 = Number((await provider.getBlock("latest")).timestamp) * 1000, D = L.openNightAt(t0), day = L.nightToDay(D);
  NOW = L.nightEnd(L.addDays(D, 2)) + 3600e3;
  await (await v1.connect(S[0]).buyTicket(day, 96, 3, true, { value: price })).wait();
  await (await v1.connect(S[1]).buyTicket(day, 50, 0, false, { value: price })).wait();
  await (await v2.connect(S[0]).buyTicket(day, 96, 3, true, { value: price })).wait();
  await (await v2.connect(S[0]).buyTicket(day, 90, 2, true, { value: price })).wait();
  await (await v2.connect(S[2]).buyTicket(day, 70, 1, false, { value: price })).wait();
  await provider.send("evm_setNextBlockTimestamp", [Math.floor(L.nightEnd(D) / 1000) + 3600]); await provider.send("evm_mine", []);
  await (await v1.connect(bot).settle(day, [S[0].address, S[1].address], [6250, 3750])).wait();
  await (await v2.connect(bot).voidNight(day)).wait();
  await (await v2.connect(S[0]).refund(day)).wait();

  if (existsSync(FILE)) rmSync(FILE);
  let r = await run(), d = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  check("first run counts both pots", r.status === 0 && d.potTickets === 5 && d.potWallets === 3 && d.paidWei === (price * 2n).toString() && d.nightsPaid === 1, r.out + JSON.stringify(d).slice(0, 300));
  check("refunds counted separately", d.refundedWei === (price * 2n).toString(), d.refundedWei);
  check("points game counts from Supabase", d.players === 41 && d.calls === 230, `${d.players} ${d.calls}`);
  r = await run();
  check("second run changes nothing", /Stats unchanged/.test(r.out) && JSON.parse(readFileSync(FILE, "utf8")).potTickets === 5, r.out);
  const D2 = L.addDays(D, 2);
  await (await v2.connect(S[1]).buyTicket(L.nightToDay(D2), 80, 3, true, { value: price })).wait();
  counts = { players: 42, picks: 236 };
  r = await run(); d = JSON.parse(readFileSync(FILE, "utf8"));
  check("later runs add only new events", d.potTickets === 6 && d.potWallets === 3 && d.players === 42 && d.calls === 236 && d.paidWei === (price * 2n).toString(), r.out + JSON.stringify(d).slice(0, 200));
} catch (e) { check("no unexpected error", false, e.stack); }
finally {
  for (const r of results) console.log((r.ok ? "PASS  " : "FAIL  ") + r.name + (r.ok ? "" : "  -> " + String(r.detail).slice(-600)));
  console.log(results.length && results.every((r) => r.ok) ? "ALL PASS" : "SOME FAILED");
  supa.close(); try { process.kill(-node.pid, "SIGKILL"); } catch {}
  process.exit(results.length && results.every((x) => x.ok) ? 0 : 1);
}
