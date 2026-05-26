---
title: "Part II: Hooks Do Not Forgive: The Real Security Boundary of Uniswap v4 Integrations"
date: "2026-05-26"
slug: "hooks-do-not-forgive-uniswap-v4-integration-security"
categories:
  - DeFi
  - Security Research
tags:
  - uniswap-v4
  - hooks
  - integration
  - security
series: "Uniswap Integration Security"
seriesPart: 2
---

# Part II: Hooks Do Not Forgive: The Real Security Boundary of Uniswap v4 Integrations

*No invariant, no mercy.*

## Scope

This article is not a review of whether Uniswap v4 core is safe. The core protocol has its own security model, audits, bug bounty process, and threat boundaries. The focus here is narrower and, in practice, more dangerous: projects that integrate with Uniswap v4, build hooks, wrap the `PoolManager`, route users through v4 pools, migrate liquidity into or out of v4, or use v4 pools as pricing, accounting, liquidation, reward, or execution primitives.

The cases below are limited to publicly verifiable material: exploit postmortems, public audit reports, Code4rena and Sherlock findings, public GitHub repositories, and public security research. Private audits, private Immunefi triage, undisclosed mitigations, and non-public judging discussions are intentionally excluded. When a report is mirrored by an aggregator, the primary report or judging record is used as the source of truth.

The core thesis is simple:

**Uniswap v4 core can enforce pool-level token accounting. It cannot enforce the business invariants that an integration builds around hooks, migrators, vault shares, synthetic claims, limit orders, TWAMM orders, leverage, fee auctions, or external accounting.**

That distinction explains why some v4 integration findings become critical exploits, while many superficially similar findings are only low severity, informational, disputed, or invalid.

## Pinned source map

The following commits and paths are the most useful anchors for readers who want to inspect the relevant code rather than only the reports.

- **Uniswap v4 core audit scope**: OpenZeppelin audited `Uniswap/v4-core` at commit `d5d4957`.
  - [`PoolManager.sol`](https://github.com/Uniswap/v4-core/blob/d5d4957/src/PoolManager.sol)
  - [`IHooks.sol`](https://github.com/Uniswap/v4-core/blob/d5d4957/src/interfaces/IHooks.sol)
  - [`Hooks.sol`](https://github.com/Uniswap/v4-core/blob/d5d4957/src/libraries/Hooks.sol)
  - [`PoolKey.sol`](https://github.com/Uniswap/v4-core/blob/d5d4957/src/types/PoolKey.sol)
  - [`SwapMath.sol`](https://github.com/Uniswap/v4-core/blob/d5d4957/src/libraries/SwapMath.sol)
  - [`TickBitmap.sol`](https://github.com/Uniswap/v4-core/blob/d5d4957/src/libraries/TickBitmap.sol)
  - [`TickMath.sol`](https://github.com/Uniswap/v4-core/blob/d5d4957/src/libraries/TickMath.sol)

- **Bunni v2 exploit-era code**: Bunni v2 release `v1.2.1`, commit `000f79a38bdd3fb2b314dc8c108b2a3d1ca1d440`.
  - [`BunniHubLogic.sol`, withdrawal idle-balance update](https://github.com/Bunniapp/bunni-v2/blob/000f79a/src/lib/BunniHubLogic.sol#L2728-L2741)
  - Bunni's public repository now warns that the protocol was exploited and relevant issues are not fully addressed: [`Bunniapp/bunni-v2`](https://github.com/Bunniapp/bunni-v2)

- **Zaha Studio TWAMM hook audit scope**: Certora report scope commit `02950985541a210244d33a4d5c8e3efad8d4de2c`.
  - [`v4-twamm-hook/src` at audit commit](https://github.com/akshatmittal/v4-twamm-hook/tree/02950985541a210244d33a4d5c8e3efad8d4de2c/src)
  - Fix commit for fee logic and `sqrtPriceX96` overflow: [`cde8b7cd80a93ddafcbc3298fac3cdfc4a7604d3`](https://github.com/akshatmittal/v4-twamm-hook/commit/cde8b7cd80a93ddafcbc3298fac3cdfc4a7604d3)
  - Fix commit for precision and related logic: [`97774ed231b93c5274bc83dc67e4f9eadd3c9333`](https://github.com/akshatmittal/v4-twamm-hook/commit/97774ed231b93c5274bc83dc67e4f9eadd3c9333)

- **OpenZeppelin Uniswap hooks library audits**:
  - RC1 audit scope commit: [`087974776fb7285ec844ca090eab860bd8430a11`](https://github.com/OpenZeppelin/uniswap-hooks/tree/0879747)
  - RC2 audit scope commit: [`3e9fa22`](https://github.com/OpenZeppelin/uniswap-hooks/tree/3e9fa22)
  - Final fix merge referenced by the RC2 audit: [`67ddcdf`](https://github.com/OpenZeppelin/uniswap-hooks/commit/67ddcdf)
  - Infinite-loop fix: [`5e42129`](https://github.com/OpenZeppelin/uniswap-hooks/commit/5e42129)
  - Dynamic-after-fee exact-output fix: [`2678eb9`](https://github.com/OpenZeppelin/uniswap-hooks/commit/2678eb9)
  - Secondary-account liquidity-penalty note/fix: [`bd7b885`](https://github.com/OpenZeppelin/uniswap-hooks/commit/bd7b885)

- **Flayer Sherlock contest code**:
  - Pinned contest repository path used by multiple findings: [`UniswapImplementation.sol` at `0ec252cf9ef0f3470191dcf8318f6835f5ef688c`](https://github.com/sherlock-audit/2024-08-flayer/blob/0ec252cf9ef0f3470191dcf8318f6835f5ef688c/flayer/src/contracts/implementation/UniswapImplementation.sol)

- **Doppler / Airlock Certora audit scope**: Certora reports repository `whetstoneresearch/doppler-smart-contracts` and commit `047e6297c0a04541856b45ed2d50849b22c015ad`. The public repository layout appears to have changed since the report, so the report's commit hash is the stable source of truth.
  - Likely current repository root: [`whetstoneresearch/doppler`](https://github.com/whetstoneresearch/doppler)
  - Report: [Certora Doppler Security Assessment](https://www.certora.com/reports/doppler-security-assessment-report)

- **Panoptic Next Core Code4rena audit scope**: Code4rena reports private repository `panoptic-labs/panoptic-next-core-private` at commit `29980a740b67f3e5d9df9d96264a246b51fc7b6b`. The public report is the stable source because the audited repository was private.
  - Report: [Code4rena Panoptic Next Core](https://code4rena.com/reports/2025-12-panoptic-next-core)

- **Cork Protocol and BoostHook**: no stable public GitHub commit for the affected source was verified. The analysis relies on public exploit reports, official postmortems, and transaction-level writeups.
  - Cork: [Dedaub analysis](https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/), [BlockSec analysis](https://blocksec.com/blog/cork-protocol-incident-two-independent-flaws-combine-into-one-devastating-exploit-chain), [Cork postmortem](https://www.cork.tech/blog/post-mortem)
  - BoostHook: [BlockSec weekly roundup, May 2026](https://blocksec.com/blog/weekly-web3-security-roundup-2026-05-17)

## Why Uniswap v4 changes the integration threat model

Uniswap v2 and v3 integrations were already dangerous. A protocol could misuse spot price, trust a manipulable pool, forget slippage, or mishandle liquidity positions. Uniswap v4 keeps those risks and adds a new class of integration surface: the AMM lifecycle itself becomes programmable.

That power is the point. It is also the trap.

### Singleton PoolManager

In v4, pools are not individual pool contracts in the v2 or v3 sense. The `PoolManager` is the singleton entry point that owns and updates pool state. A pool is identified by a `PoolKey`, not by a pool contract address. The important fields are conceptually:

```solidity
PoolKey({
    currency0: currency0,
    currency1: currency1,
    fee: fee,
    tickSpacing: tickSpacing,
    hooks: hooks
});
```

A pool is therefore not merely "USDC/WETH". It is `USDC/WETH` with a specific fee mode, tick spacing, and hook address. That means `PoolKey` is an execution environment. If an integration accepts a user-supplied `PoolKey`, it is often accepting user-supplied execution semantics.

This is the first recurring boundary mistake. Projects validate `currency0` and `currency1`, then forget that `hooks`, `fee`, and `tickSpacing` are equally security-critical. For a generic router, that may be fine: users can choose any pool and own the slippage risk. For a launchpad, vault, migrator, lending market, or synthetic asset protocol, it can be fatal.

### Hook address flags

Hooks are external contracts called by the `PoolManager` before or after pool lifecycle operations such as initialization, liquidity modification, swaps, and donations. v4 encodes hook permissions in the hook contract address. The low bits of the address tell the `PoolManager` which callbacks should be called.

This produces an unusual deployment-time security property: a hook address is not just an address; it is also a permission bitmap.

If an address advertises a callback but the contract does not implement it correctly, the pool operation can revert. If an address does not advertise a callback that the integration assumes will run, the integration's accounting may silently fail. If the address flags are accidentally mined with the wrong bits, the code can look correct while the runtime behavior is wrong.

Good hook constructors validate their own permission flags. Good deployment pipelines treat hook address mining as part of the security-critical build.

### Flash accounting and deferred settlement

v4's flash accounting model lets callers enter an `unlockCallback`, perform multiple operations, and settle net token deltas at the end. This reduces token transfers and enables powerful composition. It also changes how integrators must reason about state.

Inside an unlock flow, the question is not simply "did a token transfer happen?" The question is: who owes what, which delta sign means what, when does `settle` or `take` happen, and what external or persistent state has already been updated before the final settlement check?

A nonzero delta at the end usually reverts the transaction. That is a safety feature. But it only protects state that is inside the same revert domain. If a hook or integration updates persistent business accounting, emits events consumed by off-chain systems, calls an external system, or grants claims before the final invariant is known, the integration has stepped outside the simple safety story.

### Custom accounting and return deltas

v4 hooks can do more than observe swaps. They can implement custom accounting, charge hook fees, return deltas, and effectively build custom curves or execution logic around v4 pools. That is where v4 becomes more than a DEX primitive. It becomes a settlement kernel for new market designs.

The security implication is sharp: once a hook defines its own accounting, v4 core can no longer prove the higher-level invariant. The core may verify that the pool's net deltas settle. It does not know whether a TWAMM order was filled at the right average price, whether a vault share is fully backed, whether a synthetic claim corresponds to real collateral, whether a limit order was only marked filled after crossing, or whether an idle balance was rounded in a globally safe direction.

### Dynamic fees, native ETH, and larger assumption space

v4 adds dynamic LP fees, hook fees, native ETH support, and a broader hook-driven design space. Each of these features is useful. Each also invalidates assumptions carried over from older integrations.

- Dynamic fees mean fee setting can become an oracle, governance, or market-manipulation surface.
- Native ETH means `payable` paths, `receive`, refunds, and ETH-specific settlement logic matter again.
- Hook-level fee logic means exact-input and exact-output semantics must be tested separately.
- Custom tick and range usage means libraries that "worked for v3-like assumptions" may fail when v4 allows different configurations.

The result is not that v4 is unsafe. The result is that v4 makes hidden integration assumptions explicit. Some teams are ready for that. Many early integrations were not.

## True-positive cases: where v4 integration risk became real

### 1. Cork Protocol: callback access control was not a style issue

Cork is the cleanest example of a v4 hook integration failure becoming a large real-world exploit. Public analyses by Dedaub, BlockSec, and Cork's own postmortem attribute the incident to a chain of weaknesses, including a critical access-control flaw in Cork's custom Uniswap v4 hook path. The affected flow allowed the attacker to make the protocol believe that valuable Redemption Assets had been deposited and to obtain derivative claims that could be redeemed. Cork's postmortem reports that 3,761 wstETH were extracted, and external analyses describe the loss at roughly the 11 to 12 million USD scale.

The key hook-level issue was that a `beforeSwap` callback could be invoked directly instead of only by the `PoolManager`. That sounds almost too simple for a critical exploit, but it cuts directly through the v4 security boundary.

A vulnerable pattern looks like this:

```solidity
function beforeSwap(
    address sender,
    PoolKey calldata key,
    IPoolManager.SwapParams calldata params,
    bytes calldata hookData
)
    external
    override
    returns (bytes4, BeforeSwapDelta, uint24)
{
    // Business logic assumes this callback was reached through PoolManager.
    // hookData is parsed as trusted protocol context.
    // Internal claims, market state, or settlement state may be updated.
}
```

The absence of `onlyPoolManager` is not automatically critical in every hook. If the function only returns a selector and does not mutate meaningful state, direct external calls may be harmless. In Cork, however, the callback was part of a larger business flow involving derivative tokens, rollover logic, market context, and hook data. Direct invocation allowed the attacker to manufacture the appearance of a legitimate v4 swap context.

The deeper bug is not "forgot a modifier". The deeper bug is that the protocol treated callback execution as evidence that a real pool action had happened.

In v4, callback parameters are data. `msg.sender` is authority. If the protocol does not check that `msg.sender` is the trusted `PoolManager`, then the callback is just a public API with a scary name.

A safer skeleton is closer to:

```solidity
modifier onlyPoolManager() {
    if (msg.sender != address(poolManager)) revert NotPoolManager();
    _;
}

function beforeSwap(
    address sender,
    PoolKey calldata key,
    IPoolManager.SwapParams calldata params,
    bytes calldata hookData
)
    external
    override
    onlyPoolManager
    returns (bytes4, BeforeSwapDelta, uint24)
{
    _assertCanonicalPool(key);
    _assertExpectedSender(sender);
    _handleSwapContext(key, params, hookData);
    return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
}
```

Even that skeleton is incomplete unless `hookData` is domain-separated and validated against expected market state. But the first principle is non-negotiable: a sensitive hook callback must prove who called it before it believes why it was called.

**Verdict:** true positive, exploited.

**Why it was severe:** direct callback invocation modified or enabled valuable protocol accounting. The attacker crossed a business boundary that Uniswap core cannot see.

**Why similar reports are often low or invalid:** a public callback is not inherently a critical vulnerability if it is stateless, always reverts safely, or cannot affect claims, balances, pool state, order state, or fee accounting.

### 2. Bunni v2: rounding dust became TVL risk

Bunni v2 was a hook-based protocol built on Uniswap v4. Its exploit is the best public example of custom accounting risk. According to Bunni's own postmortem, the affected pools were the weETH/ETH pool on Unichain and the USDC/USDT pool on Ethereum, with total losses of roughly 8.4 million USD.

The exploit path was not a classic missing access control bug. It was more subtle. The attacker manipulated the pool into an extreme state, then repeated small withdrawals to compound a rounding error in idle-balance accounting. In Bunni's description, the attack pushed the spot tick far enough that one active balance became extremely small. Then many tiny withdrawals reduced the active balance and pool liquidity far more than the intuitive amount. The attacker could then reverse the price movement and extract value.

The vulnerable line in the exploit-era code is visible in `BunniHubLogic.sol` at commit `000f79a`:

```solidity
uint256 newBalance = balance - balance.mulDiv(shares, currentTotalSupply);
```

Source: [`BunniHubLogic.sol#L2728-L2741`](https://github.com/Bunniapp/bunni-v2/blob/000f79a/src/lib/BunniHubLogic.sol#L2728-L2741)

At first glance, this can look like a small rounding problem. In many protocols, a one-wei rounding direction is low severity. Bunni shows why that intuition is dangerous when the accounting is compositional.

The system did not have a single balance. It had raw balances in `PoolManager`, reserves in vaults, active and idle accounting, LP shares, and dynamic liquidity behavior. A rounding decision in one component changed how much liquidity the protocol believed it had. In an ordinary state, the difference might be tiny. In an extreme state, where one side's active balance was almost zero, repeated operations amplified the discrepancy until it became economically meaningful.

The real invariant was not "rounding should favor the protocol in this one formula". The real invariant was something like:

```text
withdrawable assets + active pool liquidity + idle balances + vault reserves
must remain consistent with total shares across all reachable price states,
including extreme imbalance and repeated small operations.
```

That invariant is much harder to prove. It requires stateful fuzzing, adversarial price movement, repeated tiny operations, and tests around pathological balances.

Bunni's postmortem states that the fix changed the rounding direction to use upward rounding in the relevant place and that exploit reproduction was no longer profitable. That is a useful patch-level statement, but the deeper lesson is broader: v4 custom accounting turns rounding into market structure. A one-wei error can be a market-making rule when it is embedded in a repeated, adversarially reachable state machine.

**Verdict:** true positive, exploited.

**Why it was severe:** rounding affected shared accounting and could be repeated after manipulating pool state into an extreme region.

**Why similar reports are often low:** if the error is bounded dust, non-repeatable, affects only the caller, or cannot change redeemable shares or shared liquidity, it is usually not high severity.

### 3. BoostHook: spot price is not an entry oracle

BoostHook is a smaller exploit by dollar value, but it is conceptually important. BlockSec reported that the protocol used a Uniswap v4 pool's `slot0.sqrtPriceX96` directly as the entry price for leveraged positions. The attacker manipulated the spot price in a single transaction, opened leveraged long positions at the manipulated price, and caused the protocol to buy at the wrong valuation using its own reserves. The reported loss was approximately 46.75 thousand USD.

This is not a new oracle lesson. It is the old AMM spot-price lesson inside a new hook-shaped machine.

Reading `slot0` is not itself wrong. Using `slot0` to execute a normal AMM swap with slippage bounds is ordinary. The problem appears when the spot price becomes an input to protocol solvency or protocol-funded valuation:

- leveraged entry price,
- collateral value,
- borrow limit,
- liquidation trigger,
- mint or redeem rate,
- internal fee conversion,
- synthetic position accounting.

In those cases, the price is not just a quote. It is an oracle. If it can be moved in the same transaction that consumes it, the protocol has lent authority to an attacker-controlled number.

BoostHook also illustrates a self-referential design risk. When a protocol borrows or deploys funds from the same pool whose spot price it uses to price the resulting position, price manipulation and protocol execution become one loop. The AMM does exactly what AMMs do: it moves price when traded. The integration fails because it treats that moved price as an external truth.

**Verdict:** true positive, exploited.

**Why it was severe:** the spot price drove protocol-funded leverage accounting, not merely user swap execution.

**Why similar reports are often invalid:** "uses spot price" is not enough. A report must show that the price is consumed by a value-moving protocol decision and that manipulation is economically reachable.

### 4. Doppler / Airlock: `PoolKey` is not metadata

The Doppler Certora report is one of the most useful public audits for v4 integrators because it repeatedly exposes the same design fact: in v4, a `PoolKey` is not passive metadata. It defines the pool's execution context.

The critical finding C-01 states that missing `PoolKey` validation allowed a complete fund drain from Airlock. The report describes an `Airlock.create` flow that allowed arbitrary hook values in the `PoolKey`, followed by a same-transaction migration path where a malicious hook could return arbitrary values and currencies. Because the currencies and amounts were not sufficiently validated, funds could be transferred through migrator logic under attacker-controlled assumptions.

This is a canonical true positive because it satisfies the full severity chain:

1. The attacker controls security-critical pool configuration.
2. The integration binds shared protocol funds to that configuration.
3. The malicious hook influences downstream migration behavior.
4. The protocol does not fully validate currencies, amounts, and recipients at the boundary.
5. The exploit path drains funds, not merely reverts a user transaction.

The important mistake is not just "untrusted hook". Permissionless hooks are a feature. The mistake is letting an untrusted hook become part of a canonical market or custody path without proving that it is the expected hook.

A v4 integration with custody should treat pool validation like this:

```solidity
function _assertCanonicalPool(PoolKey calldata key) internal view returns (PoolId id) {
    id = key.toId();

    if (id != expectedPoolId) revert InvalidPoolId();
    if (key.currency0 != expectedCurrency0) revert InvalidCurrency0();
    if (key.currency1 != expectedCurrency1) revert InvalidCurrency1();
    if (address(key.hooks) != expectedHook) revert InvalidHook();
    if (key.fee != expectedFee) revert InvalidFee();
    if (key.tickSpacing != expectedTickSpacing) revert InvalidTickSpacing();
}
```

That style is overkill for a generic router. It is not overkill for a vault, launchpad, migrator, lending market, or token issuance system.

**Verdict:** true positive, critical audit finding.

**Why it was severe:** attacker-controlled pool configuration affected shared funds and migration accounting.

**Why similar reports are often invalid:** if the user is simply routing their own swap through a pool they selected, arbitrary `PoolKey` support is expected behavior. The severity depends on who owns the funds being moved and whose invariants are being trusted.

### 5. Zaha Studio TWAMM hook: when custom execution becomes a second AMM

A TWAMM hook is not merely a callback. It is an execution engine. It accepts long-term orders, simulates or performs incremental execution, tracks sale rates, handles fees, and distributes proceeds over time. That means it must be correct as an AMM-like system, not just as a Uniswap extension.

The Certora audit of Zaha Studio's TWAMM hook reported two critical issues and several medium, low, and informational findings. The critical issues are especially instructive.

#### Incorrect fee implementation

The report found that Uniswap protocol fee and LP fee logic were incorrectly implemented. In Uniswap-style fee composition, protocol fee and LP fee are not always equivalent to a naive sum applied once to the gross amount. Fee order and precision matter. A TWAMM hook that computes its own execution must match the fee model it claims to implement.

This is a true positive because fees are not cosmetic. Fee mis-accounting changes who receives value: traders, LPs, protocol, or order owners. In a long-running order system, tiny fee errors can compound over time and across many orders.

#### `sqrtPriceX96` overflow

The report also found that squaring a large `sqrtPriceX96` in an unchecked block could overflow. This is the kind of bug that hides in plain sight because `sqrtPriceX96` is a familiar Uniswap number. Familiar is not safe. Near the upper bound, squaring a 160-bit-ish value can exceed 256-bit capacity if the expression is not scaled or bounded correctly.

A simplified dangerous pattern looks like:

```solidity
unchecked {
    uint256 priceX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
}
```

Depending on how the result is used, overflow can become an incorrect price, incorrect order execution, or fund loss.

The TWAMM case also gives good examples of downgraded findings. The report's M-02, about matching order exhaustion not averaging pool price history, was acknowledged as a trade-off rather than a straightforward theft path. The I-02 rebasing-token issue was downgraded to informational because rebasing tokens were not supported. Those are not meaningless findings, but they are not the same class as incorrect fee settlement or arithmetic overflow in the execution path.

**Verdict:** true positive for fee logic and overflow; mixed or lower severity for design trade-offs and unsupported token behavior.

**Why it was severe:** the hook implemented execution and accounting that directly determined user proceeds.

**Why some related findings were lower severity:** unsupported assets and documented trade-offs do not automatically become vulnerabilities unless they create reachable loss for supported use cases.

### 6. OpenZeppelin Uniswap hooks library: even reference-style hooks hit edge cases

OpenZeppelin's audits of the Uniswap hooks library are valuable because the audited code was not an obscure one-off integration. It was a library of hook implementations and abstractions intended to help developers build on v4.

The RC1 audit found 19 issues, including critical and high severity issues in hook designs such as liquidity penalties, limit orders, and anti-sandwich logic. The RC2 audit found fewer issues after refactoring, but still reported a high-severity infinite loop and a medium exact-output fee issue.

Three patterns stand out.

#### Tick alignment can become liveness risk

The RC2 high-severity issue involved iterating ticks with a loop condition that assumed `currentTick` aligned with `tickSpacing`. That assumption is not generally safe. If a loop advances through initialized ticks but waits to equal a non-aligned `currentTick`, it may never terminate.

This is not fund theft, but it can be high severity when it DoSes swaps or hook execution for a live pool.

The core lesson is that v4 hook code often handles tick math outside the narrow path where Uniswap core libraries have already normalized everything. If hook code walks ticks, compresses ticks, maps them into bitmaps, or uses current tick as a loop boundary, it must explicitly reason about alignment and bounds.

#### Exact-input and exact-output semantics cannot be hand-waved

The RC2 medium finding involved `BaseDynamicAfterFee` assuming that `unspecifiedAmount` represented output, which is not true in the same way for exact-output swaps. This is the kind of issue that appears repeatedly in v4 integrations: a field is semantically different depending on swap direction and exact-in/exact-out mode.

A serious v4 hook test matrix cannot only test one happy path. It needs at least:

```text
zeroForOne = true / false
exactInput = true / false
currency0 native / ERC20
currency1 native / ERC20
positive delta / negative delta
fee on input / fee on output
current tick aligned / non-aligned
```

If that matrix feels large, that is the point. Hooks are not decorators. They are execution logic.

#### Limit order and JIT fee accounting are adversarial state machines

RC1 findings around `LimitOrderHook` and `LiquidityPenaltyHook` show how hard it is to make fee snapshots and order state fair. A limit order can be incorrectly marked fully filled. A large order created right before a fill can capture previously accrued fees if the accounting does not distinguish active time or fee snapshots. A JIT penalty can be bypassed if fee accounting can be reset through a tiny liquidity modification.

These are true-positive design bugs because they break the economic promise of the hook. But OpenZeppelin's RC2 also contains a good low-severity example: secondary-account circumvention of a liquidity penalty. The report acknowledges feasibility but rates it low because the exploitability depends on price movement costs, pool liquidity, and user flow. That is an important severity lesson. Mechanism bypass is not always critical; the economic route matters.

**Verdict:** true positives for state-machine and semantic bugs; some low findings where the bypass is economically constrained.

**Why it matters:** if a well-reviewed hook library hits these edges, production protocols that copy patterns without understanding them will almost certainly do worse.

### 7. Flayer Sherlock findings: v4 lifecycle bugs are real even without theft

The Flayer contest findings show a cluster of lifecycle and hook-configuration mistakes that are not all direct fund drains but can still be serious.

#### Pool pre-initialization griefing

A high-severity Sherlock issue described how an attacker could front-run or preempt the protocol's `initializeCollection` flow by directly initializing the corresponding Uniswap v4 pool through `PoolManager.initialize`. Because the `PoolKey` was predictable, and because initialization can occur outside the protocol's intended factory flow, the later official initialization would fail with a pool-already-initialized condition.

This is a real v4 integration bug because v4 pool initialization is permissionless at the `PoolManager` level. If the integration needs initialization to bind business state, it cannot assume the only initializer is the integration's own function.

Mitigations include atomic creation and initialization, idempotent initialization logic, or a design where external pre-initialization does not bypass required business state.

#### Donate hooks mismatch

Another finding showed that fee distribution through `poolManager.donate` could be DoSed when donate hooks were not implemented consistently with the hook permissions and base hook behavior. If `beforeDonate` or `afterDonate` is expected by the hook address flags but the contract falls back to reverting base implementations, donation-based fee distribution can fail.

This is the practical consequence of hook address flags being runtime behavior, not documentation.

#### `beforeInitialize` always reverts

A related finding described a `beforeInitialize` hook that always reverted, blocking pool creation. Again, this is not glamorous, but it is real. If pool initialization is a core lifecycle path, a hook that always reverts on initialization can freeze markets before they exist.

#### Misusing swap math parameters

A confirmed Flayer issue involved treating `sqrtPriceLimitX96` as a target price rather than a boundary limit in internal swap math. That kind of semantic misuse is common when integrations call low-level math directly. Uniswap math libraries are sharp tools; parameter names that look familiar still need precise interpretation.

**Verdict:** true-positive DoS and semantic bugs.

**Why they were severe enough:** the affected paths could block collection initialization, fee distribution, or swap execution.

**Why similar reports may be lower severity:** if the failure happens before any user funds enter, or if there is an obvious retry path with no lasting harm, the issue may fall to medium or low.

### 8. Panoptic Next Core: v4 assumptions can break solvency checks

The Panoptic Next Core Code4rena report includes findings that are useful for integrators even where severity was debated or downgraded. One medium finding described how very wide tick ranges could cause solvency checks to revert because a computation like `getSqrtRatioAtTick(tickUpper - tickLower)` could exceed supported TickMath bounds. The issue was tied to v4's larger assumption space around tick spacing and valid ranges.

The interesting part is not only the math. It is the downstream effect: if a solvency or liquidation check reverts, an otherwise liquidatable account may become temporarily or permanently unliquidatable. In an options, margin, or lending-like system, a revert in risk checks can create bad debt.

Panoptic marked that particular issue as informative, which makes it a good boundary case. The mechanics are real, but severity depends on whether such ranges are accepted, whether users can create them in production, whether liquidations can be routed around the revert, and whether insolvency is economically reachable.

**Verdict:** valuable integration lesson; severity depends on reachability and accepted market parameters.

**Why it matters:** v4 integrations often import v3-era assumptions about ticks and ranges. Solvency code must be tested over the actual v4 configuration space that the protocol accepts.

## False positives, downgraded findings, and why they matter

A useful security methodology does not only collect true positives. It also explains why similar reports fail. Without that distinction, teams overfit to slogans: "always use TWAP", "never allow arbitrary hooks", "all public callbacks are critical", "rounding is exploitable". Those slogans are sometimes right and often incomplete.

The following are recurring false-positive or low-severity patterns in v4 integration audits.

### Pattern 1: "Anyone can create a malicious hook"

This is usually not a vulnerability by itself.

Uniswap is permissionless. Anyone can create a malicious token, malicious pool, malicious hook, malicious UI, or malicious route. A generic router that lets a user choose any v4 pool is not automatically vulnerable because one possible pool is malicious. The user is choosing the execution venue.

It becomes a true positive when the protocol binds shared funds or canonical state to that hook.

Doppler C-01 is the clean contrast. The issue was not that a malicious hook existed. The issue was that Airlock and migration logic could be made to treat attacker-controlled pool configuration and hook outputs as part of a legitimate custody path.

The severity question is:

```text
Whose money follows the untrusted PoolKey?
```

If the answer is "only the caller's swap input, with slippage controls", the report is probably low or invalid. If the answer is "the protocol's launch proceeds, vault TVL, migrator inventory, collateral pool, or all users' funds", the report may be critical.

### Pattern 2: "The hook callback is external"

All hook callbacks are external functions. That alone proves almost nothing.

A public `beforeSwap` that only returns a selector may be harmless. A public `beforeSwap` that updates order fill state, grants claims, consumes `hookData`, moves fees, writes an oracle checkpoint, or triggers a market rollover may be critical.

Cork shows the critical version. Composable Security's FullRange hook research shows the same principle around `beforeInitialize`. Gamma and Doppler-style findings summarized in public research repeat the pattern: callback access control matters when the callback performs privileged business logic.

The severity question is:

```text
Does direct callback invocation let an attacker create a state transition that should only be possible after a real PoolManager action?
```

If yes, it is a real bug. If no, it may be a style issue.

### Pattern 3: "Flash accounting can leave deltas unsettled"

In v4, unsettled deltas at the end of an unlock flow normally cause a revert. A report that stops at "this path leaves a nonzero delta" may simply describe a reverted transaction.

It becomes severe when one of the following is true:

- persistent protocol state is updated before the revert boundary is reached,
- external calls create effects outside the revert domain,
- claims are minted before settlement is proven,
- the revert can be used to permanently block a necessary protocol path,
- the integration misinterprets delta signs and settles in the wrong direction,
- a hook returns custom deltas that make the user or protocol pay the wrong side.

The severity question is:

```text
After the transaction reverts or settles, has any durable economic state changed incorrectly?
```

If the answer is no, the issue is likely a DoS, low, or invalid. If the answer is yes, it may be high.

### Pattern 4: "The protocol reads `slot0`"

This is one of the most common overreported issues in AMM audits.

Reading spot price is not automatically wrong. A swap must read or imply the current price. A UI can display spot price. A slippage-bound quote can use spot as one input. A keeper can use spot as a trigger if the final transaction enforces its own checks.

BoostHook is the true-positive version because the protocol used spot price as the entry price for leveraged positions funded by protocol reserves. The price was manipulable in the same transaction that consumed it.

Flayer issue #559 is a useful boundary case. The report claimed that fee-token internal swaps could be manipulated because the hook used current price rather than TWAP, and it included a PoC. The issue was labeled sponsor-disputed and won't-fix in the public Sherlock record. That does not mean the idea is worthless. It means a spot-price report still needs to prove the full value path, net profit, and violation of intended economics under the sponsor's accepted assumptions.

The severity question is:

```text
Is spot price being used as an oracle for protocol value, or merely as the current AMM execution price for a user-bounded trade?
```

### Pattern 5: unsupported tokens are not automatically in scope

The Zaha TWAMM report downgraded a rebasing-token issue to informational because rebasing tokens were not supported. That is the right kind of scoping discipline.

Unsupported token behavior can still matter if the protocol permissionlessly accepts arbitrary tokens and innocent users can be harmed. But if the protocol explicitly supports only standard ERC20s or a whitelist, and the behavior is documented, the finding is often low or informational.

The severity question is:

```text
Can a non-supported token enter a production market in a way that harms someone other than the token chooser?
```

### Pattern 6: economic bypass without economic feasibility

The OpenZeppelin RC2 low-severity liquidity-penalty finding is a good example. A user could use secondary accounts to partially avoid a penalty. Technically, that is a bypass. Economically, it may require moving price, waiting for user flow, or controlling enough activity that the cost dominates the benefit.

A mechanism can be imperfect without being high severity. Security severity is not moral purity. It is reachable impact.

The severity question is:

```text
Can the attacker execute the bypass profitably, repeatedly, and at meaningful size under realistic liquidity and MEV conditions?
```

### Pattern 7: trusted owner configuration

Arrakis's Uniswap v4 module audit includes examples around hook flags, module oracle validation, and approvals that are best read through the trust model. If the vault owner is fully trusted, then a bad owner-selected oracle or approval may be a note or centralization risk rather than an external exploit.

The same pattern becomes much more serious in a different system:

- strategy marketplaces,
- permissionless managers,
- delegated vault operators,
- factories that create markets for third-party users,
- governance-delayed but user-facing configuration.

The severity question is:

```text
Is the actor who can configure the dangerous value explicitly trusted by the users whose funds are at risk?
```

If yes, the report may be informational. If no, it can be high.

### Pattern 8: naming and documentation issues

The TWAMM report's `priceSq` naming note and OpenZeppelin's `getTargetOutput` naming issue are useful but not severe by themselves. They become dangerous only when downstream integrators build financial logic on a wrong interpretation.

Naming issues are not noise. They are weak signals. In hook systems, weak semantic signals often become real bugs after copy-paste, inheritance, or refactoring. But the immediate severity should match the immediate impact.

## A severity framework for Uniswap v4 integration findings

A v4 integration finding deserves high or critical severity when most of the following are true.

### 1. The trigger is untrusted

The attacker can supply or influence one of:

- `PoolKey`,
- hook address,
- hook data,
- swap parameters,
- initialization parameters,
- migration parameters,
- recipient,
- fee manager input,
- external vault or oracle,
- token pair,
- tick range,
- dynamic fee state.

Trusted-owner-only paths require a trust-model analysis before they can be called vulnerabilities.

### 2. The affected state is shared or durable

The issue affects:

- vault TVL,
- protocol reserves,
- migration inventory,
- collateral accounting,
- synthetic claims,
- order fill state,
- fee growth,
- reward distribution,
- liquidation or solvency state,
- canonical market initialization,
- user share price.

If only the caller's own swap reverts or executes with their accepted slippage, severity is much lower.

### 3. The broken invariant is outside Uniswap core's knowledge

This is the key v4 mental model. Core does not know that:

- a Cork derivative claim must be backed by real Redemption Assets,
- a Bunni share must represent a consistent slice of active, idle, and reserve balances,
- a TWAMM order must execute at a particular historical average,
- a limit order should not receive fees from before it became active,
- a BoostHook leveraged entry should use a manipulation-resistant price,
- a Panoptic solvency check must not revert for accepted ranges,
- an Airlock migration must only move canonical currencies to canonical recipients.

If the invariant is not a core invariant, the integration must enforce it.

### 4. The attack is economically reachable

A theoretical path is not enough. The report should address:

- flash-loan availability,
- liquidity depth,
- slippage cost,
- gas cost,
- MEV competition,
- repeatability,
- maximum extractable value,
- whether the attacker must control victim flow,
- whether the state can be reached before funds enter.

Bunni and BoostHook were economically reachable. Some penalty-bypass and spot-manipulation reports are not.

### 5. The final state is wrong, not merely reverted

Reverts can be serious when they freeze withdrawals, liquidations, market initialization, or fee distribution. But a revert in an optional path is usually lower severity than incorrect settlement.

A useful triage line is:

```text
Does the attacker end with more value, or can they force others to end with less access to value?
```

If not, the finding probably needs a lower severity.

## Core vulnerability classes and review notes

### PoolKey validation

Every custody-bearing integration should treat `PoolKey` as adversarial input unless it was constructed internally and verified at use time. This includes callbacks: do not assume a callback's `PoolKey` is canonical because the function was reached.

Review questions:

- Is `key.toId()` checked against expected storage?
- Are `currency0` and `currency1` checked in sorted order?
- Is `hooks` exactly the expected hook?
- Is `fee` exactly expected, including dynamic-fee flags?
- Is `tickSpacing` checked?
- Can a user initialize a pool with the same currencies but different hook or fee and pass it into protocol logic?
- Does the protocol ever derive token ownership, market identity, or migration authority from a partially checked key?

High-risk examples: Doppler C-01, Airlock migration paths, fake-market setups around derivative claims.

### Callback authorization

Sensitive callbacks should have `onlyPoolManager`. They should also validate `PoolKey`, expected action context, and hook data.

Review questions:

- Can `beforeSwap`, `afterSwap`, `beforeInitialize`, `afterInitialize`, `beforeAddLiquidity`, `afterAddLiquidity`, `beforeRemoveLiquidity`, `afterRemoveLiquidity`, `beforeDonate`, or `afterDonate` be called directly?
- If called directly, what storage changes?
- Is `sender` treated as authority?
- Is `hookData` authenticated or domain-separated?
- Can direct callback calls mint claims, mark orders filled, update fees, unlock reserves, or initialize market state?

High-risk examples: Cork, Composable FullRange research, Gamma-style limit order callback findings, Doppler `beforeInitialize` findings.

### Hook permission flags

Hook flags are code behavior encoded into an address. They deserve the same review attention as constructor parameters.

Review questions:

- Does the constructor call a flag validation routine such as `validateHookPermissions`?
- Are all advertised callbacks implemented and returning the expected selector?
- Are unused callback flags disabled?
- Are deployment scripts deterministic and reproducible?
- Are donate and initialize hooks tested in production-like flows?

High-risk examples: Flayer donate hook mismatch, `beforeInitialize` reverts, hook libraries with callback return issues.

### Flash accounting and delta signs

The v4 delta model is powerful and unforgiving. Most mistakes hide in sign conventions and exact-in/exact-out branches.

Review questions:

- Are positive and negative deltas interpreted consistently?
- Are exact-input and exact-output swaps tested separately?
- Are zero-for-one and one-for-zero branches symmetric where they should be?
- Does `settle`, `take`, and `sync` order differ for native ETH and ERC20?
- Can an external call happen while the protocol assumes a delta will later settle?
- Does the integration update persistent state before settlement is proven?
- Are custom deltas bounded and audited as value transfers?

High-risk examples: custom accounting hooks, fee hooks, routers that combine multiple v4 actions in one unlock.

### Custom accounting and rounding

Any hook that tracks shares, reserves, virtual balances, idle balances, sale rates, or custom curves needs invariant testing, not just unit tests.

Review questions:

- Is total asset value conserved across deposits, withdrawals, swaps, rebalances, and fee collection?
- Does share price behave monotonically where expected?
- Are rounding directions chosen globally, not locally?
- Can the attacker repeat tiny operations to amplify dust?
- Are extreme price states tested?
- Are one-sided near-zero balances tested?
- Are low-decimal tokens tested if supported?
- Are ERC4626 vault fees, withdrawal limits, and exchange-rate changes modeled?

High-risk examples: Bunni v2 exploit, TWAMM fee and precision bugs, custom curve hooks.

### Spot price and oracle boundaries

Every `slot0` read should be classified as either execution price or oracle input. The former may be fine. The latter needs manipulation resistance.

Review questions:

- Does spot price affect protocol-funded positions?
- Does it affect collateral value, borrow limit, liquidation, mint/redeem rate, or entry price?
- Can the same transaction manipulate and consume the price?
- Is there a TWAP, external oracle, impact cap, or post-trade solvency check?
- Is the pool whose price is read also the pool being traded by the attacker?

High-risk examples: BoostHook, disputed-but-instructive Flayer price-manipulation report, many older AMM oracle incidents outside v4.

### Dynamic fees

Dynamic fees are not just parameters. They are part of market execution.

Review questions:

- Who can update fees?
- Can fees be changed in the same transaction as a victim swap?
- Are fee overrides bounded?
- Are exact-output paths handled correctly?
- Are hook fees and LP fees composed in the correct order?
- Is fee state manipulable through spot price or short-term volume?

High-risk examples: TWAMM fee composition, OpenZeppelin `BaseDynamicAfterFee` exact-output semantics, fee auction hooks.

### Tick, range, and bitmap assumptions

When hook code reimplements tick logic, it inherits the sharpest parts of Uniswap math.

Review questions:

- Are ticks multiples of `tickSpacing` where required?
- What happens when `currentTick` is not aligned?
- Are loops bounded?
- Are compressed tick indexes safe for negative ticks?
- Is bitmap bit position conversion safe?
- Can accepted range widths exceed TickMath domain assumptions?
- Can a risk check revert for a position that the protocol allowed users to create?

High-risk examples: OpenZeppelin infinite loop, TWAMM tick bitmap overflow, Panoptic wide-range solvency checks.

### Native ETH and `Currency`

v4 native ETH support is useful, but it reopens old footguns.

Review questions:

- Are ERC20 and native ETH paths separated?
- Do ERC20 paths reject nonzero `msg.value`?
- Are refunds sent after all state-sensitive logic?
- Is `receive()` restricted or harmless?
- Can ETH be stuck in contracts that do not expose rescue flows?
- Does native settlement interact with reentrancy?

High-risk examples: Panoptic payable collateral path issue, Doppler missing receive-function findings.

### External dependencies and reentrancy

Hooks often call vaults, oracles, ERC4626s, bridges, lending markets, or token contracts. That means hook security becomes compositional security.

Review questions:

- Are external calls made inside hook callbacks?
- Can external calls reenter through PoolManager or another protocol entry point?
- Is state cached before an external call and trusted after it?
- Are vault exchange rates or withdrawal fees allowed to change during execution?
- Are oracles stale, manipulable, pausable, or chain-dependent?
- Can a hook be upgraded after users deposit?

High-risk examples: Bunni vault and custom-accounting surface, Arrakis trust-model notes, BlockSec's early hook-risk research on untrusted external calls.

## Case matrix

| Case | Category | Verdict | Core mistake | Why the severity lands there |
|---|---:|---:|---|---|
| Cork Protocol | Exploit | True positive, critical | Sensitive `beforeSwap` path lacked proper PoolManager-only authorization and trusted hook context | Direct callback-style invocation affected derivative claims and real redeemable value |
| Bunni v2 | Exploit | True positive, critical | Rounding in custom active/idle accounting could be amplified through extreme state and repeated tiny withdrawals | Shared TVL accounting changed, not just dust |
| BoostHook | Exploit | True positive, high | Used v4 pool spot price as leveraged entry oracle | Same-transaction price manipulation caused protocol-funded mispricing |
| Doppler / Airlock C-01 | Audit | True positive, critical | Missing `PoolKey`, hook, currency, and migrator validation | Attacker-controlled execution context could move shared funds |
| Zaha TWAMM C-01/C-02 | Audit | True positive, critical | Incorrect fee model and unchecked `sqrtPriceX96` square overflow | Hook directly determined order execution and proceeds |
| OpenZeppelin hooks RC1/RC2 | Audit | True positives mixed with lows | Tick iteration, exact-output fee semantics, limit-order state, JIT penalty accounting | Hook libraries had real state-machine errors; some bypasses were economically constrained |
| Flayer #342 | Sherlock | True positive, high | Permissionless pool pre-initialization could DoS protocol initialization | Protocol assumed its own initializer was the only initializer |
| Flayer #147/#293 | Sherlock | True positive, high/DoS | Hook permission and lifecycle mismatch around donate and initialize | Core fee or initialization flows could revert |
| Flayer #402 | Sherlock | True positive, high/DoS | Misused `sqrtPriceLimitX96` as target price in internal swap math | Swap path could revert due semantic misuse |
| Flayer #559 | Sherlock | Disputed boundary case | Claimed spot-price manipulation in fee conversion | Useful warning, but public record labels it sponsor-disputed and won't-fix |
| TWAMM M-02 | Audit | Design trade-off / medium | Matching order exhaustion did not average pool history | Real modeling issue, but not a straightforward theft path under accepted design |
| TWAMM I-02 | Audit | Informational | Rebasing tokens unsupported | Scope excluded the behavior |
| OpenZeppelin RC2 liquidity-penalty secondary accounts | Audit | Low | Penalty could be partially bypassed by splitting accounts | Economic feasibility limited severity |
| Panoptic wide-range TickMath issue | Code4rena | Informative / boundary | Accepted range could make solvency checks revert | Severity depends on reachable production parameters and liquidation design |
| Arrakis trusted configuration notes | Audit | Trust-model dependent | Owner-selected flags, oracle, approvals | Low/info under fully trusted owner, potentially high in permissionless manager models |

## The underlying pattern

The most important v4 integration bugs are not random. They follow one pattern:

```text
The integration treats a v4 mechanism as proof of a higher-level business fact,
but v4 core only proves the lower-level pool accounting fact.
```

Examples:

- A callback ran, therefore a legitimate swap happened. Cork shows why that is false without authorization.
- A `PoolKey` has the right tokens, therefore it is the right market. Doppler shows why the hook, fee, and tick spacing matter.
- A rounding direction is locally conservative, therefore the system is globally conservative. Bunni shows why repeated operations and extreme states matter.
- A spot price is the pool price, therefore it is a fair entry price. BoostHook shows why spot is not an oracle.
- A tick loop works on aligned ticks, therefore it works for live pool state. OpenZeppelin's infinite-loop finding shows why alignment assumptions matter.
- A token behavior is possible on Ethereum, therefore it is in scope. TWAMM's rebasing-token downgrade shows why protocol support boundaries matter.

This is why v4 audit work feels different. The hard part is rarely the call into `PoolManager`. The hard part is proving that the integration's own state machine remains correct around that call.

## Practical review checklist

This checklist is intentionally opinionated. It is written for protocols that custody funds or create claims around v4, not for simple user-directed routers.

### Boundary checks

- Validate `PoolId`, not only token pair.
- Validate `currency0`, `currency1`, `fee`, `tickSpacing`, and `hooks`.
- Treat user-supplied `PoolKey` as untrusted execution context.
- Domain-separate `hookData`.
- Do not trust callback parameters as authority.
- Use `onlyPoolManager` on sensitive callbacks.

### Lifecycle checks

- Assume anyone can initialize a v4 pool directly through `PoolManager`.
- Make initialization idempotent or atomic with business-state binding.
- Test all advertised hook callbacks.
- Verify hook address permission bits in constructor and deployment scripts.
- Test donate paths separately from swap and liquidity paths.

### Accounting checks

- Write invariants for total assets, shares, reserves, active balances, idle balances, fees, and claims.
- Fuzz repeated tiny deposits and withdrawals.
- Fuzz extreme ticks and one-sided near-zero balances.
- Test exact-input and exact-output swaps for both directions.
- Test native ETH and ERC20 paths independently.
- Verify rounding direction across the whole state machine, not formula by formula.

### Oracle and price checks

- Classify every spot-price read.
- Use TWAP or external oracle for protocol-funded valuation.
- Add impact caps when TWAP is not enough.
- Recompute solvency after state-changing actions.
- Do not let the same pool be both the manipulated venue and the trusted oracle without strong controls.

### External dependency checks

- Model ERC4626 fees, limits, and exchange-rate changes.
- Re-read state after external calls.
- Protect callbacks and ordinary entry points under the same reentrancy model.
- Treat upgradeable hooks, vaults, and oracles as governance risk.
- Add pause, TVL caps, and monitoring for early deployments.

### Severity triage checks

For each finding, ask:

1. Who controls the input?
2. Whose funds or claims are affected?
3. Is the affected state durable?
4. Is the broken invariant visible to Uniswap core?
5. Can the attack be executed profitably or at meaningful scale?
6. Is the actor trusted under the protocol's stated model?
7. Does the issue cause theft, bad debt, frozen funds, or only a revert?

Most false positives die somewhere in that list. Most criticals pass all seven.

## Closing thoughts

Uniswap v4 does not make integration security easier. It makes integration security more expressive.

That is a compliment and a warning. Hooks let builders place new market logic directly inside the AMM lifecycle. They make TWAMMs, dynamic fees, custom curves, JIT penalties, internal routers, launch mechanisms, vault strategies, and new derivative designs feel native. The design space is genuinely exciting.

But hooks also remove the comforting illusion that the AMM boundary is simple. Once a project uses a hook to create claims, move reserves, price leverage, fill orders, migrate funds, or rebalance vault shares, the project is no longer merely integrating a DEX. It is building a protocol on top of a settlement kernel.

The teams that do well with v4 will be the teams that internalize this distinction:

**PoolManager settles pool deltas. Your protocol must settle meaning.**

If a hook changes economic reality, it needs the same rigor as a lending market, a vault, or a derivatives engine. Access control must bind callback authority. `PoolKey` must be treated as execution context. Rounding must be proven over repeated adversarial states. Spot price must be demoted unless it is made manipulation-resistant. Tick math must be bounded. Native ETH must be handled deliberately. Trust models must be explicit.

The optimistic view is that these are solvable problems. The pessimistic view is that they are easy to miss. The realistic view is that both are true.

## References

- Uniswap Docs, v4 overview: <https://developers.uniswap.org/docs/protocols/v4/overview>
- Uniswap Docs, hooks: <https://developers.uniswap.org/docs/protocols/v4/concepts/hooks>
- Uniswap Docs, PoolManager: <https://developers.uniswap.org/docs/protocols/v4/concepts/poolmanager>
- Uniswap Docs, flash accounting: <https://developers.uniswap.org/docs/protocols/v4/concepts/flash-accounting>
- Uniswap Docs, dynamic fees: <https://developers.uniswap.org/docs/protocols/v4/concepts/dynamic-fees>
- Uniswap Docs, custom accounting: <https://developers.uniswap.org/docs/protocols/v4/guides/custom-accounting>
- Uniswap Docs, hook deployment: <https://developers.uniswap.org/docs/protocols/v4/guides/hooks/hook-deployment>
- OpenZeppelin, Uniswap v4 Core Audit: <https://www.openzeppelin.com/news/uniswap-v4-core-audit>
- BlockSec, Thorns in the Rose: Exploring Security Risks in Uniswap v4's Hook Mechanism: <https://blocksec.com/blog/thorns-in-the-rose-exploring-security-risks-in-uniswap-v4-s-novel-hook-mechanism>
- Dedaub, The $11M Cork Protocol Hack: <https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/>
- BlockSec, Cork Protocol Incident: <https://blocksec.com/blog/cork-protocol-incident-two-independent-flaws-combine-into-one-devastating-exploit-chain>
- Cork Protocol Postmortem: <https://www.cork.tech/blog/post-mortem>
- Bunni v2 Exploit Postmortem: <https://blog.bunni.xyz/posts/exploit-post-mortem/>
- BlockSec, Bunni Incident Analysis: <https://blocksec.com/blog/bunni-incident-repeated-small-withdrawals-compound-a-rounding-error-into-an-8.4m-drain>
- Bunni v2 GitHub repository: <https://github.com/Bunniapp/bunni-v2>
- BlockSec, Weekly Web3 Security Roundup, May 17 2026: <https://blocksec.com/blog/weekly-web3-security-roundup-2026-05-17>
- Certora, Doppler Security Assessment Report: <https://www.certora.com/reports/doppler-security-assessment-report>
- Certora, Doppler PDF report: <https://certora.cdn.prismic.io/certora/Z6zPyJbqstJ9-ib-_DopplerSecurityAssessmentReport_Final.pdf>
- Certora, TWAMM Hook Report: <https://www.certora.com/reports/twamm-hook>
- Certora, TWAMM Hook PDF report: <https://certora.cdn.prismic.io/certora/aJ2weKTt2nPbaUJ0_TWAMMv1.1SecurityReport.pdf>
- Zaha Studio TWAMM Hook repository: <https://github.com/akshatmittal/v4-twamm-hook>
- OpenZeppelin, Uniswap Hooks v1.1.0-rc.1 Audit: <https://www.openzeppelin.com/news/openzeppelin-uniswap-hooks-v1.1.0-rc-1-audit>
- OpenZeppelin, Uniswap Hooks v1.1.0-rc.2 Audit: <https://www.openzeppelin.com/news/openzeppelin-uniswap-hooks-v1.1.0-rc-2-audit>
- Sherlock Flayer issue #342, pre-initialization DoS: <https://github.com/sherlock-audit/2024-08-flayer-judging/issues/342>
- Sherlock Flayer issue #147, donate hook mismatch: <https://github.com/sherlock-audit/2024-08-flayer-judging/issues/147>
- Sherlock Flayer issue #293, `beforeInitialize` reverts: <https://github.com/sherlock-audit/2024-08-flayer-judging/issues/293>
- Sherlock Flayer issue #402, `sqrtPriceLimitX96` misuse: <https://github.com/sherlock-audit/2024-08-flayer-judging/issues/402>
- Sherlock Flayer issue #559, disputed spot-price manipulation report: <https://github.com/sherlock-audit/2024-08-flayer-judging/issues/559>
- Code4rena, Panoptic Next Core Report: <https://code4rena.com/reports/2025-12-panoptic-next-core>
- ChainSecurity, Arrakis Uniswap V4 Module Audit: <https://reports.chainsecurity.com/ArrakisFinance/ChainSecurity_ArrakisFinance_UniswapV4Module_Audit.pdf>
- Composable Security, Bad Hook with Broken Access Control: <https://composable-security.com/blog/uniswap-v4-bad-hook-with-broken-access-control/>
- Cyfrin, Uniswap v4 Hooks Security Deep Dive: <https://www.cyfrin.io/blog/uniswap-v4-hooks-security-deep-dive>
