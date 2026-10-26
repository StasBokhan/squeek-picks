# Squeek Picks

A points-only prediction game on Squeektoshi's wheel. Every night players call three things: how far he runs, which 3 hours he spins the most, and whether more Squeek blocks settle than the night before. Picks lock when the night starts; results come from the public Squeekchain API.

The whole site is one file, `index.html`. A free Supabase database holds players and picks.

## What's in the folder

| File | What it is |
|---|---|
| `index.html` | The site. Upload this to any static host. |
| `supabase.sql` | Database setup. Run once in Supabase. |
| `src/app.html`, `build.mjs` | The source, if you want to edit. `node build.mjs` rebuilds `index.html` from it, so put your Supabase settings in `src/app.html` too before rebuilding. |

## Setup, about 15 minutes

### 1. Make the database

1. Create a free account at supabase.com and start a new project. Any region and name work.
2. In the project, open **SQL Editor**, start a new query, paste all of `supabase.sql`, and run it. It is safe to run again later.
3. Open the authentication settings and turn on **anonymous sign-ins**. Players then join with only a nickname, no email or password.

### 2. Connect the page

1. In the project settings, open the API page. Copy the **Project URL** and the **anon public** key.
2. Open `index.html` in a text editor and find this near the top of the script:

   ```js
   var CONFIG = {
     SUPABASE_URL: "",
     SUPABASE_ANON_KEY: "",
   ```

3. Paste the two values between the quotes and save.

The anon key is meant to be public. The rules in `supabase.sql` are what protect the data, so never paste the `service_role` key here.

### 3. Put it online

Any static host works. Two easy ones:

- **Netlify Drop:** go to app.netlify.com/drop and drag the folder holding `index.html` onto the page.
- **GitHub Pages:** put `index.html` in a repository, then turn on Pages in the repository settings.

Open the site, pick a nickname, save a ticket. That's it.

## Try it before connecting anything

Open `index.html` with the config left empty:

- If the Squeekchain API is reachable, you see live hamster data and your picks are kept in your browser only.
- If it isn't (for example opened inside a sandboxed preview), the page runs on clearly labelled sample numbers and sample players.

## How the game works

**A night** is the API's own day: 12:00 UTC on a date to 12:00 UTC the next day. Picks for a night close the moment it starts, so players pick the next night while watching the current one.

**Points**

| Market | Points |
|---|---|
| Distance guess | 30 / 20 / 10 / 5 within 0.25 / 0.5 / 1 / 2 km, plus 10 for the closest guess of the night |
| Peak window (eight 3-hour windows) | 20 for the right window, 5 for a window next to it |
| More or fewer Squeek blocks than the night before | 15 |

Best possible night: 75. The leaderboard sums the last 28 nights.

**Results**

- Distance and peak window come from the stats endpoint, which is built from closed, accepted rounds. A night is scored once its data covers at least 95% of its rounds.
- Blocks come from the settlements endpoint, counted by when they settled on Ethereum. Blocks from the last minutes of a night usually settle a few minutes later and count toward the next night. Everyone is scored the same way, so it stays fair.
- A market is void, with no points for anyone, when the data has a gap for more than a day, when the block counts tie, or when he takes the night off (no peak window to call).

## What protects the game

- **Locks are enforced by the database,** not the page. Picks can only be written for the open night, and only by their owner.
- **Picks stay hidden until their night locks.** Nobody can copy someone else's guess.
- **Scores are computed in each visitor's browser** from public data and locked picks, so everyone sees the same board.
- **Nobody deletes through the site.** You can remove players or picks yourself in the Supabase Table Editor.

## Limits worth knowing

- **Nicknames live in the browser.** A player on a new phone or after clearing site data starts as a new player. A later version could let players attach an email to keep their account.
- **Anyone can make a new player.** One person can play several nicknames. Each one competes on its own, so it doesn't boost a single score. If bots start signing up, turn on a captcha in Supabase's authentication settings.
- **The data is only as good as the device.** Squeekchain's own docs say a signature proves which key signed a record, not that a hamster ran. That's fine for points and a reason not to put money on it.
- **The Squeekchain API is in active development.** If fields change, parts of the page show as unavailable rather than wrong. It currently serves the Sepolia testnet.
- **Free Supabase projects pause after a week with no activity.** Unpause from the dashboard if that happens.

## Welfare

The game rewards guessing, never running. Squeekchain's care policy says he is never woken or pushed to mine, and quiet nights are expected. Keep it that way: no features that tip, ping or pay anyone around his wheel time.
