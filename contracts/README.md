# Lattice — Smart Contracts

Solidity contracts for on-chain settlement and solver registration, deployed on **Arbitrum One**.

| | |
|---|---|
| Solidity | `0.8.34`, `via_ir`, optimizer 200 runs |
| Tests | 48 Foundry tests passing (30 `IntentSettlement`, 18 `MockIntentSettlement`) |
| Audit status | H-1 → L-5 remediated, tracked in [`issues/`](issues/) |

---

## Contracts

| Contract | Purpose |
|---|---|
| `IntentTypes.sol` | EIP-712 type library shared by all contracts |
| `SolverRegistry.sol` | Solver stake, tiers, PeerID ↔ EVM binding, `deregister()` + pull `withdraw()`, immutable `treasury` |
| `IntentSettlement.sol` | Verify both EIP-712 signatures, execute the Uniswap v3 swap, pay user and solver, `nonces(user)` and `invalidateNonce()` |
| `MockIntentSettlement.sol` | Testnet drop-in — same validation, no SwapRouter call (proves the coordination layer) |

### Current behavior

- **Binding quote** — `bid.outputAmount` is `amountOutMinimum` and the post-swap floor. A swap below it reverts with `Output below bid`; the nonce is not burned.
- **Solver fee** — `SOLVER_FEE_BPS = 500`: 5% of the surplus above the signed bid. The user always receives at least the bid.
- **Pull withdrawal** — `deregister()` credits `pendingWithdrawals`; `withdraw()` pays out.
- **Cancellation** — `invalidateNonce()` bumps the caller's nonce and emits `NonceInvalidated`, voiding outstanding signatures.
- **Nonce passthrough** — `IntentSettlement.nonces(user)` reads `registry.nonces(user)`; the EIP-712 `verifyingContract` is the settlement address.
- **Route validation** — `InvalidRouteLength`, `RouteInputTokenMismatch`, `RouteOutputTokenMismatch` revert before `transferFrom`.
- **No slashing path** — v1 has no slash function. `SLASH_AMOUNT`, `slashProceedsBalance`, `sweepSlashedFunds()` and the `SolverSlashed` event remain in the bytecode but are unreachable, so the sweepable balance is always zero.

---

## Tech Stack

- **Solidity** `0.8.34` (pinned in `src` / `test` / `script`; `foundry.toml` `solc` matches)
- **Foundry** — build, test, deploy (`via_ir = true` in `foundry.toml` for `IntentSettlement.settle` stack limits)
- **OpenZeppelin Contracts v5** — `SafeERC20`, `ReentrancyGuard` (`lib/openzeppelin-contracts`, remapped as `@openzeppelin/contracts/`)
- **Uniswap v3 SwapRouter** — `0xE592427A0AEce92De3Edee1F18E0157C05861564` (same address on all EVM chains). Settlement calls `exactInput`; the packed path is checked in `_validateRoute`: `token (20) + fee (3) + token (20)`. Off-chain encoding is `node/route-encoder.js`; quotes use QuoterV2 in `node/compute-engine.js`. The on-chain `QUOTER_V2` constant is not called. `MockIntentSettlement` skips the router when Sepolia pools have no liquidity

---

## Keys & Environment

Create `contracts/.env`:

```bash
# Deployer wallet — needs ETH for gas
PRIVATE_KEY=0x...

# Arbitrum Sepolia RPC — get from Alchemy or Infura
ARB_SEPOLIA_RPC=https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY

# Arbitrum Mainnet
ARB_MAINNET_RPC=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY

# Arbiscan API key — for contract verification
# Get at: https://arbiscan.io/myapikey
ARBISCAN_API_KEY=...

# Arbitrum One only — deployed Safe. The constructor rejects an EOA on chain id 42161.
# Leave unset on Sepolia to keep the deployer as treasury.
TREASURY_ADDRESS=0x...
```

---

## Faucets (Arbitrum Sepolia)

| Resource | Link |
|---|---|
| Arbitrum Sepolia ETH | https://faucet.triangleplatform.com/arbitrum-sepolia |
| Alchemy Faucet (requires signup) | https://sepoliafaucet.com |
| Chainlink Faucet | https://faucets.chain.link/arbitrum-sepolia |
| Alchemy RPC | https://dashboard.alchemy.com |
| Infura RPC | https://app.infura.io |

---

## Build & Test

```bash
cd contracts

# Install Foundry (if not installed)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# Dependencies (forge-std + OpenZeppelin; skip if already in lib/)
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts@v5.0.2

# Build
forge build

# Run all tests
forge test -vvv

# Run specific test
forge test --match-test test_IntentTypeHash -vvv

# Run fuzz tests (1000 runs by default)
forge test --match-test testFuzz -vvv

# Gas snapshot
forge snapshot
```

---

## Deploy on Anvil (local fork)

```bash
# Terminal 1 — fork Arbitrum mainnet locally
anvil --fork-url $ARB_MAINNET_RPC --chain-id 42161

# Terminal 2 — deploy to local fork
forge script script/Deploy.s.sol \
  --rpc-url anvil \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast

# Test settle against local fork with real Uniswap v3 pools
SETTLEMENT_CONTRACT_ADDRESS=0x... node scripts/settle.js
```

Anvil's default funded account: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
Private key: `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`

---

## Deploy on Arbitrum Sepolia

```bash
cd contracts

# Load env
source .env

# Build first — ensure new functions compile
forge build

# Run tests (48 should pass)
forge test -v

# Dry run (no broadcast)
forge script script/Deploy.s.sol \
  --rpc-url $ARB_SEPOLIA_RPC \
  --private-key $PRIVATE_KEY

# Deploy + verify on Arbiscan
forge script script/Deploy.s.sol \
  --rpc-url $ARB_SEPOLIA_RPC \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ARBISCAN_API_KEY

# Verify manually if --verify failed (registry first, then settlement)
forge verify-contract <REGISTRY> src/SolverRegistry.sol:SolverRegistry \
  --chain arbitrum-sepolia --etherscan-api-key $ARBISCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,address)" <SETTLEMENT> <TREASURY>)

forge verify-contract <SETTLEMENT> src/IntentSettlement.sol:IntentSettlement \
  --chain arbitrum-sepolia --etherscan-api-key $ARBISCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" <REGISTRY>)

# Copy printed addresses into .env:
# SETTLEMENT_CONTRACT_ADDRESS=0x...
# REGISTRY_CONTRACT_ADDRESS=0x...
```

### Deploy `MockIntentSettlement` only (testnet / maintainer demo)

Use this when you already have a `SolverRegistry` and want a settlement contract that **skips SwapRouter** but keeps the same signing, nonce, and tier checks — ideal for a **full green** `settle` on Sepolia without pool-liquidity roulette.

```bash
cd contracts
source .env   # PRIVATE_KEY, ARB_SEPOLIA_RPC (Alchemy recommended)

forge script script/Deploy.s.sol:DeployAll \
  --sig "deployMock(address)" \
  "$REGISTRY_CONTRACT_ADDRESS" \
  --rpc-url "$ARB_SEPOLIA_RPC" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

Copy the logged **MockIntentSettlement** address into the **app** repo-root `.env`:

- `SETTLEMENT_CONTRACT_ADDRESS=<mock>`
- Ensure EIP-712 `verifyingContract` matches that address (`INTENT_SETTLEMENT_ADDRESS` / `sdk/domain.js` convention in your env).

The mock stores user nonces **on the contract itself**; the registry address you pass is only used for solver registration / tier checks.

After deploy, run the integration test:

```bash
ARB_SEPOLIA_RPC=$ARB_SEPOLIA_RPC \
SOLVER_KEY=$PRIVATE_KEY \
USER_KEY=$USER_PRIVATE_KEY \
SETTLEMENT_CONTRACT_ADDRESS=$SETTLEMENT_CONTRACT_ADDRESS \
REGISTRY_CONTRACT_ADDRESS=$REGISTRY_CONTRACT_ADDRESS \
node test/unit/e2e-sepolia.test.mjs
```

### Mesh solver + `IntentSettlement.settle`

From the application package root (`../` relative to this folder), `node scripts/run-solver.js` can submit the winning solver bid on-chain via `node/settlement-submit.js` when `SETTLEMENT_CONTRACT_ADDRESS` is set (`AUTO_SETTLE=false` skips the broadcast and keeps `scripts/settle.js` for manual runs). EIP-712 `verifyingContract` accepts `SETTLEMENT_CONTRACT_ADDRESS` or `INTENT_SETTLEMENT_ADDRESS` (see `sdk/domain.js`).

---

## Deploy on Arbitrum Mainnet

```bash
cd contracts
source .env

# Static analysis first
slither src/

# Treasury is immutable. Deploy a Safe first; chain id 42161 reverts for an EOA.
export TREASURY_ADDRESS=0xYourSafe

# Dry run
forge script script/Deploy.s.sol --rpc-url $ARB_MAINNET_RPC --private-key $PRIVATE_KEY

# Deploy + verify
forge script script/Deploy.s.sol \
  --rpc-url $ARB_MAINNET_RPC \
  --private-key $PRIVATE_KEY \
  --broadcast --verify \
  --etherscan-api-key $ARBISCAN_API_KEY \
  --slow
```

Post-deploy checks:

```bash
cast call <REGISTRY>   "treasury()(address)"             --rpc-url $ARB_MAINNET_RPC   # your Safe
cast call <REGISTRY>   "settlementContract()(address)"   --rpc-url $ARB_MAINNET_RPC   # IntentSettlement
cast call <SETTLEMENT> "SOLVER_FEE_BPS()(uint256)"       --rpc-url $ARB_MAINNET_RPC   # 500
```

---

## Contract Addresses

| Network | SolverRegistry | IntentSettlement |
|---|---|---|
| **Arbitrum One** (current) | [`0x469e747e4bEe661989DC7b1C988E0fBC87d5826d`](https://arbiscan.io/address/0x469e747e4bEe661989DC7b1C988E0fBC87d5826d) | [`0xdaB66B53c1041Ac60cD238beAe885f8741415025`](https://arbiscan.io/address/0xdaB66B53c1041Ac60cD238beAe885f8741415025) |
| Arbitrum Sepolia (legacy, pre-audit bytecode) | [`0x57b6…97d4`](https://sepolia.arbiscan.io/address/0x57b68c7595b8de5376d7b3c6cdafcc415cb597d4) | [`0x438b…daca`](https://sepolia.arbiscan.io/address/0x438b7889a1428f63f6450d3c1c2bab39f80edaca) |

Arbitrum One treasury (Gnosis Safe): [`0x3404F333B92DD849819F3C03e0eF18ec1035Dd6f`](https://arbiscan.io/address/0x3404F333B92DD849819F3C03e0eF18ec1035Dd6f)

The Sepolia deployment predates the audit fixes. Redeploy before using it with the current scripts.

---

## Verified TypeHashes

These are computed from the EIP-712 type strings and verified in `test/unit/eip712-parity.test.mjs`:

```
INTENT_TYPEHASH = 0x0d4e893b8ca2e1af73ef542e64756233b51d6ef4a450e4778c89898ceda17ece
BID_TYPEHASH    = 0x2e1aa209d8a4134c9a8e7fe708d82167eaf3ac87abb2c5a79b7dae3708aec2e7
```

---

## Foundry Test Matrix

Run all 48 tests with `forge test -v`:

| Test File | Coverage |
|---|---|
| `IntentSettlement.t.sol` (30 tests) | Nonce passthrough and cancellation, route validation errors, replay, deadlines, tier, preferred solver, binding bid output, fee on surplus, pull withdrawal |
| `MockIntentSettlement.t.sol` (18 tests) | Same validation matrix on the mock — local nonce storage, malformed-signature reverts, `invalidateNonce`, route errors, registration, tier, bid floor |

Key test categories:
- **Nonce:** `test_NoncePassthroughMatchesRegistry`, `test_NonceIncrementAfterSettle`, `test_RevertNonceMismatch`
- **Route validation:** `test_RevertInvalidRouteLength`, `test_RevertRouteInputTokenMismatch`, `test_RevertRouteOutputTokenMismatch`, `test_TwoHopRouteValid`
- **Replay and cancellation:** `test_CannotSettleTwice`, `test_InvalidateNonceCancelsPendingIntent`
- **Signatures:** `test_RevertMalformedIntentSignature`, `test_RevertMalformedBidSignature`
- **Binding bid & reentrancy:** `test_SettleEnforcesBidOutputMinimumOnRouter`, `test_RevertIfSwapOutputBelowBid`, `test_CallbackTokenCannotReenterSettle`

---

## Security Notes

- `SolverRegistry.settlementContract` and `treasury` are `immutable` — changing either requires redeployment.
- `settle()` enforces the solver's signed **`bid.outputAmount`** as the Uniswap v3 `amountOutMinimum` and the post-swap floor (`Output below bid`). There is no post-settlement slashing, so there is no overpromise-slash replay surface.
- `settle()` uses per-user nonces and marks `settled[intentId]` **before** the first external call (CEI); it is `nonReentrant` (OpenZeppelin `ReentrancyGuard`).
- Users cancel outstanding signatures with **`invalidateNonce()`**.
- Signed **`preferredSolver`** and **`topicTier`** are enforced on-chain (`address(0)` preferred solver means open auction; `topicTier` requires `registry.solverTier(msg.sender) >= intent.topicTier`).
- ERC-20 paths use **`SafeERC20`** (`forceApprove` to the SwapRouter, allowance cleared to zero after the swap).
- **Standard ERC-20 tokens only:** fee-on-transfer, deflationary and rebasing tokens are unsupported; `settle()` passes the exact `intent.inputAmount` to the router and distributes the reported `actualOutput`, so balance mutations make settlement revert.
- EIP-712 checks use **OpenZeppelin `ECDSA.tryRecover`** in both `IntentSettlement` and the mock: malleable or malformed signatures revert and a failed recovery never matches `address(0)`.
- **Pull withdrawals:** `deregister()` only credits `pendingWithdrawals`; `withdraw()` pays with `call{value:}` (not `transfer`) so smart-wallet solvers are not bricked, and a failing recipient cannot block the registry.
- **Treasury** is a Safe on Arbitrum One; the constructor rejects an EOA on chain id 42161. Sepolia may use the deployer EOA.
- **`settle()`** requires **`bid.deadline <= intent.deadline`** and non-zero `inputToken` / `outputToken` (v1 is ERC-20 only; use WETH for ETH).
- Audit findings H-1 → L-5 are resolved and tracked in [`issues/`](issues/).

---

## Troubleshooting

### `execution reverted (no data present)` when calling `nonces()`

The deployed contract doesn't have the `nonces()` passthrough. Either:
1. **Redeploy** `IntentSettlement` with the updated source (includes `nonces()`)
2. **Workaround:** Set `REGISTRY_CONTRACT_ADDRESS` in `.env` — `run-user.js` falls back to reading `registry.nonces(user)`

### `Nonce mismatch` on settle

The intent's nonce doesn't match on-chain. Causes:
- Intent was signed with stale nonce (already used in a prior settlement)
- User re-ran `run-user.js` without waiting for the prior settlement to confirm

Fix: Re-run `run-user.js` — it reads the current nonce before signing.

### `InvalidRouteLength` / `RouteInputTokenMismatch` / `RouteOutputTokenMismatch`

The solver's route doesn't match the intent's tokens. Check:
- `intent.inputToken` and `intent.outputToken` are valid ERC-20 addresses
- The solver's pathfinding produces a route that starts with `inputToken` and ends with `outputToken`

### `Solver not registered`

The solver calling `settle()` is not registered in `SolverRegistry`. Run:

```bash
node scripts/register-solver.js
```

```
SOLVER_INDEX=1 PEER_ID=<peerId> node scripts/register-solver.js
Registering solver (tier 0)…
  stake:    0.05 ETH
  tx: 0x…
  arbiscan: https://arbiscan.io/tx/0x…
```

- Next: run `node scripts/run-solver.js`, or after 10+ fills run `REGISTER_ACTION=upgrade` for tier 1.
- To leave: `REGISTER_ACTION=deregister` credits the stake and calls `withdraw()`.
