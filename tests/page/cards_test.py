"""Night Cards on the page: a wallet's cards, their pictures, and the cards contract it shows."""
import json, subprocess, time, threading, functools, http.server, os, shutil, signal
from common import *
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
node = start_chain()
errors = []
try:
    for _ in range(60):
        try: rpc("eth_chainId"); break
        except Exception: time.sleep(0.5)
    accts = rpc("eth_accounts")
    pot = subprocess.run(["node", "lib/chain.mjs", "deploy"], cwd=CHAIN, check=True, capture_output=True, text=True).stdout.strip()
    cards = subprocess.run(["node", "lib/mintcards.mjs", "http://127.0.0.1:8545", accts[3]], cwd=CHAIN, check=True, capture_output=True, text=True).stdout.strip()
    SITE = SCR + "/site_cards"; os.makedirs(SITE, exist_ok=True)
    for f in ("index.html", "wallet.js", "icon.svg", "squeektoshi.jpg", "diary.html", "overlay.html"): shutil.copy(PROJ + "/" + f, SITE + "/" + f)
    shutil.copytree(PROJ + "/vendor", SITE + "/vendor", dirs_exist_ok=True)
    shutil.copytree(PROJ + "/fonts", SITE + "/fonts", dirs_exist_ok=True)
    now = int(time.time() * 1000); live = live_night(now)
    def config(extra): open(SITE + "/config.js", "w").write("window.SQUEEK_CONFIG = " + json.dumps(dict({"POT_ADDRESS": pot, "RPC_URL": "http://127.0.0.1:8545", "SEASONS": [{"name": "Season 1", "start": add_days(live, -3), "nights": 14}]}, **extra)) + ";\n")
    s = http.server.ThreadingHTTPServer(("127.0.0.1", 8011), functools.partial(Q, directory=SITE)); threading.Thread(target=s.serve_forever, daemon=True).start()
    route = lambda page: page.route("**/*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(api_body(r.request.url.split("api.squeekchain.com", 1)[1]))) if "api.squeekchain.com" in r.request.url else r.continue_() if r.request.url.startswith("http://127.0.0.1") else r.abort())
    WALLET = """
      window.__acct = %s; window.__connected = %s;
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {},
        async request({ method, params }) {
          (window.__calls = window.__calls || []).push(method);
          if (method === "eth_requestAccounts") { window.__connected = true; return [window.__acct]; }
          if (method === "eth_accounts") return window.__connected ? [window.__acct] : [];
          if (method === "eth_sendTransaction") params = params.map((p) => Object.assign({}, p, { from: window.__acct }));
          const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
          const j = await r.json();
          if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
          return j.result;
        } };"""
    with sync_playwright() as p:
        b = p.chromium.launch()
        config({"CARDS_ADDRESS": cards})
        ctx = b.new_context(viewport={"width": 1200, "height": 1000})
        ctx.add_init_script(WALLET % (json.dumps(accts[3]), "true"))
        ctx.add_init_script("localStorage.setItem('squeekpicks.local.v1', JSON.stringify({nickname: 'wheel_watcher', picks: {}}))")
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8011/"); page.wait_for_timeout(3500)
        body = page.inner_text("#cards-body")
        check("Night Cards ask to link a wallet first", page.locator("#cards").is_visible() and "Link a wallet" in body and "no fee" in body, body)
        page.click("#cards button[data-cards=link]")
        try: page.wait_for_selector("#cards .cards-grid img", timeout=20000)
        except Exception: pass
        st = json.loads(page.evaluate("localStorage.getItem('squeekpicks.local.v1')"))
        link = st.get("wallet") or {}
        check("linking signs a message and keeps it", link.get("wallet", "").lower() == accts[3].lower() and link.get("message") == "Squeek Picks: send my Night Cards to %s. Player me." % accts[3].lower() and len(link.get("signature", "")) == 132 and "personal_sign" in page.evaluate("window.__calls"), json.dumps(link) + page.inner_text("#cards-msg"))
        imgs = page.locator("#cards .cards-grid img")
        caps = page.inner_text("#cards .cards-grid")
        check("the wallet's cards load from the contract with their art", imgs.count() == 2 and "2026-10-27: Perfect night" in caps and "2026-10-29: Bullseye" in caps and page.get_attribute("#cards .cards-grid img >> nth=0", "src").startswith("data:image/svg+xml;base64,"), caps)
        check("the art actually draws", page.evaluate("(() => { const i = document.querySelector('#cards .cards-grid img'); return i.complete && i.naturalWidth > 0; })()"))
        page.locator("#cards").screenshot(path=SCR + "/cards-panel.png")
        ctx.close()
        # No nickname yet: play first.
        ctx = b.new_context(viewport={"width": 390, "height": 900})
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8011/"); page.wait_for_timeout(3000)
        check("without a nickname the panel says to play first", "Save your picks with a nickname" in page.inner_text("#cards-body"), page.inner_text("#cards-body"))
        ctx.close()
        # The owner deploys the cards from the admin page.
        config({})
        ctx = b.new_context(viewport={"width": 1200, "height": 1000})
        ctx.add_init_script(WALLET % (json.dumps(accts[0]), "true"))
        page = ctx.new_page(); route(page); page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:8011/?admin")
        page.wait_for_selector("button[data-admin=cards]", timeout=20000)
        check("no cards panel until the contract is set", page.locator("#cards").is_hidden())
        page.click("button[data-admin=cards]")
        wait_text(page, "admin-msg", "Night Cards deployed", timeout=30000)
        ab = page.inner_text("#admin-body")
        check("the owner deploys Night Cards with the payout bot as minter", "Night Cards deployed at 0x" in ab and "CARDS_ADDRESS" in ab, ab[-400:])
        addr = ab.split("Night Cards deployed at ")[1].split()[0]
        minter = subprocess.run(["node", "-e", "const {ethers}=require('ethers');const p=new ethers.JsonRpcProvider('http://127.0.0.1:8545');new ethers.Contract('%s',['function minter() view returns (address)','function owner() view returns (address)'],p).minter().then(m=>new ethers.Contract('%s',['function owner() view returns (address)'],p).owner().then(o=>console.log(m+' '+o)))" % (addr, addr)], cwd=CHAIN, capture_output=True, text=True).stdout.strip()
        check("its minter is the bot and its owner is you", minter.lower() == (accts[1] + " " + accts[0]).lower(), minter)
        ctx.close()
        b.close()
finally:
    os.killpg(node.pid, signal.SIGKILL)
finish(errors)
