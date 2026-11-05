// Telegram announcer test: local chain + fake Squeekchain API + fake Supabase + fake Telegram.
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import { ROOT, startChain, scratch } from "../lib/common.mjs";

const require = createRequire(import.meta.url);
const TMP = scratch("announce");
const L = require(ROOT + "/src/logic.js");
const art2 = require(ROOT + "/contracts/SqueekPot.json");
const SETTLE = ROOT + "/settler/settle.mjs";
const ANNOUNCE = ROOT + "/settler/announce.mjs";
const CONFIG = TMP + "/config.js";
const STATE = TMP + "/state.json";
const KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"];
const RPC = "http://127.0.0.1:8546", TOKEN = "123456:SECRET-test-token";
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

const node = startChain(8546);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

// Fake services
let fixture = {}, posts = [], tgFail = false;
const serve = (port, fn) => http.createServer(fn).listen(port);
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const apiSrv = serve(8792, (req, res) => {
  if (req.url.startsWith("/v1/measurement/stats")) return json(res, 200, fixture.stats);
  if (req.url.startsWith("/v1/settlements")) return json(res, 200, fixture.settlements);
  json(res, 404, {});
});
const supaSrv = serve(8793, (req, res) => {
  if (req.headers.apikey !== "anon-key") return json(res, 401, {});
  if (req.url.startsWith("/rest/v1/picks")) return json(res, 200, req.url.includes("night=eq." + fixture.night) ? fixture.picks : []);
  if (req.url.startsWith("/rest/v1/players")) return json(res, 200, fixture.players);
  if (req.url.startsWith("/rest/v1/call_answers") && !fixture.noCalls) return json(res, 200, []);
  json(res, 404, {});
});
const tgSrv = serve(8794, (req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url !== `/bot${TOKEN}/sendMessage`) return json(res, 404, { ok: false, description: "Not Found" });
    if (tgFail) return json(res, 400, { ok: false, description: "Bad Request: chat not found" });
    posts.push(JSON.parse(body));
    json(res, 200, { ok: true, result: { message_id: posts.length } });
  });
});

const run = (file, env) => new Promise((resolve) => {
  const p = spawn("node", [file], { env: { ...process.env, DIARY_FILE: "/nonexistent/diary.json", ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => p.kill("SIGKILL"), 90000);
  p.on("close", (status) => { clearTimeout(t); resolve({ status, out }); });
});

try {
  const owner = new ethers.Wallet(KEYS[0], provider), bot = new ethers.Wallet(KEYS[1], provider);
  const S = await Promise.all([2, 3, 4, 5].map((i) => provider.getSigner(i)));
  const price = ethers.parseEther("0.01");
  const pot = await new ethers.ContractFactory(art2.abi, art2.bytecode, owner).deploy(price, bot.address);
  await pot.waitForDeployment();
  writeFileSync(CONFIG, `window.SQUEEK_CONFIG = { SUPABASE_URL: "http://127.0.0.1:8793", SUPABASE_ANON_KEY: "anon-key", POT_ADDRESS: "${pot.target}" };\n`);

  const t0 = Number((await provider.getBlock("latest")).timestamp) * 1000;
  const D = L.openNightAt(t0), OPEN = L.addDays(D, 2);
  const buy = async (s, night, p) => (await pot.connect(s).buyTicket(L.nightToDay(night), ...p, { value: price })).wait();
  await buy(S[0], D, [96, 3, true]);
  await buy(S[1], D, [93, 3, true]);
  await buy(S[0], D, [89, 2, true]);
  await buy(S[2], D, [50, 0, false]);

  // He ran 9.6 km on night D: up at slot 18, busiest window 3, more blocks than the night before.
  const day = (date, km, slots) => ({
    date, coverage: { coverageBps: 10000 }, distanceMm: String(Math.round(km * 1e6)),
    buckets: slots.map((w, i) => ({ startMinuteUtc: (720 + i * 30) % 1440, coverage: "complete", workUnits: String(w) })),
  });
  const night = (pattern) => Array.from({ length: 48 }, (_, i) => pattern(i));
  const usual = night((i) => (i >= 18 && i < 24 ? 1500 : i >= 26 && i < 28 ? 400 : 0));
  const NOW1 = L.nightEnd(D) + 40 * 60e3;   // 40 minutes after night D ends
  const makeFixture = (now) => ({
    stats: {
      window: { startAt: new Date(L.nightStart(L.addDays(D, -3))).toISOString(), endAt: new Date(now).toISOString() }, generatedAt: new Date(now).toISOString(),
      // A week of usual nights before, so the live calls have their lines (from the fake API
      // alone: the bot is pointed away from the real diary file).
      activity: { days: [...[8, 7, 6, 5, 4, 3].map((k) => day(L.addDays(D, -k), 8.0, usual)), day(L.addDays(D, -2), 8.1, usual), day(L.addDays(D, -1), 8.4, usual), day(D, 9.6, usual), day(L.addDays(D, 1), 2.0, night((i) => (i === 18 ? 900 : 0)))], typicalDay: [] },
      lifetime: { firstObservedAt: new Date(L.nightStart(L.addDays(D, -2)) - 3600e3).toISOString(), observedDistanceMm: "28000000" },
      records: {
        longestActiveWindowMinutes: { value: "180", occurredAt: new Date(L.nightStart(D) + 9 * 3600e3).toISOString(), coverage: "complete" },
        maximumDailyDistanceMm: { value: "9600000", occurredAt: new Date(L.nightStart(D)).toISOString(), coverage: "complete" },
        mostWorkHalfHour: { value: "1500", occurredAt: new Date(L.nightStart(L.addDays(D, -2)) + 9 * 3600e3).toISOString(), coverage: "complete" },
      },
    },
    settlements: {
      status: "available", generatedAt: new Date(now).toISOString(),
      buckets: [L.addDays(D, -2), L.addDays(D, -1), D].map((d, i) => ({ startAt: new Date(L.nightStart(d)).toISOString(), endAt: new Date(L.nightEnd(d)).toISOString(), completedBlockCount: String([900, 1000, 1200][i]) })),
      recentSettlements: [{ blockTimestamp: new Date(now - 60e3).toISOString() }],
    },
    night: D,
    picks: [
      { player_id: "u1", distance_km: 9.5, peak_block: 3, more_blocks: true },
      { player_id: "u2", distance_km: 7.0, peak_block: 4, more_blocks: false },
    ],
    players: [{ id: "u1", nickname: "wheel_watcher" }, { id: "u2", nickname: "night_owl" }],
  });
  fixture = makeFixture(NOW1);
  if (existsSync(STATE)) rmSync(STATE);
  const env = (now, extra = {}) => ({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "@squeektest", TELEGRAM_API: "http://127.0.0.1:8794", MAINNET_RPC_URL: "",
    SEPOLIA_RPC_URL: RPC, API_BASE: "http://127.0.0.1:8792", CONFIG_FILE: CONFIG, STATE_FILE: STATE, NOW_MS: String(now), TIME_ZONE: "Europe/Zurich", ...extra });

  // 1. Not set up: nothing happens, no failure.
  let r = await run(ANNOUNCE, { ...env(NOW1), TELEGRAM_BOT_TOKEN: "" });
  check("without a token it skips quietly", r.status === 0 && /isn't set up/.test(r.out) && posts.length === 0, r.out);

  // 1b. The test post from "Run workflow".
  r = await run(ANNOUNCE, { ...env(L.nightStart(D) - 6 * 3600e3), TELEGRAM_TEST: "true" });
  check("the test post goes out on request", r.status === 0 && posts.length === 1 && posts[0].text.includes("Squeek Picks is connected"), r.out);
  posts = [];

  // 2. The pot isn't paid out yet: wait for the payout bot.
  r = await run(ANNOUNCE, env(NOW1));
  check("waits while the pot isn't paid out", r.status === 0 && /waiting, the pot isn't paid out yet/.test(r.out) && posts.length === 0, r.out);

  // 3. The payout bot settles, then the results go out once.
  await provider.send("evm_setNextBlockTimestamp", [Math.floor(NOW1 / 1000)]); await provider.send("evm_mine", []);
  const s = await run(SETTLE, { SETTLER_PRIVATE_KEY: KEYS[1], SEPOLIA_RPC_URL: RPC, API_BASE: "http://127.0.0.1:8792", CONFIG_FILE: CONFIG, NOW_MS: String(NOW1) });
  check("payout bot settles the night", s.status === 0 && /settled on pot/.test(s.out), s.out.slice(-400));
  r = await run(ANNOUNCE, env(NOW1 + 60e3));
  const post = posts[0] || {}, text = post.text || "";
  console.log("---- results post ----\n" + text + "\n----------------------");
  check("results are posted to the channel as HTML", r.status === 0 && posts.length === 1 && post.chat_id === "@squeektest" && post.parse_mode === "HTML", r.out);
  check("the post has the distance and the diary write-up", text.includes("Squeektoshi ran <b>9.6 km</b>") && text.includes("Up at 22:00 as usual and ran non-stop until 1:00") && text.includes("his longest run yet") && text.includes("One more run at 2:00. Asleep by 3:00."), text);
  check("busiest window, blocks and records", text.includes("Busiest 3 hours: <b>22:00–1:00</b> (CET)") && text.includes("Squeek blocks: <b>1,200</b>, more than the night before (1,000)") &&
    text.includes("New records: farthest night (9.6 km), longest non-stop run (3 hours)") && !text.includes("busiest half hour ("), text);
  check("who won the pot and the points game", text.includes("won 0.02 ETH with 75 points (4 tickets, 0.04 ETH)") && text.includes(S[0].address.slice(0, 6)) &&
    text.includes("Points game: <b>wheel_watcher</b> on top with 75 points (2 players)"), text);
  check("links to the diary and the game", text.includes("https://squeekpicks.xyz/diary") && text.includes("Call tonight's run: https://squeekpicks.xyz/"), text);
  r = await run(ANNOUNCE, env(NOW1 + 3600e3));
  check("the same results aren't posted twice", r.status === 0 && posts.length === 1 && /Nothing to post/.test(r.out), r.out);
  check("its memory is a small file", JSON.parse(readFileSync(STATE, "utf8")).results[D] != null);

  // 4. Last call before picks close, with the pot so far.
  await buy(S[3], OPEN, [91, 3, true]);
  await buy(S[1], OPEN, [88, 4, false]);
  const NOW2 = L.nightStart(OPEN) - 45 * 60e3;
  r = await run(ANNOUNCE, env(NOW2));
  const call = (posts[1] || {}).text || "";
  console.log("---- last call ----\n" + call + "\n-------------------");
  check("last call goes out 45 minutes before picks close", posts.length === 2 && call.includes("<b>Last call:</b> picks for the night of " + new Date(OPEN + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) + " close at 13:00 CET, in 45 minutes."), call);
  check("with the pot so far and a hint from his nights", call.includes("Pot so far: <b>0.02 ETH</b> from 2 tickets.") && call.includes("Hint: 22:00–1:00 was his busiest on") && call.includes("https://squeekpicks.xyz/"), call);
  r = await run(ANNOUNCE, env(NOW2 + 20 * 60e3));
  check("only one last call per night", posts.length === 2, r.out);
  r = await run(ANNOUNCE, env(L.nightStart(L.addDays(OPEN, 1)) - 3 * 3600e3));
  check("no last call hours before the window", posts.length === 2, r.out);

  // 4b. Live calls in a season: one post per call, within an hour of it closing.
  const LIVEN = L.addDays(D, 1);
  writeFileSync(CONFIG, `window.SQUEEK_CONFIG = { SUPABASE_URL: "http://127.0.0.1:8793", SUPABASE_ANON_KEY: "anon-key", POT_ADDRESS: "${pot.target}", SEASONS: [{ name: "Season 1", start: "${L.addDays(D, -1)}", nights: 14 }] };\n`);
  posts = [];
  const NOW3 = L.callCloses(LIVEN, 1) - 30 * 60e3;
  fixture = Object.assign(makeFixture(NOW3), { noCalls: true });
  r = await run(ANNOUNCE, env(NOW3));
  check("no live call posts before the call_answers table exists", posts.length === 0 && r.out.includes("No call_answers table yet"), r.out);
  fixture = makeFixture(NOW3);
  r = await run(ANNOUNCE, env(NOW3));
  const lc = (posts[0] || {}).text || "";
  console.log("---- live call ----\n" + lc + "\n-------------------");
  check("a live call goes out half an hour before it closes", posts.length === 1 && /⏱ <b>Live call · Season 1:<\/b> more or fewer than <b>[\d,]+ spins<\/b> between 22:00 and 23:00 CET\?/.test(lc) && lc.includes("Closes at 22:00, in 30 minutes."), lc + r.out);
  r = await run(ANNOUNCE, env(NOW3 + 10 * 60e3));
  check("each live call is posted once", posts.length === 1, r.out);
  r = await run(ANNOUNCE, env(L.callCloses(LIVEN, 2) - 20 * 60e3));
  check("the next call gets its own post", posts.length === 2 && posts[1].text.includes("between 0:00 and 1:00 CET"), (posts[1] || {}).text);
  writeFileSync(CONFIG, `window.SQUEEK_CONFIG = { SUPABASE_URL: "http://127.0.0.1:8793", SUPABASE_ANON_KEY: "anon-key", POT_ADDRESS: "${pot.target}" };\n`);
  r = await run(ANNOUNCE, env(L.callCloses(L.addDays(LIVEN, 1), 1) - 30 * 60e3));
  check("no live calls outside a season", posts.length === 2, r.out);
  posts = [];

  // 5. Telegram says no: the run fails with Telegram's reason, never the token.
  if (existsSync(STATE)) rmSync(STATE);
  tgFail = true;
  r = await run(ANNOUNCE, env(L.nightStart(L.addDays(OPEN, 1)) - 30 * 60e3));
  check("a refused post fails the step with the reason, not the token", r.status === 1 && /chat not found/.test(r.out) && !r.out.includes("SECRET"), r.out);
  check("and isn't marked as posted", !existsSync(STATE) || !Object.keys(JSON.parse(readFileSync(STATE, "utf8")).calls || {}).length);
} catch (e) {
  check("no unexpected error", false, e.stack);
} finally {
  for (const r of results) console.log((r.ok ? "PASS  " : "FAIL  ") + r.name + (r.ok ? "" : "  -> " + String(r.detail).slice(-700)));
  console.log(results.length && results.every((r) => r.ok) ? "ALL PASS" : "SOME FAILED");
  apiSrv.close(); supaSrv.close(); tgSrv.close();
  try { process.kill(-node.pid, "SIGKILL"); } catch {}
  process.exit(results.length && results.every((x) => x.ok) ? 0 : 1);
}
