# Uniswap Integration Feedback — Lattice

**Name**: Neha Kumari
**email:** nehakumarisde@gmail.com
**Project:** Lattice — Private Solver Mesh  
**Hackathon:** ETHGlobal Mumbai 2026  
**GitHub:** https://github.com/Nkovaturient/Lattice


## What we built
Integrated Uniswap v3 SwapRouter (ExactInput) as the settlement execution layer 
for winning solver bids, and QuoterV2 for offchain bid amount estimation inside 
the RFQ auction window.

## Integration experience
- SwapRouter ABI and ExactInputParams were well-documented; wiring took ~2 hours.
- QuoterV2 staticcall on Arbitrum Sepolia hits p95 ~40ms — tight inside our 80ms 
  auction budget; a latency note in docs for time-sensitive use cases would help.
- No dedicated docs for SwapRouter use inside solver/intent settlement patterns; 
  had to infer the correct approval + swap flow from general v3 examples.

## What could be better
- Docs example for "solver calls SwapRouter on behalf of user with pre-signed 
  ERC-20 approval" — this pattern isn't covered explicitly.
- QuoterV2 latency benchmarks per network would be useful for auction designers.

## Feedback form submitted
https://developers.uniswap.org/hackathon-feedback