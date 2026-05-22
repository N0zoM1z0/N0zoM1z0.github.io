---
title: "When One Wei Breaks the Curve: A Research Field Guide to Fixed-Point AMM Failures"
date: "2026-05-22"
slug: "when-one-wei-breaks-the-curve"
categories:
  - DeFi
  - Security Research
tags:
  - amm
  - defi
  - fixed-point
  - exploits
---

# When One Wei Breaks the Curve: A Research Field Guide to Fixed-Point AMM Failures

*If the invariant is not enforced at the boundary, the mempool will prove the counterexample.*

## Scope and thesis

This post collects real, public fixed-point AMM failures and near-failures across production incidents, whitehat disclosures, and public audit contests for real protocols. It intentionally excludes CTF-style toy targets. The center of gravity is not "integer math is hard." That is too vague to be useful. The real pattern is sharper:

> A local rounding, scaling, or solver assumption becomes exploitable when it is stored as protocol state, replayed through another entry point, or amplified under low liquidity, zero supply, unusual token decimals, or batch settlement.

The cases below span StableSwap-style invariants, Solidly-style stable pairs, MetaPools, CLMMs, ERC4626 boosted pools, Uniswap v4 hook AMMs, protocol-layer AMMs, and custom bonding-curve systems. Some were exploited on mainnet. Some were caught in responsible disclosure or public audits before a public drain. All are useful because they show the same security law from different angles: AMM math is not only a formula; it is a state machine with adversarially chosen precision loss.

This corpus covers:

1. Synapse nUSD MetaPool, 2021.
2. Nerve Bridge MetaPool, 2021.
3. Saddle Finance sUSD V2 MetaPool, 2022.
4. Velodrome/Solidly stable-pair zero-`k` class.
5. DFX Finance EURS rounding disclosure, 2023.
6. Balancer ERC4626 Linear/Boosted Pools disclosure, 2023.
7. KyberSwap Elastic CLMM exploit, 2023.
8. Numoen invariant precision finding, 2023.
9. XRPL AMM protocol-layer rounding/invariant fix, 2024.
10. Abracadabra/MIMSwap MagicLP `I`-ratio finding, 2024.
11. HydraDX Stableswap/Omnipool findings, 2024.
12. Blackhole DEX stable-pair zero-`k` finding, 2025.
13. Cetus Protocol CLMM overflow/truncation exploit, 2025.
14. Bunni V2 LDF rounding exploit, 2025.
15. Balancer V2 Composable Stable Pool exploit, 2025.
16. Yearn yETH fixed-point solver exploit, 2025.

An appendix also names several adjacent incidents that are important to recognize, but should not be over-classified as fixed-point AMM failures: Curve/Vyper 2023, Platypus 2023, WOOFi 2024, Cork 2025, and Panoptic position spoofing.

---

## 0. A taxonomy before the case studies

The failures cluster into seven recurring shapes.

### 0.1 A product term or invariant collapses to zero

This is the Yearn `Π = 0` story, the Solidly/Velodrome/Blackhole stable-pair `k = 0` story, and the DFX "zero token transfer, nonzero LP mint" story. In all cases, the attack is not that a single division rounds down. The attack is that the rounded-down value becomes a trusted state transition.

```solidity
// The dangerous shape:
intermediate = numerator / denominator;  // floors to 0
require(intermediate >= 0);              // meaningless for uints
state.critical = intermediate;           // persisted as if valid
```

### 0.2 The same asset exists in two numeric domains

MetaPools are the canonical example. A base-pool LP token is not just an ERC-20 amount. It is a claim on a pool, and its value is `amount * virtualPrice`. If one path prices the LP token as raw units and another path prices it through `getVirtualPrice()`, arbitrage is no longer market discovery. It is a protocol bug.

### 0.3 Rounding direction is locally safe but globally unsafe

Bunni V2 is the cleanest example. A line rounded down in a withdrawal path because lower estimated liquidity seemed conservative. It was conservative for one operation. After 44 tiny withdrawals and a price-moving swap, that same underestimation reversed into an atomic liquidity increase that could be sandwiched.

### 0.4 Exact-out swaps require different rounding than exact-in swaps

Balancer V2 in 2025 exposed this at scale. A helper called `_upscale` rounded down in all contexts. That can be tolerable when scaling only integer decimal factors. It is much less tolerable when scaling factors include token exchange rates, especially in low-liquidity exact-out paths.

### 0.5 CLMM boundary math is a minefield

KyberSwap Elastic and Cetus both show that concentrated liquidity systems fail differently from constant-product AMMs. The critical predicate is often not "does `k` increase?" but "did we cross this tick?" or "how many token units are required for this liquidity range?" Off-by-one rounding and silent truncation can turn tick math into free liquidity.

### 0.6 Bootstrap and zero-supply states are attack surfaces

If a pool's initialization branch is gated by `totalSupply == 0`, the code is implicitly saying that zero supply can only occur at birth. Yearn yETH shows why that is not a safe lifecycle invariant. Balancer 2023 also shows the danger of rate reset behavior near zero supply.

### 0.7 Invariants must be economic, not only algebraic

A solver can converge to a number. A pool can preserve an internal equation. A branch can be mathematically monotone under real arithmetic. None of that proves safety. The core property is economic:

```text
attacker_value_out <= attacker_value_in + legitimate_fees + bounded_rounding_epsilon
```

Every case below can be understood as a way to violate that property.

---

## 1. Synapse nUSD MetaPool, 2021: raw LP units are not value

### Event

On November 6, 2021, Synapse reported that an attacker manipulated the nUSD MetaPool virtual price, lowering it by roughly 12.5%. Synapse stated that no funds were lost and that the issue was isolated to the Saddle MetaPool implementation used by the Synapse AMM, not the core bridge contract.[^synapse]

This belongs in the corpus even though the outcome was contained. It is an early example of a class that later hit Nerve and Saddle more directly: a MetaPool included a base-pool LP token whose raw ERC-20 amount was not equivalent to its economic value.

### Root cause

A MetaPool with a base LP token has at least two representations of that asset:

```text
raw_amount
value_amount = raw_amount * base_pool_virtual_price / 1e18
```

The invariant must be evaluated in a single canonical value domain. If any entry point uses `raw_amount` while another uses `value_amount`, the AMM gives the attacker a synthetic spread between two protocol-owned accounting systems.

The Synapse post-mortem identifies the vulnerable component as the Saddle MetaPool implementation. The bug class is not "price manipulation" in the usual oracle sense. It is more precise: the pool's own accounting exposed a route where the base LP token was under-normalized.

### Code path

The affected family is Saddle-style `MetaSwapUtils`, where base-pool LP token handling must apply the base pool virtual price. The later Saddle public remediation makes the missing primitive clear: calculations involving the base LP token must scale by `baseSwap.getVirtualPrice()` before feeding the token into the MetaPool invariant.[^saddle-immunefi][^saddle-vuln][^saddle-patched]

A simplified version of the bug looks like this:

```solidity
// Unsafe shape:
balances[i] = lpToken.balanceOf(address(this));  // raw LP units

// Safer shape:
balances[i] = lpToken.balanceOf(address(this))
    * basePool.getVirtualPrice()
    / 1e18;
```

The exact code evolved across deployments and forks, but the audit rule is invariant: base LP tokens, ERC4626 shares, LST wrappers, and rebasing wrappers must enter the AMM in value units, not raw units.

### Exploit path

The exploit shape is a loop:

1. Enter the route that underprices the base LP token.
2. Receive more base LP exposure than a value-consistent invariant would allow.
3. Exit or swap through a route that uses the correct value or a less distorted route.
4. Repeat until the virtual price or pool balances are pushed to a harmful state.

In Synapse's case, the observed outcome was a virtual price depression rather than a reported drain. That matters: the same root cause can manifest as a direct theft, a virtual-price corruption, or a bridge/accounting risk depending on integrations.

### How an audit should have found it

The audit should start with a numeraire map. For every token in the pool, write the canonical internal unit:

```text
USDC       -> 18-decimal normalized token amount
nUSD       -> 18-decimal normalized token amount
base LP    -> raw LP amount * base_virtual_price
ERC4626    -> shares * convertToAssets(shares)
LST wrapper -> shares * exchangeRate
```

Then compare every external and internal route:

```text
swap
swapUnderlying
addLiquidity
removeLiquidity
removeLiquidityOneToken
calculateSwap
getDy
view helpers used by routers
```

Any route that reaches the invariant before normalization is suspicious.

### Properties and invariant fuzzing

A good invariant would not require knowing the eventual exploit:

```solidity
// Route-equivalence property:
valueOut(routeA(x -> y)) <= valueOut(routeB(x -> y)) + fee_bound + epsilon
```

More concretely, fuzz a closed loop:

```text
underlying -> meta LP route -> base LP route -> underlying
```

The property is:

```text
loop_profit <= fees + tiny_rounding_bound
```

The fuzzer should vary:

- base pool virtual price,
- MetaPool imbalance,
- LP token position as asset 0, asset n, or "special" index,
- deposits near minimum liquidity,
- repeated route alternation.

### Our reading

The lesson from Synapse is that "LP token as pool asset" should be treated like a foreign currency, not a normal ERC-20. Once a pool accepts a derivative token, the AMM math is only half the protocol. The other half is the exchange-rate adapter, and adapters deserve the same scrutiny as the invariant itself.

---

## 2. Nerve Bridge MetaPool, 2021: the same scaling bug, now with direct extraction

### Event

BlockSec reported that on November 15, 2021, a flash-loan attack targeted Nerve Bridge fUSDT and UST MetaPools. The attack exhausted fUSDT and UST liquidity and netted around 900 BNB. BlockSec attributed the root cause to inconsistent exchange amount calculations in code forked from Saddle.[^nerve-blocksec]

### Root cause

Nerve inherited the MetaPool raw-vs-value bug class. The key inconsistency was between two routes:

```text
swap(...)            -> treated the base LP token too close to raw units
swapUnderlying(...)  -> performed scale-up / scale-down through base pool pricing
```

When one route underestimates the value of the LP token, the attacker can acquire too much LP exposure. When another route later redeems that exposure at the correct value, the invariant becomes a funding source.

### Code path

The vulnerable shape maps to Saddle `MetaSwapUtils` and related Nerve fork logic. BlockSec describes the inconsistency as a failure to account for base pool LP virtual price in `_calculateSwap`, while `swapUnderlying` performed the extra scaling.[^nerve-saddle-blocksec]

Conceptual vulnerable path:

```solidity
function swap(uint8 i, uint8 j, uint256 dx) external returns (uint256 dy) {
    // dx and balances are normalized for decimals,
    // but the base LP token is not value-scaled.
    dy = _calculateSwap(i, j, dx, balances);
}

function swapUnderlying(...) external returns (...) {
    // This path correctly routes through base-pool virtual price.
}
```

The correct design is not "patch only `swap`." It is "make the normalization layer impossible to bypass."

### Exploit path

BlockSec's reconstruction gives the economic sequence:

1. Borrow stablecoins through flash loan.
2. Use a route that swaps into a MetaPool asset while the base LP token is underpriced.
3. Receive too much base LP token exposure.
4. Redeem through a route that observes the real base LP token value.
5. Repeat across transactions and pools until the target liquidity is exhausted.[^nerve-blocksec]

The important part is not the exact token sequence. The important part is the directionality:

```text
buy LP claim in raw domain
sell LP claim in value domain
```

### How an audit should have found it

This issue is nearly tailor-made for differential path testing. Pick any asset pair where one side is a derivative. Compare:

```text
direct meta swap
underlying route
add + remove route
swap + remove-one route
```

The paths do not have to produce exactly the same output because fees and slippage differ. But they must not produce a consistently profitable cycle after fees.

An auditor should also grep for `getVirtualPrice`, `virtualPrice`, `rate`, `convertToAssets`, and similar functions. If such a function exists and is called only in some routes, that is a serious red flag.

### Properties and invariant fuzzing

Recommended fuzz harness:

```solidity
function invariant_no_profitable_route_cycle() external {
    uint256 start = value(attacker);
    handler.randomMetaRouteSequence();
    uint256 end = value(attacker);
    assertLe(end, start + feesEarnedByProtocol + epsilon);
}
```

Route generation should include:

- `swap`,
- `swapUnderlying`,
- `removeLiquidityOneToken`,
- deposit and withdraw through the base pool,
- repeated loops rather than one-call tests.

This is one of the cases where invariant fuzzing can find the bug without understanding the exact exploit. The key is to let the fuzzer choose both entry points and exit points.

### Our reading

Nerve teaches a subtle review discipline: do not audit a MetaPool by reading the invariant formula first. Audit the unit conversions first. If the units are inconsistent, the formula is already operating on corrupted data.

---

## 3. Saddle Finance sUSD V2 MetaPool, 2022: old vulnerable library, new exploitation geometry

### Event

On April 30, 2022, Saddle Finance's sUSD V2 MetaPool was exploited through the same core MetaPool vulnerability class. BlockSec reported that about 4,900 ETH was under attack, with around 1,360 ETH saved by intervention. Immunefi's analysis showed a PoC with over 2 million dollars of profit in the vulnerable setup.[^nerve-saddle-blocksec][^saddle-immunefi]

This case is especially important because the vulnerability was known in one context, patched in a library, yet a deployed pool still used an older vulnerable utility. That is not rare in DeFi. Libraries are upgraded in repositories faster than they are removed from production risk.

### Root cause

The same raw LP vs virtual-price scaling mismatch existed, but Saddle's exploit route differed from Nerve's. Immunefi points to a missing base virtual price calculation in the vulnerable MetaSwap utility. The patched version adds scaling through the base LP token virtual price.[^saddle-immunefi][^saddle-vuln][^saddle-patched]

The core bug:

```text
MetaPool invariant sees base LP token as cheaper than it is.
```

The exploit then builds a pool state where that mispricing causes the pool to overpay.

### Code path

Primary code references:

- Vulnerable `MetaSwapUtils.sol` at commit `141a00e7ba0c5e8d51d8018d3c4a170e63c6c7c4`.[^saddle-vuln]
- Patched `MetaSwapUtils.sol` at commit `7b7060e45be2ec3c9bcdf16240acf13394204571`.[^saddle-patched]
- Saddle pull request `#469`, which remediated the class.[^saddle-pr]

The conceptual vulnerable line is an invariant calculation over balances where the base LP token balance is not multiplied by its virtual price:

```solidity
// Bad: raw LP balance enters StableSwap math.
xp[baseLpIndex] = balances[baseLpIndex] * precisionMultiplier;

// Good: value-adjusted LP balance enters StableSwap math.
xp[baseLpIndex] =
    balances[baseLpIndex]
    * baseSwap.getVirtualPrice()
    / 1e18
    * precisionMultiplier;
```

### Exploit path

Immunefi's writeup outlines a route that did not simply repeat Nerve's exact swap-underlying pattern. The attacker could manipulate the MetaPool curve using direct swaps and liquidity operations around the underpriced base LP token. In one reconstructed path, the attacker borrowed USDC, acquired sUSD, obtained LP tokens, and then redeemed for a larger amount of sUSD, producing more than 2 million dollars in profit in the PoC.[^saddle-immunefi]

The shape:

1. Move the MetaPool into a state where the base LP token is materially underpriced.
2. Exchange stablecoin exposure into the underpriced LP representation.
3. Redeem or swap back once the pool's own invariant pays out at a more correct value.
4. Leave the pool with depleted stablecoin reserves.

### How an audit should have found it

Saddle shows that code review must track deployed utility contracts, not only repository state. In upgradeable or library-linked systems, ask:

```text
Which library address is this pool actually using?
Was the patched utility deployed?
Was every pool migrated?
Can old pools still be joined, swapped, or routed through aggregators?
```

A common failure mode after a patch is "new pools are safe; old pools are still callable." For AMMs, that is enough for a full incident.

### Properties and invariant fuzzing

Useful invariant:

```text
For any base LP virtual price p, a closed route through meta and base pools cannot increase value beyond fees.
```

A differential test should create two models:

1. A high-precision model that always values base LP through virtual price.
2. The Solidity implementation.

Then fuzz route sequences. Any persistent positive delta is a bug, even if the individual swap function claims to preserve its local invariant.

### Our reading

The most interesting part of Saddle is not that a known bug repeated. It is why it repeated: production deployments are a graph, not a repository. A security fix only exists when every reachable contract instance that can exercise the old path is either migrated, paused, or made economically irrelevant.

---

## 4. Velodrome/Solidly stable pairs: `x^3y + y^3x` can become zero before it becomes stable

### Event

Velodrome/Solidly-style stable pairs use the invariant:

```text
k = x^3y + y^3x
```

A Spearbit review of Velodrome described a high-risk issue where the first liquidity provider of a stable pair could make the pool's invariant `k` equal zero through rounding, then DoS or drain residual balances. The review states that `_a = (_x * _y) / 1e18` becomes zero when `_x * _y < 1e18`.[^velodrome-spearbit]

This was not a reported production drain in Velodrome, but it is a real public project finding, and the same class later appeared in other Solidly-style forks.

### Root cause

The invariant is high-degree, but the implementation is fixed-point. A common implementation decomposes it:

```solidity
function _k(uint256 x, uint256 y) internal view returns (uint256) {
    if (stable) {
        uint256 _x = (x * 1e18) / decimals0;
        uint256 _y = (y * 1e18) / decimals1;
        uint256 _a = (_x * _y) / 1e18;
        uint256 _b = ((_x * _x) / 1e18) + ((_y * _y) / 1e18);
        return (_a * _b) / 1e18;
    }
    return x * y;
}
```

The dangerous line is `_a`:

```text
_x * _y < 1e18  =>  _a = 0  =>  k = 0
```

Uniswap V2's `MINIMUM_LIQUIDITY` protects the square-root constant-product initialization. It does not prove safety for a cubic stable invariant. A minimum liquidity threshold designed for `xy` is not automatically safe for `x^3y + y^3x`.

### Code path

The Spearbit report points to Velodrome `Pair` logic around `_k` and `mint`, including the `MINIMUM_LIQUIDITY` assumption inherited from Uniswap V2.[^velodrome-spearbit]

A closely related immutable code reference appears in the Blackhole Code4rena report, which links the same stable-pair `_k` shape in `Pair.sol` at commit `92fff849d3b266e609e6d63478c4164d9f608e91`.[^blackhole]

### Exploit path

The path is a first-LP lifecycle attack:

1. Create or initialize a stable pair with extremely small balances.
2. Satisfy the generic liquidity mint condition.
3. Let the stable invariant compute `k = 0`.
4. Use swaps against a zero-invariant state to extract whatever token dust or later-added liquidity becomes available.
5. Repeat or DoS the pool.

This is not a large flash-loan exploit. It is worse in another way: it can be a griefing or pool-bricking primitive that sits at the pair's birth.

### How an audit should have found it

The first audit check is simple:

```text
Does the minimum initial liquidity imply k > 0 for the actual stable invariant?
```

For Solidly-style stable pairs, the answer may be no. You must calculate the lower bound for `_x * _y` after decimal normalization.

The second check is more general:

```text
Does every denominator, product term, and invariant term used by swap math remain nonzero after any valid mint?
```

A reviewer should not accept `MINIMUM_LIQUIDITY` by inheritance. The minimum must be re-derived for the invariant.

### Properties and invariant fuzzing

This class is very fuzzable.

Handler actions:

```text
createPair(stable = true)
mint(amount0, amount1)
swap(...)
skim/sync if available
burn(...)
```

Generators should heavily bias toward:

```text
amount0 in [1, 1e9]
amount1 in [1, 1e9]
token decimals in {2, 6, 8, 18}
first LP only
```

Properties:

```solidity
if (stable && totalSupply > 0) {
    assertGt(_k(reserve0, reserve1), MINIMUM_K);
}

assertNoProfitableCycleAfterFees();
assertNoZeroInvariantSwap();
```

### Our reading

This case is a reminder that copying a liquidity bootstrap pattern from one invariant to another is not safe engineering. Every AMM invariant has its own minimum viable state. If the code does not enforce that state explicitly, the first LP gets to choose it.

---

## 5. DFX Finance EURS, 2023: transferring zero but minting shares

### Event

On April 28, 2023, a whitehat reported a critical rounding vulnerability in DFX Finance through Immunefi. The issue involved EURS on Polygon, which has only two decimals. Immunefi reported that about $237,143 was at risk, no user funds were lost, and DFX paid a 100,000 USDT bounty.[^dfx-immunefi]

### Root cause

DFX uses Assimilators to convert different FX stablecoins into a common numeraire. The bug occurred in a proportional liquidity path where the raw token transfer amount could round down to zero, but the deposit path still minted LP shares.

The minimal vulnerable shape is:

```solidity
amount_ = (_amount.mulu(10**tokenDecimals) * 1e6) / _rate;
token.safeTransferFrom(msg.sender, address(this), amount_);
// downstream: mint LP shares based on the requested numeraire amount
```

If `amount_ == 0`, no real EURS moves. But if the surrounding liquidity function treats the deposit as successful, the attacker receives pool shares for a zero-cost transfer.

### Code path

Immunefi identifies `AssimilatorV2.intakeNumeraireLPRatio` as the relevant function and points to the transfer amount calculation.[^dfx-immunefi] The public repository reference shows the amount calculation and transfer in `src/assimilators/AssimilatorV2.sol`.[^dfx-code]

```solidity
amount_ = (_amount.mulu(10**tokenDecimals) * 1e6) / _rate;
...
token.safeTransferFrom(msg.sender, address(this), amount_);
```

The fix described by Immunefi was to deploy a new `AssimilatorV2` and add a `require` that the amount transferred from the user is greater than zero.[^dfx-immunefi]

### Exploit path

The exploit shape:

1. Choose a token with very low decimals, here EURS with two decimals.
2. Call the deposit path with a tiny numeraire amount.
3. Let the raw token amount floor to zero.
4. Receive LP shares anyway.
5. Repeat many times in a single transaction.
6. Withdraw the accumulated LP share for real pool assets.

Immunefi states that the low-decimal EURS setup made the attack economical and that repeated tiny deposits could generate profit while progressively acquiring a larger share of the vulnerable pool.[^dfx-immunefi]

### How an audit should have found it

This is a classic "actual in vs accounted in" mismatch. The review should compare:

```text
requested_amount
computed_raw_transfer
actual_balance_delta
shares_minted
```

For every deposit path, the invariant should be:

```text
shares_minted > 0  =>  actual_asset_delta > 0
```

For fee-on-transfer and rebasing tokens, even `computed_raw_transfer > 0` is not enough. The contract should measure balance deltas.

### Properties and invariant fuzzing

This is extremely fuzzable if the harness varies token decimals.

Token mocks:

```text
decimals = 0, 1, 2, 6, 8, 18, 24
oracle rate large
deposit amount tiny
```

Properties:

```solidity
uint256 before = token.balanceOf(address(pool));
uint256 shares = pool.deposit(...);
uint256 after_ = token.balanceOf(address(pool));

if (shares > 0) {
    assertGt(after_ - before, 0);
}
```

Economic property:

```solidity
assertLe(value(attackerAfter), value(attackerBefore) + legitimateYield + epsilon);
```

Fuzzing would likely find this quickly if low-decimal tokens are included. Many DeFi fuzz suites only use 18-decimal mocks. That habit would miss DFX.

### Our reading

DFX is one of the cleanest examples of why "support any ERC-20" is a security claim, not a product feature. If a protocol only tests 18-decimal assets, it does not support arbitrary tokens. It supports a convenient subset of ERC-20 behavior.

---

## 6. Balancer ERC4626 Linear/Boosted Pools, 2023: one wei becomes a rate reset

### Event

In August 2023, a whitehat reported a critical vulnerability in Balancer ERC4626 Linear Pools. Immunefi states that the bug combined a rounding error in `ERC4626LinearPools` with `flashSwap`, and that the value in affected Boosted Pools could theoretically be drained. The report says this represented about 20% of Balancer's roughly $1 billion TVL at the time, and the whitehat received a 1,000,000 USDC bounty.[^balancer-2023]

### Root cause

Linear Pools pair an underlying token with a wrapped ERC4626 token. They also have BPT supply and a pool rate. The vulnerable behavior started as a tiny rounding asymmetry: exchanging 1 wei of wrapped token could deduct only 1 wei of underlying. Alone, that is not a meaningful profit. In the Linear Pool state machine, however, it interacted with three amplifiers:

1. Batch/flash swap settlement.
2. Balanced-state swaps with no fee.
3. Large initialized BPT supply that could be manipulated near zero.

The bug became serious when the attacker could reduce the pool's BPT supply near zero, repeatedly exploit rounding in `GivenOut` swaps, depress the rate, and repay BPT at the depressed rate.

### Code path

Immunefi's review links a public PoC repository and describes the exploit against fork block `17893427`.[^balancer-2023][^balancer-2023-poc] The affected family is Balancer's Linear/Boosted Pool logic around wrapped/underlying exchange and BPT rate accounting. The interesting code is less a single line than the interaction of:

```text
wrapped <-> underlying swap
BPT supply changes
rate = balance / supply
flash/batch settlement
```

A simplified shape:

```solidity
// Rounding makes the pool charge the attacker one unit less than the real exchange.
underlyingDelta = wrappedAmountToUnderlying(wrappedIn); // floors

// Rate update later observes a changed balance/supply relationship.
rate = poolBalance / bptSupply;
```

### Exploit path

Immunefi describes the exploit conceptually as:

1. Flash-swap BPT to reduce the observed supply close to zero.
2. Perform `GivenOut` swaps that exploit the 1 wei rounding asymmetry.
3. Reduce the pool balance without reducing BPT supply proportionally.
4. Drive the pool rate below 1.
5. Repay the BPT at the depressed rate and keep the difference.[^balancer-2023]

This is the same theme as later Balancer and Bunni incidents: a rounding error only becomes catastrophic after the attacker first creates a low-liquidity or low-supply state.

### How an audit should have found it

The audit should model the pool as a state machine with three value buckets:

```text
underlying token balance
wrapped token balance
BPT supply and rate
```

Then test whether a batch sequence can create a rate change without a corresponding economic input.

A single-function review of the wrapper exchange might classify the error as dust. The correct question is:

```text
Can dust change a denominator?
```

If yes, dust is not dust.

### Properties and invariant fuzzing

Useful properties:

```solidity
// Rate should not be manipulable by a zero-net-value flash sequence.
if (netExternalValueIn <= epsilon) {
    assertApproxEqRel(rateAfter, rateBefore, allowedRateDrift);
}

// BPT repayment cannot become cheaper due to transient supply manipulation.
assertGe(valuePaidToRepayBPT, valueBorrowedBPT - epsilon);
```

Fuzzing needs support for batch settlement. A normal one-call-per-step fuzzer may miss this. The handler should include:

```text
begin batch
swap BPT
swap wrapped/underlying exact out
swap back
settle batch
```

### Our reading

This case is a strong argument that DeFi fuzzing must include protocol-native transaction composition. A pool that is safe under isolated calls may not be safe under its own batch API.

---

## 7. KyberSwap Elastic, 2023: the tick boundary lied

### Event

KyberSwap Elastic was exploited in November 2023 for roughly $48 million. Kyber's post-mortem and BlockSec's technical analysis describe a CLMM-specific precision failure where the attacker used carefully chosen swaps and liquidity changes to cause incorrect tick handling and double-counted liquidity.[^kyber-official][^kyber-blocksec]

### Root cause

Kyber Elastic is a concentrated-liquidity AMM with reinvestment liquidity. In CLMMs, the critical boundary is often the comparison between the next square-root price and the target tick price:

```text
nextSqrtP < targetSqrtP
nextSqrtP == targetSqrtP
nextSqrtP > targetSqrtP
```

Kyber's vulnerable path let rounding make the protocol believe it had not crossed a tick, or had crossed it under the wrong liquidity assumptions. The result was that liquidity that should have been removed or recalculated remained counted. BlockSec summarized the effect as improper tick calculation and double liquidity counting caused by a rounding-direction issue in reinvestment logic.[^kyber-blocksec]

### Code path

The relevant family is Kyber's `SwapMath.computeSwapStep` and tick-crossing logic in `ks-elastic-sc`.[^kyber-sherlock][^kyber-repo] A simplified CLMM step looks like:

```solidity
targetSqrtP = TickMath.getSqrtRatioAtTick(nextTick);
nextSqrtP = calcFinalPrice(...);

if (nextSqrtP == targetSqrtP) {
    crossTick();
} else {
    // remain in current tick
}
```

The dangerous case is when arithmetic produces `nextSqrtP` one unit away from the exact mathematical boundary. If the implementation rounds in the wrong direction, the branch flips.

### Exploit path

The exploit was not a brute force price manipulation. It required precise construction:

1. Prepare pool state and liquidity positions.
2. Move price near a tick boundary.
3. Choose a swap amount close to the amount required to cross the tick, often conceptually `amountToCrossTick - 1`.
4. Trigger the rounding condition so the pool's tick state and liquidity state diverge.
5. Reverse or continue swaps while the pool counts liquidity incorrectly.
6. Extract value from the mismatch.

The public analyses emphasize the sophistication of the calculations. That should not distract from the audit lesson: the bug lived at a boundary predicate.

### How an audit should have found it

For CLMMs, review every branch whose condition depends on a rounded fixed-point result:

```text
nextSqrtP == targetSqrtP
amountRemaining >= amountToCross
liquidityDelta applied or not applied
tick initialized or skipped
```

Then ask:

```text
What happens at exact boundary?
What happens one unit below?
What happens one unit above?
Does the branch match the high-precision model?
```

### Properties and invariant fuzzing

A useful differential property:

```text
For every swap step, the production branch decision must match a high-precision reference model after applying the protocol's documented rounding policy.
```

Fuzz domains:

```text
amountToCross - 1
amountToCross
amountToCross + 1
empty ticks
single initialized tick
reinvestment liquidity > 0
base liquidity > 0
min and max ticks
```

Economic invariant:

```solidity
assertNoRoundTripProfitBeyondFees();
```

But for Kyber-like bugs, a pure economic invariant may need deep sequences. A stronger local property is:

```text
If final price reaches target tick price, tick crossing and liquidity update must occur exactly once.
```

### Our reading

Kyber is the case that should permanently change how we review CLMM math. The dangerous comparison is not only overflow or division by zero. It is any equality or inequality over a rounded Q-format price.

---

## 8. Numoen, 2023: divide first, lose the invariant later

### Event

A Code4rena finding against Numoen identified precision loss in the pool's invariant check. The report explains that if `token0` has 6 decimals and liquidity is greater than `1e24`, a `mulDiv` operation rounds before conversion to D18 precision, causing the invariant check to be wrong.[^numoen-report][^numoen-issue]

This was a public audit finding, not a known production exploit. It still belongs in this corpus because it captures a very common AMM bug: doing division before scaling.

### Root cause

The vulnerable pattern:

```solidity
scale0 = FullMath.mulDiv(amount0, 1e18, liquidity) * token0Scale;
scale1 = FullMath.mulDiv(amount1, 1e18, liquidity) * token1Scale;
```

Mathematically, the intended quantity is closer to:

```text
amount0 * 1e18 * token0Scale / liquidity
```

But the implementation computes:

```text
floor(amount0 * 1e18 / liquidity) * token0Scale
```

Once the first floor happens, multiplying by `token0Scale` cannot recover the lost information.

### Code path

The Code4rena issue points to `Pair.sol` at commit `2ad9a73d793ea23a25a381faadc86ae0c8cb5913`, around lines 56 and 57.[^numoen-issue]

The code is a small example with a large lesson:

```solidity
// Bad ordering:
x = mulDiv(amount, 1e18, liquidity) * tokenScale;

// Better ordering:
x = mulDiv(amount, 1e18 * tokenScale, liquidity);
```

This is not merely a precision preference. If the result feeds an invariant check, precision loss can turn an invalid state into an accepted state.

### Exploit path

The exploit shape is:

1. Use a low-decimal token, such as a 6-decimal asset.
2. Move liquidity high enough that `amount * 1e18 / liquidity` loses meaningful precision.
3. Execute an action that should violate the invariant.
4. Let the invariant check pass because the scaled terms are underestimated or distorted.
5. Extract value while the contract believes the invariant holds.

The exact profitability depends on pool state, but the finding's impact is invariant bypass and potential fund theft.

### How an audit should have found it

Auditors should search for this shape:

```text
division
then multiplication by scale
then comparison or invariant check
```

Any code that says "normalize to 18 decimals" after a division is suspect. Normalization should generally happen before the division, using full-precision `mulDiv`.

### Properties and invariant fuzzing

Differential test:

```text
high_precision_invariant(amounts, liquidity, scales)
vs
solidity_invariant(amounts, liquidity, scales)
```

Property:

```solidity
if (solidityInvariantPasses) {
    assertTrue(highPrecisionInvariantPassesWithinTolerance);
}
```

Fuzz ranges:

```text
token decimals in {2, 6, 8, 18}
liquidity in [1e18, 1e36]
amount in [1, 1e18]
```

This is very fuzzable if a high-precision model is present. Without the model, a fuzzer may not know the invariant is wrong.

### Our reading

Numoen is the smallest case in the corpus, but it might be the most common in code review. "Multiply before divide" is a slogan. The deeper rule is: do not let a floor happen before the value has reached the precision domain used by the invariant.

---

## 9. XRPL AMM, 2024: protocol-layer rounding must be specified, not guessed

### Event

In 2024, RippleX disclosed and fixed an XRPL AMM issue through the amendment process. RippleX said the bug had been recreated in unit tests, and a fix with additional invariant checks was developed. Because XRPL AMM is protocol-layer functionality, the fix required amendment voting rather than a normal smart-contract deployment.[^xrpl-ripplex]

XRPL's amendment documentation later described `fixAMMv1_3`, which added AMM invariant checks and explicit rounding rules for deposit and withdrawal operations.[^xrpl-amendments]

### Root cause

The key lesson is specification-level: AMM deposit and withdrawal rounding must be part of the protocol rules.

XRPL's documented fix includes rounding rules like:

```text
deposit:
  LP tokens out round downward
  deposit amount rounds upward

withdraw:
  LP tokens in round upward
  withdrawal amount rounds downward
```

That is the correct direction from a safety perspective: users should not receive more than the exact math allows, and users should not pay less than the exact math requires.

### Code path

This is not an EVM contract path. The relevant references are the XRPL amendment documentation and `rippled` protocol implementation. The public amendment description is the best canonical source for the security behavior because it states the new invariant checks and rounding policy.[^xrpl-amendments]

The conceptual code shape is:

```cpp
// Deposit:
lp_out = floor(exact_lp_out);
asset_in = ceil(exact_asset_in);

// Withdrawal:
lp_in = ceil(exact_lp_in);
asset_out = floor(exact_asset_out);
```

### Exploit path

Public sources describe the issue as a bug fixed before the AMM amendment was fully enabled for normal use at scale, rather than a public malicious drain. The likely exploit class is familiar:

1. Choose a deposit or withdrawal amount near a rounding boundary.
2. Receive too many LP tokens or pay too few assets.
3. Repeat until the AMM balance no longer satisfies its intended invariant.
4. Exit with value if the invariant drift is not checked.

The fact that the issue was protocol-layer makes the prevention bar higher. There is no emergency redeploy for a consensus rule.

### How an audit should have found it

For protocol AMMs, the audit artifact must include a rounding matrix. It is not enough to review code. The spec must say:

```text
Who benefits from each rounding direction?
What exact invariant must hold after each transaction type?
What is the maximum tolerated rounding error?
How is the invariant checked in consensus code?
```

### Properties and invariant fuzzing

A protocol-level fuzz harness should generate transaction sequences:

```text
deposit
withdraw
swap
auction/bid operations if relevant
multi-account LP ownership
```

Properties:

```text
AMM balances satisfy invariant after every accepted transaction.
No account can increase total value through a closed sequence beyond fees.
LP issuance equals floor of exact entitlement.
Withdrawal output equals floor of exact entitlement.
```

Because XRPL has consensus-level code, model-based fuzzing is especially valuable. The reference model should use arbitrary precision rational arithmetic, then compare to the rounded protocol result.

### Our reading

XRPL's fix is a good example of a mature response: make rounding rules explicit and add invariant checks. AMM math that lives in consensus must be specified like cryptography. "The implementation probably rounds the right way" is not a standard.

---

## 10. Abracadabra/MIMSwap MagicLP, 2024: a floor in a branch condition breaks the `I` ratio

### Event

A Code4rena high-severity finding against Abracadabra's MIMSwap, a DODO V2/PMM-like AMM, showed that rounding in `MagicLP.buyShares()` could break the intended `I` ratio and create incorrect target reserves.[^mimswap-issue][^mimswap-report]

### Root cause

The vulnerable branch:

```solidity
shares = quoteBalance < DecimalMath.mulFloor(baseBalance, _I_)
    ? DecimalMath.divFloor(quoteBalance, _I_)
    : baseBalance;
```

The finding gives a crisp example:

```text
quoteBalance = 1
baseBalance  = 19999
I            = 1e14
```

`mulFloor(19999, 1e14)` becomes `1`, so the condition `quoteBalance < 1` is false. The code chooses `shares = baseBalance`, minting `19999` shares and setting target reserves at a ratio far from the intended `I`.

This is not a rounding error in the output alone. It is a rounding error in the branch predicate. Once a branch flips, every later calculation may be on the wrong side of the PMM curve.

### Code path

The public Code4rena issue points to `MagicLP.sol` at commit `1f4693fdbf33e9ad28132643e2d6f7635834c6c6`, around line 381.[^mimswap-issue]

The recommended fix was to use ceiling behavior in the comparison, because the safety question is whether the mathematical product exceeds the quote balance. Floor can hide that excess.

```solidity
// Dangerous:
quoteBalance < mulFloor(baseBalance, I)

// Safer for this predicate:
quoteBalance < mulCeil(baseBalance, I)
```

### Exploit path

The exploit shape:

1. Choose base and quote balances near the comparison boundary.
2. Let `mulFloor(baseBalance, I)` round down to the quote balance.
3. Flip the branch from the quote-limited path to the base-limited path.
4. Mint too many shares or set target reserves with the wrong ratio.
5. Use PMM pricing against the corrupted targets.

The downstream effect is not just an LP accounting error. In PMM designs, target reserves feed price calculation. A bad target reserve can produce bad prices.

### How an audit should have found it

Every fixed-point comparison should be reviewed as a proof obligation:

```text
Does floor preserve this inequality in the safe direction?
Would ceil be required to avoid false negatives?
Could rounding make equality appear where the real number is greater?
```

Search pattern:

```text
if (... mulFloor(...) ...)
if (... divFloor(...) ...)
branch ? pathA : pathB
```

Branch conditions are more dangerous than final outputs because they decide which formula governs the state transition.

### Properties and invariant fuzzing

Local property:

```solidity
// The selected branch must match the high-precision branch.
assertEq(branchSolidity, branchRational);
```

Economic property:

```text
The post-buy-share target reserve ratio must remain within a bounded error of I.
```

Fuzz inputs should include:

```text
quoteBalance = 1..100
baseBalance large
I small, especially below 1e18
values where baseBalance * I / 1e18 has fractional part just below 1
```

This is highly fuzzable with a rational reference model. Without branch-level differential testing, an economic fuzzer may still find it, but it will need to stumble into the boundary.

### Our reading

MIMSwap is the case to remember when someone says "round down is conservative." Conservative for whom? In a branch predicate, floor can be conservative for the attacker.

---

## 11. HydraDX, 2024: when share invariants and stable math disagree

### Event

HydraDX's 2024 Code4rena review surfaced multiple AMM-adjacent issues in its Stableswap/Omnipool system. The most relevant for this corpus are findings around complete liquidity removal, inconsistent one-asset withdrawal calculations, minimum liquidity enforcement, and decimal normalization edge cases.[^hydradx-report][^hydradx-64][^hydradx-38][^hydradx-42][^hydradx-165]

These were audit findings rather than public drains, but they are valuable because HydraDX is a real, complex AMM system and the findings target the state-machine layer around stable math.

### Root cause

The issues are not one single bug. They show a cluster:

1. Some withdrawal paths did not enforce the same minimum pool liquidity constraints as other paths.
2. Some stable math paths could underflow or fail when one reserve approached zero.
3. Different functions produced inconsistent outputs for economically equivalent one-asset withdrawal operations.
4. Decimal normalization could break when asset decimals exceeded assumptions.

The common root is that stable-pool safety is not only a swap invariant. It is a system of invariants over shares, reserves, issuance, oracle entries, and allowed lifecycle states.

### Code path

The public findings point to HydraDX node code at commit `603187123a20e0cb8a7ea85c6a6d718429caad8d`, including:

- `stableswap/math.rs` withdrawal math around one-asset removal.[^hydradx-64][^hydradx-38]
- `pallets/stableswap/src/lib.rs` around `withdraw_asset_amount` and minimum liquidity checks.[^hydradx-42]
- decimal normalization and share price logic when asset decimals exceed 18.[^hydradx-165]

A representative dangerous shape:

```rust
let y = reserve.checked_mul(d1)?.checked_div(d_hp)?.checked_sub(y_hp)?;
```

If one reserve is zero or near zero, the algebraic formula may enter a domain where subtraction is invalid. In a robust implementation, that should be a rejected state, not a surprising runtime failure or inconsistent route.

### Exploit path

Because these were audit findings, the "attacker path" is best described as exploit classes:

- Use withdrawal paths that bypass or weaken minimum liquidity constraints.
- Push a reserve close to zero, then call a one-asset withdrawal function whose math assumes all reserves are positive.
- Use one withdrawal quote path and one execution path that disagree.
- Use unusual decimals to corrupt share-price or oracle calculations.

A real exploit would likely combine these with low liquidity or repeated small operations, not a single large swap.

### How an audit should have found it

HydraDX-style systems require route consistency testing:

```text
remove_liquidity_one_asset(shares, asset)
withdraw_asset_amount(asset_amount)
quote_remove
execute_remove
```

If two routes claim to express the same economic operation, their outputs should agree within documented rounding bounds.

Minimum liquidity must be global:

```text
No withdrawal route may leave total issuance below MinPoolLiquidity.
No reserve may enter a state where stable math is undefined.
```

### Properties and invariant fuzzing

Properties:

```rust
if total_issuance > 0 {
    assert!(total_issuance >= MinPoolLiquidity);
}

for each asset:
    assert!(reserve[asset] > min_reserve || pool_is_closing);

assert_route_equivalence(remove_by_shares, remove_by_amount);
assert_no_underflow_in_valid_states();
```

Fuzz sequences:

```text
add_liquidity
remove_liquidity
remove_one_asset
withdraw_asset_amount
transfer shares between accounts
use assets with decimals 2, 6, 18, 24
```

Invariant fuzzing can find these if the handler includes all withdrawal routes. If the fuzzer only calls swap and balanced add/remove, it will miss the share-state bugs.

### Our reading

HydraDX reinforces a point that AMM audits often underweight: LP share accounting is part of the invariant. A stable pool can have correct swap math and still be vulnerable through withdrawal math.

---

## 12. Blackhole DEX stable pair, 2025: the Solidly zero-`k` class returns

### Event

A 2025 Code4rena report for Blackhole DEX documented a medium-severity issue where a stable pair's invariant `k` could be zero because `_a = (_x * _y) / 1e18` rounded down to zero. The report links `Pair.sol` at commit `92fff849d3b266e609e6d63478c4164d9f608e91` and recommends requiring `_k(_amount0, _amount1) > MINIMUM_K` for stable pools.[^blackhole]

### Root cause

This is the same mathematical class as the Velodrome/Solidly finding:

```solidity
uint256 _a = (_x * _y) / 1e18;
...
return (_a * _b) / 1e18;
```

If `_a` is zero, the whole stable invariant is zero. A pair with `k = 0` has no meaningful stable-curve protection.

### Code path

The Code4rena report references:

- `contracts/Pair.sol#L481` for `_k`.
- `contracts/Pair.sol#L344` for mint/minimum liquidity logic.
- Commit `92fff849d3b266e609e6d63478c4164d9f608e91`.[^blackhole]

This is useful because it gives an immutable public version of the recurring Solidly stable invariant pattern.

### Exploit path

The attack class:

1. Become the first LP with very small stable-pair amounts.
2. Pass generic minimum liquidity checks.
3. Create a pool state where `_k == 0`.
4. Use swaps or repeated initialization/drain patterns to remove residual assets or DoS the pool.
5. Repeat as needed.

The finding notes a drain pattern where the first LP can repeatedly seed tiny liquidity and steal what remains.

### How an audit should have found it

The audit should assert that stable-pair initialization implies:

```text
_k(amount0, amount1) > 0
_k(amount0, amount1) >= protocol_minimum_k
```

For Solidly forks, this should be a standard checklist item. It is no longer obscure.

### Properties and invariant fuzzing

Property:

```solidity
function invariant_stable_k_nonzero() external {
    if (pair.stable() && pair.totalSupply() > 0) {
        assertGt(pair.k(), MINIMUM_K);
    }
}
```

Fuzzer bias:

```text
first LP deposits
tiny amounts
different decimals
swap immediately after first mint
burn and re-mint
```

This is one of the easiest classes for invariant fuzzing to catch, provided the harness does not filter out tiny initial deposits as "unrealistic." Attackers specialize in unrealistic states that the code accepts.

### Our reading

Blackhole shows why vulnerability classes should become regression tests across forks. Once a mathematical bug appears in a forkable AMM design, every descendant should inherit the test, not only the code.

---

## 13. Cetus Protocol, 2025: silent shift truncation mints enormous CLMM liquidity

### Event

On May 22, 2025, Cetus Protocol on Sui was exploited for more than $200 million. Dedaub's analysis attributes the root cause to a flawed overflow check in CLMM liquidity math, specifically `get_delta_a` in `clmm_math.move`, where a left shift could silently truncate a `u256` value.[^cetus-dedaub] Other analyses report that a large portion of funds was frozen or recovered, but the core technical failure was the liquidity calculation.[^cetus-cyfrin][^cetus-owasp]

### Root cause

The vulnerable function computed the token A amount required for a liquidity position over a price range:

```move
sqrt_price_diff = sqrt_price_1 - sqrt_price_0;
numerator = checked_shlw(liquidity * sqrt_price_diff);
denominator = sqrt_price_0 * sqrt_price_1;
amount_a = div_round(numerator, denominator, round_up);
```

The intended scaling was a left shift by 64. The issue was that `checked_shlw` used an incorrect overflow check. Values above `2^192` should fail before `<< 64`, because shifting them left by 64 exceeds 256 bits. Instead, the guard allowed a range of values where the shift truncated modulo `2^256`.

The result:

```text
huge liquidity * sqrt_price_diff ~= 2^192 + epsilon
left shift by 64 truncates to epsilon
required token amount becomes tiny
```

Dedaub shows concrete values where the attacker created a massive liquidity position while the computed required token amount collapsed.[^cetus-dedaub]

### Code path

Primary public references:

- `clmm_math.move::get_delta_a`, as described by Dedaub.[^cetus-dedaub]
- `integer-mate::checked_shlw`, the custom shift helper with the flawed mask.[^cetus-integer-mate]
- OWASP's 2026 integer overflow/underflow entry also uses Cetus as a non-EVM example and shows the corrected check: reject if `n >= 1 << 192` before shifting left by 64.[^cetus-owasp]

Vulnerable shape:

```move
public fun checked_shlw(n: u256): (u256, bool) {
    let mask = 0xffffffffffffffff << 192;
    if (n > mask) {
        (0, true)
    } else {
        ((n << 64), false)
    }
}
```

Safer shape:

```move
if (n >= (1 << 192)) {
    overflow
} else {
    n << 64
}
```

### Exploit path

The exploit shape:

1. Select a tick range and liquidity value such that `liquidity * sqrt_price_diff` lands just above the safe 192-bit boundary.
2. Let `checked_shlw` fail to detect that `<< 64` will overflow/truncate.
3. Obtain a very small computed token A requirement, in some analyses effectively one unit.
4. Mint a massive CLMM liquidity position for tiny input.
5. Remove that liquidity for real pool assets.
6. Use flash-swap mechanics and repayment to complete the transaction.

This is not a rounding-direction bug in the usual EVM fixed-point sense. It is still a fixed-point AMM math bug because Q-format scaling and bit-width assumptions determined the economic result.

### How an audit should have found it

For CLMM math, auditors need bit-width proofs:

```text
max(liquidity) * max(sqrt_price_diff) < 2^192
before << 64
```

If that cannot be proven from input constraints, the code must use full-precision math or reject the operation.

Every custom overflow helper should be treated as suspicious. Languages with checked arithmetic can still have unchecked shift behavior. The question is not "does multiplication overflow?" but "does every scaling operation preserve the intended integer?"

### Properties and invariant fuzzing

Local property:

```text
For any liquidity L and price range, if get_delta_a returns 0 or 1 for a massive L, the operation must be rejected unless the high-precision model agrees.
```

Differential property:

```text
move_get_delta_a == rational_model_get_delta_a rounded by policy
```

Fuzz domains:

```text
liquidity near 2^112..2^128
sqrt_price_diff near 2^64..2^96
product near 2^192 - 1
product near 2^192
product near 2^192 + 1
```

Economic invariant:

```text
minted_liquidity <= liquidity_equivalent_of(actual_tokens_paid, price_range) + epsilon
```

Could invariant fuzzing find it? Yes, but only if it explores large values near bit boundaries. Random fuzzing over `u128` may not hit `2^192 + epsilon` products. A guided boundary generator is essential.

### Our reading

Cetus is a reminder that Move's safety properties do not eliminate arithmetic design risk. If a protocol implements custom fixed-point scaling, the proof obligation moves from "Solidity overflow" to "all bit shifts and truncations match the math."

---

## 14. Bunni V2, 2025: locally safe rounding, globally exploitable liquidity

### Event

On September 2, 2025, Bunni V2 was exploited for about $8.4 million across two pools: weETH/ETH on Unichain and USDC/USDT on Ethereum. Bunni's post-mortem explains the exploit in three stages: price manipulation with flash-borrowed funds, 44 tiny withdrawals that exploited rounding, and a sandwich that converted an erroneous liquidity decrease into profit.[^bunni-official]

### Root cause

The key vulnerable line was in `BunniHubLogic::withdraw()`:

```solidity
uint256 newBalance = balance - balance.mulDiv(shares, currentTotalSupply);
```

The decrease amount was rounded down. During development, this looked safe because rounding down the idle-balance decrease effectively rounded up idle balance and rounded down active balance. Lower active liquidity seemed conservative because it increases price impact against traders.

That reasoning was local. The attacker found a sequence where the locally conservative underestimation became a globally unsafe liquidity increase.

### Code path

Bunni's post-mortem links the exact line and shows the intended mitigation:

```diff
- uint256 newBalance = balance - balance.mulDiv(shares, currentTotalSupply);
+ uint256 newBalance = balance - balance.mulDivUp(shares, currentTotalSupply);
```

Bunni also describes its total liquidity computation from active balances and LDF densities:

```solidity
uint256 totalLiquidityEstimate0 = noToken0 ? 0 : balance0.fullMulDiv(Q96, totalDensity0X96);
uint256 totalLiquidityEstimate1 = noToken1 ? 0 : balance1.fullMulDiv(Q96, totalDensity1X96);
bool useLiquidityEstimate0 =
    (totalLiquidityEstimate0 < totalLiquidityEstimate1 || totalDensity1X96 == 0)
    && totalDensity0X96 != 0;
```

The pool uses the smaller estimate. Again, locally this seems conservative. Globally, a later price move can switch which estimate is selected, reversing the underestimation.

The public Bunni V2 repository now warns that the code has been exploited and should not be used in production as-is.[^bunni-repo]

### Exploit path

Bunni's own reconstruction for the USDC/USDT pool is precise:

1. Flashborrow 3 million USDT and swap USDT to USDC, pushing the spot tick to `5000` and reducing the active USDC balance to 28 wei.
2. Perform 44 tiny withdrawals. Rounding reduces active USDC from 28 wei to 4 wei, an 85.7% decrease, while burning a disproportionately small amount of shares. Total liquidity falls from `5.83e16` to `9.114e15`.
3. Make a large swap that moves the tick to `839189`. The total liquidity estimate switches and rises to `1.065e16`, a 16.8% increase over the artificially depressed value.
4. Reverse swap at inflated conditions and extract profit. Bunni reports post-flashloan profit around 1.33 million USDC and 1 million USDT in the example.[^bunni-official]

### How an audit should have found it

The audit should not stop at asking whether each rounding direction favors the pool in isolation. It should ask:

```text
Can a rounded state variable later be selected out, switched, reset, or reversed?
```

For Bunni specifically, the dangerous variables were:

```text
idle balance
active balance
totalLiquidityEstimate0
totalLiquidityEstimate1
selected liquidity estimate
spot tick
LDF density
```

The review should have tested sequences that combine swaps and withdrawals, especially in low active-balance states.

### Properties and invariant fuzzing

Bunni's post-mortem states that they had Foundry and Medusa fuzz tests, but the tests did not cover the exploit scenario and that a better invariant framework was needed.[^bunni-official]

Useful properties:

```solidity
// Tiny withdrawals cannot reduce active liquidity disproportionally.
assertLe(
    liquidity_drop_value,
    shares_burned_value + rounding_bound
);

// A sequence of withdrawals with no external value extraction cannot create
// a later sandwichable liquidity increase.
assertNoAtomicLiquidityIncreaseProfit();
```

Handler sequence:

```text
flash-borrow-like setup or large external swap
swap to extreme tick
withdraw tiny shares N times
large swap
reverse swap
repay
```

Fuzzing can find it, but only if the fuzzer is allowed to:

- push the pool to extreme ticks,
- make many tiny withdrawals,
- perform a sandwich sequence,
- optimize for economic profit, not just assertion failure.

A pure local unit fuzzer is unlikely to find it.

### Our reading

Bunni is one of the most valuable incidents in the modern AMM literature because it kills a comforting myth: "rounding in favor of the pool" is not a local property. Rounding direction must be evaluated over adversarial sequences.

---

## 15. Balancer V2 Composable Stable Pools, 2025: `_upscale` rounded down until $120M disappeared

### Event

On November 3, 2025, specific Balancer V2 stable pools and forks were exploited for more than $120 million. OpenZeppelin's technical analysis identifies the core issue as rounding behavior in `_upscale`, combined with Composable Stable Pools, Vault `batchSwap`, transient settlement, low-liquidity states, and BPT being a pool asset.[^balancer-2025-oz] Coinspect and other researchers describe the attack as a long sequence of alternating batch swaps that manipulated exchange rates and underestimated invariant value.[^balancer-2025-coinspect]

### Root cause

Balancer's `_upscale` helper did this:

```solidity
function _upscale(uint256 amount, uint256 scalingFactor) pure returns (uint256) {
    return FixedPoint.mulDown(amount, scalingFactor);
}
```

The inline comment acknowledged that rounding direction may differ by context: token-in balances may need rounding up, token-out balances down. But the helper rounded down everywhere.

That was tolerable when `scalingFactor` was only a decimal factor such as `1e12`. It became unsafe when Composable Stable Pools overrode `_scalingFactors()` so that scaling factors also included token exchange rates:

```solidity
scalingFactors[i] = _getScalingFactor(i).mulDown(_getTokenRate(i));
```

Now scaling factors were non-unitary rates. In low-liquidity exact-out paths, `mulDown` could erase a meaningful percentage of the required input. OpenZeppelin gives an example where `amount = 17` and `scalingFactor ~= 1.058e18`; the exact scaled amount is about `17.98`, but Solidity truncates it to `17`.[^balancer-2025-oz]

### Code path

Primary references:

- `ScalingHelpers.sol::_upscale`, which returns `FixedPoint.mulDown(amount, scalingFactor)`.[^balancer-2025-code]
- OpenZeppelin's analysis of `_scalingFactors()` and its exchange-rate override.[^balancer-2025-oz]
- Commits identified by OpenZeppelin as introducing the attack vector across MetaStable, Linear, and StablePhantom/Composable Stable pools: `059284e`, `4e9e70a`, and `f450760`.[^balancer-2025-oz][^balancer-commit-059][^balancer-commit-4e9][^balancer-commit-f450]

The exact vulnerable behavior is contextual:

```text
Vault.batchSwap
  -> _swapWithPools
  -> pool.onSwap
  -> _swapGivenOut
  -> _upscale(amount, scalingFactor)
  -> amount owed is deflated by floor rounding
```

### Exploit path

The exploit shape, based on OpenZeppelin's trace-level description:

1. Use BPT swaps to push target token balances into low-liquidity states.
2. Run repeating batch-swap triplets: prime, exploit, reset.
3. In the exploit leg, use small exact-out amounts, often values like `17`, where `amount * scalingFactor / 1e18` loses almost a full unit.
4. Let `_swapGivenOut` compute a deflated amount owed by the attacker.
5. Accumulate favorable deltas during `batchSwap` transient settlement.
6. Withdraw or settle internal balances after the batch.

The attack needed multiple circumstances, but the root cause was not the existence of `batchSwap`. Batch settlement was the amplifier. Rounding direction was the bug.

### How an audit should have found it

The review should have built a rounding matrix for every swap type:

```text
exact in:
  user input accounting: round up or neutral
  user output: round down

exact out:
  required user input: round up
  user output accounting: round down

join:
  assets paid: round up
  BPT received: round down

exit:
  BPT burned: round up
  assets received: round down
```

Then compare `_upscale` usage against that matrix. A single helper that always rounds down is suspicious when it is used on both sides of a swap.

The second audit lens is "non-unitary scaling factor." A helper designed for decimal scaling may not be safe once exchange rates enter the scaling factor.

### Properties and invariant fuzzing

Useful properties:

```solidity
// Exact-out swaps must not undercharge input compared to high-precision model.
requiredInSolidity >= floor_or_ceil_policy(requiredInReference);

// A batch with zero net external value cannot increase attacker internal balances.
assertLe(attackerValueAfter, attackerValueBefore + fees + epsilon);
```

Fuzz sequences must include:

```text
batchSwap with multiple hops
BPT as pool asset
exact-out swaps
low target balances
amounts below 100 units
rate providers with non-1e18 exchange rates
```

This is fuzzable, but only with batch-aware stateful fuzzing. A one-swap differential test might catch the wrong rounding direction. A full economic invariant is needed to capture the exploitability.

### Our reading

Balancer 2025 is the strongest case for treating comments as security evidence. `_upscale` warned that rounding might need to go in different directions. Years later, a pool type changed the assumptions that made the shortcut safe. The code still compiled. The invariant did not survive.

---

## 16. Yearn yETH, 2025: fixed-point iteration, `Π = 0`, unsafe arithmetic, and bootstrap re-entry

### Event

On November 30, 2025, Yearn's yETH weighted stableswap pool was exploited for about $9 million. Yearn's official disclosure states that the exploit occurred at Ethereum mainnet block `23,914,086`, that Yearn v2/v3 vaults were not affected, and that the impact was isolated to yETH and direct integrations.[^yearn-official]

Public analyses describe a multi-phase attack: first over-mint yETH LP by causing numerical failure in the invariant solver, then drain LST assets, then re-enter a bootstrap path after supply reached zero and mint an astronomical amount of yETH from a dust deposit.[^yearn-blocksec][^yearn-checkpoint][^yearn-poc]

### Root cause

This was a compound failure. The core mathematical bug lived in `_calc_supply()`, an iterative fixed-point solver for the pool's internal supply invariant `D`. The solver tracked:

```text
Σ  = sum of virtual balances
Π  = weighted product term over virtual balances
D  = supply/invariant scale
A  = amplification
```

The solver relied on domain and convergence assumptions that were not enforced on-chain:

```text
A * Σ >= D * Π
Π must not collapse to zero in a live pool
iterations must remain in a stable region
```

There were two major numerical failure modes.

#### Failure mode A: product term collapse

In extreme imbalance, the iteration update for the product term could floor to zero:

```vyper
r = unsafe_div(unsafe_mul(r, sp), s)
```

If `sp` becomes much smaller than `s`, repeated product updates can push `r` below one fixed-point unit and then to zero. Once `Π = 0`, the solver degenerates toward constant-sum behavior:

```text
D_next = (A * Σ - D * 0) / (A - 1)
```

For a severely imbalanced weighted stableswap pool, that can over-mint LP shares.

#### Failure mode B: unsafe subtraction underflow

Later, after the pool's supply was driven to zero and the bootstrap branch became reachable again, the attacker used dust balances that made:

```text
A * Σ - D * Π < 0
```

In safe arithmetic, this should revert. In the vulnerable Vyper code, `unsafe_sub` allowed the domain violation to wrap into a huge unsigned integer, leading to an astronomical supply calculation.

### Code path

Primary references:

- Yearn's official disclosure, which lists root causes including solver domain failure, re-enterable bootstrap path, POL-driven accounting, and unsafe math.[^yearn-official]
- BlockSec's detailed analysis of `_calc_supply()` and the two arithmetic failure modes.[^yearn-blocksec]
- Public PoC repository `johnnyonline/yETH-hack`, which states that replacing unsafe math with safe arithmetic causes the attack test to revert.[^yearn-poc]
- Yearn yETH contract repository.[^yearn-repo]

A simplified vulnerable solver shape:

```vyper
l = amplification * vb_sum
d = amplification - PRECISION
s = supply
r = vb_prod

for _ in range(255):
    sp = unsafe_div(
        unsafe_sub(l, unsafe_mul(s, r)),
        d
    )

    for i in range(num_assets):
        r = unsafe_div(unsafe_mul(r, sp), s)

    if converged:
        return sp, r

    s = sp
```

The dangerous facts:

```text
unsafe_sub does not enforce A * Σ >= D * Π
unsafe_div floors product updates to zero
Π = 0 is accepted as state
bootstrap uses prev_supply == 0 as lifecycle gate
```

### Exploit path

The full exploit is best understood as three phases.

#### Phase 1: prepare extreme imbalance

The attacker used large LST and WETH liquidity to push virtual balances far away from target weights. The purpose was not immediate profit. It was to move the solver into a region where fixed-point iteration would no longer behave like the intended real-number model.

#### Phase 2: collapse `Π`, over-mint, and shift correction to POL/staking

The attacker used imbalanced `add_liquidity()` calls to push the product term toward zero. Once `Π` collapsed, the pool minted too much yETH LP.

Then a crucial state asymmetry was used:

```text
add_liquidity()      -> incremental product update can be polluted
remove_liquidity(0)  -> recomputes product from balances and can "repair" Π
update_rates()       -> reconciles supply using staking/POL side accounting
```

`remove_liquidity(0)` repaired `Π` without undoing the attacker's over-minted LP. `update_rates()` then corrected the inflated supply by burning from the staking/POL side rather than the attacker's wallet. This made the attacker's relative share larger.

The loop drained real LST assets and eventually drove supply to zero.

#### Phase 3: re-enter bootstrap and underflow

Once `prev_supply == 0`, the pool's initialization path became reachable again. The attacker deposited dust, commonly described in analyses as a tiny vector summing to 16 wei-equivalent virtual balance. The resulting state violated `A * Σ >= D * Π`. `unsafe_sub` wrapped the negative result, and the solver minted around `2.35e56` yETH LP, which was then used to drain the yETH/WETH Curve pool.[^yearn-blocksec][^yearn-checkpoint][^yearn-poc]

### How an audit should have found it

Yearn yETH requires multiple audit lenses.

#### Solver domain review

Every iterative solver needs explicit domain checks:

```solidity
require(A * sigma >= D * product);
require(product > 0 || supply == 0);
require(nextD <= maxGrowthBound * previousD);
require(iterationConvergedWithinBound);
```

A solver that "usually converges" in a Python notebook is not a safe on-chain solver.

#### Unsafe arithmetic review

Unsafe arithmetic in invariant-critical code should be treated as high risk unless the preconditions are asserted immediately above the operation.

```vyper
# Bad:
unsafe_sub(l, s * r)

# Acceptable only if:
assert l >= s * r
l - s * r
```

#### Lifecycle review

Initialization must not be gated only by `totalSupply == 0` or `prev_supply == 0`.

```solidity
bool initialized;

if (!initialized) {
    initialized = true;
    bootstrap();
} else {
    require(totalSupply > MIN_LIVE_SUPPLY);
}
```

#### State-asymmetry review

Any zero-amount call that mutates critical accounting deserves suspicion:

```text
remove_liquidity(0)
update_rates()
sync()
skim()
poke()
rebalance()
```

The question is:

```text
Can a user repair one part of state while preserving another corrupted part?
```

### Properties and invariant fuzzing

Yearn is absolutely fuzzable, but only with stateful, economic, multi-call fuzzing.

Core properties:

```solidity
// No free value.
assertLe(attackerValueOut, attackerValueIn + fees + epsilon);

// Live pool product cannot be zero.
if (supply > 0) {
    assertGt(vb_prod, 0);
}

// Solver domain must hold.
assertGe(A * sigma, D * product);

// LP minted must be economically bounded.
assertLe(lpMintedValue, depositValue * MAX_REASONABLE_MULTIPLIER);

// Bootstrap only once.
assert(initialized || supply == 0);
```

Handler actions:

```text
add_liquidity balanced
add_liquidity imbalanced
remove_liquidity
remove_liquidity(0)
update_rates
trigger rebasing/rate changes
dust deposit after low supply
```

Fuzz seeds should include:

```text
extreme imbalance
very low virtual balances in some assets
high balances in others
supply near zero
zero amount remove
rate update after add/remove
```

The public PoC repository mentions invariant fuzzing concepts and demonstrates that safe arithmetic causes the exploit to revert.[^yearn-poc] A strong no-free-value invariant with the right handler actions should find a reduced variant of the issue.

### Our reading

Yearn yETH is the most complete fixed-point AMM failure in the corpus. It was not one bug. It was a chain: solver domain assumptions, product collapse, unsafe arithmetic, state asymmetry, POL reconciliation, and bootstrap lifecycle failure. The takeaway is equally broad: numerical correctness, lifecycle correctness, and economic correctness must be tested together. Any one of them alone would have given a false sense of safety.

---

## 17. Cross-case invariant library

The following properties are reusable across many AMM designs.

### 17.1 No free value

```solidity
function invariant_noFreeValue() external {
    uint256 beforeValue = ghost.attackerValueBefore();
    uint256 afterValue = valueOf(attacker);
    assertLe(afterValue, beforeValue + protocolFeesEarned + EPSILON);
}
```

This is the most important invariant, but also the hardest. It needs a robust valuation function.

### 17.2 Nonzero live invariant terms

```solidity
if (totalSupply > 0) {
    assertGt(k, 0);
    assertGt(productTerm, 0);
    assertGt(sumTerm, 0);
}
```

Useful for Yearn, Solidly, Blackhole, DFX-like zero-transfer paths.

### 17.3 Actual asset delta matches accounting delta

```solidity
uint256 balBefore = token.balanceOf(address(pool));
uint256 shares = pool.deposit(...);
uint256 balAfter = token.balanceOf(address(pool));

if (shares > 0) {
    assertGt(balAfter - balBefore, 0);
}
```

Useful for DFX, fee-on-transfer assets, ERC4626 wrappers, rebasing wrappers.

### 17.4 Route equivalence

```text
value(routeA(x -> y)) <= value(routeB(x -> y)) + fee_bound + epsilon
```

Useful for MetaPools, underlying swaps, remove-one-token paths, routers.

### 17.5 Rounding matrix compliance

For every operation, define who pays and who receives. Then assert:

```text
user pays    -> ceil or protocol-favoring
user receives -> floor or protocol-favoring
```

Useful for Balancer 2025, XRPL AMM, MIMSwap, Numoen.

### 17.6 CLMM boundary consistency

```text
production_tick_crossing_decision == high_precision_tick_crossing_decision
```

Fuzz:

```text
amountToCross - 1
amountToCross
amountToCross + 1
```

Useful for Kyber and Cetus-like CLMM math.

### 17.7 Bootstrap cannot re-enter

```solidity
if (initialized) {
    assertFalse(inBootstrapPath);
}
```

Useful for Yearn, first-LP stable pairs, rate-reset pools.

### 17.8 Low-liquidity amplification guard

```solidity
if (balance[i] < LOW_BALANCE_THRESHOLD) {
    assertNoLargeRateOrLiquidityChange();
}
```

Useful for Balancer 2023, Balancer 2025, Bunni, Solidly-style pools.

---

## 18. Can invariant fuzzing find these bugs?

The honest answer is: yes, but only if the harness is adversarial enough.

### Easy for invariant fuzzing

- DFX zero-transfer mint.
- Solidly/Velodrome/Blackhole zero-`k`.
- Numoen precision mismatch, with a high-precision model.
- MIMSwap branch mismatch, with a rational model.
- XRPL-style rounding matrix violations.

These require good input domains more than long sequences.

### Medium difficulty

- MetaPool route inconsistency.
- Balancer 2023 rate reset.
- HydraDX withdrawal/share inconsistencies.

These require multi-route handlers and a value oracle inside the test.

### Hard, but possible

- Kyber CLMM tick boundary.
- Cetus bit-boundary overflow.
- Bunni multi-step rounding reversal.
- Balancer 2025 batch-swap amplification.
- Yearn yETH solver/POL/bootstrap chain.

These need guided generators, deep sequences, and sometimes optimization. A random stateful fuzzer may miss them. A property-driven fuzzer with boundary seeds has a real chance.

The practical recipe:

```text
1. Build a high-precision model for the math.
2. Build a handler that includes every economically meaningful route.
3. Bias toward 1 wei, low balances, low supply, max liquidity, and boundary ticks.
4. Add ghost accounting for attacker value.
5. Let the fuzzer compose sequences, not just calls.
6. Shrink failures into human-readable traces.
```

---

## 19. Adjacent incidents that should not be over-classified

These incidents are important, but they are not central fixed-point AMM failures under the taxonomy used in this post.

### Curve/Vyper, 2023

Curve pools were exploited after a Vyper compiler nonreentrancy bug affected certain versions. This was an AMM incident, but the root cause was a compiler-level reentrancy lock failure, not AMM rounding or invariant precision.[^curve-vyper]

### Platypus, 2023

Platypus was exploited through a solvency-check flaw around USP collateral, with about $8.5 million reported lost in Immunefi's analysis. It involved a stablecoin protocol and AMM-adjacent components, but the root cause was collateral/solvency logic rather than fixed-point AMM math.[^platypus]

### WOOFi, 2024

WOOFi's incident is AMM-pricing-adjacent and useful for studying algorithmic market-maker risk, but public writeups generally frame it around sPMM pricing, fallback, and low-liquidity risk rather than a pure fixed-point rounding primitive.[^woofi]

### Cork Protocol, 2025

Cork's Uniswap v4 hook exploit is relevant to AMM security, but Dedaub and OWASP describe the root cause as missing validation/access control on hook callbacks, not fixed-point math.[^cork-dedaub][^cork-owasp]

### Panoptic position spoofing, 2025

Panoptic's position-spoofing issue is closely related to Uniswap LP positions and collateral accounting. Public summaries describe the root as position validation/fingerprinting and collateral-check bypass, not AMM invariant precision.[^panoptic]

The reason to name these cases is to prevent taxonomy drift. Good incident research should know what belongs in a class and what only looks similar from a distance.

---

## 20. Final synthesis

Across all cases, the most dangerous AMM state variables are:

```text
D
k
Π
I
sqrtPriceX96 / sqrtPriceQ64
tick
totalLiquidity
virtualBalance
BPT / LP totalSupply
rate / virtualPrice
cached balances
target reserves
active vs idle balance
```

The most dangerous amplifiers are:

```text
flash loans
batch swaps
deferred settlement
low liquidity
low or zero supply
LP token as a pool asset
ERC4626 / LST / wrapper rate providers
low-decimal tokens
dust deposits and withdrawals
remove_liquidity(0)
rate update / rebase / POL reconciliation
custom hooks and LDFs
max liquidity near bit-width boundaries
```

The strongest single audit heuristic is:

> If a rounding error can change a stored state variable, assume it can become profit until an invariant proves otherwise.

The strongest single design heuristic is:

> Normalize once, compute in one domain, round according to a written matrix, and reject every solver state outside its mathematical domain.

The strongest single testing heuristic is:

> Do not fuzz "normal users." Fuzz the states the protocol wishes were unreachable: one wei balances, zero supply, tiny first LP deposits, max liquidity, exact tick boundaries, and batch sequences that repair one state variable while preserving another corrupted one.

Fixed-point AMM security is hard because the code is often locally reasonable. Each function looks defensible. Each rounding direction has an argument. Each helper has a comment. The attacker does not attack the comment. The attacker attacks the composition.

That is the heart of the research: one wei is rarely the loss. One wei is the proof.

---

## References

[^synapse]: Synapse Protocol, "11/06/2021 Post-mortem of Synapse MetaPool Exploit", https://medium.com/synapse-protocol/11-06-2021-post-mortem-of-synapse-metapool-exploit-3003b4df4ef4

[^nerve-blocksec]: BlockSec, "The Analysis of Nerve Bridge Security Incident", https://blocksec.com/blog/the-analysis-of-nerve-bridge-security-incident

[^nerve-saddle-blocksec]: BlockSec, "How to Exploit the Same Vulnerability of MetaPool in Two Different Ways: Nerve Bridge and Saddle Finance", https://blocksec.com/blog/how-to-exploit-the-same-vulnerability-of-meta-pool-in-two-different-ways-nerve-bridge-saddle-finance-what-you-see-is-not-what-you-get

[^saddle-immunefi]: Immunefi, "Hack Analysis: Saddle Finance, April 2022", https://medium.com/immunefi/hack-analysis-saddle-finance-april-2022-f2bcb119f38

[^saddle-vuln]: Saddle Finance vulnerable `MetaSwapUtils.sol`, commit `141a00e7ba0c5e8d51d8018d3c4a170e63c6c7c4`, https://github.com/saddle-finance/saddle-contract/blob/141a00e7ba0c5e8d51d8018d3c4a170e63c6c7c4/contracts/meta/MetaSwapUtils.sol

[^saddle-patched]: Saddle Finance patched `MetaSwapUtils.sol`, commit `7b7060e45be2ec3c9bcdf16240acf13394204571`, https://github.com/saddle-finance/saddle-contract/blob/7b7060e45be2ec3c9bcdf16240acf13394204571/contracts/meta/MetaSwapUtils.sol

[^saddle-pr]: Saddle Finance PR #469, https://github.com/saddle-finance/saddle-contract/pull/469

[^velodrome-spearbit]: Spearbit / Velodrome Finance Security Review, section "First liquidity provider of a stable pair can DOS the pool", https://www.studocu.vn/vn/document/truong-dai-hoc-bach-khoa-ha-noi/ly-thuyet-mat-ma/velodrome-spearbit-security-review/106184882

[^blackhole]: Code4rena, "Blackhole DEX" report, M-06 stable invariant zero issue, https://code4rena.com/reports/2025-05-blackhole

[^dfx-immunefi]: Immunefi, "DFX Finance Rounding Error Bugfix Review", https://medium.com/immunefi/dfx-finance-rounding-error-bugfix-review-17ba5ffb4114

[^dfx-code]: DFX Finance `AssimilatorV2.sol`, public repository reference, https://github.com/dfx-finance/protocol-v2/blob/main/src/assimilators/AssimilatorV2.sol

[^balancer-2023]: Immunefi, "Balancer Rounding Error Bugfix Review", https://immunefi.com/blog/bug-fix-reviews/balancer-rounding-error/

[^balancer-2023-poc]: Immunefi bugfix PoC repository for Balancer rounding error, https://github.com/immunefi-team/bugfix-reviews-pocs/tree/main/src/Balancer/rounding-error-aug2023

[^kyber-official]: KyberSwap, "Post-Mortem: KyberSwap Elastic Exploit", https://blog.kyberswap.com/post-mortem-kyberswap-elastic-exploit/

[^kyber-blocksec]: BlockSec, "Yet Another Tragedy of Precision Loss: An In-Depth Analysis of the KyberSwap Incident", https://blocksec.com/blog/yet-another-tragedy-of-precision-loss-an-in-depth-analysis-of-the-kyber-swap-incident-1

[^kyber-sherlock]: Sherlock issue discussing Kyber `computeSwapStep`, https://github.com/sherlock-audit/2023-07-kyber-swap-judging/issues/161

[^kyber-repo]: KyberNetwork `ks-elastic-sc` repository, https://github.com/KyberNetwork/ks-elastic-sc

[^numoen-report]: Code4rena, "Numoen" report, https://code4rena.com/reports/2023-01-numoen

[^numoen-issue]: Code4rena Numoen finding #264, with code path to `Pair.sol`, https://github.com/code-423n4/2023-01-numoen-findings/issues/264

[^xrpl-ripplex]: RippleX, "Update on the XRP Ledger AMM Bug and the Path Forward", https://dev.to/ripplexdev/update-on-the-xrp-ledger-amm-bug-and-the-path-forward-hkb

[^xrpl-amendments]: XRPL, "Known Amendments", `fixAMMv1_3`, https://xrpl.org/resources/known-amendments

[^mimswap-issue]: Code4rena Abracadabra/MIMSwap finding #221, https://github.com/code-423n4/2024-03-abracadabra-money-findings/issues/221

[^mimswap-report]: Code4rena, "Abracadabra Money" report, https://code4rena.com/reports/2024-03-abracadabra-money

[^hydradx-report]: Code4rena, "HydraDX" report, https://code4rena.com/reports/2024-02-hydradx

[^hydradx-64]: HydraDX finding #64, "Initial liquidity can never be fully withdrawn", https://github.com/code-423n4/2024-02-hydradx-findings/issues/64

[^hydradx-38]: HydraDX finding #38, one-asset withdrawal inconsistency, https://github.com/code-423n4/2024-02-hydradx-findings/issues/38

[^hydradx-42]: HydraDX finding #42, `MinPoolLiquidity` bypass in `withdraw_asset_amount`, https://github.com/code-423n4/2024-02-hydradx-findings/issues/42

[^hydradx-165]: HydraDX finding #165, decimals greater than 18 affecting share price, https://github.com/code-423n4/2024-02-hydradx-findings/issues/165

[^cetus-dedaub]: Dedaub, "The Cetus AMM $200M Hack: How a Flawed Overflow Check Led to Catastrophic Loss", https://dedaub.com/blog/the-cetus-amm-200m-hack-how-a-flawed-overflow-check-led-to-catastrophic-loss/

[^cetus-cyfrin]: Cyfrin, "Cetus Hack Analysis", https://www.cyfrin.io/blog/cetus-hack-analysis

[^cetus-owasp]: OWASP Smart Contract Top 10 2026, integer overflow/underflow, Cetus example, https://github.com/OWASP/www-project-smart-contract-top-10/blob/main/2026/en/src/SC09-integer-overflow-underflow.md

[^cetus-integer-mate]: CetusProtocol `integer-mate` repository, https://github.com/CetusProtocol/integer-mate

[^bunni-official]: Bunni, "Exploit Post Mortem", https://blog.bunni.xyz/posts/exploit-post-mortem/

[^bunni-repo]: Bunni V2 repository, https://github.com/Bunniapp/bunni-v2

[^balancer-2025-oz]: OpenZeppelin, "Understanding the Balancer v2 Exploit", https://www.openzeppelin.com/news/understanding-the-balancer-v2-exploit

[^balancer-2025-coinspect]: Coinspect, "Balancer Rate Manipulation Exploit", https://www.coinspect.com/blog/balancer-rate-manipulation-exploit/

[^balancer-2025-code]: Balancer `ScalingHelpers.sol::_upscale`, https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/solidity-utils/contracts/helpers/ScalingHelpers.sol

[^balancer-commit-059]: Balancer commit `059284e75dce88071f90950379cc13170f172c98`, https://github.com/balancer/balancer-v2-monorepo/commit/059284e75dce88071f90950379cc13170f172c98

[^balancer-commit-4e9]: Balancer commit `4e9e70a8f0782b15ae3d0402280c4aa5b8cd4a01`, https://github.com/balancer/balancer-v2-monorepo/commit/4e9e70a8f0782b15ae3d0402280c4aa5b8cd4a01

[^balancer-commit-f450]: Balancer commit `f45076067b68b27ea023632e69349e3051746cd4`, https://github.com/balancer/balancer-v2-monorepo/commit/f45076067b68b27ea023632e69349e3051746cd4

[^yearn-official]: Yearn security disclosure, "2025-12-01 yETH exploit", https://github.com/yearn/yearn-security/blob/master/disclosures/2025-12-01.md

[^yearn-blocksec]: BlockSec, "Yearn Finance Incident: Unsafe Arithmetic in the Invariant Solver Earns Its Name", https://blocksec.com/zh/blog/yearn-finance-incident-unsafe-arithmetic-in-the-invariant-solver-earns-its-name

[^yearn-poc]: Public yETH exploit PoC, https://github.com/johnnyonline/yETH-hack

[^yearn-repo]: Yearn yETH contracts repository, https://github.com/yearn/yETH

[^yearn-checkpoint]: Check Point Research, "The $9M yETH Exploit: How 16 Wei Became Infinite Tokens", https://research.checkpoint.com/2025/16-wei/

[^curve-vyper]: Vyper team, "Vyper Nonreentrancy Lock Vulnerability Technical Post-Mortem", https://hackmd.io/@vyperlang/HJUgNMhs2

[^platypus]: Immunefi, "Hack Analysis: Platypus Finance, February 2023", https://immunefi.com/blog/industry-trends/platypus-finance-hack-analysis/

[^woofi]: Cyfrin, "Hack Analysis into WOOFi Exploit", https://www.cyfrin.io/blog/hack-analysis-into-woofi-exploit

[^cork-dedaub]: Dedaub, "The $11M Cork Protocol Hack: A Critical Lesson in Uniswap V4 Hook Security", https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/

[^cork-owasp]: OWASP Smart Contract Top 10 2026, access-control example for Cork Protocol, https://scs.owasp.org/sctop10/SC01-AccessControlVulnerabilities/

[^panoptic]: Panoptic, "Position Spoofing Post Mortem", https://panoptic.xyz/blog/position-spoofing-post-mortem
