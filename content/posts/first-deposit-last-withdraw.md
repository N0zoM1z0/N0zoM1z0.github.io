---
title: "First Deposit, Last Withdraw: The Empty-Vault Attack Surface Behind Share-Based Protocols"
date: "2026-05-23"
slug: "first-deposit-last-withdraw"
categories:
  - DeFi
  - Security Research
tags:
  - erc4626
  - defi
  - share-accounting
  - vaults
---

# First Deposit, Last Withdraw: The Empty-Vault Attack Surface Behind Share-Based Protocols

*"One wei in, one vault out." Empty liquidity is not a neutral state.*

The phrase "First Deposit" sounds deceptively narrow. It suggests a bug that only exists in the first transaction of a vault, or a minor edge case that disappears once the system has users. That framing is too small. The real issue is not the first user. The real issue is who gets to write the first exchange rate.

In share-based protocols, the exchange rate is usually implied by two numbers:

```solidity
shares = assets * totalSupply / totalAssets;
```

When `totalSupply` is zero, tiny, or controlled by one address, that formula becomes fragile. If an attacker can increase `totalAssets` without increasing `totalSupply`, the price of one share can be inflated. Later deposits mint too few shares, sometimes zero shares. In lending forks, the inflated share token can become collateral and poison the whole protocol. In staking pools, insurance funds, LP pools, and strategy wrappers, the same mechanics reappear under different names.

This article takes the First Deposit class seriously, but not mechanically. The same words can describe a critical exploit, a valid medium, a QA observation, or a non-issue. The difference is not the label. The difference is the proof.

Our working thesis:

> First Deposit is a real security issue when an attacker can set or corrupt the initial price per share, force another party or the protocol to accept that price, and unwind into profit.

Everything else is a signal, not yet a vulnerability.

---

## 1. The minimal model

A share-based vault has two ledgers:

```text
totalAssets: the value controlled by the vault or its strategies
totalSupply: the number of outstanding shares
```

For a deposit of `u` assets, the user receives:

```text
victimShares = floor(u * totalSupply / totalAssets)
```

The empty-vault special case is usually implemented as:

```solidity
if (totalSupply == 0) {
    shares = assets;
} else {
    shares = assets * totalSupply / totalAssets;
}
```

That special case is not itself wrong. It is necessary if the vault has no prior price. The problem appears when the first depositor can create the price, then change the denominator without minting new shares.

A canonical attack looks like this:

```text
1. Attacker deposits 1 wei.
   totalSupply = 1
   totalAssets = 1

2. Attacker donates D assets directly to the vault or to something counted by totalAssets.
   totalSupply = 1
   totalAssets = 1 + D

3. Victim deposits U assets.
   victimShares = floor(U / (1 + D))

4. If D >= U, victimShares = 0.

5. Attacker redeems the only share and receives the whole asset pool.
```

If the victim receives zero shares, the attacker's donation is not a cost. It is a temporary position that comes back during redemption, plus the victim's assets. This is why the OpenZeppelin ERC-4626 documentation treats the issue as an inflation attack: the attacker moves the exchange rate into an unsafe rounding region, and a deposit that rounds below one share becomes an effective donation to the current shareholders.[^oz-docs]

The zero-share case is only the cleanest form. It is not the whole bug class. A victim who receives one share can still be robbed if the fair output should have been many shares. Sherlock's Surge and Exactly cases are important because they show that `require(shares > 0)` is a floor, not a fix.[^surge-issue][^exactly-issue]

---

## 2. The proof obligations for a true positive

A useful First Deposit report has to prove five things.

### 2.1 The attacker can become the dominant shareholder

The dangerous state is not only `totalSupply == 0`. It can also be:

```text
totalSupply == 1
totalSupply is tiny
totalSupply is non-zero but mostly attacker-owned
a market was seeded and then drained back to dust
a new accounting bucket or strategy position starts empty
```

This matters because many protocols only reason about deployment. They add a one-time check for `totalSupply == 0`, then miss the more common state: `totalSupply` is not zero, but is economically meaningless. Several accepted findings exploit exactly this distinction.

### 2.2 The attacker can increase `totalAssets` without minting shares

The word "donation" is often misunderstood. It does not have to be a raw token transfer into the vault.

It can be any value path that changes the numerator of the share price without changing the share supply:

```text
raw ERC20 transfer into the vault
raw ERC20 transfer into a strategy
transfer of an aToken or cToken that the strategy counts as collateral
claimable rewards that are included in totalAssets
liquidation profit
funding payments
flash-loan premium
rebasing balances
manual sync or harvest
external controller balance
cross-chain accounting update
```

The audit task is not "does `asset.balanceOf(address(vault))` change?" The audit task is "what exact state does `totalAssets()` read, and can a user move that state?"

### 2.3 The victim or protocol accepts the corrupted price

For a vault user, this usually means a deposit function with no `minShares` or an internal router that does not protect the user from slippage.

For a lending market, this means something more dangerous: the inflated share token or exchange rate is used as collateral value. In that case, the victim is not the next depositor. The victim is every other market that lends against the inflated receipt token.

### 2.4 Rounding converts a small accounting error into value transfer

Most of these bugs live at the boundary between integer math and economic meaning. Rounding down by one share is usually harmless when a share is worth one wei. It is catastrophic when one share has been inflated to thousands or millions of dollars.

A recurring mistake in judging these bugs is to inspect the arithmetic locally. The local rounding loss may be "one share". The economic value of that one share is the real variable.

### 2.5 The attacker can unwind in profit

This is the most important line in the report.

A donation is not automatically an exploit. If the attacker donates to a vault with substantial honest TVL, most of that donation benefits existing LPs. The attacker may create a weird exchange rate and still lose money.

A strong report computes the attacker's final balance:

```text
attacker initial assets
- seed deposit
- donation or inflation cost
+ redemption or borrowed assets
= net profit
```

If this line is missing, the finding is unfinished.

---

## 3. True positives: vaults, strategies, and share pools

### 3.1 prePO: the strategy controller donation path

**Status:** Code4rena High, sponsor confirmed.

In prePO, the first depositor could break share minting by making the system believe the vault had far more assets than shares. The important detail is that the donation path was not only the vault balance. The accounting included strategy-controller value, so an attacker could manipulate the value used by `totalAssets()` and make later deposits mint zero shares.[^prepo-report]

Pinned code references:

- `Collateral.sol`, deposit flow, audited commit `f63584133a0329781609e3f14c3004c1ca293e71`: <https://github.com/code-423n4/2022-03-prepo/blob/f63584133a0329781609e3f14c3004c1ca293e71/contracts/core/Collateral.sol#L82-L91>
- `Collateral.sol`, `totalAssets()` path, audited commit `f63584133a0329781609e3f14c3004c1ca293e71`: <https://github.com/code-423n4/2022-03-prepo/blob/f63584133a0329781609e3f14c3004c1ca293e71/contracts/core/Collateral.sol#L333-L340>

Why it is a true positive:

```text
attacker can be first depositor: yes
attacker can increase totalAssets without minting shares: yes, through strategy-controller value
victim deposit can mint zero shares: yes
attacker can redeem the victim-funded pool: yes
accepted severity: High
```

The core lesson is that First Deposit analysis must walk the full asset graph. A strategy controller can be the vault's real denominator even if the vault contract looks clean.

### 3.2 Hubble InsuranceFund: non-ERC-4626, same invariant failure

**Status:** Code4rena High.

Hubble's InsuranceFund was not interesting because it had an exotic design. It was interesting because it showed how generic the bug is. The pool minted shares for deposits, used a balance-based asset value, and allowed an attacker to become the initial shareholder. After that, a direct VUSD transfer inflated the asset balance while the share supply stayed tiny. Deposits below the inflated price minted zero shares, and the attacker could withdraw the entire balance.[^hubble-report]

Pinned code reference:

- `InsuranceFund.sol`, audited commit `8c157f519bc32e552f8cc832ecc75dc381faa91e`: <https://github.com/code-423n4/2022-02-hubble/blob/8c157f519bc32e552f8cc832ecc75dc381faa91e/contracts/InsuranceFund.sol#L44-L54>

Why it is a true positive:

```text
first depositor controls the initial share supply: yes
raw transfer changes the accounting balance: yes
subsequent users can mint zero shares: yes
attacker can withdraw the entire pool: yes
impact is direct theft of deposited funds: yes
```

This case is a useful reminder that ERC-4626 did not create the bug. ERC-4626 merely standardized a pattern that already existed across DeFi.

### 3.3 JPEG'd yVault: the Yearn-style share trap

**Status:** Code4rena High, sponsor confirmed.

The JPEG'd finding was structurally similar to older Yearn-style donation issues. The first user deposits one wei, receives one share, then moves a large amount of underlying value into the strategy side. The next depositor contributes a meaningful amount but receives zero shares. The first user then withdraws both their donation and the victim's assets.[^jpegd-report]

Pinned code reference:

- `yVault.sol`, audited commit `e72861a9ccb707ced9015166fbded5c97c6991b6`: <https://github.com/code-423n4/2022-04-jpegd/blob/e72861a9ccb707ced9015166fbded5c97c6991b6/contracts/vaults/yVault/yVault.sol#L148-L153>

Why it is a true positive:

```text
attacker can receive the only initial share: yes
total assets can be manipulated by external value movement: yes
victim can receive zero shares: yes
redemption captures the victim's deposit: yes
```

The lesson is not that Yearn-like vaults are uniquely unsafe. The lesson is that any vault which combines first-share 1:1 minting with balance-sensitive `totalAssets` needs an initial-rate defense.

### 3.4 BakerFi: strategy collateral is part of the denominator

**Status:** Code4rena High.

BakerFi is one of the better modern examples because the vulnerable value was not a simple ERC20 balance. The vault read a leveraged strategy's deployed value. That strategy's position included collateral represented through Aave-style accounting. The attacker could deposit a tiny amount, then transfer collateral tokens to the strategy, inflating the strategy's deployed value. The next depositor minted too few shares, and the attacker captured a portion of the deposit.[^baker-report]

Pinned code references:

- `Vault.sol`, deposit and share calculation, audited commit `59b1f70cbf170871f9604e73e7fe70b70981ab43`: <https://github.com/code-423n4/2024-05-bakerfi/blob/59b1f70cbf170871f9604e73e7fe70b70981ab43/contracts/core/Vault.sol#L190-L227>
- `RebaseLibrary.sol`, base/elastic conversion, same commit: <https://github.com/code-423n4/2024-05-bakerfi/blob/59b1f70cbf170871f9604e73e7fe70b70981ab43/contracts/libraries/RebaseLibrary.sol#L29-L42>
- `StrategyLeverage.sol`, deployed value path, same commit: <https://github.com/code-423n4/2024-05-bakerfi/blob/59b1f70cbf170871f9604e73e7fe70b70981ab43/contracts/core/strategies/StrategyLeverage.sol#L59-L85>

Why it is a true positive:

```text
attacker can control the early share supply: yes
strategy valuation can be externally inflated: yes
victim receives materially fewer shares: yes
attacker exits with profit: yes
```

BakerFi is the type of case that weak reports miss. The donation is not visible at the vault boundary. It is inside the dependency tree of `totalAssets()`.

### 3.5 GoodEntry: non-zero shares are not enough

**Status:** Code4rena Medium, sponsor confirmed.

GoodEntry is useful because it sits between a screaming High and a theoretical edge case. The protocol had a non-zero liquidity check, but the finding showed that requiring `liquidity > 0` did not remove the economic issue. A victim could still receive an unfair amount of shares after the first depositor manipulated the asset/share ratio. The issue was downgraded in context because the main affected window was new vault deployment and the team-controlled lifecycle, not arbitrary active-user deposits.[^goodentry-report]

Pinned code references:

- `GeVault.sol`, liquidity minting, audited commit `71c0c0eca8af957202ccdbf5ce2f2a514ffe2e24`: <https://github.com/code-423n4/2023-08-goodentry/blob/71c0c0eca8af957202ccdbf5ce2f2a514ffe2e24/contracts/GeVault.sol#L271-L278>
- `GeVault.sol`, TVL/accounting path, same commit: <https://github.com/code-423n4/2023-08-goodentry/blob/71c0c0eca8af957202ccdbf5ce2f2a514ffe2e24/contracts/GeVault.sol#L420-L424>

Why it is a true positive but not necessarily High:

```text
there is an actual value-transfer path: yes
non-zero share checks do not eliminate the issue: yes
impact depends on a new-vault lifecycle window: yes
severity is reduced by deployment context: yes
```

This is where judging becomes more nuanced. The arithmetic can be real while the exploitability window is narrower than a public, always-on vault.

### 3.6 Belong staking vault: vanilla ERC-4626, no seed, no offsets

**Status:** Immunefi Critical.

The Belong report is a canonical ERC-4626 staking-vault case. The vault started with zero supply, inherited vanilla ERC-4626 share math, did not seed liquidity, and did not use virtual share or asset offsets. Its `totalAssets()` treated the vault token balance as canonical. A first depositor could deposit dust, transfer tokens directly to the vault, make later stakers receive almost no shares, and later redeem most of the pooled assets after the lock period.[^belong-report]

Code reference from the report:

- Target path: `contracts/v2/periphery/Staking.sol` in `belongnet/checkin-contracts`.[^belong-report]

Why it is a true positive:

```text
public first depositor: yes
raw transfer changes totalAssets: yes
no seed liquidity or virtual offsets: yes
later users lose nearly all deposited assets: yes
accepted severity: Critical
```

The lock period does not save the design. If the attacker can wait out the lock and redeem the victim-funded vault, the issue is theft with delayed settlement.

---

## 4. True positives where the victim does not necessarily get zero shares

The most damaging misunderstanding in this bug class is the belief that the exploit requires `shares == 0`. It does not.

### 4.1 Surge: stealing half the deposit while minting one share

**Status:** Sherlock High, reward.

In the Surge finding, Bob deposits one loan token and receives one pool share. Bob then transfers `1e18` loan tokens directly to the pool, inflating the value of that one share. Alice deposits `2e18` loan tokens and receives only one share. Bob withdraws and captures roughly `0.5e18` loan tokens of value from Alice.[^surge-issue]

Pinned code reference:

- `Pool.sol`, audited commit `b7cb1dc2a2dcb4bf22c765a4222d7520843187c6`: <https://github.com/Surge-fi/surge-protocol-v1/blob/b7cb1dc2a2dcb4bf22c765a4222d7520843187c6/src/Pool.sol#L307-L343>

The simplified economics:

```text
Bob deposits 1 and owns 1 share.
Bob donates D = 1e18.
Alice deposits U = 2e18 and receives 1 share.
Bob now owns 1/2 of the shares.
Total assets ~= 3e18.
Bob withdraws ~= 1.5e18.
Bob's cost was ~= 1e18.
Bob's profit ~= 0.5e18.
```

Why it is a true positive:

```text
victim does not receive zero shares: correct
victim still receives far too few shares: yes
attacker profit is shown: yes
impact is direct value transfer: yes
```

This is why `require(shares > 0)` is not a complete mitigation. It prevents the cleanest full-loss case. It does not protect the user from minting one massively overpriced share.

### 4.2 Exactly / Interest Rate Model: dust supply, repeated rounding, real profit

**Status:** Sherlock High, reward.

The Exactly-related Sherlock case showed a more complex form. The attacker pushed the market into a state where `totalSupply` was one and `totalAssets` was two, then used repeated mint/withdraw behavior to amplify assets per share. A victim deposit of 9000 DAI minted only one wei of shares in the PoC, and the attacker extracted profit from the distorted exchange rate.[^exactly-issue]

Code reference:

- `Market.sol`, archived contest repository: <https://github.com/sherlock-audit/2024-04-interest-rate-model/blob/main/protocol/contracts/Market.sol#L710>

Why it is a true positive:

```text
bug is not limited to deployment first deposit: yes
dangerous state is totalSupply == 1, not only totalSupply == 0: yes
rounding loss is economically large: yes
PoC demonstrates attacker profit: yes
```

This case is important because it reframes the class. The bug is not "first call to deposit after deployment". The bug is "dust supply plus exchange-rate inflation plus rounding accepted as settlement."

### 4.3 Teller: internal accounting blocks raw donation, but not value injection

**Status:** Sherlock Medium, reward.

Teller had two mitigations that often stop weak First Deposit reports: an initial 1:1 exchange rate when supply is zero, and internal reserve accounting that prevents raw token transfers from changing the pool value. The accepted issue showed that those mitigations did not close the full surface. A self-liquidation path could increase the pool's estimated value, and once supply was reduced to a tiny non-zero amount, rounding could still transfer value from new depositors.[^teller-issue]

Pinned code reference:

- `LenderCommitmentGroup_Smart.sol`, audited commit `defe55469a2576735af67483acf31d623e13592d`: <https://github.com/sherlock-audit/2024-04-teller-finance/blob/defe55469a2576735af67483acf31d623e13592d/teller-protocol-v2-audit-2024/packages/contracts/contracts/LenderCommitmentForwarder/extensions/LenderCommitmentGroup/LenderCommitmentGroup_Smart.sol#L307-L322>

Why it is a true positive:

```text
raw transfer attack blocked: yes
another value-increase path exists: yes, liquidation accounting
attacker can reduce supply to a dangerous dust state: yes
impact is partial but real: yes
```

Our take: internal accounting is a strong mitigation against the lazy version of the attack. It is not a proof of safety. Once a protocol has liquidations, reward claims, funding flows, or strategy profit updates, "donation" becomes a broader concept.

### 4.4 FlatMoney: minimum liquidity checks can be bypassed by dust states

**Status:** Sherlock Medium, sponsor confirmed, won't fix.

FlatMoney is another nuanced case. The protocol had a `MIN_LIQUIDITY` mechanism and state-variable accounting, so the obvious raw-transfer attack did not work. The report argued that an attacker could pass the minimum-liquidity phase, withdraw almost all shares, leave a one-share dust state, and then inflate collateral per share through protocol-native value paths such as loss-making leveraged positions or funding payments to LPs.[^flatmoney-issue]

Pinned code reference:

- `StableModule.sol`, audited commit `957489baee10d52d65c50ec88f73189b62c36853`: <https://github.com/dhedge/flatcoin-v1/blob/957489baee10d52d65c50ec88f73189b62c36853/src/StableModule.sol#L61>

Why it is a true positive:

```text
minimum liquidity does not permanently prevent low-supply states: yes
raw transfer blocked by internal accounting: yes
protocol-native value-increase path alleged and accepted: yes
impact depends on economic setup: yes
```

This case gives a clean audit rule: a first-deposit defense must protect the entire lifecycle, not just the first mint. If users can later leave the system with one economically meaningful share, the empty-vault problem has merely moved in time.

---

## 5. True positives in production: Compound and Aave fork empty-pool attacks

The lending versions are the scariest because the victim is not necessarily the next depositor. The victim is the protocol balance sheet.

Compound-style markets have an exchange rate between cTokens and underlying assets. If a market starts empty or near-empty, an attacker can mint dust cTokens, transfer underlying directly to the cToken contract, and inflate the exchange rate. If that cToken is accepted as collateral, the attacker can borrow real assets from other markets. If redeem or borrow math also rounds in the wrong direction, the damage compounds.

MixBytes summarized the key distinction well: in vault inflation attacks, the next depositor is often the direct victim; in Compound/Aave fork empty-pool attacks, the protocol itself becomes the victim because the inflated receipt token is used across markets.[^mixbytes-empty]

### 5.1 Hundred Finance

Hundred Finance, a Compound V2 fork, lost roughly $7.4 million in April 2023. The attack used an empty or low-liquidity hWBTC market. The attacker created a tiny hToken supply, donated WBTC to inflate the exchange rate, then exploited rounding in redemption/collateral accounting to borrow and drain other assets.[^blocksec-hundred]

Why it is a true positive:

```text
low supply market: yes
exchange rate manipulated by direct transfer: yes
inflated receipt token used as collateral: yes
protocol-wide loss: yes
```

This is the same invariant failure with a larger blast radius.

### 5.2 Onyx Protocol

Onyx, another Compound fork, was exploited in November 2023 after a newly added PEPE market remained effectively unfunded. The attacker minted oPEPE, donated PEPE to inflate the exchange rate, then borrowed other assets using the inflated position. Hacken's postmortem explicitly tied the incident to empty-pool behavior and recommended minting and burning initial cTokens and starting new markets with conservative collateral settings.[^hacken-onyx]

Why it is a true positive:

```text
new market lifecycle window: yes
empty pool or near-empty pool: yes
inflated exchange rate accepted by lending logic: yes
external assets borrowed against fake collateral value: yes
```

The market-launch process was part of the attack surface.

### 5.3 Sonne Finance

Sonne Finance lost around $20 million in May 2024. Halborn's analysis describes the incident as a known Compound V2 fork issue: the team attempted a multi-step mitigation, but the sequence was permissionless and could be controlled by an attacker. The attacker used the new market window to exploit the donation/inflation pattern.[^halborn-sonne]

Why it is a true positive:

```text
known empty-market risk: yes
mitigation split across permissionless steps: yes
attacker controls transaction ordering: yes
large protocol loss: yes
```

This is where operational security becomes smart-contract security. If seeding, configuring, and enabling a market happen in separate public transactions, the mempool gets a vote.

### 5.4 Radiant Capital

Radiant, an Aave V2 fork, lost around 1900 ETH in January 2024 after a new native USDC market on Arbitrum was activated. Rekt reported that the attack contract was deployed seconds after activation, and that original Aave mitigated the class by adding an initial deposit when a new market is created.[^rekt-radiant]

Why it is a true positive:

```text
freshly launched market: yes
empty or fragile supply state: yes
index/exchange-rate manipulation accepted by protocol: yes
loss comes from other protocol liquidity: yes
```

The attack window was measured in seconds. That is the correct mental model for public market initialization.

---

## 6. False positives, low-signal findings, and why they fail

A weak First Deposit report usually has a correct-looking formula and an incomplete exploit. The formula is not enough.

### 6.1 Tokemak LMPVault: a textbook story can still be excluded

A Sherlock submission against Tokemak's LMPVault described a canonical ERC-4626 inflation scenario: deposit one share, donate assets, front-run a victim deposit, make the victim receive zero shares, then withdraw. The public issue was labeled `Excluded` and `Non-Reward`.[^tokemak-issue]

This does not prove that every LMPVault inflation claim is impossible. It proves something more useful for researchers: a template narrative is not enough to clear judging.

The missing proof in many such reports is one of the following:

```text
Can the attacker actually be the first depositor under the real deployment flow?
Does the donated asset really affect the NAV used for share conversion?
Are there guards such as NAV-operation locks, slippage checks, or role-gated initialization?
Can the attacker redeem the donated value back?
Does the attack remain profitable after existing shares, fees, and restrictions?
```

Our view: Tokemak-like excluded cases are valuable because they show the boundary between pattern matching and vulnerability research. The finding title can be right at the pattern level and still fail at the exploitability level.

### 6.2 Ensuro: known issue plus access control changes the bounty answer

Ensuro's Immunefi program publicly listed `ERC4626 inflation attack` as a previously known issue mitigated by access control. Reports covering such known issues are not eligible for reward under that program.[^ensuro-known]

This is not a mathematical refutation of the ERC-4626 attack. It is a scope and reachability refutation:

```text
public attacker can perform first deposit: no, if access control holds
project has disclosed the issue: yes
bug bounty eligibility: no
```

This distinction matters. A report can be technically correct in isolation and invalid for a program because the relevant role is trusted, allowlisted, or operationally controlled.

### 6.3 Firelight: deployment-time mitigation can move the issue out of scope

Firelight's Immunefi audit competition described its vault as ERC-4626-compatible and publicly disclosed the inflation attack as a known ERC-4626 issue that would be handled at deployment time.[^firelight-known]

This creates a common judging fork:

```text
If the report only says "ERC-4626 inflation exists", it is known and out of reward.
If the report proves the deployment mitigation cannot be performed atomically or can be bypassed, it becomes interesting again.
```

The difference is not whether the generic attack exists. The difference is whether the implementation and deployment procedure leave a public unsafe state.

### 6.4 Mantra DEX: correct concern, hypothetical impact, QA severity

Mantra DEX implemented a minimum-liquidity mechanism similar in spirit to Uniswap. The Code4rena QA finding observed that the minimum-liquidity LP tokens were minted to the contract itself instead of an irrecoverable burn address. That is weaker than a true burn because a future migration or admin function could make those tokens recoverable. However, the report itself classified the issue as QA because the current code did not expose a way to access those contract-owned tokens.[^mantra-qa]

This is a good example of a low-severity but real engineering concern:

```text
current exploit path: no
future upgrade or migration could create one: yes
security hygiene recommendation: burn to an irrecoverable address
severity today: QA / informational
```

The point is subtle. "Minting minimum liquidity to `address(this)`" is not as strong as burning. But without a present extraction path, a critical-theft narrative depends on future code, not current code.

### 6.5 Existing TVL turns the donation into a gift

Suppose a vault already has honest assets `A_h` and honest shares `S_h`. The attacker deposits a small amount and donates `D`. The attacker does not own the vault. Existing shareholders do.

The donation is shared by all shareholders. If the attacker owns only 0.1 percent of the supply, then roughly 99.9 percent of the donation benefits existing LPs. The attacker may be able to make the next depositor receive fewer shares, but the attacker has also paid a large subsidy to everyone else.

This is the most common economic false positive:

```text
price can be manipulated: yes
attacker can profit: not shown, often no
existing LPs capture most of the donation: yes
severity: low, invalid, or needs stronger PoC
```

A mature report must model existing liquidity. Empty-vault math cannot be blindly applied to a live vault with meaningful TVL.

### 6.6 Internal accounting blocks the lazy raw-transfer PoC

A protocol that computes `totalAssets` from internal state rather than token balance is much harder to inflate with a raw ERC20 transfer.

```solidity
// Fragile if raw transfers are meaningful.
function totalAssets() public view returns (uint256) {
    return asset.balanceOf(address(this));
}

// Stronger against direct donation.
function totalAssets() public view returns (uint256) {
    return accountedAssets;
}
```

If a report only transfers tokens directly and `totalAssets()` does not change, the report fails.

But this defense is not the end of the review. Teller and FlatMoney show the next layer: once internal accounting blocks raw transfers, the researcher must inspect every legitimate value-increase path. Liquidations, funding, strategy profits, reward claims, and sync functions can still change the internal denominator.

### 6.7 Virtual offsets and dead shares change the economics

OpenZeppelin's modern ERC-4626 defense uses virtual assets, virtual shares, and optionally a decimal offset. The idea is to force a stable initial exchange rate and make donation attacks economically unfavorable because the attacker does not own the virtual shares.[^oz-defense]

Uniswap-style dead shares work similarly at the economic layer: the attacker must donate into a supply that includes permanently locked shares. The larger the dead-share base, the more of the donation is lost to the locked position.

A report against a vault with these defenses must prove one of the following:

```text
the offsets are missing
the offset parameter is too small for the asset scale
a deposit path bypasses the offset
dead shares are recoverable
the attack uses a later dust-supply state not covered by initialization
```

If none of those is true, the report is usually a template false positive.

### 6.8 Slippage-protected deposits turn theft into revert or griefing

ERC-4626's standard `deposit` function does not include `minShares`, and the standard explicitly treats preview/deposit mismatches as slippage that integrators must reason about.[^eip-4626] Many production systems use routers or wrappers that add slippage protection. If the victim requires a minimum share output, a front-run donation should revert the deposit instead of stealing it.

That may still be a denial-of-service concern. It is not the same as direct theft.

The severity depends on whether the attacker can cheaply and persistently block deposits, and whether the donation can be recovered. Without theft or durable protocol failure, the finding should not be sold as High.

---

## 7. Severity: how the same pattern becomes Critical, High, Medium, QA, or invalid

### Critical or High

A First Deposit issue belongs in the high-severity bucket when most of these are true:

```text
public attacker can reach the low-supply state
attacker can inflate totalAssets without minting shares
victims have no minShares protection, or the protocol accepts inflated shares as collateral
rounding causes zero-share or massively under-minted deposits
attacker can redeem or borrow into net profit
loss comes from user funds or protocol liquidity
attack is repeatable or affects newly listed markets
```

Examples:

```text
prePO: strategy-controller value inflation, zero shares, High
Hubble: InsuranceFund direct balance inflation, zero shares, High
JPEG'd: yVault donation path, zero shares, High
BakerFi: strategy collateral valuation, partial theft, High
Belong: ERC-4626 staking vault, direct theft, Critical
Hundred / Onyx / Sonne / Radiant: empty lending markets, protocol-level loss
```

### Medium

Medium is appropriate when the value-transfer path is real but constrained:

```text
only new vaults or new markets are affected
attack requires a narrow lifecycle window
partial theft is possible but not full drain
internal accounting blocks direct donation but another path exists
attacker needs meaningful capital or setup
impact depends on user behavior or a specific market state
```

Examples:

```text
GoodEntry: true issue, but mainly new-vault deployment context
Teller: raw donation blocked, liquidation accounting path remains
FlatMoney: indirect value paths and dust-state lifecycle
```

### Low, QA, or informational

Low-signal cases usually look like this:

```text
only theoretical price movement is shown
attacker profit is not computed
existing TVL makes donation uneconomic
first deposit is access-controlled
attack is publicly disclosed as a known issue
mitigation is planned and must be bypassed to matter
impact depends on a future upgrade
raw transfer does not affect accounting
```

Examples:

```text
Tokemak LMPVault issue: excluded / non-reward despite textbook narrative
Ensuro: known ERC-4626 inflation issue mitigated by access control
Firelight: known ERC-4626 issue planned for deployment handling
Mantra DEX: minimum liquidity should be burned, but current extraction path absent, QA
```

### Invalid

The report is usually invalid when it fails one of the proof obligations:

```text
attacker cannot become first or dominant shareholder
attacker cannot affect totalAssets
victim transaction would revert due slippage or share checks
attacker cannot redeem the inflated value
attack loses money once existing TVL is modeled
attack requires trusted admin misconduct that is explicitly out of scope
```

---

## 8. Mitigations that actually address the root cause

### 8.1 Atomic seeding and market activation

For vaults and lending markets, initialization must not be split into publicly interleavable steps.

Bad lifecycle:

```text
tx1: deploy vault
tx2: initialize
tx3: seed liquidity
tx4: enable deposits or collateral
```

Safer lifecycle:

```text
tx1: deploy, initialize, seed, burn or lock initial shares, then enable
```

For DAO proposals, this means the proposal payload matters. For factories, it means `createVault()` or `createMarket()` should not return a public empty market before seeding. For Compound/Aave forks, it means collateral factors and borrowing should remain disabled until the market has permanent safe liquidity.

### 8.2 Permanently locked dead shares

The Uniswap V2-style idea is simple: mint initial liquidity shares to an irrecoverable address so the attacker can never own 100 percent of the share supply.

```solidity
_mint(DEAD_ADDRESS, MINIMUM_SHARES);
```

The dead address must be truly unrecoverable. Minting to `address(this)` is not equivalent if an upgrade, rescue function, migration, or admin action can later recover the shares.

Dead shares do not make every attack impossible. They make the donation economics worse for the attacker. The required amount should be chosen with asset decimals and realistic deposit sizes in mind.

### 8.3 Virtual assets, virtual shares, and decimal offsets

The OpenZeppelin-style defense modifies the conversion basis:

```solidity
shares = assets * (totalSupply + virtualShares) / (totalAssets + virtualAssets);
```

The virtual shares make the attacker share ownership incomplete even when the real supply is tiny. The virtual asset defines an initial price. The decimal offset increases precision so that ordinary deposits mint enough shares to avoid dangerous rounding zones.[^oz-defense]

This is probably the cleanest general-purpose ERC-4626 defense, but it is still an implementation detail, not a magic word. Reviewers should check:

```text
Are virtual values applied in every convert, preview, deposit, mint, withdraw, and redeem path?
Are they applied consistently across upgrades or wrappers?
Is the share-decimal offset large enough for the asset's decimals and expected deposit sizes?
Does any external strategy valuation bypass the protected conversion?
```

### 8.4 Internal accounting with complete value-path review

Internal accounting is strong against unsolicited raw transfers:

```solidity
accountedAssets += depositAmount;
accountedAssets -= withdrawalAmount;
```

But the review must include every function that can increase accounted assets:

```text
harvest
sync
claimRewards
compound
liquidate
repay with surplus
funding settlement
strategy profit reporting
cross-chain receive
oracle-priced collateral updates
```

A safe accounting system is not one that ignores raw transfers. It is one where every accepted value update has an owner, a timing model, and a rounding model.

### 8.5 User-facing slippage protection

For EOAs and routers, the interface should allow users to express the minimum acceptable shares:

```solidity
function deposit(uint256 assets, address receiver, uint256 minShares) external returns (uint256 shares);
```

or the maximum acceptable assets for a mint:

```solidity
function mint(uint256 shares, address receiver, uint256 maxAssets) external returns (uint256 assets);
```

This does not fix the vault's economics for every integration, but it prevents a user deposit from silently becoming an attacker donation.

### 8.6 Rounding direction must be designed, not inherited blindly

Rounding should favor the side that preserves solvency and prevents free value extraction. In ERC-4626, conversions intentionally round down in several places. That is acceptable only when the economic value of the dust is bounded.

In empty-pool lending exploits, rounding of one receipt token or one underlying unit was enough to bypass collateral or redemption assumptions. The lesson is not "never round down." The lesson is that rounding errors must be bounded in economic value, not just token units.

---

## 9. A compact review checklist

When reviewing a share-based protocol, ask these questions before deciding severity.

```text
Initialization
- Can a public user be the first depositor?
- Is seed liquidity created in the same transaction as deployment and enablement?
- Can the system return to totalSupply == 0 or totalSupply == 1 later?
- Are new markets, new vaults, epochs, or strategy buckets separately initialized?

Asset accounting
- What exactly does totalAssets read?
- Does it include external strategies, controllers, aTokens, cTokens, rewards, or claimables?
- Can raw transfers affect it?
- Can liquidations, funding, harvests, or syncs affect it?

Share math
- Can deposit mint zero shares?
- Can deposit mint one share when the fair output is much larger?
- Are all conversion paths protected by virtual offsets or dead shares?
- Are rounding directions economically bounded?

User and integration protection
- Is there minShares or maxAssets protection?
- Are preview or convert functions used as an oracle by another protocol?
- Can an inflated receipt token become collateral?

Economics
- What is the attacker's final profit?
- Who captures the donation if existing TVL is present?
- Can the attack be repeated?
- Can it be flash-loaned?
- Is the attack window public or role-controlled?
```

The most useful invariant is this:

```text
No actor should be able to make assets/share arbitrarily large while owning nearly all shares and then force another party to transact at that price.
```

---

## 10. Case matrix

| Case | Venue | Status | Core vector | Why it matters |
|---|---:|---:|---|---|
| prePO | Code4rena | High | First depositor inflates strategy-controller value | `totalAssets()` dependency graph matters, not only vault balance |
| Hubble InsuranceFund | Code4rena | High | Raw VUSD transfer inflates pool balance | ERC-4626 is not required for the bug |
| JPEG'd yVault | Code4rena | High | Strategy-side donation breaks share minting | Yearn-style vaults need initial-rate protection |
| BakerFi | Code4rena | High | aToken collateral sent to strategy inflates deployed value | Strategy collateral can be a donation surface |
| GoodEntry | Code4rena | Medium | Non-zero share output still unfair | `shares > 0` is not enough |
| Belong Staking | Immunefi | Critical | Vanilla ERC-4626, no seed, no offsets | Classic first depositor theft against staking vault |
| Surge | Sherlock | High | Victim gets one share, attacker still profits | Zero-share is not required |
| Exactly / Interest Rate Model | Sherlock | High | Dust supply plus repeated rounding | Dangerous states can be created after deployment |
| Teller | Sherlock | Medium | Internal accounting bypassed via liquidation value | Donation can be protocol-native value injection |
| FlatMoney | Sherlock | Medium | Dust-state lifecycle plus funding/value path | Minimum liquidity checks must protect the whole lifecycle |
| Hundred Finance | Production exploit | Critical impact | Empty Compound market exchange-rate inflation | Protocol, not next depositor, becomes the victim |
| Onyx | Production exploit | Critical impact | New unfunded PEPE market | Market listing workflow is security-critical |
| Sonne | Production exploit | Critical impact | Multi-step mitigation in public mempool | Non-atomic initialization can fail even if the mitigation is known |
| Radiant | Production exploit | Critical impact | New Aave-fork market activated empty | Attack windows can be seconds long |
| Tokemak LMPVault | Sherlock | Excluded / Non-Reward | Textbook ERC-4626 narrative | Pattern matching without full proof can fail |
| Ensuro | Immunefi | Known issue | ERC-4626 inflation mitigated by access control | Reachability and scope can invalidate a generic report |
| Firelight | Immunefi | Known issue | ERC-4626 inflation planned for deployment handling | Deployment procedure is part of the security claim |
| Mantra DEX | Code4rena | QA | Minimum liquidity minted to contract, not dead address | Correct concern, but impact depended on future access path |

---

## 11. The essence

The First Deposit bug class is really three bugs stacked together:

```text
1. Price authority bug: the attacker can write the initial exchange rate.
2. Accounting integrity bug: totalAssets can be increased without proportional shares.
3. Settlement bug: another user or protocol accepts the distorted price with unsafe rounding.
```

When all three are present, the issue is serious. Sometimes it is catastrophic. The history of Hundred, Onyx, Sonne, and Radiant shows that empty-market share inflation can graduate from "the first user loses money" to "the protocol balance sheet is drained." The accepted audit findings show the same mechanics across vaults, strategy wrappers, insurance funds, staking contracts, and lending markets.

But the reverse is also true. A vault with existing TVL, internal accounting, virtual offsets, dead shares, slippage-protected deposits, access-controlled seeding, or an atomic deployment flow may not have a profitable attack. In those cases, a First Deposit report that only pastes the canonical ERC-4626 inflation sequence is not research. It is a template.

The best way to avoid both under-reporting and over-reporting is to stop asking whether the contract has a "first deposit issue." Ask a sharper question:

> Can an attacker become the price setter of a low-supply share system, move the asset/share ratio without minting shares, and exit with value that came from someone else?

If the answer is yes, the first deposit was not a deposit. It was the opening move.

---

## References

[^oz-docs]: OpenZeppelin Contracts ERC-4626 documentation, "Security concern: Inflation attack." <https://docs.openzeppelin.com/contracts/5.x/erc4626>
[^oz-defense]: OpenZeppelin, "A Novel Defense Against ERC4626 Inflation Attacks." <https://www.openzeppelin.com/news/a-novel-defense-against-erc4626-inflation-attacks>
[^eip-4626]: EIP-4626, Tokenized Vault Standard. <https://eips.ethereum.org/EIPS/eip-4626>
[^prepo-report]: Code4rena prePO report, H-02, "First depositor can break minting shares." <https://code4rena.com/reports/2022-03-prepo>
[^hubble-report]: Code4rena Hubble report, H-03, "InsuranceFund depositors can be priced out and their deposits stolen." <https://code4rena.com/reports/2022-02-hubble>
[^jpegd-report]: Code4rena JPEG'd report, H-01, "yVault: First depositor can break minting of shares." <https://code4rena.com/reports/2022-04-jpegd>
[^baker-report]: Code4rena BakerFi report, H-02, "First depositor can manipulate shares." <https://code4rena.com/reports/2024-05-bakerfi>
[^goodentry-report]: Code4rena GoodEntry report, M-04, first depositor inflation issue. <https://code4rena.com/reports/2023-08-goodentry>
[^belong-report]: Immunefi Belong report #56941, "Staking vault vulnerable to first depositor donation attack." <https://reports.immunefi.com/belong/56941-sc-critical-staking-vault-vulnerable-to-first-depositor-donation-attack>
[^surge-issue]: Sherlock Surge judging issue #42, High, first depositor manipulation. <https://github.com/sherlock-audit/2023-02-surge-judging/issues/42>
[^exactly-issue]: Sherlock Interest Rate Model judging issue #37, High, first depositor can steal from next users. <https://github.com/sherlock-audit/2024-04-interest-rate-model-judging/issues/37>
[^teller-issue]: Sherlock Teller Finance judging issue #161, Medium, inflation-style share theft despite mitigations. <https://github.com/sherlock-audit/2024-04-teller-finance-judging/issues/161>
[^flatmoney-issue]: Sherlock FlatMoney judging issue #190, Medium, first depositor inflation with indirect value paths. <https://github.com/sherlock-audit/2023-12-flatmoney-judging/issues/190>
[^mixbytes-empty]: MixBytes, "Aave and Compound Forking: Empty Pool Attacks." <https://mixbytes.io/blog/aave-and-compound-forking-empty-pool-attacks>
[^blocksec-hundred]: BlockSec, "Hundred Finance Incident: catalyzing the wave of precision-related exploits in vulnerable forked protocols." <https://blocksec.com/blog/6-hundred-finance-incident-catalyzing-the-wave-of-precision-related-exploits-in-vulnerable-forked-protocols>
[^hacken-onyx]: Hacken, "Onyx Protocol Hack." <https://hacken.io/discover/onyx-protocol-hack/>
[^halborn-sonne]: Halborn, "Explained: The Sonne Finance Hack, May 2024." <https://www.halborn.com/blog/post/explained-the-sonne-finance-hack-may-2024>
[^rekt-radiant]: Rekt, "Radiant Capital - Rekt." <https://rekt.news/radiant-capital-rekt>
[^tokemak-issue]: Sherlock Tokemak judging issue #888, excluded/non-reward LMPVault ERC-4626 inflation submission. <https://github.com/sherlock-audit/2023-06-tokemak-judging/issues/888>
[^ensuro-known]: Ensuro Immunefi program, known issues list. <https://immunefi.com/bug-bounty/ensuro/information/>
[^firelight-known]: Firelight Immunefi audit competition scope, known ERC-4626 inflation issue. <https://immunefi.com/audit-competition/audit-comp-firelight/scope/>
[^mantra-qa]: Code4rena Mantra DEX report, QA issue 03, "Inflation attack protection is not really sufficient." <https://code4rena.com/reports/2024-11-mantra-dex>
