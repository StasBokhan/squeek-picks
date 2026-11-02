// Tests for the Night Cards collectibles (contracts/SqueekNightCards.sol).
//   cd contracts  &&  npm ci  &&  npm test
const { ethers, network } = require("hardhat");
const assert = require("assert");
const { compile } = require("../compile.cjs");
const art = require("../SqueekNightCards.json");
const diary = require("../../data/diary.json").nights;

const NIGHT = "2026-10-29";
const day = (night) => Math.round(Date.parse(night + "T00:00:00Z") / 86400e3);
// His real run that night: 48 half hours of spins, 2 bytes each, the way the minting bot sends it.
const slotsOf = (night) => diary[night].slots.map((x) => Number(x || 0));
const spinsOf = (night) => "0x" + slotsOf(night).map((v) => v.toString(16).padStart(4, "0")).join("");
const commas = (n) => n.toLocaleString("en-US");
const key = (night, player) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint32", "string"], [day(night), player]));
async function reverts(p, text) {
  try { await p; } catch (e) {
    let msg = String(e.shortMessage || e.message);
    const data = (msg.match(/return data: (0x[0-9a-f]+)/) || [])[1];
    if (data) { try { const err = new ethers.Interface(art.abi).parseError(data); if (err) msg += " " + err.name; } catch {} }
    if (text && !msg.includes(text)) throw new Error(`expected revert "${text}", got: ${msg}`);
    return;
  }
  throw new Error(`expected a revert${text ? ` "${text}"` : ""}, but it went through`);
}
function decode(uri) {
  assert.ok(uri.startsWith("data:application/json;base64,"));
  const meta = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
  assert.ok(meta.image.startsWith("data:image/svg+xml;base64,"));
  meta.svg = Buffer.from(meta.image.split(",")[1], "base64").toString("utf8");
  return meta;
}

describe("SqueekNightCards.json", function () {
  it("is what SqueekNightCards.sol compiles to", function () {
    const { artifact, size } = compile("SqueekNightCards.sol", "SqueekNightCards");
    assert.equal(artifact.bytecode, art.bytecode, "SqueekNightCards.json is out of date: run npm run compile");
    assert.ok(size < 24576, `deployed size ${size} is over the 24 KB limit`);
  });
});

describe("Night Cards", function () {
  let cards, owner, bot, a, b, c;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, bot, a, b, c] = await ethers.getSigners();
    cards = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(bot.address);
    await cards.waitForDeployment();
  });

  it("starts with the deployer as owner and the bot as minter", async function () {
    assert.equal(await cards.owner(), owner.address);
    assert.equal(await cards.minter(), bot.address);
    assert.equal(await cards.name(), "Squeek Picks Night Cards");
    assert.equal(await cards.symbol(), "SQNIGHT");
    const c2 = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(ethers.ZeroAddress);
    assert.equal(await c2.minter(), owner.address);
  });

  it("records a night once, only from the minter, and checks it", async function () {
    const sp = spinsOf(NIGHT);
    assert.equal((sp.length - 2) / 2, 96);
    await reverts(cards.connect(a).recordNight(day(NIGHT), sp, 117, 3, 1141, 1), "NotMinter");
    await reverts(cards.connect(bot).recordNight(day(NIGHT), "0x" + "00".repeat(48), 117, 3, 1141, 1), "48 half hours");   // the old one-byte-a-spoke format
    await reverts(cards.connect(bot).recordNight(day(NIGHT), sp, 117, 8, 1141, 1), "bad peak window");
    await reverts(cards.connect(bot).recordNight(day(NIGHT), sp, 117, 3, 1141, 3), "bad blocks call");
    await cards.connect(bot).recordNight(day(NIGHT), sp, 117, 3, 1141, 1);
    await reverts(cards.connect(bot).recordNight(day(NIGHT), sp, 50, 2, 1, 0), "night already recorded");
    const r = await cards.run(day(NIGHT));
    assert.deepEqual([r.set, Number(r.kmDeci), Number(r.peak), Number(r.blocks), Number(r.moreBlocks), r.spins], [true, 117, 3, 1141, 1, sp]);
    await cards.connect(bot).recordNight(day("2026-10-30"), spinsOf("2026-10-30"), 110, 255, 1069, 0);   // a night with no peak is allowed
  });

  it("mints each player's card for a night once, only from the minter", async function () {
    await reverts(cards.connect(bot).mint(a.address, day(NIGHT), 0, 40, key(NIGHT, "p1")), "night not recorded");
    await cards.connect(bot).recordNight(day(NIGHT), spinsOf(NIGHT), 117, 3, 1141, 1);
    await reverts(cards.connect(a).mint(a.address, day(NIGHT), 0, 40, key(NIGHT, "p1")), "NotMinter");
    await reverts(cards.connect(bot).mint(a.address, day(NIGHT), 5, 40, key(NIGHT, "p1")), "bad kind");
    await reverts(cards.connect(bot).mint(ethers.ZeroAddress, day(NIGHT), 0, 40, key(NIGHT, "p1")), "zero address");
    await reverts(cards.connect(bot).mint(a.address, day(NIGHT), 0, 40, ethers.ZeroHash), "already minted");
    await cards.connect(bot).mint(a.address, day(NIGHT), 1, 52, key(NIGHT, "p1"));
    await cards.connect(bot).mint(b.address, day(NIGHT), 4, 214, key(NIGHT, "p2"));
    await reverts(cards.connect(bot).mint(c.address, day(NIGHT), 0, 40, key(NIGHT, "p1")), "already minted");
    assert.equal(Number(await cards.totalMinted()), 2);
    assert.equal(Number(await cards.cardFor(key(NIGHT, "p1"))), 1);
    assert.deepEqual((await cards.cardsOf(a.address)).map(Number), [1]);
    const c1 = await cards.card(1), c2 = await cards.card(2);
    assert.deepEqual([Number(c1.night), Number(c1.kind), Number(c1.rarity), Number(c1.points)], [day(NIGHT), 1, 1, 52]);
    assert.deepEqual([Number(c2.kind), Number(c2.rarity)], [4, 3]);
    assert.deepEqual([0, 1, 2, 3, 4].map((k) => k), [0, 1, 2, 3, 4]);
    assert.deepEqual(await Promise.all([0, 1, 2, 3, 4].map(async (k) => Number(await cards.rarityOf(k)))), [0, 1, 2, 2, 3]);
  });

  it("prints the card on chain as a receipt of his real run", async function () {
    await cards.connect(bot).recordNight(day(NIGHT), spinsOf(NIGHT), 117, 3, 1141, 1);
    await cards.connect(bot).mint(a.address, day(NIGHT), 1, 52, key(NIGHT, "p1"));
    const meta = decode(await cards.tokenURI(1));
    const slots = slotsOf(NIGHT), total = slots.reduce((x, y) => x + y, 0);
    const hours = [...Array(24)].map((_, h) => slots[2 * h] + slots[2 * h + 1]);
    assert.equal(meta.name, "Night Card 2026-10-29: Bullseye");
    const attrs = Object.fromEntries(meta.attributes.map((x) => [x.trait_type, x.value]));
    assert.deepEqual(attrs, { Rarity: "Rare", "Earned for": "Bullseye", Night: "2026-10-29", Distance: "11.7 km", "Total spins": total, Points: 52 });
    const svg = meta.svg;
    for (const t of ["SQUEEK WHEEL CO.", "NIGHT SHIFT RECEIPT", "THU 29 OCT 2026", "CASHIER: SQUEEKTOSHI", "CARD #1", "TOTAL SPINS", commas(total), "11.7 KM", "21:00–0:00", "1,141 MORE", "BULLSEYE", "+52 PTS", "THANK YOU"])
      assert.ok(svg.includes(t), `missing "${t}"`);
    // One line per hour from 12:00 to 11:00, each with that hour's spins; his busiest 3 hours marked.
    const times = [...svg.matchAll(/<text x="140" y="\d+" text-anchor="end"[^>]*>(\d+):00<\/text>/g)].map((m) => Number(m[1]));
    assert.deepEqual(times, [...Array(24)].map((_, h) => (12 + h) % 24));
    const values = [...svg.matchAll(/<text x="508" y="(\d+)" text-anchor="end"[^>]*>([\d,-]+)<\/text>/g)].filter((m) => Number(m[1]) < 630).map((m) => m[2]);
    assert.deepEqual(values, hours.map((v) => (v ? commas(v) : "-")));
    assert.equal((svg.match(/&gt;<\/text>/g) || []).length, 3, "three hours marked");
    assert.ok(svg.includes(`<text x="140" y="${273 + 9 * 15}" text-anchor="end" font-weight="700">21:00</text>`), "21:00 is in his busiest window");
    const bars = [...svg.matchAll(/<rect x="168" y="(\d+)" width="(\d+)"/g)].filter((m) => Number(m[1]) < 630).map((m) => Number(m[2]));
    assert.equal(bars.length, hours.filter(Boolean).length);
    assert.equal(Math.max(...bars), 230, "the busiest hour is the longest bar");
    // The stamp is the rarity, in blue for Rare; the hamster's in the logo.
    assert.ok(svg.includes('stroke="#2F5BD8"') && svg.includes(">RARE</text>") && svg.includes("· BULLSEYE ·"));
    assert.ok(svg.includes('<g id="hm">') && (svg.match(/href="#hm"/g) || []).length === 2, "the hamster in his wheel");
    assert.ok((svg.match(/<rect x="\d+" y="760"/g) || []).length > 40, "a barcode");
    require("fs").writeFileSync(require("path").join(__dirname, "..", "cache", "sample-card.svg"), svg);
    await reverts(cards.tokenURI(2));
  });

  it("stamps each rarity in its own ink, and every card's barcode differs", async function () {
    await cards.connect(bot).recordNight(day(NIGHT), spinsOf(NIGHT), 117, 3, 1141, 1);
    const want = [["COMMON", "#3A3D44", "CALLED IT"], ["RARE", "#2F5BD8", "BULLSEYE"], ["EPIC", "#7A3FD3", "LONE CALL"], ["EPIC", "#7A3FD3", "PERFECT NIGHT"], ["LEGENDARY", "#C28A12", "SEASON CHAMPION"]];
    const codes = new Set();
    for (let k = 0; k < 5; k++) {
      await cards.connect(bot).mint(a.address, day(NIGHT), k, 20 + k, key(NIGHT, "p" + k));
      const svg = decode(await cards.tokenURI(k + 1)).svg, [name, ink, kind] = want[k];
      assert.ok(svg.includes(`>${name}</text>`) && svg.includes(`stroke="${ink}"`) && svg.includes(`· ${kind} ·`) && svg.includes(`+${20 + k} PTS`), name + " " + kind);
      assert.ok(svg.includes(`textLength="${name.length * 26}"`), "the stamp's word fits its frame");
      codes.add((svg.match(/<rect x="\d+" y="760" width="\d+"/g) || []).join(""));
      require("fs").writeFileSync(require("path").join(__dirname, "..", "cache", `sample-card-${k}.svg`), svg);
    }
    assert.equal(codes.size, 5);
    // A night he didn't run still prints.
    await cards.connect(bot).recordNight(day("2026-10-30"), "0x" + "00".repeat(96), 0, 255, 0, 2);
    await cards.connect(bot).mint(b.address, day("2026-10-30"), 0, 20, key("2026-10-30", "p1"));
    const off = decode(await cards.tokenURI(6)).svg;
    assert.ok(off.includes("NIGHT OFF") && off.includes("0.0 KM") && !off.includes("&gt;") && !off.includes(" MORE") && !off.includes(" FEWER"));
  });

  it("reads cheaply enough for wallets and marketplaces", async function () {
    await cards.connect(bot).recordNight(day(NIGHT), spinsOf(NIGHT), 117, 3, 1141, 1);
    await cards.connect(bot).mint(a.address, day(NIGHT), 4, 214, key(NIGHT, "p1"));
    const gas = await ethers.provider.estimateGas({ to: await cards.getAddress(), data: cards.interface.encodeFunctionData("tokenURI", [1]) });
    assert.ok(gas < 15_000_000n, `tokenURI takes ${gas} gas`);
    console.log(`      tokenURI: ${gas} gas, ${(await cards.tokenURI(1)).length} characters`);
  });

  it("cards move like any NFT, and the lists follow", async function () {
    await cards.connect(bot).recordNight(day(NIGHT), spinsOf(NIGHT), 117, 3, 1141, 1);
    await cards.connect(bot).mint(a.address, day(NIGHT), 0, 30, key(NIGHT, "p1"));
    await cards.connect(bot).mint(a.address, day(NIGHT), 2, 61, key(NIGHT, "p2"));
    await reverts(cards.connect(b).transferFrom(a.address, b.address, 1));
    await cards.connect(a).transferFrom(a.address, b.address, 1);
    assert.deepEqual((await cards.cardsOf(a.address)).map(Number), [2]);
    assert.deepEqual((await cards.cardsOf(b.address)).map(Number), [1]);
    assert.equal(await cards.ownerOf(1), b.address);
  });

  it("only the owner changes the minter, and hands over in two steps", async function () {
    await reverts(cards.connect(bot).setMinter(a.address), "NotOwner");
    await reverts(cards.setMinter(ethers.ZeroAddress), "zero address");
    await cards.setMinter(c.address);
    assert.equal(await cards.minter(), c.address);
    await cards.offerOwner(a.address);
    assert.equal(await cards.owner(), owner.address);
    await reverts(cards.connect(b).acceptOwner(), "not offered to you");
    await cards.connect(a).acceptOwner();
    assert.equal(await cards.owner(), a.address);
    await reverts(cards.setMinter(bot.address), "NotOwner");
  });

  it("holds no ETH", async function () {
    await reverts(owner.sendTransaction({ to: await cards.getAddress(), value: 1n }));
  });
});
