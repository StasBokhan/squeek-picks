// Tests for the Night Cards collectibles (contracts/SqueekNightCards.sol).
//   cd contracts  &&  npm ci  &&  npm test
const { ethers, network } = require("hardhat");
const assert = require("assert");
const { compile } = require("../compile.cjs");
const art = require("../SqueekNightCards.json");
const diary = require("../../data/diary.json").nights;

const NIGHT = "2026-10-29";
const day = (night) => Math.round(Date.parse(night + "T00:00:00Z") / 86400e3);
// His real run that night, scaled the way the minting bot does it.
function spokesOf(night) {
  const s = diary[night].slots.map((x) => Number(x || 0)), max = Math.max(...s) || 1;
  return "0x" + s.map((v) => Math.round((v / max) * 255).toString(16).padStart(2, "0")).join("");
}
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
    const sp = spokesOf(NIGHT);
    await reverts(cards.connect(a).recordNight(day(NIGHT), sp, 117, 3, 1141, 1), "NotMinter");
    await reverts(cards.connect(bot).recordNight(day(NIGHT), "0x" + "00".repeat(47), 117, 3, 1141, 1), "48 half hours");
    await reverts(cards.connect(bot).recordNight(day(NIGHT), sp, 117, 8, 1141, 1), "bad peak window");
    await reverts(cards.connect(bot).recordNight(day(NIGHT), sp, 117, 3, 1141, 3), "bad blocks call");
    await cards.connect(bot).recordNight(day(NIGHT), sp, 117, 3, 1141, 1);
    await reverts(cards.connect(bot).recordNight(day(NIGHT), sp, 50, 2, 1, 0), "night already recorded");
    const r = await cards.run(day(NIGHT));
    assert.deepEqual([r.set, Number(r.kmDeci), Number(r.peak), Number(r.blocks), Number(r.moreBlocks), r.spokes], [true, 117, 3, 1141, 1, sp]);
    await cards.connect(bot).recordNight(day("2026-10-30"), spokesOf("2026-10-30"), 110, 255, 1069, 0);   // a night with no peak is allowed
  });

  it("mints each player's card for a night once, only from the minter", async function () {
    await reverts(cards.connect(bot).mint(a.address, day(NIGHT), 0, 40, key(NIGHT, "p1")), "night not recorded");
    await cards.connect(bot).recordNight(day(NIGHT), spokesOf(NIGHT), 117, 3, 1141, 1);
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

  it("draws the card on chain from his real run", async function () {
    await cards.connect(bot).recordNight(day(NIGHT), spokesOf(NIGHT), 117, 3, 1141, 1);
    await cards.connect(bot).mint(a.address, day(NIGHT), 4, 214, key(NIGHT, "p1"));
    const meta = decode(await cards.tokenURI(1));
    assert.equal(meta.name, "Night Card 2026-10-29: Season champion");
    const attrs = Object.fromEntries(meta.attributes.map((x) => [x.trait_type, x.value]));
    assert.deepEqual(attrs, { Rarity: "Legendary", "Earned for": "Season champion", Night: "2026-10-29", Distance: "11.7 km", Points: 214 });
    const spokes = (meta.svg.match(/<line /g) || []).length, dots = (meta.svg.match(/r="3"/g) || []).length;
    const zero = diary[NIGHT].slots.filter((x) => !Number(x)).length;
    assert.equal(spokes + dots, 48, "one mark per half hour");
    assert.equal(dots, zero, "quiet half hours are dots");
    assert.equal((meta.svg.match(/stroke="#FFB074"/g) || []).length, diary[NIGHT].slots.slice(18, 24).filter((x) => Number(x)).length, "his busiest 3 hours are lit");
    assert.ok(meta.svg.includes("11.7") && meta.svg.includes("Peak 21:00–0:00 UTC") && meta.svg.includes("1141 blocks, more") && meta.svg.includes("LEGENDARY") && meta.svg.includes("#FFB020"));
    require("fs").writeFileSync(require("path").join(__dirname, "..", "cache", "sample-card.svg"), meta.svg);
    await reverts(cards.tokenURI(2));
  });

  it("cards move like any NFT, and the lists follow", async function () {
    await cards.connect(bot).recordNight(day(NIGHT), spokesOf(NIGHT), 117, 3, 1141, 1);
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
