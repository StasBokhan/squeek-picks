// Tests for the pot contract (contracts/SqueekPot.sol, version 3), including every edge
// the IMD swarm audit of version 2 looked at. Run them with:
//   cd contracts  &&  npm ci  &&  npm test
// They deploy SqueekPot.json (the compiled contract the page and the bot use) on
// hardhat's built-in chain, and first check that file matches the source.
const { ethers, network } = require("hardhat");
const assert = require("assert");
const solc = require("solc");
const { compile } = require("../compile.cjs");
const art = require("../SqueekPot.json");

const DAY = 86400;
const HOUR = 3600;
const PRICE = ethers.parseEther("0.01");
const NIGHT = Math.floor(Date.UTC(2026, 10, 1) / 1000 / DAY); // the night of 2026-11-01

// Wallet contracts that receive ETH in awkward ways.
const HELPERS = `
pragma solidity 0.8.24;
interface IPot {
  function buyTicket(uint32, uint16, uint8, bool) external payable;
  function refund(uint32) external;
  function refundTo(uint32, address) external;
  function withdrawOwed() external;
  function withdrawOwedTo(address) external;
}
// receive() modes: 0 accept, 1 refuse, 2 burn all gas, 3 re-enter refund, 4 re-enter withdrawOwed.
contract Player {
  IPot public pot; uint8 public mode; uint32 public night;
  constructor(address p) { pot = IPot(p); }
  function setMode(uint8 m, uint32 n) external { mode = m; night = n; }
  function buy(uint32 n, uint16 d, uint8 b, bool m) external payable { pot.buyTicket{value: msg.value}(n, d, b, m); }
  function doRefund(uint32 n) external { pot.refund(n); }
  function doRefundTo(uint32 n, address to) external { pot.refundTo(n, to); }
  function doWithdraw() external { pot.withdrawOwed(); }
  function doWithdrawTo(address to) external { pot.withdrawOwedTo(to); }
  receive() external payable {
    uint8 m = mode;
    if (m == 1) revert("no thanks");
    if (m == 2) { while (true) {} }
    if (m == 3) { mode = 0; pot.refund(night); }
    if (m == 4) pot.withdrawOwed();
  }
}
// Accepts a payout and returns a 96,000-byte blob, all within the payout gas.
contract Bomb {
  function buy(address pot, uint32 n) external payable { IPot(pot).buyTicket{value: msg.value}(n, 90, 3, true); }
  receive() external payable { assembly { return(0, 96000) } }
}
contract Refuser {
  function buy(address pot, uint32 n) external payable { IPot(pot).buyTicket{value: msg.value}(n, 90, 3, true); }
  receive() external payable { revert(); }
}`;
const built = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "Helpers.sol": { content: HELPERS } },
  settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
}))).contracts["Helpers.sol"];

const lockOf = (n) => n * DAY + 12 * HOUR;
const endOf = (n) => lockOf(n) + DAY;
const bal = async (x) => ethers.provider.getBalance(typeof x === "string" ? x : await x.getAddress());
const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
// Mines an empty block at time t: the next transaction lands one second later.
async function setTime(t) { await network.provider.send("evm_setNextBlockTimestamp", [t]); await network.provider.send("evm_mine"); }
// The next transaction lands at exactly time t.
async function nextAt(t) { await network.provider.send("evm_setNextBlockTimestamp", [t]); }
async function reverts(p, text) {
  try { await p; } catch (e) {
    let msg = String(e.shortMessage || e.message);
    const data = (msg.match(/return data: (0x[0-9a-f]+)/) || [])[1] || (e.data && typeof e.data === "string" ? e.data : null);
    if (data) { try { const err = new ethers.Interface(art.abi).parseError(data); if (err) msg += " " + err.name; } catch {} }
    if (text && !msg.includes(text)) throw new Error(`expected revert "${text}", got: ${msg}`);
    return;
  }
  throw new Error(`expected a revert${text ? ` "${text}"` : ""}, but it went through`);
}
async function deployHelper(name, ...args) {
  const [owner] = await ethers.getSigners();
  const F = new ethers.ContractFactory(built[name].abi, "0x" + built[name].evm.bytecode.object, owner);
  const c = await F.deploy(...args); await c.waitForDeployment(); return c;
}
async function gasOf(p) { return (await (await p).wait()).gasUsed; }
async function feeOf(p) { const r = await (await p).wait(); return r.gasUsed * r.gasPrice; }
function eventsOf(receipt, contract, name) {
  return receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).filter((x) => x && x.name === name);
}

describe("SqueekPot.json", function () {
  it("is what SqueekPot.sol compiles to", function () {
    const { artifact } = compile();
    assert.equal(artifact.bytecode, art.bytecode, "SqueekPot.json is out of date: run npm run compile");
    assert.deepEqual(artifact.abi, art.abi);
  });
});

describe("SqueekPot version 3", function () {
  let pot, potAddr, owner, bot, a, b, c, d, safe, night;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, bot, a, b, c, d, safe] = await ethers.getSigners();
    pot = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(PRICE, bot.address);
    potAddr = await pot.getAddress();
    night = NIGHT;
    await setTime(lockOf(night - 1) + HOUR); // tickets for NIGHT are on sale
    assert.equal(Number(await pot.openNight()), night);
  });

  it("starts with the deployer as owner and the given bot as payout wallet", async function () {
    assert.equal(Number(await pot.VERSION()), 3);
    assert.equal(await pot.owner(), owner.address);
    assert.equal(await pot.resolver(), bot.address);
    assert.equal(await pot.pendingOwner(), ethers.ZeroAddress);
    const p2 = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(PRICE, ethers.ZeroAddress);
    assert.equal(await p2.resolver(), owner.address);
    await reverts(new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(0, bot.address), "bad price");
  });

  it("works from time zero on a fresh chain (audit finding 6)", async function () {
    await network.provider.send("hardhat_reset");
    const fresh = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(PRICE, bot.address);
    assert.ok((await now()) < 12 * HOUR, "the test chain should start at 1970-01-01");
    assert.equal(Number(await fresh.openNight()), 0);
    await fresh.connect(a).buyTicket(0, 90, 3, true, { value: PRICE });
    await setTime(12 * HOUR - 1);
    assert.equal(Number(await fresh.openNight()), 0, "night 0 is on sale until 12:00 UTC");
    await setTime(12 * HOUR);
    assert.equal(Number(await fresh.openNight()), 1);
    await reverts(fresh.connect(b).buyTicket(0, 90, 3, true, { value: PRICE }), "night not open");
  });

  it("only lets the owner and the payout bot do their parts", async function () {
    await reverts(pot.connect(a).setResolver(a.address), "NotOwner");
    await reverts(pot.connect(bot).setTicketPrice(1n), "NotOwner");
    await reverts(pot.connect(bot).offerOwner(bot.address), "NotOwner");
    await reverts(pot.setResolver(ethers.ZeroAddress), "zero address");
    await reverts(pot.setTicketPrice(0), "bad price");
    await pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE });
    await setTime(endOf(night));
    await reverts(pot.connect(owner).settle(night, [0], [10000]), "NotResolver");
    await reverts(pot.connect(a).voidNight(night), "NotResolver");
  });

  it("sells up to 5 tickets per wallet, each with its own picks", async function () {
    await reverts(pot.connect(a).buyTicket(night + 1, 94, 3, true, { value: PRICE }), "night not open");
    await reverts(pot.connect(a).buyTicket(night - 1, 94, 3, true, { value: PRICE }), "night not open");
    await reverts(pot.connect(a).buyTicket(night, 94, 3, true, { value: PRICE - 1n }), "wrong ticket price");
    await reverts(pot.connect(a).buyTicket(night, 94, 3, true, { value: PRICE + 1n }), "wrong ticket price");
    await reverts(pot.connect(a).buyTicket(night, 601, 3, true, { value: PRICE }), "distance out of range");
    await reverts(pot.connect(a).buyTicket(night, 94, 8, true, { value: PRICE }), "peak window out of range");
    for (let i = 0; i < 5; i++) await pot.connect(a).buyTicket(night, 90 + i, i, i % 2 === 0, { value: PRICE });
    await reverts(pot.connect(a).buyTicket(night, 50, 2, false, { value: PRICE }), "ticket limit reached");
    await pot.connect(b).buyTicket(night, 600, 7, false, { value: PRICE });
    const n = await pot.getNight(night);
    assert.equal(n.pot, PRICE * 6n);
    assert.deepEqual(n.tickets.map((t) => t.player), [a, a, a, a, a, b].map((s) => s.address));
    assert.deepEqual(n.tickets.map((t) => Number(t.distanceDeci)), [90, 91, 92, 93, 94, 600]);
    assert.deepEqual(n.tickets.map((t) => Number(t.peakBlock)), [0, 1, 2, 3, 4, 7]);
    assert.deepEqual((await pot.ticketsOf(night, a.address)).map(Number), [0, 1, 2, 3, 4]);
    assert.deepEqual((await pot.ticketsOf(night, b.address)).map(Number), [5]);
    assert.equal(await bal(potAddr), PRICE * 6n);
  });

  it("lets a player change only their own tickets, until the instant the night starts", async function () {
    await pot.connect(a).buyTicket(night, 94, 3, true, { value: PRICE });
    await pot.connect(a).buyTicket(night, 80, 2, false, { value: PRICE });
    await pot.connect(b).buyTicket(night, 70, 1, true, { value: PRICE });
    await reverts(pot.connect(a).changePicks(night, 2, 50, 1, true), "not your ticket");
    await reverts(pot.connect(a).changePicks(night, 3, 50, 1, true), "no such ticket");
    await reverts(pot.connect(a).changePicks(night, 1, 601, 1, true), "distance out of range");
    const before = (await pot.getNight(night)).tickets[1].boughtAt;
    await nextAt(lockOf(night) - 2);
    await pot.connect(a).changePicks(night, 1, 120, 4, true);
    await nextAt(lockOf(night) - 1);
    await pot.connect(c).buyTicket(night, 60, 0, false, { value: PRICE }); // last second: still on sale
    const n = await pot.getNight(night);
    assert.deepEqual([Number(n.tickets[0].distanceDeci), Number(n.tickets[1].distanceDeci), Number(n.tickets[1].peakBlock)], [94, 120, 4]);
    assert.equal(n.tickets[1].boughtAt, before, "changing picks keeps the ticket's place in the tie-break order");
    await nextAt(lockOf(night));
    await reverts(pot.connect(a).changePicks(night, 0, 50, 1, true), "night not open");
    await reverts(pot.connect(d).buyTicket(night, 50, 1, true, { value: PRICE }), "night not open");
  });

  it("pays winning tickets by number, so one wallet can win two places", async function () {
    await pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE });   // 0
    await pot.connect(a).buyTicket(night, 91, 3, true, { value: PRICE });   // 1
    await pot.connect(b).buyTicket(night, 92, 3, true, { value: PRICE });   // 2
    await pot.connect(c).buyTicket(night, 93, 3, true, { value: PRICE });   // 3
    await setTime(endOf(night));
    await reverts(pot.connect(bot).settle(night, [0, 9], [5000, 5000]), "no such ticket");
    await reverts(pot.connect(bot).settle(night, [0, 0], [5000, 5000]), "duplicate winner");
    await reverts(pot.connect(bot).settle(night, [0, 1], [5000, 3000]), "shares must total 100%");
    await reverts(pot.connect(bot).settle(night, [0, 1], [5000]), "bad winners");
    await reverts(pot.connect(bot).settle(night, [], []), "bad winners");
    const before = await Promise.all([a, b, c].map(bal));
    const r = await (await pot.connect(bot).settle(night, [0, 1, 2], [5000, 3000, 2000])).wait();
    const after = await Promise.all([a, b, c].map(bal));
    const total = PRICE * 4n;
    assert.equal(after[0] - before[0], total * 8000n / 10000n);
    assert.equal(after[1] - before[1], total * 2000n / 10000n);
    assert.equal(after[2] - before[2], 0n);
    assert.equal(await bal(potAddr), 0n);
    const [ev] = eventsOf(r, pot, "NightSettled");
    assert.deepEqual(ev.args.tickets.map(Number), [0, 1, 2]);
    assert.deepEqual(Array.from(ev.args.winners), [a.address, a.address, b.address]);
  });

  it("refunds all of a wallet's tickets on a voided night in one go, once", async function () {
    for (let i = 0; i < 3; i++) await pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE });
    await pot.connect(b).buyTicket(night, 90, 3, true, { value: PRICE });
    await nextAt(endOf(night) - 1);
    await reverts(pot.connect(bot).voidNight(night), "night not over");
    await setTime(endOf(night));
    await reverts(pot.connect(a).refund(night), "not refundable");
    await pot.connect(bot).voidNight(night);
    const before = await bal(a);
    const fee = await feeOf(pot.connect(a).refund(night));
    assert.equal(await bal(a) - before + fee, PRICE * 3n);
    await reverts(pot.connect(a).refund(night), "nothing to refund");
    await reverts(pot.connect(c).refund(night), "nothing to refund");
    await pot.connect(b).refund(night);
    assert.equal(await bal(potAddr), 0n);
    assert.ok((await pot.getNight(night)).tickets.every((t) => t.refunded));
  });

  it("settles until 3 days after the night ends, and from then on only refunds", async function () {
    const n1 = night, n2 = night + 1;
    await pot.connect(a).buyTicket(n1, 90, 3, true, { value: PRICE });
    await pot.connect(b).buyTicket(n1, 80, 3, true, { value: PRICE });
    await setTime(lockOf(n1) + HOUR);
    await pot.connect(a).buyTicket(n2, 90, 3, true, { value: PRICE });
    await pot.connect(b).buyTicket(n2, 80, 3, true, { value: PRICE });

    await nextAt(endOf(n1) - 1);
    await reverts(pot.connect(bot).settle(n1, [0], [10000]), "night not over");
    await nextAt(endOf(n1) + 3 * DAY - 2);
    await reverts(pot.connect(a).refund(n1), "not refundable");
    await nextAt(endOf(n1) + 3 * DAY - 1);
    await pot.connect(bot).settle(n1, [0, 1], [6250, 3750]);              // last second to pay out
    await reverts(pot.connect(a).refund(n1), "not refundable");
    await reverts(pot.connect(bot).voidNight(n1), "already closed");

    await nextAt(endOf(n2) + 3 * DAY - 1);
    await reverts(pot.connect(a).refund(n2), "not refundable");
    await nextAt(endOf(n2) + 3 * DAY);
    await reverts(pot.connect(bot).settle(n2, [0], [10000]), "refund window open");
    await pot.connect(a).refund(n2);                                        // first second of refunds
    await pot.connect(b).refund(n2);
    await reverts(pot.connect(bot).settle(n2, [0], [10000]), "refund window open");
    assert.equal(await bal(potAddr), 0n);
  });

  it("never closes a night twice", async function () {
    const n1 = night, n2 = night + 1;
    await pot.connect(a).buyTicket(n1, 90, 3, true, { value: PRICE });
    await pot.connect(b).buyTicket(n1, 80, 3, true, { value: PRICE });
    await setTime(lockOf(n1) + HOUR);
    await pot.connect(a).buyTicket(n2, 90, 3, true, { value: PRICE });
    await pot.connect(b).buyTicket(n2, 80, 3, true, { value: PRICE });
    await setTime(endOf(n2));
    await pot.connect(bot).settle(n1, [1], [10000]);
    await reverts(pot.connect(bot).settle(n1, [0], [10000]), "already closed");
    await reverts(pot.connect(bot).voidNight(n1), "already closed");
    await pot.connect(bot).voidNight(n2);
    await reverts(pot.connect(bot).voidNight(n2), "already closed");
    await reverts(pot.connect(bot).settle(n2, [0], [10000]), "already closed");
    await pot.connect(a).refund(n2);
    await reverts(pot.connect(a).refund(n2), "nothing to refund");
    await pot.connect(b).refund(n2);
    assert.equal(await bal(potAddr), 0n);
  });

  it("voiding after the timeout, with some tickets already refunded, refunds the rest exactly once", async function () {
    await pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE });
    await pot.connect(b).buyTicket(night, 80, 3, true, { value: PRICE });
    await pot.connect(b).buyTicket(night, 70, 3, true, { value: PRICE });
    await pot.connect(c).buyTicket(night, 60, 3, true, { value: PRICE });
    await setTime(endOf(night) + 3 * DAY);
    await pot.connect(a).refund(night);
    await pot.connect(bot).voidNight(night);
    await reverts(pot.connect(a).refund(night), "nothing to refund");
    const before = await bal(b);
    const fee = await feeOf(pot.connect(b).refund(night));
    assert.equal(await bal(b) - before + fee, PRICE * 2n);
    await pot.connect(c).refund(night);
    assert.equal(await bal(potAddr), 0n);
    await reverts(pot.connect(bot).settle(night, [0], [10000]), "already closed");
  });

  it("keeps payouts that winners can't take in owed: refusing, gas-burning and re-entering winners", async function () {
    const refuser = await deployHelper("Player", potAddr), burner = await deployHelper("Player", potAddr), reenter = await deployHelper("Player", potAddr);
    await refuser.setMode(1, night); await burner.setMode(2, night); await reenter.setMode(4, night);
    for (const p of [refuser, burner, reenter]) await p.buy(night, 90, 3, true, { value: PRICE });
    await pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE });
    await setTime(endOf(night));
    const before = await bal(a);
    const r = await (await pot.connect(bot).settle(night, [0, 1, 2, 3], [4000, 3000, 2000, 1000])).wait();
    const total = PRICE * 4n;
    const expect = [4000n, 3000n, 2000n].map((x) => total * x / 10000n);
    const owed = await Promise.all([refuser, burner, reenter].map(async (p) => pot.owed(await p.getAddress())));
    assert.deepEqual(owed, expect);
    assert.equal(await bal(a) - before, total * 1000n / 10000n);
    assert.equal(eventsOf(r, pot, "PaymentOwed").length, 3);
    assert.equal(await bal(potAddr), owed.reduce((x, y) => x + y, 0n), "the pot holds exactly what it owes");
    assert.ok(r.gasUsed < 1_000_000n, "a gas-burning winner can't make the payout expensive");
    for (const p of [refuser, burner, reenter]) {
      await p.setMode(0, night);
      await p.doWithdraw();
      await reverts(p.doWithdraw(), "nothing owed");
    }
    assert.equal(await bal(potAddr), 0n);
  });

  it("lets a wallet contract that can't take plain ETH send its refund and payout elsewhere (audit finding 1)", async function () {
    const n1 = night, n2 = night + 1;
    const w = await deployHelper("Player", potAddr);
    const wAddr = await w.getAddress();
    await w.setMode(1, 0); // refuses plain ETH
    await w.buy(n1, 90, 3, true, { value: PRICE });
    await w.buy(n1, 91, 3, true, { value: PRICE });
    await setTime(lockOf(n1) + HOUR);
    await w.buy(n2, 90, 3, true, { value: PRICE });
    await pot.connect(a).buyTicket(n2, 50, 3, true, { value: PRICE });
    await setTime(endOf(n2));

    // A voided night: refund() can't reach it, refundTo() can.
    await pot.connect(bot).voidNight(n1);
    await reverts(w.doRefund(n1), "send failed");
    await reverts(w.doRefundTo(n1, ethers.ZeroAddress), "zero address");
    let before = await bal(safe);
    let r = await (await w.doRefundTo(n1, safe.address)).wait();
    assert.equal(await bal(safe) - before, PRICE * 2n);
    const [refunded] = eventsOf(r, pot, "Refunded"), [sent] = eventsOf(r, pot, "SentTo");
    assert.equal(refunded.args.player, wAddr);
    assert.deepEqual([sent.args.from, sent.args.to, sent.args.amount], [wAddr, safe.address, PRICE * 2n]);
    await reverts(w.doRefundTo(n1, safe.address), "nothing to refund");

    // A win: the payout goes to owed, withdrawOwed() can't reach it, withdrawOwedTo() can.
    await pot.connect(bot).settle(n2, [0, 1], [6250, 3750]);
    const owedAmt = await pot.owed(wAddr);
    assert.equal(owedAmt, PRICE * 2n * 6250n / 10000n);
    await reverts(w.doWithdraw(), "send failed");
    await reverts(w.doWithdrawTo(ethers.ZeroAddress), "zero address");
    before = await bal(safe);
    await w.doWithdrawTo(safe.address);
    assert.equal(await bal(safe) - before, owedAmt);
    assert.equal(await pot.owed(wAddr), 0n);
    await reverts(w.doWithdrawTo(safe.address), "nothing owed");
    assert.equal(await bal(potAddr), 0n);
  });

  it("only refunds the caller's own tickets, wherever the money is sent", async function () {
    await pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE });
    await pot.connect(b).buyTicket(night, 80, 3, true, { value: PRICE });
    await setTime(endOf(night));
    await pot.connect(bot).voidNight(night);
    await reverts(pot.connect(c).refundTo(night, c.address), "nothing to refund");
    const before = await bal(safe);
    await pot.connect(a).refundTo(night, safe.address);
    assert.equal(await bal(safe) - before, PRICE);
    await reverts(pot.connect(a).refund(night), "nothing to refund");
    await pot.connect(b).refund(night);
    assert.equal(await bal(potAddr), 0n);
  });

  it("blocks a refund that tries to re-enter itself", async function () {
    const p = await deployHelper("Player", potAddr);
    await p.buy(night, 90, 3, true, { value: PRICE });
    await p.buy(night, 91, 3, true, { value: PRICE });
    await pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE });
    await setTime(endOf(night));
    await pot.connect(bot).voidNight(night);
    await p.setMode(3, night);
    await reverts(p.doRefund(night), "send failed");
    assert.equal(await bal(potAddr), PRICE * 3n);
    await p.setMode(0, night);
    await p.doRefund(night);
    assert.equal(await bal(await p.getAddress()), PRICE * 2n);
  });

  it("a winner that returns a huge blob can't make payouts expensive (audit finding 2)", async function () {
    // Version 2 for comparison: it copies the winner's return data.
    const v2 = compile("SqueekPotV2.sol").artifact;
    async function run(artifact, kind) {
      await network.provider.send("hardhat_reset");
      const p = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner).deploy(PRICE, bot.address);
      await setTime(lockOf(night - 1) + HOUR);
      for (let i = 0; i < 10; i++) await (await deployHelper(kind)).buy(await p.getAddress(), night, { value: PRICE });
      await setTime(endOf(night));
      return gasOf(p.connect(bot).settle(night, [...Array(10).keys()], new Array(10).fill(1000)));
    }
    const [v2Bomb, v2Refuse, v3Bomb, v3Refuse] = [await run(v2, "Bomb"), await run(v2, "Refuser"), await run(art, "Bomb"), await run(art, "Refuser")];
    assert.ok(v2Bomb > v2Refuse * 4n, `version 2 should show the problem: ${v2Bomb} vs ${v2Refuse}`);
    // Version 3: about the same as winners that refuse (each winner can still use its payout gas).
    assert.ok(v3Bomb * 10n < v3Refuse * 12n, `version 3: ${v3Bomb} gas with blob-returning winners, ${v3Refuse} with refusing ones`);
    assert.ok(v3Bomb < 600_000n, `version 3 paid 10 blob-returning winners for ${v3Bomb} gas`);
  });

  it("hands the owner role over only when the new owner accepts (audit finding 3)", async function () {
    const typo = "0x000000000000000000000000000000000000dEaD";
    let r = await (await pot.offerOwner(typo)).wait();
    assert.equal(eventsOf(r, pot, "OwnerOffered")[0].args.next, typo);
    assert.equal(await pot.owner(), owner.address, "an offer alone changes nothing");
    await pot.setResolver(c.address);                    // still the owner
    await pot.offerOwner(a.address);                     // a new offer replaces the old one
    await reverts(pot.connect(b).acceptOwner(), "not offered to you");
    await pot.offerOwner(ethers.ZeroAddress);            // withdraws the offer
    await reverts(pot.connect(a).acceptOwner(), "not offered to you");
    await pot.offerOwner(a.address);
    r = await (await pot.connect(a).acceptOwner()).wait();
    assert.equal(eventsOf(r, pot, "OwnerChanged")[0].args.owner, a.address);
    assert.equal(await pot.owner(), a.address);
    assert.equal(await pot.pendingOwner(), ethers.ZeroAddress);
    await reverts(pot.connect(a).acceptOwner(), "not offered to you");
    await reverts(pot.setResolver(owner.address), "NotOwner");
    await pot.connect(a).setResolver(bot.address);
  });

  it("fixes a night's price at its first ticket", async function () {
    assert.equal((await pot.getNight(night)).price, PRICE);
    await pot.setTicketPrice(PRICE * 2n);                // before the first ticket: applies
    await reverts(pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE }), "wrong ticket price");
    await pot.connect(a).buyTicket(night, 90, 3, true, { value: PRICE * 2n });
    await pot.setTicketPrice(PRICE * 5n);                // after it: only for later nights
    await pot.connect(b).buyTicket(night, 80, 3, true, { value: PRICE * 2n });
    const n = await pot.getNight(night);
    assert.deepEqual([n.price, n.pot], [PRICE * 2n, PRICE * 4n]);
    assert.equal((await pot.getNight(night + 1)).price, PRICE * 5n);
  });

  it("caps winners at 10 and gives rounding dust to the first", async function () {
    const players = (await ethers.getSigners()).slice(2, 5);
    for (const p of players) for (let i = 0; i < 4; i++) await pot.connect(p).buyTicket(night, 90, 3, true, { value: PRICE });
    await setTime(endOf(night));
    const eleven = [...Array(11).keys()];
    const bps = new Array(11).fill(909); bps[0] += 10000 - 909 * 11;
    await reverts(pot.connect(bot).settle(night, eleven, bps), "bad winners");
    const r = await (await pot.connect(bot).settle(night, [0, 5, 9], [3334, 3333, 3333])).wait();
    const [ev] = eventsOf(r, pot, "NightSettled");
    const total = PRICE * 12n, share = total * 3333n / 10000n;
    assert.deepEqual(ev.args.amounts, [total - 2n * share, share, share]);
    assert.equal(await bal(potAddr), 0n);
  });

  it("leaves nothing behind, whatever the number of tickets and the split", async function () {
    let seed = 20261031;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const signers = (await ethers.getSigners()).slice(2, 12);
    for (let round = 0; round < 12; round++) {
      const count = 2 + rand(11), holders = signers.slice(0, Math.min(count, signers.length));
      await setTime(lockOf(night) - 2 * HOUR);
      for (let i = 0; i < count; i++) {
        await pot.connect(signers[i % signers.length]).buyTicket(night, rand(601), rand(8), rand(2) === 1, { value: PRICE });
      }
      const k = 1 + rand(Math.min(count, 10));
      const winners = [...Array(count).keys()].sort(() => rand(3) - 1).slice(0, k);
      const bps = winners.map(() => 1 + rand(2000));
      const sum = bps.reduce((x, y) => x + y, 0);
      const scaled = bps.map((x) => Math.floor((x * 10000) / sum));
      scaled[0] += 10000 - scaled.reduce((x, y) => x + y, 0);
      if (scaled.some((x) => x === 0)) { scaled.fill(0); scaled[0] = 10000; }
      await setTime(endOf(night));
      const before = await Promise.all(holders.map(bal));
      const r = await (await pot.connect(bot).settle(night, winners, scaled)).wait();
      const after = await Promise.all(holders.map(bal));
      const gained = after.reduce((x, v, i) => x + v - before[i], 0n);
      const [ev] = eventsOf(r, pot, "NightSettled");
      assert.equal(ev.args.amounts.reduce((x, y) => x + y, 0n), PRICE * BigInt(count), `round ${round}: amounts add up to the pot`);
      assert.equal(gained, PRICE * BigInt(count), `round ${round}: winners got the whole pot`);
      assert.equal(await bal(potAddr), 0n, `round ${round}: nothing left in the contract`);
      night += 2; // the next night still on sale
    }
  });
});
