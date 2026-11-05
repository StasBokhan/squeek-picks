// Night Cards bot: local chain + fake Squeekchain API + fake Supabase.
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import { ROOT, startChain, scratch } from "../lib/common.mjs";
const require = createRequire(import.meta.url);
const TMP = scratch("cards");
const L = require(ROOT + "/src/logic.js");
const art = require(ROOT + "/contracts/SqueekNightCards.json");
const BOT = ROOT + "/settler/cards.mjs";
const CONFIG = TMP + "/config.js";
const KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"];
const RPC = "http://127.0.0.1:8549";
const results = []; const check = (n, ok, d = "") => results.push([n, !!ok, d]);
const node = startChain(8549);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
let fx = {};
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const api = http.createServer((req, res) => req.url.startsWith("/v1/measurement/stats") ? json(res, 200, fx.stats) : req.url.startsWith("/v1/settlements") ? json(res, 200, fx.settlements) : json(res, 404, {})).listen(8796);
const supa = http.createServer((req, res) => {
  const night = (req.url.match(/night=eq\.([\d-]+)/) || [])[1];
  if (req.url.startsWith("/rest/v1/picks")) return json(res, 200, fx.picks[night] || []);
  if (req.url.startsWith("/rest/v1/call_answers")) return json(res, 200, fx.answers[night] || []);
  if (req.url.startsWith("/rest/v1/wallet_links")) return json(res, 200, fx.links);
  json(res, 404, {});
}).listen(8797);
const run = (env) => new Promise((resolve) => {
  const p = spawn("node", [BOT], { env: { ...process.env, DIARY_FILE: "/nonexistent/diary.json", SEPOLIA_RPC_URL: RPC, API_BASE: "http://127.0.0.1:8796", CONFIG_FILE: CONFIG, ...env } });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("close", (status) => resolve({ status, out }));
});
try {
  const owner = new ethers.Wallet(KEYS[0], provider), bot = new ethers.Wallet(KEYS[1], provider);
  const w1 = new ethers.Wallet(KEYS[2]), w2 = new ethers.Wallet(KEYS[3]), w4 = new ethers.Wallet(KEYS[4]);
  const cards = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(bot.address); await cards.waitForDeployment();
  const t0 = Number((await provider.getBlock("latest")).timestamp) * 1000;
  const D = L.liveNightAt(t0), S = L.addDays(D, -2);   // a 3-night season: S, S+1, D
  writeFileSync(CONFIG, `window.SQUEEK_CONFIG = { SUPABASE_URL: "http://127.0.0.1:8797", SUPABASE_ANON_KEY: "anon", CARDS_ADDRESS: "${cards.target}", SEASONS: [{ name: "Season 1", start: "${S}", nights: 3 }] };\n`);
  const usual = Array.from({ length: 48 }, (_, i) => (i >= 18 && i < 24 ? 1500 : i >= 24 && i < 28 ? 300 : 0));
  const day = (date, km) => ({ date, coverage: { coverageBps: 10000 }, distanceMm: String(Math.round(km * 1e6)), buckets: usual.map((w, i) => ({ startMinuteUtc: (720 + i * 30) % 1440, coverage: "complete", workUnits: String(w) })) });
  const NOW = L.nightEnd(D) + 3600e3;
  const nightsAll = [-12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0].map((k) => L.addDays(D, k));
  fx = {
    stats: { window: { startAt: new Date(L.nightStart(nightsAll[0])).toISOString(), endAt: new Date(NOW).toISOString() }, generatedAt: new Date(NOW).toISOString(),
      activity: { days: nightsAll.map((n, i) => day(n, 9 + (i % 3))), typicalDay: [] } },
    settlements: { status: "available", generatedAt: new Date(NOW).toISOString(),
      buckets: nightsAll.map((n, i) => ({ startAt: new Date(L.nightStart(n)).toISOString(), endAt: new Date(L.nightEnd(n)).toISOString(), completedBlockCount: String(1000 + 10 * i) })), recentSettlements: [{ blockTimestamp: new Date(NOW - 60e3).toISOString() }] },
    picks: {}, answers: {}, links: [],
  };
  const km = (n) => 9 + (nightsAll.indexOf(n) % 3);
  // Every night: u1 is spot on (perfect), u2 within 0.2 km on distance only, u3 decent, u4 decent.
  for (const n of [S, L.addDays(S, 1), D]) {
    fx.picks[n] = [
      { player_id: "u1", distance_km: km(n), peak_block: 3, more_blocks: true, double_market: "peak" },
      { player_id: "u2", distance_km: km(n) + 0.2, peak_block: 6, more_blocks: false, double_market: null },
      { player_id: "u3", distance_km: km(n) + 0.8, peak_block: 3, more_blocks: false, double_market: null },
      { player_id: "u4", distance_km: km(n) + 0.8, peak_block: 3, more_blocks: false, double_market: null },
    ];
  }
  const link = async (w, id) => ({ player_id: id, wallet: w.address, message: L.linkMessage(w.address, id), signature: await w.signMessage(L.linkMessage(w.address, id)) });
  fx.links = [await link(w1, "u1"), await link(w2, "u2"), Object.assign(await link(w4, "u4"), { wallet: w2.address }),   // u4's signature doesn't match the wallet
    await link(w1, "u3")];   // u3 linked u1's wallet too: it counts for u1 only

  let r = await run({ NOW_MS: String(NOW), DRY_RUN: "1" });
  check("dry run lists what it would mint, sends nothing", r.status === 0 && /would mint Epic "Perfect night"/.test(r.out) && Number(await cards.totalMinted()) === 0, r.out);
  check("a wallet with a signature that doesn't match is ignored", /2 players linked a wallet/.test(r.out), r.out);
  check("a wallet linked to two nicknames counts for the first only", /linked to more than one nickname/.test(r.out), r.out);
  r = await run({ NOW_MS: String(NOW), SETTLER_PRIVATE_KEY: KEYS[0] });
  check("a wallet that isn't the minter is refused", r.status === 1 && /not the cards' minter/.test(r.out), r.out);
  r = await run({ NOW_MS: String(NOW), SETTLER_PRIVATE_KEY: KEYS[1] });
  console.log(r.out);
  const of1 = (await cards.cardsOf(w1.address)).map(Number), of2 = (await cards.cardsOf(w2.address)).map(Number);
  check("bot run succeeds", r.status === 0, r.out);
  check("u1 gets a perfect-night card for each night, plus the champion card", of1.length === 4, JSON.stringify(of1));
  const kinds1 = await Promise.all(of1.map(async (id) => Number((await cards.card(id)).kind)));
  check("three Epic perfect nights and one Legendary champion", JSON.stringify(kinds1.sort()) === JSON.stringify([3, 3, 3, 4]), JSON.stringify(kinds1));
  const kinds2 = await Promise.all(of2.map(async (id) => Number((await cards.card(id)).kind)));
  check("u2 gets a bullseye each night", kinds2.length === 3 && kinds2.every((k) => k === 1), JSON.stringify(kinds2));
  check("each night is recorded once, with his run", (await cards.run(L.nightToDay(D))).set && Number((await cards.run(L.nightToDay(D))).kmDeci) === km(D) * 10);
  const rec = await cards.run(L.nightToDay(D)), sp = ethers.getBytes(rec.spins), half = [...Array(48)].map((_, i) => sp[2 * i] * 256 + sp[2 * i + 1]);
  check("it records his real spins per half hour", sp.length === 96 && half.reduce((a, b) => a + b, 0) > 0 && Math.max(...half) > 255, JSON.stringify(half));
  const total = Number(await cards.totalMinted());
  r = await run({ NOW_MS: String(NOW + 3600e3), SETTLER_PRIVATE_KEY: KEYS[1] });
  check("running again mints nothing new", r.status === 0 && Number(await cards.totalMinted()) === total && /No new cards/.test(r.out), r.out);
  const meta = JSON.parse(Buffer.from((await cards.tokenURI(of1[0])).split(",")[1], "base64").toString());
  check("the cards render", /Night Card \d{4}-\d\d-\d\d: (Perfect night|Season champion)/.test(meta.name), meta.name);
  // Results not final: nothing minted for that night yet.
  const D2 = L.addDays(D, 1);
  writeFileSync(CONFIG, `window.SQUEEK_CONFIG = { SUPABASE_URL: "http://127.0.0.1:8797", SUPABASE_ANON_KEY: "anon", CARDS_ADDRESS: "${cards.target}", SEASONS: [{ name: "Season 2", start: "${D2}", nights: 3 }] };\n`);
  fx.picks[D2] = fx.picks[D];
  r = await run({ NOW_MS: String(L.nightEnd(D2) + 3600e3), SETTLER_PRIVATE_KEY: KEYS[1] });
  check("waits while a night's results aren't in", r.status === 0 && /results not final yet/.test(r.out) && Number(await cards.totalMinted()) === total, r.out);
  writeFileSync(CONFIG, `window.SQUEEK_CONFIG = { SUPABASE_URL: "http://127.0.0.1:8797", SUPABASE_ANON_KEY: "anon" };\n`);
  r = await run({ NOW_MS: String(NOW) });
  check("without a cards contract it does nothing", r.status === 0 && /No Night Cards contract/.test(r.out), r.out);
} catch (e) { check("no unexpected error", false, e.stack); }
finally {
  for (const [n, ok, d] of results) console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  -> " + String(d).slice(-700)));
  console.log(results.every((x) => x[1]) ? "ALL PASS" : "SOME FAILED");
  api.close(); supa.close(); try { process.kill(-node.pid, "SIGKILL"); } catch {}
  process.exit(results.length && results.every((x) => x[1]) ? 0 : 1);
}
