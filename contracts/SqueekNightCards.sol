// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title Squeek Picks Night Cards
/// @notice A collectible card for each night a player calls Squeektoshi's run well. The art is
///         his real run that night, printed on chain as a receipt from his wheel's till: his
///         spins hour by hour, his busiest 3 hours marked, the night's totals, and a rubber
///         stamp for how the player called it, which sets the rarity.
/// @dev    Testnet only, like the pot. The minter (the payout bot) records each night's run
///         once and mints cards to the wallets players linked; nobody pays, nobody can change
///         a recorded night or a minted card. No ETH is ever held here.
contract SqueekNightCards is ERC721Enumerable {
    using Strings for uint256;

    // What a card was earned for, and its rarity.
    uint8 public constant CALLED_IT = 0;        // Common: 20+ points that night
    uint8 public constant BULLSEYE = 1;         // Rare: distance within 0.25 km
    uint8 public constant LONE_CALL = 2;        // Epic: right when nobody else was
    uint8 public constant PERFECT_NIGHT = 3;    // Epic: all three calls right, closest distance
    uint8 public constant SEASON_CHAMPION = 4;  // Legendary: won a season
    uint8 public constant KINDS = 5;
    uint8 public constant NO_PEAK = 255;        // a night he didn't run

    struct NightRun {
        bool set;
        uint16 kmDeci;     // distance in tenths of a km
        uint8 peak;        // busiest 3-hour window, 0..7 from 12:00 UTC, or NO_PEAK
        uint16 blocks;     // Squeek blocks settled that night
        uint8 moreBlocks;  // 0 fewer, 1 more than the night before, 2 not known
        bytes spins;       // 48 half hours of wheel spins from 12:00 UTC, 2 bytes each (big-endian)
    }

    struct Card {
        uint32 night;      // days since 1970-01-01, as in the pot
        uint8 kind;
        uint16 points;
    }

    string private constant INK = "#26241F";
    string private constant PAPER = "#F6F2E7";
    // The till's logo: a hamster running in his wheel, printed in the receipt's ink.
    string private constant LOGO =
        '<g fill="none" stroke="#26241F"><circle cx="300" cy="88" r="38" stroke-width="3"/><circle cx="300" cy="88" r="33"/>'
        '<path stroke-opacity=".55" d="M300 88L304.6 55.3M300 88L322.9 64.3M300 88L332.5 82.3M300 88L329.7 102.5M300 88L315.5 117.1M300 88L295.4 120.7M300 88L277.1 111.7M300 88L267.5 93.7M300 88L270.3 73.5M300 88L284.5 58.9"/>'
        '<path stroke-width="2.5" d="M300 88L282 140M300 88L318 140"/><path stroke-width="3" stroke-linecap="round" d="M272 140H328"/>'
        '<path stroke-width="1.6" stroke-linecap="round" d="M259 100h12M261 107h12M263 114h12"/></g><circle cx="300" cy="88" r="3.5"/>'
        '<use href="#hm" fill="#F6F2E7" stroke="#F6F2E7" stroke-width="4"/><use href="#hm"/>'
        '<g fill="#F6F2E7"><circle cx="312" cy="103" r="1.7"/><circle cx="304" cy="96" r="1.6"/><ellipse cx="308" cy="109" rx="4.5" ry="3" fill-opacity=".85"/></g>';
    string private constant HAMSTER =
        '<g id="hm"><ellipse cx="297" cy="108" rx="14" ry="11"/><circle cx="308" cy="105" r="9.5"/><circle cx="304" cy="96" r="3.8"/>'
        '<ellipse cx="290" cy="118" rx="4" ry="2.2"/><ellipse cx="306" cy="118" rx="4" ry="2.2"/></g>';

    address public owner;
    address public pendingOwner;
    address public minter;
    uint256 public totalMinted;

    mapping(uint32 => NightRun) private _runs;
    mapping(uint256 => Card) private _cards;
    /// The card minted for a key (the bot's hash of a player and a night), or 0.
    mapping(bytes32 => uint256) public cardFor;

    event NightRecorded(uint32 indexed night);
    event CardMinted(uint256 indexed id, address indexed to, uint32 indexed night, uint8 kind, bytes32 key);
    event MinterChanged(address minter);
    event OwnerOffered(address next);
    event OwnerChanged(address owner);

    error NotOwner();
    error NotMinter();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyMinter() { if (msg.sender != minter) revert NotMinter(); _; }

    /// @param minter_ the bot that records nights and mints cards; zero means the deployer.
    constructor(address minter_) ERC721("Squeek Picks Night Cards", "SQNIGHT") {
        require(block.chainid == 11155111 || block.chainid == 31337, "testnet only");
        owner = msg.sender;
        minter = minter_ == address(0) ? msg.sender : minter_;
    }

    // ----- Minter -----

    /// Records a night's run, once. The card art for that night is drawn from it.
    function recordNight(uint32 night, bytes calldata spins, uint16 kmDeci, uint8 peak, uint16 blocks, uint8 moreBlocks) external onlyMinter {
        NightRun storage r = _runs[night];
        require(!r.set, "night already recorded");
        require(spins.length == 96, "48 half hours");
        require(peak < 8 || peak == NO_PEAK, "bad peak window");
        require(moreBlocks <= 2, "bad blocks call");
        require(kmDeci <= 999, "distance out of range");
        r.set = true;
        r.kmDeci = kmDeci;
        r.peak = peak;
        r.blocks = blocks;
        r.moreBlocks = moreBlocks;
        r.spins = spins;
        emit NightRecorded(night);
    }

    /// Mints one card for a player's night. `key` names the player and night, so the same
    /// card can never be minted twice.
    function mint(address to, uint32 night, uint8 kind, uint16 points, bytes32 key) external onlyMinter returns (uint256 id) {
        require(to != address(0), "zero address");
        require(_runs[night].set, "night not recorded");
        require(kind < KINDS, "bad kind");
        require(key != bytes32(0) && cardFor[key] == 0, "already minted");
        id = ++totalMinted;
        cardFor[key] = id;
        _cards[id] = Card({ night: night, kind: kind, points: points });
        // _mint, not _safeMint: a wallet that can't take cards mustn't stop the bot.
        _mint(to, id);
        emit CardMinted(id, to, night, kind, key);
    }

    // ----- Owner -----

    function setMinter(address next) external onlyOwner {
        require(next != address(0), "zero address");
        minter = next;
        emit MinterChanged(next);
    }

    /// Offers the owner role to `next`, who takes it with acceptOwner(). Zero withdraws the offer.
    function offerOwner(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnerOffered(next);
    }

    function acceptOwner() external {
        require(msg.sender == pendingOwner, "not offered to you");
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerChanged(msg.sender);
    }

    // ----- Views -----

    function run(uint32 night) external view returns (NightRun memory) { return _runs[night]; }

    function card(uint256 id) external view returns (uint32 night, uint8 kind, uint8 rarity, uint16 points) {
        _requireOwned(id);
        Card storage c = _cards[id];
        return (c.night, c.kind, rarityOf(c.kind), c.points);
    }

    /// Every card a wallet holds, by id.
    function cardsOf(address who) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(who);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = tokenOfOwnerByIndex(who, i);
    }

    function rarityOf(uint8 kind) public pure returns (uint8) {
        return kind == CALLED_IT ? 0 : kind == BULLSEYE ? 1 : kind == SEASON_CHAMPION ? 3 : 2;
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        Card storage c = _cards[id];
        NightRun storage r = _runs[c.night];
        string memory date = _date(c.night);
        string memory kind = _kindName(c.kind);
        uint256 total = _total(r.spins);
        string memory json = string.concat(
            '{"name":"Night Card ', date, ': ', kind, '",',
            '"description":"Squeektoshi\'s run on the night of ', date, ' (from 12:00 UTC), printed as a receipt from his wheel\'s till: his spins hour by hour, his busiest 3 hours marked. The stamp says how this card was earned on Squeek Picks.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(id, c, r, total))), '",',
            '"attributes":[{"trait_type":"Rarity","value":"', _rarityName(rarityOf(c.kind)), '"},',
            '{"trait_type":"Earned for","value":"', kind, '"},',
            '{"trait_type":"Night","value":"', date, '"},',
            '{"trait_type":"Distance","value":"', _km(r.kmDeci), ' km"},',
            '{"trait_type":"Total spins","display_type":"number","value":', total.toString(), '},',
            '{"trait_type":"Points","display_type":"number","value":', uint256(c.points).toString(), '}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ----- Art: a till receipt -----

    function _svg(uint256 id, Card storage c, NightRun storage r, uint256 total) private view returns (string memory) {
        return string.concat(_head(id, c.night), _rows(r), _totals(c, r, total), _barcode(id), _stamp(c.kind), "</g></svg>");
    }

    function _head(uint256 id, uint32 night) private pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 840" width="600" height="840" font-family="\'Courier New\',Courier,monospace" font-size="13" fill="', INK, '">',
            '<defs><path id="pp" d="', _paper(), '"/>', HAMSTER, '</defs>',
            '<rect width="600" height="840" fill="#22252C"/><g transform="rotate(-2 300 420)">',
            '<use href="#pp" transform="translate(7 9)" fill="#000" fill-opacity=".35"/><use href="#pp" fill="', PAPER, '"/>', LOGO,
            '<text x="300" y="172" text-anchor="middle" font-size="26" font-weight="700">SQUEEK WHEEL CO.</text>',
            '<text x="300" y="194" text-anchor="middle" font-size="12" letter-spacing="1">* * NIGHT SHIFT RECEIPT * *</text>',
            '<text x="92" y="222">', _longDate(night), '</text><text x="508" y="222" text-anchor="end">12:00 UTC</text>',
            '<text x="92" y="240">CASHIER: SQUEEKTOSHI</text><text x="508" y="240" text-anchor="end">CARD #', id.toString(), '</text>',
            '<path d="M92 253H508" stroke="', INK, '" stroke-dasharray="5 4"/>'
        );
    }

    // The paper, torn along the top and bottom.
    function _paper() private pure returns (string memory p) {
        p = "M70 40";
        for (uint256 i = 0; i < 46; i++) p = string.concat(p, "l5 -8l5 8");
        p = string.concat(p, "L530 812");
        for (uint256 i = 0; i < 46; i++) p = string.concat(p, "l-5 8l-5 -8");
        p = string.concat(p, "Z");
    }

    // One line per hour, 12:00 to 11:00 UTC: a bar as long as his spins, the busiest 3 hours marked.
    function _rows(NightRun storage r) private view returns (string memory out) {
        bytes memory s = r.spins;
        uint256 top = 0;
        for (uint256 h = 0; h < 24; h++) { uint256 v = _hour(s, h); if (v > top) top = v; }
        for (uint256 h = 0; h < 24; h++) out = string.concat(out, _row(h, _hour(s, h), top, r.peak != NO_PEAK && h / 3 == r.peak));
    }

    function _row(uint256 h, uint256 v, uint256 top, bool peak) private pure returns (string memory) {
        string memory y = (273 + h * 15).toString();
        string memory bold = peak ? ' font-weight="700"' : "";
        return string.concat(
            peak ? string.concat('<text x="92" y="', y, '" font-weight="700">&gt;</text>') : "",
            '<text x="140" y="', y, '" text-anchor="end"', bold, '>', ((12 + h) % 24).toString(), ':00</text>',
            v == 0 ? string.concat('<text x="168" y="', y, '" fill-opacity=".5">\xc2\xb7 \xc2\xb7 \xc2\xb7</text>')
                : string.concat('<rect x="168" y="', (264 + h * 15).toString(), '" width="', _atLeast3(v * 230 / top).toString(), '" height="9"', peak ? "" : ' fill-opacity=".8"', '/>'),
            '<text x="508" y="', y, '" text-anchor="end"', bold, '>', v == 0 ? string("-") : _commas(v), '</text>'
        );
    }

    function _totals(Card storage c, NightRun storage r, uint256 total) private view returns (string memory) {
        return string.concat(
            '<path d="M92 630H508" stroke="', INK, '" stroke-dasharray="5 4"/>',
            _line(652, "TOTAL SPINS", _commas(total), false),
            _line(670, "DISTANCE", string.concat(_km(r.kmDeci), " KM"), false),
            _line(688, "PEAK WINDOW", r.peak == NO_PEAK ? string("NIGHT OFF") : _window(r.peak), false),
            _line(706, "BLOCKS", string.concat(_commas(r.blocks), r.moreBlocks == 1 ? string(" MORE") : r.moreBlocks == 0 ? string(" FEWER") : string("")), false),
            '<path d="M92 718H508" stroke="', INK, '" stroke-width="1.5"/>',
            _line(742, _upper(_kindName(c.kind)), string.concat("+", uint256(c.points).toString(), " PTS"), true),
            '<text x="300" y="808" text-anchor="middle" font-size="12" letter-spacing="1">THANK YOU \xc2\xb7 COME RUN AGAIN</text>'
        );
    }

    // "LABEL ........ VALUE", the dots sized to the gap (Courier is 0.6 em a letter).
    function _line(uint256 y, string memory label, string memory value, bool big) private pure returns (string memory out) {
        string memory ys = y.toString();
        string memory style = big ? ' font-size="17" font-weight="700"' : "";
        uint256 w = big ? 102 : 78;   // tenths of a pixel per letter
        uint256 a = 92 + (_letters(label) * w) / 10 + 8;
        uint256 b = 508 - (_letters(value) * w) / 10 - 8;
        out = string.concat('<text x="92" y="', ys, '"', style, '>', label, '</text><text x="508" y="', ys, '" text-anchor="end"', style, '>', value, '</text>');
        if (b > a + 10) out = string.concat(out, '<path d="M', a.toString(), " ", (y - 3).toString(), "H", b.toString(), '" stroke="', INK, '" stroke-dasharray="1.5 4" stroke-opacity=".7"/>');
    }

    // A barcode that's different on every card.
    function _barcode(uint256 id) private pure returns (string memory out) {
        bytes32 h = keccak256(abi.encode(id));
        uint256 x = 160;
        for (uint256 i = 0; x < 440; i++) {
            if (i == 32) { h = keccak256(abi.encode(h)); i = 0; }
            uint8 b = uint8(h[i]);
            uint256 w = 1 + (b % 3);
            out = string.concat(out, '<rect x="', x.toString(), '" y="760" width="', w.toString(), '" height="28"/>');
            x += w + 1 + ((b >> 4) % 3);
        }
    }

    // The rubber stamp: the rarity, in its own ink, and what the card was earned for.
    function _stamp(uint8 kind) private pure returns (string memory) {
        uint8 rarity = rarityOf(kind);
        string memory ink = _stampInk(rarity);
        string memory name = _upper(_rarityName(rarity));
        uint256 len = bytes(name).length * 26;
        return string.concat(
            '<g transform="translate(392 327) rotate(-13)" opacity=".82" fill="none" stroke="', ink, '">',
            '<rect x="-', ((len + 48) / 2).toString(), '" y="-34" width="', (len + 48).toString(), '" height="70" rx="8" stroke-width="4"/>',
            '<rect x="-', ((len + 34) / 2).toString(), '" y="-27" width="', (len + 34).toString(), '" height="56" rx="5" stroke-width="1.5"/>',
            '<g fill="', ink, '" stroke="none" text-anchor="middle"><text y="8" font-family="Impact,\'Arial Black\',sans-serif" font-size="36" font-weight="700" textLength="', len.toString(), '" lengthAdjust="spacingAndGlyphs">', name, '</text>',
            '<text y="24" font-size="11" font-weight="700">\xc2\xb7 ', _upper(_kindName(kind)), ' \xc2\xb7</text></g></g>'
        );
    }

    // ----- Helpers -----

    function _half(bytes memory s, uint256 i) private pure returns (uint256) {
        return uint256(uint8(s[2 * i])) << 8 | uint256(uint8(s[2 * i + 1]));
    }

    function _hour(bytes memory s, uint256 h) private pure returns (uint256) {
        return _half(s, 2 * h) + _half(s, 2 * h + 1);
    }

    function _total(bytes memory s) private pure returns (uint256 t) {
        for (uint256 i = 0; i < 48; i++) t += _half(s, i);
    }

    function _atLeast3(uint256 v) private pure returns (uint256) { return v < 3 ? 3 : v; }

    // 13297 -> "13,297"
    function _commas(uint256 v) private pure returns (string memory) {
        if (v < 1000) return v.toString();
        uint256 r = v % 1000;
        return string.concat(_commas(v / 1000), ",", r < 10 ? string("00") : r < 100 ? string("0") : string(""), r.toString());
    }

    // Letters as they print: UTF-8 continuation bytes don't count.
    function _letters(string memory s) private pure returns (uint256 n) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) if (uint8(b[i]) & 0xC0 != 0x80) n++;
    }

    function _km(uint16 deci) private pure returns (string memory) {
        return string.concat(uint256(deci / 10).toString(), ".", uint256(deci % 10).toString());
    }

    function _window(uint8 w) private pure returns (string memory) {
        uint256 a = (12 + uint256(w) * 3) % 24;
        uint256 b = (a + 3) % 24;
        return string.concat(a.toString(), ":00\xe2\x80\x93", b.toString(), ":00");
    }

    // A night number (days since 1970-01-01) as year, month, day.
    function _ymd(uint32 night) private pure returns (uint256 y, uint256 m, uint256 d) {
        uint256 z = uint256(night) + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }

    // YYYY-MM-DD
    function _date(uint32 night) private pure returns (string memory) {
        (uint256 y, uint256 m, uint256 d) = _ymd(night);
        return string.concat(y.toString(), "-", m < 10 ? string("0") : string(""), m.toString(), "-", d < 10 ? string("0") : string(""), d.toString());
    }

    // THU 29 OCT 2026
    function _longDate(uint32 night) private pure returns (string memory) {
        (uint256 y, uint256 m, uint256 d) = _ymd(night);
        return string.concat(_three("SUNMONTUEWEDTHUFRISAT", (uint256(night) + 4) % 7), " ", d.toString(), " ", _three("JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC", m - 1), " ", y.toString());
    }

    function _three(string memory list, uint256 i) private pure returns (string memory) {
        bytes memory b = bytes(list);
        return string(abi.encodePacked(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]));
    }

    function _kindName(uint8 k) private pure returns (string memory) {
        if (k == CALLED_IT) return "Called it";
        if (k == BULLSEYE) return "Bullseye";
        if (k == LONE_CALL) return "Lone call";
        if (k == PERFECT_NIGHT) return "Perfect night";
        return "Season champion";
    }

    function _rarityName(uint8 r) private pure returns (string memory) {
        if (r == 0) return "Common";
        if (r == 1) return "Rare";
        if (r == 2) return "Epic";
        return "Legendary";
    }

    // Stamp inks: black, blue, purple, gold.
    function _stampInk(uint8 r) private pure returns (string memory) {
        if (r == 0) return "#3A3D44";
        if (r == 1) return "#2F5BD8";
        if (r == 2) return "#7A3FD3";
        return "#C28A12";
    }

    function _upper(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) if (b[i] >= 0x61 && b[i] <= 0x7a) b[i] = bytes1(uint8(b[i]) - 32);
        return string(b);
    }
}
