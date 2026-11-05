// End-to-end: local chain + fake Squeekchain API + the real payout bot,
// with an old pot still finishing (version 1, or version 2 with OLD=2) and a new version 3 pot.
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import { ROOT, TESTS, startChain, scratch } from "../lib/common.mjs";

const require = createRequire(import.meta.url);
const TMP = scratch("settle");
const L = require(ROOT + "/src/logic.js");
const art2 = require(ROOT + "/contracts/SqueekPot.json");
const art1 = require(ROOT + "/contracts/SqueekPotV1.json");
const artV2 = require(TESTS + "/fixtures/SqueekPotV2.json");
const OLD = Number(process.env.OLD || 1);
const BOT = ROOT + "/settler/settle.mjs";
const CONFIG = TMP + "/config.js";
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];
const RPC = "http://127.0.0.1:8545";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); };

const node = startChain(8545);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
for (let i = 0; i < 60; i++) {
  try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}

let fixture = { stats: null, settlements: null };
const api = http.createServer((req, res) => {
  const body = req.url.startsWith("/v1/measurement/stats") ? fixture.stats : req.url.startsWith("/v1/settlements") ? fixture.settlements : null;
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(body || { error: "not_found" }));
}).listen(8787);

try {
  const owner = new ethers.Wallet(KEYS[0], provider);
  const bot = new ethers.Wallet(KEYS[1], provider);
  const S = await Promise.all([2, 3, 4, 5, 6, 7].map((i) => provider.getSigner(i)));
  const price = ethers.parseEther("0.01");
  const old = OLD === 2 ? await new ethers.ContractFactory(artV2.abi, artV2.bytecode, owner).deploy(price, bot.address)
    : await new ethers.ContractFactory(art1.abi, art1.bytecode, owner).deploy(price);
  await old.waitForDeployment();
  if (OLD === 1) await (await old.setResolver(bot.address)).wait();
  const pot = await new ethers.ContractFactory(art2.abi, art2.bytecode, owner).deploy(price, bot.address);
  await pot.waitForDeployment();
  // The repository's config.js after the switch: the new pot plus the old one still finishing.
  writeFileSync(CONFIG, `window.SQUEEK_CONFIG = { SUPABASE_URL: "", POT_ADDRESS: "${pot.target}", OLD_POTS: ["${old.target}"] };\n`);

  const t0 = Number((await provider.getBlock("latest")).timestamp) * 1000;
  const D = L.openNightAt(t0), D1 = L.addDays(D, 1);
  const set = async (ms) => { await provider.send("evm_setNextBlockTimestamp", [Math.floor(ms / 1000)]); await provider.send("evm_mine", []); };
  const buy = async (c, s, night, p) => (await c.connect(s).buyTicket(L.nightToDay(night), ...p, { value: price })).wait();

  // Old pot, night D: two tickets.
  await buy(old, S[0], D, [96, 3, true]);
  await buy(old, S[1], D, [50, 0, false]);
  // New pot, night D: S2 holds two tickets, S3 and S4 one each.
  await buy(pot, S[2], D, [96, 3, true]);    // ticket 0, best
  await buy(pot, S[3], D, [93, 3, true]);    // ticket 1, second
  await buy(pot, S[2], D, [89, 2, true]);    // ticket 2, third
  await buy(pot, S[4], D, [50, 0, false]);   // ticket 3, last
  // New pot, night D+1: a single ticket, which should be voided.
  await set(L.nightStart(D) + 3600e3);
  await buy(pot, S[5], D1, [70, 3, true]);

  const NOW = L.nightEnd(D1) + 3600e3;
  await set(NOW);

  // Fake API data: D ran 9.6 km peaking in window 3 with more blocks than D-1.
  const day = (date, km) => {
    const buckets = [];
    for (let i = 0; i < 48; i++) {
      const startMinuteUtc = (720 + i * 30) % 1440;
      const work = Math.floor(i / 6) === 3 ? 1500 : Math.floor(i / 6) === 4 ? 400 : 0;
      buckets.push({ startMinuteUtc, coverage: "complete", observedRoundCount: 3, workUnits: String(work) });
    }
    return { date, coverage: { expectedRoundCount: 144, observedRoundCount: 144, coverageBps: 10000 }, observedWorkUnits: "11400", distanceMm: String(Math.round(km * 1e6)), buckets };
  };
  const from = L.nightStart(L.addDays(D, -5));
  fixture.stats = {
    window: { startAt: new Date(from).toISOString(), endAt: new Date(NOW).toISOString() },
    generatedAt: new Date(NOW).toISOString(),
    activity: { days: [day(L.addDays(D, -1), 8.0), day(D, 9.6), day(D1, 7.0)], typicalDay: [] },
  };
  const bucket = (date, n) => ({ startAt: new Date(L.nightStart(date)).toISOString(), endAt: new Date(L.nightEnd(date)).toISOString(), completedBlockCount: String(n) });
  fixture.settlements = {
    status: "available", generatedAt: new Date(NOW).toISOString(), window: { bucketSeconds: 86400 },
    buckets: [bucket(L.addDays(D, -1), 1000), bucket(D, 1200), bucket(D1, 900)],
    recentSettlements: [{ blockTimestamp: new Date(NOW - 20 * 60e3).toISOString() }],
  };

  // Like the workflow: POT_ADDRESS still names the old pot; config.js names both.
  const runBot = (key, extra = {}) => new Promise((resolve) => {
    const p = spawn("node", [BOT], { env: { ...process.env, DIARY_FILE: "/nonexistent/diary.json", SETTLER_PRIVATE_KEY: key, POT_ADDRESS: old.target, CONFIG_FILE: CONFIG, SEPOLIA_RPC_URL: RPC, API_BASE: "http://127.0.0.1:8787", NOW_MS: String(NOW), ...extra } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 60000);
    p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });

  const wrong = await runBot(KEYS[0]);
  check("bot reports a wallet that isn't the payout wallet", wrong.status === 1 && /not the payout wallet of pot/.test(wrong.stderr), wrong.stderr.trim());
  check("and sends nothing with it", Number((await pot.getNight(L.nightToDay(D))).status) === 0 && Number((await old.getNight(L.nightToDay(D))).status) === 0);

  const dry = await runBot(KEYS[1], { DRY_RUN: "1" });
  check("dry run sends nothing", dry.status === 0 && /would settle/.test(dry.stdout) && Number((await pot.getNight(L.nightToDay(D))).status) === 0, dry.stdout + dry.stderr);
  check("bot finds both pots and their versions", new RegExp(`\\(version ${OLD}\\)`).test(dry.stdout) && /\(version 3\)/.test(dry.stdout), dry.stdout);

  const before = await Promise.all(S.slice(0, 5).map((s) => provider.getBalance(s.address)));
  const run = await runBot(KEYS[1]);
  console.log("---- bot output ----\n" + run.stdout + run.stderr + "--------------------");
  check("bot run succeeds", run.status === 0, run.stderr);
  const after = await Promise.all(S.slice(0, 5).map((s) => provider.getBalance(s.address)));
  const g = after.map((a, i) => a - before[i]);
  const two = price * 2n, four = price * 4n;
  check("old pot: 62.5% to the better ticket", g[0] === two * 6250n / 10000n, ethers.formatEther(g[0]));
  check("old pot: 37.5% to the other", g[1] === two * 3750n / 10000n, ethers.formatEther(g[1]));
  check("new pot: the two-ticket wallet wins 1st and 3rd (70%)", g[2] === four * 7000n / 10000n, ethers.formatEther(g[2]));
  check("new pot: 2nd place gets 30%", g[3] === four * 3000n / 10000n, ethers.formatEther(g[3]));
  check("new pot: last ticket gets nothing", g[4] === 0n, ethers.formatEther(g[4]));
  check("both night D's are settled", Number((await pot.getNight(L.nightToDay(D))).status) === 1 && Number((await old.getNight(L.nightToDay(D))).status) === 1);
  check("single-ticket night is voided", Number((await pot.getNight(L.nightToDay(D1))).status) === 2);
  const logs = await pot.queryFilter(pot.filters.NightSettled(), 0, "latest");
  check("payout names the winning tickets", logs.length === 1 && logs[0].args.tickets.map(Number).join() === "0,1,2", logs.map((l) => l.args.tickets.join()).join(" | "));

  const again = await runBot(KEYS[1]);
  check("second run has nothing to do", again.status === 0 && /Nothing to pay out/.test(again.stdout), again.stdout);

  const s5 = S[5], b5 = await provider.getBalance(s5.address);
  const r = await (await pot.connect(s5).refund(L.nightToDay(D1))).wait();
  check("voided ticket refunds in full", (await provider.getBalance(s5.address)) - b5 + r.gasUsed * r.gasPrice === price);
} catch (e) {
  check("no unexpected error", false, e.stack || String(e));
} finally {
  for (const { name, ok, detail } of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
  console.log(results.every((x) => x.ok) ? "ALL PASS" : "SOME FAILED");
  api.close(); try { process.kill(-node.pid, "SIGKILL"); } catch {}
  process.exit(results.length && results.every((x) => x.ok) ? 0 : 1);
}
