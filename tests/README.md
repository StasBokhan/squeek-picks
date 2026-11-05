# Tests

These run on GitHub on every push and pull request ([tests.yml](../.github/workflows/tests.yml)),
and on your computer with `./run.sh`. Nothing touches Sepolia, Supabase, Telegram or the real
Squeekchain API: each test starts its own local chain (hardhat) and small stand-ins for the
services.

| Suite | What it checks |
|---|---|
| `database/` | The rules in `supabase.sql` on a real Postgres (PGlite): who can read and change what, unique nicknames, wallet links, and that the file can be run again. |
| `bots/` | The bots in `settler/` and `archive/`, run for real: paying out the pot (with an old version 1 or 2 pot still finishing), Night Cards, the Telegram posts, the stats, the inspect tool, and the diary when Squeekchain restarts its history. |
| `page/` | The page in Chromium (Playwright) with a stand-in wallet: tickets, the race, results after a payout, My tickets, seasons and calls, Night Cards, email sign-in against a fake Supabase, and phone sizes. |

The contracts have their own tests in [`contracts/test`](../contracts/test), run by
[contracts.yml](../.github/workflows/contracts.yml). GitHub also checks that `index.html` is
built from `src/` (`node build.mjs`).

## Running them

```sh
cd tests && npm ci
(cd ../settler && npm ci)
# the page tests also need Python 3 with Playwright:
pip install playwright==1.63.0 && python3 -m playwright install chromium

./run.sh              # everything, or one suite: ./run.sh database | bots | page
```

Each test's output goes to `out/logs/`, and the page tests' screenshots to `out/page/`. A test
can also run alone, for example `node bots/cards.test.mjs` or `python3 page/account_test.py`
(from this folder). They use local ports 8000–8021, 8545–8549 and 8787–8797, so run one at a
time.

## Fixtures

- `fixtures/SqueekPotV2.json`: version 2 of the pot as it was deployed (compiled from
  `contracts/SqueekPotV2.sol`), for the tests where an old pot is still finishing.
- `fixtures/SqueekNightCards-first.json`: the first Night Cards contract, from before the cards
  were printed as receipts, so the inspect tool is checked against it too.
