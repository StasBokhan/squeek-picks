"""Seasons on the page: the season band and tab, points, the double, and the live calls."""
import json, threading, functools, http.server, os, shutil, time
from common import *
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
SITE = SCR + "/site_season"
os.makedirs(SITE, exist_ok=True)
for f in ("index.html", "wallet.js", "icon.svg", "squeektoshi.jpg", "diary.html", "overlay.html"): shutil.copy(PROJ + "/" + f, SITE + "/" + f)
shutil.copytree(PROJ + "/vendor", SITE + "/vendor", dirs_exist_ok=True)
shutil.copytree(PROJ + "/fonts", SITE + "/fonts", dirs_exist_ok=True)
s = http.server.ThreadingHTTPServer(("127.0.0.1", 8010), functools.partial(Q, directory=SITE)); threading.Thread(target=s.serve_forever, daemon=True).start()
def config(seasons): open(SITE + "/config.js", "w").write("window.SQUEEK_CONFIG = " + json.dumps({"SEASONS": seasons}) + ";\n")
route = lambda page: page.route("**/*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(api_body(r.request.url.split("api.squeekchain.com", 1)[1]))) if "api.squeekchain.com" in r.request.url else r.continue_() if r.request.url.startswith("http://127.0.0.1") else r.abort())
now = int(time.time() * 1000); live = live_night(now); open_n = add_days(live, 1)
errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    def page_with(seed=None, vw=1280):
        ctx = b.new_context(viewport={"width": vw, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        if seed: ctx.add_init_script("localStorage.setItem('squeekpicks.local.v1', %s)" % json.dumps(json.dumps(seed)))
        pg = ctx.new_page(); route(pg); pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto("http://127.0.0.1:8010/"); pg.wait_for_timeout(3500)
        return ctx, pg
    # ----- a season under way: started 3 nights before tonight -----
    config([{"name": "Season 1", "start": add_days(live, -3), "nights": 14}])
    seed = {"nickname": "wheel_watcher", "picks": {add_days(live, -k): {"distance_km": 8.0 + (k % 4), "peak_block": 3, "more_blocks": False, "double_market": "peak"} for k in (1, 2)}}
    ctx, pg = page_with(seed)
    band = pg.inner_text("#season-band")
    check("the ticket says which season night you're picking", pg.locator("#season-band").is_visible() and "Night 5 of 14" in band and "Season 1" in band and pg.locator("#season-band .dots i").count() == 14, band)
    check("players see their season place on their ticket", "#1 in Season 1" in pg.inner_text("#you-line") and "220 pts" in pg.inner_text("#you-line"), pg.inner_text("#you-line"))
    peak = pg.inner_text("#pick-peak")
    check("peak options show only his diary, never the crowd", pg.locator("#pick-peak .bar").count() == 8 and "picked by" not in peak and "nobody yet" not in peak and " pts" not in peak.lower() and pg.inner_text("#pts-peak") == "5–40 pts", peak[:200])
    check("blocks are plain More and Fewer", pg.inner_text("#pick-more button[data-more='true']").upper() == "MORE" and pg.inner_text("#pick-more button[data-more='false']").upper() == "FEWER" and pg.inner_text("#pts-blocks") == "5–25 pts", pg.inner_text("#pick-more"))
    hints = pg.inner_text("#hint-peak") + pg.inner_text("#hint-blocks")
    check("hints never show how others picked", "% of players" not in hints and "picked" not in hints, hints)
    check("the double is offered", pg.locator("#double-row").is_visible())
    pg.fill("#pick-distance", "10.4"); pg.click("#pick-peak button[data-block='4']"); pg.click("#pick-more button[data-more='false']")
    pg.click("#pick-double button[data-double='peak']")
    check("no best-case points line", pg.locator("#best-case").count() == 0 and "If it all comes in" not in pg.inner_text("#ticket"))
    check("the double shows pressed", pg.get_attribute("#pick-double button[data-double='peak']", "aria-pressed") == "true")
    pg.click("#pick-double button[data-double='peak']")
    check("pressing the double again takes it off", pg.get_attribute("#pick-double button[data-double='peak']", "aria-pressed") == "false")
    pg.click("#pick-double button[data-double='blocks']"); pg.click("#save"); pg.wait_for_timeout(600)
    st = json.loads(pg.evaluate("localStorage.getItem('squeekpicks.local.v1')"))
    check("saving keeps the double", st["picks"].get(open_n, {}).get("double_market") == "blocks", json.dumps(st["picks"].get(open_n)))
    check("Season tab leads the leaderboard", pg.locator("#tab-season").is_visible() and pg.get_attribute("#tab-season", "aria-selected") == "true" and pg.inner_text("#board-h").upper() == "SEASON 1 LEADERBOARD", pg.inner_text("#board-h"))
    sb = pg.inner_text("#board-season")
    check("season board scores the season's nights", "wheel_watcher" in sb and "Season 1" in sb, sb[:300])
    res = pg.inner_text("#results")
    check("results name the double", "doubled peak window +31" in res, res[-300:])
    you = pg.inner_text("#you-line")
    check("your ticket shows the season place", "SEASON 1" in you.upper() and "#1" in you, you)
    pg.click("#small-print summary")
    rules = pg.inner_text("#rules-season")
    check("How it works explains the season", "by the odds" in rules and "Double one pick" in rules and "classic points" in rules and "until picks close" in rules, rules)
    pg.click("#tab-week"); pg.wait_for_timeout(200)
    check("you can still switch to This week", pg.get_attribute("#tab-week", "aria-selected") == "true" and pg.locator("#board-season").is_hidden())
    pg.locator("#ticket").screenshot(path=SCR + "/season-ticket.png")
    pg.screenshot(path=SCR + "/season-top.png")
    ctx.close()
    ctx, pg = page_with(seed, vw=390)
    pg.screenshot(path=SCR + "/season-phone-top.png")
    pg.locator("#ticket").screenshot(path=SCR + "/season-phone-ticket.png")
    ctx.close()
    # ----- live calls, at 22:30 UTC on tonight's night -----
    import datetime as _dt
    T = night_start(live) + int(10.5 * 3600_000); FIX["now"] = T
    hot = [0] * 48; hot[18] = hot[19] = 2000; hot[20] = 1500            # tonight's first hour: 4,000 spins, line 3,000
    calm = [0] * 48; calm[18] = calm[19] = 1500; calm[22] = calm[23] = 1000   # last night's 23:00 hour: 2,000, line 3,000
    FIX["special"] = {live: {"slots": hot}, add_days(live, -1): {"slots": calm}}
    seed3 = {"nickname": "wheel_watcher", "picks": {add_days(live, -1): {"distance_km": 9.0, "peak_block": 3, "more_blocks": False}},
             "calls": {live: {"1": True}, add_days(live, -1): {"2": False}}}
    def clocked(seed, vw=1280):
        ctx = b.new_context(viewport={"width": vw, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        if seed: ctx.add_init_script("localStorage.setItem('squeekpicks.local.v1', %s)" % json.dumps(json.dumps(seed)))
        pg = ctx.new_page(); route(pg); pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.clock.install(time=_dt.datetime.fromtimestamp(T / 1000, _dt.timezone.utc))
        pg.goto("http://127.0.0.1:8010/"); pg.wait_for_timeout(3500)
        return ctx, pg
    config([{"name": "Season 1", "start": add_days(live, -3), "nights": 14}])
    ctx, pg = clocked(seed3)
    calls = pg.inner_text("#call-list")
    check("three live calls tonight", pg.locator("#calls").is_visible() and pg.locator("#call-list .call").count() == 3, calls[:300])
    first = pg.inner_text("#call-list .call >> nth=0")
    check("the first hour is settled against its line", "SETTLED" in first.upper() and "More or fewer than 3,000 spins?" in first and "4,000 spins: more." in first and "You called it, +" in first, first)
    second = pg.inner_text("#call-list .call >> nth=1")
    check("the next call is open, plain More or Fewer, no split shown", "OPEN" in second.upper() and pg.inner_text("#call-list .call >> nth=1 >> button[data-over='true']").upper() == "MORE" and "so far" not in second.split("spins?")[1] and "Closes" in second, second)
    pg.click("#call-list .call >> nth=1 >> button[data-over='false']"); pg.wait_for_timeout(500)
    st = json.loads(pg.evaluate("localStorage.getItem('squeekpicks.local.v1')"))
    check("answering saves it", st["calls"][live].get("2") is False and "Saved" in pg.inner_text("#calls-msg"), json.dumps(st.get("calls")) + pg.inner_text("#calls-msg"))
    check("your answer shows pressed", pg.get_attribute("#call-list .call >> nth=1 >> button[data-over='false']", "aria-pressed") == "true")
    res = pg.inner_text("#results")
    check("last night's results count the live calls", "live calls 5" in res, res[-300:])
    pg.locator("#calls").screenshot(path=SCR + "/calls-desktop.png")
    ctx.close()
    ctx, pg = clocked(None, vw=390)
    check("without a nickname the buttons ask you to join first", pg.locator("#call-list button[data-call]:not([disabled])").count() == 0 and "Save your picks with a nickname" in pg.inner_text("#call-list"), pg.inner_text("#call-list")[:300])
    pg.locator("#calls").screenshot(path=SCR + "/calls-phone.png")
    ctx.close()
    FIX["now"] = 0; FIX["special"] = {}

    # ----- a season coming up -----
    config([{"name": "Season 1", "start": add_days(open_n, 7), "nights": 14}])
    ctx, pg = page_with()
    band = pg.inner_text("#season-band")
    check("upcoming season gets a teaser", "Starts" in band and "Season 1" in band, band)
    check("before it starts, picks keep the classic points", pg.inner_text("#pts-peak") == "20 pts" and pg.locator("#double-row").is_hidden() and pg.locator("#tab-season").is_hidden())
    ctx.close()
    # ----- a season just over -----
    config([{"name": "Season 1", "start": add_days(live, -18), "nights": 14}])
    seed2 = {"nickname": "wheel_watcher", "picks": {add_days(live, -k): {"distance_km": 9.0, "peak_block": 3, "more_blocks": False} for k in range(5, 18)}}
    ctx, pg = page_with(seed2)
    band = pg.inner_text("#season-band")
    check("a finished season names its winner", "IS OVER" in band.upper() and "wheel_watcher won it" in band, band)
    check("its final board stays up", pg.locator("#tab-season").is_visible() and "champion" in pg.inner_text("#board-season").lower(), pg.inner_text("#board-season")[:200])
    ctx.close()
    # ----- no seasons: everything as before -----
    config([])
    ctx, pg = page_with()
    check("with no seasons nothing changes", pg.locator("#season-band").is_hidden() and pg.locator("#tab-season").is_hidden() and pg.inner_text("#pts-peak") == "20 pts" and pg.locator("#double-row").is_hidden())
    ctx.close()
    b.close()
finish(errors)
