// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title Squeek Picks Night Cards
/// @notice A collectible card for each night a player calls Squeektoshi's run well. The art is
///         his real run that night, drawn on chain: a wheel with one spoke per half hour of
///         spins, his busiest 3 hours lit. How the player called the night sets the rarity.
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
        bytes spokes;      // 48 half hours of spins, scaled to 0..255 by the night's busiest
    }

    struct Card {
        uint32 night;      // days since 1970-01-01, as in the pot
        uint8 kind;
        uint16 points;
    }

    // 48 spoke directions, cos and sin x 10,000, from the top (12:00 UTC) clockwise.
    bytes private constant DIRS = hex"028ed905079fd9b00c8edb031147dcf715b4df8519c1e2a21d5ee63f207bea4c2309eeb924fdf3722650f86126fbfd7226fb028e2650079f24fd0c8e23091147207b15b41d5e19c119c11d5e15b4207b114723090c8e24fd079f2650028e26fbfd7226fbf8612650f37224fdeeb92309ea4c207be63f1d5ee2a219c1df8515b4dcf71147db030c8ed9b0079fd905028ed905fd72d9b0f861db03f372dcf7eeb9df85ea4ce2a2e63fe63fe2a2ea4cdf85eeb9dcf7f372db03f861d9b0fd72d905";

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
    function recordNight(uint32 night, bytes calldata spokes, uint16 kmDeci, uint8 peak, uint16 blocks, uint8 moreBlocks) external onlyMinter {
        NightRun storage r = _runs[night];
        require(!r.set, "night already recorded");
        require(spokes.length == 48, "48 half hours");
        require(peak < 8 || peak == NO_PEAK, "bad peak window");
        require(moreBlocks <= 2, "bad blocks call");
        require(kmDeci <= 999, "distance out of range");
        r.set = true;
        r.kmDeci = kmDeci;
        r.peak = peak;
        r.blocks = blocks;
        r.moreBlocks = moreBlocks;
        r.spokes = spokes;
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
        uint8 rarity = rarityOf(c.kind);
        string memory json = string.concat(
            '{"name":"Night Card ', date, ': ', _kindName(c.kind), '",',
            '"description":"Squeektoshi\'s run on the night of ', date, ' (from 12:00 UTC), called on Squeek Picks. Each spoke is half an hour of wheel spins; his busiest 3 hours are lit.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(c, r, date, rarity))), '",',
            '"attributes":[{"trait_type":"Rarity","value":"', _rarityName(rarity), '"},',
            '{"trait_type":"Earned for","value":"', _kindName(c.kind), '"},',
            '{"trait_type":"Night","value":"', date, '"},',
            '{"trait_type":"Distance","value":"', _km(r.kmDeci), ' km"},',
            '{"trait_type":"Points","display_type":"number","value":', uint256(c.points).toString(), '}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ----- Art -----

    function _svg(Card storage c, NightRun storage r, string memory date, uint8 rarity) private view returns (string memory) {
        string memory col = _rarityColor(rarity);
        string memory head = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 840" width="600" height="840" font-family="Helvetica,Arial,sans-serif">',
            '<rect x="6" y="6" width="588" height="828" rx="40" fill="#1B1F28" stroke="', col, '" stroke-width="10"/>',
            '<rect x="36" y="34" width="', uint256(bytes(_rarityName(rarity)).length * 15 + 40).toString(), '" height="40" rx="20" fill="', col, '"/>',
            '<text x="56" y="61" font-size="20" font-weight="700" fill="#171A21" letter-spacing="2">', _upper(_rarityName(rarity)), '</text>',
            '<text x="564" y="62" font-size="24" font-weight="700" fill="#B4BCCB" text-anchor="end">', date, '</text>',
            '<circle cx="300" cy="340" r="252" fill="none" stroke="', col, '" stroke-opacity=".22" stroke-width="4"/>'
        );
        return string.concat(head, _spokes(r, col), _footer(c, r, col));
    }

    function _spokes(NightRun storage r, string memory col) private view returns (string memory out) {
        bytes memory s = r.spokes;
        for (uint256 i = 0; i < 48; i++) {
            (int256 cx, int256 sy) = _dir(i);
            uint256 v = uint8(s[i]);
            bool lit = r.peak != NO_PEAK && i / 6 == r.peak;
            if (v == 0) {
                out = string.concat(out, '<circle cx="', _coord(300, cx, 96), '" cy="', _coord(340, sy, 96), '" r="3" fill="', col, '" fill-opacity=".35"/>');
                continue;
            }
            uint256 len = 96 + 12 + (v * 140) / 255;
            out = string.concat(out,
                '<line x1="', _coord(300, cx, 92), '" y1="', _coord(340, sy, 92), '" x2="', _coord(300, cx, len), '" y2="', _coord(340, sy, len),
                '" stroke="', lit ? string("#FFB074") : col, '" stroke-opacity="', lit ? string("1") : string(".62"), '" stroke-width="10" stroke-linecap="round"/>');
        }
        out = string.concat(out, '<circle cx="300" cy="340" r="60" fill="none" stroke="', col, '" stroke-opacity=".5" stroke-width="4"/><circle cx="300" cy="340" r="14" fill="#FFB074"/>');
    }

    function _footer(Card storage c, NightRun storage r, string memory col) private view returns (string memory) {
        string memory traits = string.concat(
            r.peak == NO_PEAK ? string("Night off") : string.concat("Peak ", _window(r.peak), " UTC"),
            "  \xc2\xb7  ", uint256(r.blocks).toString(), " blocks", r.moreBlocks == 1 ? string(", more") : r.moreBlocks == 0 ? string(", fewer") : string("")
        );
        return string.concat(
            '<text x="44" y="672" font-size="64" font-weight="700" fill="#EEF1F7">', _km(r.kmDeci), '<tspan font-size="30" fill="#98A1B3"> km</tspan></text>',
            '<text x="44" y="712" font-size="22" font-weight="700" fill="#B4BCCB">', traits, '</text>',
            '<rect x="36" y="736" width="528" height="70" rx="20" fill="#20242E"/>',
            '<text x="58" y="780" font-size="28" font-weight="700" fill="', col, '">', _kindName(c.kind), '</text>',
            '<text x="542" y="780" font-size="22" font-weight="700" fill="#98A1B3" text-anchor="end">', uint256(c.points).toString(), ' pts</text>',
            "</svg>"
        );
    }

    function _dir(uint256 i) private pure returns (int256, int256) {
        bytes memory d = DIRS;
        uint256 o = i * 4;
        int16 c = int16(uint16(uint8(d[o])) << 8 | uint16(uint8(d[o + 1])));
        int16 s = int16(uint16(uint8(d[o + 2])) << 8 | uint16(uint8(d[o + 3])));
        return (int256(c), int256(s));
    }

    // center + r * dir / 10,000, with one decimal.
    function _coord(uint256 center, int256 dir, uint256 r) private pure returns (string memory) {
        int256 v = int256(center) * 10 + (dir * int256(r)) / 1000;
        uint256 u = uint256(v);   // always positive: r < center
        return string.concat((u / 10).toString(), ".", (u % 10).toString());
    }

    function _km(uint16 deci) private pure returns (string memory) {
        return string.concat(uint256(deci / 10).toString(), ".", uint256(deci % 10).toString());
    }

    function _window(uint8 w) private pure returns (string memory) {
        uint256 a = (12 + uint256(w) * 3) % 24;
        uint256 b = (a + 3) % 24;
        return string.concat(a.toString(), ":00\xe2\x80\x93", b.toString(), ":00");
    }

    // A night number (days since 1970-01-01) as YYYY-MM-DD.
    function _date(uint32 night) private pure returns (string memory) {
        uint256 z = uint256(night) + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 d = doy - (153 * mp + 2) / 5 + 1;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
        return string.concat(y.toString(), "-", m < 10 ? string("0") : string(""), m.toString(), "-", d < 10 ? string("0") : string(""), d.toString());
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

    function _rarityColor(uint8 r) private pure returns (string memory) {
        if (r == 0) return "#98A1B3";
        if (r == 1) return "#6E96FF";
        if (r == 2) return "#B48CFF";
        return "#FFB020";
    }

    function _upper(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) if (b[i] >= 0x61 && b[i] <= 0x7a) b[i] = bytes1(uint8(b[i]) - 32);
        return string(b);
    }
}
