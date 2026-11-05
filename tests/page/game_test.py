"""The game page against a local chain posing as Sepolia, a stand-in wallet and a fake Squeekchain
API: buying and changing tickets, the race, the diary, results after the payout bot runs, My
tickets, sharing, old pots, and the wallet kit."""
from common import *

class ApiHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = api_body(self.path)
        self.send_response(200 if body else 404); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps(body or {}).encode())
    def log_message(self, *a): pass
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve(port, handler):
    s = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=s.serve_forever, daemon=True).start(); return s

node = start_chain()
try:
    for _ in range(60):
        try: rpc("eth_chainId"); break
        except Exception: time.sleep(0.5)
    accts = rpc("eth_accounts")
    helper = lambda *a: subprocess.run(["node", "lib/chain.mjs", *a], cwd=CHAIN, capture_output=True, text=True, check=True).stdout.strip()
    pot = helper("deploy")
    old = helper("deploy1")   # a version 1 pot, like the one deployed before the upgrade
    old2 = helper("deploy2")  # a version 2 pot, the one live before version 3

    for site, cfg in ((SCR + "/site", {"POT_ADDRESS": pot}), (SCR + "/site2", {}), (SCR + "/site3", {"POT_ADDRESS": pot, "REOWN_PROJECT_ID": "0123456789abcdef0123456789abcdef"}),
                      (SCR + "/site4", {"POT_ADDRESS": old}), (SCR + "/site5", {"POT_ADDRESS": pot, "OLD_POTS": [old]}), (SCR + "/site6", {"POT_ADDRESS": old2})):
        os.makedirs(site, exist_ok=True)
        for f in ("index.html", "wallet.js", "icon.svg", "squeektoshi.jpg", "diary.html", "overlay.html"): shutil.copy(PROJ + "/" + f, site + "/" + f)
        shutil.copytree(PROJ + "/vendor", site + "/vendor", dirs_exist_ok=True)
        shutil.copytree(PROJ + "/fonts", site + "/fonts", dirs_exist_ok=True)
        cfg.update({"RPC_URL": "http://127.0.0.1:8545"})
        open(site + "/config.js", "w").write("window.SQUEEK_CONFIG = " + json.dumps(cfg) + ";\n")
    serve(8000, functools.partial(Quiet, directory=SCR + "/site"))
    serve(8001, functools.partial(Quiet, directory=SCR + "/site2"))
    serve(8002, functools.partial(Quiet, directory=SCR + "/site3"))
    serve(8003, functools.partial(Quiet, directory=SCR + "/site4"))
    serve(8004, functools.partial(Quiet, directory=SCR + "/site5"))
    serve(8005, functools.partial(Quiet, directory=SCR + "/site6"))
    serve(8787, ApiHandler)

    WALLET = """
      window.__acct = %s; window.__connected = %s;
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {},
        async request({ method, params }) {
          (window.__calls = window.__calls || []).push(method);
          if (method === "eth_requestAccounts") { window.__connected = true; return [window.__acct]; }
          if (method === "eth_accounts") return window.__connected ? [window.__acct] : [];
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
          if (method === "eth_sendTransaction") params = params.map((p) => Object.assign({}, p, { from: window.__acct }));
          const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
          const j = await r.json();
          if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
          return j.result;
        } };"""

    CDN = []
    def route(page):
        page.route("**/*", lambda r: (
            (CDN.append(r.request.url), r.abort())[1] if "jsdelivr" in r.request.url else
            r.fulfill(status=200, content_type="application/json", body=json.dumps(api_body(r.request.url.split("api.squeekchain.com", 1)[1]))) if "api.squeekchain.com" in r.request.url else
            r.continue_() if r.request.url.startswith("http://127.0.0.1") else r.abort()))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        errors = []
        # ---------- Phase A: buy and change a ticket ----------
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script(WALLET % (json.dumps(accts[2]), "false"))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8000/")
        page.wait_for_selector("#pot:not([hidden])", timeout=20000)
        page.wait_for_selector("#pot-actions button[data-pot=connect]", timeout=20000)
        check("pot shows a Connect wallet button", True)
        check("one look: no theme switch, fonts from the site", page.locator("#theme-btn").count() == 0 and page.evaluate("document.documentElement.dataset.theme || 'none'") == "none" and
              page.evaluate("[...document.styleSheets].every(s => !s.href || !s.href.includes('googleapis'))"))
        check("pot names its night", "Pot for" in page.inner_text("#pot-num") and "the same picks on a test-ETH ticket" in page.inner_text("#pot-for"), page.inner_text("#pot-num") + page.inner_text("#pot-for"))
        check("header has a Connect wallet button", page.is_visible("#me button[data-wallet=connect]"))
        check("My tickets stays hidden until a wallet is connected", page.locator("#dash").is_hidden())
        check("pot tab is offered on the leaderboard", page.is_visible("#tab-pot"))
        page.click("#pot-actions button[data-pot=connect]")
        page.wait_for_selector("#pot-actions button[data-pot=buy]", timeout=15000)
        check("My tickets appears once connected", page.locator("#dash").is_visible())
        check("buy is disabled until all three picks are in", page.is_disabled("#pot-actions button[data-pot=buy]"))
        page.fill("#pick-distance", "9.6"); page.click("#pick-peak button[data-block='3']"); page.click("#pick-more button[data-more='true']")
        check("buy enables with picks", not page.is_disabled("#pot-actions button[data-pot=buy]"))
        page.click("#pot-actions button[data-pot=buy]")
        wait_text(page, 'pot-msg', 'Ticket bought', timeout=30000)
        check("ticket bought through the wallet", True, page.inner_text("#pot-msg"))
        check("position shows the ticket", "Your ticket for" in page.inner_text("#pot-me") and "9.6 km" in page.inner_text("#pot-me"), page.inner_text("#pot-me"))
        page.fill("#pick-distance", "9.4")
        page.wait_for_selector("#pot-me button[data-pot=change]", timeout=5000)
        page.click("#pot-me button[data-pot=change]")
        wait_text(page, 'pot-msg', 'Ticket updated', timeout=30000)
        calls = page.evaluate("window.__calls || []")
        check("wallet only gets the transaction itself", "eth_sendTransaction" in calls and not any(c in calls for c in ("eth_estimateGas", "eth_blockNumber", "eth_gasPrice")), str(calls))
        check("chip names the wallet", "MetaMask" in page.inner_text("#pot-actions"), page.inner_text("#pot-actions"))
        dash = page.inner_text("#dash")
        check("dashboard lists the open ticket", "open" in dash.lower() and "9.4 km" in dash and "0.01" in dash, dash)
        check("header shows the connected wallet", page.is_visible("#me button[data-wallet=account]") and accts[2][2:6].lower() in page.inner_text("#me").lower(), page.inner_text("#me"))
        check("changed picks reach the contract", "9.4 km" in page.inner_text("#pot-me"), page.inner_text("#pot-me"))
        check("same picks again get a nudge to spread guesses", "already have a ticket with these picks" in page.inner_text("#pot-actions"), page.inner_text("#pot-actions"))
        page.fill("#pick-distance", "9.6"); page.click("#pick-peak button[data-block='2']")
        page.click("#pot-actions button[data-pot=buy]")
        wait_text(page, 'pot-msg', 'Another ticket bought', timeout=30000)
        pm = page.inner_text("#pot-me")
        check("a second ticket with its own picks", "Your 2 tickets" in pm and "9.4 km" in pm and "9.6 km" in pm, pm)
        check("buy button offers more tickets up to the limit", "buy another ticket" in page.inner_text("#pot-actions").lower() and "3 more allowed" in page.inner_text("#pot-actions"), page.inner_text("#pot-actions"))

        open_night = add_days(live_night(int(time.time() * 1000)), 1)
        for idx, pick in ((3, ("90", "3", "true")), (4, ("80", "2", "true")), (5, ("50", "0", "false"))):
            helper("buy", pot, open_night, str(idx), *pick)
        # The old pot sells the same night too, as it did before the upgrade.
        helper("buy", old, open_night, "2", "70", "4", "false")
        helper("buy", old, open_night, "3", "60", "1", "true")
        page.reload(); wait_text(page, 'pot-num', '5', timeout=20000)
        check("pot shows 5 tickets and 0.05", "0.05" in page.inner_text("#pot-num"), page.inner_text("#pot-num"))
        check("payout preview is 50/30/20", all(x in page.inner_text("#pot-payouts") for x in ("0.025", "0.015", "0.01")), page.inner_text("#pot-payouts"))
        onchain = json.loads(helper("night", pot, open_night))
        check("contract holds both tickets the page sent", onchain["version"] == 3 and onchain["picks"][:2] == [[94, 3, True], [96, 2, True]] and
              [a.lower() for a in onchain["players"][:2]] == [accts[2].lower()] * 2 and onchain["pot"] == str(5 * 10**16), str(onchain))
        page.locator("#pot").screenshot(path=SCR + "/ui-pot.png")
        ctx.close()

        # ---------- Phase G: that night running, who's winning right now ----------
        # 03:10 UTC: he has run 10.07 km, busiest window 22:00-1:00 Paris time, 1,000 blocks vs 1,007.
        # An hour earlier he was at 9.51 km, so the 9.6 km ticket moved up past the 9.4 km one.
        TG = night_start(open_night) + 15 * 3600_000 + 600_000
        FIX["now"] = TG
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script(WALLET % (json.dumps(accts[2]), "true"))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.clock.install(time=dt.datetime.fromtimestamp(TG / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8000/")
        wait_text(page, 'race-list', '0.025 ETH', timeout=30000)
        lines = page.inner_text("#race-lines")
        check("tonight so far: busiest window and blocks, him on the ruler", "22:00–1:00" in lines and "1,000 / 1,007" in lines and "fewer" in lines and "10.1" in page.inner_text("#track"), lines + " | " + page.inner_text("#track"))
        rows = page.locator("#race-list .prow").all_inner_texts()
        check("race ranks pot tickets with the payout rules", len(rows) == 5 and "9.6 km" in rows[0] and "35" in rows[0] and "0.025 ETH" in rows[0] and "you" in rows[0].lower() and "#2" in rows[0]
              and "9.4 km" in rows[1] and "30" in rows[1] and "0.015 ETH" in rows[1] and "9.0 km" in rows[2] and "0.01 ETH" in rows[2] and "ETH" not in rows[3], " || ".join(rows))
        check("race shows movement since an hour ago", "up 1" in rows[0] and "down 1" in rows[1], " || ".join(r[:30] for r in rows))
        tips = page.locator("#race-list .prow .pt").evaluate_all("els => els.map(e => e.title)")
        check("each row's points split by market on hover", "distance 30, 3 hours 5, blocks 0" == tips[0] and "blocks 15" in tips[3], str(tips))
        check("race footer names the leader and when it's final", "alice.eth" not in page.inner_text("#race-foot") and "leads, if it ended now" in page.inner_text("#race-foot") and "Final after" in page.inner_text("#race-foot"), page.inner_text("#race-foot"))
        check("distance race has a pin per ticket and the hamster", page.locator("#track .pin").count() == 5 and page.locator("#track .ham").count() == 1, page.inner_text("#track"))
        wait_text(page, 'dash-body', 'right now', timeout=20000)
        dash = page.inner_text("#dash-body")
        check("My tickets shows each ticket's place right now", "#1 right now" in dash.lower() and "#2 right now" in dash.lower() and "worth 0.025 ETH if it ended now" in dash, dash[:700])
        page.click("#rtab-points")
        check("points tab says when nobody played", "Nobody in the points game picked tonight" in page.inner_text("#race-list"), page.inner_text("#race-list"))
        page.reload(); wait_text(page, 'race-list', 'Nobody in the points game', timeout=20000)
        check("race tab is remembered", page.get_attribute("#rtab-points", "aria-selected") == "true")
        page.click("#rtab-pot"); wait_text(page, 'race-list', '0.025 ETH', timeout=5000)
        page.locator("#race").screenshot(path=SCR + "/ui-race.png")
        ctx.close()
        ctx = browser.new_context(viewport={"width": 390, "height": 900}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script(WALLET % (json.dumps(accts[2]), "true"))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.clock.install(time=dt.datetime.fromtimestamp(TG / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8000/")
        wait_text(page, 'race-list', '0.025 ETH', timeout=30000)
        wait_text(page, 'dash-body', 'right now', timeout=20000)
        WIDE = "[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > 390.5 && getComputedStyle(e).position !== 'fixed').slice(0, 8).map(e => e.tagName + '#' + e.id + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))"
        check("no sideways scrolling on a phone", page.evaluate("document.documentElement.scrollWidth") <= 390, str(page.evaluate("document.documentElement.scrollWidth")) + " " + str(page.evaluate(WIDE)))
        page.locator("#race").screenshot(path=SCR + "/ui-race-phone.png")
        page.screenshot(path=SCR + "/ui-phone-full.png", full_page=True)
        ctx.close()

        # ---------- Phase H: Squeektoshi's diary ----------
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.clock.install(time=dt.datetime.fromtimestamp(TG / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8000/")
        wait_text(page, 'hint-peak', 'his busiest', timeout=30000)
        best = page.locator("#pick-peak button[data-block='3']")
        check("pick hints come from the diary, with a link to it", "of his last 29" in page.inner_text("#hint-peak") and page.locator("#hint-peak a[href='#diary']").count() == 1 and
              "29" in best.inner_text() and best.locator(".bar.on").count() == 1 and "his busiest on 29 nights" in best.get_attribute("aria-label") and page.locator("#pick-peak .h.on").count() == 1, page.inner_text("#hint-peak") + " | " + page.inner_text("#pick-peak")[:200])
        page.click("a.nav-btn[href='#diary']")
        page.wait_for_function("document.body.dataset.view === 'diary'", timeout=5000)
        check("diary opens as its own view", not page.is_visible("#race") and page.is_visible("#dy-list") and page.title().startswith("Squeektoshi's diary") and
              page.evaluate("document.activeElement.id") == "diary-h")
        entries = page.locator("#dy-list .dy-entry").all_inner_texts()
        check("diary shows the last 7 nights, newest first", len(entries) == 7 and entries[0].upper().startswith(dt.datetime.fromtimestamp(night_start(add_days(open_night, -1)) / 1000, dt.timezone.utc).strftime("%a %-d %b").upper()), entries[0][:80] if entries else "none")
        check("each night is written from its half hours", "Up at 22:00 as usual and ran non-stop until 4:00." in entries[0] and "Asleep by 4:00." in entries[0] and "Busiest 22:00–1:00" in entries[0], entries[0][:300])
        check("habits count his busiest windows and wake-up time", "22:00–1:00 was his busiest on 29 of 29 nights." in page.inner_text("#dy-habits") and "His first spin came at 22:00 on 29 of 29 nights." in page.inner_text("#dy-habits"), page.inner_text("#dy-habits")[:600])
        rec = page.inner_text("#dy-records")
        check("records fall back to the saved half hours", "longest non-stop run\n6 hours" in rec.lower() and "nights in a row on the wheel\n29" in rec.lower() and "total distance" in rec.lower(), rec)
        page.click("#dy-list button[data-diary=all]")
        check("older nights open on request", page.locator("#dy-list .dy-entry").count() == 29)
        page.click("a.nav-btn[href='#game']")
        page.wait_for_function("document.body.dataset.view === 'game'", timeout=5000)
        check("back to the game", page.is_visible("#race") and not page.is_visible("#dy-list") and page.evaluate("location.hash") == "")
        page.goto("http://127.0.0.1:8000/diary.html")
        page.wait_for_function("document.body && document.body.dataset.view === 'diary'", timeout=15000)
        check("squeekpicks.xyz/diary lands on the diary", page.url.endswith("/#diary"), page.url)
        page.set_viewport_size({"width": 390, "height": 900}); page.wait_for_timeout(300)
        check("diary has no sideways scrolling on a phone", page.evaluate("document.documentElement.scrollWidth") <= 390, page.evaluate("document.documentElement.scrollWidth"))
        page.screenshot(path=SCR + "/ui-diary-phone.png", full_page=True)
        ctx.close()

        # ---------- Phase J: streaks, badges and the week board ----------
        live = open_night
        mine = {add_days(live, -3): {"distance_km": 7.0, "peak_block": 2, "more_blocks": True},
                add_days(live, -2): {"distance_km": 9.5, "peak_block": 3, "more_blocks": True},
                add_days(live, -1): {"distance_km": 9.0, "peak_block": 3, "more_blocks": False},   # a perfect night
                live: {"distance_km": 9.9, "peak_block": 3, "more_blocks": False},
                add_days(live, 1): {"distance_km": 9.6, "peak_block": 3, "more_blocks": False}}
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script("localStorage.setItem('squeekpicks.local.v1', %s)" % json.dumps(json.dumps({"nickname": "streaker", "picks": mine})))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.clock.install(time=dt.datetime.fromtimestamp(TG / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8000/")
        wait_text(page, 'you-line', 'nights in a row', timeout=30000)
        check("your streak shows on your ticket", "5 nights in a row" in page.inner_text("#you-line") and "streaker's picks" in page.inner_text("#ticket-who").lower() and page.locator("#streak-note").is_hidden(), page.inner_text("#you-line"))
        check("the leaderboard opens on this week", page.get_attribute("#tab-week", "aria-selected") == "true" and page.is_visible("#board-week") and "top player is its champion" in page.inner_text("#board-week"), page.inner_text("#board-week")[:300])
        page.click("#tab-points")
        b28 = page.inner_text("#board")
        check("badges for a streak and a perfect night", "streaker" in b28 and "4-night streak" in b28.lower() and "perfect night" in b28.lower(), b28)
        page.reload(); wait_text(page, 'board', 'streaker', timeout=20000)
        check("the chosen board stays chosen", page.get_attribute("#tab-points", "aria-selected") == "true" and page.is_visible("#board"))
        page.keyboard.press("Tab")
        page.focus("#tab-points"); page.keyboard.press("ArrowLeft")
        check("arrow keys move between the boards", page.get_attribute("#tab-week", "aria-selected") == "true")
        ctx.close()

        # ---------- Phase I: the stream overlay ----------
        ctx = browser.new_context(viewport={"width": 1600, "height": 140}, locale="en-GB", timezone_id="Europe/Paris")
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.clock.install(time=dt.datetime.fromtimestamp(TG / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8000/overlay.html")
        wait_text(page, 'ov-lead', '0.025 ETH', timeout=30000)
        ov = page.inner_text("#ov")
        check("overlay shows tonight, the busiest window, the pot leader and the countdown", page.url.endswith("/?view=overlay") and "10.1 km" in ov and "22:00–1:00" in ov and
              "35 pts" in ov and "0.025 ETH" in ov and "Picks close in" in ov and "WINNING THE POT RIGHT NOW" in ov.upper(), ov)
        check("overlay is see-through and shows nothing else", page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgba(0, 0, 0, 0)" and
              not page.is_visible("#race") and not page.is_visible("header.top") and page.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]") == [1600, 140],
              str(page.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]")))
        page.screenshot(path=SCR + "/ui-overlay.png", omit_background=True)
        page.goto("http://127.0.0.1:8000/overlay.html?theme=light"); wait_text(page, 'ov-lead', 'ETH', timeout=30000)
        check("overlay takes ?theme=light", page.evaluate("document.documentElement.dataset.theme") == "light")
        ctx.close()

        # ---------- Phase B: night ends, bot pays out, page shows it ----------
        T = night_start(open_night) + DAY + 2 * 3600_000
        FIX["now"] = T
        FIX["special"] = {open_night: {"km": 9.6, "blocks": 1500}, add_days(open_night, -1): {"blocks": 1000}}
        rpc("evm_setNextBlockTimestamp", [T // 1000]); rpc("evm_mine")
        bot = subprocess.run(["node", PROJ + "/settler/settle.mjs"], capture_output=True, text=True, env={**os.environ,
            "DIARY_FILE": "/nonexistent/diary.json", "SETTLER_PRIVATE_KEY": BOT_KEY, "POT_ADDRESS": pot, "CONFIG_FILE": SCR + "/site5/config.js", "SEPOLIA_RPC_URL": "http://127.0.0.1:8545", "API_BASE": "http://127.0.0.1:8787", "NOW_MS": str(T)})
        check("bot pays out the night on both pots", bot.returncode == 0 and bot.stdout.count("paid out") == 2, bot.stdout + bot.stderr)
        print(bot.stdout)
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script(WALLET % (json.dumps(accts[2]), "true"))
        ctx.add_init_script("localStorage.setItem('squeekpicks.ens.v1', JSON.stringify({ %s: { name: 'alice.eth', at: Date.now() + 864e6 } }))" % json.dumps(accts[2].lower()))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.clock.install(time=dt.datetime.fromtimestamp((T + 300_000) / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8000/")
        wait_text(page, 'results-pot', 'Paid out', timeout=30000)
        rp = page.inner_text("#results-pot")
        check("results show the payout with amounts", "0.025" in rp and "0.015" in rp and "0.01" in rp, rp)
        check("player sees both winning tickets", "0.04" in rp and "paid to your wallet for 2 winning tickets" in rp, rp)
        check("results show 9.6 km", "9.6 km" in page.inner_text("#results"), page.inner_text("#results"))
        page.locator("#results-pot").screenshot(path=SCR + "/ui-results.png")
        wait_text(page, 'dash-body', 'Won', timeout=20000)
        dash = page.inner_text("#dash")
        net = page.inner_text("#dash .stats .stat:nth-child(4)")
        check("dashboard shows each ticket's win and the net", "+0.025" in dash and "+0.015" in dash and "#2" in dash and "+0.02 ETH" in net, dash + " | " + net)
        check("dashboard uses the ENS name", "alice.eth" in page.inner_text("#dash-who"), page.inner_text("#dash-who"))
        page.click("#tab-pot")
        bp = page.inner_text("#board-pot")
        check("pot board ranks winners by ETH won", page.is_visible("#board-pot") and not page.is_visible("#board") and "alice.eth" in bp and "0.04" in bp, bp)
        page.wait_for_timeout(1500)
        check("failed ENS avatar falls back to dots", page.locator("#board-pot img.av").count() == 0 and page.locator("#board-pot svg.av").count() >= 2)
        page.locator("#dash").screenshot(path=SCR + "/ui-dash.png")
        page.locator("#board-pot").screenshot(path=SCR + "/ui-board-pot.png")
        page.reload(); page.wait_for_selector("#board-pot:not([hidden])", timeout=20000)
        check("leaderboard tab is remembered", page.get_attribute("#tab-pot", "aria-selected") == "true")
        # Share last night
        wait_text(page, 'results-pot', 'Paid out', timeout=30000)
        page.click("#share-open")
        page.wait_for_function("document.getElementById('share-dl').href.startsWith('blob:')", timeout=10000)
        check("share window opens on the night card", page.evaluate("document.getElementById('share').open") and page.get_attribute("#stab-night", "aria-selected") == "true" and page.is_visible("#stab-mine"))
        xl = page.get_attribute("#share-x", "href")
        check("night post for X has the distance and the link", xl.startswith("https://x.com/intent/post?") and "ran%209.6%20km" in xl and "alice.eth%20won" in xl and "url=http%3A%2F%2F127.0.0.1%3A8000%2F" in xl, xl)
        drawn = page.evaluate("""(() => { const c = document.getElementById('share-canvas'), x = c.getContext('2d');
          const photo = x.getImageData(200, 300, 1, 1).data, text = x.getImageData(478, 100, 600, 100).data; let ink = 0;
          for (let i = 0; i < text.length; i += 4) if (text[i] > 200 && text[i + 1] > 200) ink++;
          return { photo: Array.from(photo), ink: ink, label: c.getAttribute('aria-label') }; })()""")
        check("night card is drawn: the receipt and the headline", drawn["ink"] > 500 and "9.6 km" in drawn["label"], str(drawn))
        with page.expect_download() as dl:
            page.click("#share-dl")
        f = dl.value
        size = os.path.getsize(f.path())
        check("download saves the card as a PNG", f.suggested_filename == "squeek-picks-%s.png" % open_night and size > 20000, f.suggested_filename + " " + str(size))
        page.click("#stab-mine")
        page.wait_for_function("document.getElementById('share-x').href.includes('won%200.04')", timeout=10000)
        xl = page.get_attribute("#share-x", "href")
        check("my result post says the place and the win", "I%20finished%20%231" in xl and "won%200.04%20test%20ETH" in xl, xl)
        check("my result card names the result", "Finished #1 and won 0.04 test ETH" in page.get_attribute("#share-canvas", "aria-label") and "alice.eth" in page.get_attribute("#share-canvas", "aria-label"), page.get_attribute("#share-canvas", "aria-label"))
        page.wait_for_function("document.getElementById('share-dl').download.includes('my-result')", timeout=10000)
        page.evaluate("""() => { navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = { n: d.files.length, type: d.files[0].type, name: d.files[0].name, size: d.files[0].size, text: d.text }; }; }""")
        page.click("#share-native")
        page.wait_for_function("!!window.__shared", timeout=5000)
        sh = page.evaluate("window.__shared")
        check("Share image hands the picture to the phone's apps", sh["n"] == 1 and sh["type"] == "image/png" and sh["name"].endswith("-my-result.png") and sh["size"] > 20000 and "Think you can call tonight better?" in sh["text"], str(sh))
        page.locator("#share").screenshot(path=SCR + "/ui-share.png")
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        check("Escape closes the share window", not page.evaluate("document.getElementById('share').open"))
        ctx.close()

        # ---------- Phase B2: an RPC that no longer keeps old events ----------
        # Public endpoints keep only hours of event history: the page works out what each
        # paid-out night paid with the payout rules instead.
        os.makedirs(SCR + "/site/data", exist_ok=True)
        open(SCR + "/site/data/stats.json", "w").write(json.dumps({"players": None, "calls": None, "potTickets": 7, "paidWei": str(4 * 10**16)}))
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script(WALLET % (json.dumps(accts[2]), "true"))
        page = ctx.new_page(); page.on("pageerror", lambda e: errors.append(str(e)))
        def pruned(r):
            body = r.request.post_data or ""
            if r.request.url.startswith("http://127.0.0.1:8545") and '"eth_getLogs"' in body:
                req = json.loads(body); ids = [x["id"] for x in req] if isinstance(req, list) else [req["id"]]
                err = [{"jsonrpc": "2.0", "id": i, "error": {"code": 4444, "message": "pruned history unavailable"}} for i in ids]
                return r.fulfill(status=200, content_type="application/json", body=json.dumps(err if isinstance(req, list) else err[0]))
            if "api.squeekchain.com" in r.request.url:
                return r.fulfill(status=200, content_type="application/json", body=json.dumps(api_body(r.request.url.split("api.squeekchain.com", 1)[1])))
            return r.continue_() if r.request.url.startswith("http://127.0.0.1") else r.abort()
        page.route("**/*", pruned)
        page.clock.install(time=dt.datetime.fromtimestamp((T + 300_000) / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8000/")
        wait_text(page, 'results-pot', 'Paid out', timeout=30000)
        rp = page.inner_text("#results-pot")
        check("without old events, payouts are worked out from the rules", "0.025" in rp and "0.015" in rp and "paid to your wallet for 2 winning tickets" in rp and "See the pot on Etherscan" in rp, rp)
        wait_text(page, 'dash-body', 'Won', timeout=20000)
        check("My tickets shows the worked-out wins", "+0.025" in page.inner_text("#dash-body") and "+0.015" in page.inner_text("#dash-body"), page.inner_text("#dash-body")[:400])
        page.click("#tab-pot")
        check("pot winners board fills in too", "0.04" in page.inner_text("#board-pot"), page.inner_text("#board-pot"))
        wait_text(page, 'proof', 'test ETH won', timeout=10000)
        tc = page.evaluate("document.getElementById('proof').textContent")
        check("all-time numbers under the header", "7pot tickets" in tc and "0.04test ETH won" in tc and page.is_visible("#proof"), tc)
        os.remove(SCR + "/site/data/stats.json")
        ctx.close()

        # ---------- Phase E: the old pot still shows after the switch ----------
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script(WALLET % (json.dumps(accts[2]), "true"))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.clock.install(time=dt.datetime.fromtimestamp((T + 300_000) / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8004/")
        wait_text(page, 'dash-body', '+0.0125', timeout=30000)
        dash = page.inner_text("#dash-body")
        check("My tickets includes the old pot's ticket and payout", "+0.025" in dash and "+0.015" in dash and "+0.0125" in dash and "Tickets\n3" in dash, dash[:600])
        bp = page.inner_text("#board-pot")
        check("pot board counts both pots", "0.0525" in bp, bp)
        ctx.close()

        # ---------- Phase F: a wallet with no Sepolia ETH ----------
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script(WALLET % (json.dumps("0x1111111111111111111111111111111111111111"), "true"))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.clock.install(time=dt.datetime.fromtimestamp((T + 300_000) / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8000/")
        wait_text(page, 'pot-me', 'not enough for a ticket', timeout=30000)
        check("empty wallet is warned before buying, with faucet links", "faucet" in page.inner_text("#pot-me") and page.locator("#pot-me .notice a").count() == 3, page.inner_text("#pot-me"))
        page.fill("#pick-distance", "9.1"); page.click("#pick-peak button[data-block='3']"); page.click("#pick-more button[data-more='true']")
        page.click("#pot-actions button[data-pot=buy]")
        wait_text(page, 'pot-msg', "doesn't have enough Sepolia test ETH", timeout=30000)
        calls = page.evaluate("window.__calls || []")
        check("buying with no ETH explains why and sends nothing", "eth_sendTransaction" not in calls and "faucet" in page.inner_text("#pot-msg"), page.inner_text("#pot-msg") + str(calls))
        ctx.close()

        # ---------- Phase C: owner settings and deploy ----------
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000})
        ctx.add_init_script(WALLET % (json.dumps(accts[2]), "true"))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8000/?admin")
        wait_text(page, 'admin-body', 'Owner', timeout=20000)
        ab = page.inner_text("#admin-body")
        check("admin shows the bot wallet and a non-owner warning", accts[1].lower() in ab.lower() and "isn't the owner" in ab, ab)
        before = len(page.evaluate("window.__calls || []"))
        page.fill("#adm-newprice", "0.05"); page.click("button[data-admin=price]")
        wait_text(page, 'admin-msg', 'refused', timeout=20000)
        after_calls = page.evaluate("window.__calls || []")[before:]
        check("non-owner gets a readable refusal before any wallet window", "only the wallet that deployed the pot" in page.inner_text("#admin-msg") and "eth_sendTransaction" not in after_calls, page.inner_text("#admin-msg") + " " + str(after_calls))
        page.goto("http://127.0.0.1:8005/?admin")
        wait_text(page, 'admin-body', 'Connect the owner wallet', timeout=20000)
        check("only the current owner gets the upgrade button", page.locator("button[data-admin=upgrade]").count() == 0 and "Upgrade to version 3" in page.inner_text("#admin-body"), page.inner_text("#admin-body")[:600])
        ctx.close()
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000})
        ctx.add_init_script(WALLET % (json.dumps(accts[0]), "true"))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8000/?admin")
        wait_text(page, 'admin-body', 'Owner', timeout=20000)
        page.fill("#adm-newprice", "0.02"); page.click("button[data-admin=price]")
        wait_text(page, 'admin-msg', 'Ticket price set', timeout=30000)
        check("owner changes the ticket price", True)
        check("admin shows the pot version", "3 (up to 5 tickets per wallet)" in page.inner_text("#admin-body") and "Upgrade to version" not in page.inner_text("#admin-body"), page.inner_text("#admin-body")[:500])
        page.goto("http://127.0.0.1:8003/?admin")
        page.wait_for_selector("button[data-admin=upgrade]", timeout=20000)
        page.click("button[data-admin=upgrade]")
        wait_text(page, 'admin-msg', 'Pot deployed', timeout=30000)
        new_addr = page.inner_text("#admin-body .notice .addr").strip()
        info = json.loads(helper("resolver", new_addr))
        check("upgrade from version 1 deploys version 3 with the same payout bot", info["version"] == 3 and info["resolver"].lower() == accts[1].lower(), str(info))
        page.goto("http://127.0.0.1:8005/?admin")
        page.wait_for_selector("button[data-admin=upgrade]", timeout=20000)
        ab = page.inner_text("#admin-body")
        check("a version 2 pot offers version 3, with the audit fixes and the same rules", "Upgrade to version 3" in ab and "IMD swarm audit" in ab and "rules stay the same" in ab and "2 (up to 5 tickets per wallet)" in ab, ab[:700])
        page.click("button[data-admin=upgrade]")
        wait_text(page, 'admin-msg', 'Pot deployed', timeout=30000)
        new_addr = page.inner_text("#admin-body .notice .addr").strip()
        info = json.loads(helper("resolver", new_addr))
        check("upgrade from version 2 deploys version 3 with the same payout bot", info["version"] == 3 and info["resolver"].lower() == accts[1].lower(), str(info))
        page.goto("http://127.0.0.1:8001/?admin")
        page.wait_for_selector("button[data-admin=deploy]", timeout=20000)
        page.click("button[data-admin=deploy]")
        try: wait_text(page, 'admin-msg', 'Pot deployed', timeout=30000)
        except Exception: print("ADMIN MSG:", page.inner_text("#admin-msg"), "| BODY:", page.inner_text("#admin-body")[:400], "| CALLS:", page.evaluate("window.__calls || []")[-6:]); raise
        check("owner deploys a new pot from the page", "0x" in page.inner_text("#admin-body"), page.inner_text("#admin-body")[:300])
        ctx.close()

        # ---------- Phase R: Rabby without Sepolia ----------
        RABBY = """
          window.__chain = "0x1"; window.__added = null;
          window.ethereum = { isRabby: true, isMetaMask: true, on() {}, removeListener() {},
            async request({ method, params }) {
              if (method === "eth_requestAccounts" || method === "eth_accounts") return [%s];
              if (method === "eth_chainId") return window.__chain;
              if (method === "wallet_switchEthereumChain") {
                if (!window.__added) { const e = new Error('Unrecognized chain ID "0xaa36a7". Try adding the chain using wallet_switchEthereumChain first.'); e.code = 4902; throw e; }
                window.__chain = params[0].chainId; return null;
              }
              if (method === "wallet_addEthereumChain") { window.__added = params[0]; window.__chain = params[0].chainId; return null; }
              const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
              const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result;
            } };""" % json.dumps(accts[6])
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000})
        ctx.add_init_script(RABBY)
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8000/")
        page.wait_for_selector("#rabby-sepolia", timeout=20000)
        note = page.inner_text("#rabby-sepolia")
        check("Rabby without Sepolia gets told how to add it", "Add Custom Network to Rabby" in note and "Press Add" in note and page.locator("button[data-pot=switch]").count() == 1, note)
        page.click("button[data-pot=switch]")
        page.wait_for_selector("button[data-pot=buy]", timeout=20000)
        added = page.evaluate("window.__added")
        check("switching adds Sepolia to Rabby with the page's RPC, then the hint goes", added and added["chainId"] == "0xaa36a7" and added["rpcUrls"] == ["http://127.0.0.1:8545"] and page.locator("#rabby-sepolia").count() == 0, str(added))
        ctx.close()

        # ---------- Phase D: the wallet picker (Reown AppKit) ----------
        KIT_WALLET = """(() => {
          const acct = %s; let connected = localStorage.getItem("__tw") === "1";
          const provider = { on() {}, removeListener() {},
            async request({ method, params }) {
              (window.__calls = window.__calls || []).push(method);
              if (method === "eth_requestAccounts") { connected = true; localStorage.setItem("__tw", "1"); return [acct]; }
              if (method === "wallet_requestPermissions") { connected = true; localStorage.setItem("__tw", "1"); return [{ parentCapability: "eth_accounts" }]; }
              if (method === "eth_accounts") return connected ? [acct] : [];
              if (method === "wallet_getPermissions") return connected ? [{ parentCapability: "eth_accounts" }] : [];
              if (method === "wallet_revokePermissions") { connected = false; localStorage.removeItem("__tw"); return null; }
              if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
              if (method === "eth_sendTransaction") params = params.map((p) => Object.assign({}, p, { from: acct }));
              const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
              const j = await r.json();
              if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
              return j.result;
            } };
          const info = { uuid: "1f0c4a52-0000-4000-8000-000000000001", name: "Test Wallet", icon: "data:image/svg+xml,%%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%%3E%%3Crect width='32' height='32' fill='%%23e9b44c'/%%3E%%3C/svg%%3E", rdns: "io.test.wallet" };
          const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
          window.addEventListener("eip6963:requestProvider", announce);
          announce();
        })();"""
        ctx = browser.new_context(viewport={"width": 1200, "height": 1000}, locale="en-GB", timezone_id="Europe/Paris")
        ctx.add_init_script(KIT_WALLET % json.dumps(accts[2]))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        loaded = []; page.on("request", lambda r: loaded.append(r.url))
        page.clock.install(time=dt.datetime.fromtimestamp((T + 600_000) / 1000, dt.timezone.utc))
        page.goto("http://127.0.0.1:8002/")
        page.wait_for_selector("#me button[data-wallet=connect]", timeout=20000)
        page.wait_for_timeout(1000)
        check("picker isn't loaded for a first visit", not any(u.endswith("/wallet.js") for u in loaded))
        page.click("#me button[data-wallet=connect]")
        CLICK = """() => {
          const walk = (root, out) => { root.querySelectorAll('*').forEach(el => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; };
          const els = walk(document, []);
          const t = els.find(el => /WUI-LIST-WALLET|W3M-LIST-WALLET|WUI-LIST-ITEM/.test(el.tagName) && (el.getAttribute('name') === 'Test Wallet' || (el.textContent || '').includes('Test Wallet')));
          if (t) { t.click(); return true; } return false; }"""
        found = False
        for _ in range(40):
            if page.evaluate(CLICK): found = True; break
            page.wait_for_timeout(250)
        check("picker lists the browser wallet", found)
        wait_text(page, 'dash-body', 'Won', timeout=30000)
        check("connects through the picker and shows the dashboard", "Test Wallet" in page.inner_text("#dash-who"), page.inner_text("#dash-who"))
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        page.fill("#pick-distance", "7.7"); page.click("#pick-peak button[data-block='2']"); page.click("#pick-more button[data-more='false']")
        page.click("#pot-actions button[data-pot=buy]")
        wait_text(page, 'pot-msg', 'Ticket bought', timeout=30000)
        check("buys a ticket through the picker's wallet", "7.7 km" in page.inner_text("#dash"), page.inner_text("#dash"))
        page.reload()
        try:
            wait_text(page, 'dash-body', 'Won', timeout=30000); back = True
        except Exception: back = False
        check("reconnects on the next visit", back, page.inner_text("#dash")[:300])
        page.locator("#dash").screenshot(path=SCR + "/ui-dash-kit.png")
        ctx.close()
        check("libraries load from the site, not a CDN", not CDN, str(CDN[:3]))
        check("no page errors", not errors, "; ".join(errors))
        browser.close()
except Exception as e:
    import traceback; check("no unexpected error", False, traceback.format_exc())
finally:
    os.killpg(node.pid, 9)
finish()
