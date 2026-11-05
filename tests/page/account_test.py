"""The page in its real "remote" mode against a fake Supabase: a newcomer plays without signing
up, adds an email with a code, signs in on another browser, signs out there; an email can't
belong to two nicknames, and nobody gets locked out of linking a wallet."""
import json, subprocess, time, threading, functools, http.server, os, shutil, signal
from common import *
import fake_supabase as fake_sb
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
node = start_chain()
errors = []
def check(name, ok, detail=""): results.append((name, bool(ok), detail))
OUT = SCR + "/acct"; os.makedirs(OUT, exist_ok=True)
try:
    for _ in range(60):
        try: rpc("eth_chainId"); break
        except Exception: time.sleep(0.5)
    accts = rpc("eth_accounts")
    pot = subprocess.run(["node", "lib/chain.mjs", "deploy"], cwd=CHAIN, check=True, capture_output=True, text=True).stdout.strip()
    cards = subprocess.run(["node", "lib/mintcards.mjs", "http://127.0.0.1:8545", accts[3]], cwd=CHAIN, check=True, capture_output=True, text=True).stdout.strip()
    fake, _srv = fake_sb.start(8790)
    SITE = SCR + "/site_acct"; os.makedirs(SITE, exist_ok=True)
    for f in ("index.html", "wallet.js", "icon.svg", "squeektoshi.jpg"): shutil.copy(PROJ + "/" + f, SITE + "/" + f)
    for d in ("vendor", "fonts", "data"): shutil.copytree(PROJ + "/" + d, SITE + "/" + d, dirs_exist_ok=True)
    now = int(time.time() * 1000); live = live_night(now)
    open(SITE + "/config.js", "w").write("window.SQUEEK_CONFIG = " + json.dumps({
        "SUPABASE_URL": "http://127.0.0.1:8790", "SUPABASE_ANON_KEY": "test-anon-key", "EMAIL_LOGIN": True, "TELEGRAM_URL": "https://t.me/squeekpicks",
        "POT_ADDRESS": pot, "RPC_URL": "http://127.0.0.1:8545", "CARDS_ADDRESS": cards,
        "SEASONS": [{"name": "Season 1", "start": add_days(live, -3), "nights": 14}]}) + ";\n")
    s = http.server.ThreadingHTTPServer(("127.0.0.1", 8021), functools.partial(Q, directory=SITE)); threading.Thread(target=s.serve_forever, daemon=True).start()
    URL = "http://127.0.0.1:8021/"
    route = lambda page: page.route("**/*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(api_body(r.request.url.split("api.squeekchain.com", 1)[1]))) if "api.squeekchain.com" in r.request.url else r.continue_() if r.request.url.startswith("http://127.0.0.1") else r.abort())
    WALLET = """
      window.__acct = %s; window.__connected = true;
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {},
        async request({ method, params }) {
          (window.__calls = window.__calls || []).push(method);
          if (method === "eth_requestAccounts") { window.__connected = true; return [window.__acct]; }
          if (method === "eth_accounts") return window.__connected ? [window.__acct] : [];
          const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
          const j = await r.json();
          if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
          return j.result;
        } };""" % json.dumps(accts[3])
    def newpage(ctx):
        page = ctx.new_page(); route(page)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL); page.wait_for_timeout(3500)
        return page
    def play(page, nick, km="9.6"):
        page.fill("#pick-distance", km); page.click("#pick-peak button[data-block='3']"); page.click("#pick-more button[data-more='true']")
        page.fill("#nick", nick); page.click("#save"); page.wait_for_timeout(1200)
    def code_for(email): return fake.last_code(email)
    FITS = "(() => { const t = document.querySelector('.top'); return t.scrollWidth <= t.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })()"

    with sync_playwright() as p:
        b = p.chromium.launch()
        # ----- A newcomer on a phone plays without signing up, then adds an email -----
        ctxA = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="en-GB", timezone_id="Europe/Paris", has_touch=True, is_mobile=True)
        ctxA.add_init_script(WALLET)
        A = newpage(ctxA)
        check("a newcomer can sign in from the nickname step", A.locator("#nick-row").is_visible() and A.locator("#signin-line").is_visible() and "Sign in with your email" in A.inner_text("#signin-line"))
        check("no account line and no Telegram line before playing", A.locator("#acct-note").is_hidden() and A.locator("#tg-note").is_hidden())
        check("the phone header has Sign in and the wallet, and fits", A.locator("#me .signin-btn").is_visible() and A.locator("#me .wallet-btn").is_visible() and A.evaluate(FITS),
              A.inner_text(".top") + " | " + A.evaluate("document.querySelector('.top').className"))
        A.screenshot(path=OUT + "/0-header-newcomer.png", clip={"x": 0, "y": 0, "width": 390, "height": 70})
        play(A, "tester_1")
        check("saving joins without an email (anonymous player)", "Welcome, tester_1" in A.inner_text("#save-msg") and len(fake.tables["players"]) == 1 and len(fake.tables["picks"]) == 1 and
              list(fake.users.values())[0]["is_anonymous"], A.inner_text("#save-msg"))
        note = A.inner_text("#acct-note")
        check("after playing, the phone header shows the nickname (no email yet) next to the wallet", A.locator("#me .who-me.anon").is_visible() and "tester_1" in A.inner_text("#me .who-me") and
              A.locator("#me .signin-btn").count() == 0 and A.locator("#me .wallet-btn").is_visible() and A.evaluate(FITS), A.inner_text(".top"))
        check("then it offers to keep the nickname with an email", A.locator("#acct-note").is_visible() and "only in this browser" in note and "Add your email" in note, note)
        check("and points to the Telegram channel", A.locator("#tg-note").is_visible() and A.get_attribute("#tg-note-link", "href") == "https://t.me/squeekpicks")
        A.locator("#save").scroll_into_view_if_needed(); A.wait_for_timeout(200)
        A.screenshot(path=OUT + "/1-after-save.png")
        A.click("#acct-note button[data-acct=save]"); A.wait_for_timeout(300)
        check("Add your email opens the account window", A.locator("#acct").is_visible() and A.inner_text("#acct-h") == "Add your email" and "tester_1" in A.inner_text("#acct-body") and
              A.evaluate("document.activeElement.id") == "acct-email", A.inner_text("#acct-body"))
        A.screenshot(path=OUT + "/2-add-email.png")
        A.fill("#acct-email", "not-an-email"); A.click("#acct-form button[type=submit]"); A.wait_for_timeout(200)
        check("a wrong address is explained", "like you@example.com" in A.inner_text("#acct-msg"), A.inner_text("#acct-msg"))
        A.fill("#acct-email", "Tester@Example.com"); A.click("#acct-form button[type=submit]"); A.wait_for_timeout(1200)
        check("a code goes to the address, in lower case", code_for("tester@example.com") is not None and fake.mail[-1][2] == "email_change" and
              "We sent a code to tester@example.com" in A.inner_text("#acct-body") and A.evaluate("document.activeElement.id") == "acct-code", A.inner_text("#acct-body") + " " + A.inner_text("#acct-msg"))
        A.screenshot(path=OUT + "/3-code.png")
        A.click("#acct-body button[data-acct=resend]"); A.wait_for_timeout(300)
        check("a new code waits a minute", "new code in" in A.inner_text("#acct-msg"), A.inner_text("#acct-msg"))
        A.fill("#acct-code", "000000"); A.click("#acct-form button[type=submit]"); A.wait_for_timeout(800)
        check("a wrong code is explained", "didn't work" in A.inner_text("#acct-msg"), A.inner_text("#acct-msg"))
        A.fill("#acct-code", code_for("tester@example.com")); A.click("#acct-form button[type=submit]"); A.wait_for_timeout(1200)
        check("the right code adds the email", A.inner_text("#acct-h") == "Email added" and "tester@example.com" in A.inner_text("#acct-body") and
              not list(fake.users.values())[0]["is_anonymous"], A.inner_text("#acct-body") + " " + A.inner_text("#acct-msg"))
        A.screenshot(path=OUT + "/4-done.png")
        A.click("#acct-body button[data-acct=close]"); A.wait_for_timeout(300)
        check("and the ticket says who's signed in", A.locator("#acct").is_hidden() and "Signed in as tester@example.com" in A.inner_text("#acct-note"), A.inner_text("#acct-note"))
        check("the header nickname loses the 'no email' mark", A.locator("#me .who-me").is_visible() and A.locator("#me .who-me.anon").count() == 0)
        A.evaluate("window.scrollTo(0, 0)"); A.wait_for_timeout(200)
        A.screenshot(path=OUT + "/0-header-signed-in.png", clip={"x": 0, "y": 0, "width": 390, "height": 70})
        A.click("#me .who-me"); A.wait_for_timeout(300)
        check("on a phone the header nickname opens the account too", A.inner_text("#acct-h") == "Your account" and "tester@example.com" in A.inner_text("#acct-body"))
        A.click("#acct .sd-head button[data-acct=close]"); A.wait_for_timeout(200)
        # Night Cards: link this wallet.
        A.click("#cards button[data-cards=link]")
        try: A.wait_for_function("document.getElementById('cards-body').innerText.includes('Your cards go to')", timeout=20000)
        except Exception: pass
        check("tester_1 links a wallet for Night Cards", len(fake.tables["wallet_links"]) == 1 and fake.tables["wallet_links"][0]["wallet"].lower() == accts[3].lower(), A.inner_text("#cards-msg") + " " + A.inner_text("#cards-body"))

        # ----- The same player on a laptop: sign in with the email -----
        ctxB = b.new_context(viewport={"width": 1280, "height": 900}, locale="en-GB", timezone_id="Europe/Paris")
        B = newpage(ctxB)
        check("the laptop header has Sign in", B.locator("#me .signin-btn").is_visible())
        B.click("#me .signin-btn"); B.wait_for_timeout(300)
        check("Sign in asks for the email", B.inner_text("#acct-h") == "Sign in" and B.locator("#acct-email").is_visible())
        B.fill("#acct-email", "nobody@example.com"); B.click("#acct-form button[type=submit]"); B.wait_for_timeout(800)
        check("an email nobody added says so", "No nickname uses this email yet" in B.inner_text("#acct-msg"), B.inner_text("#acct-msg"))
        B.fill("#acct-email", "tester@example.com"); B.click("#acct-form button[type=submit]"); B.wait_for_timeout(1000)
        check("a sign-in code goes out", fake.mail[-1][0] == "tester@example.com" and fake.mail[-1][2] == "email", str(fake.mail[-1]))
        B.screenshot(path=OUT + "/5-signin-code-desktop.png")
        B.fill("#acct-code", code_for("tester@example.com")); B.click("#acct-form button[type=submit]"); B.wait_for_timeout(2000)
        check("signed in on the laptop: same nickname, same saved picks", B.locator("#acct").is_hidden() and "tester_1's picks" in B.inner_text("#ticket-who").lower() and
              B.input_value("#pick-distance") == "9.6" and B.locator("#saved-stamp").is_visible() and "You play as tester_1" in B.inner_text("#save-msg"),
              B.inner_text("#ticket-who") + " | " + B.input_value("#pick-distance") + " | " + B.inner_text("#save-msg"))
        check("the header name opens the account", B.locator("#me button.who-me[data-acct=open]").is_visible())
        B.click("#me button.who-me"); B.wait_for_timeout(300)
        check("the account shows the email and a sign-out", B.inner_text("#acct-h") == "Your account" and "tester@example.com" in B.inner_text("#acct-body") and
              B.locator("#acct-body button[data-acct=signout]").is_visible())
        B.screenshot(path=OUT + "/6-account-desktop.png")
        B.click("#acct-body button[data-acct=signout]"); B.wait_for_timeout(1000)
        check("signing out leaves this browser only", fake.logouts == ["local"] and B.locator("#nick-row").is_visible() and B.inner_text("#ticket-who").lower() == "your picks" and
              B.input_value("#pick-distance") == "", str(fake.logouts) + " " + B.inner_text("#ticket-who"))
        B.reload(); B.wait_for_timeout(3000)
        check("and stays signed out after a reload", B.locator("#nick-row").is_visible() and B.locator("#signin-line").is_visible())
        A.reload(); A.wait_for_timeout(3500)
        check("the phone is still signed in", "tester_1's picks" in A.inner_text("#ticket-who").lower() and "Signed in as tester@example.com" in A.inner_text("#acct-note"), A.inner_text("#ticket-who"))

        # ----- Someone else can't take that email, and can switch to it by signing in -----
        ctxC = b.new_context(viewport={"width": 390, "height": 844}, locale="en-GB", timezone_id="Europe/Paris")
        C = newpage(ctxC)
        play(C, "other_1", "8.2")
        C.click("#acct-note button[data-acct=save]"); C.wait_for_timeout(300)
        C.fill("#acct-email", "tester@example.com"); C.click("#acct-form button[type=submit]"); C.wait_for_timeout(1000)
        check("an email can't belong to two nicknames", "already belongs to another nickname" in C.inner_text("#acct-msg"), C.inner_text("#acct-msg"))
        C.click("#acct-body button[data-acct=signin]"); C.wait_for_timeout(300)
        check("signing in from a browser with another nickname warns first", C.inner_text("#acct-h") == "Sign in" and "other_1" in C.inner_text("#acct-body") and "stays behind" in C.inner_text("#acct-body"), C.inner_text("#acct-body"))
        C.screenshot(path=OUT + "/7-switch-warning.png")
        C.fill("#acct-email", "tester@example.com"); C.click("#acct-form button[type=submit]"); C.wait_for_timeout(1000)
        C.fill("#acct-code", code_for("tester@example.com")); C.click("#acct-form button[type=submit]"); C.wait_for_timeout(2000)
        check("then it switches to the email's nickname", "tester_1's picks" in C.inner_text("#ticket-who").lower() and C.input_value("#pick-distance") == "9.6", C.inner_text("#ticket-who"))

        # ----- The smallest phone, a long nickname and a wallet: the header still fits -----
        ctxS = b.new_context(viewport={"width": 320, "height": 700}, device_scale_factor=2, locale="en-GB", timezone_id="Europe/Paris", is_mobile=True, has_touch=True)
        ctxS.add_init_script(WALLET)
        S = newpage(ctxS)
        check("at 320 px a newcomer still gets Sign in and the wallet", S.locator("#me .signin-btn").is_visible() and S.locator("#me .wallet-btn").is_visible() and S.evaluate(FITS), S.inner_text(".top"))
        play(S, "wheel_watcher_2026x", "9.1")
        check("and after playing: the nickname and the wallet, nothing pushed off screen", S.locator("#me .who-me").is_visible() and S.locator("#me .wallet-btn").is_visible() and S.evaluate(FITS),
              S.inner_text(".top") + " | " + S.evaluate("document.querySelector('.top').className"))
        S.evaluate("window.scrollTo(0, 0)"); S.wait_for_timeout(200)
        S.screenshot(path=OUT + "/0-header-320.png", clip={"x": 0, "y": 0, "width": 320, "height": 70})
        ctxS.close()

        # ----- A wallet gets one nickname's cards -----
        ctxE = b.new_context(viewport={"width": 1280, "height": 900}, locale="en-GB", timezone_id="Europe/Paris")
        ctxE.add_init_script(WALLET)
        E = newpage(ctxE)
        play(E, "third_1", "7.7")
        E.click("#cards button[data-cards=link]")
        try: E.wait_for_function("document.getElementById('cards-body').innerText.includes('Your cards go to')", timeout=20000)
        except Exception: pass
        check("a wallet another nickname linked first can still be linked: nobody gets locked out (the minting bot gives its cards to the first)",
              len(fake.tables["wallet_links"]) == 2 and "Your cards go to" in E.inner_text("#cards-body"), E.inner_text("#cards-msg") + " | " + E.inner_text("#cards-body"))
        b.close()
finally:
    os.killpg(node.pid, signal.SIGKILL)
finish(errors)
