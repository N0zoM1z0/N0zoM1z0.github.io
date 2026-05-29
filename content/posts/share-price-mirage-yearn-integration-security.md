---
title: "The Share-Price Mirage: Yearn Integration Bugs, False Positives, and the Oracle We Keep Rebuilding"
date: "2026-05-29"
slug: "share-price-mirage-yearn-integration-security"
categories:
  - DeFi
  - Security Research
tags:
  - yearn
  - vaults
  - oracle
  - accounting
---

# The Share-Price Mirage: Yearn Integration Bugs, False Positives, and the Oracle We Keep Rebuilding

*PPS is not an oracle. Yield is not collateral. Composability is just dependency injection with money.*

## Source boundary

This post covers publicly verifiable Yearn-related integration issues: official incident disclosures, Code4rena reports and GitHub finding issues, Sherlock judging issues, public security write-ups, Yearn documentation, and ERC-4626 references. It intentionally treats private audits, closed bounty reports, and non-indexed commercial databases as outside the evidence boundary. In other words, this is a best-effort map of public knowledge, not a claim that every private or undisclosed case has been captured.

The focus is not whether Yearn itself was vulnerable. The more interesting and repeatable class is what happens when another protocol integrates yVaults, yvTokens, Yearn-style vault shares, or Yearn adapters and accidentally assumes stronger properties than Yearn provides.

The thesis is simple:

```text
A Yearn vault share is an accounting claim, not a price oracle.
A Yearn withdraw is a best-effort state transition, not a hard liquidity guarantee.
A Yearn adapter is a trust boundary, not a plumbing detail.
```

Most true positives are just different ways of violating one of those three lines.

---

## 1. The architecture that creates the attack surface

### 1.1 yVaults are share-accounting machines

A Yearn vault accepts an underlying asset, allocates that asset to one or more strategies, and mints ERC20 vault shares to depositors. The share token is commonly called a yvToken. A user who deposits DAI into a DAI vault receives yvDAI. The yvDAI balance is not a DAI balance. It is a pro-rata claim on the vault's accounted assets.

The core exchange-rate intuition is:

```text
assets_per_share = totalAssets / totalSupply
user_assets      = user_shares * assets_per_share
```

That formula looks harmless until a lending protocol, a wrapper, or an adapter starts treating it as a hard external price. The vault rate is part of the vault's internal accounting model. It answers, approximately, "how many underlying assets does this share represent according to this vault right now?" It does not answer, "what is the manipulation-resistant market price of this share token?"

Yearn V2 vaults also have multiple strategies, a withdrawal queue, and emergency shutdown behavior. When idle funds are insufficient, withdrawals pull liquidity from strategies in queue order. Yearn's own documentation describes the vault as holding the underlying token, connecting to strategies, maintaining a withdrawal queue, and supporting emergency shutdown.[^yearn-v2-vault] The same documentation is explicit about an important token assumption: underlying tokens should not change balances outside normal transfers, which excludes fee-on-transfer and rebasing tokens as supported underlyings.[^yearn-v2-token-assumption]

That matters for integrators. A vault share can be a perfectly reasonable ERC20 and still be a dangerous collateral primitive if the protocol consuming it does not preserve the vault's assumptions.

### 1.2 Yearn V2 integration is not just `deposit()` and `withdraw()`

The most fragile parts of V2-style integration are not the happy path calls. They are the semantics around those calls.

A typical integration has to answer several questions correctly:

```text
Is this number assets or shares?
Is this rate denominated in 1e18, asset decimals, or share decimals?
Does this withdraw allow losses?
What happens if only a partial withdrawal is possible?
Who receives unused shares?
Can the vault receive donated assets directly?
Can someone pass a fake yToken or fake underlying token?
```

A surprising number of real findings reduce to one of those questions being answered implicitly rather than explicitly.

### 1.3 ERC-4626 made the interface cleaner, not the risk smaller

Yearn V3 moved toward a more standardized ERC-4626 world: tokenized strategies, vaults, routers, registries, accountants, debt allocators, and limit modules.[^yearn-v3-overview] ERC-4626 is an improvement because it gives integrators a common vocabulary: `asset`, `totalAssets`, `convertToShares`, `convertToAssets`, `previewDeposit`, `previewRedeem`, `maxWithdraw`, and so on.

But standardization does not erase economic ambiguity. EIP-4626 deliberately distinguishes idealized conversion functions from preview functions, and it does not promise that a preview value is a manipulation-resistant oracle.[^eip-4626] OpenZeppelin's ERC-4626 documentation highlights the inflation attack class: an attacker seeds a low-liquidity vault, donates assets to skew the exchange rate, and causes later deposits to mint too few shares or zero shares due to rounding. The recommended defenses include virtual offsets and virtual assets/shares.[^oz-erc4626]

That is the key point: ERC-4626 gives us safer nouns. It does not make the nouns safe to use as oracle prices.

### 1.4 The dangerous design surface for external protocols

Yearn integrations tend to fail in five places:

| Surface | Common mistake | Why it matters |
|---|---|---|
| Collateral pricing | Use `pricePerShare`, `getPricePerFullShare`, or `convertToAssets` as an immediate borrow oracle | A donated asset or transient accounting state can inflate collateral value |
| Share math | Treat shares as underlying assets, or assets as shares | Withdrawals burn the wrong amount or transfer the wrong amount |
| Loss handling | Hard-code `maxLoss` too low or too high | Users can be stuck forever, or the adapter can accept catastrophic loss |
| Vault identity | Let users pass arbitrary vault, yToken, or underlying addresses | Fake contracts can spoof return values and steal real token balances |
| Precision and rounding | Assume 18 decimals, ignore rounding, or require exact transfers after approximate conversions | USDC-style vaults, tiny share supplies, or rounding deltas can break accounting |

The exploitability line is usually crossed when the mistake feeds into asset movement: minting, borrowing, redeeming, liquidating, or transferring funds out of a custodian contract.

---

## 2. True positives: when Yearn integration mistakes become real vulnerabilities

### 2.1 Cream Finance, 2021: the canonical PPS-as-oracle failure

The Cream exploit is the cleanest historical example because the core Yearn vault behavior was not the bug. The downstream interpretation was.

In October 2021, the attacker manipulated the Yearn yUSD vault's price per share by directly donating yCrv into the yUSD vault. Yearn's disclosure explains that vault shares are valued as `totalAssets / totalSupply`, and that directly sent tokens can increase the vault's price per share as a donation or airdrop. The yUSD price per share was pushed from roughly `1.000996` to `2.001993` during the exploit. Cream used that Yearn vault share rate to value yUSD collateral. The attack therefore doubled the perceived collateral value and allowed the attacker to borrow against an inflated number.[^yearn-cream-disclosure]

Cream's own post-mortem framed the incident as an oracle and economic exploit using flash liquidity across MakerDAO, Aave, Curve, Yearn, and Cream. Reported losses were around the $120 million to $130 million range, depending on accounting source and asset prices.[^cream-postmortem]

The vulnerable mental model looked like this:

```solidity
collateralValue = yvTokenBalance
    * yVault.pricePerShare()
    * underlyingUsdPrice;

borrowLimit = collateralValue * collateralFactor;
```

That formula is seductive because it is almost right for a dashboard. It is wrong for borrowing. It assumes that the share rate cannot be moved inside the transaction that creates the collateral position. Cream proved the opposite.

The more precise failure was this:

```text
Yearn PPS = accounting rate.
Cream consumed it as an oracle.
The attacker manipulated accounting state, not the external market price.
Cream lent against the manipulated state before it could normalize.
```

This is why the case remains the best mental model for yvToken collateral risk. A protocol can integrate Yearn correctly at the ERC20 level and still be insolvent at the economic level.

**Verdict: true positive, Critical.** The exploit path directly converted manipulated share accounting into borrowable value. The impact did not require Yearn to be broken.

**Commit or code reference.** The public exploit disclosures do not reduce to one vulnerable GitHub line in Cream's open code in the same way a contest finding does. The stable references are the Yearn security disclosure and Cream post-mortem.[^yearn-cream-disclosure][^cream-postmortem]

---

### 2.2 Popcorn M-04: reconstructing Yearn accounting from raw token balance

The Popcorn finding is smaller than Cream, but technically very pure. The adapter tried to compute Yearn vault assets using the underlying token balance held by the Yearn vault plus Yearn total debt:

```solidity
return IERC20(asset()).balanceOf(address(yVault)) + yVault.totalDebt();
```

The finding points out that Yearn's own accounting used tracked values, effectively `totalIdle + totalDebt`, not arbitrary raw ERC20 balance. A direct token transfer into the vault can make `IERC20(asset).balanceOf(yVault)` larger than the vault's tracked idle balance. The adapter therefore inflated `_yTotalAssets()` relative to Yearn's actual accounting.[^popcorn-m04]

The code path cited by the report is:

```text
src/vault/adapter/yearn/YearnAdapter.sol#L109-L111
commit d95fc31449c260901811196d617366d6352258cd
https://github.com/code-423n4/2023-01-popcorn/blob/d95fc31449c260901811196d617366d6352258cd/src/vault/adapter/yearn/YearnAdapter.sol#L109-L111
```

This is not just a local arithmetic bug. It is a boundary violation. The adapter looked inside the vault and rebuilt its accounting from a lower-level observable balance. That is dangerous because token balances are not always the same thing as vault-accounted assets. Direct transfers, donations, rescue flows, sweep logic, and vault-specific accounting decisions can all make raw balances misleading.

The deeper rule is:

```text
Never replace a vault's accounting API with `asset.balanceOf(vault)` unless the vault explicitly defines that as the accounting source.
```

For a strategy adapter, this is especially important because the adapter's share price, deposit accounting, or redemption accounting may compound the error. The bug becomes more severe if the inflated accounting value affects minting, redeeming, or collateral calculations.

**Verdict: true positive, Medium.** The finding was selected and sponsor-confirmed. It demonstrates a real accounting mismatch, but the public report frames it as a bounded integration bug rather than a direct protocol-draining path.[^popcorn-m04]

---

### 2.3 First depositor inflation: JPEG'd and Badger Citadel

First-depositor inflation is the quiet twin of the Cream attack. Cream manipulated an existing vault's share rate to overvalue collateral. First-depositor inflation manipulates a new or low-liquidity vault's share rate to steal deposits from later users.

The generic structure is:

```text
1. Attacker deposits a tiny amount and receives almost all initial shares.
2. Attacker donates a large amount directly to the vault.
3. Exchange rate becomes extremely high.
4. Victim deposits a normal amount.
5. Victim receives zero or far too few shares because of integer rounding.
6. Attacker withdraws and captures the donated assets plus victim assets.
```

#### JPEG'd H-01

The JPEG'd Code4rena report describes a high-risk issue where the first depositor can break minting of shares. The report links the issue to `yVault.sol#L148-L153` and explicitly compares the attack vector to the known Yearn audit finding often referenced as `TOB-YEARN-003`.[^jpegd-report][^jpegd-issue]

The public code path from the finding is:

```text
contracts/vaults/yVault/yVault.sol#L148-L153
https://github.com/code-423n4/2022-04-jpegd/blob/main/contracts/vaults/yVault/yVault.sol#L148-L153
```

The interesting part is not that JPEG'd was "using Yearn" in the adapter sense. It was using a Yearn-style vault accounting pattern. That distinction matters because the pattern has escaped its original context. The moment a protocol implements shares over assets with integer division and no minimum-share protection, it inherits the same class.

#### Badger Citadel H-03

Badger Citadel had the same shape. The public issue describes an attacker making the initial deposit, directly transferring assets to the staking contract, and causing later depositors to receive badly rounded shares. The issue was classified High because it could lead to direct principal loss, even though the strongest version required the vault to be new or low-liquidity.[^badger-citadel-report][^badger-citadel-issue]

The public code paths from the report include:

```text
src/StakedCitadel.sol#L293-L295
src/StakedCitadel.sol#L309-L311
src/StakedCitadel.sol#L764-L777
src/StakedCitadel.sol#L881-L892
https://github.com/code-423n4/2022-04-badger-citadel/blob/main/src/StakedCitadel.sol
```

The common false comfort is that "the attacker has to donate a lot." That is not a defense if the attacker can recover the donated value through withdrawal after victims deposit. Donation cost only matters after modeling the full loop.

A first-depositor finding is real when all of these are true:

```text
low initial supply or attacker can be first depositor
+ direct donation or totalAssets manipulation is possible
+ deposit uses floor division
+ no minSharesOut protection
+ no virtual shares/assets or dead shares
+ attacker can withdraw the inflated claim later
```

Remove one of those conditions and the finding may drop sharply in severity. Preserve them and the finding is not theoretical. It is a principal-loss bug.

**Verdict: true positive, High for JPEG'd and Badger Citadel.** These are not merely "rounding issues." They are share-supply initialization failures.

---

### 2.4 Swivel H-01: underlying amount passed where Yearn expects shares

The Swivel finding is the cleanest example of unit confusion. The report states that the protocol passed an amount of underlying to Yearn's `withdraw`, but the Yearn function parameter represented shares. When price per share is above 1, the adapter withdraws too little. When price per share is below 1, it can withdraw too much. The consequences include users being unable to redeem, excess assets becoming locked, or accounting falling out of sync.[^swivel-report]

The public report's vulnerable pattern can be summarized as:

```solidity
// Wrong mental model:
yVault.withdraw(underlyingAmount);

// Actual Yearn-style semantics in that path:
yVault.withdraw(shareAmount);
```

This bug looks banal. It is not. In vault systems, unit confusion is the local version of oracle confusion. The code compiles, the function name looks right, tests often pass while price per share is close to 1, and the exploit or failure appears only after yield accrues, loss occurs, or a rate moves.

The right integration posture is to name units aggressively:

```solidity
uint256 assetsRequested;
uint256 sharesToBurn;
uint256 assetsReceived;
```

Then assert with balance deltas:

```solidity
uint256 assetsBefore = asset.balanceOf(address(this));
uint256 sharesBefore = yVault.balanceOf(address(this));

uint256 sharesBurned = sharesBefore - yVault.balanceOf(address(this));
uint256 assetsReceived = asset.balanceOf(address(this)) - assetsBefore;
```

Do not trust a comment that says "amount". Prove the unit at the interface boundary.

**Verdict: true positive, High in the Code4rena report.** The finding demonstrates direct user redemption failure or asset misallocation once PPS diverges from 1.[^swivel-report]

---

### 2.5 Popcorn M-07 and Alchemix M-04: `maxLoss` is a risk parameter, not boilerplate

Yearn V2 withdrawals include a loss-tolerance concept. Integrators often discover it only after they have accidentally encoded a risk policy.

#### Too strict: Popcorn M-07

Popcorn's Yearn adapter called Yearn `withdraw` without passing a configurable `maxLoss`, causing Yearn's default loss threshold, around 0.01 percent, to apply. The finding argued that if a Yearn strategy loss exceeded that threshold, user `withdraw` and `redeem` paths would revert, preventing users from exiting.[^popcorn-m07]

The relevant code paths from the report include:

```text
src/vault/adapter/yearn/YearnAdapter.sol#L166-L172
commit d95fc31449c260901811196d617366d6352258cd
https://github.com/code-423n4/2023-01-popcorn/blob/d95fc31449c260901811196d617366d6352258cd/src/vault/adapter/yearn/YearnAdapter.sol#L166-L172

src/vault/adapter/abstracts/AdapterBase.sol#L210-L235
commit d95fc31449c260901811196d617366d6352258cd
https://github.com/code-423n4/2023-01-popcorn/blob/d95fc31449c260901811196d617366d6352258cd/src/vault/adapter/abstracts/AdapterBase.sol#L210-L235
```

The important nuance is that a low `maxLoss` sounds safer. It is safer only if users have another way to exit. If no emergency path exists, the safety check becomes a liveness failure. A user may rationally prefer to exit with a 0.5 percent realized loss rather than be trapped forever behind a hard-coded 0.01 percent threshold.

#### Too loose: Alchemix M-04

Alchemix had the opposite risk shape. The Yearn adapter used a maximum slippage or loss value of `10000`, effectively allowing 100 percent loss on Yearn withdrawal in the reported context. The Code4rena report classified this as Medium and recommended adding a real slippage check.[^alchemix-report]

The public code path is:

```text
contracts-full/adapters/yearn/YearnTokenAdapter.sol#L13
contracts-full/adapters/yearn/YearnTokenAdapter.sol#L43
commit de65c34c7b6e4e94662bf508e214dcbf327984f4
https://github.com/code-423n4/2022-05-alchemix/blob/de65c34c7b6e4e94662bf508e214dcbf327984f4/contracts-full/adapters/yearn/YearnTokenAdapter.sol#L13
https://github.com/code-423n4/2022-05-alchemix/blob/de65c34c7b6e4e94662bf508e214dcbf327984f4/contracts-full/adapters/yearn/YearnTokenAdapter.sol#L43
```

The contrast is useful:

```text
maxLoss too low  -> withdrawals can be permanently blocked
maxLoss too high -> withdrawals can accept catastrophic loss
```

A correct adapter does not hide this value. It treats loss tolerance as a protocol risk parameter or user slippage parameter, with upper bounds and emergency handling.

**Verdict: true positives, Medium.** These are not the same bug, but they share the same root: the adapter silently chose the user's risk policy.

---

### 2.6 Derby: partial withdrawals and unused shares

The Derby Sherlock issue is one of the best examples of why a Yearn adapter must handle partial execution. The reported `YearnProvider.withdraw()` transferred a full amount of yTokens from the vault to the provider, called Yearn withdraw, and then sent the withdrawn underlying back. The issue was that Yearn might use only part of the shares if only partial withdrawal is possible. The unused shares could remain stuck in the provider.[^derby-partial]

The public code path is:

```text
derby-yield-optimiser/contracts/Providers/YearnProvider.sol#L44-L66
https://github.com/sherlock-audit/2023-01-derby/blob/main/derby-yield-optimiser/contracts/Providers/YearnProvider.sol#L44-L66
```

The vulnerable pattern is:

```solidity
transferFrom(vault, provider, maxShares);
withdrawn = yVault.withdraw(maxShares);
transfer(underlying, vault, withdrawn);
// unused yVault shares are not returned or accounted
```

The adapter implicitly assumed:

```text
shares requested == shares burned
```

Yearn does not owe that invariant to a downstream adapter. If strategy liquidity is constrained or the vault can only fulfill part of the request, the adapter must account for actual shares burned and refund or re-record the rest.

A robust pattern looks like this:

```solidity
uint256 sharesBefore = yVault.balanceOf(address(this));
uint256 assetsBefore = asset.balanceOf(address(this));

uint256 assetsReceived = yVault.withdraw(maxShares);

uint256 sharesAfter = yVault.balanceOf(address(this));
uint256 assetsAfter = asset.balanceOf(address(this));

uint256 sharesBurned = sharesBefore - sharesAfter;
uint256 actualAssetsReceived = assetsAfter - assetsBefore;
uint256 unusedShares = maxShares - sharesBurned;

if (unusedShares != 0) {
    yVault.transfer(accountingOwner, unusedShares);
}
require(actualAssetsReceived >= minAssetsOut, "INSUFFICIENT_ASSETS");
```

The exact interface differs by Yearn version, but the invariant does not: settle on actual deltas, not expected inputs.

**Verdict: true positive, High.** The Sherlock issue was sponsor-confirmed and marked for fix. The impact is frozen user value, not merely a display error.[^derby-partial]

---

### 2.7 Derby again: user-supplied yToken and underlying token pairs

Derby's more severe adapter issue was not subtle math. It was trust boundary collapse.

The provider accepted both `_uToken` and `_yToken` as parameters. Sherlock reports showed that an attacker could pass fake token contracts or fake yToken contracts to manipulate balance checks and returned values, then cause the provider to move real underlying assets or yTokens in unintended ways.[^derby-fake-deposit][^derby-fake-withdraw]

The public code paths are:

```text
Deposit path:
derby-yield-optimiser/contracts/Providers/YearnProvider.sol#L19-L36
https://github.com/sherlock-audit/2023-01-derby/blob/main/derby-yield-optimiser/contracts/Providers/YearnProvider.sol#L19-L36

Withdraw path:
derby-yield-optimiser/contracts/Providers/YearnProvider.sol#L44-L66
https://github.com/sherlock-audit/2023-01-derby/blob/main/derby-yield-optimiser/contracts/Providers/YearnProvider.sol#L44-L66
```

The invariant that should have existed is:

```solidity
require(approvedVault[yToken], "UNAPPROVED_VAULT");
require(vaultAsset[yToken] == uToken, "ASSET_MISMATCH");
```

Or in ERC-4626 terms:

```solidity
require(IERC4626(vault).asset() == expectedAsset, "BAD_ASSET");
require(vault == approvedVaultFor[expectedAsset], "BAD_VAULT");
```

The dangerous argument against this finding is, "The provider should not hold balances anyway." That is not a security argument. Contracts receive dust, mistaken transfers, reward tokens, rescue balances, partial withdrawals, and transient balances all the time. If an untrusted caller can choose the accounting lens through which a contract sees its own balance, any residual balance becomes attack surface.

**Verdict: true positives, High.** These findings are not "Yearn-specific" in the narrow sense, but they are exactly the kind of bug Yearn adapters create when vault identity is treated as user input instead of configuration.

---

### 2.8 Sublime H-04: decimals are part of the security model

Sublime's Yearn strategy converted Yearn shares to underlying tokens with:

```solidity
amount = pricePerFullShare * shares / 1e18;
```

The finding notes that Yearn's `getPricePerFullShare` is in vault-decimal precision, and Yearn vault decimals track the underlying token decimals. For non-18-decimal assets such as USDC or USDT, dividing by `1e18` is wrong. The impact is that too much or too little may be paid out, causing loss to users or the protocol.[^sublime-issue]

The public commit-pinned code path is:

```text
contracts/yield/YearnYield.sol
commit 9df1b7c4247f8631647c7627a8da9bdc16db8b11
https://github.com/code-423n4/2021-12-sublime/blob/9df1b7c4247f8631647c7627a8da9bdc16db8b11/contracts/yield/YearnYield.sol
```

This bug is a useful reminder that decimals are not UI metadata. They are part of the exchange-rate denominator. If a vault share rate is denominated in `10 ** vault.decimals()` and the adapter normalizes it with `1e18`, the adapter silently changes the value of every share.

The right pattern is not merely:

```solidity
amount = pricePerShare * shares / 10 ** vault.decimals();
```

It is also:

```solidity
assertKnownDecimals(asset, vault);
normalizeAtBoundaries(assetDecimals, shareDecimals, oracleDecimals);
```

When the result influences lending, redemption, or debt accounting, a decimals bug is a funds bug.

**Verdict: true positive, High in the GitHub issue labels and Code4rena report.** The sponsor confirmed the problem.[^sublime-issue]

---

### 2.9 PoolTogether and Alchemix: approval bugs are not glamorous, but they brick adapters

A Yearn adapter often has to approve the underlying asset to the Yearn vault before depositing. That sounds harmless until the token is USDT-like or until a vault cap causes a partial deposit, leaving non-zero allowance behind.

#### PoolTogether M-01

The PoolTogether Yearn V2 yield source used OpenZeppelin `safeApprove()` to approve deposits into Yearn. The finding notes that changing a non-zero allowance to another non-zero allowance can revert. If the Yearn vault could not accept the full amount because of a deposit limit, a leftover allowance could remain and future deposits could be blocked.[^pooltogether-m01]

The commit-pinned code path is:

```text
contracts/yield-source/YearnV2YieldSource.sol#L171-L173
commit 85f8d044e7e46b7a3c64465dcd5dffa9d70e4a3e
https://github.com/code-423n4/2021-06-pooltogether/blob/85f8d044e7e46b7a3c64465dcd5dffa9d70e4a3e/contracts/yield-source/YearnV2YieldSource.sol#L171-L173
```

#### Alchemix issue #99

Alchemix had a similar issue in its Yearn adapter. The finding explains that if a Yearn vault accepts only part of a deposit, leftover approval can cause later `safeApprove` calls to revert for tokens that do not allow non-zero to non-zero approval changes.[^alchemix-approve]

The relevant code path is:

```text
contracts-full/adapters/yearn/YearnTokenAdapter.sol#L32
commit de65c34c7b6e4e94662bf508e214dcbf327984f4
https://github.com/code-423n4/2022-05-alchemix/blob/de65c34c7b6e4e94662bf508e214dcbf327984f4/contracts-full/adapters/yearn/YearnTokenAdapter.sol#L32
```

The mitigation is boring and correct:

```solidity
asset.safeApprove(vault, 0);
asset.safeApprove(vault, amount);
```

or a modern `forceApprove` equivalent.

**Verdict: true positives, Medium.** These are availability bugs, not direct theft bugs. But for a yield source, unavailable deposits or wraps can be protocol-critical.

---

### 2.10 Mellow H-01: rounding becomes severe when exact transfer is required

Mellow's YearnVault issue is a good severity lesson. The code calculated the amount of yTokens needed for a target underlying withdrawal using integer division:

```solidity
yTokenAmount = tokenAmount * decimals / pricePerShare;
```

Because division rounds down, the actual withdrawn amount could be slightly less than requested. The function then returned the original requested `tokenAmounts` instead of the actual received amount. Downstream, another contract attempted to transfer the requested amount and could revert because the contract had received slightly less.[^mellow-report]

The commit-pinned code path from the report is:

```text
mellow-vaults/test_brownie/contracts/YearnVault.sol#L84-L101
commit 6679e2dd118b33481ee81ad013ece4ea723327b5
https://github.com/code-423n4/2021-12-mellow/blob/6679e2dd118b33481ee81ad013ece4ea723327b5/mellow-vaults/test_brownie/contracts/YearnVault.sol#L84-L101
```

The sponsor argued the difference might be only a few wei. That may be true for some states. But this is the exact place where "only dust" can become real: a later exact transfer does not care whether the missing amount is one wei or one token. If the operation requires exact settlement, the whole withdrawal can fail.

A useful severity rule:

```text
Rounding error that changes a displayed number: usually Low.
Rounding error that changes a transfer amount: maybe Medium.
Rounding error that causes exit failure or can be accumulated: often High or Medium.
```

**Verdict: true positive with nuanced severity.** The technical bug is real. The economic severity depends on whether the rounding delta only creates dust or blocks an important withdrawal path.

---

### 2.11 MAI/QiDAO Yearn Curve stETH vaults: not a yVault PPS bug, still a Yearn-adjacent integration lesson

Amber Group disclosed a critical oracle manipulation vulnerability affecting two MAI vaults associated with Curve stETH collateral, including a Yearn Curve stETH Ethereum MAI vault naming context. The attack involved Curve read-only reentrancy style manipulation of collateral pricing, allowing an attacker to borrow against an inflated collateral value and potentially leave bad debt.[^amber-mai]

ChainSecurity's post-mortem on Curve LP oracle manipulation explains the broader issue: protocols consuming Curve LP virtual price could be affected by read-only reentrancy if they read a temporarily inconsistent pool state.[^chainsecurity-curve]

This is not the same class as Cream's yUSD PPS manipulation. The source of manipulated value was Curve LP pricing, not simply Yearn's vault share accounting. But the integration lesson is the same:

```text
A yvToken wrapper can inherit oracle risk from the asset beneath it.
A protocol that says "we accept Yearn Curve stETH collateral" is also accepting Curve LP oracle semantics.
```

That is why Yearn integrations cannot be audited as single-hop dependencies. The real dependency graph often looks like:

```text
lending market
  -> yvToken collateral
      -> Yearn vault accounting
          -> strategy asset
              -> Curve LP token
                  -> pool virtual price
                      -> stETH/ETH market state
```

If any layer is consumed as a hard price oracle, the whole stack inherits the weakest oracle.

**Verdict: true positive as a collateral-oracle vulnerability, but not a direct Yearn vault bug.** It belongs in a Yearn integration study because external protocols often expose users to the full nested stack, not just to Yearn's immediate interface.

---

### 2.12 Legacy Yearn and product-specific incidents: allowlists must encode version and product type

Two later public incidents reinforce a deployment lesson rather than a new adapter pattern.

Yearn's 2025 yETH disclosure states that the yETH weighted stableswap pool was exploited while Yearn V2 and V3 vaults and other Yearn products were not affected. The impact was isolated to the yETH product and direct integrators.[^yearn-yeth-2025] Check Point's analysis described a numerical edge-case exploit that allowed extreme yETH minting from a tiny input.[^checkpoint-yeth]

A separate 2025 investigation by banteg described a legacy iEarn TUSD issue involving a misconfigured lending adapter and fragile share-minting logic, again emphasizing that immutable legacy products differ sharply from modern Yearn vaults.[^banteg-iearn-2025]

The integration takeaway is straightforward:

```text
"Yearn" is not a single risk profile.
A modern V3 ERC-4626 vault, a V2 yVault, a legacy iEarn product, and a custom stableswap pool are different systems.
```

An allowlist that records only a token symbol or a brand name is not an allowlist. A serious integration allowlist should encode:

```text
chain
vault address
vault version or product type
asset address
asset decimals
share decimals
expected API surface
oracle policy
deposit and withdrawal limits
emergency controls
accepted collateral factor
```

**Verdict: boundary true positives for integration risk.** These incidents do not prove that every Yearn-branded product is unsafe. They prove that integrators must not treat brand identity as a substitute for contract-specific risk review.

---

## 3. False positives, low findings, and why the distinction matters

Good security research is not just finding patterns. It is proving when the pattern crosses into exploitable state. The Yearn integration space has many findings that name a real class but do not prove a real exploit in context.

### 3.1 Derby issue #219: the right warning, the wrong proof

A Sherlock Derby report argued that `YearnProvider.withdraw()` used amount where Yearn expected shares. This sounds close to Swivel H-01, and the report even referenced the Swivel finding. But the issue was marked Non-Reward and Sponsor Disputed.[^derby-nonreward-shares]

The key difference is proof.

Swivel established that the protocol path actually passed an underlying amount into a shares-denominated Yearn withdraw. In Derby issue #219, the report relied heavily on naming and comments, but did not demonstrate that the actual call flow supplied underlying assets rather than yToken shares. In the same Derby contest, other YearnProvider findings were valid and high severity: partial withdrawal accounting and arbitrary yToken/uToken parameters. The shares-vs-assets report failed not because the class is fake, but because the class was not proven in that code path.

The judging lesson is sharp:

```text
"Yearn withdraw uses shares" is background knowledge.
"This adapter passes assets as shares and loses funds here" is a vulnerability.
```

False positives often stop at the first sentence.

**Verdict: false positive or non-reward in that contest context.** It is still a useful audit prompt, but not a proven finding.

---

### 3.2 Aloe issue #4: ERC-4626 inflation is real, but pattern matching is not enough

A Sherlock Aloe report described a first-depositor ERC-4626 price-per-share manipulation attack. The issue was marked Excluded and Non-Reward.[^aloe-nonreward]

This should not be read as "first-depositor inflation is invalid." JPEG'd and Badger Citadel show the opposite. The better reading is that ERC-4626 inflation requires specific preconditions:

```text
attacker controls first or low-liquidity deposit
+ attacker can manipulate totalAssets through donation or equivalent state
+ victim deposit has no minSharesOut or meaningful slippage protection
+ rounding loss is material
+ attacker can redeem the manipulated claim profitably
```

A report that says "this is ERC-4626, so first depositor attack" has not done the work. It needs to model actual initialization, existing supply, virtual offsets, dead shares, deposit caps, routers, slippage checks, and profit extraction.

The contrast with JPEG'd and Badger is the core lesson. Same pattern, different proof quality. One becomes High. One becomes Non-Reward.

**Verdict: non-reward, not a disproof of the class.** It is a warning against vulnerability cargo-culting.

---

### 3.3 PoolTogether issue #69: high `maxLoss` as an owner parameter is not automatically high severity

A PoolTogether finding argued that the Yearn V2 yield source owner could set `maxLosses` as high as `9999`, close to 100 percent. The issue was labeled Low and sponsor-acknowledged.[^pooltogether-maxloss-low]

At first glance this resembles Alchemix M-04. The difference is context.

In Alchemix, the adapter hard-coded a loss tolerance in a user-facing unwrap path. In PoolTogether, the value was an owner-controlled protocol parameter, and the report framed the impact around interest and prize consequences rather than a permissionless attacker stealing principal through the adapter.

Owner-controlled risk parameters can still be dangerous. But contests usually distinguish between:

```text
permissionless exploit of user funds
```

and:

```text
trusted governance or owner can choose a risky parameter
```

The second may be valid as a risk note, but it is often Low unless governance trust assumptions are broken or the parameter can be manipulated by an attacker.

**Verdict: valid low risk, not a high-severity Yearn exploit.** The same keyword, `maxLoss`, does not imply the same severity.

---

### 3.4 PoolTogether issue #70: ignored return values without a loss path

Another PoolTogether issue noted that `_depositInVault()` returns the number of shares received from Yearn, but the return value was ignored. The finding was labeled Low and sponsor-disputed.[^pooltogether-return-low]

This is a classic example of an audit smell that may or may not be a vulnerability. Ignoring a return value is suspicious when the caller needs that value to update accounting. But if the caller's accounting is based elsewhere, or if the return value is not required for any invariant, the report needs to show a concrete mismatch.

The difference is:

```text
"The return value is ignored" -> code smell.
"The ignored return value causes the protocol to overcredit shares here" -> vulnerability.
```

Without the second sentence, the finding is usually Low or informational.

**Verdict: low or disputed.** Useful review signal, insufficient exploit proof on its own.

---

### 3.5 Nested QA: zero-address checks in YearnCurveVaultOperator

A Nested Code4rena QA issue noted that immutable addresses in `YearnCurveVaultOperator` should be zero-checked.[^nested-qa]

This is valid engineering hygiene. It is not a Yearn economic vulnerability. Constructor zero-address checks prevent broken deployments and confusing failures, but they rarely imply permissionless fund loss unless a deployment process can be externally influenced or an invalid address creates a later drain path.

**Verdict: valid QA, not a security-critical Yearn integration issue.** It belongs in a checklist, not in a Critical findings deck.

---

### 3.6 The general false-positive pattern

Across the low and invalid examples, the failure mode is usually one of these:

```text
The report identifies a real Yearn hazard but does not connect it to asset movement.
The report assumes the wrong unit without proving the call flow.
The report ignores protocol-specific mitigations such as allowlists, minOuts, virtual shares, or seeded supply.
The report treats governance-controlled configuration as a permissionless exploit.
The report describes a UI or accounting smell without a concrete loss, lock, or insolvency path.
```

That does not make the ideas useless. Many good high-severity findings start as a smell. But the final report must cross the bridge from pattern to exploit.

---

## 4. A practical severity model for Yearn integration findings

The fastest way to triage a Yearn-related finding is to ask what the protocol does with the Yearn-derived value.

### 4.1 Critical or High: the value gates borrowing, minting, redeeming, or liquidation

A finding tends to be severe when the wrong Yearn assumption directly controls value leaving the system.

Examples:

```text
PPS controls collateral value and borrow limit.
Share conversion controls minted vault shares.
Withdraw accounting controls user redemption.
Fake yToken parameters control real token transfers.
Decimals error controls payout amount.
```

Cream, Derby's fake token issues, Swivel, Sublime, JPEG'd, and Badger are in this zone.

### 4.2 Medium: user funds can be stuck or core functionality can be bricked

Medium is common when the bug causes liveness failure rather than clean theft.

Examples:

```text
maxLoss too strict blocks withdrawals after real Yearn loss.
safeApprove blocks future deposits after partial acceptance.
rounding causes exact-transfer exit failure.
```

Popcorn M-07, PoolTogether M-01, Alchemix approval issue, and Mellow's exact-transfer issue fit here.

### 4.3 Low or Informational: the issue is real but the impact path is weak

Low or informational is appropriate when:

```text
The value is used for UI or analytics only.
The parameter is owner-controlled under stated trust assumptions.
The code smell has no demonstrated accounting consequence.
The affected deployment is impossible under the protocol's allowlist.
The rounding error is bounded dust and cannot block execution or be accumulated.
```

PoolTogether's ignored return value and Nested's zero-address QA issue are good examples.

### 4.4 Invalid or Non-Reward: the report proves a class, not this instance

Invalid findings often contain true statements. The problem is that the true statement is too general.

```text
"Yearn withdraw uses shares."
True, but did this path pass assets?

"ERC-4626 vaults can be inflation-attacked."
True, but is this vault unseeded, unprotected, and profitable to attack?

"pricePerShare can change."
True, but does the protocol use it as an oracle in a permissionless value-moving path?
```

Security work is not keyword matching. The invariant must break in the deployed system.

---

## 5. The deeper invariant: Yearn turns time and strategy state into a token

The philosophical mistake is treating yvTokens as normal ERC20s because they implement ERC20 methods.

A plain ERC20 balance is usually a quantity of the asset itself. A yvToken balance is a quantity of claims over a moving pool of assets. That pool may include idle funds, strategy debt, unrealized losses, pending reports, withdrawal queues, external liquidity constraints, and direct donations. The yvToken compresses all of that into one transferable number.

That compression is the magic of Yearn. It is also the risk.

For a wallet UI, the compression is convenient:

```text
balanceOf(user) * pricePerShare ~= displayed underlying value
```

For a lending market, the compression can be fatal:

```text
balanceOf(user) * pricePerShare = borrowable value
```

The same calculation changes risk class depending on what the result is allowed to do.

This is the point many low-quality findings miss and many real exploits exploit. The bug is not always the formula. The bug is the authority given to the formula.

---

## 6. Defensive patterns that actually address the root causes

### 6.1 Treat vault identity as configuration, never user input

A Yearn adapter should not accept arbitrary vault and asset pairs from users. At minimum:

```solidity
struct VaultConfig {
    address vault;
    address asset;
    uint8 assetDecimals;
    uint8 shareDecimals;
    bool enabled;
}

mapping(address => VaultConfig) public configByVault;
mapping(address => address) public approvedVaultForAsset;

function _checkVault(address vault, address asset) internal view {
    VaultConfig memory cfg = configByVault[vault];
    require(cfg.enabled, "VAULT_NOT_APPROVED");
    require(cfg.asset == asset, "ASSET_MISMATCH");
}
```

For ERC-4626 vaults, verify `IERC4626(vault).asset()`. For Yearn V2-style vaults, verify the equivalent token or underlying getter for that specific interface.

The rule is simple:

```text
Users can choose amounts.
Governance or risk managers choose vaults.
```

### 6.2 Never use raw vault balances as total assets unless the vault defines it that way

Popcorn M-04 exists because the adapter used:

```solidity
asset.balanceOf(address(vault)) + totalDebt
```

instead of respecting Yearn's tracked accounting.

A direct donation should not necessarily become protocol accounting. If a vault deliberately treats donations as yield, that should be part of the risk model. But an external adapter should not accidentally include balances the vault itself excludes.

### 6.3 Do not use instantaneous PPS as a lending oracle

For yvToken collateral, a robust design needs more than `pricePerShare`.

Possible controls include:

```text
rate-change caps per block or per time window
TWAP or delayed rate adoption
donation and raw-balance discrepancy checks
collateral supply caps
non-borrowable collateral shares
conservative collateral factors
pause-on-rate-jump logic
separate underlying price oracle
manual risk review per vault and strategy stack
```

The minimum safe mental model is:

```text
underlying price oracle != vault share accounting rate
```

Both must be hardened. The final collateral price is only as strong as the weaker component.

### 6.4 Every deposit path needs `minSharesOut`

For share vaults, slippage is not just AMM slippage. It is also rounding and exchange-rate slippage.

```solidity
function depositToVault(uint256 assets, uint256 minSharesOut) external {
    uint256 shares = vault.deposit(assets, address(this));
    require(shares >= minSharesOut, "MIN_SHARES");
}
```

If a protocol deposits on behalf of users, the protocol should derive a conservative `minSharesOut` from a trusted quote or let the user provide it. `previewDeposit` is a useful quote. It is not a substitute for a post-condition.

### 6.5 Every withdrawal path needs `minAssetsOut` and actual-delta accounting

Withdrawals should settle on observed deltas:

```solidity
uint256 assetsBefore = asset.balanceOf(address(this));
uint256 sharesBefore = share.balanceOf(address(this));

vault.withdraw(...);

uint256 assetsReceived = asset.balanceOf(address(this)) - assetsBefore;
uint256 sharesSpent = sharesBefore - share.balanceOf(address(this));

require(assetsReceived >= minAssetsOut, "MIN_ASSETS");
```

If unused shares remain, return them or explicitly account for them. Never assume `shares requested == shares burned` unless the interface guarantees it and tests enforce it against the real vault implementation.

### 6.6 `maxLoss` needs a policy, not a magic number

A good Yearn adapter exposes loss tolerance through a constrained policy:

```solidity
function withdraw(uint256 shares, uint256 minAssetsOut, uint256 maxLossBps) external {
    require(maxLossBps <= protocolMaxLossBps, "LOSS_TOO_HIGH");
    uint256 assets = yVault.withdraw(shares, address(this), maxLossBps);
    require(assets >= minAssetsOut, "MIN_ASSETS");
}
```

There should also be an emergency mode. If the normal path blocks because Yearn has realized a loss, users may need to choose between accepting the loss and waiting. Hard-coding that choice into the adapter is poor risk design.

### 6.7 Normalize decimals at every boundary

Do not assume 18 decimals. Record and assert:

```solidity
uint8 assetDecimals = IERC20Metadata(asset).decimals();
uint8 shareDecimals = IERC20Metadata(vault).decimals();
```

Then normalize intentionally:

```solidity
assets = shares * pricePerShare / (10 ** shareDecimals);
```

For lending, also include oracle decimals. Many serious value bugs are just three decimal systems pretending to be one.

### 6.8 Use force approve patterns

Approval code should tolerate USDT-like behavior and partial deposit leftovers:

```solidity
asset.safeApprove(vault, 0);
asset.safeApprove(vault, amount);
```

or:

```solidity
asset.forceApprove(vault, amount);
```

This will not win style points, but it prevents real deposit failures.

### 6.9 Fork tests should be adversarial, not only happy-path

A Yearn integration test suite should include:

```text
Direct donation into the Yearn vault before deposit, borrow, or redeem.
First depositor deposits 1 wei, then donates assets, then victim deposits.
USDC or USDT decimal vaults.
Yearn strategy loss greater than the default loss threshold.
Partial withdrawal where idle liquidity is insufficient.
Deposit cap or partial deposit leaving allowance behind.
Fake yToken and fake underlying token parameters.
Residual balances in the adapter before attacker calls deposit or withdraw.
Emergency shutdown or paused deposits.
State change between preview and actual deposit/redeem.
```

The point is not to prove Yearn is malicious. The point is to prove the adapter does not require Yearn to be more deterministic than it actually is.

---

## 7. Case matrix

| Case | Public verdict | True/false bucket | Core bug | Practical lesson |
|---|---:|---|---|---|
| Cream yUSD, 2021 | Exploited, Critical-scale loss | True positive | Yearn PPS consumed as collateral oracle | Accounting rate is not borrow oracle |
| Popcorn M-04 | Medium, sponsor-confirmed | True positive | Adapter used raw vault token balance instead of Yearn tracked accounting | Do not reconstruct vault accounting from ERC20 balance |
| JPEG'd H-01 | High | True positive | First depositor donation and rounding attack | New share vaults need virtual shares, dead shares, or min shares |
| Badger Citadel H-03 | High | True positive | First depositor manipulates share denominator | Strict preconditions do not make it invalid if the profit loop closes |
| Swivel H-01 | High | True positive | Underlying amount passed to shares-denominated Yearn withdraw | Name and assert units |
| Popcorn M-07 | Medium | True positive | Default `maxLoss` too strict, withdrawals can revert | Safety threshold can become a lock |
| Alchemix M-04 | Medium | True positive | `maxLoss` effectively 100 percent | Loss threshold can become a value leak |
| Derby partial withdrawal | High, sponsor-confirmed | True positive | Unused shares stuck after partial Yearn withdrawal | Settle by actual deltas and refund unused shares |
| Derby fake yToken/uToken | High, sponsor-confirmed | True positive | User-controlled vault and asset identity | Vault pairs must be allowlisted |
| Sublime H-04 | High, sponsor-confirmed | True positive | Assumed 1e18 precision for Yearn share conversion | Decimals are security-critical |
| PoolTogether M-01 | Medium, sponsor-confirmed | True positive | `safeApprove` DoS after leftover allowance | Use force approve or zero-first approve |
| Alchemix issue #99 | Medium, sponsor-confirmed | True positive | Same approval class with Yearn cap/partial deposit | Weird ERC20 behavior is adapter risk |
| Mellow H-01 | High in report, severity nuanced | True positive | Rounding down then exact transfer | Dust can brick exits when exact transfer is required |
| MAI/QiDAO Curve stETH vaults | Critical fixed before exploit | Boundary true positive | Curve LP oracle manipulation in nested collateral | Yearn integrations inherit lower-layer oracle risks |
| Derby issue #219 | Non-Reward, sponsor-disputed | False/non-reward | Shares-vs-assets asserted but not proven in flow | A correct pattern still needs instance proof |
| Aloe issue #4 | Excluded, Non-Reward | False/non-reward | Generic ERC-4626 inflation claim | Pattern matching is not exploit proof |
| PoolTogether issue #69 | Low | Low | Owner can set high `maxLoss` | Governance-risk parameter != permissionless exploit |
| PoolTogether issue #70 | Low, sponsor-disputed | Low/disputed | Ignored Yearn deposit return value | Code smell needs accounting impact |
| Nested QA issue | QA | Informational | Zero-address checks | Deployment hygiene, not Yearn economic failure |

---

## 8. The audit questions that find most of these bugs

When reviewing a Yearn integration, these questions are worth asking before reading the rest of the codebase:

### 8.1 Does any Yearn-derived number decide how much external value leaves the protocol?

Search for:

```text
pricePerShare
getPricePerFullShare
convertToAssets
convertToShares
previewDeposit
previewRedeem
totalAssets
balanceOf(vault)
```

Then follow the value into:

```text
borrow limit
mint amount
redeem amount
liquidation amount
collateral valuation
share issuance
user transfer
```

If the path ends in UI, it is probably not severe. If it ends in `transfer`, `mint`, `borrow`, or `liquidate`, it deserves serious modeling.

### 8.2 Can an attacker change the value in the same transaction?

Donation is the obvious method, but not the only one.

```text
direct asset transfer
flash-loaned deposit or withdrawal
strategy report timing
Curve virtual price manipulation
read-only reentrancy
low-supply exchange-rate skew
fee-on-transfer or rebasing behavior
```

The Cream class exists because same-transaction state was accepted as truth.

### 8.3 Does the adapter know the difference between shares and assets?

Look for variables named only `amount`. Replace them mentally:

```text
amountAssets
amountShares
sharesIn
assetsOut
sharesBurned
assetsReceived
```

If the code becomes confusing after this rename, the adapter is probably confusing too.

### 8.4 What happens when Yearn gives less than requested?

This includes:

```text
strategy loss
withdrawal queue constraints
partial withdrawal
rounding down
maxLoss revert
emergency shutdown
deposit cap
```

Correct code has post-conditions. Weak code has expectations.

### 8.5 Who chose the vault?

If the user chose the vault or yToken address, assume the user chose a malicious contract until proven otherwise.

---

## 9. Closing view: the real bug is over-trusting composability

Yearn is one of DeFi's most important abstractions because it packages strategy execution into transferable vault shares. That abstraction is powerful. It lets wallets display yield-bearing balances, protocols compose with automated strategies, and users move yield positions like normal tokens.

But every abstraction hides state. In Yearn's case, the hidden state includes strategy debt, idle liquidity, reports, losses, vault accounting, withdrawal queues, token assumptions, and sometimes nested protocol pricing. The yvToken is the handle to that state. It is not the state itself.

Most severe Yearn integration bugs happen when an external protocol forgets that distinction:

```text
It prices the handle as if it were an oracle.
It withdraws through the handle as if liquidity were guaranteed.
It transfers the handle as if it had the same decimals and semantics as the underlying asset.
It accepts a user-provided handle as if it were an approved vault.
```

The false positives happen one layer earlier. They identify that the handle might be dangerous, but they do not show that this protocol gives it dangerous authority.

That is the line worth keeping. The best Yearn findings are not the ones that say "Yearn has PPS." They are the ones that show exactly where PPS, shares, decimals, loss tolerance, or vault identity crosses into value transfer.

Yield is composable. Risk is composable too. The auditor's job is to find the place where somebody forgot the second half.

---

## References

[^yearn-v2-vault]: Yearn documentation, "V2 Vault", https://docs.yearn.fi/developers/smart-contracts/V2/vault

[^yearn-v2-token-assumption]: Yearn documentation, "V2 Vault", token assumptions in initialization docs, https://docs.yearn.fi/developers/smart-contracts/V2/vault

[^yearn-v3-overview]: Yearn documentation, "Yearn V3 Overview", https://docs.yearn.fi/developers/v3/overview

[^eip-4626]: EIP-4626, "Tokenized Vault Standard", https://eips.ethereum.org/EIPS/eip-4626

[^oz-erc4626]: OpenZeppelin Contracts documentation, "ERC-4626", https://docs.openzeppelin.com/contracts/5.x/erc4626

[^yearn-cream-disclosure]: Yearn Security disclosure, "Cream Finance exploit", 2021-10-27, https://github.com/yearn/yearn-security/blob/master/disclosures/2021-10-27.md

[^cream-postmortem]: C.R.E.A.M. Finance, "C.R.E.A.M. Finance Post Mortem: Flash Loan Exploit, Oct 27", https://medium.com/cream-finance/c-r-e-a-m-finance-post-mortem-flash-loan-exploit-oct-27-507b12bb6f8e

[^popcorn-m04]: Code4rena Popcorn finding issue #728, "Yearn Vault totalAssets is calculated incorrectly in YearnAdapter", https://github.com/code-423n4/2023-01-popcorn-findings/issues/728

[^popcorn-m07]: Code4rena Popcorn finding issue #581, "YearnAdapter does not allow to inject maxLoss", https://github.com/code-423n4/2023-01-popcorn-findings/issues/581

[^jpegd-report]: Code4rena, "JPEG'd contest Findings & Analysis Report", https://code4rena.com/reports/2022-04-jpegd

[^jpegd-issue]: Code4rena JPEG'd finding issue #12, "First depositor can break minting of shares", https://github.com/code-423n4/2022-04-jpegd-findings/issues/12

[^badger-citadel-report]: Code4rena, "Badger Citadel contest Findings & Analysis Report", https://code4rena.com/reports/2022-04-badger-citadel

[^badger-citadel-issue]: Code4rena Badger Citadel finding issue #217, "StakedCitadel first depositor can manipulate exchange rate", https://github.com/code-423n4/2022-04-badger-citadel-findings/issues/217

[^swivel-report]: Code4rena, "Swivel contest Findings & Analysis Report", H-01, https://code4rena.com/reports/2022-07-swivel

[^alchemix-report]: Code4rena, "Alchemix contest Findings & Analysis Report", M-04, https://code4rena.com/reports/2022-05-alchemix

[^alchemix-approve]: Code4rena Alchemix finding issue #99, "YearnTokenAdapter.wrap() can revert due to non-zero to non-zero approval", https://github.com/code-423n4/2022-05-alchemix-findings/issues/99

[^derby-partial]: Sherlock Derby judging issue #355, "YearnProvider does not account for partial withdrawal", https://github.com/sherlock-audit/2023-01-derby-judging/issues/355

[^derby-fake-deposit]: Sherlock Derby judging issue #411, "Provider accepts underlying and yield token from user", https://github.com/sherlock-audit/2023-01-derby-judging/issues/411

[^derby-fake-withdraw]: Sherlock Derby judging issue #359, "Malicious yToken can drain underlying balances", https://github.com/sherlock-audit/2023-01-derby-judging/issues/359

[^sublime-issue]: Code4rena Sublime finding issue #134, "Yearn token <> shares conversion decimal issue", https://github.com/code-423n4/2021-12-sublime-findings/issues/134

[^pooltogether-m01]: Code4rena PoolTogether finding issue #71, "YearnV2YieldSource may get stuck if safeApprove reverts", https://github.com/code-423n4/2021-06-pooltogether-findings/issues/71

[^mellow-report]: Code4rena, "Mellow contest Findings & Analysis Report", H-01, https://code4rena.com/reports/2021-12-mellow

[^amber-mai]: Amber Group, "MAI Finance's oracle manipulation vulnerability explained", https://medium.com/amber-group/mai-finances-oracle-manipulation-vulnerability-explained-55e4b5cc2b82

[^chainsecurity-curve]: ChainSecurity, "Curve LP Oracle Manipulation Post-Mortem", https://www.chainsecurity.com/blog/curve-lp-oracle-manipulation-post-mortem

[^yearn-yeth-2025]: Yearn Security disclosure, "yETH exploit disclosure", 2025-12-01, https://github.com/yearn/yearn-security/blob/master/disclosures/2025-12-01.md

[^checkpoint-yeth]: Check Point Research, "16 wei", https://research.checkpoint.com/2025/16-wei/

[^banteg-iearn-2025]: banteg, "iEarn 2025-12 investigation", https://github.com/banteg/iearn-2025-12-investigation/blob/master/readme.md

[^derby-nonreward-shares]: Sherlock Derby judging issue #219, "Yearn withdraw receives shares and not amount", https://github.com/sherlock-audit/2023-01-derby-judging/issues/219

[^aloe-nonreward]: Sherlock Aloe judging issue #4, "ERC4626: first depositor can manipulate pricePerShare", https://github.com/sherlock-audit/2023-10-aloe-judging/issues/4

[^pooltogether-maxloss-low]: Code4rena PoolTogether finding issue #69, "maxLosses can be set to 100%", https://github.com/code-423n4/2021-06-pooltogether-findings/issues/69

[^pooltogether-return-low]: Code4rena PoolTogether finding issue #70, "_depositInVault return value is ignored", https://github.com/code-423n4/2021-06-pooltogether-findings/issues/70

[^nested-qa]: Code4rena Nested QA issue #18, "YearnCurveVaultOperator immutable addresses should be 0-checked", https://github.com/code-423n4/2022-06-nested-findings/issues/18
