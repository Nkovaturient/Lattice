// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// Track 1.3 / 5.2 — Solver stake, register, slash.
// v2: progressive stake requirements + fill history to deter Sybil admission.

contract SolverRegistry {
    // ── Stake tiers ───────────────────────────────────────────────────────────
    // Tier 0 (public):  0.05 ETH stake — any solver
    // Tier 1 (trusted): 0.5 ETH stake + MIN_FILLS fills on record
    // Higher tier = access to tier-1 GossipSub topic = better intents
    uint256 public constant TIER0_MIN_STAKE = 0.05 ether;
    uint256 public constant TIER1_MIN_STAKE = 0.5 ether;
    uint256 public constant MIN_FILLS_TIER1 = 10; // fills required before tier-1
    uint256 public constant SLASH_AMOUNT = 0.01 ether;
    uint256 public constant MAX_PEERID_LENGTH = 128;

    address public immutable settlementContract;
    address public immutable treasury;

    /// @dev ETH removed from solver stake accounting on slash — sweepable by `treasury` only.
    uint256 public slashProceedsBalance;

    // ── Solver state ──────────────────────────────────────────────────────────
    struct SolverInfo {
        bool registered;
        uint8 tier;
        uint256 stake;
        uint256 fills; // successful settlement count — anti-Sybil metric
        uint256 slashes; // slash count — reputation signal
        string peerId; // libp2p PeerID
    }

    mapping(address => SolverInfo) public solvers;
    mapping(address => uint256) public nonces; // user intent nonces
    mapping(string => address) public peerIdToAddress;

    // ── Events ────────────────────────────────────────────────────────────────
    event SolverRegistered(address indexed solver, string peerId, uint8 tier);
    event SolverUpgraded(address indexed solver, uint8 fromTier, uint8 toTier);
    event SolverDeregistered(address indexed solver);
    event SolverSlashed(address indexed solver, uint256 amount, string reason);
    event FillRecorded(address indexed solver, uint256 totalFills);
    event SlashedFundsSwept(address indexed treasury, uint256 amount);

    constructor(address _settlementContract, address _treasury) {
        require(_settlementContract != address(0), "zero settlement");
        require(_treasury != address(0), "zero treasury");
        settlementContract = _settlementContract;
        treasury = _treasury;
    }

    // ── Registration ──────────────────────────────────────────────────────────

    function register(string calldata peerId, uint8 tier) external payable {
        require(!solvers[msg.sender].registered, "Already registered");
        // require(bytes(peerId).length > 0, "Empty peerId");
        require(bytes(peerId).length <= MAX_PEERID_LENGTH, "PeerID too long");
        require(peerIdToAddress[peerId] == address(0), "PeerID taken");
        require(tier <= 1, "Invalid tier");

        uint256 required = tier == 1 ? TIER1_MIN_STAKE : TIER0_MIN_STAKE;
        require(msg.value >= required, "Insufficient stake");

        if (tier == 1) {
            require(solvers[msg.sender].fills >= MIN_FILLS_TIER1, "Insufficient fill history for tier-1");
        }

        solvers[msg.sender] = SolverInfo({
            registered: true,
            tier: tier,
            stake: msg.value,
            fills: solvers[msg.sender].fills,
            slashes: solvers[msg.sender].slashes,
            peerId: peerId
        });
        peerIdToAddress[peerId] = msg.sender;

        emit SolverRegistered(msg.sender, peerId, tier);
    }

    /**
     * Upgrade from tier-0 to tier-1 once fill threshold is met.
     * Requires topping up stake to TIER1_MIN_STAKE.
     */
    function upgradeTier() external payable {
        SolverInfo storage s = solvers[msg.sender];
        require(s.registered, "Not registered");
        require(s.tier == 0, "Already tier-1");
        require(s.fills >= MIN_FILLS_TIER1, "Insufficient fills");

        uint256 needed = TIER1_MIN_STAKE > s.stake ? TIER1_MIN_STAKE - s.stake : 0;
        require(msg.value >= needed, "Insufficient top-up");

        s.tier = 1;
        s.stake += msg.value;

        emit SolverUpgraded(msg.sender, 0, 1);
    }

    function deregister() external {
        SolverInfo storage s = solvers[msg.sender];
        require(s.registered, "Not registered");

        delete peerIdToAddress[s.peerId];
        uint256 amount = s.stake;
        s.registered = false;
        s.stake = 0;
        s.tier = 0;
        s.peerId = "";

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "ETH transfer failed");

        emit SolverDeregistered(msg.sender);
    }

    function topUpStake() external payable {
        require(msg.value > 0, "Zero stake top-up not allowed");
        require(solvers[msg.sender].registered, "Not registered");
        solvers[msg.sender].stake += msg.value;
    }

    /// @dev Pull accumulated slash proceeds to `treasury` (does not touch solver stake accounting).
    function sweepSlashedFunds() external {
        require(msg.sender == treasury, "Only treasury");
        uint256 amt = slashProceedsBalance;
        slashProceedsBalance = 0;
        require(amt <= address(this).balance, "Insufficient balance");
        (bool ok,) = payable(treasury).call{value: amt}("");
        require(ok, "Sweep failed");
        emit SlashedFundsSwept(treasury, amt);
    }

    // ── Called by IntentSettlement ────────────────────────────────────────────

    function recordFill(address solver) external {
        require(msg.sender == settlementContract, "Only settlement");
        solvers[solver].fills++;
        emit FillRecorded(solver, solvers[solver].fills);
    }

    /// @dev Stake slash when the solver is still registered with enough stake (generic protocol slash).
    function slash(address solver, string calldata reason) external {
        require(msg.sender == settlementContract, "Only settlement");
        SolverInfo storage s = solvers[solver];
        require(s.registered, "Not registered");
        require(s.stake >= SLASH_AMOUNT, "Insufficient stake");
        _executeStakeSlash(solver, s, reason);
    }

    /**
     * @dev Overpromise slash: same as `slash` when stake is available; if the solver was already
     *      deregistered (e.g. prior slash) or has no slashable stake, still increments `slashes` and
     *      emits `SolverSlashed` with `amount == 0` so reputation accounting completes.
     * @notice Requires prior on-chain activity (`fills`, `slashes`, or currently `registered`).
     */
    function slashOverpromise(address solver) external {
        require(msg.sender == settlementContract, "Only settlement");
        SolverInfo storage s = solvers[solver];
        require(s.fills > 0 || s.slashes > 0 || s.registered, "No solver history");

        if (s.registered && s.stake >= SLASH_AMOUNT) {
            _executeStakeSlash(solver, s, "overpromise");
        } else {
            s.slashes += 1;
            emit SolverSlashed(solver, 0, "overpromise");
        }
    }

    function _executeStakeSlash(address solver, SolverInfo storage s, string memory reason) private {
        s.stake -= SLASH_AMOUNT;
        slashProceedsBalance += SLASH_AMOUNT;
        s.slashes += 1;

        uint256 minStake = s.tier == 1 ? TIER1_MIN_STAKE : TIER0_MIN_STAKE;
        if (s.stake < minStake) {
            string memory pid = s.peerId;
            delete peerIdToAddress[pid];
            uint256 refund = s.stake;
            s.registered = false;
            s.tier = 0;
            s.stake = 0;
            s.peerId = "";
            (bool ok,) = payable(solver).call{value: refund}("");
            require(ok, "Stake refund failed");
        }

        emit SolverSlashed(solver, SLASH_AMOUNT, reason);
    }

    function incrementNonce(address user) external {
        require(msg.sender == settlementContract, "Only settlement");
        nonces[user]++;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function isRegistered(address solver) external view returns (bool) {
        return solvers[solver].registered;
    }

    function isActiveAndStaked(address solver) external view returns (bool) {
        SolverInfo storage s = solvers[solver];
        if (!s.registered) return false;
        uint256 minStake = s.tier == 1 ? TIER1_MIN_STAKE : TIER0_MIN_STAKE;
        return s.stake >= minStake;
    }

    function solverTier(address solver) external view returns (uint8) {
        return solvers[solver].tier;
    }

    function stake(address solver) external view returns (uint256) {
        return solvers[solver].stake;
    }

    function peerIdToAddressView(string calldata peerId) external view returns (address) {
        return peerIdToAddress[peerId];
    }

    function MIN_STAKE() external pure returns (uint256) {
        return TIER0_MIN_STAKE;
    }
}
