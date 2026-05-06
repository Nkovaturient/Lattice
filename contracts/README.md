## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.


## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```


# Lattice — Smart Contracts

Solidity contracts powering on-chain settlement, solver registration, and slashing.

---

## Contracts

| Contract | Purpose |
|---|---|
| `IntentTypes.sol` | EIP-712 type library shared by all contracts |
| `SolverRegistry.sol` | Solver stake, register, slash, **`treasury` + `sweepSlashedFunds()`** — p2p trust anchor |
| `IntentSettlement.sol` | Verify sigs, execute Uniswap v3 swap, pay solver, **`nonces(user)` passthrough** |
| `MockIntentSettlement.sol` | Testnet drop-in — same validation, no SwapRouter call (proves coordination layer) |

### Recent additions (v1.1)

- **`IntentSettlement.nonces(address user)`** — passthrough view to `registry.nonces(user)`. All JS callers read nonces through the settlement address (EIP-712 `verifyingContract`).
- **Route validation with custom errors** — `InvalidRouteLength`, `RouteInputTokenMismatch`, `RouteOutputTokenMismatch` revert early before `transferFrom` for diagnosable failures.
- **40 Foundry tests** — nonce passthrough, route validation, replay protection, tier checks, slash mechanics across both `IntentSettlement` and `MockIntentSettlement`.

---

## Tech Stack

- **Solidity** `0.8.34` (pinned in `src` / `test` / `script`; `foundry.toml` `solc` matches)
- **Foundry** — build, test, deploy (`via_ir = true` in `foundry.toml` for `IntentSettlement.settle` stack limits)
- **OpenZeppelin Contracts v5** — `SafeERC20`, `ReentrancyGuard` (`lib/openzeppelin-contracts`, remapped as `@openzeppelin/contracts/`)
- **Uniswap v3 SwapRouter** — `0xE592427A0AEce92De3Edee1F18E0157C05861564` (same address on all EVM chains)

---

## Keys & Environment

Create `foundry/.env`:

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

# Populated after deployment
SETTLEMENT_CONTRACT_ADDRESS=0x...
REGISTRY_CONTRACT_ADDRESS=0x...
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
cd foundry

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

# Run tests (40 tests should pass)
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

# Verified Solver Registry contract
forge verify-contract 0xbA8a94C43d7850adB3C0F9339a4630aBa704A919 \
  src/SolverRegistry.sol:SolverRegistry \
  --chain arbitrum-sepolia \
  --etherscan-api-key $ARBISCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x168E7554919e07dF4fc57616C1D4098d1C360C7C \
    0x1Bf95a7322D3B207A5a6f1beed9dD2C8145558fC)

# Verified Intent Settlement contract

forge verify-contract 0x168E7554919e07dF4fc57616C1D4098d1C360C7C \
  src/IntentSettlement.sol:IntentSettlement \
  --chain arbitrum-sepolia \
  --etherscan-api-key $ARBISCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" \
    0xbA8a94C43d7850adB3C0F9339a4630aBa704A919)

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
cd foundry

source .env

# Audit contracts first — DO NOT skip this step
# Recommended: Slither static analysis
pip3 install slither-analyzer
slither src/

# Estimate deployment cost
forge script script/Deploy.s.sol \
  --rpc-url $ARB_MAINNET_RPC \
  --private-key $PRIVATE_KEY

# Deploy + verify
forge script script/Deploy.s.sol \
  --rpc-url $ARB_MAINNET_RPC \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ARBISCAN_API_KEY \
  --slow  # wait for each tx to be mined before next
```

---

## Contract Addresses (update after deploy)

| Network | SolverRegistry | IntentSettlement |
|---|---|---|
| Arbitrum Sepolia | [Deployed contract](https://sepolia.arbiscan.io/address/0x57b68c7595b8de5376d7b3c6cdafcc415cb597d4) | [IS Deployed contract](https://sepolia.arbiscan.io/address/0x438b7889a1428f63f6450d3c1c2bab39f80edaca) |
| Arbitrum Mainnet | `0x...` | `0x...` |

---

## Verified TypeHashes

These are computed from the EIP-712 type strings and verified in `test/unit/eip712-parity.test.mjs`:

```
INTENT_TYPEHASH = 0x0d4e893b8ca2e1af73ef542e64756233b51d6ef4a450e4778c89898ceda17ece
BID_TYPEHASH    = 0x2e1aa209d8a4134c9a8e7fe708d82167eaf3ac87abb2c5a79b7dae3708aec2e7
```

---

## Foundry Test Matrix

Run all 40 tests with `forge test -v`:

| Test File | Coverage |
|---|---|
| `IntentSettlement.t.sol` (26 tests) | Nonce passthrough, nonce increment, nonce mismatch, route validation errors, replay, deadlines, tier, preferred solver, slash mechanics |
| `MockIntentSettlement.t.sol` (14 tests) | Same validation matrix on the mock — nonce local storage, route errors, registration, tier, bid floor |

Key test categories:
- **Nonce:** `test_NoncePassthroughMatchesRegistry`, `test_NonceIncrementAfterSettle`, `test_RevertNonceMismatch`
- **Route validation:** `test_RevertInvalidRouteLength`, `test_RevertRouteInputTokenMismatch`, `test_RevertRouteOutputTokenMismatch`, `test_TwoHopRouteValid`
- **Replay:** `test_CannotSettleTwice`
- **Slash:** `test_SettleRecordsOutputAndSlashForOverpromise`, `test_SlashForOverpromise_AfterPriorSlashAutoDeregister`

---

## Security Notes

- `SolverRegistry.settlementContract` is `immutable` — changing it requires redeployment
- `slash()` / `slashOverpromise()` are callable only by `IntentSettlement` — no admin grief vector; overpromise uses `slashOverpromise` so a solver who is already deregistered still gets `slashes++` and `SolverSlashed(..., 0, "overpromise")` when no stake remains to seize
- `settle()` uses per-user nonces and marks `settled[intentId]` **before** the first external call (CEI); the function is `nonReentrant` (OpenZeppelin `ReentrancyGuard`) to block reentrant double-settlement
- Signed intent fields **`preferredSolver`** and **`topicTier`** are enforced on-chain (`address(0)` preferred solver means open auction; `topicTier` requires `registry.solverTier(msg.sender) >= intent.topicTier`)
- ERC20 paths use **`SafeERC20`** (`safeTransfer` / `safeTransferFrom`, `forceApprove` to the SwapRouter, allowance cleared to zero after the swap)
- EIP-712 signature checks use **OpenZeppelin `ECDSA.tryRecover`** (not raw `ecrecover`): rejects **malleable** signatures (EIP-2 `s` range, `v` ∈ {27,28}) and does not treat a failed recovery as a match when `expected` is `address(0)`
- **`slashForOverpromise(bid, bidSig)`** — no third argument. Slashing compares the bid’s `outputAmount` to **`settlementActualOutput[intentId]`** written at successful settlement, so callers cannot inject a fake “actual output”
- **`deregister()`** returns stake with **`call{value:}`** (not `transfer`) so smart-wallet solvers are not bricked
- If a slash leaves stake below the tier minimum, the registry **auto-deregisters** and **`call`s the residual stake** back to the solver (avoids locked ETH)
- **`SolverRegistry`** is deployed as `new SolverRegistry(predictedSettlement, treasury)` — each **`SLASH_AMOUNT`** increments **`slashProceedsBalance`**; **`sweepSlashedFunds()`** ( **`treasury` only** ) sends that balance to **`treasury`**
- **`settle()`** requires **`bid.deadline <= intent.deadline`** and **`inputToken` / `outputToken` ≠ `address(0)`** (v1 is ERC20-only; use WETH for ETH — see `IntentTypes`)
- Run full Slither audit before mainnet deployment

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
PEER_ID=12D3KooWQRLSb7SQwQKwe62zCjporEH3qVwc1juvpUpJhS7Dj4XS  node scripts/register-solver.js
Registering solver (tier 0)…
  address:  0x1Bf95a7322D3B207A5a6f1beed9dD2C8145558fC
  peerId:   12D3KooWQRLSb7SQwQKwe62zCjporEH3qVwc1juvpUpJhS7Dj4XS
  stake:    0.05 ETH
  tx: 0x6eeba28229810fcfda370e0f4746d31d7f28cad5942e0ed235042c00b8fdf8f3
  arbiscan: https://sepolia.arbiscan.io/tx/0x6eeba28229810fcfda370e0f4746d31d7f28cad5942e0ed235042c00b8fdf8f3
  confirmed in block 265711857
```

- Next: run `node scripts/run-solver.js` with SOLVER_TIER=0 for public topic, or after 10+ fills run REGISTER_ACTION=upgrade then SOLVER_TIER=1.