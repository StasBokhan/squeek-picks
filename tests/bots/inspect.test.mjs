import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import { ROOT, TESTS, startChain, scratch } from "../lib/common.mjs";
const require = createRequire(import.meta.url);
const TMP = scratch("inspect");
const L = require(ROOT + "/src/logic.js");
const v3 = require(ROOT + "/contracts/SqueekPot.json");
const v2 = require(TESTS + "/fixtures/SqueekPotV2.json");
const v1 = require(ROOT + "/contracts/SqueekPotV1.json");
const RPC = "http://127.0.0.1:8548", CFG = TMP + "/config.js";
const node = startChain(8548);
const p = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
for (let i = 0; i < 60; i++) { try { await p.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
const results = []; const check = (n, ok, d = "") => results.push({ n, ok, d });
try {
  const [owner, bot, a, b] = await Promise.all([0, 1, 2, 3].map((i) => p.getSigner(i)));
  const price = ethers.parseEther("0.01");
  const dep = async (art, args, s = owner) => { const c = await new ethers.ContractFactory(art.abi, art.bytecode, s).deploy(...args); await c.waitForDeployment(); return c; };
  const old1 = await dep(v1, [price]); await (await old1.setResolver(bot.address)).wait();
  const cur = await dep(v2, [price, bot.address]);
  const good = await dep(v3, [price, bot.address]);
  const wrongBot = await dep(v3, [price, a.address]);
  const fake = await dep(v2, [price, bot.address]);
  writeFileSync(CFG, `window.SQUEEK_CONFIG = { POT_ADDRESS: "${cur.target}", OLD_POTS: ["${old1.target}"] };\n`);
  const now = Number((await p.getBlock("latest")).timestamp) * 1000, open = L.openNightAt(now);
  const run = (addr) => spawnSync("node", [ROOT + "/settler/inspect.mjs"], { env: { ...process.env, SEPOLIA_RPC_URL: RPC, CONFIG_FILE: CFG, CHECK_ADDRESS: addr, NOW_MS: String(now) }, encoding: "utf8" });
  let r = run(good.target);
  console.log(r.stdout);
  check("good v3 checks out and can switch now", r.status === 0 && /checks out: version 3, code identical/.test(r.stdout) && /no tickets for .* can switch now/.test(r.stdout), r.stdout + r.stderr);
  check("lists all three pots", (r.stdout.match(/::notice::Pot 0x/g) || []).length === 4, r.stdout);
  await (await cur.connect(a).buyTicket(L.nightToDay(open), 90, 3, true, { value: price })).wait();
  r = run(good.target);
  check("says to wait when the current pot sold tickets for the open night", r.status === 0 && /already has 1 tickets for/.test(r.stdout), r.stdout);
  r = run(wrongBot.target);
  check("flags a different payout bot", r.status === 1 && /payout bot .* isn't the current pot's/.test(r.stdout), r.stdout);
  r = run(fake.target);
  check("flags code that isn't v3", r.status === 1 && /not 3/.test(r.stdout), r.stdout);
  // Night Cards: the new receipt contract checks out; the old art, or a wrong minter, doesn't.
  const cardsArt = JSON.parse(readFileSync(ROOT + "/contracts/SqueekNightCards.json", "utf8"));
  const oldCards = JSON.parse(readFileSync(TESTS + "/fixtures/SqueekNightCards-first.json", "utf8"));
  const runC = (addr) => spawnSync("node", [ROOT + "/settler/inspect.mjs"], { env: { ...process.env, SEPOLIA_RPC_URL: RPC, CONFIG_FILE: CFG, CHECK_CARDS: addr, NOW_MS: String(now) }, encoding: "utf8" });
  const cGood = await dep(cardsArt, [bot.address]), cOld = await dep(oldCards, [bot.address]), cWrong = await dep(cardsArt, [a.address]), cOther = await dep(cardsArt, [bot.address], b);
  r = runC(cGood.target);
  check("new Night Cards check out", r.status === 0 && /Night Cards .* checks out: "Squeek Picks Night Cards", code identical/.test(r.stdout), r.stdout + r.stderr);
  r = runC(cOld.target);
  check("flags the old card art", r.status === 1 && /not what contracts\/SqueekNightCards.json deploys/.test(r.stdout), r.stdout);
  r = runC(cWrong.target);
  check("flags a minter that isn't the payout bot", r.status === 1 && /minter .* isn't the payout bot/.test(r.stdout), r.stdout);
  r = runC(cOther.target);
  check("flags an owner that isn't the pot's", r.status === 1 && /owner .* isn't the pot's owner/.test(r.stdout), r.stdout);
} catch (e) { check("no error", false, e.stack); }
finally {
  for (const x of results) console.log((x.ok ? "PASS  " : "FAIL  ") + x.n + (x.ok ? "" : "  -> " + String(x.d).slice(-800)));
  console.log(results.every((x) => x.ok) ? "ALL PASS" : "SOME FAILED");
  try { process.kill(-node.pid, "SIGKILL"); } catch {}
  process.exit(results.length && results.every((x) => x.ok) ? 0 : 1);
}
