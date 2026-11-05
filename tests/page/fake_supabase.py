# A small stand-in for Supabase (auth + the PostgREST tables the page uses), so the page can be
# tested in its real "remote" mode: anonymous players, adding an email with a code, signing in
# on another browser, signing out, and the database's unique rules (nicknames, one wallet link
# per player).
import base64, json, threading, time, uuid, http.server
from urllib.parse import urlparse, parse_qsl

def b64(d): return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")

class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.users = {}       # id -> user dict
        self.tokens = {}      # access or refresh token -> user id
        self.codes = {}       # email -> (code, kind, user id)
        self.mail = []        # (email, code, kind) in the order sent
        self.logouts = []     # scopes asked for
        self.tables = {"players": [], "picks": [], "call_answers": [], "wallet_links": []}
        self.next_code = 100000
    def session(self, uid):
        u = self.users[uid]
        now = int(time.time())
        at = b64({"alg": "HS256", "typ": "JWT"}) + "." + b64({"sub": uid, "role": "authenticated", "aud": "authenticated", "exp": now + 3600, "iat": now,
                                                                "email": u["email"], "is_anonymous": u["is_anonymous"], "session_id": str(uuid.uuid4())}) + ".c2ln"
        rt = uuid.uuid4().hex
        self.tokens[at] = uid; self.tokens[rt] = uid
        return {"access_token": at, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600, "refresh_token": rt, "user": dict(u)}
    def new_user(self):
        uid = str(uuid.uuid4())
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.users[uid] = {"id": uid, "aud": "authenticated", "role": "authenticated", "email": "", "phone": "", "is_anonymous": True,
                           "app_metadata": {}, "user_metadata": {}, "identities": [], "created_at": ts, "updated_at": ts}
        return uid
    def send(self, email, kind, uid):
        self.next_code += 1
        code = str(self.next_code)
        self.codes[email] = (code, kind, uid)
        self.mail.append((email, code, kind))
        return code
    def last_code(self, email):
        return next((c for e, c, k in reversed(self.mail) if e == email), None)

UNIQUE = {"players": [("id",), ("nickname",)], "picks": [("player_id", "night")], "call_answers": [("player_id", "night", "call_no")],
          "wallet_links": [("player_id",)]}

def handler(st):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *a): pass
        def cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers") or "*")
            self.send_header("Access-Control-Expose-Headers", "Content-Range, X-Supabase-Api-Version")
        def reply(self, code, body=None, headers=None):
            data = b"" if body is None else json.dumps(body).encode()
            self.send_response(code); self.cors()
            if body is not None: self.send_header("Content-Type", "application/json")
            for k, v in (headers or {}).items(): self.send_header(k, v)
            self.send_header("Content-Length", str(len(data))); self.end_headers()
            if self.command != "HEAD": self.wfile.write(data)
        def err(self, code, error_code, msg): self.reply(code, {"code": code, "error_code": error_code, "msg": msg})
        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"null") if n else None
        def me(self):
            auth = self.headers.get("Authorization", "")
            return st.tokens.get(auth[7:]) if auth.startswith("Bearer ") else None
        def do_OPTIONS(self): self.reply(204)
        def do_GET(self): self.route("GET")
        def do_HEAD(self): self.route("HEAD")
        def do_POST(self): self.route("POST")
        def do_PUT(self): self.route("PUT")
        def do_PATCH(self): self.route("PATCH")
        def route(self, m):
            u = urlparse(self.path)
            with st.lock:
                if u.path.startswith("/auth/v1/"): return self.auth(m, u.path[9:], dict(parse_qsl(u.query)))
                if u.path.startswith("/rest/v1/"): return self.rest(m, u.path[9:], parse_qsl(u.query))
            self.reply(404, {"message": "not found"})
        # ----- auth -----
        def auth(self, m, path, q):
            b = self.body() if m in ("POST", "PUT") else None
            if path == "signup" and m == "POST":
                if b and b.get("email"): return self.err(422, "validation_failed", "Use an OTP")
                return self.reply(200, st.session(st.new_user()))
            if path == "token" and q.get("grant_type") == "refresh_token":
                uid = st.tokens.get((b or {}).get("refresh_token"))
                return self.reply(200, st.session(uid)) if uid else self.err(400, "refresh_token_not_found", "Invalid Refresh Token")
            if path == "user":
                uid = self.me()
                if not uid: return self.err(401, "no_authorization", "This endpoint requires a valid Bearer token")
                if m == "GET": return self.reply(200, st.users[uid])
                email = ((b or {}).get("email") or "").lower()
                if email:
                    if any(x["email"] == email for k, x in st.users.items() if k != uid):
                        return self.err(422, "email_exists", "A user with this email address has already been registered")
                    st.users[uid]["new_email"] = email
                    st.send(email, "email_change", uid)
                return self.reply(200, st.users[uid])
            if path == "otp" and m == "POST":
                email = (b.get("email") or "").lower()
                uid = next((k for k, x in st.users.items() if x["email"] == email), None)
                if not uid: return self.err(422, "otp_disabled", "Signups not allowed for otp")
                st.send(email, "email", uid)
                return self.reply(200, {})
            if path == "verify" and m == "POST":
                email, token, kind = (b.get("email") or "").lower(), str(b.get("token") or ""), b.get("type")
                got = st.codes.get(email)
                ok = got and got[0] == token and (got[1] == kind or (kind in ("email", "magiclink") and got[1] == "email"))
                if not ok: return self.err(403, "otp_expired", "Token has expired or is invalid")
                del st.codes[email]
                uid = got[2]
                if kind == "email_change":
                    st.users[uid].update({"email": email, "is_anonymous": False}); st.users[uid].pop("new_email", None)
                return self.reply(200, st.session(uid))
            if path == "logout" and m == "POST":
                st.logouts.append(q.get("scope"))
                return self.reply(204)
            return self.reply(404, {"msg": "no such auth route " + path})
        # ----- tables -----
        def rest(self, m, table, params):
            rows = st.tables.get(table)
            if rows is None: return self.reply(404, {"code": "42P01", "message": f'relation "public.{table}" does not exist'})
            if m in ("GET", "HEAD"):
                out = rows
                for k, v in params:
                    if k in ("select", "order", "limit", "offset"): continue
                    op, _, val = v.partition(".")
                    def keep(r, k=k, op=op, val=val):
                        x = r.get(k)
                        x = "" if x is None else str(x).lower() if isinstance(x, bool) else str(x)
                        return {"eq": x == val, "gte": x >= val, "lte": x <= val, "gt": x > val, "lt": x < val}.get(op, True)
                    out = [r for r in out if keep(r)]
                sel = dict(params).get("select", "*")
                if sel != "*":
                    cols = [c.strip() for c in sel.split(",")]
                    out = [{c: r.get(c) for c in cols} for r in out]
                total = len(out)
                lim = dict(params).get("limit")
                rng = self.headers.get("Range")
                if rng:
                    a, b2 = [int(x) for x in rng.split("-")]; out = out[a:b2 + 1]
                elif lim: out = out[:int(lim)]
                hdr = {"Content-Range": (f"0-{max(0, len(out) - 1)}/{total}" if out else f"*/{total}")}
                return self.reply(200 if m == "GET" else 200, out if m == "GET" else None, hdr)
            if m == "POST":
                b = self.body(); items = b if isinstance(b, list) else [b]
                prefer = self.headers.get("Prefer", "")
                conflict = tuple(dict(params).get("on_conflict", "").split(",")) if dict(params).get("on_conflict") else None
                for it in items:
                    it = dict(it)
                    same = (lambda r, cols: all(str(r.get(c)).lower() == str(it.get(c)).lower() for c in cols))
                    hit = next((r for r in rows if conflict and same(r, conflict)), None) if "merge-duplicates" in prefer else None
                    for cols in UNIQUE.get(table, []):
                        clash = next((r for r in rows if r is not hit and same(r, cols)), None)
                        if clash: return self.reply(409, {"code": "23505", "details": None, "hint": None, "message": f'duplicate key value violates unique constraint "{table}_{"_".join(cols)}_key"'})
                    if hit: hit.update(it)
                    else: rows.append(it)
                return self.reply(201, items if "return=representation" in prefer else None)
            return self.reply(405, {"message": "method not allowed"})
    return H

def start(port):
    st = State()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler(st))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return st, srv
