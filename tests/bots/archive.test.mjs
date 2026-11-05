// When Squeekchain starts its history again (a new deployment), the API forgets the nights
// before and only half sees the night of the restart. Results, the diary and the archive bot
// must keep using the saved nights then, and never compare block counts across the restart.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { ROOT } from "../lib/common.mjs";
const require = createRequire(import.meta.url);
const L = require(ROOT + "/src/logic.js");
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

const T = (s) => Date.parse(s);
const NOW = T("2026-11-05T18:00:00Z");
const slots = (km) => Array.from({ length: 48 }, (_, i) => (i >= 20 && i < 26 ? Math.round(km * 1000 / 0.878 / 6) : 0));
const saved = (km, blocks, cov = 10000) => ({ km, coverageBps: cov, work: slots(km).reduce((a, b) => a + b, 0), slots: slots(km), blocks });
const FILE = {
  firstObservedAt: "2026-10-26T13:50:00.000Z",
  records: { maximumDailyDistanceMm: { value: "11674766", occurredAt: "2026-10-30T23:00:00Z" }, longestActiveDayStreak: { value: "9" } },
  nights: {
    "2026-10-26": saved(5.0, 400, 9300),          // Squeekchain started at 13:50: never complete
    "2026-10-30": saved(9.0, 950, 8000),          // a gap night
    "2026-10-31": saved(7.467, 769), "2026-11-01": saved(7.888, 835), "2026-11-02": saved(7.661, 853), "2026-11-03": saved(7.022, 769),
    "2026-11-04": saved(3.351, 366),
  },
};
const archive = L.archiveNights(FILE);
check("the archive keeps only complete nights recorded from their start", archive.has("2026-11-03") && !archive.has("2026-10-26") && !archive.has("2026-10-30") &&
  archive.get("2026-11-03").settledBlocks === 769 && archive.get("2026-11-03").blocks.length === 8, [...archive.keys()].join(","));

// The API after the restart: history from 3 Nov 19:50, so 3 Nov is two-thirds seen with no running.
const apiNight = (km, cov) => ({ distanceKm: km, work: km ? 3817 : 0, coverageBps: cov, slots: slots(km), blocks: (() => { const b = new Array(8).fill(0); slots(km).forEach((w, i) => { b[Math.floor(i / 6)] += w; }); return b; })() });
const api = {
  nights: new Map([["2026-11-03", apiNight(0, 6736)], ["2026-11-04", apiNight(3.351, 10000)]]),
  statsAt: NOW, statsFrom: T("2026-10-06T12:00:00Z"), firstAt: T("2026-11-03T19:50:00Z"),
  blocks: new Map([["2026-11-03", 0], ["2026-11-04", 366]]), blocksAt: NOW, blocksFrom: T("2026-10-06T12:00:00Z"), settledTs: NOW,
};
const plain = (night) => L.resolveNight(night, NOW, api);
const withSaved = (night) => L.resolveNight(night, NOW, Object.assign({}, api, { archive }));

check("without the diary, the nights before the restart void (the bug)", plain("2026-11-02").distance.state === "void" && plain("2026-11-03").distance.state === "void");
let r = withSaved("2026-11-02");
check("with the diary, 2 Nov resolves from the saved copy", r.fromDiary && r.distance.state === "resolved" && r.distance.km === 7.661 && r.peak.state === "resolved", JSON.stringify(r));
check("2 Nov's blocks compare two saved nights from the same history", r.blocks.state === "resolved" && r.blocks.more === true && r.blocks.cur === 853 && r.blocks.prev === 835, JSON.stringify(r.blocks));
r = withSaved("2026-11-03");
check("3 Nov (half seen by the new history) resolves from the saved, complete copy", r.fromDiary && r.distance.km === 7.022, JSON.stringify(r.distance));
check("3 Nov's blocks: fewer than 2 Nov, from the saved counts", r.blocks.state === "resolved" && r.blocks.more === false && r.blocks.cur === 769 && r.blocks.prev === 853, JSON.stringify(r.blocks));
r = withSaved("2026-11-04");
check("4 Nov comes from the API (it saw the whole night)", !r.fromDiary && r.distance.state === "resolved" && r.distance.km === 3.351, JSON.stringify(r.distance));
check("4 Nov's blocks never compare across the restart (void, as the pot was settled)", r.blocks.state === "void" && /No fully recorded night before/.test(r.blocks.reason), JSON.stringify(r.blocks));
r = withSaved("2026-10-26");
check("a night Squeekchain only started partway through still voids", r.distance.state === "void" && !r.fromDiary, JSON.stringify(r.distance));
r = withSaved("2026-10-30");
check("a saved night with a gap isn't used", !r.fromDiary && r.distance.state === "void", JSON.stringify(r.distance));

// Normal running: the API saw the night whole, so it wins over the diary's copy.
const normal = { nights: new Map([["2026-11-01", apiNight(8.5, 10000)]]), statsAt: NOW, statsFrom: T("2026-10-06T12:00:00Z"), firstAt: T("2026-10-26T13:50:00Z"),
  blocks: new Map([["2026-10-31", 769], ["2026-11-01", 900]]), blocksAt: NOW, blocksFrom: T("2026-10-06T12:00:00Z"), settledTs: NOW, archive };
r = L.resolveNight("2026-11-01", NOW, normal);
check("when the API has a night whole, it's used, not the diary", !r.fromDiary && r.distance.km === 8.5 && r.blocks.cur === 900, JSON.stringify(r));
// The API's 30 days no longer reach the night before: the saved counts compare.
r = L.resolveNight("2026-11-01", NOW, Object.assign({}, normal, { blocksFrom: T("2026-11-01T12:00:00Z") }));
check("when the API no longer reaches the night before, the saved counts compare", r.blocks.state === "resolved" && r.blocks.cur === 835 && r.blocks.prev === 769, JSON.stringify(r.blocks));
// A night just ended, not saved yet: unchanged behaviour (wait).
r = L.resolveNight("2026-11-05", T("2026-11-06T12:05:00Z"), Object.assign({}, api, { archive, statsAt: T("2026-11-06T12:00:00Z") }));
check("a night just ended still waits for its stats", r.distance.state === "wait", JSON.stringify(r.distance));

const m = L.mergeRecords(FILE.records, { maximumDailyDistanceMm: { value: "3351326" }, mostWorkHalfHour: { value: "1130" } });
check("records keep the better of each", m.maximumDailyDistanceMm.value === "11674766" && m.mostWorkHalfHour.value === "1130" && m.longestActiveDayStreak.value === "9", JSON.stringify(m));

// ----- The archive bot after a restart -----
const day = (date, km, cov, work) => ({ date, coverage: { coverageBps: cov }, distanceMm: Math.round(km * 1e6), observedWorkUnits: work,
  buckets: Array.from({ length: 48 }, (_, i) => ({ startMinuteUtc: (720 + i * 30) % 1440, coverage: "complete", workUnits: i >= 20 && i < 26 && work ? Math.round(work / 6) : 0 })) });
const STATS = { schemaVersion: 1, generatedAt: new Date(NOW).toISOString(), window: { startAt: "2026-10-06T12:00:00Z", endAt: new Date(NOW).toISOString() },
  lifetime: { firstObservedAt: "2026-11-03T19:50:00.000Z", observedDistanceMm: "3351326" },
  records: { maximumDailyDistanceMm: { value: "3351326", occurredAt: "2026-11-05T01:00:00Z" }, mostWorkHalfHour: { value: "1130" } },
  activity: { days: [day("2026-11-03", 0, 6736, 0), day("2026-11-04", 3.351, 10000, 3817), day("2026-11-05", 1.2, 5000, 1400)], typicalDay: [] } };
const bucket = (d, n) => ({ startAt: d + "T12:00:00.000Z", endAt: L.addDays(d, 1) + "T12:00:00.000Z", completedBlockCount: n });
const SETTLE = { status: "available", generatedAt: new Date(NOW).toISOString(), buckets: [bucket("2026-11-03", 0), bucket("2026-11-04", 366), bucket("2026-11-05", 120)], recentSettlements: [] };
const srv = http.createServer((req, res) => {
  const body = req.url.startsWith("/v1/measurement/stats") ? STATS : req.url.startsWith("/v1/settlements") ? SETTLE : null;
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body || { error: "not_found" }));
});
await new Promise((ok) => srv.listen(8797, "127.0.0.1", ok));
const dir = mkdtempSync(tmpdir() + "/diary-"), file = dir + "/diary.json";
const before = { about: "x", firstObservedAt: "2026-10-26T13:50:00.000Z", lifetime: { firstObservedAt: "2026-10-26T13:50:00.000Z" },
  records: FILE.records, nights: { "2026-11-02": saved(7.661, 853), "2026-11-03": saved(7.022, 769) } };
writeFileSync(file, JSON.stringify(before));
const run = () => new Promise((ok) => {
  import("node:child_process").then(({ spawn }) => {
    const p = spawn("node", [ROOT + "/archive/archive.mjs"], { env: { ...process.env, API_BASE: "http://127.0.0.1:8797", DIARY_FILE: file, NOW_MS: String(NOW) } });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (status) => ok({ status, out }));
  });
});
const a = await run();
const after = JSON.parse(readFileSync(file, "utf8"));
check("the archive bot runs", a.status === 0, a.out);
check("it keeps the saved, complete 3 Nov instead of the restart's two-thirds copy", after.nights["2026-11-03"].km === 7.022 && after.nights["2026-11-03"].coverageBps === 10000 &&
  after.nights["2026-11-03"].blocks === 769, JSON.stringify(after.nights["2026-11-03"]));
check("it adds 4 Nov from the new history, and not the running night", after.nights["2026-11-04"] && after.nights["2026-11-04"].km === 3.351 && after.nights["2026-11-04"].blocks === 366 &&
  !after.nights["2026-11-05"], JSON.stringify(Object.keys(after.nights)));
check("it keeps the earliest first recording and the better records", after.firstObservedAt === "2026-10-26T13:50:00.000Z" && after.records.maximumDailyDistanceMm.value === "11674766" &&
  after.records.mostWorkHalfHour.value === "1130", JSON.stringify({ first: after.firstObservedAt, rec: after.records }));
srv.close();

for (const { name, ok, detail } of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + String(detail).slice(0, 600)}`);
console.log(results.every((x) => x.ok) ? "ALL PASS" : "SOME FAILED");
process.exit(results.length && results.every((x) => x.ok) ? 0 : 1);
