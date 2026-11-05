"""A newcomer on a phone: how to play comes first, picks save without a wallet, the ticket gets
stamped, and the page reads well at phone sizes."""
import json, subprocess, time, threading, functools, http.server, os, signal
from common import *
node = start_chain()
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
errors = []
try:
    for _ in range(60):
        try: rpc("eth_chainId"); break
        except Exception: time.sleep(0.5)
    pot = subprocess.run(["node", "lib/chain.mjs", "deploy"], cwd=CHAIN, check=True, capture_output=True, text=True).stdout.strip()
    SITE = make_site("site_phone", {"POT_ADDRESS": pot, "RPC_URL": "http://127.0.0.1:8545"})
    s = http.server.ThreadingHTTPServer(("127.0.0.1", 8000), functools.partial(Q, directory=SITE)); threading.Thread(target=s.serve_forever, daemon=True).start()
    route = lambda page: page.route("**/*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(api_body(r.request.url.split("api.squeekchain.com", 1)[1]))) if "api.squeekchain.com" in r.request.url else r.continue_() if r.request.url.startswith("http://127.0.0.1") else r.abort())
    with sync_playwright() as p:
        b = p.chromium.launch()
        # ----- a newcomer on a phone -----
        ctx = b.new_context(viewport={"width": 390, "height": 844}, locale="en-GB", timezone_id="Europe/Paris", has_touch=True, is_mobile=True)
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8000/"); page.wait_for_timeout(4000)
        page.screenshot(path=SCR + "/after-phone-new-top.png")
        howto = page.locator("#howto")
        check("how to play is the first thing on the page, in three short lines", howto.is_visible() and howto.bounding_box()["y"] < 300 and page.locator("#howto li").count() == 3 and
              len(page.inner_text("#howto")) < 330, str(howto.bounding_box()) + " " + str(len(page.inner_text("#howto"))))
        check("then the wheel and the till's display, then your picks", howto.bounding_box()["y"] < page.locator("#wheel").bounding_box()["y"] < page.locator(".vfd").bounding_box()["y"] < page.locator("#ticket").bounding_box()["y"] and
              page.locator("#m-dist").is_visible() and page.locator("#wheel .spin").count() == 1, str(page.locator("#wheel").bounding_box()))
        state = page.get_attribute("#m-status", "data-state")
        cls = page.get_attribute("#wheel", "class")
        rev = page.evaluate("document.getElementById('wheel').style.getPropertyValue('--rev')")
        check("the drawn wheel turns at his real speed while he runs, and stops when he doesn't", ("running" in cls and rev.endswith("s") and 0.3 <= float(rev[:-1]) <= 6) if state == "running" else ("still" in cls), state + " | " + cls + " | " + rev)
        check("one piece of paper on the page, your picks; no receipt headers or barcodes", page.locator("#game .paper:visible").count() == 1 and page.locator("#ticket.paper").is_visible() and
              page.locator(".rc-head, .barcode, hr.cut, .legend").count() == 0, page.locator("#game .paper:visible").count())
        check("the wheel shows tonight only, with four times around it", page.locator("#wheel .lbl").count() == 4 and "per half hour" in page.inner_text("#live-night"), page.inner_text("#live-night"))
        check("the whole page is short on a phone", page.evaluate("document.documentElement.scrollHeight") < 4600, page.evaluate("document.documentElement.scrollHeight"))
        check("no big Play button in the header; Connect wallet isn't loud", page.locator("#me a.play-btn").count() == 0 and
              page.evaluate("getComputedStyle(document.querySelector('#me button.wallet-btn.connect')).backgroundColor") in ("rgba(0, 0, 0, 0)", "transparent"))
        check("no player line and no My tickets for a first visit", page.locator("#you-line").is_hidden() and page.locator("#dash").is_hidden())
        c1 = page.inner_text("#clock"); page.wait_for_timeout(1300); c2 = page.inner_text("#clock")
        check("the closing countdown ticks", c1 != c2 and len(c2) == 8, c1 + " / " + c2)
        check("phone bar counts down to the picks closing", page.locator("#pickbar").is_visible() and "picks close in" in page.inner_text("#pickbar").lower() and page.inner_text("#pb-go").upper() == "PICK NOW", page.inner_text("#pickbar"))
        page.click("#pb-go"); page.wait_for_timeout(1500)
        check("Pick now goes to the ticket and focuses the distance", page.evaluate("document.activeElement && document.activeElement.id") == "pick-distance" and page.locator("#ticket").bounding_box()["y"] < 200, str(page.locator("#ticket").bounding_box()))
        check("phone bar steps aside while the ticket is on screen", page.locator("#pickbar").is_hidden())
        check("no nickname step before picking", page.locator("#nick-row").is_visible() and page.inner_text("#save").upper() == "SAVE MY PICKS" and not page.is_disabled("#save"))
        page.click("#save"); page.wait_for_timeout(300)
        check("pressing Save with nothing filled in says what's missing", "distance" in page.inner_text("#save-msg"), page.inner_text("#save-msg"))
        page.click("#quick-pick"); page.wait_for_timeout(300)
        d = page.evaluate("({ km: document.getElementById('pick-distance').value, peak: [...document.querySelectorAll('#pick-peak [aria-pressed=true]')].map(b => b.dataset.block), more: [...document.querySelectorAll('#pick-more [aria-pressed=true]')].map(b => b.dataset.more), msg: document.getElementById('save-msg').textContent })")
        check("Quick pick fills his usual night", d["km"] != "" and len(d["peak"]) == 1 and "Filled in his usual" in d["msg"], str(d))
        if not d["more"]: page.click("#pick-more button[data-more='false']")
        page.locator("#save").scroll_into_view_if_needed(); page.screenshot(path=SCR + "/after-phone-save.png")
        page.click("#save"); page.wait_for_timeout(300)
        check("saving without a nickname asks for one", "Add a nickname" in page.inner_text("#save-msg") and page.evaluate("document.activeElement.id") == "nick", page.inner_text("#save-msg"))
        page.fill("#nick", "x"); page.click("#save"); page.wait_for_timeout(200)
        check("a bad name is explained", "2 to 20 letters" in page.inner_text("#save-msg"), page.inner_text("#save-msg"))
        page.fill("#nick", "tester_1"); page.click("#save"); page.wait_for_timeout(800)
        st = json.loads(page.evaluate("localStorage.getItem('squeekpicks.local.v1')") or "{}")
        check("one press joins and saves", "Welcome, tester_1" in page.inner_text("#save-msg") and st.get("nickname") == "tester_1" and len(st.get("picks", {})) == 1, page.inner_text("#save-msg") + " " + json.dumps(st))
        check("then the picks are stamped SAVED and named", page.locator("#nick-row").is_hidden() and page.inner_text("#save").upper() == "PICKS SAVED" and page.locator("#saved-stamp").is_visible() and
              "SAVED" in page.inner_text("#saved-stamp") and "tester_1's picks" in page.inner_text("#ticket-who").lower(), page.inner_text("#saved-stamp") + " | " + page.inner_text("#ticket-who"))
        page.locator("#ticket").screenshot(path=SCR + "/after-phone-stamped.png")
        page.fill("#pick-distance", "9.9"); page.wait_for_timeout(200)
        check("changing saved picks lifts the stamp until they're saved again", page.locator("#saved-stamp").is_hidden() and page.inner_text("#save").upper() == "UPDATE MY PICKS")
        page.click("#save"); page.wait_for_timeout(800)
        check("saving again stamps it again", page.locator("#saved-stamp").is_visible())
        page.evaluate("window.scrollTo(0, 0)"); page.wait_for_timeout(800)
        check("phone bar says the picks are saved", "picks saved" in page.inner_text("#pickbar").lower() and page.inner_text("#pb-go").upper() == "CHANGE", page.inner_text("#pickbar"))
        page.click("#howto a.more-rules"); page.wait_for_timeout(600)
        check("How points work opens the small print and goes there", page.evaluate("location.hash") == "#small-print" and page.evaluate("document.getElementById('small-print').open") and
              page.evaluate("window.scrollY") > 1000, page.evaluate("window.scrollY"))
        ctx.close()
        # ----- a returning player, for the screenshots -----
        now = int(time.time() * 1000); live = live_night(now)
        seed = {"nickname": "wheel_watcher", "picks": {add_days(live, -k): {"distance_km": 9.5 + k / 10, "peak_block": 3, "more_blocks": False} for k in range(1, 5)}}
        for name, vw, vh in (("after-phone-back", 390, 844), ("after-desktop-back", 1280, 900), ("after-desktop-new", 1280, 900)):
            ctx = b.new_context(viewport={"width": vw, "height": vh}, locale="en-GB", timezone_id="Europe/Paris")
            if "back" in name: ctx.add_init_script("localStorage.setItem('squeekpicks.local.v1', %s)" % json.dumps(json.dumps(seed)))
            page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto("http://127.0.0.1:8000/"); page.wait_for_timeout(4000)
            page.screenshot(path=SCR + "/" + name + "-top.png")
            if name == "after-phone-back":
                check("a returning player's ticket shows their name and place", "wheel_watcher's picks" in page.inner_text("#ticket-who").lower() and page.locator("#you-line").is_visible() and "pts" in page.inner_text("#you-line"), page.inner_text("#you-line"))
                check("last night shows their points", "pts" in page.inner_text("#results .yours").lower(), page.inner_text("#results"))
                page.screenshot(path=SCR + "/" + name + "-full.png", full_page=True)
            if name == "after-desktop-new":
                check("on a wide screen the wheel stays in view beside the ticket", page.locator(".counter").evaluate("e => getComputedStyle(e).position") == "sticky" and
                      page.locator("#ticket").bounding_box()["x"] > page.locator("#wheel").bounding_box()["x"] + 300)
            ctx.close()
        # ----- a short laptop window: how to play shows without scrolling, and nothing hides below a stuck column -----
        ctx = b.new_context(viewport={"width": 1280, "height": 600}, locale="en-GB", timezone_id="Europe/Paris")
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8000/"); page.wait_for_timeout(3000)
        hb = page.locator("#howto").bounding_box()
        check("on a short laptop screen how to play is on the first screen, and the wheel column scrolls normally", hb["y"] + hb["height"] < 600 and
              page.locator(".counter").evaluate("e => getComputedStyle(e).position") == "static", str(hb))
        ctx.close()
        b.close()
finally:
    os.killpg(node.pid, signal.SIGKILL)
finish(errors)
