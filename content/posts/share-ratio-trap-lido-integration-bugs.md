---
title: "The Share-Ratio Trap: Why Lido Integrations Keep Breaking DeFi Accounting"
date: "2026-05-28"
slug: "share-ratio-trap-lido-integration-bugs"
categories:
  - DeFi
  - Security Research
tags:
  - lido
  - lst
  - accounting
  - defi
---

# The Share-Ratio Trap: Why Lido Integrations Keep Breaking DeFi Accounting

*Not your shares, not your solvency.*

Lido is one of the most widely integrated pieces of Ethereum infrastructure, and that is exactly why its integration bugs are interesting. Most of the serious incidents and audit findings around Lido integrations are not failures of Lido itself. They are failures of accounting boundaries. A protocol takes an asset that is deliberately not a normal ERC-20, feeds it into a lending market, vault, oracle, withdrawal queue, or leveraged position manager, and somewhere along the path it silently changes the unit of account.

The recurring pattern is brutally simple:

```text
stETH amount != stETH shares
wstETH exchange rate != market price
WithdrawalQueue request != synchronous withdrawal
balanceOf delta != user-supplied amount
oracle cap != live exchange rate
```

Those inequalities are not academic. They have produced validated high-severity audit findings, medium-severity design breaks, real production incidents, unfair liquidations, locked withdrawals, stuck yield, and exploitable pricing surfaces. They have also produced a mountain of noisy submissions. The hard part is not saying "stETH rebases". Everyone knows that. The hard part is proving that the protocol's invariant breaks when the rebase, price update, queue finalization, or rounding event happens at the wrong time.

This article is about that line: when a Lido-related finding is real, when it is noise, and what the public case history tells us about the deeper design mistake.

The scope here is external integrations of Lido assets and flows, mainly stETH, wstETH, and the WithdrawalQueue. It is not an audit of Lido core. Public audit data is messy, with duplicates, sponsor disputes, downgraded severities, and findings that depend heavily on protocol intent. I collapse duplicates and focus on reusable failure modes. Private reports and unpublished triage decisions are outside the public record.

## 1. The Lido mental model that integrations keep getting wrong

### 1.1 stETH is a share-accounted, rebasing receipt

When a user stakes ETH through Lido, they receive stETH. Externally, stETH looks like an ERC-20. Internally, balances are derived from shares in the total pooled ether controlled by the protocol. The important relationship is:

```text
stETH balance = account shares * totalPooledEther / totalShares
```

Lido's own integration guide makes the relevant integration hazards explicit: stETH balances can change after oracle reports, these rebases do not emit `Transfer` events, and the rebasing can be positive or negative. The guide also recommends share-based accounting for integrations that need precision and points to functions such as `getSharesByPooledEth`, `getPooledEthByShares`, and `transferShares`. See the official [Lido tokens integration guide](https://docs.lido.fi/guides/lido-tokens-integration-guide/).

The core implication is that an external protocol must decide what it owes:

```text
Do we owe the user a fixed nominal amount of stETH?
Or do we owe the user the same share of Lido pooled ETH exposure?
```

Those are different promises. A vault can safely socialize Lido rewards and penalties by storing shares. It can also intentionally promise a fixed nominal amount, but then the vault, not the user, is underwriting rebase risk. What fails is the accidental middle ground: storing nominal stETH amounts while assuming the economics of shares.

A minimal bad shape looks like this:

```solidity
// The protocol stores a nominal stETH amount.
owedStETH[user] = amount;

// Time passes. stETH rebases.

// The protocol later pays the old nominal amount.
stETH.transfer(user, owedStETH[user]);
```

A safer shape is:

```solidity
// The protocol stores the user's share claim.
owedShares[user] = stETH.getSharesByPooledEth(amount);

// Time passes. stETH rebases.

// The protocol later transfers the same share exposure.
stETH.transferShares(user, owedShares[user]);
```

This is the design line behind many of the most important true positives.

### 1.2 wstETH removes rebasing balances, not price-domain mistakes

wstETH wraps stETH into a non-rebasing ERC-20. The wstETH balance remains fixed, while each unit of wstETH represents an increasing or decreasing amount of stETH through the wrapper exchange rate. Lido documents this difference directly: stETH is rebasing, wstETH is non-rebasing, and wstETH value is obtained through functions such as `stEthPerToken()` or `getStETHByWstETH()`. See the official [stETH and wstETH integration notes](https://docs.lido.fi/guides/lido-tokens-integration-guide/#wsteth).

That solves one category of accounting bugs. It does not solve pricing bugs.

A wstETH exchange-rate call answers:

```text
How much stETH can I unwrap from 1 wstETH?
```

It does not answer:

```text
How much USD is 1 wstETH worth?
How much ETH would the market pay for 1 stETH today?
Can this collateral be liquidated at that value right now?
```

A correct price expression usually has two layers:

```text
wstETH/USD = wstETH/stETH exchange rate * stETH/USD market price
wstETH/ETH = wstETH/stETH exchange rate * stETH/ETH market price
```

Many integrations forgot one side of that equation. Others used a market-rate feed where their accounting expected a redemption-rate feed. Some used a spot DEX quote as if it were an oracle. Some put a cap on an exchange rate and later discovered that the cap itself had become part of the pricing system.

### 1.3 WithdrawalQueue is a state machine, not `withdraw(amount)`

Lido withdrawals are asynchronous. A withdrawal request locks stETH or wstETH, mints an unstETH NFT, waits for finalization, and later claims ETH. Lido documents the request and claim flow, including the NFT representation, the request size bounds, the inability to cancel a request, and the fact that the claimable ETH may be lower than the requested amount in slashing scenarios. See the [Lido withdrawal documentation](https://docs.lido.fi/guides/lido-tokens-integration-guide/#withdrawals-unsteth) and the [withdrawals overview](https://docs.lido.fi/guides/lido-tokens-integration-guide/#withdrawals-unsteth).

For integrators, this means a WithdrawalQueue request ID is not an event log convenience. It is an asset. It should be stored, indexed, and protected like an asset.

A bad integration shape looks like this:

```solidity
uint256[] memory ids = withdrawalQueue.getWithdrawalRequests(holder);
withdrawalQueue.claimWithdrawal(ids[0]);
```

The assumption is that `ids[0]` is the protocol's request. But if a third party can create a dust request for the same owner address before the real request, the true request may no longer be at index zero. That is not theoretical. It appears in a validated Sherlock case discussed below.

### 1.4 Lido deposit path is not always best execution

Submitting ETH to Lido mints stETH through the protocol. Buying stETH from the market may be better when stETH trades below ETH. Lido's guide itself discusses staking rate limits and the alternative of obtaining stETH via secondary markets when appropriate. See the [integration guide section on staking limits and secondary market routes](https://docs.lido.fi/guides/lido-tokens-integration-guide/#staking-rate-limits).

This is a subtle class. It is not always a smart contract vulnerability. A protocol can intentionally choose direct minting. But if the protocol claims to optimize deposits, has no user `minOut`, or internalizes the loss across users, this becomes a real value leak.

### 1.5 The 1-2 wei problem is small until it is not

Lido documents a common stETH precision issue: because balances are derived from shares and integer division, transferring an apparent full stETH balance can leave 1-2 wei behind, and transfers can be off by a tiny amount. The official recommendation is to use share methods when exactness matters. See [stETH internals and share mechanics](https://docs.lido.fi/guides/lido-tokens-integration-guide/#steth-internals-share-mechanics).

Alone, this is usually dust. In a composable contract, dust can become a hard revert:

```solidity
stETH.transferFrom(user, address(this), amount);
wstETH.wrap(amount); // may revert if only amount - 1 was received
```

The right shape is balance-delta accounting:

```solidity
uint256 beforeBal = stETH.balanceOf(address(this));
stETH.transferFrom(user, address(this), amount);
uint256 received = stETH.balanceOf(address(this)) - beforeBal;
wstETH.wrap(received);
```

The difference between those snippets is the difference between a QA note and a high-severity denial of service.

## 2. A severity lens: what makes a Lido finding real?

A useful Lido-integration finding usually proves at least one of the following:

1. A cross-time liability is stored in the wrong unit.
2. A price feed is used in the wrong domain.
3. An asynchronous withdrawal right is treated as synchronous cash.
4. A manipulable or stale oracle changes borrow, mint, redeem, or liquidation math.
5. A small precision loss feeds into exact-amount state transitions and causes a revert or stuck funds.
6. An external dependency can fail after local state or native funds have already moved.

A noisy finding usually does one of the following instead:

1. It says "stETH rebases" without showing a broken invariant.
2. It says "stETH can depeg" without showing who is promised a pegged exit.
3. It says "negative rebase" without showing a claim-order, accounting, or solvency consequence.
4. It says "Lido can pause" while the protocol safely reverts atomically.
5. It says "1 wei rounding" but no downstream code requires exact equality.
6. It assumes a token or route that is not actually supported in scope.

The best mental model is not token-specific. It is invariant-specific.

```text
If total user claims are denominated in stETH amounts,
while protocol assets move in stETH shares,
then a rebase can create winners and losers.
```

```text
If borrow power uses an exchange rate,
while liquidation proceeds depend on market price,
then the protocol may mint bad debt or liquidate healthy accounts.
```

```text
If a request ID is discovered by scanning queue state,
while third parties can create requests for the same owner,
then the request can be displaced.
```

The rest of this article applies that lens to public cases.

## 3. True positives: where the integration actually breaks

### 3.1 Lybra: fixed collateral amounts let users escape negative rebases

**Classification:** True positive, Code4rena Medium, sponsor acknowledged.

**Public record:** [Lybra finding #931](https://github.com/code-423n4/2023-06-lybra-findings/issues/931).

**Commit-pinned code pointers:**

- [`LybraEUSDVaultBase.sol`, collateral accounting](https://github.com/code-423n4/2023-06-lybra/blob/7b73ef2fbb542b569e182d9abf79be643ca883ee/contracts/lybra/pools/base/LybraEUSDVaultBase.sol#L79)
- [`LybraEUSDVaultBase.sol`, withdrawal path](https://github.com/code-423n4/2023-06-lybra/blob/7b73ef2fbb542b569e182d9abf79be643ca883ee/contracts/lybra/pools/base/LybraEUSDVaultBase.sol#L103)

Lybra's issue is the cleanest version of the share-ratio trap. The vault stored the amount of stETH a user deposited. If Lido experienced a negative rebase, the vault's stETH balance would decrease, but the user's recorded collateral amount would not. A user could deposit before the negative rebase and withdraw after it, receiving the same nominal stETH amount while the vault paid out more shares than the user originally contributed.

This is not simply "stETH can rebase". The broken invariant is:

```text
sum(recorded collateral amounts) can exceed the stETH balance represented by the vault's shares.
```

The exploitability comes from timing. A user who can avoid being the residual holder during the negative rebase can shift the loss to the vault or to other users. In a share-based system, every holder absorbs the same percentage change. In Lybra's amount-based accounting, early exiters could preserve nominal amount while remaining holders absorbed the share loss.

The right fix is not just "use wstETH". It is more precise:

```text
If the user is meant to own Lido exposure, store shares.
If the protocol promises nominal stETH, reserve capital for rebase risk.
```

Lybra accidentally made the second promise while economically expecting the first.

### 3.2 Renzo H-05: pending withdrawals cached `amountToRedeem` across rebases

**Classification:** True positive, Code4rena High.

**Public record:** [Renzo report, H-05](https://code4rena.com/reports/2024-04-renzo#h-05-withdrawals-of-rebasing-tokens-can-lead-to-insolvency-and-unfair-distribution-of-protocol-reserves).

**Commit-pinned code pointer:**

- [`WithdrawQueue.sol`, request and claim flow](https://github.com/code-423n4/2024-04-renzo/blob/519e518f2d8dec9acf6482b84a181e403070d22d/contracts/Withdraw/WithdrawQueue.sol#L206-L263)

Renzo's withdrawal queue stored a fixed `amountToRedeem` for the asset being withdrawn. That works for non-rebasing assets. It does not work for stETH while the claim remains pending.

The bug is almost the same invariant failure as Lybra, but in a more dangerous place: an explicit withdrawal queue. A user requests withdrawal at time T0. The protocol records a nominal amount of stETH. The claim is executed at time T1. Between T0 and T1, the contract's stETH balance can change because the same shares now map to a different pooled ETH amount.

If stETH negatively rebases, the queue may not have enough nominal stETH to satisfy all fixed claims. First claimers can be overpaid relative to their share of the remaining pool. Later claimers may fail. If stETH positively rebases, the protocol may underpay withdrawing users relative to the share exposure they had during the waiting period.

The judge's sustained high-severity framing is the correct one: the bug is not about whether a negative rebase is common. It is about the queue converting a pro-rata asset into fixed first-come-first-served liabilities.

The mitigation is conceptually exact:

```solidity
uint256 shares = stETH.getSharesByPooledEth(amountToRedeem);
// store shares, not amount

// later
stETH.transferShares(user, shares);
```

This case is a strong rule for any integration that queues stETH withdrawals: if the queue lasts across blocks, the claim should usually be expressed in shares.

### 3.3 BendDAO H-01: treating strategy shares as assets broke NFT yield distribution

**Classification:** True positive, Code4rena High.

**Public record:** [BendDAO report, H-01](https://code4rena.com/reports/2024-07-benddao#h-01-sharesassets-mismatch-causes-protocol-to-lose-funds).

**Commit-pinned code pointers:**

- [`YieldStakingBase.sol`, shares/assets accounting](https://github.com/code-423n4/2024-07-benddao/blob/117ef61967d4b318fc65170061c9577e674fffa1/src/yield/YieldStakingBase.sol#L250-L255)
- [`YieldEthStakingLido.sol`, Lido staking adapter](https://github.com/code-423n4/2024-07-benddao/blob/117ef61967d4b318fc65170061c9577e674fffa1/src/yield/lido/YieldEthStakingLido.sol#L120-L122)

BendDAO's issue is a reminder that "shares" is not only a Lido word. Vaults, strategies, and staking adapters often return shares. If the caller treats those shares as underlying assets, the error propagates into user-level accounting.

The BendDAO finding described a yield staking flow where the strategy returned minted shares, but the base contract treated them as asset amounts while calculating per-NFT yield. The result was not just a display mismatch. One NFT could claim too much yield early, leaving later NFTs with losses or liquidation risk.

The essential shape is:

```text
strategy returns shares
caller records assets
yield distribution assumes assets
first claimant extracts more than fair share
later claimant inherits the deficit
```

This is why "share/asset mismatch" should be treated as a first-class audit category, especially around LST integrations. Lido made the accounting trap famous, but the same bug appears whenever a wrapper, vault, or strategy uses share semantics.

### 3.4 Saffron: stETH/share ratio changes broke fixed and variable side accounting

**Classification:** True positive or strongly valid design issue, Sherlock Medium-class public issues, sponsor disputed in some cases.

**Public records:**

- [Saffron issue #92, slashing and `fixedSidestETHOnStartCapacity`](https://github.com/sherlock-audit/2024-08-saffron-finance-judging/issues/92)
- [Saffron issue #129, protocol-fee accounting across stETH/share changes](https://github.com/sherlock-audit/2024-08-saffron-finance-judging/issues/129)

**Commit-pinned code pointer:**

- [`LidoVault.sol`, protocol fee and share-rate-sensitive accounting](https://github.com/sherlock-audit/2024-08-saffron-finance/blob/38dd9c8436db341c331f1b14545770c1766fc0ee/lido-fiv/contracts/LidoVault.sol#L773-L785)

Saffron's Lido vault cases are valuable because they show the same Lido property hitting a more complex payoff surface. A fixed side and a variable side split Lido yield and loss. That design can be legitimate, but it demands brutal consistency about what is measured in ETH, what is measured in stETH, and what is measured in Lido shares.

One issue focused on slashing. If a slash decreases the stETH ETH-per-share ratio, an early withdrawal can reduce a capacity variable by the lossy withdrawn amount rather than by the original fixed-side entitlement. If the ratio later recovers, the next fixed-side users can withdraw more than their initial deposit, pushing the loss to variable-side users.

Another issue focused on protocol-fee accounting. Variable users who withdraw during the vault and later after the vault ends can be charged or credited incorrectly when fee variables and share-denominated earnings are mixed. The mechanical details are different, but the invariant is the same:

```text
A payoff formula that mixes current stETH balance, initial ETH capacity,
Lido shares, withdrawn earnings, and protocol fees must keep every term in one coherent unit.
```

The lesson is that complex yield-splitting vaults cannot patch Lido support with one conversion function. The whole payoff tree must be audited as a dimensional-analysis problem.

### 3.5 Morpheus M-02: balance-delta handling was correct in one layer and lost in the next

**Classification:** True positive, Code4rena Medium.

**Public record:** [Morpheus report, M-02](https://code4rena.com/reports/2025-08-morpheus#m-02-inconsistent-balance-accounting-in-steth-deposits-leads-to-dos-of-core-functions-and-reward-loss).

**Commit-pinned code pointers:**

- [`DepositPool.sol`, balance-delta based stETH receipt](https://github.com/code-423n4/2025-08-morpheus/blob/a65c254e4c3133c32c05b80bf2bd6ff9eced68e2/contracts/capital-protocol/DepositPool.sol#L379-L384)
- [`Distributor.sol`, recorded amount and last underlying balance](https://github.com/code-423n4/2025-08-morpheus/blob/a65c254e4c3133c32c05b80bf2bd6ff9eced68e2/contracts/capital-protocol/Distributor.sol#L295-L301)
- [`Distributor.sol`, reward calculation](https://github.com/code-423n4/2025-08-morpheus/blob/a65c254e4c3133c32c05b80bf2bd6ff9eced68e2/contracts/capital-protocol/Distributor.sol#L384-L386)

Morpheus is a subtle and important case because one part of the system did the right thing. The deposit pool used a before/after balance delta when receiving stETH, exactly as Lido recommends for precision. The bug appeared when the amount passed into the distributor was later stored as if it were the actual received balance.

That creates a small accounting excess:

```text
stored deposited amount > actual token balance
```

Small does not mean harmless. The reward distributor later computes yield as:

```text
current balance - lastUnderlyingBalance
```

If `lastUnderlyingBalance` is slightly too high, the subtraction can underflow or block reward distribution until enough stETH yield accrues to cover the difference. The lost yield needed to repair the accounting gap becomes invisible to users.

This is one of the best examples of why Lido integration review has to follow the data across contract boundaries. It is not enough for the receiving function to use balance deltas. Every downstream accounting write must use the received delta too.

### 3.6 Sophon #63: the 1-2 wei stETH rounding issue became a hard DoS

**Classification:** True positive, Sherlock High, sponsor confirmed.

**Public record:** [Sophon issue #63](https://github.com/sherlock-audit/2024-05-sophon-judging/issues/63).

**Commit-pinned code pointers:**

- [`SophonFarming.sol`, `depositStEth` transfer path](https://github.com/sherlock-audit/2024-05-sophon/blob/05059e53755f24ae9e3a3bb2996de15df0289a6c/farming-contracts/contracts/farm/SophonFarming.sol#L474-L478)
- [`SophonFarming.sol`, ETH to stETH conversion path](https://github.com/sherlock-audit/2024-05-sophon/blob/05059e53755f24ae9e3a3bb2996de15df0289a6c/farming-contracts/contracts/farm/SophonFarming.sol#L808-L813)

The Sophon rounding issue is the canonical example of a tiny Lido quirk becoming a real bug. stETH transfers can deliver 1-2 wei less than the requested amount because of share rounding. Sophon's flow transferred `_amount` stETH from the user and then passed the same `_amount` into later conversion logic. If the contract received `_amount - 1`, the later wrap call could revert.

The impact was not loss of 1 wei. The impact was that a supported deposit path could be denied service. That is why the finding was treated as high severity in Sherlock.

The broader rule is:

```text
Dust is low severity when it remains dust.
Dust is high severity when exact-amount assumptions turn it into a stuck state or revert.
```

### 3.7 Alchemix: wstETH-to-stETH rate was treated as underlying WETH price

**Classification:** True positive, Code4rena Medium.

**Public record:** [Alchemix finding #97](https://github.com/code-423n4/2022-05-alchemix-findings/issues/97).

**Commit-pinned code pointer:**

- [`WstETHAdapterV1.sol`, `price()`](https://github.com/code-423n4/2022-05-alchemix/blob/de65c34c7b6e4e94662bf508e214dcbf327984f4/contracts-full/adapters/lido/WstETHAdapterV1.sol#L82-L84)

Alchemix's Lido adapter returned the amount of stETH represented by wstETH and used that as the price of the underlying WETH. That is a price-domain error. `getStETHByWstETH()` converts wrapper units. It does not convert stETH into ETH market value.

The dangerous part is where the wrong price lands. The finding noted that balance calculations depended on the yield token converted to underlying, which could overstate or understate harvestable amounts. In other words, this was not a cosmetic price display. It fed core strategy accounting.

The clean expression is:

```text
wstETH -> stETH is an exchange-rate conversion.
stETH -> WETH is a market-price conversion.
Skipping the second step assumes peg where the system needed price.
```

### 3.8 Asymmetry H-06: wstETH accounting assumed stETH could always be treated as ETH

**Classification:** True positive, Code4rena High, mitigation review found an incomplete fix.

**Public record:** [Asymmetry report, H-06](https://code4rena.com/reports/2023-03-asymmetry#h-06-wsteth-derivative-assumes-1-steth--1-eth).

**Commit-pinned code pointers:**

- [`WstEth.sol`, `ethPerDerivative`](https://github.com/code-423n4/2023-03-asymmetry/blob/44b5cd94ebedc187a08884a7f685e950e987261c/contracts/SafEth/derivatives/WstEth.sol#L56-L67)
- [`WstEth.sol`, withdrawal slippage path](https://github.com/code-423n4/2023-03-asymmetry/blob/44b5cd94ebedc187a08884a7f685e950e987261c/contracts/SafEth/derivatives/WstEth.sol#L86-L88)

Asymmetry's wstETH derivative treated `getStETHByWstETH(1e18)` as though it were an ETH amount. That assumes stETH trades at 1 ETH. In the withdrawal path, the mitigation review found another version of the same problem: `minOut` was still based on stETH amount rather than ETH value, so the protocol could be DoSed or users could be exposed when stETH traded below the assumed range.

This case is useful because it shows that slippage parameters are not magic. A `minOut` in the wrong unit does not protect the user. It may even give a false sense of safety.

A correct integration has to answer:

```text
What does the user want to receive?
ETH, stETH, wstETH, or a protocol share?
What price domain is the minOut expressed in?
Can the asset used for minOut diverge from the asset actually delivered?
```

Asymmetry's issue was not merely that stETH depegged in the past. It was that the contract's redemption logic implicitly promised ETH-like value while measuring only stETH wrapper exchange rate.

### 3.9 Renzo M-14: market-rate feeds and exchange-rate feeds do not compose for free

**Classification:** Valid but nuanced, Code4rena Medium.

**Public record:** [Renzo report, M-14](https://code4rena.com/reports/2024-04-renzo#m-14-the-use-of-market-rate-of-steth-to-eth-in-depositwithdrawals-could-lead-to-loss-of-funds).

**Commit-pinned code pointers:**

- [`RestakeManager.sol`, collateral valuation path](https://github.com/code-423n4/2024-04-renzo/blob/519e518f2d8dec9acf6482b84a181e403070d22d/contracts/RestakeManager.sol#L491)
- [`RenzoOracle.sol`, oracle infrastructure](https://github.com/code-423n4/2024-04-renzo/blob/519e518f2d8dec9acf6482b84a181e403070d22d/contracts/Oracle/RenzoOracle.sol#L68-L81)

Renzo's M-14 is not as clean as H-05, and that is why it is useful. The issue argued that using the stETH/ETH market-rate feed alongside exchange-rate style feeds for other LSTs could let users exploit discrepancies in mint and redemption math. The sponsor argued that using market rate was expected behavior. The judge sustained the finding as a real economic concern.

This is the kind of case where severity depends on the protocol's contract with users. If a basket token explicitly prices every collateral at market value, then a market-rate feed is not automatically wrong. If the basket mixes market-rate and redemption-rate assets while allowing mint/redeem against the same share supply, users may be able to enter with one price domain and exit through another.

The deeper insight is that "price" is not a scalar. It is a promise about settlement:

```text
Market price answers: what can I trade this for now?
Exchange rate answers: what does the wrapper redeem for?
Accounting rate answers: how much value does the protocol assign internally?
Liquidation value answers: what can be recovered under stress?
```

Using one where another is expected can be a vulnerability even when every individual feed is correct.

### 3.10 Iron Bank: PToken for wstETH bypassed the wstETH pricing branch

**Classification:** True positive, Sherlock Medium, will fix.

**Public record:** [Iron Bank issue #220](https://github.com/sherlock-audit/2023-05-ironbank-judging/issues/220).

**Code pointer:**

- [`PriceOracle.sol`, wstETH pricing branch](https://github.com/sherlock-audit/2023-05-ironbank/blob/main/ib-v2/src/protocol/oracle/PriceOracle.sol#L43)

Iron Bank had special logic for pricing wstETH directly. The bug appeared when the asset being priced was a PToken whose underlying asset was wstETH. The direct `asset == wsteth` check no longer triggered because the asset address was the PToken address. The oracle then risked using a Chainlink aggregator as if the PToken itself had a direct wstETH price, potentially returning the stETH price instead of wstETH price.

This is the two-hop asset problem:

```text
asset = PToken(wstETH)
price(asset) must price underlying first
underlying = wstETH
wstETH must be converted through stETH-per-wstETH and stETH market price
```

Many integrations correctly handle base assets and fail on wrapped, vault, or receipt-token versions of the same asset. The fix is architectural: pricing should be recursive and typed, not a flat address equality tree.

### 3.11 Tapioca H-08: Curve `get_dy` was used as an oracle for stETH balance

**Classification:** True positive, Code4rena High.

**Public record:** [Tapioca finding #1432](https://github.com/code-423n4/2023-07-tapioca-findings/issues/1432).

**Commit-pinned code pointer:**

- [`LidoEthStrategy.sol`, `_currentBalance`](https://github.com/Tapioca-DAO/tapioca-yieldbox-strategies-audit/blob/05ba7108a83c66dada98bc5bc75cf18004f2a49b/contracts/lido/LidoEthStrategy.sol#L118-L125)

Tapioca's Lido strategy used Curve `get_dy` to estimate the value of the strategy's stETH balance. That is dangerous because DEX spot quotes are not robust collateral or accounting oracles. If the estimated current balance feeds lending, borrowing, or liquidation paths, an attacker can manipulate the pool price and make the strategy appear overvalued or undervalued.

This case belongs to the broader class of LST oracle vulnerabilities. stETH has deep liquidity, but deep liquidity is not the same as oracle safety. A flashloan can still move a pool enough when the attacker only needs the manipulated value for one transaction or one protocol action.

The high-severity argument is strong when the quote feeds:

```text
strategy valuation -> collateral value -> borrow capacity
```

or:

```text
strategy valuation -> liquidation threshold -> forced liquidation
```

In those paths, a bad quote is not an inaccurate UI number. It is a machine for minting bad debt or stealing liquidation surplus.

### 3.12 Tapioca M-10 and emergency slippage cases: hardcoded slippage can be a value leak

**Classification:** True positive, Code4rena Medium-class issues.

**Public records:**

- [Tapioca finding #1430, hardcoded 2.5% slippage](https://github.com/code-423n4/2023-07-tapioca-findings/issues/1430)
- [Tapioca finding #965, emergency withdrawal slippage issue](https://github.com/code-423n4/2023-07-tapioca-findings/issues/965)

**Commit-pinned code pointers:**

- [`LidoEthStrategy.sol`, withdraw path](https://github.com/Tapioca-DAO/tapioca-yieldbox-strategies-audit/blob/05ba7108a83c66dada98bc5bc75cf18004f2a49b/contracts/lido/LidoEthStrategy.sol#L128-L137)
- [`LidoEthStrategy.sol`, emergency withdraw path](https://github.com/Tapioca-DAO/tapioca-yieldbox-strategies-audit/blob/05ba7108a83c66dada98bc5bc75cf18004f2a49b/contracts/lido/LidoEthStrategy.sol#L149-L157)

Tapioca also surfaced a different Lido integration problem: fixed slippage. A strategy that converts stETH back to ETH through a pool with a hardcoded tolerance hands a predictable bound to MEV searchers. If the strategy manages meaningful TVL, the slippage number becomes a budget for extraction.

This is not unique to Lido. The Lido-specific component is that stETH exits can happen through either secondary markets or the WithdrawalQueue, and the strategy must choose how to model market risk, time risk, and user protection. A hardcoded global slippage value is usually the weakest possible model.

A better integration asks the caller or strategist to choose an explicit path:

```text
secondary market exit with user minOut and deadline
or
WithdrawalQueue exit with request IDs, queue timing, and claim accounting
```

Blending the two as "withdraw stETH to ETH somehow" is how slippage becomes invisible until value leaks.

### 3.13 Notional: stale Balancer TWAPs distorted stETH/ETH vault valuations

**Classification:** True positive, Sherlock Medium, sponsor confirmed.

**Public record:** [Notional issue #67](https://github.com/sherlock-audit/2022-09-notional-judging/issues/67).

**Code pointers:**

- [`TwoTokenPoolUtils.sol`, oracle pair price](https://github.com/sherlock-audit/2022-09-notional/blob/main/leveraged-vaults/contracts/vaults/balancer/internal/pool/TwoTokenPoolUtils.sol#L66)
- [`BalancerUtils.sol`, Balancer TWAP call](https://github.com/sherlock-audit/2022-09-notional/blob/main/leveraged-vaults/contracts/vaults/balancer/internal/pool/BalancerUtils.sol#L21)

Notional's issue was not that Balancer TWAPs are always bad. It was that the stETH/ETH Balancer pool had low trading activity, so the TWAP could update infrequently and fail to track true market value. The affected price fed vault settlement, deleveraging, liquidation, and borrowing calculations.

This is one of the best examples of a medium-severity oracle issue. It is not necessarily single-transaction theft. It is a persistent valuation drift that can liquidate users too early, allow over-borrowing, or settle vault positions against stale prices.

The lesson is that oracle design must include market microstructure. A TWAP over a pool that rarely trades is not magically fresher because the averaging window is long. It may be stale precisely because nothing updates it.

### 3.14 Olympus: oracle slop and misplaced slippage protection around wstETH

**Classification:** True positive, Sherlock Medium/High-class findings.

**Public records:**

- [Olympus issue #2, stETH/ETH Chainlink heartbeat and deviation threshold](https://github.com/sherlock-audit/2023-03-olympus-judging/issues/2)
- [Olympus issue #3, ineffective `minTokenAmounts_`](https://github.com/sherlock-audit/2023-03-olympus-judging/issues/3)

Olympus's Lido-related findings are useful because they are not raw oracle manipulation. They are about oracle slop and user protection boundaries. The stETH/ETH Chainlink feed had a heartbeat and deviation threshold that could let the on-chain price differ from the market. That price was used to compute how much wstETH should be returned to the user and how much could be skimmed to the treasury.

A separate issue argued that the user's `minTokenAmounts_` protected only the Balancer pool exit, not the final amount of wstETH the user received after the skim logic. This is a subtle but powerful point: slippage protection must be placed at the final user-visible output, not at an intermediate operation.

The bug shape is:

```text
pool exit minOut passes
protocol applies oracle-based skim
user receives less than intended
no final minOut protects the actual transfer
```

This is a recurring DeFi integration mistake. Any time a protocol performs post-swap accounting, fee capture, or oracle-based redistribution, user slippage must wrap the final settlement, not only the AMM call.

### 3.15 Sturdy Finance: stETH LP oracle plus read-only reentrancy became a production exploit

**Classification:** Production exploit.

**Public records:**

- [SolidityScan Sturdy Finance hack analysis](https://blog.solidityscan.com/sturdy-finance-hack-analysis-bd8605cd2956/)
- [ImmuneBytes detailed analysis](https://medium.com/@immunebytes/sturdy-finance-hack-june-12-2023-detailed-analysis-immunebytes-ff7f6f0bca96)
- [Distributed Networks Institute incident page](https://dn.institute/research/cyberattacks/incidents/2023-06-12-sturdy-finance/)

Sturdy Finance is the production version of the warning behind many audit findings. The exploit used Balancer read-only reentrancy and manipulation of the B-stETH-STABLE price. Public analyses describe a roughly $800K loss, with the attacker using flashloans, depositing manipulated LP collateral, borrowing, disabling collateral, withdrawing other collateral, and later liquidating their own position after prices normalized.

This is not a "Lido token bug". It is an integration composition bug:

```text
LST LP token accepted as collateral
plus manipulable/stale oracle read
plus lending-market collateral accounting
plus flashloan scale
equals extractable value
```

The reason it belongs in a Lido integration study is that stETH/wstETH LPs are often treated as blue-chip, safe, deep, or stable. That reputation can make protocols comfortable accepting derived positions as collateral. The exploit shows that the risk is not only the asset. It is the full read path used to value the asset under adversarial state.

### 3.16 Kelp DAO H-01: Chainlink deviation windows across multiple LSTs created basket arbitrage

**Classification:** True positive, Code4rena High, sponsor disputed but selected for report.

**Public record:** [Kelp finding #584](https://github.com/code-423n4/2023-11-kelp-findings/issues/584).

**Code pointer:**

- [`LRTDepositPool.sol`, deposit valuation path](https://github.com/code-423n4/2023-11-kelp/blob/main/src/LRTDepositPool.sol#L109)

Kelp DAO's finding is a more general LST basket issue. The protocol calculated rsETH/ETH value from multiple LST price feeds, including rETH, cbETH, and stETH. Those feeds had different deviation thresholds and heartbeats. A user could exploit acceptable but inconsistent feed deviations by depositing the asset that was temporarily favorable relative to the basket's aggregate valuation.

This is not a simple stale-feed complaint. The issue is cross-feed coherence:

```text
Each feed is individually within its allowed deviation.
The basket valuation is collectively exploitable.
```

In multi-collateral LST protocols, oracle safety cannot be assessed feed by feed. The relevant invariant is whether users can mint and redeem against a basket while selecting the collateral whose oracle is most favorable at that moment.

### 3.17 Leveraged Vaults / Kelp holder: third-party dust requests displaced the real Lido request ID

**Classification:** True positive, Sherlock High, sponsor confirmed in the public issue metadata.

**Public record:** [Leveraged Vaults issue #105](https://github.com/sherlock-audit/2024-06-leveraged-vaults-judging/issues/105).

**Code pointers from issue:**

- [`Kelp.sol`, trigger extra step](https://github.com/sherlock-audit/2024-06-leveraged-vaults/blob/main/leveraged-vaults-private/contracts/vaults/staking/protocols/Kelp.sol#L83)
- [`Kelp.sol`, finalize cooldown](https://github.com/sherlock-audit/2024-06-leveraged-vaults/blob/main/leveraged-vaults-private/contracts/vaults/staking/protocols/Kelp.sol#L100)

This is the most memorable WithdrawalQueue integration bug in the public set. The holder withdrew from Kelp to stETH and then from stETH to ETH through Lido's WithdrawalQueue. During finalization, the code claimed the zero-th Lido withdrawal request returned for the holder address.

A third party could create a dust Lido withdrawal request owned by the holder before the real protocol request. The real request would no longer be at index zero. The protocol would finalize the dust request, delete its own account-withdraw state, and lose the ability to claim the real request through the intended path. Rescue logic could not recover the stETH because it was already inside Lido's queue.

The broken assumption is extremely specific:

```text
getWithdrawalRequests(owner)[0] == my request
```

The correct design is equally specific:

```text
requestIds = requestWithdrawals(...)
store requestIds under the protocol's own withdrawal object
claim exactly those requestIds later
```

Any Lido WithdrawalQueue integration that does not persist request IDs deserves immediate scrutiny.

### 3.18 BendDAO M-06 and Saffron #104: WithdrawalQueue limits and protocol-invented minimums can lock funds

**Classification:** True positives with liveness and fund-locking impact.

**Public records:**

- [BendDAO report, M-06](https://code4rena.com/reports/2024-07-benddao#m-06-unstake-of-lido-will-fail-and-steth-will-be-locked-in-yieldethstakinglido-if-amount-is-greater-than-1000-ether)
- [Saffron issue #104](https://github.com/sherlock-audit/2024-08-saffron-finance-judging/issues/104)

**Commit-pinned code pointer:**

- [`YieldEthStakingLido.sol`, BendDAO Lido withdrawal path](https://github.com/code-423n4/2024-07-benddao/blob/117ef61967d4b318fc65170061c9577e674fffa1/src/yield/lido/YieldEthStakingLido.sol#L120-L122)

Lido WithdrawalQueue requests have maximum sizes. Lido documentation states the maximum request size is 1000 stETH. BendDAO submitted a single withdrawal request, so withdrawals above the limit would revert and leave funds stuck in the staking contract.

Saffron shows the opposite edge. The protocol had its own `MIN_STETH_WITHDRAWAL_AMOUNT` of 100 stETH. If the contract's balance fell below that internal threshold and no fallback path existed, tail users could be unable to initiate withdrawals. This is not Lido's minimum, which is much smaller. It is a protocol-level constraint that accidentally turned small residual balances into a lock.

WithdrawalQueue integration must handle both sides:

```text
large exits must be split into multiple requests
small exits must be batched, delayed, or allowed through a fallback path
```

A queue adapter that only works for the happy-path amount range is not a withdrawal adapter. It is a partial router with hidden insolvency-like behavior at the edges.

### 3.19 Sense Finance: stale stETH price feed made the adapter's scale value attacker-timed

**Classification:** Production disclosure and post-mortem.

**Public record:** [Sense Finance post-mortem](https://medium.com/sensefinance/post-mortem-stale-steth-price-feed-in-a7-c70d648bef89).

Sense Finance's wstETH adapter used a stale stETH price feed. The protocol's post-mortem explained that the feed had not been updated for a long period, and that a permissionless sync could update it at a time chosen by anyone. If stETH traded below 1 ETH, an attacker-timed update could cause the adapter scale value to jump down, affecting PT and YT holders.

This is a great example of the "stale until adversarially fresh" oracle problem. A stale oracle may look safe if nobody updates it. But if update permission is public, the relevant threat model is not "will the oracle eventually update?" It is:

```text
Can someone update it exactly when the update hurts other users?
```

The fix was not to wish the feed were fresher. Sense changed the adapter design so users were explicitly exposed to stETH price risk rather than silently relying on a stale WETH-denominated scale assumption.

### 3.20 Aave 2026 CAPO incident: a guardrail became part of the wstETH price

**Classification:** Production incident, no protocol bad debt, real user liquidations.

**Public record:** [Aave governance post-mortem, March 10, 2026](https://governance.aave.com/t/post-mortem-exchange-rate-misallignment-on-wsteth-core-and-prime-instances/24269).

This is not a classic audit finding, but it is too important to ignore. In March 2026, a CAPO risk oracle configuration incident caused the effective wstETH/stETH exchange rate used by Aave Core and Prime to fall roughly 2.85% below the live market exchange rate. The post-mortem reports roughly 10,938 wstETH in E-Mode liquidation volume across 34 accounts, no bad debt, and liquidation value captured by third-party liquidators before recovery and compensation efforts.

The root cause was a mismatch between `snapshotRatio` and `snapshotTimestamp` under on-chain update constraints. The intended off-chain target could not be fully applied on-chain because the ratio update was rate-limited, while the timestamp advanced as if the full target ratio had been applied. The cap then computed a maximum exchange rate below the real rate.

This incident matters because it shows the next generation of Lido integration risk. Mature protocols no longer simply price wstETH by a naive feed. They add caps, risk agents, growth bounds, and delegated update flows to protect against exchange-rate manipulation. Those guardrails are good. But once a guardrail can override the effective price, it becomes part of the oracle.

The invariant is:

```text
snapshot ratio and snapshot timestamp must describe the same economic reference point.
```

If they drift apart, the safety cap can create the exact type of artificial price movement it was designed to defend against.

## 4. False positives, downgraded issues, and the anatomy of noisy Lido findings

The public record is full of Lido-related submissions that sound scary but do not clear the impact bar. That does not mean they are useless. Many are good observations with weak exploitability. The goal is to separate incomplete arguments from real bugs.

### 4.1 Noise pattern: "stETH rebases" without a broken invariant

A finding is weak if its entire argument is:

```text
The protocol uses stETH.
stETH rebases.
Therefore accounting is wrong.
```

That is not enough. The finding must show a broken invariant such as:

```text
sum(user claims) > protocol assets
first claimer receives more than pro-rata share
later claimer reverts
borrower can mint debt against inflated collateral
liquidator can seize collateral from a healthy position
```

Kelp's deposit-limit issue is a useful example of a downgraded case. The finding argued that stETH rebasing could make a deposit limit inaccurate and temporarily block deposits near the limit. It was labeled as downgraded, sponsor disputed, and unsatisfactory in the public issue metadata. See [Kelp finding #537](https://github.com/code-423n4/2023-11-kelp-findings/issues/537).

The observation is directionally correct: rebasing balances can affect a balance-based deposit limit. But the impact is mainly liveness and configuration drift. No direct asset theft, bad debt, or unfair withdrawal distribution was demonstrated. That is why it belongs closer to QA than High.

Contrast that with Renzo H-05 or Lybra. Those cases also involve rebase. But they prove that claims and assets diverge in a way that lets one party escape losses or leaves another unable to claim.

The audit lesson is simple: name the invariant, then break it.

### 4.2 Noise pattern: direct Lido submit is suboptimal, but the protocol never promised best execution

Directly submitting ETH to Lido can be worse than buying stETH from the market when stETH trades at a discount. Tapioca's direct-submit finding was treated as a valid medium issue because the strategy hardcoded the route and could systematically leak value. See [Tapioca finding #1437](https://github.com/code-423n4/2023-07-tapioca-findings/issues/1437) and the commit-pinned [`LidoEthStrategy.sol` deposit path](https://github.com/Tapioca-DAO/tapioca-yieldbox-strategies-audit/blob/05ba7108a83c66dada98bc5bc75cf18004f2a49b/contracts/lido/LidoEthStrategy.sol#L108).

Sophon had a similar submission about hardcoding `stETH.submit`, but the public Sherlock issue was labeled excluded, non-reward, sponsor disputed, and won't fix. See [Sophon issue #33](https://github.com/sherlock-audit/2024-05-sophon-judging/issues/33).

This is a good false-positive boundary. The same economic observation can be valid in one protocol and non-reward in another depending on the product promise.

The question is not:

```text
Could the user have bought stETH cheaper somewhere else?
```

The question is:

```text
Did the protocol promise best execution, internalize the loss, remove user minOut,
or socialize the difference across other users?
```

If the user knowingly selects a direct mint route and the transaction is atomic, this may be a UX or efficiency issue. If the protocol silently routes all deposits through a worse path while pricing shares as if no loss occurred, it becomes a value leak.

### 4.3 Noise pattern: conditional support for rebasing tokens is not the same as active support

Cork had a public Sherlock issue arguing that rebasing tokens were not supported despite README language claiming support through an exchange-rate mechanism. The issue stated that wstETH-like non-rebasing wrappers were supported, but stETH itself would accrue untracked yield if used as a redemption or pegged asset. See [Cork issue #235](https://github.com/sherlock-audit/2024-08-cork-protocol-judging/issues/235).

This is not pure noise. It is a legitimate spec-versus-implementation mismatch. But its severity depends on whether an administrator can actually list stETH in production under the stated trust model, whether that configuration is in scope, and whether stuck yield is user loss or protocol surplus.

A strong version of this finding would prove:

```text
stETH is within the allowed listed assets
users can deposit it under normal operations
rebases cause user claims or protocol reserves to diverge
someone can extract or permanently lose value
```

A weaker version says:

```text
If governance lists stETH someday, accounting may be wrong.
```

That may still be useful, but it is often QA, documentation, or governance-risk territory unless the listing is part of the deployed design.

### 4.4 Noise pattern: Curve or Balancer risk is conditional on pool type and call context

The xETH Code4rena report contains an informational note about Curve pool type. The report explains that stETH, as a rebasing token, needs an appropriate Curve pool type and that some read-only reentrancy concerns depend on whether the pool includes native ETH. Under the protocol team's asserted pool configuration, the issue was informational. See the [xETH report, INFO-01](https://code4rena.com/reports/2023-05-xeth#info-01-type-of-curve-pool-is-an-important-and-sensible-parameter).

This is a healthy pattern for auditors: state the condition clearly and avoid overstating impact.

A serious Curve/Balancer/LST oracle finding usually needs:

```text
the exact pool type
whether native ETH is involved
whether the read can happen during inconsistent state
whether the value feeds mint, borrow, redeem, or liquidation
whether the attacker can move price or state in the same transaction
```

Without that, "Balancer read-only reentrancy" or "Curve virtual price" is just a checklist phrase. Sturdy shows the exploit class is real. xETH shows the same phrase can be informational when the preconditions are absent.

### 4.5 Noise pattern: Lido pause or rate limit is only severe if the integration mishandles failure

Lido has staking limits and pause-like external dependency behavior. A protocol that calls Lido must expect calls to revert or produce no useful output under some conditions. But the mere fact that Lido can pause does not make every integration vulnerable.

The Badger eBTC Zap Router case is the correct way to argue this class. The Code4rena report discusses a low-level interaction with stETH where a failure flag was not adequately handled, and the debate focused on whether specific paths could lose native funds. The severity was reduced to Medium because the trigger was conditional, but the impact could be direct loss in some flows. See the [eBTC Zap Router report](https://code4rena.com/reports/2024-06-badger) and the commit-pinned [`ZapRouterBase.sol` Lido deposit path](https://github.com/code-423n4/2024-06-badger/blob/9173558ee1ac8a78a7ae0a39b97b50ff0dd9e0f8/ebtc-zap-router/src/ZapRouterBase.sol#L34-L41).

The distinction is:

```text
External call reverts and the whole transaction reverts: usually liveness.
External call fails silently after ETH or state moved: potential fund loss.
External call succeeds with less output than assumed: accounting bug.
```

A Lido dependency finding should identify which of those three shapes is present.

### 4.6 Noise pattern: 1-2 wei rounding without downstream exactness

The stETH rounding issue is real. Lido documents it. Sophon and Morpheus show how it becomes real impact. But it is not automatically Medium or High.

A low-value rounding observation becomes high value only when the protocol requires exact equality later:

```text
received amount is slightly less than requested
protocol records requested amount
later transfer, wrap, or withdraw uses requested amount
operation reverts or accounting overstates assets
```

If the only impact is that a user may leave 1 wei behind, and no critical state uses the wrong number, the finding is usually low, QA, or informational.

The best submissions in this class include a failing path. The weakest submissions only link the Lido docs.

### 4.7 Noise pattern: rare negative rebase is not impossible, but probability still affects severity

It is wrong to dismiss negative rebase findings by saying "Lido will never slash". Lido documentation explicitly discusses negative rebases and slashing scenarios. But probability matters for severity.

A negative-rebase issue is strong when the protocol amplifies it into unfair distribution, first-claimer advantage, insolvency, stuck withdrawals, or broken accounting after the event. Renzo H-05 and Lybra did that.

A negative-rebase issue is weaker when it says only:

```text
If a massive slash happens, everyone loses money.
```

That is not a vulnerability. That is the risk of holding the asset. A protocol is not required to eliminate Lido economic risk unless it promised to do so. It is required not to misallocate that risk contrary to its own accounting.

### 4.8 Noise pattern: a market-rate feed is not wrong by default

Renzo M-14 is a nuanced case because it sits near this boundary. Market price can be the correct price if the protocol is designed around liquidation value or tradable value. Exchange rate can be the correct price if the protocol is designed around redemption value. The bug is not the choice of one feed. The bug is mixing feed semantics within one mint/redeem system.

A finding that says:

```text
stETH/ETH is below 1, therefore the oracle is wrong
```

is incomplete.

A stronger finding says:

```text
The protocol prices stETH by market rate on deposit,
prices another LST by exchange rate on redemption,
and lets users mint/redeem against a common share supply.
The cross-domain mismatch creates extractable arbitrage or unfair dilution.
```

The second version is a security finding. The first version is a complaint about market reality.

## 5. The deeper taxonomy

Across all the cases, the bugs fit into five families.

### Family A: share-liability mismatch

Representative cases:

- Lybra negative rebase collateral accounting.
- Renzo pending withdrawal `amountToRedeem`.
- BendDAO strategy shares treated as assets.
- Saffron fixed/variable payoff formulas.
- Morpheus balance delta lost across contract boundary.

The invariant to test:

```text
For every time T, sum(user claims in the promised unit) <= protocol assets in the same unit.
```

The dangerous code smells:

```solidity
mapping(address => uint256) depositedStETH;
uint256 totalDeposited;
uint256 amountToRedeem;
uint256 lastUnderlyingBalance;
```

These variables are not bad by themselves. They are bad when the underlying asset is stETH and the variable spans time without storing shares.

### Family B: price-domain mismatch

Representative cases:

- Alchemix wstETH/stETH rate used as WETH value.
- Asymmetry wstETH derivative assumes stETH equals ETH.
- Renzo market-rate and exchange-rate feed mismatch.
- Iron Bank PToken for wstETH bypasses wstETH price path.
- Aave CAPO incident where a cap became an artificial effective price.

The invariant to test:

```text
Every price has a base asset, quote asset, freshness model, manipulation model, and settlement meaning.
```

The dangerous code smells:

```solidity
return wstETH.getStETHByWstETH(1e18); // used as ETH price
if (asset == wstETH) { ... }          // no recursive handling for wrappers
minOut = stETHAmount;                 // user expects ETH value
```

### Family C: oracle-state manipulation or staleness

Representative cases:

- Tapioca Curve `get_dy` strategy valuation.
- Notional low-activity Balancer TWAP for stETH/ETH.
- Olympus heartbeat and misplaced minOut protection.
- Sturdy Balancer read-only reentrancy exploit.
- Sense stale feed with permissionless update timing.
- Kelp cross-LST Chainlink deviation arbitrage.

The invariant to test:

```text
Can an attacker choose the oracle value, update timing, or stale/fresh transition
at the moment the protocol mints, borrows, redeems, liquidates, or distributes value?
```

The dangerous code smells:

```solidity
pool.get_dy(...);                // used as collateral price
pool.getRate();                  // read during external pool state transition
latestAnswer();                  // no stale check
minOut checked before protocol skim
```

### Family D: WithdrawalQueue state-machine bugs

Representative cases:

- Leveraged Vaults/Kelp dust request ID injection.
- BendDAO single request above 1000 stETH.
- Saffron internal 100 stETH minimum causing tail lock risk.

The invariant to test:

```text
Every withdrawal request created by the protocol can be uniquely claimed later,
regardless of third-party requests, request ordering, size limits, NFT transfer behavior,
and partial or discounted finalization.
```

The dangerous code smells:

```solidity
getWithdrawalRequests(owner)[0]
requestWithdrawals(singleAmount)
require(amount >= internalMin)
// no stored requestIds
// no split logic
// no small-tail fallback
```

### Family E: precision and output-accounting bugs

Representative cases:

- Sophon exact `_amount` after stETH transfer.
- Morpheus downstream accounting of requested rather than received amount.
- Badger Zap low-level Lido call handling.

The invariant to test:

```text
Every external token interaction records what was actually received or paid,
not what the caller hoped would be received or paid.
```

The dangerous code smells:

```solidity
token.transferFrom(user, address(this), amount);
record(amount);
wrap(amount);
```

Safer code:

```solidity
uint256 beforeBal = token.balanceOf(address(this));
token.transferFrom(user, address(this), amount);
uint256 received = token.balanceOf(address(this)) - beforeBal;
record(received);
wrap(received);
```

## 6. How to audit a Lido integration without chasing ghosts

### 6.1 Start with units, not functions

Before reading every branch, write down all value domains:

```text
ETH
stETH nominal amount
stETH shares
wstETH amount
wstETH/stETH exchange rate
stETH/ETH market price
USD price
vault shares
strategy shares
unstETH request IDs
claimable ETH
```

Then mark every state variable with a domain. Most real bugs become obvious when a variable's domain changes without a conversion.

Example:

```text
amountToRedeem: stETH nominal amount at request time
claim transfer: stETH nominal amount at claim time
asset actually held: fixed stETH shares
```

That is Renzo H-05 in one line.

### 6.2 For stETH, test positive and negative rebases even if the protocol says "unlikely"

The test does not need to predict slashing. It needs to verify invariants under the token's documented behavior.

At minimum:

```text
deposit -> positive rebase -> withdraw
 deposit -> negative rebase -> withdraw
request -> positive rebase -> claim
request -> negative rebase -> claim
multiple users -> rebase -> first user claims -> second user claims
```

The important assertions are:

```text
no user gets more than intended pro-rata value
no later user becomes unable to claim because earlier users overclaimed
sum of claims never exceeds available assets in the promised unit
protocol surplus or deficit is intentional and documented
```

### 6.3 For wstETH, test price-domain separation

Every wstETH valuation should be reviewed as a pipeline:

```text
wstETH amount
-> stETH amount via wrapper rate
-> ETH or USD via market oracle
-> haircut or cap if used for collateral
-> final value used in borrow/liquidation/mint/redeem
```

A missing stage is a bug candidate. A duplicated stage is also a bug candidate. A cap or guardrail that can override the value is part of the oracle and must be tested as such.

### 6.4 For WithdrawalQueue, treat request IDs as escrowed assets

Audit questions:

```text
Does the protocol store the request IDs returned by Lido?
Can anyone create a request for the same owner address?
Can request order be changed by third-party dust?
Can the unstETH NFT be transferred away?
What happens if claimable ETH is lower than requested stETH?
What happens above 1000 stETH?
What happens below the protocol's own minimum?
Can a rescue function recover the real asset, or is it already in Lido's queue?
```

If the code ever calls `getWithdrawalRequests(owner)` and chooses by index, assume it is suspicious until proven otherwise.

### 6.5 For oracles, ask who chooses time

Most LST oracle bugs are time-selection bugs:

```text
Who can update the feed?
Who can trigger a sync?
Who can manipulate the pool inside the same transaction?
Who can choose to borrow after the price rises but before it normalizes?
Who can choose to liquidate after a cap pushes price down?
```

The adversary rarely needs to control the oracle forever. They often need to control one read, one update, or one stale-to-fresh transition.

### 6.6 For false-positive triage, demand the extraction path

A high-quality finding should be able to complete this sentence:

```text
Because the protocol stores X in unit A but later settles Y in unit B,
an attacker or unlucky user can cause Z loss or lock by doing these steps.
```

If the report cannot fill in `Z`, it is probably not high severity. If it cannot fill in the steps, it may still be a design warning, but not a proven vulnerability.

## 7. Public case index

| Case | Public classification | Root cause | Real impact or triage outcome | Primary source |
|---|---:|---|---|---|
| Lybra negative rebase collateral | Medium, sponsor acknowledged | Stored fixed stETH collateral amount instead of share exposure | Users can avoid negative rebase loss and shift it to vault or other users | [Issue #931](https://github.com/code-423n4/2023-06-lybra-findings/issues/931) |
| Renzo H-05 | High | Withdrawal queue cached nominal stETH `amountToRedeem` across rebases | Insolvency, unfair claim order, failed claims | [Report](https://code4rena.com/reports/2024-04-renzo#h-05-withdrawals-of-rebasing-tokens-can-lead-to-insolvency-and-unfair-distribution-of-protocol-reserves) |
| BendDAO H-01 | High | Strategy shares treated as assets | Early NFT overclaims yield, later NFTs lose value or face liquidation pressure | [Report](https://code4rena.com/reports/2024-07-benddao#h-01-sharesassets-mismatch-causes-protocol-to-lose-funds) |
| Saffron LidoVault slashing/accounting | Medium-class public issues, disputed in places | Fixed/variable payoff math mixes ETH, stETH, and shares | Loss shifted between fixed and variable sides, stuck or misallocated fee/yield | [Issue #92](https://github.com/sherlock-audit/2024-08-saffron-finance-judging/issues/92), [Issue #129](https://github.com/sherlock-audit/2024-08-saffron-finance-judging/issues/129) |
| Morpheus M-02 | Medium | Balance-delta accounting lost across contract boundary | Reward distribution DoS and reward loss | [Report](https://code4rena.com/reports/2025-08-morpheus#m-02-inconsistent-balance-accounting-in-steth-deposits-leads-to-dos-of-core-functions-and-reward-loss) |
| Sophon #63 | High, sponsor confirmed | stETH transfer may receive 1-2 wei less, downstream wrap used original amount | Deposit path DoS | [Issue #63](https://github.com/sherlock-audit/2024-05-sophon-judging/issues/63) |
| Alchemix WstETH adapter | Medium | wstETH/stETH exchange rate used as WETH value | Harvestable/accounting amounts misstated | [Issue #97](https://github.com/code-423n4/2022-05-alchemix-findings/issues/97) |
| Asymmetry H-06 | High | Assumed stETH equals ETH in wstETH derivative and withdrawal path | Mispricing, DoS or value loss on depeg | [Report](https://code4rena.com/reports/2023-03-asymmetry#h-06-wsteth-derivative-assumes-1-steth--1-eth) |
| Renzo M-14 | Medium, nuanced | Mixed market-rate and exchange-rate semantics | Basket arbitrage or unfair mint/redeem valuation | [Report](https://code4rena.com/reports/2024-04-renzo#m-14-the-use-of-market-rate-of-steth-to-eth-in-depositwithdrawals-could-lead-to-loss-of-funds) |
| Iron Bank PToken wstETH | Medium, will fix | PToken wrapper bypassed direct wstETH pricing branch | Over-borrow or unfair liquidation risk | [Issue #220](https://github.com/sherlock-audit/2023-05-ironbank-judging/issues/220) |
| Tapioca H-08 | High | Curve `get_dy` used as oracle | Over-borrowing or malicious liquidation via manipulated stETH valuation | [Issue #1432](https://github.com/code-423n4/2023-07-tapioca-findings/issues/1432) |
| Tapioca slippage cases | Medium | Hardcoded or unsafe slippage on stETH exits | MEV/value leakage during strategy exits | [Issue #1430](https://github.com/code-423n4/2023-07-tapioca-findings/issues/1430), [Issue #965](https://github.com/code-423n4/2023-07-tapioca-findings/issues/965) |
| Notional stETH/ETH Balancer oracle | Medium, sponsor confirmed | Low-activity TWAP not refreshed enough | Settlement, borrowing, and liquidation valuation drift | [Issue #67](https://github.com/sherlock-audit/2022-09-notional-judging/issues/67) |
| Olympus oracle and minOut | Medium/High-class findings | Oracle slop and slippage protection not applied to final user output | Users could lose wstETH through skim logic or stale price | [Issue #2](https://github.com/sherlock-audit/2023-03-olympus-judging/issues/2), [Issue #3](https://github.com/sherlock-audit/2023-03-olympus-judging/issues/3) |
| Sturdy Finance exploit | Production exploit | Balancer read-only reentrancy plus B-stETH-STABLE oracle manipulation | Roughly $800K loss | [SolidityScan](https://blog.solidityscan.com/sturdy-finance-hack-analysis-bd8605cd2956/), [ImmuneBytes](https://medium.com/@immunebytes/sturdy-finance-hack-june-12-2023-detailed-analysis-immunebytes-ff7f6f0bca96) |
| Kelp DAO cross-LST oracle | High, sponsor disputed but selected | Different Chainlink deviation windows across LST basket | rsETH mint/redeem arbitrage | [Issue #584](https://github.com/code-423n4/2023-11-kelp-findings/issues/584) |
| Leveraged Vaults Kelp holder | High, sponsor confirmed | Relied on zero-th Lido request ID, third-party dust request injection | Real withdrawal request locked | [Issue #105](https://github.com/sherlock-audit/2024-06-leveraged-vaults-judging/issues/105) |
| BendDAO M-06 | Medium | Lido request size not split above 1000 stETH | Large unstake fails, funds stuck | [Report](https://code4rena.com/reports/2024-07-benddao#m-06-unstake-of-lido-will-fail-and-steth-will-be-locked-in-yieldethstakinglido-if-amount-is-greater-than-1000-ether) |
| Saffron #104 | Submitted High, liveness/fund-lock concern | Protocol-internal 100 stETH minimum without fallback | Tail balances can become unwithdrawable | [Issue #104](https://github.com/sherlock-audit/2024-08-saffron-finance-judging/issues/104) |
| Sense stale stETH feed | Post-mortem | Permissionless stale-to-fresh price update timing | PT/YT scale-value disruption and undisclosed stETH price exposure | [Post-mortem](https://medium.com/sensefinance/post-mortem-stale-steth-price-feed-in-a7-c70d648bef89) |
| Aave CAPO 2026 | Production incident | Snapshot ratio and timestamp misaligned under on-chain constraints | wstETH oracle depressed, roughly 10,938 wstETH liquidation volume, no bad debt | [Post-mortem](https://governance.aave.com/t/post-mortem-exchange-rate-misallignment-on-wsteth-core-and-prime-instances/24269) |
| Kelp #537 | Downgraded, disputed, unsatisfactory | Deposit limit affected by rebasing balance | Mostly liveness/config drift, no demonstrated asset theft | [Issue #537](https://github.com/code-423n4/2023-11-kelp-findings/issues/537) |
| Sophon #33 | Excluded, non-reward, disputed | Direct Lido submit may be worse than market purchase | Economic efficiency issue unless protocol promised best execution or socialized the loss | [Issue #33](https://github.com/sherlock-audit/2024-05-sophon-judging/issues/33) |
| Cork #235 | Medium label, sponsor disputed | README claimed rebasing-token support, code fit non-rebasing wrappers | Config/spec mismatch; severity depends on whether stETH listing is real in scope | [Issue #235](https://github.com/sherlock-audit/2024-08-cork-protocol-judging/issues/235) |
| xETH INFO-01 | Informational | Curve pool type and read-only reentrancy risk depend on deployment assumptions | Good warning, not active vulnerability under asserted pool config | [Report](https://code4rena.com/reports/2023-05-xeth#info-01-type-of-curve-pool-is-an-important-and-sensible-parameter) |
| Badger free-loan style rebase timing | QA, downgraded | Borrow around rebase to reduce protocol fee capture | Mostly fee leakage and capital-intensive timing, not direct asset risk | [Issue #325](https://github.com/code-423n4/2023-10-badger-findings/issues/325) |

## 8. Practical review checklist

### stETH accounting

- Does any state variable store a stETH amount across blocks?
- Is the value a user claim, protocol inventory, reward baseline, debt amount, or fee amount?
- Should it be stored as shares instead?
- Does `sum(user claims)` remain solvent after positive and negative rebases?
- Can first claimers benefit at the expense of later claimers?
- Are balance deltas used after `transferFrom`?
- Are downstream contracts given the actual received amount, not the requested amount?

### wstETH pricing

- Is `getStETHByWstETH` used only as a wrapper exchange rate?
- Is stETH market price applied when the final accounting unit is ETH or USD?
- Are market-rate and exchange-rate feeds mixed in a basket?
- Are wrapper, vault, PToken, BPT, and strategy-share assets priced recursively?
- Does a cap, risk oracle, or growth bound override the final price?
- Can the cap move down and trigger liquidations?
- Are timestamps and ratios updated consistently?

### Oracle safety

- Is any Curve, Balancer, or AMM quote used for collateral value?
- Is the quote same-transaction manipulable?
- Is a TWAP meaningful given actual pool trading frequency?
- Are feed heartbeat and deviation parameters appropriate for the action they protect?
- Can anyone update a stale feed at a chosen time?
- Is user slippage applied to the final amount received, not only an intermediate pool exit?

### WithdrawalQueue

- Are request IDs stored immediately after request creation?
- Does the code ever rely on `getWithdrawalRequests(owner)[0]`?
- Can a third party create a withdrawal request owned by the holder address?
- Are large withdrawals split below Lido's per-request maximum?
- Are small or tail withdrawals handled without permanent lock?
- Does the protocol account for claimable ETH potentially being lower than requested amount?
- Is the unstETH NFT transferability relevant to ownership assumptions?

### External dependency failure

- What happens if Lido submit reverts?
- What happens if staking limit is zero?
- What happens if WithdrawalQueue is paused?
- Is a low-level call return value checked?
- Does local state update before the external dependency succeeds?
- Can native ETH be stranded if the external call fails?

## 9. Closing thesis

Lido integration risk is not one bug. It is a family of unit mismatches.

The strongest findings are not the ones that repeat Lido's documentation the loudest. They are the ones that locate an accounting promise and show that the promise is denominated in the wrong thing. stETH shares, stETH nominal amounts, wstETH units, ETH market value, queue request IDs, and oracle caps are all valid abstractions. They are not interchangeable.

That is the real lesson from the public case history:

```text
A protocol does not become safe by using wstETH.
It becomes safer when every accounting edge knows what unit it is in.
```

```text
A withdrawal integration does not become safe by calling Lido's queue.
It becomes safe when the request ID is treated as the asset.
```

```text
An oracle does not become safe by adding a cap.
It becomes safe when the cap's state variables are internally consistent and adversarially testable.
```

The exciting part is that these bugs are preventable. They are not mystical LST weirdness. They are dimensional-analysis failures in smart contracts. Once a team starts writing down units, time boundaries, and settlement promises, most of the scary edge cases stop being edge cases. They become ordinary invariants.

And ordinary invariants can be tested.
