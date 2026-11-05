"""The page never scrolls sideways on narrow phones (320, 360 and 390 px wide)."""
from common import *

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

SITE = make_site("site_widths", {})
s = http.server.ThreadingHTTPServer(("127.0.0.1", 8012), functools.partial(Q, directory=SITE)); threading.Thread(target=s.serve_forever, daemon=True).start()
errors = []
# Elements that reach past the right edge (not counting fixed ones), to say what to fix.
WIDE = """w => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > w + 0.5 && getComputedStyle(e).position !== 'fixed')
  .slice(0, 6).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ' ' + e.getBoundingClientRect().right.toFixed(1))"""
with sync_playwright() as p:
    b = p.chromium.launch()
    for w in (320, 360, 390):
        ctx = b.new_context(viewport={"width": w, "height": 800}, locale="en-GB", timezone_id="Europe/Paris", has_touch=True, is_mobile=True)
        pg = ctx.new_page(); pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.route("**/*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(api_body(r.request.url.split("api.squeekchain.com", 1)[1])))
                 if "api.squeekchain.com" in r.request.url else r.continue_() if r.request.url.startswith("http://127.0.0.1") else r.abort())
        pg.goto("http://127.0.0.1:8012/"); pg.wait_for_timeout(2500)
        width = pg.evaluate("document.documentElement.scrollWidth")
        check("at %d px the page doesn't scroll sideways" % w, width <= w, "page is %d px wide; %s" % (width, pg.evaluate(WIDE, w)))
        pg.screenshot(path=SCR + "/widths-%d.png" % w)
        ctx.close()
    b.close()
finish(errors)
