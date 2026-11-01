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
      s.perfect = s.total === 75;
      out.set(p.player_id, s);
    });
    return out;
  }

  // ---------- Seasons ----------
  // seasons: [{ name, start (the first night, "YYYY-MM-DD"), nights }]. The free points game
  // scores a season's nights by the odds (below); other nights and the pot keep the classic rules.
  function seasonOf(night, seasons) {
    var list = Array.isArray(seasons) ? seasons : [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (x && x.start && night >= x.start && night < addDays(x.start, Number(x.nights) || 14)) {
        return { index: i, name: x.name || "Season " + (i + 1), start: x.start, nights: Number(x.nights) || 14, last: addDays(x.start, (Number(x.nights) || 14) - 1) };
      }
    }
    return null;
  }

  // What a right call on the peak window or the blocks is worth in a season: the fewer
  // players made the same pick, the more. Counts are smoothed with one imaginary player per
  // option, so a handful of players can't swing a pick to the extremes.
  var ODDS = { peak: { top: 40, low: 5, options: 8 }, blocks: { top: 25, low: 5, options: 2 }, call: { top: 15, low: 5, options: 2 } };
  function oddsPoints(market, count, players) {
    var m = ODDS[market], share = (count + 1) / (players + m.options);
    return Math.max(m.low, Math.min(m.top, Math.round(m.top * (1 - share))));
  }
  // How many players picked each option: { players, peak: [8], more, fewer }.
  function crowdOf(picks) {
    var c = { players: picks.length, peak: [0, 0, 0, 0, 0, 0, 0, 0], more: 0, fewer: 0 };
    picks.forEach(function (p) { c.peak[p.peak_block]++; if (p.more_blocks) c.more++; else c.fewer++; });
    return c;
  }
  var DOUBLE_MARKETS = ["distance", "peak", "blocks"];

  // A season night: distance as always; the peak window and blocks by the odds, from every
  // pick that night; and one market per pick (double_market) counting twice.
  function scoreSeason(res, picks) {
    var base = scoreNight(res, picks), crowd = crowdOf(picks), out = new Map();
    picks.forEach(function (p) {
      var b = base.get(p.player_id), s = Object.assign({}, b);
      s.worth = { peak: oddsPoints("peak", crowd.peak[p.peak_block], crowd.players), blocks: oddsPoints("blocks", p.more_blocks ? crowd.more : crowd.fewer, crowd.players) };
      if (res.peak.state === "resolved") s.peak = res.peak.winners.indexOf(p.peak_block) >= 0 ? s.worth.peak : b.peak;
      if (res.blocks.state === "resolved") s.blocks = p.more_blocks === res.blocks.more ? s.worth.blocks : 0;
      s.double = DOUBLE_MARKETS.indexOf(p.double_market) >= 0 ? p.double_market : null;
      s.bonus = s.double === "distance" ? s.distance + s.closest : s.double === "peak" ? s.peak : s.double === "blocks" ? s.blocks : 0;
      s.total = s.distance + s.closest + s.peak + s.blocks + s.bonus;
      s.perfect = b.perfect;
      s.season = true;
      out.set(p.player_id, s);
    });
    return out;
  }
  // The points game's scores for a night: a season's rules on its nights, classic otherwise.
  function scoreGame(res, picks, seasons) {
    return seasonOf(res.night, seasons) ? scoreSeason(res, picks) : scoreNight(res, picks);
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

  // ---------- Live calls ----------
  // In a season, three quick calls a night on one hour of his running each: more or fewer
  // spins than his usual for that hour. A call closes when its hour starts and settles from
  // the half-hour stats once the hour is over. Hours in UTC, by half-hour slot of the night.
  var CALLS = [
    { no: 1, slot: 18 },   // 21:00 to 22:00 UTC
    { no: 2, slot: 22 },   // 23:00 to 00:00 UTC
    { no: 3, slot: 26 }    // 01:00 to 02:00 UTC
  ];
  var CALL_MIN_LINE = 50;
  function callOf(no) { for (var i = 0; i < CALLS.length; i++) if (CALLS[i].no === Number(no)) return CALLS[i]; return null; }
  function callCloses(night, no) { return nightStart(night) + callOf(no).slot * 30 * 60e3; }
  function callEnds(night, no) { return callCloses(night, no) + HOUR; }
  // The line: his median spins in that hour over the 7 nights ending two nights before (all
  // archived by the time the night starts, so everyone gets the same line), rounded to 50.
  // slotsOf(date) gives that night's 48 half-hour spin counts, or null. null: too little history.
  function callLine(night, no, slotsOf) {
    var c = callOf(no), vals = [];
    for (var k = 2; k <= 8; k++) {
      var s = slotsOf(addDays(night, -k));
      if (s && s[c.slot] != null && s[c.slot + 1] != null) vals.push(Number(s[c.slot]) + Number(s[c.slot + 1]));
    }
    if (vals.length < 3) return null;
    vals.sort(function (a, b) { return a - b; });
    var m = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
    return Math.max(CALL_MIN_LINE, Math.round(m / 50) * 50);
  }
  // A call's state: open (answers taken), live (its hour is running), wait (data not in),
  // void (no data for that hour) or resolved with the hour's spins.
  function resolveCall(night, no, now, data) {
    var c = callOf(no), end = callEnds(night, no);
    if (now < callCloses(night, no)) return { state: "open" };
    if (now < end) return { state: "live" };
    var n = data.nights.get(night), has = n && n.slots && n.slots[c.slot] != null && n.slots[c.slot + 1] != null;
    if (data.statsAt < end + 10 * 60e3 || !has) {
      return now >= nightEnd(night) + VOID_AFTER ? { state: "void", reason: "No data for that hour" } : { state: "wait", reason: "Waiting for the hour's data" };
    }
    return { state: "resolved", spins: n.slots[c.slot] + n.slots[c.slot + 1] };
  }
  // Points per player for a night's calls. answers: [{ player_id, call_no, over }];
  // lines and results keyed by call number. A right answer pays 5 to 15 by the odds;
  // a call that lands exactly on its line counts for nobody.
  function scoreCalls(answers, lines, results) {
    var out = new Map();
    CALLS.forEach(function (c) {
      var list = answers.filter(function (a) { return Number(a.call_no) === c.no; });
      var r = results[c.no], line = lines[c.no];
      if (!list.length || !r || r.state !== "resolved" || line == null || r.spins === line) return;
      var over = r.spins > line, same = list.filter(function (a) { return !!a.over === over; }).length;
      var pts = oddsPoints("call", same, list.length);
      list.forEach(function (a) {
        var s = out.get(a.player_id) || { points: 0, right: 0, settled: 0 };
        s.settled++;
        if (!!a.over === over) { s.points += pts; s.right++; }
        out.set(a.player_id, s);
      });
    });
    return out;
  }

  // ---------- Night Cards ----------
  // A collectible for each season night a player calls well (contracts/SqueekNightCards.sol).
  var CARD_KINDS = ["Called it", "Bullseye", "Lone call", "Perfect night", "Season champion"];
  var CARD_RARITY = ["Common", "Rare", "Epic", "Epic", "Legendary"];
  var LONE_MIN = 3;   // a lone call needs at least this many players on that market
  // The card each player earned for a season night: { kind, points } by player. The best of:
  // a perfect night (3), a lone call (2: right when nobody else was), a bullseye (1: distance
  // within 0.25 km) or 20+ points (0). Players with none get no card.
  function nightCards(res, picks, answers, lines, callResults) {
    var scores = scoreSeason(res, picks), crowd = crowdOf(picks), calls = scoreCalls(answers, lines, callResults);
    var lone = new Set();
    picks.forEach(function (p) {
      if (crowd.players < LONE_MIN) return;
      if (res.peak.state === "resolved" && res.peak.winners.indexOf(p.peak_block) >= 0 && crowd.peak[p.peak_block] === 1) lone.add(p.player_id);
      if (res.blocks.state === "resolved" && p.more_blocks === res.blocks.more && (p.more_blocks ? crowd.more : crowd.fewer) === 1) lone.add(p.player_id);
    });
    CALLS.forEach(function (c) {
      var r = callResults[c.no], line = lines[c.no], list = answers.filter(function (a) { return Number(a.call_no) === c.no; });
      if (!r || r.state !== "resolved" || line == null || r.spins === line || list.length < LONE_MIN) return;
      var right = list.filter(function (a) { return !!a.over === (r.spins > line); });
      if (right.length === 1) lone.add(right[0].player_id);
    });
    var out = new Map(), ids = new Set();
    scores.forEach(function (s, id) { ids.add(id); });
    calls.forEach(function (c, id) { ids.add(id); });
    ids.forEach(function (id) {
      var s = scores.get(id), c = calls.get(id);
      var points = (s && s.counted ? s.total : 0) + (c ? c.points : 0), kind = null;
      if (s && s.perfect) kind = 3;
      else if (lone.has(id)) kind = 2;
      else if (s && res.distance.state === "resolved" && s.err != null && s.err <= 0.25) kind = 1;
      else if (points >= 20) kind = 0;
      if (kind != null) out.set(id, { kind: kind, points: Math.min(points, 65535) });
    });
    return out;
  }
  // What a player signs to have their cards sent to a wallet; the minting bot checks it.
  function linkMessage(wallet, playerId) {
    return "Squeek Picks: send my Night Cards to " + String(wallet).toLowerCase() + ". Player " + playerId + ".";
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
  // Returns [{ entry, score, place }]. With `seasons`, entries are points-game picks and
  // a season night is scored by its rules; without, by the classic (pot) rules.
  // `extra`: points from elsewhere that night (live calls), by player, added to each total.
  function liveStandings(res, entries, seasons, extra) {
    var scores = seasons ? scoreGame(res, entries, seasons) : scoreNight(res, entries);
    if (extra) scores.forEach(function (s, id) { var x = extra.get(id); if (x && x.points) { s.calls = x.points; s.total += x.points; } });
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

  // ---------- Diary: what happened in a night ----------
  // Runs (half hours in a row with spins), when he started and stopped, his busiest window.
  // A half hour with fewer than 30 spins (a few metres) doesn't count as running.
  var RUN_MIN_SPINS = 30;
  function nightFacts(n) {
    var win = new Array(8).fill(0), runs = [], cur = null, first = -1, last = -1, max = 0, maxAt = -1;
    for (var i = 0; i < 48; i++) {
      var v = n.slots[i] || 0;
      win[Math.floor(i / 6)] += v;
      if (v > max) { max = v; maxAt = i; }
      if (v >= RUN_MIN_SPINS) {
        if (first < 0) first = i;
        last = i;
        if (cur) cur.end = i + 1; else { cur = { start: i, end: i + 1 }; runs.push(cur); }
      } else cur = null;
    }
    var top = Math.max.apply(null, win), longest = null;
    runs.forEach(function (r) { if (!longest || r.end - r.start > longest.end - longest.start) longest = r; });
    return {
      win: win, runs: runs, first: first, last: last, longest: longest, maxSlot: max, maxAt: maxAt,
      busiest: top > 0 ? win.indexOf(top) : -1
    };
  }
  function joinList(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  // What he usually does, over the last 30 nights in the diary.
  function diaryHabits(nights) {
    var list = nights.slice(-30), n = list.length;
    var counts = new Array(8).fill(0), wakes = {}, sleeps = [], kms = [], flips = [];
    list.forEach(function (x) {
      var f = x.facts;
      if (f.busiest >= 0) counts[f.busiest]++;
      if (f.first >= 0) { wakes[f.first] = (wakes[f.first] || 0) + 1; sleeps.push(f.last + 1); }
      kms.push(x.km);
      if (x.blocks != null && x.prevBlocks != null && x.blocks !== x.prevBlocks) flips.push(x.blocks > x.prevBlocks);
    });
    var wake = -1, wakeN = 0;
    Object.keys(wakes).forEach(function (k) { if (wakes[k] > wakeN) { wakeN = wakes[k]; wake = Number(k); } });
    var top = Math.max.apply(null, counts);
    return {
      n: n, list: list, counts: counts, top: top, topIdx: top > 0 ? counts.indexOf(top) : -1,
      ran: list.filter(function (x) { return x.facts.busiest >= 0; }).length,
      wake: wake, wakeN: wakeN, woke: Object.keys(wakes).reduce(function (a, k) { return a + wakes[k]; }, 0),
      sleepMin: sleeps.length ? Math.min.apply(null, sleeps) : -1, sleepMax: sleeps.length ? Math.max.apply(null, sleeps) : -1,
      kmMin: kms.length ? Math.min.apply(null, kms) : null, kmMax: kms.length ? Math.max.apply(null, kms) : null,
      kmAvg: kms.length ? kms.reduce(function (a, b) { return a + b; }, 0) / kms.length : null,
      over10: kms.filter(function (k) { return k >= 10; }).length,
      flips: flips, more: flips.filter(Boolean).length
    };
  }

  // A few plain sentences about one night, from its half-hour data.
  // t(i) formats half hour i of the night as a clock time; ft(ms) formats a timestamp.
  // ctx: { habits (from diaryHabits), firstNight, rec: { run, halfHour, halfHourAt } }
  function describeNight(n, ctx, t, ft) {
    var f = n.facts, night = n.night, out = [];
    if (night === ctx.firstNight) out.push("The camera's first night.");
    if (f.first < 0) { out.push("He took the night off. Not a single spin."); return out.join(" "); }
    var L = f.longest, firstRun = f.runs[0], usual = night !== ctx.firstNight && ctx.habits.n >= 3 && ctx.habits.wake === f.first && ctx.habits.wakeN >= 2;
    var longMin = (L.end - L.start) * 30;
    var recRun = ctx.rec.run === night ? ", his longest run yet" : "";
    if (firstRun === L && longMin >= 60) out.push("Up at " + t(f.first) + (usual ? " as usual" : "") + " and ran non-stop until " + t(L.end) + recRun + ".");
    else {
      out.push("Up at " + t(f.first) + (usual ? " as usual" : "") + ((firstRun.end - firstRun.start) >= 2 ? " and ran until " + t(firstRun.end) : "") + ".");
      if (longMin >= 60) out.push("Then ran non-stop from " + t(L.start) + " to " + t(L.end) + recRun + ".");
      else if (f.runs.length > 1) out.push("He ran in short bursts, none longer than " + longMin + " minutes.");
    }
    var others = f.runs.filter(function (r) { return r !== L && r !== firstRun; }).map(function (r) { return t(r.start); });
    if (others.length > 3) out.push("Several shorter runs after that.");
    else if (others.length) out.push((others.length === 1 ? "One more run at " : "More runs at ") + joinList(others) + ".");
    if (ctx.rec.halfHour === night && ctx.rec.halfHourAt) out.push("His busiest half hour ever came at " + ft(ctx.rec.halfHourAt) + ".");
    out.push("Asleep by " + t(f.last + 1) + ".");
    if (n.coverageBps < 9500 && night !== ctx.firstNight) out.push("Part of this night's data is missing.");
    return out.join(" ");
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
    CARD_KINDS: CARD_KINDS, CARD_RARITY: CARD_RARITY, nightCards: nightCards, linkMessage: linkMessage,
    CALLS: CALLS, CALL_MIN_LINE: CALL_MIN_LINE, callOf: callOf, callCloses: callCloses, callEnds: callEnds, callLine: callLine, resolveCall: resolveCall, scoreCalls: scoreCalls,
    seasonOf: seasonOf, ODDS: ODDS, oddsPoints: oddsPoints, crowdOf: crowdOf, scoreSeason: scoreSeason, scoreGame: scoreGame, DOUBLE_MARKETS: DOUBLE_MARKETS,
    potTicketId: potTicketId, potTickets: potTickets,
    provisionalResult: provisionalResult, liveStandings: liveStandings,
    RUN_MIN_SPINS: RUN_MIN_SPINS, nightFacts: nightFacts, diaryHabits: diaryHabits, describeNight: describeNight
  };
});
