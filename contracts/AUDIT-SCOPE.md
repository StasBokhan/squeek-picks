# Audit: Squeek Picks nightly pot

**Audited:** version 2 of the pot, by the [IMD swarm](https://github.com/Identity-md/research/blob/main/jobs/06d98304-78a4-4089-815a-2be96ef1f7c5/files/AUDIT.md)
on 2026-10-31, at commit `6ba3b13` (job `06d98304-78a4-4089-815a-2be96ef1f7c5`). Four agents each
audited one area (math, permissions, economics, control flow); a judge reproduced, merged and
ranked their findings. **Result: 3 low, 4 info, no high or medium.**
Version 2 is kept as `SqueekPotV2.sol`, deployed on Sepolia at `0x845AC45012405B8Fa1Ff017320304b665b915F86`.

**Current:** `contracts/SqueekPot.sol`, version 3 (Solidity 0.8.24): version 2 plus the fixes below.
Its tests are in `contracts/test` (`cd contracts && npm ci && npm test`) and run on every change.

**Lower priority:** `contracts/SqueekPotV1.sol`, the first version (one ticket per wallet, winners
paid by address). It has the same shape as findings 1 and 2 and can't be changed; the page no
longer sells its tickets.
**Out of scope:** the web page (`src/app.html`), the payout bot (`settler/settle.mjs`) and
the scoring rules (`src/logic.js`), except where they explain what the contract expects.

## Findings and what changed in version 3

| # | Severity | Finding | Version 3 |
|---|---|---|---|
| 1 | Low | `refund` and `withdrawOwed` only pay `msg.sender` and revert if the send fails, so a wallet contract that can't take plain ETH can't get its refund or owed payout out. | `refundTo(night, to)` and `withdrawOwedTo(to)` send it to another address. Only the caller's own tickets or balance; zero address refused; a `SentTo` event records where it went. |
| 2 | Low | `_pay` copies the winner's return data, so a winner can return 96,000 bytes within the 30,000-gas stipend and make `settle` about 5× more expensive for the bot. | All sends go through `_send`, a `call` in assembly that doesn't copy return data. Tested: ten blob-returning winners now cost about the same as ten refusing ones. |
| 3 | Low | `setOwner` hands over the owner role in one step, so a mistyped address loses it for good, and with it the only way to replace the payout bot. | `offerOwner(next)`, then `acceptOwner()` from the new address. Until then nothing changes; offering zero withdraws the offer. |
| 4 | Info | The resolver, and the owner by first making itself resolver, can pay a night's whole pot to any ticket of that night, including one it holds. | No code change: accepted for a testnet game and now stated precisely below. |
| 5 | Info | `getNight` quotes the global price before a night's first ticket, so an owner price change just before it makes that purchase revert. | No code change: no funds move, and the page shows "The ticket price changed. Reload the page and try again." |
| 6 | Info | `openNight()` underflows when `block.timestamp` is under 12 hours (fresh local chains). | Rewritten as `(block.timestamp + DAY - LOCK_OFFSET) / DAY`: the same night for every real timestamp, no subtraction. |
| 7 | Info | No test suite in the repository. | `contracts/test/SqueekPot.test.cjs` pins every edge below, plus a check that `SqueekPot.json` matches the source. |

## What it does

A nightly prediction pot on Squeektoshi the hamster's wheel (Squeekchain). Each night `d`
runs from day `d` 12:00 UTC to day `d+1` 12:00 UTC and is numbered by days since 1970-01-01.

- **Buying:** while a night is open (before it starts), anyone can buy up to 5 tickets for it
  at the night's price, each with its own picks: a distance guess (0 to 60.0 km, in tenths),
  a 3-hour window (0 to 7) and more or fewer blocks than the night before. At most 500
  tickets a night. The price is fixed for a night by its first ticket.
- **Changing picks:** a ticket's owner can change its picks until the night starts. Its
  place in the tie-break order (`boughtAt`, then ticket number) stays.
- **Settling:** after the night ends and within 3 days, the resolver pays the whole pot to
  up to 10 winning tickets, by ticket number, with shares in basis points that add up to
  10,000. Rounding dust goes to the first winner. A payout that can't be received within
  30,000 gas is kept in `owed` for the winner to collect with `withdrawOwed` or `withdrawOwedTo`.
- **Voiding:** after the night ends, the resolver can void it instead (no result, or fewer
  than 2 tickets). Every ticket can then be refunded.
- **Timeout:** if a night isn't settled within 3 days of ending, every ticket can be refunded,
  without anyone voiding it.
- **Refunds:** `refund(night)` pays back all of the caller's not-yet-refunded tickets for that
  night at the night's price; `refundTo(night, to)` sends the same amount to another address.

## Roles and trust assumptions (known and accepted)

- **Resolver** (the payout bot): decides the winners and shares for each night. The contract
  checks that each winner is a ticket of that night, that none repeats and that the shares add
  up to 100%, but not that they follow the scoring rules. So the resolver can pay a night's whole
  pot to any of that night's tickets, including one it bought itself. The bot computes the winners
  from the public Squeekchain data with `src/logic.js`, and anyone can recompute them. This trust
  is accepted for a testnet game.
- **Owner:** can change the resolver (at once, so it can also make itself resolver), the ticket
  price (for nights with no tickets yet), and offer the owner role to another address. It can't
  take, move or lock players' funds in any other way.
- **Nobody**, the owner and resolver included, can withdraw the pot: every wei paid in goes to
  that night's tickets (settled), back to its buyer (voided or timed out), or stays claimable in `owed`.
- The constructor only allows Sepolia (11155111) and a local test chain (31337).
- Picks are public. One person can use several wallets to get past the 5-ticket limit.

## Edges the tests pin

1. **Funds can't be lost, locked or taken.** After any settle, void or refund, the contract
   holds exactly what it owes; a fuzz over 2 to 12 tickets and any split leaves zero.
2. **No double payouts or refunds.** Refunding twice, refunding a settled night, settling or
   voiding a closed night, voiding after the timeout with some tickets already refunded.
3. **Timing edges:** buying and changing picks at the last second and at the lock instant;
   settling at `endTime - 1`, at `endTime + 3 days - 1` and at `endTime + 3 days`; refunding at
   `endTime + 3 days - 1` and `endTime + 3 days`.
4. **Reentrancy and griefing:** winners that refuse, burn all their gas, re-enter
   `withdrawOwed` or return a large blob; a refund that re-enters `refund`.
5. **Arithmetic:** shares and rounding dust to the first winner, up to 10 winners.
6. **Roles:** only the owner and the resolver can do their parts; the two-step owner handover.
