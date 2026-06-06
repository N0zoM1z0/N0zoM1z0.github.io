---
title: "The Aave Integration Trap: When Blue-Chip Liquidity Becomes Your Attack Surface"
date: "2026-06-06"
slug: "aave-integration-trap"
categories:
  - DeFi
  - Security Research
tags:
  - aave
  - lending
  - integration
  - security
---

# The Aave Integration Trap: When Blue-Chip Liquidity Becomes Your Attack Surface

*Fork mainnet, doubt the callback, and never trust a rebasing balance.*

## Abstract

Aave is one of DeFi's most composable liquidity protocols. That is exactly why it keeps showing up in security reviews of protocols that are not Aave: vaults, leverage managers, strategy routers, cross-chain bridges, structured products, liquidation bots, meta-lending systems, and yield sources all integrate with Aave because it is deep, battle-tested liquidity.

The interesting security story is not that Aave itself is fragile. The interesting story is that many integrations build a second state machine on top of Aave, then quietly assume that Aave behaves like a normal ERC20 vault, a normal flash-loan primitive, or a static oracle and collateral engine. Those assumptions are where the bugs live.

This article studies public historical cases from Code4rena, Sherlock, Immunefi, Spearbit, ConsenSys Diligence, ChainSecurity, and independent bug bounty writeups. The focus is integration risk: what goes wrong when an external protocol uses Aave v3, and how the same classes of failure should be re-evaluated for Aave v4's Hub and Spoke model. The most useful split is not by protocol name. It is by whether a finding proves a real exploit path.

A true positive usually has four ingredients:

1. An attacker-controlled trigger.
2. Protocol-held funds, allowances, debt authority, or shared accounting at the affected address.
3. A divergence between the integration's internal state and Aave's real state machine.
4. A concrete impact: direct theft, bad debt, permanent or long-lived fund lock, liquidation risk, or lost yield that the protocol actually promised to users.

A weak or false positive usually stops earlier. It notices a real Aave behavior, but fails to connect it to a reachable asset flow, a protocol invariant, or a material loss. That distinction is the entire game.

## Scope and terminology

This is not a review of Aave Core as a standalone target. It is a review of protocols that integrate with Aave.

The word "false positive" is used broadly in this article. It covers issues that were judged invalid, non-reward, excluded, low severity, informational, or simply context-limited. Some of those observations are technically correct. They are not necessarily bad reports. They are useful negative controls: they show where the security argument fails to become a high or medium severity vulnerability.

The public case corpus is necessarily incomplete. Private audits, unpublished bug bounty submissions, and internal reviews are outside the dataset. The aim is to cover the major known public patterns and to extract the decision rules that generalize.

## The integration mental model: Aave is not a passive vault

Before looking at individual cases, it is worth rebuilding the mental model from the integrator's perspective.

### Aave v3: Pool, aTokens, debt tokens, risk modes, and callbacks

The main integration entry point in Aave v3 is the `Pool`. Users and contracts supply assets, withdraw assets, borrow, repay, enable or disable collateral, liquidate positions, and request flash loans through the Pool. A production integration usually discovers the Pool through a `PoolAddressesProvider`, not through a random hard-coded address. The reason is simple: Aave markets are chain-specific and provider-specific. A token address, an aToken address, a RewardsController, and an oracle address only make sense inside the same market configuration.

The aToken design is the first major sharp edge. When a user supplies an asset, Aave mints an aToken. The aToken is ERC20-like and pegged 1:1 to the underlying asset, but the balance represents principal plus accrued interest. The official tokenization documentation describes aTokens as minted on supply, burned on withdraw, pegged 1:1, and interest-accruing through a `balanceOf` that includes yield.

That is easy to use and dangerous to model. A protocol that reads `aToken.balanceOf(address(this))` is reading a rebasing claim on an underlying reserve. It is not reading a static share balance. It is not reading an internal accounting variable. It is not protected from direct transfers unless the integration explicitly accounts for them.

The second major sharp edge is the flash loan callback. Aave flash loans are intentionally permissionless. A caller can ask the Pool to send assets to a receiver and then call the receiver's `executeOperation`. The receiver must repay or approve repayment. In Aave v3, `flashLoan` can also open debt depending on the `modes` argument, while `flashLoanSimple` is a simpler single-asset path. From the receiver's perspective, `msg.sender == Pool` only proves that Aave made the callback. It does not prove that the protocol itself initiated the flash loan. An attacker can initiate a flash loan and set your contract as the receiver.

The third sharp edge is the risk engine. Aave v3 is not just `collateral * LTV >= debt`. The engine includes eMode, Isolation Mode, Siloed Borrowing, borrow caps, supply caps, pause and freeze flags, LTV-zero assets, user configuration bitmaps, oracle overrides, fallback behavior, and health-factor checks. If an integration copies only part of this model, it will eventually disagree with Aave.

The fourth sharp edge is the reward layer. Base supply yield appears in the aToken balance. Incentive rewards, such as OP or ARB liquidity mining rewards, are claimed separately through Aave's rewards infrastructure. Treating all yield as `aToken.balanceOf` is incomplete.

### Aave v4: the same integration problem, with a different boundary

Aave v4 changes the integration boundary. The architecture moves toward a Hub and Spoke design. The Hub is the consolidated liquidity and accounting layer. Spokes implement user-facing or product-specific logic, each with its own risk and operational configuration. The Aave v4 documentation describes the Hub as issuing per-Spoke credit and debit limits and enforcing system-wide constraints. Spoke data includes active status, module settings, liquidation parameters, supplied and borrowed balances, cap usage, and connected hubs and assets.

For integrators, the lesson is not "v4 removes the old risks." The lesson is that the risk boundary moved.

In v3, a strategy often asks, "What is the user's position in this Pool and reserve?" In v4, a strategy must ask, "Which Spoke am I using, what limits does that Spoke have against the Hub, and what risk rules apply to this position inside that Spoke?" A v3-style integration that assumes one market-level Pool and one reserve-level risk model can be subtly wrong in v4.

There are fewer public third-party integration incidents for Aave v4 at the time of writing, partly because v4 is newer and its public security process has been unusually visible. Aave Labs' v4 security update describes roughly 345 days of cumulative review, multiple audit firms, invariant testing, formal verification work, a public Sherlock contest, and no reported critical or high findings in the public contest. The official v4 repository also publishes audit reports under its `audits` directory.

That does not make future integrations safe by default. It raises the quality bar for core protocol assumptions, while pushing more responsibility onto integrators that compose with Hub and Spoke liquidity.

## A practical severity model for Aave integration findings

Aave-related findings often sound scary because the underlying protocol is complex. Complexity alone is not impact. The following matrix is a useful way to separate true positives from weak reports.

| Question | Why it matters |
|---|---|
| Can the attacker trigger the Aave behavior without privileged access? | Permissionless flash loans, direct aToken transfers, `supply(onBehalfOf)`, public strategy functions, and user-controlled calldata are common triggers. |
| Does the affected contract hold pooled funds, allowances, aTokens, debt authority, or accounting power? | A callback bug in an empty receiver is very different from a callback bug in a vault holding user assets. |
| Does the integration update internal state before confirming Aave's actual result? | This is where bridges, vault shares, and strategy accounting become dangerous. |
| Does Aave's user configuration or reserve configuration differ from the integration's local assumptions? | LTV-zero assets, eMode, Isolation Mode, Siloed Borrowing, pause, freeze, and caps live here. |
| Is the impact principal loss, yield loss, bad debt, liquidation, or long-lived fund lock? | Observations without material impact usually become low, info, or invalid. |
| Is the token or mode explicitly supported? | Weird ERC20 behavior, fee-on-transfer assets, unsupported markets, and future integrations are common invalidation points. |
| Is there a reliable recovery path? | Admin rescue, pause, upgradeability, withdrawal queues, and keeper actions can reduce severity, but only if they really work under the failure condition. |

This aligns with public judging standards. Sherlock's current severity guidance, for example, focuses on direct loss of funds for high severity and material loss or broken core functionality for medium severity. It also explicitly treats accidental direct token transfers, unsupported non-standard tokens, purely view-function errors, and many admin self-misconfiguration cases as not valid medium or high issues by default.

The rest of this article applies that model to real cases.

## True positive case studies

### 1. DODO MarginTrading: Aave flash loan callback as an unintended public entry point

**Public source:** Sherlock DODO contest, issue #150.  
**Code anchor:** `dodo-margin-trading-contracts/contracts/marginTrading/MarginTrading.sol` in the Sherlock snapshot, commit `1ba64de11b26172ae6b950dcc6109300449fe191`. Relevant areas are the flash-loan entry and callback around `executeFlashLoans` and `executeOperation`, and the swap approval logic.  
**Representative links:**

- Report: `https://github.com/sherlock-audit/2023-05-dodo-judging/issues/150`
- Scoped repo snapshot: `https://github.com/sherlock-audit/2023-05-dodo/tree/1ba64de11b26172ae6b950dcc6109300449fe191`
- Code: `https://github.com/sherlock-audit/2023-05-dodo/blob/1ba64de11b26172ae6b950dcc6109300449fe191/dodo-margin-trading-contracts/contracts/marginTrading/MarginTrading.sol`

The root cause is brutally simple: the contract treated an Aave callback as if it were only reachable through the contract's own authorized `executeFlashLoans` function.

The vulnerable flow had two separate gates:

```solidity
modifier onlyFlashLoan() {
    require(
        _USER == msg.sender ||
        owner() == msg.sender ||
        IMarginTradingFactory(owner()).isAllowedProxy(address(this), msg.sender),
        "caller is unauthorized"
    );
    _;
}

modifier onlyLendingPool() {
    require(address(lendingPool) == msg.sender, "caller is not the lendingPool");
    _;
}
```

`executeFlashLoans` was protected by `onlyFlashLoan`. The callback `executeOperation` was protected only by `onlyLendingPool`.

That is not enough. Anyone can call Aave's Pool and set the DODO MarginTrading contract as the flash-loan receiver. Aave will then call `executeOperation`, so `msg.sender == lendingPool` is true. The attacker has bypassed the protocol's intended authorization layer without compromising Aave.

The dangerous part was what the callback did with attacker-controlled params. The callback decoded `_swapApproveTarget`, `_swapApproveToken`, and `_swapParams`, approved tokens to the attacker-chosen approval target, and made a low-level call. In other words, once the attacker reached the callback, they could convert a flash-loan receiver into an approval oracle for assets already sitting in the contract.

A simplified shape of the bug is:

```solidity
function executeOperation(..., bytes calldata params)
    external
    onlyLendingPool
    returns (bool)
{
    (
        uint8 flag,
        address swapAddress,
        address swapApproveTarget,
        address[] memory swapApproveToken,
        bytes memory swapParams,
        ...
    ) = abi.decode(params, (...));

    for (uint256 i = 0; i < swapApproveToken.length; i++) {
        IERC20(swapApproveToken[i]).approve(swapApproveTarget, type(uint256).max);
    }

    (bool success,) = swapAddress.call(swapParams);
    require(success, "swap fail");
}
```

This is a textbook true positive because all four ingredients are present.

The attacker trigger is permissionless Aave flash loan initiation. The affected contract holds user-managed margin assets. The callback performs attacker-influenced approvals and calls. The impact is direct token drain, not a mere revert.

The correct fix is not merely "check `msg.sender == Pool`." The Pool is the messenger, not the origin of intent. A robust receiver binds the callback to a pending operation created by the contract itself:

```solidity
function executeOperation(
    address[] calldata assets,
    uint256[] calldata amounts,
    uint256[] calldata premiums,
    address initiator,
    bytes calldata params
) external returns (bool) {
    require(msg.sender == address(POOL), "ONLY_AAVE_POOL");
    require(initiator == address(this), "BAD_INITIATOR");

    bytes32 opHash = keccak256(abi.encode(assets, amounts, params));
    require(opHash == pendingFlashloanHash, "UNEXPECTED_FLASHLOAN");
    delete pendingFlashloanHash;

    // No arbitrary approval target. No arbitrary router call.
}
```

Our view: this is one of the highest signal patterns in the entire Aave integration corpus. Any Aave flash-loan receiver that decodes attacker-controlled params and only checks the Pool as `msg.sender` should be treated as guilty until the receiver proves how it binds intent.

### 2. Mimo SuperVault: the same flash-loan receiver bug, amplified by arbitrary swap calldata

**Public source:** Code4rena Mimo DeFi contest, H-02.  
**Code anchor:** `supervaults/contracts/SuperVault.sol` at commit `b18670f44d595483df2c0f76d1c57a7bfbfbc083`.  
**Representative links:**

- Report: `https://code4rena.com/reports/2022-04-mimo#h-02-fund-loss-or-theft-by-attacker-with-creating-a-flash-loan-and-setting-supervault-as-receiver-so-executeoperation-will-be-get-called-by-lendingpool-but-with-attackers-specified-params`
- Original issue: `https://github.com/code-423n4/2022-04-mimo-findings/issues/123`
- Code: `https://github.com/code-423n4/2022-04-mimo/blob/b18670f44d595483df2c0f76d1c57a7bfbfbc083/supervaults/contracts/SuperVault.sol#L76-L99`

Mimo's SuperVault case is the same class as DODO, but it demonstrates why the bug is not just about approvals. The public report shows a callback that checks `msg.sender == lendingPool`, decodes an attacker-controlled operation, and then dispatches into leverage, rebalance, or empty-vault logic. Those operations can call `aggregatorSwap` with user-controlled DEX transaction data.

The issue report included this callback shape:

```solidity
function executeOperation(
    address[] calldata assets,
    uint256[] calldata amounts,
    uint256[] calldata premiums,
    address,
    bytes calldata params
) external returns (bool) {
    require(msg.sender == address(lendingPool), "SV002");
    (Operation operation, bytes memory operationParams) = abi.decode(params, (Operation, bytes));

    if (operation == Operation.LEVERAGE) {
        leverageOperation(asset, flashloanRepayAmount, operationParams);
    }
    if (operation == Operation.REBALANCE) {
        rebalanceOperation(asset, amounts[0], flashloanRepayAmount, operationParams);
    }
    if (operation == Operation.EMPTY) {
        emptyVaultOperation(asset, amounts[0], flashloanRepayAmount, operationParams);
    }

    asset.approve(address(lendingPool), flashloanRepayAmount);
    return true;
}
```

Inside the swap helper, the router call used attacker-influenced calldata:

```solidity
function aggregatorSwap(
    uint256 dexIndex,
    IERC20 token,
    uint256 amount,
    bytes memory dexTxData
) internal {
    (address proxy, address router) = _dexAP.dexMapping(dexIndex);
    require(proxy != address(0) && router != address(0), "SV201");
    token.approve(proxy, amount);
    router.call(dexTxData);
}
```

The sponsor confirmed the issue. The recommended mitigation was to maintain a state variable proving that the vault itself initiated the flash loan, then reject callback execution when that state is not active.

The deeper lesson is that flash-loan receiver bugs become catastrophic when the callback can perform arbitrary route execution. Modern DeFi protocols often outsource execution to aggregators. That is fine when the route is user-initiated and slippage-protected. It is not fine when the route is decoded from callback params that any attacker can route through Aave.

A good mental model is:

```text
Aave Pool callback authentication proves transport authenticity.
It does not prove business intent.
```

The receiver must separately authenticate business intent.

### 3. PoolTogether Aave V3 Yield Source: aToken donation and share-price manipulation

**Public source:** Code4rena PoolTogether Aave V3 Yield Source contest, H-01.  
**Code anchor:** `contracts/AaveV3YieldSource.sol` at commit `e63d1b0e396a5bce89f093630c282ca1c6627e44`.  
**Representative links:**

- Report: `https://code4rena.com/reports/2022-04-pooltogether#h-01-yield-source-can-be-manipulated-and-drained-of-funds`
- Code: `https://github.com/pooltogether/aave-v3-yield-source/blob/e63d1b0e396a5bce89f093630c282ca1c6627e44/contracts/AaveV3YieldSource.sol`

This is the canonical aToken integration bug.

The yield source minted ERC20 shares representing a claim on Aave-supplied assets. The conversion from underlying tokens to shares used the contract's aToken balance as the denominator:

```solidity
function _tokenToShares(uint256 _tokens) internal view returns (uint256) {
    uint256 _supply = totalSupply();
    return _supply == 0
        ? _tokens
        : _tokens.mul(_supply).div(aToken.balanceOf(address(this)));
}
```

The reverse conversion also used the aToken balance:

```solidity
function _sharesToToken(uint256 _shares) internal view returns (uint256) {
    uint256 _supply = totalSupply();
    return _supply == 0
        ? _shares
        : _shares.mul(aToken.balanceOf(address(this))).div(_supply);
}
```

This looks natural. It is also exactly what the attacker needs.

The attack described in the report is the standard first-depositor donation pattern:

1. The attacker deposits a tiny amount, such as 1 wei, and receives the initial share supply.
2. The attacker directly transfers a large amount of aTokens to the yield source contract.
3. The denominator `aToken.balanceOf(address(this))` becomes enormous, but total share supply remains tiny.
4. A later depositor receives almost no shares for a large deposit.
5. The attacker redeems their tiny share supply for a large fraction of the pool.

The key is that the aToken donation changes the exchange rate without minting shares. This is not an Aave bug. Aave allows ERC20 transfers of aTokens. The integration chose to let direct aToken balance affect share pricing.

This is a true positive because the attack is permissionless and directly impacts later depositors. It is not merely that "aTokens rebase." It is that `aToken.balanceOf` was used as live share-accounting state, and an attacker could manipulate that state without passing through `supplyTokenTo`.

The fix pattern is familiar from hardened ERC4626 vaults:

- Use virtual shares or dead shares to prevent first-depositor price griefing.
- Add `minSharesOut` to deposits.
- Use internal accounting for managed assets, or explicitly define direct donations as belonging to existing share holders.
- Use before-and-after deltas for actual received assets.
- Test first-deposit, one-wei, donation, rebasing accrual, and rounding-to-zero cases on a fork.

Our judgment: aToken donation bugs are often underappreciated because the exploit feels like a vault math bug rather than an Aave bug. That is exactly why it matters. Aave composability turns a standard vault pitfall into a production-grade integration failure.

### 4. Morpho-Aave v3: LTV-zero aToken poison and configuration divergence

**Public source:** Spearbit Morpho-Aave v3 security review.  
**Representative links:**

- Audit report PDF: `https://cdn.morpho.org/documents/Spearbit_04052023.pdf`
- Related independent writeup: `https://stermi.medium.com/aave-v3-bug-bounty-part-3-ltv-0-atoken-poison-attack-4f2478558988`

The Morpho-Aave v3 report is one of the richest sources for Aave integration risk because Morpho did not simply deposit into Aave. It built a peer-to-peer matching layer over Aave. That means Morpho had to reason about Aave's real collateral configuration, user configuration, and reserve behavior. When it diverged, the impact was not cosmetic.

The most famous class is LTV-zero aToken poison. In Aave v3, certain assets can have LTV equal to zero. They may be supplied, but they do not provide borrowing power. Aave's validation logic treats accounts holding zero-LTV collateral specially. Historically, an attacker could send 1 wei of a zero-LTV aToken to a victim. If the receiver did not already hold that aToken, it could be set as collateral, causing later withdraw, transfer, or collateral-configuration operations involving non-zero-LTV collateral to revert.

StErMi's public bug bounty writeup explains the primitive clearly: an attacker can poison a user by sending 1 wei of an aToken whose underlying has LTV zero; the victim can then be blocked from operations such as withdrawing non-zero-LTV collateral or transferring non-zero-LTV aTokens until the poisoned asset is handled.

For an individual Aave user, this is a griefing and UX issue. For an integration that uses one pooled Aave account to represent many users, it can become systemic. That was the Morpho risk. The Spearbit report described critical issues where LTV-zero aToken side effects could block withdraws, borrows, liquidations, and reward claims, and could also alter health-factor behavior.

The true-positive reasoning is strong:

- The attacker trigger can be a tiny token transfer or supply-on-behalf path.
- The affected address is not a normal end user. It is a protocol account representing many users.
- The failure mode blocks core protocol operations and can influence liquidation risk.
- The integration cannot simply say, "Aave reverted, so nothing happened." Morpho's own state and user promises depend on being able to operate its Aave position.

The same report also contains a related critical class: isolated assets and collateral eligibility were not always mirrored correctly. Some assets in Aave may be supplied but not actually usable as collateral in the way the integration expects. If the upper-layer protocol treats such assets as collateral anyway, users can borrow against collateral that Aave does not recognize. This is the dangerous kind of risk-engine copy: the integration's health model says yes, Aave's health model says no, and the difference can create liquidation or bad-debt risk.

A simplified invariant for this class is:

```text
For every user action that changes supplied collateral, borrowed debt, eMode, isolation status, or collateral usage:

    integration_internal_health(user)
        must not be more permissive than
    Aave_actual_health_or_configuration(protocol_account)
```

If the integration is more permissive, attackers borrow. If Aave is more restrictive, users get stuck. Both are bad.

Our view: this is the most important non-flashloan lesson in the corpus. Integrations that build on Aave at the strategy layer can treat Aave as an external venue. Integrations that build a lending layer over Aave are effectively re-implementing part of Aave's risk engine. That is a different security category.

### 5. Morpho-Aave v3: eMode price-source divergence

**Public source:** Spearbit Morpho-Aave v3 security review.  
**Representative link:** `https://cdn.morpho.org/documents/Spearbit_04052023.pdf`

Aave v3 eMode allows assets in the same category to use optimized risk parameters and, in some cases, a custom price source. The edge case is `priceSource == address(0)`, which has specific fallback semantics inside Aave. The Morpho report identified a divergence in price retrieval under eMode when the price source was zero.

This is not just an oracle nit. It is a state-machine equivalence issue.

If an integration calls Aave's oracle directly and then builds local health-factor or collateral-value logic, it must reproduce Aave's branch structure. The relevant branches include:

- eMode category or no eMode category.
- Custom price source or zero price source.
- Underlying reserve price or category-level price.
- Decimal scaling and base currency.
- Fallback oracle behavior.

A bug is serious when the wrong price changes borrow limits, liquidation eligibility, share pricing, or redemption value. It is weak when the price is used only for UI display or analytics.

The Morpho case was serious because Morpho's own matching and risk logic depended on pricing equivalence with Aave. That is the difference between a view bug and a solvency bug.

A good review habit is to write a differential test:

```text
For every supported asset and every supported eMode category:

    integration_price(asset, eModeCategory)
        must equal
    Aave_price_used_for_validation(asset, eModeCategory)

under:
    priceSource != address(0)
    priceSource == address(0)
    fallback oracle used
    decimals != 18
    stale or paused reserve state
```

The boring branch is where bugs hide.

### 6. Connext Amarok: ignoring the actual amount withdrawn from Aave

**Public source:** Code4rena Connext Amarok contest, M-15.  
**Code anchor:** `BridgeFacet.sol`, `_executePortalTransfer`, around the lines referenced in the report. The fix is commit `b99f9cf54b5d03029c6665776dc434d744758339`.  
**Representative links:**

- Report: `https://code4rena.com/reports/2022-06-connext#m-15-bridgefacet_executeportaltransfer-ignores-the-actual-underlying-token-amount-withdrawn-from-aave`
- Fix commit: `https://github.com/connext/monorepo/commit/b99f9cf54b5d03029c6665776dc434d744758339`

This case is less flashy than callback theft, but it is one of the best examples of integration accounting discipline.

The finding was that Connext's portal transfer flow withdrew funds from Aave but did not use the actual amount returned by Aave's `withdraw`. The report notes that Aave may not be able to withdraw the full requested amount if pool liquidity is insufficient. The mitigation was to check that the full amount was withdrawn or to use the actual returned amount in accounting.

This issue is about dynamic liquidity. Aave is a lending market. Supplied assets may be borrowed by others. Available liquidity can be lower than total supplied liquidity. A withdrawal can fail or return less than the integration's optimistic assumption, depending on the exact interface and mode.

The true-positive reasoning is strongest in cross-chain and bridge contexts because state is often split across domains. If a protocol releases or mints assets on one side based on an intended Aave withdrawal on the other side, any mismatch can create a deficit.

The rule is simple:

```solidity
uint256 beforeBal = token.balanceOf(address(this));
uint256 returned = pool.withdraw(asset, requested, address(this));
uint256 afterBal = token.balanceOf(address(this));
uint256 received = afterBal - beforeBal;

require(received == requested, "AAVE_WITHDRAW_SHORTFALL");
require(returned == received, "BAD_AAVE_WITHDRAW_RETURN");
```

Sometimes the right behavior is not to accept a partial withdraw. In a bridge, partial execution may be worse than revert. In a vault with withdrawal queues, partial execution may be acceptable if shares are burned proportionally. What is not acceptable is using `requested` as if it were `received`.

Our view: this class is a quiet killer. It rarely produces an elegant one-transaction theft proof, but it is exactly how accounting systems become insolvent during stress.

### 7. Float Capital and Alchemix: Aave rewards are not the same as aToken yield

**Public sources:** Code4rena Float Capital contest, Immunefi Alchemix V3 audit competition.  
**Representative links:**

- Float report: `https://code4rena.com/reports/2021-08-floatcapital#m-05-use-the-atoken-instead-of-the-payment-token-when-claiming-aave-rewards`
- Alchemix report #57812: `https://reports.immunefi.com/alchemix-v3/57812-sc-medium-no-function-to-claim-aave-incentives`
- Alchemix report #58080: `https://reports.immunefi.com/alchemix-v3/58080-sc-medium-aave-v3-strategies-fail-to-claim-op-arb-liquidity-mining-rewards-causing-permanent-l`

Aave integrations commonly capture base yield because it appears in `aToken.balanceOf`. That does not mean they capture incentive rewards.

The Float Capital report identified a wrong-asset rewards claim: the yield manager used the payment token where Aave expected the aToken. The result was that rewards could not be claimed correctly.

The Alchemix V3 Immunefi reports show the same theme in a later strategy context. Report #57812 states that Aave strategies supplied assets but lacked a function to claim Aave incentives, causing permanent freezing of unclaimed yield. Report #58080 is even more explicit: the strategies captured base supply APY through aToken balances but ignored OP and ARB rewards distributed through Aave's `RewardsController`.

This class is usually medium, not critical. But it becomes real when the following are true:

- The strategy is non-upgradeable or lacks a rescue path.
- Rewards are economically material.
- Rewards are part of the user's expected or advertised yield.
- The rewards are attributed to the strategy address and cannot be claimed by anyone else.
- The protocol has a working reward pattern elsewhere, suggesting omission rather than intentional design.

It becomes weak or informational when rewards are not part of the product promise, rewards belong to treasury by design, reward emissions are not active, or an authorized manager can recover them safely.

The integration checklist is short:

```text
Base yield:
    aToken balance growth.

Incentive yield:
    RewardsController claim path.

Accounting questions:
    Who owns rewards?
    Who can claim them?
    Where are they sent?
    Are there multiple reward tokens?
    Are reward assets aTokens or underlyings?
    Can the strategy be upgraded if Aave changes reward configuration?
```

Our view: reward bugs are often dismissed too quickly because they do not steal principal. That is a mistake when the protocol sells yield as the product. Lost yield is still user value. The severity should follow the product promise.

## False positives and context-limited cases

The negative cases are just as important as the true positives. They explain why many Aave-related reports do not deserve high severity even when they describe a real protocol behavior.

### 1. GoodEntry OptionsPositionManager: missing `initiator` check is a red flag, but the report still has to prove the asset flow

**Public source:** Code4rena GoodEntry issues #110 and #138.  
**Code anchor:** `contracts/PositionManager/OptionsPositionManager.sol` at commit `71c0c0eca8af957202ccdbf5ce2f2a514ffe2e24`.  
**Representative links:**

- Issue #110: `https://github.com/code-423n4/2023-08-goodentry-findings/issues/110`
- Issue #138: `https://github.com/code-423n4/2023-08-goodentry-findings/issues/138`
- Code: `https://github.com/code-423n4/2023-08-goodentry/blob/71c0c0eca8af957202ccdbf5ce2f2a514ffe2e24/contracts/PositionManager/OptionsPositionManager.sol`

GoodEntry is interesting because it looks, at first glance, like the DODO and Mimo bug. The report argued that anyone could initiate an Aave flash loan with `OptionsPositionManager` as the receiver, because `executeOperation` decoded params and did not check `initiator`. The issue was labelled high risk in the issue tracker, but also marked sponsor disputed and unsatisfactory. It did not become a clean public true-positive case in the same way DODO or Mimo did.

This is a useful negative control.

A missing `initiator` check is a strong smell. It is not, by itself, a complete exploit. The report must still show what attacker-controlled callback execution can do to funds that the attacker does not own. The decisive questions are:

- Can the attacker choose a victim user whose funds will be withdrawn, repaid, swapped, or liquidated?
- Does the callback use `msg.sender`, decoded `user`, or stored state in a way that points at the attacker rather than the victim?
- Are there slippage checks, oracle checks, reserve checks, or cleanup logic that block the malicious route?
- Does the receiver hold funds outside the flash-loaned assets?
- Does the exploit leave the attacker with profit after paying the flash-loan premium?

If those links are not proven, judges may treat the report as an incomplete attack path even if the design could be hardened.

Our judgment is deliberately nuanced: missing `initiator` validation in an Aave receiver is rarely acceptable engineering. But severity is not awarded for smell. It is awarded for demonstrated impact. A rigorous report should include a fork test or a concrete trace showing the unauthorized state transition and final balances.

### 2. PoolTogether fee-on-transfer and rebasing observations: technically correct, but support assumptions decide severity

**Public source:** Code4rena PoolTogether Aave V3 Yield Source contest, M-02 and M-05.  
**Representative link:** `https://code4rena.com/reports/2022-04-pooltogether`

The same PoolTogether contest that produced the high-severity aToken donation issue also produced more context-limited findings.

One finding concerned fee-on-transfer tokens. If the protocol calculates shares from an input amount but receives less due to transfer fees, accounting can diverge. That is a real pattern. But the sponsor stated that fee-on-transfer tokens were not planned to be supported, and the judge treated the impact as more constrained than a general user-fund drain.

Another finding concerned rebasing and share conversion edge cases. The report discussed scenarios where conversion rounding could leak value or break precision in unusual decimal and exchange-rate conditions. The judge decreased severity to medium because the issue was edge-case dependent and did not show the same direct drain path as H-01.

The lesson is not that fee-on-transfer and rebasing issues are fake. The lesson is that support boundaries matter.

A finding is stronger when the protocol claims to support arbitrary ERC20s or lets governance permissionlessly add assets. A finding is weaker when the adapter only supports canonical Aave underlying assets, or when the token behavior is explicitly excluded by documentation.

A clean report should say:

```text
This token behavior is in scope because:
    - the README says arbitrary ERC20s are supported; or
    - governance can add this asset without code changes; or
    - this exact Aave market asset has the behavior; or
    - the protocol has already deployed the strategy for this asset.
```

Without that bridge, the report may be true but not security-critical.

### 3. PoolTogether reward ownership: admin can claim rewards, but who owns the rewards?

**Public source:** Code4rena PoolTogether Aave V3 Yield Source contest, M-03 and M-04.  
**Representative link:** `https://code4rena.com/reports/2022-04-pooltogether`

PoolTogether also had reward-related findings. One report argued that the owner or manager could claim Aave rewards to an arbitrary address. Another argued that Aave's RewardsController emission manager could authorize claimers and siphon yield.

These are real trust-boundary questions. They are not automatically high severity.

The right analysis is not "someone can claim rewards, therefore theft." The right analysis is:

- Were Aave rewards promised to depositors?
- Are the owner and manager trusted roles under the contest assumptions?
- Does the reward token represent user principal, user yield, protocol fee, or external subsidy?
- Can the authorized claimer affect only future rewards, or already accrued rewards?
- Can governance or the manager recover from a wrong claimer?
- Is the external Aave emission manager in the threat model?

If the protocol explicitly treats rewards as manager-controlled treasury income, then arbitrary reward recipient behavior is not a user-fund bug. If the product markets those rewards as depositor APY, then the same behavior becomes a real loss of yield.

This is why reward findings often land in medium, low, or informational territory. The code path alone does not decide severity. The product promise does.

### 4. Index / SetToken Aave leverage module: LTV-zero and Isolation Mode observations can be semantically right but non-reward

**Public source:** Sherlock Index contest issues #90, #164, and #95.  
**Code anchor:** audit scope included `index-protocol` at commit `86be7ee76d9a7e4f7e93acfc533216ebef791c89`, including `contracts/protocol/modules/v1/AaveV3LeverageModule.sol`.  
**Representative links:**

- LTV-zero issue #90: `https://github.com/sherlock-audit/2023-05-Index-judging/issues/90`
- Forced Isolation Mode issue #164: `https://github.com/sherlock-audit/2023-05-Index-judging/issues/164`
- eMode configuration issue #95: `https://github.com/sherlock-audit/2023-05-Index-judging/issues/95`
- Scoped repo: `https://github.com/sherlock-audit/2023-05-Index`

The Index contest produced several Aave-semantics reports around LTV-zero aTokens, Isolation Mode, and eMode configuration. Some were labelled non-reward or excluded.

This is one of the most valuable false-positive clusters because the underlying observations are not nonsense. Aave v3 really does have LTV-zero restrictions. Isolation Mode really does change borrow behavior. eMode really can make certain borrows fail if assets are outside the selected category.

The missing piece is usually exploit framing.

A report is weak if it says, "This Aave configuration can make a function revert," but does not prove that an attacker can force the configuration, that the function is time-sensitive, that funds are locked beyond a meaningful period, or that users lose principal or yield. A report is stronger if the attacker can send dust, force the protocol account into a restricted Aave user configuration, and block redemptions or liquidations for all SetToken holders with no recovery path.

In other words, the same Aave fact can be either:

```text
Low or informational:
    A configuration makes an optional action revert.
    Admin or manager can restore the state.
    No user funds are lost or locked for a material period.

High or medium:
    An attacker can force the configuration.
    Core issuance, redemption, deleveraging, or liquidation breaks.
    The affected account represents pooled users.
    There is no practical recovery path before funds or time-sensitive operations are harmed.
```

This distinction is also aligned with Sherlock's judging guidance on denial of service. A short-lived revert is not enough. Long-lived fund lock or time-sensitive function failure is what gives the issue security weight.

### 5. Grove ALM Controller: LTV-zero withdrawal blocking as acknowledged operational risk

**Public source:** ChainSecurity Grove ALM Controller audit.  
**Representative link:** `https://www.chainsecurity.com/security-audit/grove-alm-controller`

ChainSecurity's Grove ALM review discussed an Aave withdrawal-blocking risk involving LTV-zero assets. The issue was acknowledged rather than treated as a high-impact exploit. The important context was that the route depended on configuration changes or specific asset states, and the system had a relayer or management path capable of withdrawing the relevant balance and resetting the condition.

This is exactly the difference between a vulnerability and an operational sharp edge. If governance can change an Aave parameter and your integration temporarily needs a special order of operations, that is not automatically a high-severity bug. If the same parameter change causes permanent insolvency or unbounded user lock, it is.

Our view: reports that rely on Aave governance parameter changes must be especially precise. Governance changes are real. They happen. But they are not attacker actions unless the attacker controls governance or can exploit the change before normal operational response. The severity argument must account for monitoring, timelocks, emergency pause, asset delisting, and rescue paths.

## Cross-case patterns: what the cases are really saying

### Pattern 1: Aave callback authentication has two layers

Every flash-loan receiver needs transport authentication:

```solidity
require(msg.sender == address(POOL), "ONLY_POOL");
```

But that is only the first layer. It proves that Aave called the function. It does not prove that the receiver wanted this operation.

Business-intent authentication needs at least one of:

- `initiator == address(this)`.
- A stored pending operation nonce.
- A hash of expected assets, amounts, modes, and params.
- A known original caller bound before the flash loan.
- A strict route whitelist and recipient validation.

The dangerous anti-pattern is:

```solidity
require(msg.sender == address(POOL));
(operation, data) = abi.decode(params, ...);
_doWhatever(data);
```

That is not a private callback. That is a public function with Aave as a forwarding layer.

### Pattern 2: Aave balances are not always accounting balances

`aToken.balanceOf` is a real claim. It is also a moving target. It changes because interest accrues. It can change because someone transfers aTokens directly. It may include assets not minted through your deposit function.

This does not mean `aToken.balanceOf` is unusable. It means the integration must define what it means.

Possible policies:

```text
Donation belongs to existing share holders.
    Then direct aToken transfer should increase PPS, and depositors need minSharesOut.

Donation is protocol income.
    Then internal accounting must separate managed assets from unexpected balances.

Donation is unsupported and recoverable.
    Then a rescue function must exist, and it must not steal managed assets.

Donation should be impossible.
    Then the assumption is wrong for ERC20-like aTokens.
```

The worst policy is the implicit one: direct aToken balance changes share pricing, but users have no slippage protection and first-deposit math is fragile.

### Pattern 3: Aave user configuration is part of your attack surface

Aave stores user-level configuration: which reserves are used as collateral, eMode category, debt state, collateral state, and so on. If your protocol uses a contract address as an Aave user, that address has a user configuration too.

Attackers may be able to influence it through:

- Direct aToken transfers.
- `supply(asset, amount, onBehalfOf, referralCode)`.
- Dusting tokens.
- Triggering functions that call Aave with attacker-selected assets.
- Waiting for governance parameter changes.

A good integration treats the Aave user configuration as external mutable state, not as a private implementation detail.

### Pattern 4: Re-implementing Aave's risk engine is a high-risk decision

Calling Aave and letting Aave revert is relatively safe. Reproducing Aave's borrow capacity, liquidation threshold, eMode price source, isolation debt ceiling, siloed borrow constraints, and collateral eligibility is much harder.

If a protocol re-implements risk logic, it needs differential testing against Aave's own result. For v3, this means comparing against `getUserAccountData`, reserve configuration, user configuration, eMode categories, and oracle behavior. For v4, it means comparing against Spoke-level position and risk data, not just Hub-level liquidity.

The invariant is not that your math looks similar. The invariant is that your math is never more permissive than Aave's actual validation in any state you support.

### Pattern 5: External liquidity is not guaranteed liquidity

Aave liquidity can be borrowed out. Reserves can be frozen or paused. Caps can be reached. Risk parameters can change. If your integration promises instant redemption, bridge settlement, or strategy deallocation, you must decide what happens when Aave does not return the requested amount.

There are only three safe designs:

1. Revert before internal state changes.
2. Use actual received amounts and account for partial completion.
3. Use withdrawal queues, liquidity buffers, or delayed settlement.

Everything else is accounting optimism.

### Pattern 6: Reward ownership must be explicit

Aave base yield and Aave incentives are separate systems. The security question is not only whether rewards can be claimed. It is who owns them.

A strategy should explicitly state:

- Are Aave incentives user yield, protocol revenue, or ignored subsidies?
- Who can call `claimAllRewards`?
- What assets are passed to the rewards controller?
- What recipient receives rewards?
- Are multiple reward tokens supported?
- Can rewards be swept without sweeping principal?

Ambiguity becomes severity when users reasonably expect the rewards.

### Pattern 7: Aave v4 moves integration risk to the Spoke boundary

The v4 Hub and Spoke model is a meaningful architectural improvement, but it does not remove integration responsibility. It changes the questions.

For v4 integrators, the checklist becomes:

- Which Spoke is the integration using?
- Is the Spoke active?
- What Hub assets is the Spoke connected to?
- What are the Spoke's credit and debit limits?
- Which caps apply at Hub level and Spoke level?
- Which liquidation parameters apply to this Spoke?
- Is the integration reading the position from the correct risk domain?
- Does the integration assume liquidity in the Hub that the Spoke cannot actually draw?
- Does the integration handle risk premium effects on cost and liquidation?

The v3 failure mode was often "we copied Aave reserve logic incompletely." The v4 failure mode will often be "we treated Hub liquidity as if it were Spoke-available liquidity" or "we applied the wrong Spoke's risk assumptions."

## A review checklist for Aave integrations

### Flash loans

- Does every `executeOperation` check `msg.sender == Pool`?
- Does it check `initiator` or bind a pending operation hash?
- Can an attacker call Aave and set this contract as receiver?
- Are assets, amounts, premiums, modes, and params validated against stored intent?
- Can callback params choose approval targets, routers, calldata, recipients, or users?
- Does the receiver hold idle funds that could repay an attacker-triggered flash loan?
- Are debt-opening modes disabled unless intentionally used?
- Are temporary allowances reset?

### aTokens and vault shares

- Is `aToken.balanceOf` used as total assets?
- What happens if someone transfers aTokens directly to the contract?
- Is first-depositor inflation possible?
- Are there virtual shares, dead shares, or minimum initial liquidity?
- Does deposit have `minSharesOut`?
- Are before-and-after deltas used for actual received assets?
- Is scaled balance mixed with underlying balance?
- Can rounding produce zero shares for nonzero deposits?
- Is accrued aToken yield allocated intentionally?

### Withdrawals and liquidity

- Does the integration assume Aave can always withdraw the requested amount?
- Are actual returned amounts checked?
- Are internal shares burned before or after Aave confirms withdrawal?
- In cross-chain flows, can the remote side finalize before source liquidity is secured?
- Is there a withdrawal queue or liquidity buffer?
- Are paused, frozen, capped, or low-liquidity reserves tested?

### Aave user configuration

- Can attackers send or supply aTokens to the protocol account?
- Can unknown aTokens become collateral for the protocol address?
- Does the protocol handle LTV-zero assets?
- Can governance reduce supported asset LTV to zero?
- Is there a rescue path to withdraw dust or disable collateral?
- Does the protocol monitor Aave reserve configuration changes?

### Risk modes and oracle logic

- Is eMode supported?
- Is `priceSource == address(0)` handled exactly as Aave handles it?
- Are Isolation Mode and Siloed Borrowing supported or blocked?
- Are debt ceilings and borrowable assets checked?
- Does internal borrow capacity ever exceed Aave's actual borrow capacity?
- Are decimals and oracle base units tested across all supported assets?
- Are view functions used only for UI, or do they feed fund-moving logic?

### Rewards

- Are base aToken yield and incentive rewards accounted separately?
- Does the strategy call the correct RewardsController for the chain and market?
- Does it pass aTokens, not underlyings, where required?
- Are multiple reward tokens supported?
- Can rewards be claimed after strategy migration?
- Are rewards sent to the vault, users, treasury, or manager?
- Is reward ownership documented?

### Aave v4-specific integration questions

- Does the integration use Hub or Spoke interfaces directly?
- Does it read the correct Spoke-level position?
- Are Hub credit and debit limits checked?
- Are Spoke caps, active status, and liquidation parameters checked?
- Does the integration assume Hub liquidity is universally drawable?
- Is the risk premium included in cost and solvency modeling?
- Are v3 liquidation assumptions accidentally reused?
- If the integration builds a custom Spoke, does it have its own invariant suite for Hub accounting, caps, liquidation, and solvency?

## How to write a strong Aave integration report

The best reports do not merely say "Aave has this behavior." They show how the integration misuses that behavior.

A strong report includes:

1. The exact Aave primitive involved: flash loan receiver, aToken transfer, LTV-zero collateral, eMode oracle, RewardsController, withdraw liquidity, credit delegation, or Hub and Spoke limit.
2. The attacker-controlled entry point.
3. The vulnerable integration assumption.
4. The state divergence.
5. A trace or PoC showing final balances, locked funds, bad debt, or lost yield.
6. The reason the issue is in scope for the supported assets and deployment chain.
7. The reason rescue, admin action, or revert behavior does not eliminate impact.

A weak report usually stops at step 1 or 2.

For example:

```text
Weak:
    Aave flash-loan callbacks can be called by anyone through the Pool.

Strong:
    Anyone can call Pool.flashLoan with this contract as receiver. The callback only checks msg.sender == Pool, decodes attacker-controlled swapApproveTarget, approves all USDC held by the contract, and calls attacker-controlled calldata. A fork test drains Alice's deposited USDC from the receiver.
```

Or:

```text
Weak:
    aTokens can be transferred directly to the vault.

Strong:
    The vault computes shares as depositAmount * totalSupply / aToken.balanceOf(vault). An attacker mints 1 wei share, donates 10,000 aTokens, and causes the next depositor to mint 1 wei share for a 10,000 token deposit. The attacker then redeems most assets.
```

Or:

```text
Weak:
    Aave rewards are not claimed.

Strong:
    The strategy is non-upgradeable, deployed on Arbitrum where the Aave RewardsController attributes ARB rewards to the strategy address, and the protocol advertises Aave strategy yield to depositors. No function can claim these rewards, so they remain permanently inaccessible.
```

Security severity is an argument about consequences, not just a list of edge cases.

## Final thesis

Aave integrations fail when developers collapse Aave into a simpler abstraction than it really is.

They treat aToken balances as static accounting. They treat Pool callbacks as private callbacks. They treat Aave liquidity as guaranteed liquidity. They treat Aave's oracle as a generic price feed. They treat eMode, Isolation Mode, Siloed Borrowing, LTV-zero assets, caps, freeze flags, and user configuration as rare governance details rather than active parts of the state machine. They treat rewards as if all yield appears in `balanceOf`.

The best Aave integrations do the opposite. They make the integration boundary explicit. They authenticate callbacks with intent, not only transport. They separate accounting balances from token balances. They compare internal risk logic against Aave's actual validation. They treat Aave configuration as mutable external state. They define reward ownership. They test with hostile dust, hostile callbacks, hostile liquidity conditions, hostile rounding, and hostile governance parameter changes.

Aave's composability is powerful because it gives protocols access to deep liquidity and mature risk infrastructure. The price of that composability is precision. When a protocol builds on Aave, it inherits not only liquidity, but also the obligation to model Aave's state machine honestly.

That is the trap. That is also the opportunity. The teams that understand the boundary can build very strong systems on top of Aave. The teams that round it down to "just another vault" will keep producing the same bugs.

## Case reference table

| Category | Case | Public outcome | Root cause | Primary reference |
|---|---|---:|---|---|
| True positive | DODO MarginTrading | Sherlock high, reward | Aave callback reachable by attacker, arbitrary approval and call in callback | `https://github.com/sherlock-audit/2023-05-dodo-judging/issues/150` |
| True positive | Mimo SuperVault | Code4rena high, sponsor confirmed | Aave callback reachable by attacker, arbitrary operation and aggregator calldata | `https://code4rena.com/reports/2022-04-mimo#h-02-fund-loss-or-theft-by-attacker-with-creating-a-flash-loan-and-setting-supervault-as-receiver-so-executeoperation-will-be-get-called-by-lendingpool-but-with-attackers-specified-params` |
| True positive | PoolTogether Aave V3 Yield Source | Code4rena high | Direct aToken donation manipulates share price | `https://code4rena.com/reports/2022-04-pooltogether#h-01-yield-source-can-be-manipulated-and-drained-of-funds` |
| True positive | Morpho-Aave v3 | Spearbit critical findings | LTV-zero aToken poison and Aave configuration divergence | `https://cdn.morpho.org/documents/Spearbit_04052023.pdf` |
| True positive | Morpho-Aave v3 | Spearbit critical finding | eMode price-source divergence | `https://cdn.morpho.org/documents/Spearbit_04052023.pdf` |
| True positive | Connext Amarok | Code4rena medium | Ignored actual Aave withdrawal amount | `https://code4rena.com/reports/2022-06-connext#m-15-bridgefacet_executeportaltransfer-ignores-the-actual-underlying-token-amount-withdrawn-from-aave` |
| True positive | Float Capital | Code4rena medium | Used underlying/payment token instead of aToken for Aave reward claim | `https://code4rena.com/reports/2021-08-floatcapital#m-05-use-the-atoken-instead-of-the-payment-token-when-claiming-aave-rewards` |
| True positive | Alchemix V3 | Immunefi medium | Aave strategy rewards unclaimable | `https://reports.immunefi.com/alchemix-v3/57812-sc-medium-no-function-to-claim-aave-incentives` |
| True positive | Alchemix V3 | Immunefi medium | OP and ARB rewards ignored by Aave v3 strategies | `https://reports.immunefi.com/alchemix-v3/58080-sc-medium-aave-v3-strategies-fail-to-claim-op-arb-liquidity-mining-rewards-causing-permanent-l` |
| Context-limited | GoodEntry OptionsPositionManager | Sponsor disputed, unsatisfactory issue status | Missing initiator check alleged, but exploit proof matters | `https://github.com/code-423n4/2023-08-goodentry-findings/issues/110` |
| Context-limited | PoolTogether fee-on-transfer finding | Medium, support-boundary dependent | FOT behavior only matters if token behavior is supported | `https://code4rena.com/reports/2022-04-pooltogether#m-02-fee-on-transfer-tokens-are-not-correctly-accounted-for` |
| Context-limited | PoolTogether rewards findings | Medium, trust and ownership dependent | Reward recipient control depends on product promise and trusted roles | `https://code4rena.com/reports/2022-04-pooltogether#m-03-owner-or-manager-can-steal-aave-rewards` |
| Context-limited | Index LTV-zero issue | Sherlock non-reward | Aave semantic observation requires forced impact and unavailable recovery | `https://github.com/sherlock-audit/2023-05-Index-judging/issues/90` |
| Context-limited | Index Isolation Mode issue | Sherlock excluded, non-reward | Forced mode/configuration argument not sufficient alone | `https://github.com/sherlock-audit/2023-05-Index-judging/issues/164` |
| Context-limited | Index eMode issue | Sherlock excluded, non-reward | Configured eMode incompatibility without sufficient exploit path | `https://github.com/sherlock-audit/2023-05-Index-judging/issues/95` |
| Context-limited | Grove ALM Controller | ChainSecurity acknowledged/informational style risk | LTV-zero withdrawal blocking had operational recovery context | `https://www.chainsecurity.com/security-audit/grove-alm-controller` |

## Fixed code and report anchors

Where a stable commit or scoped snapshot was publicly available, the links below use fixed commits or tags.

- DODO MarginTrading scoped snapshot: `https://github.com/sherlock-audit/2023-05-dodo/tree/1ba64de11b26172ae6b950dcc6109300449fe191`
- DODO `MarginTrading.sol`: `https://github.com/sherlock-audit/2023-05-dodo/blob/1ba64de11b26172ae6b950dcc6109300449fe191/dodo-margin-trading-contracts/contracts/marginTrading/MarginTrading.sol`
- Mimo `SuperVault.sol`: `https://github.com/code-423n4/2022-04-mimo/blob/b18670f44d595483df2c0f76d1c57a7bfbfbc083/supervaults/contracts/SuperVault.sol#L76-L99`
- PoolTogether `AaveV3YieldSource.sol`: `https://github.com/pooltogether/aave-v3-yield-source/blob/e63d1b0e396a5bce89f093630c282ca1c6627e44/contracts/AaveV3YieldSource.sol`
- GoodEntry `OptionsPositionManager.sol`: `https://github.com/code-423n4/2023-08-goodentry/blob/71c0c0eca8af957202ccdbf5ce2f2a514ffe2e24/contracts/PositionManager/OptionsPositionManager.sol`
- Connext fix commit: `https://github.com/connext/monorepo/commit/b99f9cf54b5d03029c6665776dc434d744758339`
- Aave v3 core commit used in StErMi's LTV-zero bug bounty writeup: `https://github.com/aave/aave-v3-core/blob/94e571f3a7465201881a59555314cd550ccfda57`
- Aave v4 repository: `https://github.com/aave/aave-v4`
- Aave v4 latest release referenced during research, `v0.5.11`, commit `cdacec5`: `https://github.com/aave/aave-v4/releases/tag/v0.5.11`

## Primary sources

- Aave v3 Tokenization: `https://aave.com/docs/aave-v3/smart-contracts/tokenization`
- Aave v3 Pool: `https://aave.com/docs/aave-v3/smart-contracts/pool`
- Aave v3 Flash Loans: `https://aave.com/docs/aave-v3/guides/flash-loans`
- Aave v4 Overview: `https://aave.com/docs/aave-v4`
- Aave v4 Hubs: `https://aave.com/docs/aave-v4/liquidity/hubs`
- Aave v4 Spokes: `https://aave.com/docs/aave-v4/liquidity/spokes`
- Aave v4 Positions: `https://aave.com/docs/aave-v4/positions`
- Aave v4 security update: `https://aave.com/blog/aave-v4-security-by-design`
- Aave v4 GitHub repository and audits: `https://github.com/aave/aave-v4`
- Sherlock judging criteria: `https://docs.sherlock.xyz/audits/judging/guidelines`
- DODO Sherlock finding #150: `https://github.com/sherlock-audit/2023-05-dodo-judging/issues/150`
- Mimo Code4rena report: `https://code4rena.com/reports/2022-04-mimo`
- Mimo finding issue #123: `https://github.com/code-423n4/2022-04-mimo-findings/issues/123`
- PoolTogether Code4rena report: `https://code4rena.com/reports/2022-04-pooltogether`
- Morpho-Aave v3 Spearbit report: `https://cdn.morpho.org/documents/Spearbit_04052023.pdf`
- StErMi LTV-zero aToken poison writeup: `https://stermi.medium.com/aave-v3-bug-bounty-part-3-ltv-0-atoken-poison-attack-4f2478558988`
- Connext Code4rena report: `https://code4rena.com/reports/2022-06-connext`
- Float Capital Code4rena report: `https://code4rena.com/reports/2021-08-floatcapital`
- Alchemix V3 Immunefi report #57812: `https://reports.immunefi.com/alchemix-v3/57812-sc-medium-no-function-to-claim-aave-incentives`
- Alchemix V3 Immunefi report #58080: `https://reports.immunefi.com/alchemix-v3/58080-sc-medium-aave-v3-strategies-fail-to-claim-op-arb-liquidity-mining-rewards-causing-permanent-l`
- GoodEntry Code4rena issue #110: `https://github.com/code-423n4/2023-08-goodentry-findings/issues/110`
- GoodEntry Code4rena issue #138: `https://github.com/code-423n4/2023-08-goodentry-findings/issues/138`
- Index Sherlock issue #90: `https://github.com/sherlock-audit/2023-05-Index-judging/issues/90`
- Index Sherlock issue #164: `https://github.com/sherlock-audit/2023-05-Index-judging/issues/164`
- Index Sherlock issue #95: `https://github.com/sherlock-audit/2023-05-Index-judging/issues/95`
- Grove ALM Controller ChainSecurity review: `https://www.chainsecurity.com/security-audit/grove-alm-controller`
