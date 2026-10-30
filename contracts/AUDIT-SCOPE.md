# Audit scope: Squeek Picks nightly pot

**In scope:** `contracts/SqueekPot.sol` (version 2, Solidity 0.8.24), deployed on Sepolia at
`0x845AC45012405B8Fa1Ff017320304b665b915F86`.
**Lower priority:** `contracts/SqueekPotV1.sol`, the earlier version (one ticket per wallet,
winners paid by address). It still pays out its last nights.
**Out of scope:** the web page (`src/app.html`), the payout bot (`settler/settle.mjs`) and
the scoring rules (`src/logic.js`), except where they explain what the contract expects.

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
  10,000. Rounding dust goes to the first winner. A payout that fails to send (30,000 gas
  stipend) is kept in `owed` for the winner to collect with `withdrawOwed`.
- **Voiding:** after the night ends, the resolver can void it instead (no result, or fewer
  than 2 tickets). Every ticket can then be refunded.
- **Timeout:** if a night isn't settled within 3 days of ending, every ticket can be refunded,
  without anyone voiding it.
- **Refunds:** `refund(night)` pays back all of the caller's not-yet-refunded tickets for that
  night at the night's price.

## Roles and trust assumptions (known and accepted)

- **Resolver** (the payout bot): decides the winners and shares for each night. The contract
  does not check that they follow the scoring rules; the bot computes them from the public
  Squeekchain data with `src/logic.js`, and anyone can recompute them. This trust is
  accepted for a testnet game.
- **Owner:** can change the resolver, the ticket price (for nights with no tickets yet) and
  the owner. Must not be able to take, move or lock players' funds in any other way.
- **Nobody**, the owner and resolver included, should be able to withdraw the pot.
- The constructor only allows Sepolia (11155111) and a local test chain (31337).
- Picks are public. One person can use several wallets to get past the 5-ticket limit.

## Please check in particular

1. **Funds can't be lost, locked or taken.** Every wei paid in either goes to winners
   (settled), back to its buyer (voided or timed out), or stays claimable in `owed`.
2. **No double payouts or refunds.** Refunding twice, refunding a settled night, or settling
   a night that is voided, timed out or being refunded.
3. **Timing edges:** buying or changing picks at the lock instant, settling at exactly
   `endTime + 3 days`, voiding after the timeout while some tickets are already refunded.
4. **Reentrancy and griefing:** in `refund`, `withdrawOwed` and `settle` (a winner that
   reverts, burns gas or reenters).
5. **Arithmetic:** `uint128` pot and price, the share maths and the dust.
6. Anything the owner or resolver can do beyond what's described above.
