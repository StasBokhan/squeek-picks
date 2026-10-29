/*
 * Squeek Picks rules: nights, results, points and pot payouts.
 * One file shared by the page (inlined at build time) and the payout bot
 * (settler/settle.mjs), so both always agree on who won.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SqueekLogic = api;
})(this, function () {
  "use strict";

  var HOUR = 3600e3, DAY = 86400e3;
  var COVERAGE_OK_BPS = 9500;      // a night needs 95% of its rounds in to be scored
  var VOID_AFTER = 24 * HOUR;      // a gap still open a day after the night ends voids it
  var POT_SHARES_3 = [5000, 3000, 2000];
  var POT_SHARES_2 = [6250, 3750];
  var MAX_WINNERS = 10;

  // ---------- Nights ----------
  // A night is named by its date and runs from 12:00 UTC that day to 12:00 UTC the next.
  function dateStr(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(night, n) { return dateStr(Date.parse(night + "T00:00:00Z") + n * DAY); }
  function nightStart(night) { return Date.parse(night + "T12:00:00Z"); }
  function nightEnd(night) { return nightStart(night) + DAY; }
  function liveNightAt(ms) { return dateStr(ms - 12 * HOUR); }
  function openNightAt(ms) { return addDays(liveNightAt(ms), 1); }
  // The pot contract numbers nights by day since 1970-01-01.
  function nightToDay(night) { return Math.round(Date.parse(night + "T00:00:00Z") / DAY); }
  function dayToNight(day) { return dateStr(Number(day) * DAY); }
  function slotOf(startMinuteUtc) { return Math.floor(((((startMinuteUtc - 720) % 1440) + 1440) % 1440) / 30); }

  // ---------- Squeekchain API ----------
  function parseStats(stats) {
    if (!stats || !stats.activity) return null;
    var nights = new Map(), typical = null;
    (stats.activity.days || []).forEach(function (d) {
      var slots = new Array(48).fill(null), blocks = new Array(8).fill(0), total = 0;
      (d.buckets || []).forEach(function (b) {
        if (b.coverage === "future") return;
        var w = Number(b.workUnits || 0), i = slotOf(Number(b.startMinuteUtc));
        slots[i] = w; blocks[Math.floor(i / 6)] += w; total += w;
      });
      nights.set(d.date, {
        distanceKm: Number(d.distanceMm || 0) / 1e6,
        work: total,
        coverageBps: Number(d.coverage && d.coverage.coverageBps != null ? d.coverage.coverageBps : 0),
        slots: slots, blocks: blocks
      });
    });
    if (Array.isArray(stats.activity.typicalDay) && stats.activity.typicalDay.length) {
      typical = new Array(48).fill(0);
      stats.activity.typicalDay.forEach(function (s) {
        typical[slotOf(Number(s.startMinuteUtc))] = Number(s.meanWorkMilli || 0) / 1000;
      });
    }
    var w = stats.window || {};
    var life = stats.lifetime || {};
    return {
      nights: nights, typical: typical,
      at: Date.parse(w.endAt || stats.generatedAt) || Date.now(),
      from: Date.parse(w.startAt) || 0,
      // When this Squeekchain installation started recording. Nights that began
      // earlier can never be complete (for example after a testnet restart).
      firstAt: Date.parse(life.firstObservedAt) || 0
    };
  }

  // Daily settlement buckets that run 12:00 to 12:00 UTC are exactly our nights.
  function parseSettlements(set) {
    if (!set || set.status !== "available") return null;
    var blocks = new Map(), settledTs = 0, from = Infinity;
    (set.buckets || []).forEach(function (b) {
      var t = Date.parse(b.startAt), e = Date.parse(b.endAt);
      if (e - t !== DAY || new Date(t).getUTCHours() !== 12) return;
      blocks.set(dateStr(t), Number(b.completedBlockCount || 0));
      if (t < from) from = t;
    });
    (set.recentSettlements || []).forEach(function (s) {
      var t = Date.parse(s.blockTimestamp);
      if (t > settledTs) settledTs = t;
    });
    return { blocks: blocks, settledTs: settledTs, at: Date.parse(set.generatedAt) || Date.now(), from: from === Infinity ? 0 : from };
  }

  // ---------- Results ----------
  // data: { nights, statsAt, statsFrom, firstAt, blocks, blocksAt, blocksFrom, settledTs }
  // Each market comes back as live, wait (data not in yet), void, or resolved.
  // Missing or stale data means "wait", never "void", except for a night that began
  // before Squeekchain started recording: that one can never be complete.
  function resolveNight(night, now, data) {
    var end = nightEnd(night), ended = now >= end, old = now >= end + VOID_AFTER;
    var res = { night: night, ended: ended, distance: { state: "live" }, peak: { state: "live" }, blocks: { state: "live" } };
    if (!ended) return res;

    var started = data.firstAt || 0;
    var n = data.nights.get(night);
    var statsCover = data.statsAt >= end + 10 * 60e3 && data.statsFrom <= nightStart(night);
    if (started > nightStart(night)) {
      res.distance = res.peak = { state: "void", reason: "Squeekchain started recording partway through this night" };
    } else if (!statsCover) {
      res.distance = res.peak = { state: "wait", reason: "The night's stats aren't published yet" };
    } else if (!n || n.coverageBps < COVERAGE_OK_BPS) {
      var why = !n ? "No data for this night" : "Data gap: " + Math.floor(n.coverageBps / 100) + "% of the night's rounds are in";
      res.distance = res.peak = old ? { state: "void", reason: why } : { state: "wait", reason: why + " so far" };
    } else {
      res.distance = { state: "resolved", km: n.distanceKm };
      var max = Math.max.apply(null, n.blocks);
      if (n.work === 0 || max === 0) res.peak = { state: "void", reason: "He took the night off" };
      else res.peak = {
        state: "resolved",
        winners: n.blocks.map(function (v, i) { return v === max ? i : -1; }).filter(function (i) { return i >= 0; }),
        spins: max
      };
    }

    // Blocks are bucketed by when they settled on Ethereum, so a night's count is final
    // once its bucket has closed and the 12-confirmation delay (about 2.5 minutes) has
    // passed. 20 minutes leaves room for the API's indexer to catch up.
    var cur = data.blocks.get(night), prev = data.blocks.get(addDays(night, -1));
    var blocksCover = data.blocksAt >= end + 20 * 60e3 && data.blocksFrom <= nightStart(addDays(night, -1));
    if (started > nightStart(addDays(night, -1))) {
      // The night before wasn't fully recorded, so its count is too low to compare with.
      res.blocks = { state: "void", reason: "No fully recorded night before this one to compare with" };
    } else if (!blocksCover) {
      res.blocks = { state: "wait", reason: "Block counts are final 20 minutes after the night ends" };
    } else if (cur == null || prev == null) {
      res.blocks = old ? { state: "void", reason: "No settlement data" } : { state: "wait" };
    } else if (cur === prev) {
      res.blocks = { state: "void", reason: "Tie: " + cur + " blocks both nights" };
    } else {
      res.blocks = { state: "resolved", more: cur > prev, cur: cur, prev: prev };
    }
    return res;
  }

  // ---------- Points ----------
  function distancePoints(err) { return err <= 0.25 ? 30 : err <= 0.5 ? 20 : err <= 1 ? 10 : err <= 2 ? 5 : 0; }

  // picks: [{ player_id, distance_km, peak_block, more_blocks }]
  function scoreNight(res, picks) {
    var out = new Map(), errs = new Map(), minErr = Infinity;
    if (res.distance.state === "resolved") {
      picks.forEach(function (p) {
        var e = Math.round(Math.abs(p.distance_km - res.distance.km) * 1000) / 1000;
        errs.set(p.player_id, e);
        if (e < minErr) minErr = e;
      });
    }
    picks.forEach(function (p) {
      var s = { distance: 0, closest: 0, peak: 0, blocks: 0, total: 0, counted: false, err: errs.has(p.player_id) ? errs.get(p.player_id) : null };
      if (res.distance.state === "resolved") { s.distance = distancePoints(s.err); s.closest = s.err === minErr ? 10 : 0; s.counted = true; }
      if (res.peak.state === "resolved") {
        var w = res.peak.winners;
        s.peak = w.indexOf(p.peak_block) >= 0 ? 20 : w.some(function (x) { return Math.abs(x - p.peak_block) === 1; }) ? 5 : 0;
        s.counted = true;
      }
      if (res.blocks.state === "resolved") { s.blocks = p.more_blocks === res.blocks.more ? 15 : 0; s.counted = true; }
      s.total = s.distance + s.closest + s.peak + s.blocks;
      out.set(p.player_id, s);
    });
    return out;
  }

  // ---------- Pot ----------
  // tickets: [{ player_id (address), distance_km, peak_block, more_blocks, boughtAt (seconds) }]
  // Ranks by the night's points, then the closest distance, then who bought first.
  // Top 3 split 50/30/20 (62.5/37.5 with two tickets). Players tied on all three
  // share the places they cover equally.
  // Returns { action: "wait" | "void" | "settle", reason, winners, bps, ranking }.
  function potPayouts(res, tickets) {
    if (!res.ended) return { action: "wait", reason: "The night isn't over yet." };
    var markets = [res.distance, res.peak, res.blocks];
    if (markets.some(function (m) { return m.state === "wait" || m.state === "live"; })) {
      return { action: "wait", reason: "Waiting for the night's results." };
    }
    if (!markets.some(function (m) { return m.state === "resolved"; })) {
      return { action: "void", reason: "No result for this night, so every ticket is refunded." };
    }
    if (tickets.length < 2) {
      return { action: "void", reason: "Fewer than 2 tickets, so the ticket is refunded." };
    }

    var scores = scoreNight(res, tickets);
    function errKey(s) { return s.err == null ? 1e9 : s.err; }
    var ranked = tickets.map(function (t) { return { t: t, s: scores.get(t.player_id) }; });
    ranked.sort(function (a, b) {
      return (b.s.total - a.s.total) || (errKey(a.s) - errKey(b.s)) || (Number(a.t.boughtAt) - Number(b.t.boughtAt)) ||
        (a.t.player_id < b.t.player_id ? -1 : a.t.player_id > b.t.player_id ? 1 : 0);
    });
    function tied(a, b) {
      return a.s.total === b.s.total && errKey(a.s) === errKey(b.s) && Number(a.t.boughtAt) === Number(b.t.boughtAt);
    }

    var shares = tickets.length >= 3 ? POT_SHARES_3 : POT_SHARES_2;
    var paid = [], ranking = [], place = 0;
    for (var i = 0; i < ranked.length;) {
      var j = i;
      while (j + 1 < ranked.length && tied(ranked[i], ranked[j + 1])) j++;
      var size = j - i + 1, groupBps = 0;
      for (var p = place; p < Math.min(place + size, shares.length); p++) groupBps += shares[p];
      var each = Math.floor(groupBps / size), rem = groupBps - each * size;
      for (var k = i; k <= j; k++) {
        var bps = groupBps ? each + (k === i ? rem : 0) : 0;
        var row = { player_id: ranked[k].t.player_id, place: place + 1, points: ranked[k].s.total, err: ranked[k].s.err, score: ranked[k].s, bps: bps };
        ranking.push(row);
        if (bps > 0) paid.push(row);
      }
      place += size; i = j + 1;
    }
    if (paid.length > MAX_WINNERS) {
      return { action: "void", reason: "Too many players tied for a prize, so every ticket is refunded.", ranking: ranking };
    }
    return {
      action: "settle",
      winners: paid.map(function (r) { return r.player_id; }),
      bps: paid.map(function (r) { return r.bps; }),
      ranking: ranking
    };
  }

  // ---------- Live standings ----------
  // The night so far, scored as if it ended right now: distance run so far, busiest
  // window so far, and tonight's blocks against the night before's final count. Only for
  // showing who's ahead. Payouts use resolveNight, after the night has ended.
  // live: { km, busiest (window index or indexes; -1 or [] before he runs), blocks, prevBlocks }
  function provisionalResult(night, live) {
    var none = { state: "void", reason: "Not known yet" };
    var busiest = Array.isArray(live.busiest) ? live.busiest : live.busiest != null && live.busiest >= 0 ? [live.busiest] : [];
    return {
      night: night, ended: true, provisional: true,
      distance: live.km != null && live.km > 0 ? { state: "resolved", km: live.km } : none,
      peak: busiest.length ? { state: "resolved", winners: busiest } : none,
      blocks: live.blocks != null && live.prevBlocks != null && live.blocks !== live.prevBlocks
        ? { state: "resolved", more: live.blocks > live.prevBlocks, cur: live.blocks, prev: live.prevBlocks } : none
    };
  }
  // Orders entries the way the pot ranks tickets: points, then the closer distance guess,
  // then the earlier ticket. Entries tied on all of those share a place.
  // Returns [{ entry, score, place }].
  function liveStandings(res, entries) {
    var scores = scoreNight(res, entries);
    function errKey(s) { return s.err == null ? 1e9 : s.err; }
    var rows = entries.map(function (e) { return { entry: e, score: scores.get(e.player_id) }; });
    rows.sort(function (a, b) {
      return (b.score.total - a.score.total) || (errKey(a.score) - errKey(b.score)) ||
        (Number(a.entry.boughtAt || 0) - Number(b.entry.boughtAt || 0)) ||
        (a.entry.player_id < b.entry.player_id ? -1 : a.entry.player_id > b.entry.player_id ? 1 : 0);
    });
    rows.forEach(function (r, i) {
      var p = rows[i - 1];
      r.place = p && p.score.total === r.score.total && errKey(p.score) === errKey(r.score) &&
        Number(p.entry.boughtAt || 0) === Number(r.entry.boughtAt || 0) ? p.place : i + 1;
    });
    return rows;
  }

  // Pot tickets in one shape for both contract versions. Version 1 sells one ticket per
  // wallet, so the wallet is the ticket's id; version 2 numbers tickets within the night.
  // The page and the bot both use this, so ties break the same way in both.
  function potTicketId(version, index, address) {
    return version >= 2 ? "t" + ("000" + index).slice(-4) : String(address).toLowerCase();
  }
  function potTickets(version, raw) {
    function one(t, i, addr) {
      return {
        player_id: potTicketId(version, i, addr), index: i, address: addr,
        distance_km: Number(t.distanceDeci) / 10, peak_block: Number(t.peakBlock), more_blocks: !!t.moreBlocks,
        boughtAt: Number(t.boughtAt), refunded: !!t.refunded
      };
    }
    if (version >= 2) return Array.from(raw.tickets || []).map(function (t, i) { return one(t, i, t.player); });
    var picks = Array.from(raw.picks || []);
    return Array.from(raw.players || []).map(function (addr, i) { return one(picks[i], i, addr); });
  }

  return {
    HOUR: HOUR, DAY: DAY, COVERAGE_OK_BPS: COVERAGE_OK_BPS, VOID_AFTER: VOID_AFTER,
    POT_SHARES_3: POT_SHARES_3, POT_SHARES_2: POT_SHARES_2, MAX_WINNERS: MAX_WINNERS,
    dateStr: dateStr, addDays: addDays, nightStart: nightStart, nightEnd: nightEnd,
    liveNightAt: liveNightAt, openNightAt: openNightAt, nightToDay: nightToDay, dayToNight: dayToNight, slotOf: slotOf,
    parseStats: parseStats, parseSettlements: parseSettlements,
    resolveNight: resolveNight, distancePoints: distancePoints, scoreNight: scoreNight, potPayouts: potPayouts,
    potTicketId: potTicketId, potTickets: potTickets,
    provisionalResult: provisionalResult, liveStandings: liveStandings
  };
});
