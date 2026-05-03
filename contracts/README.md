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
| `IntentSettlement.sol` | Verify sigs, execute Uniswap v3 swap, pay solver |

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

# Arbitrum Mainnet RPC
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
cd foundry

# Load env
source .env

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
forge verify-contract 0x57B68C7595B8de5376D7B3c6CDAFCc415cB597d4 \
  src/SolverRegistry.sol:SolverRegistry \
  --chain arbitrum-sepolia \
  --etherscan-api-key $ARBISCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x438B7889a1428F63f6450D3c1C2BAb39f80EDAca \
    0x1Bf95a7322D3B207A5a6f1beed9dD2C8145558fC)

# Verified Intent Settlement contract

forge verify-contract 0x438B7889a1428F63f6450D3c1C2BAb39f80EDAca \
  src/IntentSettlement.sol:IntentSettlement \
  --chain arbitrum-sepolia \
  --etherscan-api-key $ARBISCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" \
    0x57B68C7595B8de5376D7B3c6CDAFCc415cB597d4)

# Copy printed addresses into .env:
# SETTLEMENT_CONTRACT_ADDRESS=0x...
# REGISTRY_CONTRACT_ADDRESS=0x...
```

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