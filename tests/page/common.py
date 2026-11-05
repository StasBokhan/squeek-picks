"""Shared by the page tests (from common import *): where things are, a local chain posing as
Sepolia, the fake Squeekchain API, and small helpers."""
import datetime as dt, functools, http.server, json, os, shutil, subprocess, sys, threading, time, urllib.request
from playwright.sync_api import sync_playwright

CHAIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # tests/: hardhat and lib/ run from here
PROJ = os.path.dirname(CHAIN)                                          # the repo: the page and the bots under test
SCR = os.path.join(os.environ.get("TEST_OUT") or os.path.join(CHAIN, "out"), "page")   # served copies of the site, screenshots
os.makedirs(SCR, exist_ok=True)
BOT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
DAY = 86400_000
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))

def wait_text(page, el_id, text, timeout=30000):
    try: page.wait_for_function("document.getElementById(%s).textContent.includes(%s)" % (json.dumps(el_id), json.dumps(text)), timeout=timeout)
    except Exception:
        raise AssertionError("waited for %r in #%s; it shows: %r; wallet calls: %r" % (text, el_id, page.inner_text("#" + el_id)[:300], page.evaluate("window.__calls || []")[-8:]))

def rpc(method, params=None):
    req = urllib.request.Request("http://127.0.0.1:8545", json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode(), {"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())["result"]

def date_str(ms): return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
def night_start(n): return int(dt.datetime.strptime(n + "T12:00:00+0000", "%Y-%m-%dT%H:%M:%S%z").timestamp() * 1000)
def add_days(n, k): return date_str(night_start(n) - 12 * 3600_000 + k * DAY)
def live_night(ms): return date_str(ms - 12 * 3600_000)
def iso(ms): return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat().replace("+00:00", "Z")

# ----- fake Squeekchain API, answering for the time in FIX["now"] -----
FIX = {"now": 0, "special": {}}
def stats(now):
    live = live_night(now); days = []
    for k in range(29, -1, -1):
        night = add_days(live, -k); start = night_start(night); buckets = []; work = 0
        sp = FIX["special"].get(night, {}).get("slots")
        for i in range(48):
            t0 = start + i * 1800_000
            if t0 >= now: buckets.append({"startMinuteUtc": (720 + i * 30) % 1440, "coverage": "future", "observedRoundCount": 0, "workUnits": "0"}); continue
            w = sp[i] if sp is not None else 1500 if i // 6 == 3 else 300 if i // 6 == 4 else 0
            work += w
            buckets.append({"startMinuteUtc": (720 + i * 30) % 1440, "coverage": "complete", "observedRoundCount": 3, "workUnits": str(w)})
        km = FIX["special"].get(night, {}).get("km", 8.0 + (k % 4))
        complete = now >= start + DAY
        days.append({"date": night, "coverage": {"expectedRoundCount": 144, "observedRoundCount": 144 if complete else 70, "coverageBps": 10000 if complete else 4800},
                     "observedWorkUnits": str(work), "distanceMm": str(int(round(km * 1e6))) if complete else str(work * 932), "buckets": buckets})
    typical = [{"startMinuteUtc": (720 + i * 30) % 1440, "totalWorkUnits": "0", "observedDayCount": 7, "meanWorkMilli": str((1500 if i // 6 == 3 else 300 if i // 6 == 4 else 0) * 1000)} for i in range(48)]
    return {"window": {"startAt": iso(night_start(add_days(live, -29))), "endAt": iso(now)}, "generatedAt": iso(now), "activity": {"days": days, "typicalDay": typical}}
def settlements(now):
    live = live_night(now); buckets = []
    for k in range(29, -1, -1):
        night = add_days(live, -k)
        n = FIX["special"].get(night, {}).get("blocks", 1000 + 7 * k)
        buckets.append({"startAt": iso(night_start(night)), "endAt": iso(night_start(night) + DAY), "completedBlockCount": str(n)})
    return {"status": "available", "generatedAt": iso(now), "window": {"bucketSeconds": 86400}, "buckets": buckets, "recentSettlements": [{"blockTimestamp": iso(now - 300_000)}]}
def live_work(now):
    start = night_start(live_night(now)); work = 0
    for i in range(48):
        if start + i * 1800_000 < now: work += 1500 if i // 6 == 3 else 300 if i // 6 == 4 else 0
    return work
def status(now):
    # Tonight's distance on the wheel, consistent with the half-hour stats above.
    return {"measurement": {"freshness": "online", "observedAt": iso(now - 5000), "coreStatus": "ACTIVE", "rpmMilli": 80000, "speedMmPerSecond": 1200, "distanceMm": live_work(now) * 932},
            "builder": {"status": "available", "anchor": {"blockHeight": "4321"}}}
def api_body(path):
    now = FIX["now"] or int(time.time() * 1000)
    if path.startswith("/v1/measurement/stats"): return stats(now)
    if path.startswith("/v1/settlements"): return settlements(now)
    if path.startswith("/v1/status"): return status(now)
    return None

def start_chain(port=8545):
    """A local chain answering as Sepolia, in its own process group (stop it with os.killpg)."""
    return subprocess.Popen(["node", "node_modules/hardhat/internal/cli/bootstrap.js", "--config", "hardhat.sepolia.cjs", "node", "--port", str(port)],
                            cwd=CHAIN, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def make_site(name, config, files=("index.html", "wallet.js", "icon.svg", "squeektoshi.jpg", "diary.html", "overlay.html"), dirs=("vendor", "fonts")):
    """A copy of the site under SCR/name with its own config.js; returns its folder."""
    site = os.path.join(SCR, name)
    os.makedirs(site, exist_ok=True)
    for f in files: shutil.copy(os.path.join(PROJ, f), os.path.join(site, f))
    for d in dirs: shutil.copytree(os.path.join(PROJ, d), os.path.join(site, d), dirs_exist_ok=True)
    open(os.path.join(site, "config.js"), "w").write("window.SQUEEK_CONFIG = " + json.dumps(config) + ";\n")
    return site

def finish(errors=()):
    """Prints every check and exits 1 if any failed, or if the page threw errors."""
    for name, ok, detail in results: print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "  -> " + str(detail)[-900:]))
    if errors: print("page errors:", list(errors)[:3])
    good = bool(results) and all(ok for _, ok, _ in results) and not errors
    print("ALL PASS" if good else "SOME FAILED")
    sys.exit(0 if good else 1)
