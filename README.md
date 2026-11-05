# Squeek Picks

A prediction game on Squeektoshi's wheel. Every night players call three things: how far he runs, which 3 hours he spins the most, and whether more Squeek blocks settle than the night before.

- **Points game:** free, nickname only, with a 28-night leaderboard. Stored in Supabase.
- **Nightly pot:** players buy tickets in Sepolia test ETH, up to 5 per wallet a night, each with its own picks. The top 3 tickets by that night's points split the pot 50/30/20. A bot pays out every hour.
- **My tickets:** a connected player sees every ticket from the last 2 weeks, how each night went, what they won, and refunds in one place. The leaderboard has a second tab ranking pot winners by ETH won.

Play it at **[squeekpicks.xyz](https://squeekpicks.xyz)**. The pot runs on the **Sepolia testnet only**. The contract refuses to deploy anywhere else.

## The page

The page is a dark counter with one piece of paper on it. On the counter: his wheel, turning at his real speed while he runs, with tonight's spins marked around it half hour by half hour; the till's display with tonight's numbers; and a three-line note on how to play. The paper is your picks for the next night, stamped SAVED once they're saved. Below it, plain sections on the counter: tonight so far, last night, the leaderboards, your Night Cards and the optional pot. The full rules are the small print at the bottom. Share pictures are little receipts.

Everything is served from the site: the fonts in `fonts/` (Hanken Grotesk, Courier Prime, Doto, Anton, all SIL Open Font License) and the libraries in `vendor/`.

## How a night works

- **A night** runs from 12:00 UTC to 12:00 UTC, the same day the Squeekchain API uses. Picks and tickets for a night close when it starts, so players pick the next night while watching the current one.
- **Points:** distance 30 / 20 / 10 / 5 within 0.25 / 0.5 / 1 / 2 km, plus 10 for the closest guess. Peak window 20, or 5 for the window next to it. Blocks 15. Best possible night: 75.
- **Results:** distance and peak come from closed, accepted rounds. Blocks come from blocks settled on Ethereum, counted by when they settled. A market with a data gap for over a day, a tied block count, or a night he doesn't run is void.

### Seasons

The free points game runs in seasons, set in `config.js` (`SEASONS`: a name, the first night, how many nights). Season 1 is the nights of Mon 2 Nov to Sun 15 Nov 2026.

- **By the odds:** in a season the peak window pays 5 to 40 points and blocks 5 to 25, depending on how many players picked the same thing: the fewer, the more it's worth. Counts are smoothed so a handful of players can't swing a pick to the extremes. Nobody sees how others picked until picks close, not even as counts: everything to go on is in his diary, so the players who read it best win.
- **One double a night:** a player can pick one market whose points count twice.
- **Live calls:** three quick calls a night, on the hours 21:00, 23:00 and 01:00 UTC: more or fewer spins than his median for that hour over the archived nights. Each closes when its hour starts (the database enforces it), settles from the half-hour stats, and pays 5 to 15 points by the odds. Answers stay hidden until the call closes. The Telegram bot posts each one within the hour before it closes.
- Distance scores as always. The pot keeps the classic points, since a pot ticket on chain has no double.
- The season has its own leaderboard tab and a champion. The rules live in `src/logic.js` (`scoreSeason`), shared by the page and the Telegram bot.
- Needs the **Seasons** and **Live calls** parts at the end of `supabase.sql` (a `double_market` column and a `call_answers` table; it also drops the `pick_odds` function an earlier version had). Until they're run, picks save without a double and no live calls appear.

### Night Cards

A collectible for each season night a player calls well, on Sepolia (`contracts/SqueekNightCards.sol`, an ERC-721). The art is printed on chain from his real run that night, as a receipt from his wheel's till: a hamster-in-wheel logo, his spins hour by hour with his busiest 3 hours marked, the night's totals, and a rubber stamp for the rarity (black Common, blue Rare, purple Epic, gold Legendary).

- **Common · Called it:** 20+ points that night. **Rare · Bullseye:** distance within 0.25 km. **Epic · Lone call:** right when nobody else was (3+ players), or **Perfect night:** all three right and the closest distance. **Legendary · Season champion:** one per season, showing the champion's best night.
- Players link a wallet on the page by signing a message (no fee). The payout bot (`settler/cards.mjs`, in the hourly workflow) checks the signature, records each finished night's run on the contract once, and mints each player's best card for that night. A card can only be minted once per player and night.
- Deploy it from `?admin` (the pot's owner wallet; the payout bot becomes the minter), then put its address in `config.js` as `CARDS_ADDRESS`. Needs the **Night Cards** part of `supabase.sql` (`wallet_links`).
- Not audited yet: it holds no ETH and only the minter can mint. Before any mainnet version, it gets its own audit.

### The pot

- Every ticket costs the same. Up to 5 tickets per wallet per night, each with its own picks, so players can spread their guesses. Each ticket ranks on its own, so one wallet can win more than one place. Players can change any of their tickets until the lock, paying only gas.
- Ranking: the night's points, then the closest distance guess, then the earlier ticket.
- Payout: 50/30/20 to the top 3. With 2 tickets, 62.5/37.5. Players tied on everything share the places they cover.
- The night is voided and everyone can refund when there's only 1 ticket, no result at all, or too many winners tied. A refund takes back all of a wallet's tickets for that night at once.
- If the bot hasn't paid a night out within 3 days of it ending, every ticket can be refunded from the page. Nobody's ticket can get stuck.
- If a payout can't be sent to a wallet, it waits in the contract and the player collects it from the page.
- The page and the bot use the same rules file (`src/logic.js`), so the expected winners shown on the page match what the bot pays.

### Email sign-in

Players start with no sign-up: a nickname and their picks, kept in the browser they played in. Adding an email keeps the nickname for good: the page emails a code, the player types it, and from then on the same email signs in on any phone or computer, with a new code each time. No passwords, and no wallet needed. Signing out only signs out that browser. Without an email, a nickname is lost when the browser's data is cleared (Safari clears it after a week without a visit), and the nickname can't be taken again.

It's off until email sending is set up (`EMAIL_LOGIN` in `config.js`). Supabase's own email only reaches the project's team, so it needs a sender of your own, for example Resend (free for 3,000 emails a month):

1. **Resend:** sign up at resend.com, add the domain `squeekpicks.xyz`, and add the DNS records it shows (for `send` and `resend._domainkey`) in Porkbun. Press Verify. Then create an API key with sending access. It goes into Supabase only, nowhere else.
2. **Supabase, Authentication → Emails → SMTP Settings:** turn on custom SMTP. Sender email `login@squeekpicks.xyz`, sender name `Squeek Picks`, host `smtp.resend.com`, port `465`, username `resend`, password: the API key.
3. **Supabase, Authentication → Emails → Templates:** set **Magic Link** to `email-templates/sign-in.html` and **Change Email Address** to `email-templates/add-email.html`, both with the subject `Your Squeek Picks code`. They send a code (`{{ .Token }}`) instead of a link, so it works in any browser, including the ones inside X and Telegram.
4. **Supabase, Authentication → Sign In / Providers:** keep **Allow anonymous sign-ins** on, turn on **Allow manual linking** (Supabase needs it to give an anonymous player an email), and under **Email** keep **Confirm email** on (that's what makes adding an email need the code).
5. **Supabase, Authentication → URL Configuration:** Site URL `https://squeekpicks.xyz`.
6. Set `EMAIL_LOGIN: true` in `config.js`.

## What protects the game

- Points picks lock in the database and stay hidden until the night starts.
- Pot tickets lock in the contract. Pot picks are public on the blockchain once bought.
- The bot can only pay a night to players who hold a ticket for it, and only between the end of the night and the 3-day refund window.
- Settings can only be changed by the owner wallet, and never the money in the pot.
- A wallet gets one nickname's Night Cards: the minting bot gives a wallet's cards to the first nickname that proved it owns it with a signature, and ignores any other link to it. Extra nicknames can't farm cards into one wallet, and nobody can lock a wallet's owner out by linking it first.
- Results don't depend on Squeekchain keeping its history. Every finished night is saved to `data/diary.json` once a day, and a saved night is never replaced by a less complete copy. When Squeekchain restarts its history with a new deployment (as it did on 4 to 5 November 2026), the page and the bots score the nights before from the saved copies, and never compare block counts across the restart (that market voids).

## Audit

The pot contract was audited by the **[IMD swarm](https://github.com/Identity-md/research/blob/main/jobs/06d98304-78a4-4089-815a-2be96ef1f7c5/files/AUDIT.md)**: four AI auditors (math, permissions, economics, control flow) and a judge who reproduced, merged and ranked their findings. It reviewed version 2 at commit `6ba3b13`. **No high or medium issues.** The 3 low findings are fixed in version 3:

| Finding | Version 3 |
|---|---|
| A wallet contract that can't receive plain ETH can't take its refund or owed payout | `refundTo` and `withdrawOwedTo` send it to another address |
| A winner can return a large blob and make payouts about 5× more expensive | payouts no longer copy what the winner returns |
| A mistyped owner address loses the owner role for good | the owner role changes hands in two steps: `offerOwner`, then `acceptOwner` |
| `openNight()` underflows on a fresh local chain (info) | rewritten without the subtraction |
| No test suite in the repository (info) | `contracts/test`, run by GitHub Actions on every contract change |

The other two info findings are recorded in [`contracts/AUDIT-SCOPE.md`](contracts/AUDIT-SCOPE.md): the payout bot decides which of a night's tickets win, and an owner price change just before a night's first ticket makes that purchase fail (the page says to reload).

To run the contract tests: `cd contracts && npm ci && npm test` (the pot and the Night Cards). The page, the bots and the database rules have their own tests in [`tests/`](tests/README.md), which GitHub runs on every push.

## Limits worth knowing

- **The results are only as good as the device.** Squeekchain's docs say a signature proves which key signed a record, not that a hamster ran. That's fine for test ETH, and the reason this stays on Sepolia.
- **Picks in the pot are public** once a ticket is bought, so a later player can see earlier picks.
- **GitHub pauses scheduled workflows** in repositories with no activity for 60 days. Re-enable it in the Actions tab if that happens. Missed nights can still be refunded.
- **The public Sepolia RPC** can be slow or rate limited. The bots try each step up to 3 times. If their runs still fail with network errors, get a free Sepolia RPC URL from Alchemy or Infura and add it as a secret named `SEPOLIA_RPC_URL`.
- **A deployed contract can't be changed.** To change the rules, deploy a new pot (the admin page, `?admin`, offers it when the source has a newer version), set `POT_ADDRESS` to it and add the old one to `OLD_POTS` in `config.js`, so the old pot's last nights still show and get paid. Unpaid nights on the old pot become refundable after 3 days.
- **The Squeekchain API is in active development.** If it changes, parts of the page show as unavailable rather than wrong, and the bot waits instead of paying out.

## Welfare

The game rewards guessing, never running. Squeekchain's care policy says he's never woken or pushed to mine, and quiet nights are expected. Keep it that way: no features that tip, ping or pay anyone around his wheel time.

## Squeekchain Genesis

squeekchain-project: 66af5fa9-77e6-4063-94a0-a7113106afe9
