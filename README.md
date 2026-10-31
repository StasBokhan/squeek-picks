# Squeek Picks

A prediction game on Squeektoshi's wheel. Every night players call three things: how far he runs, which 3 hours he spins the most, and whether more Squeek blocks settle than the night before.

- **Points game:** free, nickname only, with a 28-night leaderboard. Stored in Supabase.
- **Nightly pot:** players buy tickets in Sepolia test ETH, up to 5 per wallet a night, each with its own picks. The top 3 tickets by that night's points split the pot 50/30/20. A bot pays out every hour.
- **My tickets:** a connected player sees every ticket from the last 2 weeks, how each night went, what they won, and refunds in one place. The leaderboard has a second tab ranking pot winners by ETH won.

Play it at **[squeekpicks.xyz](https://squeekpicks.xyz)**. The pot runs on the **Sepolia testnet only**. The contract refuses to deploy anywhere else.

## How a night works

- **A night** runs from 12:00 UTC to 12:00 UTC, the same day the Squeekchain API uses. Picks and tickets for a night close when it starts, so players pick the next night while watching the current one.
- **Points:** distance 30 / 20 / 10 / 5 within 0.25 / 0.5 / 1 / 2 km, plus 10 for the closest guess. Peak window 20, or 5 for the window next to it. Blocks 15. Best possible night: 75.
- **Results:** distance and peak come from closed, accepted rounds. Blocks come from blocks settled on Ethereum, counted by when they settled. A market with a data gap for over a day, a tied block count, or a night he doesn't run is void.

### The pot

- Every ticket costs the same. Up to 5 tickets per wallet per night, each with its own picks, so players can spread their guesses. Each ticket ranks on its own, so one wallet can win more than one place. Players can change any of their tickets until the lock, paying only gas.
- Ranking: the night's points, then the closest distance guess, then the earlier ticket.
- Payout: 50/30/20 to the top 3. With 2 tickets, 62.5/37.5. Players tied on everything share the places they cover.
- The night is voided and everyone can refund when there's only 1 ticket, no result at all, or too many winners tied. A refund takes back all of a wallet's tickets for that night at once.
- If the bot hasn't paid a night out within 3 days of it ending, every ticket can be refunded from the page. Nobody's ticket can get stuck.
- If a payout can't be sent to a wallet, it waits in the contract and the player collects it from the page.
- The page and the bot use the same rules file (`src/logic.js`), so the expected winners shown on the page match what the bot pays.

## What protects the game

- Points picks lock in the database and stay hidden until the night starts.
- Pot tickets lock in the contract. Pot picks are public on the blockchain once bought.
- The bot can only pay a night to players who hold a ticket for it, and only between the end of the night and the 3-day refund window.
- Settings can only be changed by the owner wallet, and never the money in the pot.

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

To run the tests: `cd contracts && npm ci && npm test`.

## Limits worth knowing

- **The results are only as good as the device.** Squeekchain's docs say a signature proves which key signed a record, not that a hamster ran. That's fine for test ETH, and the reason this stays on Sepolia.
- **Picks in the pot are public** once a ticket is bought, so a later player can see earlier picks.
- **GitHub pauses scheduled workflows** in repositories with no activity for 60 days. Re-enable it in the Actions tab if that happens. Missed nights can still be refunded.
- **The public Sepolia RPC** can be slow or rate limited. If the bot's runs fail with network errors, get a free Sepolia RPC URL from Alchemy or Infura and add it as a secret named `SEPOLIA_RPC_URL`.
- **A deployed contract can't be changed.** To change the rules, deploy a new pot (the admin page, `?admin`, offers it when the source has a newer version), set `POT_ADDRESS` to it and add the old one to `OLD_POTS` in `config.js`, so the old pot's last nights still show and get paid. Unpaid nights on the old pot become refundable after 3 days.
- **The Squeekchain API is in active development.** If it changes, parts of the page show as unavailable rather than wrong, and the bot waits instead of paying out.

## Welfare

The game rewards guessing, never running. Squeekchain's care policy says he's never woken or pushed to mine, and quiet nights are expected. Keep it that way: no features that tip, ping or pay anyone around his wheel time.
