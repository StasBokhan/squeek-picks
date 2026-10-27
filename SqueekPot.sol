// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Squeek Picks nightly pot
/// @notice One ticket per wallet per night, all at the same price. Picks are
///         stored here so anyone can check them. After the night ends, the
///         resolver pays the pot to the night's top guessers (50/30/20, ties
///         split), or voids the night so everyone can take their ticket back.
///         If a night is not settled within 3 days, every ticket can be refunded.
/// @dev    Testnet only: the constructor refuses any chain except Sepolia and a
///         local test chain. Nobody, the owner included, can withdraw the pot.
contract SqueekPot {
    uint256 public constant DAY = 1 days;
    uint256 public constant LOCK_OFFSET = 12 hours;   // a night starts and locks at 12:00 UTC
    uint256 public constant REFUND_AFTER = 3 days;    // after the night ends
    uint256 public constant MAX_TICKETS = 500;
    uint256 public constant MAX_WINNERS = 10;
    uint16 public constant MAX_DISTANCE_DECI = 600;   // 60.0 km

    enum Status { Open, Settled, Voided }

    struct Ticket {
        uint64 boughtAt;      // block time, also the last tie-breaker
        uint16 distanceDeci;  // distance guess in tenths of a km
        uint8 peakBlock;      // 0..7, the 3-hour window of the night
        bool moreBlocks;      // more Squeek blocks than the night before
        bool refunded;
    }

    struct Night {
        uint128 price;
        uint128 pot;
        Status status;
        address[] players;
    }

    address public owner;
    address public resolver;
    uint256 public ticketPrice;

    mapping(uint32 => Night) private _nights;
    mapping(uint32 => mapping(address => Ticket)) public tickets;
    mapping(address => uint256) public owed;
    bool private _entered;

    event TicketBought(uint32 indexed night, address indexed player, uint16 distanceDeci, uint8 peakBlock, bool moreBlocks, uint256 price);
    event PicksChanged(uint32 indexed night, address indexed player, uint16 distanceDeci, uint8 peakBlock, bool moreBlocks);
    event NightSettled(uint32 indexed night, address[] winners, uint256[] amounts);
    event NightVoided(uint32 indexed night);
    event Refunded(uint32 indexed night, address indexed player, uint256 amount);
    event PaymentOwed(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ResolverChanged(address resolver);
    event TicketPriceChanged(uint256 price);
    event OwnerChanged(address owner);

    error NotOwner();
    error NotResolver();
    error Reentrant();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyResolver() { if (msg.sender != resolver) revert NotResolver(); _; }
    modifier nonReentrant() {
        if (_entered) revert Reentrant();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(uint256 price) {
        require(block.chainid == 11155111 || block.chainid == 31337, "testnet only");
        require(price > 0 && price <= type(uint128).max / MAX_TICKETS, "bad price");
        owner = msg.sender;
        resolver = msg.sender;
        ticketPrice = price;
    }

    // ----- Time -----

    /// Nights are numbered by day since 1970-01-01 (UTC). Night d runs from
    /// d 12:00 UTC to d+1 12:00 UTC and locks when it starts.
    function lockTime(uint32 night) public pure returns (uint256) { return uint256(night) * DAY + LOCK_OFFSET; }
    function endTime(uint32 night) public pure returns (uint256) { return lockTime(night) + DAY; }
    function openNight() public view returns (uint32) { return uint32((block.timestamp - LOCK_OFFSET) / DAY + 1); }

    // ----- Players -----

    function buyTicket(uint32 night, uint16 distanceDeci, uint8 peakBlock, bool moreBlocks) external payable {
        require(night == openNight(), "night not open");
        _checkPicks(distanceDeci, peakBlock);
        Night storage n = _nights[night];
        Ticket storage t = tickets[night][msg.sender];
        require(t.boughtAt == 0, "already have a ticket");
        require(n.players.length < MAX_TICKETS, "night is full");
        if (n.players.length == 0) n.price = uint128(ticketPrice);
        require(msg.value == n.price, "wrong ticket price");

        n.players.push(msg.sender);
        n.pot += uint128(msg.value);
        t.boughtAt = uint64(block.timestamp);
        t.distanceDeci = distanceDeci;
        t.peakBlock = peakBlock;
        t.moreBlocks = moreBlocks;
        emit TicketBought(night, msg.sender, distanceDeci, peakBlock, moreBlocks, msg.value);
    }

    /// Change your picks until the night locks. Your place in the tie-break order stays.
    function changePicks(uint32 night, uint16 distanceDeci, uint8 peakBlock, bool moreBlocks) external {
        require(night == openNight(), "night not open");
        _checkPicks(distanceDeci, peakBlock);
        Ticket storage t = tickets[night][msg.sender];
        require(t.boughtAt != 0, "no ticket");
        t.distanceDeci = distanceDeci;
        t.peakBlock = peakBlock;
        t.moreBlocks = moreBlocks;
        emit PicksChanged(night, msg.sender, distanceDeci, peakBlock, moreBlocks);
    }

    function refund(uint32 night) external nonReentrant {
        Night storage n = _nights[night];
        Ticket storage t = tickets[night][msg.sender];
        require(t.boughtAt != 0 && !t.refunded, "nothing to refund");
        bool timedOut = n.status == Status.Open && block.timestamp >= endTime(night) + REFUND_AFTER;
        require(n.status == Status.Voided || timedOut, "not refundable");
        t.refunded = true;
        uint256 amount = n.price;
        emit Refunded(night, msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send failed");
    }

    /// Collect a payout that could not be sent automatically.
    function withdrawOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        require(amount > 0, "nothing owed");
        owed[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send failed");
    }

    // ----- Resolver -----

    /// Pay the pot to the winners. `bps` are shares in basis points and must add up to 10,000.
    /// The page and the bot compute them with the same open rules: 50/30/20 by the night's
    /// points, ties split, 62.5/37.5 with two tickets.
    function settle(uint32 night, address[] calldata winners, uint16[] calldata bps) external onlyResolver nonReentrant {
        Night storage n = _nights[night];
        require(n.status == Status.Open, "already closed");
        require(block.timestamp >= endTime(night), "night not over");
        require(block.timestamp < endTime(night) + REFUND_AFTER, "refund window open");
        uint256 count = winners.length;
        require(count > 0 && count <= MAX_WINNERS && count == bps.length, "bad winners");

        uint256 totalBps;
        for (uint256 i = 0; i < count; i++) {
            require(tickets[night][winners[i]].boughtAt != 0, "winner has no ticket");
            for (uint256 j = 0; j < i; j++) require(winners[j] != winners[i], "duplicate winner");
            totalBps += bps[i];
        }
        require(totalBps == 10_000, "shares must total 100%");

        n.status = Status.Settled;
        uint256 pot = n.pot;
        uint256[] memory amounts = new uint256[](count);
        uint256 paid;
        for (uint256 i = 0; i < count; i++) {
            amounts[i] = (pot * bps[i]) / 10_000;
            paid += amounts[i];
        }
        amounts[0] += pot - paid; // rounding dust goes to the first winner
        emit NightSettled(night, winners, amounts);
        for (uint256 i = 0; i < count; i++) _pay(winners[i], amounts[i]);
    }

    /// No result for this night (data gap, too few tickets): everyone can refund.
    function voidNight(uint32 night) external onlyResolver {
        Night storage n = _nights[night];
        require(n.status == Status.Open, "already closed");
        require(block.timestamp >= endTime(night), "night not over");
        n.status = Status.Voided;
        emit NightVoided(night);
    }

    // ----- Owner -----

    function setResolver(address next) external onlyOwner {
        require(next != address(0), "zero address");
        resolver = next;
        emit ResolverChanged(next);
    }

    /// Applies to nights that have no tickets yet.
    function setTicketPrice(uint256 price) external onlyOwner {
        require(price > 0 && price <= type(uint128).max / MAX_TICKETS, "bad price");
        ticketPrice = price;
        emit TicketPriceChanged(price);
    }

    function setOwner(address next) external onlyOwner {
        require(next != address(0), "zero address");
        owner = next;
        emit OwnerChanged(next);
    }

    // ----- Views -----

    function getNight(uint32 night)
        external
        view
        returns (uint256 price, uint256 pot, Status status, address[] memory players, Ticket[] memory picks)
    {
        Night storage n = _nights[night];
        players = n.players;
        picks = new Ticket[](players.length);
        for (uint256 i = 0; i < players.length; i++) picks[i] = tickets[night][players[i]];
        return (n.price == 0 ? ticketPrice : n.price, n.pot, n.status, players, picks);
    }

    // ----- Internal -----

    function _checkPicks(uint16 distanceDeci, uint8 peakBlock) private pure {
        require(distanceDeci <= MAX_DISTANCE_DECI, "distance out of range");
        require(peakBlock < 8, "peak window out of range");
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount, gas: 30_000}("");
        if (!ok) {
            owed[to] += amount;
            emit PaymentOwed(to, amount);
        }
    }
}
