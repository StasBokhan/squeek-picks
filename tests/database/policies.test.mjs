// The database rules in supabase.sql (row-level security, unique nicknames, wallet links),
// checked on a real Postgres (PGlite) with stand-ins for Supabase's auth schema and roles:
//   node database/policies.test.mjs [path/to/supabase.sql]
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { ROOT } from "../lib/common.mjs";

const SQL = process.argv[2] || ROOT + "/supabase.sql";

const db = new PGlite();
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

// Stand-in for Supabase's auth schema and roles.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users values ('${A}'), ('${B}');
`);
await db.exec(readFileSync(SQL, "utf8"));
// Running it twice must also work (people re-run setup scripts).
await db.exec(readFileSync(SQL, "utf8"));

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

async function as(role, sub, sql) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub ?? ""}', false); set role ${role};`);
  try {
    const r = await db.query(sql);
    return { rows: r.rows, affected: r.affectedRows };
  } catch (e) {
    return { error: e.message };
  } finally {
    await db.exec("reset role;");
  }
}

const open = (await db.query("select public.open_night()::text as d")).rows[0].d;
const live = (await db.query("select (public.open_night() - 1)::text as d")).rows[0].d;
const later = (await db.query("select (public.open_night() + 1)::text as d")).rows[0].d;
check("open_night is tomorrow-ish", true, `open=${open} live=${live}`);

let r = await as("authenticated", A, `insert into public.players (id, nickname) values ('${A}', 'wheelwatcher')`);
check("A creates own player", !r.error, r.error);
r = await as("authenticated", A, `insert into public.players (id, nickname) values ('${B}', 'impostor')`);
check("A cannot create B's player", !!r.error, r.error);
r = await as("authenticated", B, `insert into public.players (id, nickname) values ('${B}', 'WheelWatcher')`);
check("nickname unique ignoring case", !!r.error && /unique|duplicate/i.test(r.error), r.error);
r = await as("authenticated", B, `insert into public.players (id, nickname) values ('${B}', 'bad name!')`);
check("nickname format enforced", !!r.error, r.error);
r = await as("authenticated", B, `insert into public.players (id, nickname) values ('${B}', 'night_owl')`);
check("B creates own player", !r.error, r.error);

r = await as("authenticated", A, `insert into public.picks (player_id, night, distance_km, peak_block, more_blocks) values ('${A}', '${open}', 9.4, 3, true)`);
check("A picks the open night", !r.error, r.error);
r = await as("authenticated", A, `insert into public.picks (player_id, night, distance_km, peak_block, more_blocks) values ('${A}', '${live}', 9.4, 3, true)`);
check("A cannot pick the locked night", !!r.error, r.error);
r = await as("authenticated", A, `insert into public.picks (player_id, night, distance_km, peak_block, more_blocks) values ('${A}', '${later}', 9.4, 3, true)`);
check("A cannot pick two nights ahead", !!r.error, r.error);
r = await as("authenticated", A, `insert into public.picks (player_id, night, distance_km, peak_block, more_blocks) values ('${A}', '${open}', 11.2, 4, false)
  on conflict (player_id, night) do update set distance_km = excluded.distance_km, peak_block = excluded.peak_block, more_blocks = excluded.more_blocks`);
check("A changes pick with upsert", !r.error, r.error);
r = await as("authenticated", A, `insert into public.picks (player_id, night, distance_km, peak_block, more_blocks) values ('${A}', '${open}', 99, 4, false)
  on conflict (player_id, night) do update set distance_km = excluded.distance_km`);
check("distance range enforced", !!r.error, r.error);
r = await as("authenticated", B, `insert into public.picks (player_id, night, distance_km, peak_block, more_blocks) values ('${A}', '${open}', 1, 1, true)`);
check("B cannot pick as A", !!r.error, r.error);

// A locked pick from the night in progress, written directly as the admin would.
await db.exec(`insert into public.picks (player_id, night, distance_km, peak_block, more_blocks) values ('${A}', '${live}', 8.0, 3, true)`);

r = await as("authenticated", B, `select night::text, distance_km::text from public.picks where player_id = '${A}' order by night`);
check("B sees A's locked pick only", !r.error && r.rows.length === 1 && r.rows[0].night === live, JSON.stringify(r.rows ?? r.error));
r = await as("anon", null, `select night::text from public.picks`);
check("signed-out visitor sees locked picks only", !r.error && r.rows.length === 1 && r.rows[0].night === live, JSON.stringify(r.rows ?? r.error));
r = await as("authenticated", A, `select night::text, distance_km::text, peak_block from public.picks where player_id = '${A}' order by night`);
check("A sees own open pick with the change", !r.error && r.rows.length === 2 && r.rows[1].distance_km === "11.2" && r.rows[1].peak_block === 4, JSON.stringify(r.rows ?? r.error));
r = await as("authenticated", B, `update public.picks set distance_km = 0 where player_id = '${A}'`);
check("B cannot change A's picks", !r.error && r.affected === 0, r.error ?? `affected=${r.affected}`);
r = await as("authenticated", A, `update public.picks set distance_km = 1 where night = '${live}'`);
check("A cannot change a locked pick", !r.error && r.affected === 0, r.error ?? `affected=${r.affected}`);
r = await as("authenticated", A, `delete from public.picks`);
check("nobody deletes through the site", !r.error ? r.affected === 0 : true, r.error ?? `affected=${r.affected}`);
r = await as("anon", null, `select nickname from public.players order by nickname`);
check("everyone sees nicknames", !r.error && r.rows.length === 2, JSON.stringify(r.rows ?? r.error));
r = await as("anon", null, `insert into public.players (id, nickname) values ('${B}', 'sneaky')`);
check("signed-out visitor cannot write", !!r.error, r.error);

// ---------- Seasons: a double per pick, and no crowd counts before the lock ----------
r = await as("authenticated", A, `update public.picks set double_market = 'peak' where player_id = '${A}' and night = '${open}'`);
check("A doubles a market on the open pick", !r.error && r.affected === 1, r.error ?? `affected=${r.affected}`);
r = await as("authenticated", A, `update public.picks set double_market = 'everything' where player_id = '${A}' and night = '${open}'`);
check("only distance, peak or blocks can be doubled", !!r.error, r.error);
r = await as("authenticated", A, `update public.picks set double_market = 'blocks' where night = '${live}'`);
check("the double can't change after the lock", !r.error && r.affected === 0, r.error ?? `affected=${r.affected}`);
r = await as("authenticated", B, `insert into public.picks (player_id, night, distance_km, peak_block, more_blocks, double_market) values ('${B}', '${open}', 10.0, 3, true, null)`);
check("B picks without a double", !r.error, r.error);
r = await as("anon", null, `select night::text from public.picks where night = '${open}'`);
check("open picks themselves stay hidden", !r.error && r.rows.length === 0, JSON.stringify(r.rows ?? r.error));
// The crowd's counts aren't readable either: an earlier pick_odds function is dropped.
await db.exec(`reset role; create or replace function public.pick_odds(p_night date) returns json language sql as $$ select '{}'::json $$;
  create or replace function public.call_odds(p_night date) returns json language sql as $$ select '[]'::json $$;`);
await db.exec(readFileSync(SQL, "utf8"));
r = await db.query(`select to_regprocedure('public.pick_odds(date)')::text as p, to_regprocedure('public.call_odds(date)')::text as c`);
check("no odds functions: nobody sees counts before the lock", r.rows[0].p === null && r.rows[0].c === null, JSON.stringify(r.rows));
r = await db.query(`select count(*)::int as n from public.picks`);
check("re-running the script keeps the picks", r.rows[0].n >= 2, JSON.stringify(r.rows));

// ---------- Live calls: answers until the call closes, hidden until then ----------
const nowUtc = new Date();
const hoursIn = (Date.now() - Date.parse(live + "T12:00:00Z")) / 3600e3;   // hours into the running night
const openCall = hoursIn < 9 ? 1 : hoursIn < 11 ? 2 : hoursIn < 13 ? 3 : null;
const closedCall = hoursIn >= 13 ? 3 : hoursIn >= 11 ? 2 : hoursIn >= 9 ? 1 : null;
r = await db.query(`select public.call_closes('${live}', 1::smallint) as t`);
check("call 1 closes at 21:00 UTC", new Date(r.rows[0].t).toISOString() === live + "T21:00:00.000Z", JSON.stringify(r.rows));
if (openCall) {
  r = await as("authenticated", A, `insert into public.call_answers (player_id, night, call_no, over) values ('${A}', '${live}', ${openCall}, true)`);
  check("A answers an open call", !r.error, r.error);
  r = await as("authenticated", A, `insert into public.call_answers (player_id, night, call_no, over) values ('${A}', '${live}', ${openCall}, false)
    on conflict (player_id, night, call_no) do update set over = excluded.over`);
  check("A changes the answer before it closes", !r.error, r.error);
  r = await as("authenticated", B, `insert into public.call_answers (player_id, night, call_no, over) values ('${B}', '${live}', ${openCall}, true)`);
  check("B answers too", !r.error, r.error);
  r = await as("anon", null, `select * from public.call_answers where night = '${live}' and call_no = ${openCall}`);
  check("open answers stay hidden from others", !r.error && r.rows.length === 0, JSON.stringify(r.rows ?? r.error));
} else check("(no call open at this hour of the test run)", true);
if (closedCall) {
  r = await as("authenticated", A, `insert into public.call_answers (player_id, night, call_no, over) values ('${A}', '${live}', ${closedCall}, true)`);
  check("a closed call takes no answers", !!r.error, r.error);
}
r = await as("authenticated", A, `insert into public.call_answers (player_id, night, call_no, over) values ('${A}', '${open}', 1, true)`);
check("calls are for the running night only", !!r.error, r.error);
r = await as("authenticated", A, `insert into public.call_answers (player_id, night, call_no, over) values ('${B}', '${live}', 1, true)`);
check("nobody answers for someone else", !!r.error, r.error);
r = await as("authenticated", A, `insert into public.call_answers (player_id, night, call_no, over) values ('${A}', '${live}', 4, true)`);
check("only calls 1 to 3", !!r.error, r.error);

// ---------- Night Cards: wallet links ----------
const sig = "0x" + "ab".repeat(65), W = "0x" + "12".repeat(20);
r = await as("authenticated", A, `insert into public.wallet_links (player_id, wallet, message, signature) values ('${A}', '${W}', 'Squeek Picks: send my Night Cards to ${W}. Player ${A}.', '${sig}')`);
check("A links a wallet", !r.error, r.error);
r = await as("authenticated", A, `insert into public.wallet_links (player_id, wallet, message, signature) values ('${B}', '${W}', 'x', '${sig}')`);
check("nobody links a wallet for someone else", !!r.error, r.error);
r = await as("authenticated", B, `insert into public.wallet_links (player_id, wallet, message, signature) values ('${B}', 'not-a-wallet', 'x', '${sig}')`);
check("a wallet must look like one", !!r.error, r.error);
r = await as("authenticated", B, `insert into public.wallet_links (player_id, wallet, message, signature) values ('${B}', '${W}', 'x', '0x1234')`);
check("a signature must look like one", !!r.error, r.error);
r = await as("authenticated", A, `update public.wallet_links set wallet = '0x${"34".repeat(20)}' where player_id = '${A}'`);
check("A changes the linked wallet", !r.error && r.affected === 1, r.error ?? `affected=${r.affected}`);
r = await as("authenticated", B, `update public.wallet_links set wallet = '0x${"56".repeat(20)}' where player_id = '${A}'`);
check("B can't change A's wallet", !r.error && r.affected === 0, r.error ?? `affected=${r.affected}`);
r = await as("anon", null, `select player_id::text, wallet from public.wallet_links`);
check("the minting bot can read linked wallets", !r.error && r.rows.length === 1 && r.rows[0].wallet === "0x" + "34".repeat(20), JSON.stringify(r.rows ?? r.error));
// Someone else can't lock a wallet's owner out: a second nickname may link the same wallet
// (the minting bot gives its cards to the first nickname that proved it with a signature).
await db.exec(`reset role; create unique index if not exists wallet_links_wallet_key on public.wallet_links (lower(wallet));`);
await db.exec(readFileSync(SQL, "utf8"));   // an upgrade from the version with that rule
r = await as("anon", null, `select count(*)::int as n from pg_indexes where indexname = 'wallet_links_wallet_key'`);
check("running the file again removes the one-nickname-per-wallet rule", !r.error && r.rows[0].n === 0, JSON.stringify(r.rows ?? r.error));
r = await as("authenticated", B, `insert into public.wallet_links (player_id, wallet, message, signature) values ('${B}', '0x${"34".repeat(20)}', 'x', '${sig}')`);
check("a second nickname can link the same wallet (no lock-out)", !r.error, r.error);
r = await as("authenticated", B, `update public.wallet_links set wallet = '0x${"A1".repeat(20)}' where player_id = '${A}'`);
check("but nobody changes another player's link", !r.error && r.affected === 0, r.error ?? `affected=${r.affected}`);

for (const { name, ok, detail } of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
console.log(results.every((x) => x.ok) ? "ALL PASS" : "SOME FAILED");
process.exit(results.length && results.every((x) => x.ok) ? 0 : 1);
