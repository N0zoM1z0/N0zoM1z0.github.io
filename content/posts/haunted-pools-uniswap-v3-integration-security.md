---
title: "Part I: Haunted Pools: The Real Security Footguns in Uniswap v3 Integrations"
date: "2026-05-26"
slug: "haunted-pools-uniswap-v3-integration-security"
categories:
  - DeFi
  - Security Research
tags:
  - uniswap-v3
  - defi
  - integration
  - security
series: "Uniswap Integration Security"
seriesPart: 1
---

# Part I: Haunted Pools: The Real Security Footguns in Uniswap v3 Integrations

*Never trust spot. Never trust callbacks. Never trust a pool you did not whitelist.*

## Abstract

Uniswap v3 is not merely a swap venue. For protocols that integrate it, it is a callback-driven execution environment, a permissionless pool factory, a concentrated-liquidity accounting system, a price oracle substrate, a fee-growth state machine, and a collection of periphery conventions that are easy to treat as stronger guarantees than they really are.

Most severe incidents around Uniswap v3 integrations are not failures of Uniswap v3 Core. They are integration failures: external protocols consume a mutable data point, accept an arbitrary pool, mis-handle a callback, value a non-fungible liquidity position as if it were a simple LP token, or copy a piece of v3 math without preserving the assumptions that made it safe.

This article studies public exploit reports, Code4rena findings, Sherlock findings, and Immunefi-style disclosures around protocols that integrate Uniswap v3. The purpose is not to say that every `slot0` read is a bug or that every callback should be treated as a critical finding. The purpose is sharper: distinguish true positives from false positives, explain why some patterns led to real losses, and pin down when the same pattern is only informational noise.

The strongest conclusion is that Uniswap v3 integration security is mostly about **context binding**. Bind the pool. Bind the callback. Bind the path. Bind the price source. Bind the range. Bind the liquidity state. Bind the fee-growth model. If a protocol leaves any of those bindings implicit, the market will bind them for you, usually in the least charitable way possible.

## Scope and methodology

This article focuses on external protocols that integrate, wrap, route through, value, lend against, rebalance through, or otherwise depend on Uniswap v3. It does not evaluate the security of Uniswap v3 Core itself.

The case studies are drawn from public sources: production exploit writeups, public audit competitions, Sherlock judging repositories, Code4rena reports, and official Uniswap documentation. Public reporting is not a complete view of private audits or undisclosed bug bounty submissions, so the word "known" here means "known from public material". The coverage is intended to be comprehensive at the level of failure modes, with representative public cases for each mode.

Where public reports gave immutable GitHub links, those commit-pinned paths are preserved. Where a report only published a `main` link, the reference is labeled as a report path rather than an immutable permalink.

## Why Uniswap v3 is a hard integration target

### Core and Periphery are not the same security boundary

Uniswap v3 is split into Core and Periphery. Core contains the factory and pools; Periphery contains contracts such as SwapRouter and NonfungiblePositionManager that make Core easier to use. The official architecture docs describe Core as the part that provides fundamental safety guarantees, while Periphery contracts are helper contracts with no special privileges.

This matters because many integration bugs start when a protocol treats a periphery pattern as a universal safety property. A router may validate a callback in one way. A lending protocol may need stronger validation. A vault may need to bind the pool to a strategy. A liquidation function may need to reject arbitrary multihop paths. The existence of an official periphery contract does not mean an external integration inherits its safety model.

### One token pair can have many pools

In Uniswap v3, a pool is defined by `token0`, `token1`, and `fee`. Multiple pools can exist for the same token pair, distinguished by fee tier. This design is fundamental to v3, but it is also one of the most common integration hazards.

A lending protocol that says "WETH and USDC are supported, therefore any WETH/USDC Uniswap v3 LP NFT is acceptable" has already lost the plot. The real object is not the token pair. The real object is the specific pool: factory, token order, fee tier, liquidity depth, oracle history, and tick range.

This is the core of the ParaSpace and Themis-style LP collateral bugs: token allowlisting was mistaken for pool allowlisting.

### Concentrated liquidity makes LP positions path-dependent assets

Uniswap v3 liquidity is not uniformly distributed from zero to infinity. Liquidity providers select a finite price interval. A position can be in range, out of range below, or out of range above. As price moves, the position gradually transforms from one token into the other. The official docs describe concentrated liquidity as capital allocated to custom price ranges; when price exits a range, the position stops being active and can consist entirely of one asset.

This is why a v3 LP NFT is not a fungible LP share. It is closer to a structured product with embedded range exposure and fee accounting. Its value depends on:

- the canonical pool address,
- current and historical price,
- lower and upper ticks,
- liquidity,
- token decimals,
- uncollected fees,
- current tick relative to the range,
- pool liquidity and observation history,
- and the external prices of the underlying tokens.

A protocol that wants to use v3 positions as collateral must solve all of those problems. Most failures come from solving only two or three.

### `slot0` is state, not truth

The most famous footgun is `slot0`. It returns the pool's current `sqrtPriceX96`, tick, and oracle observation metadata. That value is useful, but it is not a secure oracle. It is the current pool state. It can move inside a transaction. It can be pushed by a flash loan. It can be set almost freely in an empty or thin pool. It can be made irrelevant by creating a different fee-tier pool with the same pair.

The correct statement is not "never read `slot0`". The correct statement is: **never let `slot0` alone decide a value transfer**.

A `slot0` read that feeds a UI preview is usually harmless. A `slot0` read that decides how much collateral a user has, how much a liquidator must repay, where protocol liquidity is reallocated, or what `amountOutMinimum` should be is a different animal.

### Callbacks invert control

Uniswap v3 uses callbacks for swaps, mints, and flash loans. A pool calls back into the caller and expects payment. The official flash callback guide states that each callback must verify the call came from a genuine v3 pool; otherwise, a callback can be manipulated by an external account.

This inversion of control is powerful and elegant, but it is also the shortest route from a minor validation bug to a critical approval-drain exploit. If a callback trusts attacker-controlled calldata and then calls `transferFrom(victim, ...)`, all historical allowances to the router or aggregator become attack surface.

### Fee accounting is lazy and intentionally weird

Uniswap v3 fee accounting uses fee-growth accumulators. Some values can overflow. Position accounting is lazily updated when position-changing actions occur. Code that copies v3 math but changes overflow behavior, or reads NonfungiblePositionManager position data as if it were always fresh, can misprice fees, lock positions, or mischarge borrowers.

The important part is that some arithmetic behavior that looks suspicious in isolation is intentional in v3. Checked arithmetic is not always safer when the original invariant relied on wrapping arithmetic.

### Special tokens break comfortable assumptions

The official Uniswap docs state that fee-on-transfer tokens do not function with v3 router contracts and that negative rebases are borne by LPs when a position is active. ERC777 adds hooks during transfers. Blacklist tokens can block liquidations or withdrawals. Rebasing and fee-on-transfer mechanics can invalidate balance-delta assumptions.

This is not an edge-case lecture. Arcadia and Panoptic show that ERC777 hooks interacting with v3 position state can become high-severity issues.

## A taxonomy of Uniswap v3 integration bugs

The public cases cluster into seven families:

1. Callback authenticity and fake-pool failures.
2. Spot price and `slot0` consumed as an oracle or control input.
3. v3 LP NFT collateral misvaluation.
4. Add/remove liquidity without meaningful slippage protection.
5. Arbitrary path, pool, or swap data accepted in value-moving flows.
6. Fee-growth, lazy accounting, and wraparound mistakes.
7. v3 math, decimals, tick, and range validation errors.

The rest of the article walks through each family with true positives and false-positive boundaries.

---

## 1. Callback authenticity failures

### The primitive

A simplified vulnerable callback often looks like this:

```solidity
function uniswapV3SwapCallback(
    int256 amount0Delta,
    int256 amount1Delta,
    bytes calldata data
) external {
    (address tokenIn, address payer, uint24 fee) = abi.decode(data, (...));

    uint256 amountToPay = amount0Delta > 0
        ? uint256(amount0Delta)
        : uint256(amount1Delta);

    TransferHelper.safeTransferFrom(
        tokenIn,
        payer,
        msg.sender,
        amountToPay
    );
}
```

The missing line is the entire security model:

```solidity
address pool = IUniswapV3Factory(factory).getPool(token0, token1, fee);
require(pool != address(0) && msg.sender == pool, "INVALID_POOL");
```

In real code, the dangerous version is often more subtle. The contract might compute a pool address from attacker-controlled data, store the expected pool in temporary state, allow arbitrary route data, or use a callback context that can be overwritten.

The exploit condition is not merely "callback lacks official `CallbackValidation`". The exploit condition is:

```text
fake or attacker-controlled caller
    -> reaches callback
    -> attacker controls payer, token, amount, recipient, or path
    -> callback performs transfer or transferFrom
    -> victim or protocol has balance or allowance
```

When all arrows exist, this is almost always High or Critical.

### True positive: SushiSwap RouteProcessor2

SushiSwap RouteProcessor2 is the canonical fake-pool callback exploit.

The RouteProcessor2 contract accepted route data that could point to a malicious pool. During a `swapUniV3` flow, the malicious pool became the recorded pool, called back into `uniswapV3SwapCallback`, and passed the callback check because the check was tied to the last-called pool rather than a canonical factory-created pool. The attacker then used the callback to drain tokens from users who had approved RouteProcessor2.

Halborn's postmortem describes an estimated loss of about $3.3 million from users who had approvals to the new RouteProcessor2 contract. The critical point is not the exact number. The critical point is the blast radius: the vulnerable contract did not need to hold all funds itself. The approvals held by users became the asset pool.

**Why this was a true positive:**

- The fake pool was reachable.
- Callback authentication was context-based, not factory-based.
- The attacker could control route data.
- The callback reached token transfers.
- Real users had approvals to the vulnerable contract.
- Exploitation did not require sustained price manipulation or economic assumptions.

This is the cleanest callback failure shape: one bad caller-binding turns a router into an allowance sweeper.

### True positive: ParaSwap AugustusV6

ParaSwap's AugustusV6 exploit is another callback-context failure, though more complex due to highly optimized assembly and aggregator-specific routing.

The public Neptune Mutual analysis reports that ParaSwap was exploited on Polygon, Arbitrum, and Ethereum Mainnet on March 20, 2024, with about $24,000 in direct losses. It also notes that the vulnerability targeted users who had approvals to AugustusV6 and came from handling external callbacks in a way that enabled unauthorized fund redirection.

The callback path decoded a `fromAddress` from calldata and, when `fromAddress` was not the contract itself, executed `transferFrom`. That is not inherently wrong. Routers often need to pull from a payer. The bug class appears when the callback context is not bound tightly enough to a legitimate swap initiated by that payer.

**Why this was a true positive:**

- The callback reached `transferFrom`.
- `fromAddress` came from callback data.
- Users had pre-existing approvals.
- The affected contract was an aggregator router, so the natural approval surface was broad.
- The loss path did not depend on long-run price manipulation.

The lesson is brutal: in an aggregator, a callback bug is rarely limited to funds currently inside the contract. It can reach outward into every account that approved the router.

### True positive: SIR Trading and transient storage collision

SIR Trading is a newer and more interesting callback failure because it did not simply omit validation. It had validation, but the validation's backing state was overwritten.

The public Rekt and Verichains analyses describe a transient storage collision in `uniswapV3SwapCallback`. The protocol stored the expected Uniswap v3 pool address in transient storage slot `0x1`, then later reused the same slot for a minted amount. The attacker crafted a value and a matching CREATE2 address so that the overwritten amount could be interpreted as the attacker's callback caller. A direct call to the callback then passed the check and transferred tokens out of the vault.

This is an important case because it defeats a superficial review heuristic. A reviewer might see "the callback checks the caller" and move on. The real invariant was weaker:

```text
TLOAD(expectedPoolSlot) must still mean expectedPool at callback time.
```

It did not.

**Why this was a true positive:**

- The expected callback caller was stored in mutable transient state.
- The same slot was reused for unrelated data.
- The attacker could influence the replacement value.
- The callback transferred vault funds after the check.
- The exploit was executed in production and drained the protocol's TVL.

SIR is one of the cleanest reminders that validation is not only about the comparison. It is also about the integrity and lifetime of the value being compared.

### False-positive boundary: Real Wagmi callback collision reports

The Real Wagmi Sherlock judging repository contains useful boundary cases. One issue claimed the Uniswap callback was incorrectly protected and dangerous, but it was labeled Non-Reward. The issue itself noted that a miscalculation in `computePoolAddress()` would likely make the callback always revert, and only theorized that a malicious actor might find arguments that collide with `msg.sender`. Another related issue argued that not checking the factory directly exposed an address-collision attack; it was also labeled Non-Reward, Sponsor Disputed, and Won't Fix.

These are valuable because the underlying instinct is not wrong: Uniswap v3 callbacks should be verified against canonical pools. But an audit finding is not rewarded for naming a dangerous class. It must show the dangerous class is reachable in this system.

**Why this collapses as a high-severity claim:**

- The reported behavior tended toward revert or DoS, not a demonstrated drain.
- The collision path was speculative and computationally unrealistic in the submitted form.
- There was no concrete victim allowance flow like SushiSwap or ParaSwap.
- The report did not prove an attacker-controlled fake pool could reach a successful token transfer.

**The judgment rule:** Missing or non-standard callback validation is a strong smell. It becomes High only when the caller can be forged and a value-moving path succeeds. Otherwise it is a design warning, DoS, or non-issue.

### Our take

Callback bugs are the highest-signal Uniswap v3 integration class because they are usually binary. Either the callback can be forged into a token transfer, or it cannot. There is much less room for economic handwaving than in oracle manipulation. The fastest way to triage them is to trace from `msg.sender` to `transfer`, `transferFrom`, Permit2, or internal accounting credit.

The best callback validation is boring:

```solidity
function uniswapV3SwapCallback(
    int256 amount0Delta,
    int256 amount1Delta,
    bytes calldata data
) external override {
    SwapCallbackData memory decoded = abi.decode(data, (SwapCallbackData));

    address token0 = decoded.token0 < decoded.token1
        ? decoded.token0
        : decoded.token1;
    address token1 = decoded.token0 < decoded.token1
        ? decoded.token1
        : decoded.token0;

    address pool = IUniswapV3Factory(factory).getPool(token0, token1, decoded.fee);
    require(pool != address(0), "POOL_NOT_FOUND");
    require(msg.sender == pool, "INVALID_CALLBACK");

    // Now and only now, pay the pool.
}
```

Then bind the rest of the context. The callback should know which operation it is settling, who the payer is, which token is owed, how much is owed, and where payment is allowed to go.

---

## 2. `slot0` as oracle or control input

### The primitive

`slot0` bugs are often reported in lazy form:

```text
Protocol uses slot0, which can be manipulated by flash loans.
```

That sentence is not enough. A real finding needs a value path:

```text
attacker manipulates pool price
    -> protocol reads slot0
    -> protocol computes collateral, minOut, price limit, rebalance range, or health
    -> protocol transfers value, mints shares, allows borrowing, or realizes bad liquidity movement
    -> attacker captures profit greater than manipulation cost
```

Without the later arrows, "uses `slot0`" is just a smell.

### True positive: ParaSpace H-05

ParaSpace accepted Uniswap v3 positions as collateral if the underlying tokens were supported. The valuation function used `LiquidityAmounts.getAmountsForLiquidity` with pool-derived price data to compute token amounts, then multiplied those amounts by token oracle prices.

The public Code4rena report shows the issue clearly: Uniswap v3 can have multiple pools for the same token pair, and a low-TVL or newly created pool can be manipulated. An attacker could create a WETH/DAI pool with little liquidity, deposit the resulting LP position as collateral, borrow from the lending pool, and manipulate the pool state so that the collateral became worthless or overvalued relative to the debt.

The most revealing part of the ParaSpace discussion is the judge exchange. The initial objection was that manipulation would be arbitraged away. The winning clarification was that the attack can happen atomically. A flash loan can push the pool into the state needed for valuation, the protocol can value the LP using external token prices, and the attacker can complete the borrow before any normal market correction matters.

**Why this was a true positive:**

- The manipulated value affected borrow capacity.
- The protocol accepted positions from arbitrary fee-tier pools as long as underlying tokens were supported.
- The pool could be low liquidity or attacker-created.
- The profit path was borrowing real assets against manipulated collateral.
- The attack could be atomic, so "arbitrage will fix it" was not a defense.

### True positive: Themis LP pricing disclosure

Themis had the same fundamental shape. The public Immunefi-style issue described under-collateralization through manipulated Uniswap v3 LP token pricing. The protocol allowed LP collateral based on supported underlying tokens and used pool state in a way that could be manipulated.

The important pattern is identical to ParaSpace:

```text
permissionless pool + spot valuation + lending collateral = real loss path
```

The exact valuation formula matters less than the trust boundary. If the attacker can choose or dominate the pool whose state is being used to value collateral, the valuation is not an oracle. It is attacker input with math around it.

### True positive: Maia H-02

Maia's `RootBridgeAgent` used Uniswap v3 `slot0` to derive `sqrtPriceLimitX96` for internal gas-token swaps. The public issue shows the code reading `slot0`, calculating a price-impact band around the current `sqrtPriceX96`, and then passing that value into `pool.swap` as the price limit.

At first glance, this is not an oracle bug. The protocol is not saying "the asset is worth X". But it is still consuming spot price as a control input. If an attacker can move the current price, the protocol computes its own safety rail around the attacker's chosen point.

That is the essence of many dynamic-slippage bugs:

```text
attacker manipulates reference price
    -> protocol computes limit relative to manipulated reference
    -> limit appears conservative
    -> execution is still bad
```

**Why this was a true positive:**

- The manipulated value fed the swap's price limit.
- The swap moved protocol-controlled assets.
- The attacker could manipulate and backrun around the protocol's trade.
- The protection was endogenous to the pool being attacked.

A protection parameter computed from the same manipulable state it is supposed to protect against is not protection. It is a mirror.

### True positive: Predy H-01

Predy is one of the most instructive `slot0` cases because it shows why "just use TWAP" is sometimes too shallow.

The public Code4rena report states that anyone could invoke `reallocate`, and whether reallocation was needed depended on the Uniswap v3 `slot0` price. The logic read both current `sqrtPrice` and current tick, then reallocated LP exposure based on whether the position was out of range.

The judge increased the severity to High and made a key observation: the problem was not merely that `slot0` was used. The problem was how the mutable spot price and current tick were consumed by a permissionless reallocation mechanism. A user could momentarily manipulate the pair, force reallocation to an unfavorable range, and then profit from the new liquidity placement. The report also notes that simply replacing one value with TWAP would be insufficient because the current tick remained part of the decision.

**Why this was a true positive:**

- The function was permissionless.
- The spot value controlled protocol liquidity placement.
- The result was not merely a bad quote, but a state change in the protocol's LP position.
- Repeated reallocation could impose swap costs and financial loss on LPs.
- TWAP alone would not solve all consumed mutable inputs.

This case points to a deeper rule: if a function mutates strategy state, the oracle problem is also a governance and authorization problem.

### True positive with nuance: Revert Lend

Revert Lend gives a rare public example where the same report separates low-signal and high-signal `slot0` uses.

The issue identified four `slot0` reads. In two instances, `sqrtPriceX96` was stored but never used. Those were effectively Low at most. In another instance, `slot0` was used when checking a pool price against another derived price. In the fourth, it was used to calculate `amountOutMin` for swap validation.

The report explicitly says the first two instances had no impact because the value was unused, while the third and fourth had a clear attack vector.

This is the correct mental model. A static analyzer can find `slot0`. A security researcher must find the value flow.

### False-positive boundary: unused or non-value `slot0` reads

A `slot0` read is weak evidence by itself. It is often false-positive or low severity when:

- the value is stored but never consumed,
- it is used only for UI or events,
- it is used only to display a quote,
- the pool is deeply liquid, strongly allowlisted, and cross-checked,
- the transaction reverts if the manipulated value matters,
- the user supplies independent `minOut` or `maxIn`,
- or the manipulation cost exceeds the maximum extractable value.

This does not mean such code is beautiful. It means severity must track impact, not vibes.

### Our take

The right question is not "does the code use `slot0`?" The right question is:

```text
What privilege does this `slot0` value receive?
```

If it receives display privilege, it is probably fine. If it receives accounting privilege, liquidation privilege, collateral privilege, reallocation privilege, or slippage-guard privilege, it needs defense in depth.

---

## 3. Uniswap v3 LP NFTs as collateral

### The primitive

A v3 LP NFT looks like an asset. It is also a bundle of assumptions:

```text
position = pool + fee tier + token order + tick range + liquidity + fee state
value = token amounts at price + uncollected fees + external token prices
risk = liquidity depth + price manipulation cost + range sensitivity + token behavior
```

Lending protocols tend to fail by accepting the NFT before fully constraining this bundle.

A vulnerable valuation path often looks like:

```solidity
Position memory p = npm.positions(tokenId);
(uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
(amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
    sqrtPriceX96,
    TickMath.getSqrtRatioAtTick(p.tickLower),
    TickMath.getSqrtRatioAtTick(p.tickUpper),
    p.liquidity
);
value = amount0 * oraclePrice0 + amount1 * oraclePrice1;
```

The formula is not automatically wrong. It becomes dangerous when `pool` and `sqrtPriceX96` are not trustworthy enough for the privilege being granted.

### True positive: ParaSpace H-05, arbitrary low-TVL pools

The ParaSpace H-05 bug is the clearest LP NFT collateral valuation case. The protocol allowed Uniswap v3 positions composed of supported ERC20 tokens to be used as collateral. The value was computed from the position's amounts and token prices, but the pool itself was not sufficiently constrained.

The attack is not just "spot can be manipulated". It is more specific:

1. Create or use a low-liquidity pool for supported tokens.
2. Mint a v3 position in that pool.
3. Deposit the NFT as collateral.
4. Manipulate the pool state to inflate or distort computed token amounts.
5. Borrow real assets from the lending pool.
6. Leave the protocol with undercollateralized debt.

The fix suggested in the report is also the right direction: allow only pools with enough TVL. In practice, a robust fix is broader: whitelist exact pool addresses, enforce fee tiers, check observation cardinality, require sufficient TWAL, use external oracle cross-checks, and apply conservative haircuts.

### True positive: ParaSpace H-06, decimals

ParaSpace also had a decimals-related LP valuation issue. The report shows that a hardcoded `1E9` scaling factor caused over-inflated `sqrtPriceX96` values when `token1Decimal > token0Decimal`. That incorrect sqrt price then flowed into `getAmountsForLiquidity`, causing huge token amount outputs and inflated NFT values.

This is not a cosmetic precision bug. In a collateral system, a decimal mismatch is a credit-line bug.

The broader rule:

```text
sqrtPriceX96 is not a human price.
It is a fixed-point ratio between token units.
Token units have decimals.
```

USDC/WETH, WBTC/WETH, USDT/DAI, and long-tail tokens do not share decimal assumptions. Any valuation formula that does not explicitly normalize units deserves suspicion.

### True positive: Themis, under-collateralized LP tokens

The Themis disclosure falls into the same family: a lending protocol accepted Uniswap v3 LP collateral and used a pricing formula vulnerable to manipulation. The public issue says the attacker could drain assets by under-collateralizing LP tokens and manipulating the underlying Uniswap pool.

The reason this family is so dangerous is that the attacker does not need to break the lending protocol's core debt accounting. They only need to smuggle attacker-controlled market state into the collateral valuation path.

### True positive: Arcadia, cached liquidity and ERC777 hook

Arcadia shows that LP NFT collateral bugs are not only about price. They can also be about state freshness and transfer ordering.

The Sherlock report explains that Arcadia cached the liquidity of a Uniswap v3 position during the deposit-processing phase. The actual asset transfer happened afterward. If the user deposited an ERC777 token first and the Uniswap v3 position second, the ERC777 `tokensToSend` hook could fire while the depositor still owned the Uniswap v3 NFT. During that hook, the depositor could withdraw liquidity from the NFT. Arcadia would then complete the deposit and believe the NFT still had the previously cached liquidity.

The result: the account could appear to hold a valuable Uniswap v3 position even though the actual position was empty or reduced.

**Why this was a true positive:**

- The cached liquidity was used for collateral value.
- The NFT state could change after caching and before transfer completion.
- ERC777 hooks gave the attacker a reentry point at exactly the wrong time.
- The final protocol state trusted stale liquidity.

This is a very different bug from ParaSpace, but the underlying theme is the same: the protocol trusted a v3 position fact outside its valid lifetime.

### True positive with lower directness: ParaSpace M-10, zero-liquidity NFT griefing

ParaSpace also had a medium issue involving zero-liquidity Uniswap v3 NFTs. An attacker could use zero-liquidity NFTs to consume collateral NFT slots or interfere with collateral management. This is not a direct drain like H-05, but it is real in a lending protocol because collateral workflows have liveness assumptions. Blocking a user from adding valid collateral or repairing a position can affect liquidation dynamics.

The lesson is simple: accepting a v3 NFT should include a `liquidity > 0` check, pool validation, and per-position sanity checks. An ERC721 token ID is not proof of economically meaningful collateral.

### False-positive boundary: impermanent loss is not a vulnerability

A common weak report says some version of:

```text
Uniswap v3 LPs can lose value when price moves, so users can lose funds.
```

That is not a protocol vulnerability. It is the asset's market risk.

It becomes a vulnerability only when the protocol forces a bad realization, misvalues the NFT, allows manipulated collateral, exposes another party to the loss, or violates a promised invariant. LPs taking range risk is normal. A lending pool lending against an attacker-created low-liquidity range at inflated value is not normal.

### Our take

The safest mental model is to treat a v3 LP NFT as an untrusted structured derivative until proven otherwise. Do not ask, "Are token0 and token1 supported?" Ask:

```text
Is this exact pool supported?
Is this exact fee tier supported?
Is this tick range acceptable?
Is this liquidity active or meaningful?
Is the price source robust enough for debt issuance?
Could this state change during the deposit flow?
Could token hooks interrupt the flow?
```

If the answer to any of those is "we assume so", the protocol is not ready to lend against v3 NFTs.

---

## 4. Add and remove liquidity without meaningful slippage protection

### The primitive

Uniswap v3 liquidity actions are price-sensitive. Adding liquidity at one price may require both tokens. Adding liquidity after price moves outside the range may require only one token. Removing liquidity realizes the current composition of the position.

A vulnerable pattern looks like:

```solidity
(uint128 liquidity, uint256 amount0, uint256 amount1) = npm.increaseLiquidity(
    INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: tokenId,
        amount0Desired: amount0Desired,
        amount1Desired: amount1Desired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
    })
);
```

or, lower-level:

```solidity
(amount0, amount1) = pool.burn(lowerTick, upperTick, liquidity);
// no amount0Min or amount1Min check
```

The absence of min checks does not always mean a protocol drain. But it usually means someone can force the user or protocol to accept an unfavorable composition.

### True positive: Good Entry H-01

Good Entry's `TokenisableRange.deposit` finding is a precise v3-specific slippage bug.

The report describes a user depositing when the pool price is inside the position range. The user submits both token amounts. Before execution, the price moves outside the range. The code recalculates amounts based on the new `slot0` state and fee logic. In the example, `amount1Min` effectively becomes zero, allowing `increaseLiquidity` to succeed while consuming the user's token1 as fee or leaving the user with a worse result.

The sponsor initially disputed the phrase "price moves during execution" because EVM execution is atomic. The warden clarified the real issue: price can move between transaction submission and execution, or due to frontrunning before the user's transaction. The sponsor accepted.

That exchange is important. Slippage bugs do not require non-atomic execution. They require stale user expectations.

**Why this was a true positive:**

- The user submitted a transaction under one price assumption.
- The protocol recomputed values under a different price state.
- Min amount protection became ineffective.
- The user could lose funds or receive an unintended position composition.
- The fix required using value-based accounting or robust min checks.

### True positive: Vultisig M-02

Vultisig's `claim` function called `pool.burn` and used the returned `amount0` and `amount1` without slippage controls. The Code4rena report compares this directly to Uniswap's own `decreaseLiquidity`, which checks `amount0 >= amount0Min` and `amount1 >= amount1Min` after `pool.burn`.

The judge accepted the issue as Medium because a sandwich attack could affect the composition users receive during claim. The sponsor argued the attacker may not profit directly. That is a useful nuance: not every slippage bug is an attacker-profit bug. It can still be a valid issue if users are forced into worse execution due to missing protections.

**Why this was a true positive:**

- The function realized a v3 liquidity position.
- There was no user-defined minimum for either token.
- Pool price could be moved before claim.
- The output composition could be worse than expected.
- Uniswap periphery itself uses min checks for the comparable operation.

### True positive: USSD `amountOutMinimum = 0`

USSD's Sherlock finding is the classic swap version. `UniV3SwapInput` set `amountOutMinimum` to zero in a rebalancing flow, allowing up to 100% slippage in theory. The issue was labeled a valid High duplicate. The same function also had deadline-related issues.

This is a high-signal bug when protocol-owned assets are swapped in public mempool transactions. The attacker does not need to invent a new primitive. They only need to sandwich a trade whose minimum acceptable output is zero.

### False-positive boundary: user-chosen slippage and harmless deadlines

A missing or bad slippage parameter is weaker when:

- the user explicitly chooses `amountOutMinimum = 0`,
- the protocol has a final balance-delta check,
- the output is not used for value transfer,
- the trade is private or keeper-protected with independent bounds,
- the amount is dust,
- or the transaction reverts before any bad execution can settle.

Similarly, `deadline = block.timestamp` is often poor UX and weak protection, but it is usually not a standalone High if meaningful slippage limits and balance checks exist. It becomes much more serious when combined with `amountOutMinimum = 0` or stale quote logic.

### Our take

For v3 liquidity operations, both token sides need explicit expectations. One-sided and out-of-range behavior is a feature of v3, not an exception. Any wrapper that hides this feature from users must replace it with stronger min checks, not weaker ones.

---

## 5. Arbitrary path, arbitrary pool, arbitrary swap data

### The primitive

Routers and liquidators often want flexibility. Flexibility becomes a vulnerability when user-supplied path data controls protocol assets.

A dangerous liquidation flow looks like:

```solidity
function liquidate(Position position, bytes calldata swapData) external {
    // close or seize position
    router.call(swapData);
    // assume enough repayment happened
    // send leftover to liquidator or borrower
}
```

The problem is not arbitrary calldata in itself. It is arbitrary calldata in a flow where the protocol assumes the swap performs a specific economic transformation.

### True positive: Particle H-03

Particle's Code4rena H-03 finding shows this clearly. The liquidator could pass arbitrary swap data. As long as the repayment amount was satisfied, malicious data could redirect or extract the borrower's profit. The public report included a fake token and fake pool proof-of-concept and recommended removing raw swap data from the liquidator's control.

The sponsor discussion is also informative. Flexibility was initially defended as necessary for liquidation routing, but the final direction moved toward not exposing arbitrary swap data.

**Why this was a true positive:**

- The swap was part of a liquidation value flow.
- The liquidator controlled raw data.
- The protocol assumed the data represented a legitimate swap path.
- The borrower or protocol surplus could be stolen or misdirected.
- The attack did not depend on market price manipulation.

### True positive connection: SushiSwap and ParaSwap

SushiSwap and ParaSwap are callback cases, but they also belong in the arbitrary route-data family. In both cases, aggregator flexibility exposed callback and fund-transfer assumptions. The route was not just a routing preference. It became a program that the contract executed with user approvals.

### False-positive boundary: routers are supposed to route

A generic router accepting arbitrary paths is not automatically vulnerable. It becomes vulnerable when one of the following is true:

- the router can spend third-party approvals without binding the payer,
- the route can introduce a fake pool that reaches callback transfer logic,
- the protocol assumes the route repays debt or returns collateral,
- a liquidation or rebalance relies on route output without independent checks,
- the recipient can be changed to an attacker-controlled address,
- or path tokens can be fake while accounting treats them as real.

If the router is purely user-directed, uses user-provided min outputs, has no protocol accounting assumptions, and cannot spend anyone except the caller, the same flexibility is usually expected behavior.

### Our take

In DeFi, `bytes calldata data` is often a tiny virtual machine. If it is supplied by an economically adversarial actor, the protocol must specify what programs it is willing to run. For Uniswap v3 integrations, that means binding tokenIn, tokenOut, fee tier, pool, recipient, payer, exact-in/exact-out direction, and final balance deltas.

---

## 6. Fee-growth, stale accounting, and wraparound mistakes

### The primitive

Uniswap v3 fee accounting is easy to misuse because it combines lazy updates, fixed-point accumulators, and intentional wraparound.

Two common wrong assumptions are:

```text
NonfungiblePositionManager.positions(tokenId) always returns fresh fee growth.
```

and:

```text
Checked arithmetic is always safer than wrapping arithmetic.
```

Both are false in v3 integrations.

### True positive: Particle H-02, stale NPM fee growth

Particle's H-02 finding identified that the protocol recorded `feeGrowthInside0LastX128` and `feeGrowthInside1LastX128` directly from `UNI_POSITION_MANAGER.positions(tokenId)` when preparing leverage. The report explains that these values are not necessarily latest. They synchronize when position actions such as `increaseLiquidity`, `decreaseLiquidity`, or `collect` occur.

If a borrower opens a leveraged position after swaps have accrued fees but before the NPM position has been synchronized, the stale snapshot can cause the borrower to overpay fees later.

**Why this was a true positive:**

- The stale value was snapshotted into borrower accounting.
- Later fee calculations used the difference from that snapshot.
- The error changed how much the borrower paid.
- The issue was not merely stale display data.

The important phrase is "lazy update". v3 state may be economically current in the pool but stale in the NFT manager's position view.

### True positive: Particle H-04 and Superposition H-04/H-06, intentional wraparound

Particle H-04 and Superposition H-04/H-06 illustrate another subtle class: copying Uniswap fee-growth math into an environment with checked arithmetic.

Uniswap v3's fee-growth calculations intentionally allow underflow or overflow in certain expressions. The Superposition report shows a Rust implementation using `checked_sub`, which returns an error instead of wrapping. The result was that positions could become impossible to update or remove, leading to locked funds. The report explicitly compares against Uniswap v3 Core's `Position.sol`, where subtraction is allowed to wrap under Solidity versions before 0.8.

This is one of the rare places where a reviewer must resist a simplistic rule. In ordinary Solidity, unchecked underflow is suspicious. In v3 fee-growth math, wraparound can be the invariant.

**Why this was a true positive:**

- The protocol claimed to implement v3-like math.
- The implementation changed arithmetic semantics.
- Core operations such as position updates, liquidity removal, or liquidation could revert.
- The effect could lock funds or break critical functionality.

### True positive: Panoptic H-01, ERC777 hook and `feesBase`

Panoptic's H-01 finding shows fee accounting combined with token hooks. The report says an attacker could steal all outstanding fees from the SemiFungiblePositionManager in pools containing ERC777 tokens. The sequence involved minting a position, updating liquidity, triggering token transfers to Uniswap, and only later updating `feesBase`. With an ERC777 hook, the attacker could transfer the position before `feesBase` was set correctly, then burn and collect fees improperly.

**Why this was a true positive:**

- Fee base state was updated after an external token-transfer phase.
- ERC777 hooks enabled reentrancy at that phase.
- Position ownership and fee accounting could diverge.
- The result was stealing fees, not just temporary inconsistency.

### False-positive boundary: stale fee variables without settlement impact

Fee-growth findings become weak when:

- the stale value is used only for display,
- the function synchronizes before settlement,
- the difference is bounded to dust,
- no user or protocol balance changes based on it,
- or the report does not show how lazy update changes the final fee charged.

Similarly, "underflow exists" is not a finding in v3 math. The finding is that a copied or ported implementation rejects a wraparound that the original model requires.

### Our take

The most dangerous v3 accounting bugs are not the flashy ones. They are the quiet ones that misplace time. The value was true when read, but not when used. The accumulator was valid if it wrapped, but the port refused to wrap. The fees belonged to one position before a hook, then another position after a hook.

When reviewing fee code, trace three timelines:

1. When the pool fee-growth value changed.
2. When the position snapshot was updated.
3. When the protocol's own accounting snapshot was updated.

Bugs live in the gaps.

---

## 7. Math, decimals, ticks, and range validation

### The primitive

Uniswap v3 math is not ordinary token math. It uses Q64.96 square-root prices, ticks, fixed-point multiplication, liquidity deltas, and token ordering. The common failure is to simplify a formula that was not optional complexity.

### True positive: Asymmetry H-05

Asymmetry's `Reth` derivative contract read `sqrtPriceX96` from a Uniswap v3 pool and calculated:

```solidity
return (sqrtPriceX96 * uint256(sqrtPriceX96) * 1e18) >> 192;
```

The Code4rena report points out that the multiplication can overflow. Uniswap's own `OracleLibrary.getQuoteAtTick` handles this by branching depending on whether squaring the sqrt ratio is safe and using `FullMath.mulDiv`.

**Why this was a true positive:**

- The price fed user minting and withdrawal calculations.
- Overflow could break the price calculation.
- The correct library pattern existed and was not followed.
- The result could overstate or understate user shares or lock withdrawals.

The lesson is not "never calculate price". The lesson is that if Uniswap wrote a branch and used `FullMath`, it was probably not decorative.

### True positive: ParaSpace H-06 decimals

The ParaSpace decimal bug belongs here too. Hardcoded scaling in a sqrt-price calculation produced huge valuation errors when token decimals differed.

The invariant is:

```text
Price ratios are ratios of token units, not human-denominated asset quantities.
```

Any formula that mixes token price, token amount, and sqrt price must normalize decimals deliberately.

### True positive: Superposition H-03, tick range validation

Superposition H-03 involved missing validation that `lower < upper` during position minting. The report showed that `lower == upper` could create positions with arbitrary liquidity without consuming tokens, and `lower > upper` could lead to incorrect fee calculations. The judge confirmed High severity because invalid tick ranges had significant consequences.

This is a fork/port lesson. Uniswap v3 Core has a dense lattice of assumptions around tick ordering. If a fork or reimplementation misses one validation, downstream math can become undefined in profitable ways.

### True positive: Superposition H-07, invalid slippage variable

Superposition H-07 involved swap-out functions where the slippage check compared `minOut` against the wrong decoded amount. The function intended to enforce output minimums but checked the input-side amount instead. The judge accepted the issue as Medium because slippage protections were ineffective for affected swaps.

This is not unique to v3, but v3's token0/token1 conventions make this class more likely. `amount0`, `amount1`, exact-in/exact-out signs, and zeroForOne direction must be mapped carefully.

### False-positive boundary: dust rounding and theoretical extremes

v3 math findings are weak when they show only:

- one-wei rounding without accumulation,
- unreachable tick ranges,
- overflow at impossible protocol-configured parameters,
- a calculation used only for a preview,
- or a sign convention issue that reverts instead of losing value.

A strong math finding shows where the wrong number enters a mint, burn, borrow, liquidation, fee settlement, or slippage check.

### Our take

The phrase "we implemented the Uniswap formula" should make reviewers nervous, especially outside Solidity. A faithful port must preserve not only formulas but also type widths, rounding direction, overflow behavior, tick preconditions, and token ordering.

---

## True positives: what they have in common

The true positives across public cases share a few traits. They are worth stating bluntly.

### 1. Attacker-controlled state gets protocol privilege

In ParaSpace and Themis, attacker-influenced pool state became collateral value. In Maia and Predy, attacker-influenced spot state became a swap or reallocation control parameter. In SushiSwap and ParaSwap, attacker-controlled route or callback data became token-transfer authority.

The bug is not merely manipulability. The bug is privilege.

### 2. The vulnerable function is economically reachable

Production exploits and high-quality findings show who calls the function, with what inputs, and why the call can succeed. Weak findings stop at "this could be manipulated". Strong findings complete the transaction.

### 3. The protocol moves someone else's value

The highest severity cases involve protocol funds, user approvals, borrower collateral, LP fees, or liquidation proceeds. A bad quote that only informs a user's UI is not in the same category.

### 4. The manipulation can complete before correction

The ParaSpace judge discussion is the template. "Arbitrage will fix it" is not a defense if the exploit is atomic. A lending protocol that accepts manipulated collateral and issues debt in the same transaction loses before the market has a chance to be rational.

### 5. The missing invariant is usually simple

Most fixes are conceptually simple, even if implementation is hard:

- callback caller must be a canonical pool,
- pool address must be allowlisted,
- price source must be robust enough for the privilege granted,
- min output must be user- or oracle-bounded,
- fee-growth math must preserve wraparound,
- cached liquidity must still be true when used,
- token0/token1 and decimals must be normalized.

Uniswap v3's complexity does not remove simple invariants. It just hides where they belong.

## False positives and low-signal reports: why they happen

### 1. Pattern matching without value flow

The most common false positive is pattern matching:

```text
uses slot0 -> flash loan manipulation -> high
```

or:

```text
callback does not call CallbackValidation -> critical
```

Pattern recognition is useful for discovery. It is not enough for severity. A valid report must show that the pattern reaches value transfer or protocol state corruption.

Revert Lend's public issue is a good example of careful separation. Two `slot0` reads had no impact because the values were not used. Two others affected protection logic and were meaningful.

### 2. The report ignores existing final checks

Some protocols compute an intermediate quote from a weak source but later check actual balance deltas, external oracle bounds, or user-provided minimums. In those systems, the weak quote may be harmless or only cause a revert.

### 3. The attack requires unrealistic address collisions

Real Wagmi's non-rewarded callback collision reports show the danger of theoretical cryptographic claims without a concrete feasibility model. Address collisions and vanity addresses can matter, as SIR proved. But SIR had a constrained target value and a concrete CREATE2 path. A generic "maybe collide with computed pool address" argument is not the same thing.

### 4. User choice is confused with protocol failure

If a user deliberately sets zero slippage, the protocol may not be responsible. If the protocol sets zero slippage for its own rebalancing, that is different. Audit severity depends on who controls the risk parameter and whose funds are exposed.

### 5. Normal LP market risk is framed as exploit impact

Uniswap v3 LPs can lose money due to price movement. That is not a bug. It becomes a bug when a protocol misrepresents, misprices, forces, or socializes that loss.

### 6. TWAP is invoked as a magic word

"Use TWAP" is often correct but incomplete. Predy shows why. If a mechanism consumes both current tick and current sqrt price for state mutation, replacing only one input with TWAP may not preserve the mechanism's purpose. Sometimes the right mitigation is permissioning, delayed execution, keeper signatures, deviation windows, or redesign.

## Severity decision framework

A Uniswap v3 integration issue tends to be High or Critical when most of the following are true:

- The function is permissionless or reachable by an adversarial actor.
- The manipulated or forged value affects borrowing, liquidation, minting, redemption, fee distribution, or protocol-owned swaps.
- The pool, path, payer, or callback caller is not tightly bound.
- The protocol accepts arbitrary or low-liquidity pools.
- The attack can be completed atomically.
- The attacker profit exceeds manipulation cost.
- The exposed funds include user approvals or protocol balances.
- There is no independent final check.

It tends to be Medium when:

- The issue causes DoS or bad execution but not direct theft.
- Only a subset of users or pools is affected.
- Special tokens or special market conditions are required.
- The attacker may grief or force realization of loss but not reliably profit.
- The bug affects slippage, claim, or launch liveness rather than core solvency.

It tends to be Low or Informational when:

- The value is unused or display-only.
- Existing checks prevent settlement.
- The error is dust-level rounding.
- The pool and path are strongly constrained.
- The attacker cannot reach a successful call path.
- The report relies on theoretical manipulation without economics.

## Practical invariants for safe integrations

This section is intentionally compact. It is not a tutorial; it is the checklist that emerges from the cases.

### Callback invariants

- `msg.sender` must be the canonical pool from the canonical factory.
- Token order and fee tier must be bound to the callback context.
- The payer must be bound to the original operation, not arbitrary callback data.
- The recipient must be constrained.
- Permit2 and ERC20 approvals must not be spendable by fake callbacks.
- Temporary storage, including transient storage, must not be reused across security-critical values.
- Callback context must be cleared or made single-use.

### Pool and path invariants

- Whitelist exact pool addresses for privileged operations.
- Token allowlists are not pool allowlists.
- Fee tiers must be explicit.
- Paths used for protocol accounting must not be arbitrary bytes.
- Final token balances must be checked against expected deltas.
- Low-liquidity, newly created, or zero-observation pools should fail closed.

### Oracle invariants

- `slot0` is acceptable for current execution mechanics only when manipulation cannot create value extraction.
- Collateral, liquidation, share minting, and protocol swaps need stronger sources.
- TWAP must have sufficient observation history and window length.
- TWAL or liquidity depth should be checked alongside TWAP.
- External oracle deviation checks should be used for credit decisions.
- Fallback to spot price is usually a bug, not a graceful degradation.

### LP NFT collateral invariants

- Validate position manager, pool, fee tier, token order, tick range, and liquidity.
- Reject zero-liquidity positions as collateral.
- Normalize decimals everywhere.
- Revalue after transfer, not only before transfer.
- Defend against token hooks during deposit flows.
- Apply conservative haircuts for narrow ranges and low liquidity.
- Do not treat uncollected fees as fresh unless synchronized or conservatively discounted.

### Liquidity operation invariants

- Always expose or enforce `amount0Min` and `amount1Min`.
- Do not set min amounts to zero for protocol-owned operations.
- Check both sides after `pool.burn` or NPM `decreaseLiquidity`.
- Treat out-of-range transitions as expected, not exceptional.
- Do not recompute user expectations from spot state at execution time without bounds.

### Fee accounting invariants

- Know when NPM position data is lazy.
- Update or synchronize before snapshotting fee-growth values.
- Preserve Uniswap v3 wraparound semantics when porting math.
- Update fee-base state before exposing reentrant token-transfer hooks.
- Fuzz fee-growth overflow and underflow paths.

### Math invariants

- Use `TickMath`, `FullMath`, `LiquidityAmounts`, and `OracleLibrary` rather than handwritten shortcuts.
- Normalize token decimals explicitly.
- Preserve rounding direction intentionally.
- Validate `lower < upper` and tick spacing.
- Fuzz extreme ticks, negative ticks, different decimals, and tiny liquidity.
- Map `amount0`, `amount1`, `zeroForOne`, exact-in, and exact-out signs with tests.

## Case matrix

| Case | Source type | Classification | Core issue | Why it matters |
|---|---|---|---|---|
| SushiSwap RouteProcessor2 | Production exploit | True positive | Fake pool callback through route data | User approvals became drainable. |
| ParaSwap AugustusV6 | Production exploit | True positive | Callback data allowed unauthorized fund redirection | Aggregator approvals created broad blast radius. |
| SIR Trading | Production exploit | True positive | Transient storage collision bypassed callback caller check | Validation existed but its backing state was corrupted. |
| ParaSpace H-05 | Code4rena | True positive | Low-TVL v3 pool manipulated LP collateral value | Borrowing against attacker-controlled pool state. |
| ParaSpace H-06 | Code4rena | True positive | Decimal mismatch in LP valuation | Unit error became collateral overvaluation. |
| Themis disclosure | Immunefi-style public issue | True positive | LP collateral pricing manipulable through pool state | Under-collateralized LP positions could drain assets. |
| Arcadia H-3 | Sherlock | True positive | Cached v3 liquidity stale after ERC777 hook | Protocol believed empty NFT still had value. |
| Maia H-02 | Code4rena | True positive | `slot0` used to derive price limit | Dynamic protection moved with attacker-controlled spot price. |
| Predy H-01 | Code4rena | True positive | Permissionless reallocation based on spot price and tick | Attacker could force unfavorable liquidity placement. |
| Revert Lend issue #348 | Code4rena issue | Mixed | Some `slot0` reads unused, others affect protection | Shows why value flow decides severity. |
| Good Entry H-01 | Code4rena | True positive | v3 deposit min amounts become ineffective after price movement | Users can receive unintended liquidity composition. |
| Vultisig M-02 | Code4rena | True positive | `pool.burn` outputs lack min checks | Claim can realize manipulated composition. |
| Vultisig H-03 | Code4rena issue | True positive | Empty pool `slot0` launch check manipulable with single-sided liquidity | Launch can be blocked at negligible cost. |
| USSD #272 | Sherlock | True positive | `amountOutMinimum = 0` in protocol rebalance | Public rebalancing swaps can be sandwiched. |
| Particle H-02 | Code4rena | True positive | Stale NPM fee growth snapshotted | Borrowers overpay fees. |
| Particle H-03 | Code4rena | True positive | Arbitrary liquidator swap data | Liquidation surplus can be redirected. |
| Particle H-04 | Code4rena | True positive | v3 fee-growth wraparound not preserved | Liquidations or close paths can revert. |
| Panoptic H-01 | Code4rena | True positive | ERC777 hook before `feesBase` update | Outstanding fees can be stolen. |
| Asymmetry H-05 | Code4rena | True positive | `sqrtPriceX96` squaring overflow | Price math affects mint and withdraw. |
| Superposition H-03 | Code4rena | True positive | Missing `lower < upper` validation | Invalid ranges distort liquidity and fees. |
| Superposition H-04/H-06 | Code4rena | True positive | Checked math rejects expected v3 underflow | Positions can become inaccessible. |
| Superposition H-07 | Code4rena | True positive | Slippage checks use wrong decoded amount | Protection exists but checks the wrong side. |
| Real Wagmi #28/#158 | Sherlock judging | False-positive boundary | Callback collision or always-revert theory | No concrete successful drain path. |
| Revert Lend first two `slot0` reads | Code4rena issue | Low-signal boundary | Values stored but unused | Manipulability without consumption is not impact. |
| Generic deadline-only complaints | Common audit pattern | Context-dependent | `deadline = block.timestamp` or missing user deadline | Usually weak alone, stronger with no slippage. |
| Generic "LP has IL" reports | Common audit pattern | Usually false positive | Normal market risk | Needs protocol mispricing or forced realization to matter. |

## Code and report references

### Commit-pinned or report-pinned code paths

- ParaSpace H-05 valuation path: `code-423n4/2022-11-paraspace`, commit `c6820a279c64a299a783955749fdc977de8f0449`, `paraspace-core/contracts/misc/UniswapV3OracleWrapper.sol#L176`.
- ParaSpace liquidation context: `code-423n4/2022-11-paraspace`, commit `c6820a279c64a299a783955749fdc977de8f0449`, `paraspace-core/contracts/protocol/libraries/logic/LiquidationLogic.sol#L286-L331`.
- Maia H-02 price-limit logic: `code-423n4/2023-05-maia`, commit `cfed0dfa3bebdac0993b1b42239b4944eb0b196c`, `src/ulysses-omnichain/RootBridgeAgent.sol#L674` and `#L717`.
- Vultisig M-02 claim path: `code-423n4/2024-06-vultisig`, commit `58ebda57ccf6a74bdef2b88eb18a62ec4ad46112`, `src/ILOPool.sol#L184-L261`.
- Superposition H-04 position fee accounting: `code-423n4/2024-08-superposition`, commit `4528c9d2dbe1550d2660dac903a8246076044905`, `pkg/seawater/src/position.rs#L52-L66`.
- Superposition H-07 slippage check: `code-423n4/2024-08-superposition`, commit `4528c9d2dbe1550d2660dac903a8246076044905`, `pkg/sol/SeawaterAMM.sol#L317` and `#L339`.
- Uniswap v3 Core reference for fee-growth wraparound comparison: `Uniswap/v3-core`, commit `d8b1c635c275d2a9450bd6a78f3fa2484fef73eb`, `contracts/libraries/Position.sol#L61-L76`.
- Good Entry report path for `TokenisableRange.sol`: `code-423n4/2023-08-goodentry`, report snapshot paths reference `contracts/TokenisableRange.sol`; some links in the public report are not immutable permalinks.
- Real Wagmi callback boundary: Sherlock report path `sherlock-audit/2023-10-real-wagmi`, `wagmi-leverage/contracts/abstract/ApproveSwapAndPay.sol#L242-L258`; public judging issue labels it Non-Reward.
- Particle findings: public Code4rena report paths are provided in the report; several links use contest repository paths rather than immutable permalinks.
- Panoptic H-01: public Code4rena report and issue paths reference `contracts/SemiFungiblePositionManager.sol#L1031-L1066` and related fee-base update paths; several public issue links use `main`.

### Public sources

- Uniswap v3 Architecture docs: https://developers.uniswap.org/docs/protocols/v3/concepts/architecture
- Uniswap concentrated liquidity docs: https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity
- Uniswap fee-tier docs: https://developers.uniswap.org/docs/get-started/concepts/fees
- Uniswap token integration issues: https://developers.uniswap.org/docs/protocols/v3/concepts/unsupported-tokens
- Uniswap flash callback guide: https://developers.uniswap.org/docs/protocols/v3/guides/flash-swaps/flash-callback
- SushiSwap RouteProcessor2 exploit analysis by Halborn: https://www.halborn.com/blog/post/explained-the-sushi-swap-hack-march-2023
- ParaSwap AugustusV6 exploit analysis by Neptune Mutual: https://medium.com/neptune-mutual/analysis-of-the-paraswap-exploit-1f97c604b4fe
- SIR Trading exploit analysis by Rekt: https://rekt.news/sirtrading-rekt
- SIR Trading transient storage analysis by Verichains: https://blog.verichains.io/p/eip-1153-transient-storage-save-gas
- ParaSpace Code4rena report: https://code4rena.com/reports/2022-11-paraspace
- Good Entry Code4rena report: https://code4rena.com/reports/2023-08-goodentry
- Maia issue #823: https://github.com/code-423n4/2023-05-maia-findings/issues/823
- Predy Code4rena report: https://code4rena.com/reports/2024-05-predy
- Revert Lend issue #348: https://github.com/code-423n4/2024-03-revert-lend-findings/issues/348
- Vultisig Code4rena report: https://code4rena.com/reports/2024-06-vultisig
- Vultisig issue #41: https://github.com/code-423n4/2024-06-vultisig-findings/issues/41
- Particle Code4rena report: https://code4rena.com/reports/2023-12-particle
- Panoptic Code4rena report: https://code4rena.com/reports/2023-11-panoptic
- Panoptic issue #448: https://github.com/code-423n4/2023-11-panoptic-findings/issues/448
- Arcadia Sherlock judging repository: https://github.com/sherlock-audit/2023-12-arcadia-judging
- Real Wagmi issue #28: https://github.com/sherlock-audit/2023-10-real-wagmi-judging/issues/28
- Real Wagmi issue #158: https://github.com/sherlock-audit/2023-10-real-wagmi-judging/issues/158
- USSD issue #272: https://github.com/sherlock-audit/2023-05-USSD-judging/issues/272
- USSD issue #921: https://github.com/sherlock-audit/2023-05-USSD-judging/issues/921
- Asymmetry Code4rena report: https://code4rena.com/reports/2023-03-asymmetry
- Superposition Code4rena report: https://code4rena.com/reports/2024-08-superposition
- Themis public issue: https://github.com/Themis-protocol/Solidity-Open-Source/issues/1

## Final thesis

Uniswap v3 integration bugs are not random. They usually come from one of four broken assumptions:

1. A pool for supported tokens is assumed to be a trusted market.
2. A current pool state is assumed to be a safe price.
3. A callback is assumed to be part of the intended execution path.
4. A v3 position is assumed to be a simple asset rather than a live, stateful, range-bound object.

The most useful reviewer mindset is to ask what the protocol has turned into authority. Did it turn `slot0` into borrowing power? Did it turn callback calldata into permission to spend user funds? Did it turn an arbitrary fee-tier pool into collateral? Did it turn stale fee-growth into settlement accounting? Did it turn a user-submitted path into liquidation logic?

When the answer is yes, the issue is usually real.

The best Uniswap v3 integrations are not the ones that avoid complexity. They are the ones that admit the complexity and bind it explicitly. They whitelist pools, verify callbacks, constrain paths, normalize decimals, preserve v3 math semantics, use independent price checks, and treat LP NFTs as structured positions rather than receipts.

That is the heart of it: Uniswap v3 is safe when used with its invariants. It is dangerous when protocols borrow its surface area without borrowing its discipline.
