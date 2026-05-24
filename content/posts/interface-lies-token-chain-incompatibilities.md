---
title: "The Interface Lies: Token and Chain Incompatibility Bugs in the Wild"
date: "2026-05-24"
slug: "interface-lies-token-chain-incompatibilities"
categories:
  - DeFi
  - Security Research
tags:
  - erc20
  - token-integration
  - cross-chain
  - defi
---

# The Interface Lies: Token and Chain Incompatibility Bugs in the Wild

*There is no such thing as "just an ERC20."*

## Abstract

The most dangerous token-integration bugs rarely start with an obviously malicious contract. They usually start with a reasonable interface, a familiar symbol, and a hidden assumption: transfers are exact, decimals are normal, balances move only when we move them, approvals behave like OpenZeppelin, the token has one address, native assets are not ERC20s, and a successful call means the intended semantic event happened.

That assumption is where the money leaks.

This article studies token and chain incompatibility bugs across real exploits, public audit findings, and public judging outcomes. The goal is not to repeat the common warning that "weird ERC20s exist." The goal is to separate true positives from false positives and to identify the invariant that makes an incompatibility matter.

The core thesis is simple:

```text
A token or chain incompatibility becomes a security bug when a protocol's internal economic state
credits, prices, unlocks, mints, borrows, settles, or bridges more value than the protocol actually
controls under the real semantics of the asset on that chain.
```

Everything else is context.

A fee-on-transfer token is not automatically a vulnerability. A blacklistable stablecoin is not automatically a vulnerability. A rebasing asset is not automatically a vulnerability. A non-standard approval rule is not automatically a vulnerability. These become high-impact only when they cross into accounting, collateral, liquidity, settlement, redemption, bridge backing, or availability guarantees that the protocol actually promises to users.

The practical consequence is uncomfortable but useful: auditors should not audit "ERC20 support." They should audit asset semantics.

---

## Scope and evidence model

This article uses "true positive" and "false positive" in the way security contests and bug bounty triage tend to use them, not in a purely mathematical sense.

A **true positive** is a case where the incompatibility either caused a real exploit, was accepted as a meaningful audit finding, or clearly broke a supported economic invariant.

A **false positive** is broader. It includes reports that are technically plausible but invalid, excluded, informational, low severity, duplicate without payout, or not security-relevant under the project's stated support model. Many false positives describe real token behavior. They fail because the asset is out of scope, the impact is only UX/display, the attacker must convince trusted governance to list a malicious token, or the protocol already documented that it does not support that class.

This distinction is not bureaucratic. It is the difference between "this protocol can be drained" and "this protocol would misbehave if it chose to support an asset it explicitly does not support."

Where possible, code links are pinned to fixed commits. Some historical incidents are better documented in postmortems or verified deployed source than in a clean public GitHub commit; those are called out as such.

---

## The weak promise of ERC20

The ERC20 interface is much thinner than most DeFi accounting assumes. Even the most familiar properties are not universal:

- `decimals()` is metadata and display logic, not arithmetic logic.
- `transfer()` and `transferFrom()` may return `false`, return nothing, revert, or succeed while moving less value than requested.
- `approve()` may require zeroing an allowance before setting a new non-zero allowance.
- A transfer may trigger callbacks or hooks.
- A balance can change without the current contract calling `transfer`.
- A token can be paused, upgraded, blacklisted, or implemented behind multiple entrypoints.
- The same economic asset can appear as native currency, an ERC20 representation, a bridged wrapper, a canonical wrapper, or a legacy proxy.

The d-xo `weird-erc20` repository summarizes the point bluntly: the ERC20 "specification" is loosely defined, many semantic expectations are violated in the wild, and robust systems either use an allowlist or isolate token interaction at the edge of the system. It lists fee-on-transfer, rebasing, blocklists, upgradeability, approval race protections, multiple token addresses, low/high decimals, false returns, and non-string metadata as real integration hazards.

Reference: [d-xo/weird-erc20](https://github.com/d-xo/weird-erc20)

OpenZeppelin's ERC20 documentation makes one of the most abused points explicit: decimals are for display only and do not affect contract arithmetic.

Reference: [OpenZeppelin ERC20 docs](https://docs.openzeppelin.com/contracts/5.x/erc20)

The correct mental model is therefore not:

```text
Token implements IERC20, therefore token is safe to integrate.
```

It is:

```text
Token address on chain X has behavior B, and protocol invariant I remains true under B.
```

That shift is the whole game.

---

## The invariant that classifies the bug

Most true positives in this class break one of the following invariants.

### 1. Entitlement cannot exceed controlled assets

```text
sum(user claims) <= assets the protocol can actually transfer out
```

This is the vault, staking, bridge, and lending invariant. Fee-on-transfer, negative rebase, phantom permit, and double-entrypoint behavior all attack it.

### 2. Internal reserve must match executable reserve

```text
pool.reserve[token] == amount the pool can actually use under token semantics
```

This is the AMM invariant. It is fragile when balances are cached, transfers are taxed, balances rebase, or the same asset can be moved through another entrypoint.

### 3. Asset identity must be canonical

```text
economic asset identity != raw token contract address
```

This is the Compound TUSD, Balancer SNX/sBTC, and Uniswap v4 CELO family. The address is a handle, not the asset.

### 4. External calls cannot observe stale accounting

```text
state is safe before token transfer invokes arbitrary external behavior
```

This is the ERC777, ERC1363, AMP, and transfer-hook family. The mistake is treating token transfer as a local state mutation.

### 5. Scaling must preserve units across all domains

```text
amount, price, shares, debt, and TVL use compatible units
```

This is the decimals and cross-chain accounting family. The dangerous bug is not "USDC has 6 decimals." The dangerous bug is using 18-decimal USDC amounts to mint 6-decimal-root-chain shares or value collateral.

### 6. Liveness must not depend on a single censorable recipient

```text
one blocked recipient cannot permanently block unrelated users
```

This is the blacklist, pause, and batch-withdrawal family. The issue becomes security-relevant when a single failing transfer prevents everyone else's withdrawal, liquidation, or settlement.

These invariants explain why the same token fact can be High in one protocol and Informational in another.

---

# Part I. True positives

## 1. Balancer STA: nominal transfer amount was treated as real pool reserve

### Class

Fee-on-transfer / deflationary token.

### Incident

In June 2020, Balancer pools containing STA, a deflationary token with a transfer fee, were exploited. Public postmortems describe the attacker using flash-loaned WETH, repeatedly swapping WETH and STA, exploiting the fact that the pool's internal accounting credited the nominal input amount while the pool actually received less because STA taxed transfers. The attack drained other pool assets such as WETH, WBTC, SNX, and LINK, with losses reported around or above $500,000 depending on source.

References:

- [1inch postmortem: Balancer Pool with STA Deflationary Token Incident](https://medium.com/1inch-network/balancer-hack-2020-a8f7131c980e)
- [CoinDesk coverage](https://www.coindesk.com/markets/2020/06/29/balancer-defi-protocol-loses-500k-in-token-hack/)

Representative code:

- [Balancer v1 `BPool.sol`, pinned commit](https://github.com/balancer/balancer-core/blob/f8264b790b3266891d22b33abbb467970d70e1e9/contracts/BPool.sol)

The vulnerable pattern can be reduced to this:

```solidity
// Pseudocode, not exact source.
recordIn.balance += tokenAmountIn;
recordOut.balance -= tokenAmountOut;

pull(tokenIn, msg.sender, tokenAmountIn);
push(tokenOut, msg.sender, tokenAmountOut);
```

For a vanilla ERC20, `tokenAmountIn` is a usable accounting input. For a transfer-taxed token, it is only the amount requested from the sender. The pool did not receive that much. The reserve variable moved away from the executable reserve.

### Why this was a true positive

This is the canonical true positive because all ingredients align:

1. The affected token was actually in a live pool.
2. The pool used nominal transfer amount in AMM accounting.
3. The token's tax made internal reserve larger than actual reserve.
4. The skewed reserve changed swap pricing.
5. The attacker extracted unrelated assets from the pool.

The issue was not "fee-on-transfer tokens are weird." The issue was "the AMM pricing function consumed a lie."

### The deeper lesson

AMMs are especially sensitive to non-exact transfers because reserves are not bookkeeping decoration. Reserves are the market. Once reserve state diverges from actual executable balances, the pricing function becomes an oracle for the attacker's fiction.

A balance-delta pattern is not an optional compatibility improvement here. It is the only way to know what the pool actually bought:

```solidity
uint256 beforeBalance = token.balanceOf(address(this));
token.safeTransferFrom(msg.sender, address(this), amountIn);
uint256 received = token.balanceOf(address(this)) - beforeBalance;

// Use received, not amountIn.
```

Even this only solves the transfer-tax dimension. It does not solve rebasing, multiple entrypoints, or arbitrary balance mutation.

---

## 2. Nibiru FunToken: fee-on-transfer broke cross-domain backing semantics

### Class

Fee-on-transfer in cross-module / bridge-like asset representation.

### Finding

Code4rena's Nibiru report includes a medium-severity finding where fee-on-transfer ERC20s could break the invariant between an EVM ERC20 representation and the Cosmos bank coin representation. On the path from ERC20 to bank coin, the module used the actual amount received after transfer. On the reverse path, a second fee could be applied, and the burn amount did not line up with the earlier minted representation. The report describes an example where 100 transferred tokens become 95 bank coins, then sending 95 back through the ERC20 side yields 90.25 after another fee, while 90.25 bank coins are burned, leaving 4.75 unbacked bank coins.

Reference:

- [Code4rena Nibiru report, M-02](https://code4rena.com/reports/2024-11-nibiru)

Representative code:

- [Nibiru `funtoken.go`, pinned commit](https://github.com/code-423n4/2024-11-nibiru/blob/84054a4f00fdfefaa8e5849c53eb66851a762319/x/evm/precompile/funtoken.go#L162-L170)
- [Nibiru `msg_server.go`, pinned commit](https://github.com/code-423n4/2024-11-nibiru/blob/84054a4f00fdfefaa8e5849c53eb66851a762319/x/evm/keeper/msg_server.go#L597-L613)
- [Nibiru mitigation PR](https://github.com/NibiruChain/nibiru/pull/2139)

### Why this was a true positive

This case is less sensational than Balancer but more instructive. There was a dispute about exploitability and whether the unburned bank coins were accessible in a way that allowed direct infinite minting. That nuance matters. Still, the finding identified a real invariant break in a protocol whose entire purpose was to preserve equivalence across representations.

A bridge or cross-domain asset module has a stricter invariant than a normal transfer wrapper:

```text
remote minted representation == locally locked or burned backing, after all fees and rounding
```

If a transfer fee is applied once on the way in and again on the way out, the bridge cannot reason in terms of the user-requested amount. It must reason in terms of actual received and actual released amounts, and it must decide which representation absorbs the fee.

### The deeper lesson

Fee-on-transfer becomes more dangerous as soon as the protocol mints a second claim against the asset. An AMM can be drained because pricing is wrong. A bridge can become insolvent because backing is wrong. A lending protocol can generate bad debt because collateral is wrong.

The surface bug is "amount mismatch." The security bug is "claim mismatch."

---

## 3. Numoen: fee-on-transfer caused a real denial-of-service path in a permissionless collateral design

### Class

Fee-on-transfer / collateral support mismatch.

### Finding

Code4rena's Numoen report contains a medium-severity finding titled "Fee on transfer tokens will not behave as expected." The protocol did not restrict the type of ERC20 collateral used for borrowing. If a fee-on-transfer token was used, `mint()` would revert at a balance check because the balance after transfer was less than `balanceBefore + collateral`.

Reference:

- [Code4rena Numoen report, M-01](https://code4rena.com/reports/2023-01-numoen)
- [Issue #263](https://github.com/code-423n4/2023-01-numoen-findings/issues/263)

Representative code:

- [Numoen `Lendgine.sol`, pinned commit](https://github.com/code-423n4/2023-01-numoen/blob/2ad9a73d793ea23a25a381faadc86ae0c8cb5913/src/core/Lendgine.sol#L99)

### Why this was a true positive

This case is not a theft path. It is an availability path. That makes it a useful boundary case.

The reason it was valid is that the protocol did not clearly restrict collateral tokens to a known vanilla subset. In a permissionless or broadly configurable collateral model, an unsupported token behavior is no longer hypothetical. It can become part of the protocol state.

The impact was also concrete: minting could revert for fee-on-transfer collateral, preventing intended use of the market. That is lower impact than draining a pool, but still a real failure mode under the advertised asset model.

### The deeper lesson

Not every true positive needs direct theft. A market that can be created but cannot be used, or can be used until an operation permanently blocks, can still be a meaningful security finding if the protocol claims support for that asset class.

However, availability severity should be calibrated carefully. "This operation reverts for unsupported assets" is not the same as "existing user funds are locked." The strongest version of this finding would show existing funds becoming stuck or critical market operations becoming unavailable after normal user actions.

---

## 4. Uniswap v1 and imBTC: ERC777 turned transfer into reentrancy

### Class

Transfer hook / ERC777 reentrancy.

### Incident

OpenZeppelin publicly analyzed a reentrancy issue affecting Uniswap v1 exchanges that listed ERC777-compatible tokens. The key observation was that Uniswap v1 was built around ERC20 expectations, while nothing prevented an ERC20-compatible token with ERC777 hooks from being registered. The exploit pattern used the `tokensToSend` hook so the attacker could be called after receiving ETH but before the token balance side of the exchange had been updated, allowing reentry under stale pricing conditions.

References:

- [OpenZeppelin, Exploiting Uniswap: from reentrancy to actual profit](https://www.openzeppelin.com/news/exploiting-uniswap-from-reentrancy-to-actual-profit)
- [OpenZeppelin Uniswap ERC777 exploit PoC](https://github.com/OpenZeppelin/exploit-uniswap)

Representative code:

- [Uniswap v1 exchange contract, pinned commit](https://github.com/Uniswap/v1-contracts/blob/c10c08d81d6114f694baa8bd32f555a40f6264da/contracts/uniswap_exchange.vy)

### Why this was a true positive

This is a pure semantics mismatch. The token exposed an ERC20-compatible surface, but its transfer semantics included external calls. The AMM treated transfer as if it could not reenter. That difference was exploitable.

The issue is not "ERC777 is bad." ERC777 was doing what it was designed to do. The integration was wrong because a token transfer was placed in a state transition where reentry could observe a favorable intermediate state.

### The deeper lesson

The right rule is not merely "use `nonReentrant`." The right rule is:

```text
Any token operation must be treated as an untrusted external call, even if the interface says ERC20.
```

That means checks-effects-interactions is not old advice. It is the minimum viable defense for modern token integration.

---

## 5. Lendf.Me and Cream AMP: hooks are catastrophic in lending accounting

### Class

ERC777-like hooks / lending reentrancy.

### Incidents

The Lendf.Me exploit in April 2020 used imBTC, an ERC777 token, after it had been enabled as collateral. Public analyses describe an attacker depositing and using the ERC777 callback to withdraw before the lending protocol's collateral state was safely updated. The attack drained nearly $25 million, although the funds were later returned.

Reference:

- [Quantstamp analysis of the Lendf.Me hack](https://quantstamp.com/blog/what-is-a-re-entrancy-attack-and-how-to-prevent-it)
- [PeckShield root cause analysis](https://peckshield.medium.com/uniswap-lendf-me-hacks-root-cause-and-loss-analysis-50f3263dcc09)

Cream Finance's AMP incident in August 2021 was the same species of bug in a different body. AMP included hook-like behavior. During `borrow`, the token's post-transfer hook could call back into the protocol before the initial borrow state had been updated, allowing repeated borrowing. Halborn's analysis describes the attack as stemming from integration of AMP with ERC777-like behavior and the ability to reenter before state was finalized.

Reference:

- [Halborn analysis of the Cream Finance AMP exploit](https://www.halborn.com/blog/post/explained-the-cream-finance-hack-august-2021)

### Why these were true positives

Lending protocols are particularly vulnerable to hook reentrancy because they maintain multiple linked economic variables:

```text
cash
collateral
borrow balance
exchange rate
liquidity
seize amount
interest index
```

If a hook can reenter while any of those variables reflect a half-completed operation, the attacker is not merely racing a transfer. They are racing the solvency model.

### The deeper lesson

AMM reentrancy often manipulates price. Lending reentrancy manipulates solvency.

A lending protocol that supports hook-enabled tokens must make state safe before external token movement, or isolate token transfers behind wrappers that cannot reenter core accounting. Supporting a hook token as collateral without this discipline is not a weird-token footnote. It is a protocol-level risk decision.

---

## 6. Multichain / AnySwap: phantom permit and the billion-dollar no-op

### Class

Permit incompatibility / phantom function / no-op success.

### Incident

In January 2022, Dedaub disclosed critical vulnerabilities in Multichain, formerly AnySwap. Dedaub described the issue as "Phantom Functions and the Billion-dollar No-op." The vulnerabilities affected router and liquidity pool contracts and involved tokens such as WETH, WBNB, MATIC, AVAX, and others. Multichain's postmortem states that Dedaub alerted the team to two critical vulnerabilities on January 10, 2022, and that affected users who had granted approvals needed to revoke them.

References:

- [Dedaub, Phantom Functions and the Billion-dollar No-op](https://dedaub.com/blog/phantom-functions-and-the-billion-dollar-no-op/)
- [Multichain Contract Vulnerability Post Mortem](https://medium.com/multichainorg/multichain-contract-vulnerability-post-mortem-d37bfab237c8)
- [Multichain critical vulnerability notice](https://medium.com/multichainorg/action-required-critical-vulnerability-for-six-tokens-6b3cbd22bfc0)

Representative vulnerable shape:

```solidity
// Pseudocode.
address underlying = wrappedToken.underlying();
IERC20(underlying).permit(from, address(this), amount, deadline, v, r, s);
safeTransferFrom(underlying, from, wrappedToken, amount);
```

The failure mode is subtle: a call to `permit` can appear successful without actually establishing the intended authorization. This can happen when the target token does not implement the expected permit interface, has fallback behavior, or follows a different permit standard. If the user already approved the vulnerable router, the later `transferFrom` can still succeed, making the fake permit path exploitable.

A public technical walk-through quotes the vulnerable function shape as `anySwapOutUnderlyingWithPermit`, calling `underlying()`, then `permit`, then `safeTransferFrom`.

Reference:

- [Technical walk-through of the Multichain exploit](https://s3cunda.github.io/2022/01/27/multichain-%E5%8E%9Fanyswap-2022.1.18%E6%94%BB%E5%87%BB%E4%BA%8B%E4%BB%B6%E5%88%86%E6%9E%90.html)

### Why this was a true positive

This is not a generic "permit might fail" issue. It was a direct theft risk against users who had already granted approvals. The protocol accepted a call path where "the permit call did not revert" was treated as evidence that the intended approval had been freshly authorized. That semantic leap was false.

A permit is not one thing. There is EIP-2612, DAI-style permit, ERC-3009 authorization, Permit2, token-specific permit variants, fallback behavior, and tokens with no permit at all. Treating them as interchangeable turns authorization into theater.

### The deeper lesson

Authorization code must verify the effect, not the call shape.

A robust pattern is:

```solidity
uint256 beforeAllowance = token.allowance(owner, spender);
tryPermit(...);
uint256 afterAllowance = token.allowance(owner, spender);
require(afterAllowance >= amount || afterAllowance > beforeAllowance, "permit ineffective");
```

Even this is only a sketch. Nonce verification, domain separation, chain ID, spender, deadline, signature type, and token-specific permit semantics must be explicit. The important point is that `permit()` success is not proof of authorization.

---

## 7. Compound TUSD: one economic asset, two entrypoints

### Class

Multiple token addresses / double entrypoint / asset identity failure.

### Incident

OpenZeppelin and ChainSecurity analyzed a critical integration issue involving Compound's TUSD market. TUSD had two entrypoints: the current proxy and a legacy contract that forwarded calls to the current implementation. Compound's `sweepToken` function was designed to allow accidental non-underlying tokens to be swept to the admin, while forbidding sweeping the actual underlying token. The check compared raw token address to the configured `underlying` address.

Because TUSD could be accessed through a legacy entrypoint, the legacy address was not equal to the configured underlying address, but calls through it could still move the same economic asset. OpenZeppelin's report explains that anyone could call `sweepToken` on cTUSD with the legacy contract address, moving all underlying from cTUSD to the Timelock. That would reduce `totalCash`, depress the exchange rate, and allow later suppliers to mint cTUSD at an inflated amount, harming prior suppliers.

References:

- [OpenZeppelin Compound Comprehensive Protocol Audit](https://www.openzeppelin.com/news/compound-comprehensive-protocol-audit)
- [ChainSecurity, TrueUSD and Compound Vulnerability](https://medium.com/chainsecurity/trueusd-compound-vulnerability-bc5b696d29e2)
- [OpenZeppelin Top Hacking Techniques of 2022](https://www.openzeppelin.com/security-audits/top-hacking-techniques-2022)

Representative code:

- [Compound `CErc20.sol` current source, `sweepToken`](https://github.com/compound-finance/compound-protocol/blob/master/contracts/CErc20.sol#L898-L905)

The simplified pattern:

```solidity
require(address(token) != underlying, "cannot sweep underlying");
token.transfer(admin, token.balanceOf(address(this)));
```

That check is safe only if one token address uniquely identifies one economic asset. TUSD violated that assumption.

### Why this was a true positive

The bug broke the identity invariant of a lending market. Compound did not just hold "an address." It held an asset whose cash balance entered the exchange rate formula. Moving the same asset through a second address changed solvency accounting.

This is one of the cleanest examples of the principle:

```text
asset identity is not token address.
```

### The deeper lesson

A rescue function is an asset-management function. It is not harmless admin plumbing. If a rescue function decides what is safe to move using only `token != underlying`, it is vulnerable to any asset that has multiple handles.

Protocols should model canonical asset identity separately from contract address. For known double-entrypoint assets, the denylist must include all equivalent entrypoints, not only the canonical one.

---

## 8. Balancer SNX/sBTC: double-entrypoint can be a liveness bug, not only a theft bug

### Class

Double entrypoint / flash loan accounting / denial of service.

### Finding

Balancer's 2022 double-entrypoint issue affected tokens such as SNX and sBTC. Immunefi's bugfix review describes a medium-severity vulnerability: double-entrypoint ERC20 tokens could create an exploitable denial-of-service scenario through Balancer flash loans. The affected funds were not directly stolen by the attacker, but liquidity involving those tokens could become temporarily inaccessible.

References:

- [Immunefi, Balancer DoS Bugfix Review](https://immunefi.com/blog/bug-fix-reviews/balancer-dos-bugfix-review/)
- [Balancer forum, Medium Severity Bug Found](https://forum.balancer.fi/t/medium-severity-bug-found/3161)
- [ChainSecurity, Denial-of-Service Attacks in DeFi: The Balancer-Synthetix Case](https://www.chainsecurity.com/blog/denial-of-service-attacks-in-defi-the-balancer-synthetix-case)

### Why this was a true positive

The key point is that double-entrypoint issues are not always direct theft. They can corrupt liveness by making the protocol believe a balance or fee exists in a place where operational flows cannot proceed normally.

Balancer's own bug bounty scope has since been explicit that tokens with transfer fees, rebasing supply, streaming mechanics, or multiple entrypoints are not Balancer-compatible. But in this historical case, known double-entrypoint tokens were actually present in affected pools.

Reference:

- [Balancer bug bounty scope](https://immunefi.com/bug-bounty/balancer/information/)

### The deeper lesson

DoS is not a consolation prize. In DeFi, time and availability are economic properties. A liquidation that cannot execute, a pool that cannot rebalance, or a withdrawal path that is blocked can be just as material as a smaller direct theft.

The severity should track what becomes unavailable and for how long, not whether the attacker's wallet receives funds immediately.

---

## 9. Uniswap v4 on Celo: native currency with an ERC20 representation

### Class

Chain-specific native/ERC20 dual representation.

### Finding

OpenZeppelin's Uniswap v4 core audit reported a critical issue: on chains where the native currency has an ERC20 representation, the ERC20 representation could be used to drain native currency pools. The audit specifically discussed Celo's CELO representation and mentioned Polygon MATIC and zkSync Era ETH as related examples with caveats.

The vulnerable mechanism involved Uniswap v4's flash accounting model. `settle` had two flows: native currency settlement used `msg.value`, while ERC20 settlement used balance differences after `sync`. On Celo, native CELO and ERC20 CELO are the same economic asset. An attacker could deposit 1000 CELO as native, then settle the ERC20 representation based on the same balance increase, creating 2000 CELO worth of deltas for only 1000 CELO. The attacker could then `take` through both representations and profit.

References:

- [OpenZeppelin, Uniswap v4 Core Audit](https://www.openzeppelin.com/news/uniswap-v4-core-audit)
- [Certora, Uniswap v4 Critical Edge-Chain Issue](https://www.certora.com/blog/uniswap-v4-critical-edge-chain-issue)

Representative code:

- [Uniswap v4 core scope, pinned commit](https://github.com/Uniswap/v4-core/tree/d5d4957b35750e8cf1f3db5584e77eef4861c21e)
- [Uniswap v4 `PoolManager.sol`, pinned commit](https://github.com/Uniswap/v4-core/blob/d5d4957b35750e8cf1f3db5584e77eef4861c21e/src/PoolManager.sol)
- [Uniswap v4 fix PR #779](https://github.com/Uniswap/v4-core/pull/779)

### Why this was a true positive

This is not a standard weird-ERC20 report. In fact, the OpenZeppelin audit explicitly notes that non-standard ERC20s such as double-entrypoint ERC20s were not supported by Uniswap v4. The critical issue was different: native tokens were supported, and on Celo the native token had a corresponding ERC20 representation.

That distinction is the heart of the severity:

```text
Unsupported double-entrypoint ERC20: usually invalid for Uniswap v4 core.
Supported native currency on a chain where native currency has an ERC20 handle: critical.
```

### The deeper lesson

Chain semantics are part of the asset. Mainnet ETH assumptions do not automatically port to Celo, Polygon, zkSync Era, Blast, or any future L2 with modified native-asset behavior.

A protocol with native-token support must define native-token identity per chain, not globally. The invariant is no longer "native token is address zero." The invariant is "this chain has one canonical settlement identity for this economic asset."

---

## 10. NOYA: cross-chain USDC and USDT decimals broke TVL accounting

### Class

Decimals mismatch / cross-chain unit mismatch.

### Finding

Code4rena's NOYA report includes a high-severity finding: base tokens like USDT and USDC could have different decimals on different chains, causing TVL to be updated incorrectly. The report describes USDT and USDC on BSC using 18 decimals while the Base chain root/base chain uses 6 decimals. TVL was sent cross-chain and recorded on the base chain without scaling down, causing accounting to be off by `1e12` in affected cases.

Reference:

- [Code4rena NOYA report, H-02](https://code4rena.com/reports/2024-04-noya)

Representative code:

- [NOYA `OmnichainManagerNormalChain.sol`, pinned commit](https://github.com/code-423n4/2024-04-noya/blob/9c79b332eff82011dcfa1e8fd51bad805159d758/contracts/helpers/OmniChainHandler/OmnichainManagerNormalChain.sol#L363-L367)
- [NOYA `OmnichainManagerBaseChain.sol`, pinned commit](https://github.com/code-423n4/2024-04-noya/blob/9c79b332eff82011dcfa1e8fd51bad805159d758/contracts/helpers/OmniChainHandler/OmnichainManagerBaseChain.sol)

### Why this was a true positive

This is the most practical decimals lesson: the problem is not that USDC has 6 decimals. Everyone knows that. The problem is that the same asset symbol across chains was moved into a root-chain accounting system without binding amount to the source chain's unit.

The affected value was not UI display. It fed `totalAssets()` and ERC4626-style share operations. That means a unit error could change minting, redemption, share price, TVL, and strategy accounting.

### The deeper lesson

Decimals bugs become security bugs when they cross into accounting. They are low severity when they only affect display. They are high severity when they change the number of claims minted against assets.

Cross-chain protocols need a unit schema:

```text
(chainId, token address, canonical asset id, token decimals, oracle decimals, accounting decimals)
```

A bare `amount` in a cross-chain message is incomplete data.

---

## 11. NOYA: one blacklisted recipient could block a withdrawal queue

### Class

Blacklist / transfer failure / batch liveness.

### Finding

The same NOYA report includes a high-severity finding where `executeWithdraw` could be blocked if any user in a withdrawal queue was blacklisted from the base token. The report notes that USDC and USDT have admin-controlled blocklists. If a blocked recipient was included in a withdrawal queue, the transfer to that recipient could revert and prevent other users in the same queue from withdrawing.

Reference:

- [Code4rena NOYA report, H-04](https://code4rena.com/reports/2024-04-noya)
- [Circle USDC risk factors, blacklisting](https://www.circle.com/legal/usdc-risk-factors)
- [d-xo/weird-erc20, tokens with blocklists](https://github.com/d-xo/weird-erc20#tokens-with-blocklists)

Representative code:

- [NOYA `AccountingManager.sol`, source link from report](https://github.com/code-423n4/2024-04-noya/blob/main/contracts/accountingManager/AccountingManager.sol)

### Why this was a true positive

Generic "USDC has a blacklist" is usually not enough. Here, the issue had a protocol path: one blocked user could cause a batch operation to revert and deny withdrawals to unrelated users.

That converts a centralized-stablecoin property into a protocol liveness failure.

### The deeper lesson

Blacklist-aware design is not about preventing Circle or Tether from exercising legal controls. A protocol cannot control the issuer. The protocol can control whether one blocked address blocks everyone else.

Safer patterns include per-user claims, pull-based withdrawals, recipient replacement, skip-and-retry logic, cancellation paths, or isolated batches. The exact choice depends on the protocol, but the invariant should be clear:

```text
A transfer failure to user A must not destroy user B's exit path.
```

---

# Part II. False positives and low-value reports

False positives in this domain are rarely nonsense. They usually describe real token behavior, but the behavior is outside the protocol's security boundary. This is why many weak reports feel convincing on first read. They are technically true and economically irrelevant.

## 1. Amun: fee-on-transfer reported as low, not a high-impact bug

### Class

Fee-on-transfer, but weak impact/scope.

### Finding

In the Code4rena Amun report, "Token with fee on transfer not supported" appears under Low Risk. The report notes that some ERC20 tokens take a transfer fee and that the implementation assumed the received amount matched the requested transfer amount.

References:

- [Code4rena Amun report, L-12](https://code4rena.com/reports/2021-12-amun)
- [Amun finding issue #220](https://github.com/code-423n4/2021-12-amun-findings/issues/220)

Representative code:

- [Amun `BasketFacet.sol`, pinned commit](https://github.com/code-423n4/2021-12-amun/blob/98f6e2ff91f5fcebc0489f5871183566feaec307/contracts/basket/contracts/facets/Basket/BasketFacet.sol#L162-L167)

### Why this was not a strong true positive

The technical observation is the same family as Balancer STA: nominal amount may differ from received amount. But the context was different. The report did not establish the same exploit path: no demonstrated pool drain, no permissionless listing impact at Balancer scale, no concrete bad debt or unbacked minting path.

This is the severity lesson:

```text
Same root cause does not imply same severity.
```

Fee-on-transfer mismatch is high when it lets an attacker mint excess claims or distort pricing. It is low when it merely means a category of unsupported tokens will not integrate cleanly.

### The reviewer's instinct

When reading a fee-on-transfer report, ask:

1. Is the token supported or permissionlessly listable?
2. Does the protocol credit the sender by `amount` instead of `received`?
3. Can that excess credit be redeemed against other users or other assets?
4. Is there a path to repeat, amplify, or create bad debt?

If the answer stops at step 2, the report is usually low.

---

## 2. "USDC can blacklist addresses" without a protocol path

### Class

Blacklist / centralization risk.

### False-positive shape

A common report says:

```text
USDC has a blacklist. If USDC blacklists the protocol or a user, transfers can fail.
```

This statement is factually true. Circle's public risk factors state that it reserves the right to block transfers of USDC to and from an on-chain address in extraordinary circumstances. The d-xo weird-erc20 list also documents USDC and USDT blocklists.

References:

- [Circle USDC risk factors](https://www.circle.com/legal/usdc-risk-factors)
- [d-xo/weird-erc20, tokens with blocklists](https://github.com/d-xo/weird-erc20#tokens-with-blocklists)

### Why it is often low or informational

The report becomes weak if it does not show a protocol-level consequence beyond the known issuer risk. A stablecoin issuer freezing an address is not automatically a bug in every protocol that supports that stablecoin.

The report becomes stronger when it identifies one of these concrete paths:

- a blacklisted user blocks an entire withdrawal queue;
- a liquidator cannot complete liquidation, allowing bad debt to grow;
- an auction cannot settle and collateral becomes stuck;
- a bridge cannot release funds but continues to mint claims;
- a protocol routes all exits through one receiver that may become blocked;
- there is no alternate recipient, retry, cancel, or claim mechanism.

NOYA H-04 is the true-positive version. The generic statement is not.

### The reviewer's instinct

Blacklist is not enough. Show the liveness dependency.

---

## 3. "The protocol breaks with malicious ERC20" when the token must be governance-listed

### Class

Unsupported malicious token / governance assumption.

### False-positive shape

A report says:

```text
An attacker can deploy a token that reenters, charges transfer fees, changes decimals, returns false, or lies about balances. If governance lists it, the protocol breaks.
```

This usually fails because the attacker is not the one who can add the asset. The attack depends on trusted governance making a bad listing decision, which is normally out of scope unless the protocol explicitly claims permissionless listing or arbitrary token support.

Code4rena's severity guidance states that non-standard/weird ERC20 and fee-on-transfer findings are out of scope unless the token is explicitly listed as supported, with USDT treated specially as in-scope due to its common non-standard behavior. Sherlock's judging rules similarly place heavy weight on README scope and contest-specific documentation.

References:

- [Code4rena severity categorization](https://docs.code4rena.com/competitions/severity-categorization)
- [Sherlock issue validity guidelines](https://docs.sherlock.xyz/audits/judging/guidelines)

### When this becomes true

The same report becomes valid if any of these are true:

- anyone can create a market for any ERC20;
- anyone can create a pool and the core protocol promises containment but not total immunity;
- the README says "all ERC20 tokens are supported";
- the token is already in the supported list;
- the token is a common exception such as USDT and the contest explicitly treats it as in scope;
- the protocol deploys to a chain where the native asset itself has the surprising behavior.

### The reviewer's instinct

The first severity question is not "can I design a malicious token?" It is "can the attacker get this token into the trusted accounting system without crossing a trusted-governance assumption?"

---

## 4. Axis Finance on Blast: technically plausible rebasing-yield issue, excluded by judging

### Class

Rebasing/yield-bearing chain behavior, but disputed/excluded.

### Finding shape

Sherlock's Axis Finance judging repository includes issues arguing that WETH and USDB yield in a `BlastLinearVesting` or `LinearVesting` contract would be lost or not claimable. Blast's documentation describes native yield and rebasing behavior, and the report argued that automatic yield would accrue in the vesting contract without a claim path.

References:

- [Sherlock Axis Finance issue #48](https://github.com/sherlock-audit/2024-03-axis-finance-judging/issues/48)
- [Sherlock Axis Finance issue #156](https://github.com/sherlock-audit/2024-03-axis-finance-judging/issues/156)
- [Blast ETH yield documentation](https://metalayerlabs.mintlify.app/building/guides/eth-yield)

The primary issue was labeled Excluded, Non-Reward, and Sponsor Disputed. A duplicate was also Non-Reward.

### Why this is a useful false-positive example

The underlying chain fact is real: Blast modifies ETH yield semantics, and USDB/WETH-style assets can have yield modes. The report still did not clear the contest's validity bar.

Why? Because a valid rebasing/yield report must identify a promised entitlement or invariant that is broken. "Yield exists" is not enough. "The protocol owner accrues yield" may be an intended design. "The likelihood of this token being used as the base token is low" can reduce or eliminate practical impact. "Extra balances remain in the contract" is not automatically user loss unless the users were entitled to those balances.

### The true-positive version

A rebasing/yield issue becomes real when the protocol explicitly promises a yield recipient and the implementation routes yield elsewhere, loses it, or lets a final actor capture it. For example:

```text
Protocol says: rebases belong to auction sellers.
Implementation: rebases accumulate in a module with no claim path.
Impact: sellers receive less than promised while another party can recover or strand the yield.
```

Without that entitlement, the report is often an accounting note, not a security bug.

### The reviewer's instinct

For rebasing/yield assets, ask: whose yield is it?

If the answer is undefined, the finding may be a product/design ambiguity. If the answer is defined and the code violates it, the finding becomes security-relevant.

---

## 5. Decimals reports that only affect display

### Class

Decimals / metadata.

### False-positive shape

A report says:

```text
The protocol assumes 18 decimals, but USDC has 6 decimals.
```

This is incomplete. Decimals are display metadata. OpenZeppelin states that decimals do not affect the arithmetic of ERC20 balances or transfers. A protocol can safely support a 6-decimal token if all its internal accounting, oracle scaling, share calculations, and UI conversions handle units consistently.

Reference:

- [OpenZeppelin ERC20 decimals note](https://docs.openzeppelin.com/contracts/5.x/erc20)

### When it becomes true

Decimals become high severity when they affect economic accounting:

- shares minted per deposit;
- collateral valuation;
- debt valuation;
- liquidation thresholds;
- bridge mint/burn normalization;
- oracle price scaling;
- TVL used for vault share price;
- reward distribution per token;
- minimum deposit or dust thresholds that block common assets.

NOYA H-02 is a true positive because the unit mismatch fed `totalAssets()` and vault operations. A front-end display mismatch is not.

### The reviewer's instinct

Ask whether the wrong unit changes a claim, a price, or a threshold. If it does not, it is probably not security severity.

---

## 6. "approve is unsafe" without a supported USDT-like path

### Class

Approval race / USDT zero-first requirement.

### False-positive shape

A report says:

```text
The contract uses approve. approve has a race condition. Also USDT requires setting allowance to zero first.
```

This often collapses multiple issues into one vague claim. The classic approve race is well known and frequently considered informational in contests. The USDT-style zero-first behavior is different: some tokens such as USDT and KNC do not allow changing a non-zero allowance directly to another non-zero allowance.

Reference:

- [d-xo/weird-erc20, approval race protections](https://github.com/d-xo/weird-erc20#approval-race-protections)

### When it becomes true

The report becomes meaningful when:

- the protocol supports USDT or a zero-first token;
- the code repeatedly sets non-zero allowances for routers, strategies, or connectors;
- a revert blocks deposit, withdrawal, rebalance, liquidation, or settlement;
- existing positions become stuck or core automation fails.

It is weak when the code approves once at initialization, sets allowance to zero before changing it, uses OpenZeppelin `forceApprove`, or does not support USDT-like assets.

### The reviewer's instinct

Do not report "approve is bad." Report the exact allowance state transition and the core function that fails because of it.

---

## 7. Missing return value reports against code that already uses SafeERC20

### Class

Missing return / false return / no revert.

### False-positive shape

A report says:

```text
Some ERC20 tokens do not return a bool, so token transfers may fail.
```

This is true in the abstract. It is weak if the protocol already uses a wrapper that handles optional return values and reverts on false returns.

Secure Contracts' token integration guidance and the weird-erc20 repository both document tokens that return false or do not return values. But modern code using OpenZeppelin `SafeERC20` has already addressed the common missing-return case.

References:

- [Secure Contracts, known non-standard tokens](https://secure-contracts.com/development-guidelines/token_integration.html)
- [d-xo/weird-erc20, no revert on failure](https://github.com/d-xo/weird-erc20#no-revert-on-failure)

### When it becomes true

It becomes valid when:

- the protocol supports USDT-like or no-return tokens;
- the code uses raw `IERC20.transfer` or `IERC20.transferFrom` in a way that expects a strict ABI-encoded bool;
- a failure is treated as success, or a no-return token causes an unintended revert;
- the affected path is core: deposits, exits, cross-chain sends, settlement, liquidation, rescue.

### The reviewer's instinct

The finding should name the exact token behavior, exact call site, and exact consequence. "Use SafeERC20" is a recommendation, not an impact demonstration.

---

## 8. Double-entrypoint reports against explicitly unsupported weird ERC20s

### Class

Multiple entrypoints / unsupported token class.

### False-positive shape

A report says:

```text
A double-entrypoint ERC20 can break the pool.
```

This may be true for a hypothetical pool, but false as a valid report when the protocol explicitly does not support double-entrypoint ERC20s. Uniswap v4's OpenZeppelin audit is the perfect boundary example. The audit says non-standard ERC20s, including double-entrypoint tokens, are not supported. The critical finding was not about supporting arbitrary double-entrypoint ERC20s. It was about native-token support on chains where the native token has an ERC20 representation.

Reference:

- [OpenZeppelin, Uniswap v4 Core Audit](https://www.openzeppelin.com/news/uniswap-v4-core-audit)

### Why the distinction matters

Two claims look similar but have opposite validity:

```text
Invalid or low: If someone creates a pool with an unsupported double-entrypoint ERC20, the pool may break.

Critical: The protocol supports native currency, and this chain's native currency is also exposed as an ERC20, allowing the same deposit to settle twice.
```

The first asks the protocol to support an asset it rejects. The second uses a supported asset path.

### The reviewer's instinct

Do not classify by surface resemblance. Classify by support boundary.

---

# Part III. The severity framework

A token/chain incompatibility report should pass five gates.

## Gate 1. Is the asset behavior in scope?

The report is strong when:

- the asset is explicitly supported;
- the protocol says it supports all ERC20 tokens;
- the market/pool/vault is permissionless;
- the chain itself imposes the behavior on native or canonical assets;
- the behavior belongs to USDT or another specifically included exception.

The report is weak when:

- the README excludes weird ERC20s;
- the asset is governance-listed and the attack assumes malicious governance;
- the token must be attacker-created and then trusted by admin;
- the protocol only supports a small fixed allowlist that does not include the behavior.

This is why severity documentation matters. Code4rena's current guidance treats non-standard/weird ERC20 and fee-on-transfer findings as out of scope unless explicitly supported, with USDT considered in scope. Balancer's bug bounty information similarly defines Balancer-compatible ERC20 behavior as exact transfers and balances changing only through transfers, excluding non-standard ERC20s from scope.

References:

- [Code4rena severity categorization](https://docs.code4rena.com/competitions/severity-categorization)
- [Balancer Immunefi bug bounty information](https://immunefi.com/bug-bounty/balancer/information/)

## Gate 2. What assumption does the protocol make?

Common hidden assumptions include:

```text
transfer moves exactly amount
transfer cannot reenter
balance changes only because this contract transfers
balanceOf is stable within accounting windows
decimals is 18
permit is EIP-2612
approve can change non-zero to non-zero
token address uniquely identifies the asset
native token cannot also be an ERC20
recipient transfer will not be blocked
```

A good report names the assumption precisely. A weak report lists weird-token trivia.

## Gate 3. Does the assumption enter economic state?

The finding becomes serious when the assumption affects:

```text
shares
LP supply
collateral credit
debt
exchange rate
reserve accounting
oracle value
TVL
bridge mint amount
withdrawal entitlement
reward entitlement
liquidation eligibility
```

If the assumption only affects display, metadata, analytics, or a non-critical helper, severity usually drops.

## Gate 4. Can the behavior be triggered by an attacker or normal counterparty?

The finding is stronger when the trigger is:

- a normal deposit or withdrawal;
- a supported token transfer;
- a public pool creation path;
- a flash loan or swap path;
- a normal cross-chain message;
- an issuer action that affects a live supported asset;
- a chain-level behavior that always exists.

The finding is weaker when it requires:

- malicious governance;
- token issuer malice outside the protocol threat model;
- a token that is never supported;
- unrealistic balances or chain configurations;
- a user voluntarily harming only themselves.

## Gate 5. What is the actual damage?

High-impact outcomes include:

```text
drain other users' assets
mint unbacked claims
borrow against fake collateral
create bad debt
permanently or long-term block withdrawals
block liquidations or auctions
misprice shares or LP tokens
capture yield owed to others
break bridge solvency
```

Low-impact outcomes include:

```text
one unsupported token reverts
front-end display wrong
metadata unreadable
user loses fee they voluntarily paid
admin rescue required for unsupported asset
known centralization risk with no protocol amplification
```

The most reliable severity language ties the incompatibility to a broken invariant, not to token weirdness itself.

---

# Part IV. Taxonomy of known cases

The following taxonomy is a compact map of the token and chain incompatibility surface. It is not a list of every duplicate contest issue ever filed. It is a coverage map of the known classes that repeatedly produce real findings.

## Transfer amount differs from received amount

Examples:

- fee-on-transfer;
- deflationary transfer;
- tax tokens;
- reflection tokens;
- Solana Token-2022 transfer fees.

High-risk contexts:

- AMMs;
- vault shares;
- lending collateral;
- bridge lock-and-mint;
- staking receipts;
- rewards based on deposit amount.

Canonical true positives:

- Balancer STA;
- Nibiru FunToken;
- many medium findings where permissionless markets credit nominal amount.

False-positive boundary:

- token not supported;
- user only receives less because they chose a taxed token;
- code already uses balance deltas;
- no claim against other users is created.

## Balance changes without transfer

Examples:

- rebasing tokens;
- yield-bearing wrappers;
- reflection tokens;
- airdrops;
- Blast native yield and USDB/WETH yield modes;
- tokens that can be minted or burned externally.

High-risk contexts:

- vault accounting;
- vesting;
- escrow;
- auction proceeds;
- bridge backing;
- AMM cached reserves;
- lending collateral.

False-positive boundary:

- no defined yield entitlement;
- extra balances intentionally accrue to protocol;
- protocol excludes rebasing tokens;
- the report cannot show who loses.

Blast documentation is a good reminder that chain-level behavior can alter asset semantics, not merely token contracts.

Reference:

- [Blast ETH yield documentation](https://metalayerlabs.mintlify.app/building/guides/eth-yield)

## Transfer invokes external code

Examples:

- ERC777 hooks;
- ERC1363 callbacks;
- ERC677 `transferAndCall`;
- AMP-like hooks;
- Solana Token-2022 transfer hooks.

High-risk contexts:

- lending borrow/repay;
- deposit before state update;
- withdraw before burn;
- AMM swap before reserve sync;
- reward claim before zeroing;
- auction settlement.

Canonical true positives:

- Uniswap v1 imBTC;
- Lendf.Me imBTC;
- Cream AMP.

False-positive boundary:

- supported assets cannot hook;
- state is updated before transfer;
- `nonReentrant` and phase locks protect the path;
- the token is malicious and out of scope.

Solana Token-2022 makes this class especially explicit. The transfer hook extension allows a mint-configured program to be called on transfer. Token-2022 also supports transfer-fee extensions, and some extensions are incompatible with each other.

References:

- [Solana Token Extensions](https://solana.com/docs/tokens/extensions)
- [Solana Transfer Fees](https://solana.com/docs/tokens/extensions/transfer-fees)
- [Neodyme, Token-2022 transfer hooks](https://neodyme.io/en/blog/token-2022)

## Return values and revert behavior differ

Examples:

- no return value;
- returns false instead of reverting;
- does not revert on failure;
- metadata returns `bytes32` rather than `string`.

High-risk contexts:

- supported USDT-like tokens;
- cross-chain transfer functions;
- settlement paths;
- vesting withdrawals;
- rescue flows;
- batch payouts.

False-positive boundary:

- `SafeERC20` or equivalent wrapper already handles it;
- only UI metadata breaks;
- token not supported.

## Approval and permit semantics differ

Examples:

- USDT/KNC zero-first approve;
- DAI-style permit;
- EIP-2612 permit;
- ERC-3009 authorization;
- Permit2;
- fallback/no-op permit;
- domain separator or chain ID mismatch.

High-risk contexts:

- routers;
- bridges;
- permit-and-transfer flows;
- strategy allowance resets;
- cross-chain messages carrying signatures.

Canonical true positive:

- Multichain / AnySwap phantom permit.

False-positive boundary:

- one-time approval;
- no supported zero-first token;
- permit result is checked;
- allowance/nonce is verified;
- classic approve race without protocol-specific impact.

## Decimals and units differ

Examples:

- USDC/USDT 6 decimals on many chains;
- WBTC 8 decimals;
- high decimals above 18;
- chain-specific same-symbol decimals differences;
- oracle decimals mismatch;
- bridge normalization dust.

High-risk contexts:

- `totalAssets()`;
- ERC4626 share math;
- collateral valuation;
- debt valuation;
- liquidation threshold;
- bridge mint/burn;
- TVL;
- reward distribution.

Canonical true positive:

- NOYA cross-chain USDC/USDT decimals.

False-positive boundary:

- display-only error;
- fixed allowlist with known decimals;
- asset registry explicitly stores decimals;
- no economic state depends on the wrong unit.

## Blacklist, freeze, pause, and upgradeability

Examples:

- USDC blocklist;
- USDT blocklist;
- RWA/KYC tokens;
- pausable wrapped assets;
- upgradeable token proxies;
- issuer-controlled fee or transfer logic changes.

High-risk contexts:

- batch withdrawals;
- auctions;
- liquidations;
- bridge redemption;
- forced settlement to fixed receiver;
- strategy unwinds;
- rescue paths.

Canonical true positive:

- NOYA withdrawal queue blocked by blacklisted recipient.

False-positive boundary:

- generic centralization risk;
- no protocol-level amplification;
- issuer action outside threat model;
- no supported token affected.

## Multiple entrypoints and multiple representations

Examples:

- TUSD proxy plus legacy forwarder;
- SNX/sBTC double-entrypoint behavior;
- native token plus ERC20 representation;
- bridged token plus canonical token;
- wrapped token plus underlying;
- CCTP native USDC plus older bridge USDC variants.

High-risk contexts:

- rescue/sweep;
- AMM pools;
- flash accounting;
- vault asset identity;
- bridge asset identity;
- oracle mapping;
- collateral allowlists.

Canonical true positives:

- Compound TUSD;
- Balancer SNX/sBTC;
- Uniswap v4 CELO.

False-positive boundary:

- unsupported token class;
- no same-asset path on the target chain;
- canonical mapping already handles aliases;
- no accounting uses address as sole identity.

---

# Part V. A practical audit playbook

## Build an asset semantics matrix

Every serious protocol should maintain a table like this for every supported asset on every supported chain:

```text
chainId
token address
canonical asset id
native, wrapped, bridged, or synthetic
issuer or bridge domain
decimals
oracle feed and oracle decimals
transfer exactness
fee-on-transfer behavior
rebasing or yield mode
hook behavior
blacklist or freeze behavior
pause behavior
upgradeability
permit type
approval constraints
multiple entrypoints
native/ERC20 dual representation
min transfer or dust constraints
known admin roles
known emergency controls
```

This table is not compliance paperwork. It is part of the security model.

## Use balance deltas, but know what they solve

Balance deltas are essential for fee-on-transfer:

```solidity
uint256 beforeBalance = token.balanceOf(address(this));
token.safeTransferFrom(from, address(this), requested);
uint256 received = token.balanceOf(address(this)) - beforeBalance;
```

But balance deltas do not solve everything. They do not prevent hook reentrancy. They do not solve rebasing between accounting checkpoints. They do not identify double-entrypoint aliases. They do not decide who owns yield. They do not fix oracle decimals.

Balance delta is a tool, not a security model.

## Treat token transfer as an external call

The safest default is:

```text
update accounting before outbound transfer
avoid stale state before inbound transfer callbacks
use reentrancy guards or phase locks
avoid calling arbitrary hooks inside unsettled accounting windows
```

For lending protocols, this is non-negotiable. For AMMs, it is still critical. For bridges, it is often the difference between a failed transfer and an unbacked mint.

## Normalize units at the boundary

A protocol should not pass raw amounts across chains without unit metadata. A safe cross-chain message should bind:

```text
source chain
source token
source decimals
canonical asset id
normalized amount
rounding policy
dust policy
destination token
destination decimals
```

If a root chain stores 6-decimal USDC accounting, an 18-decimal child-chain amount must not enter state without conversion.

## Verify effects, not call success

For approvals and permits:

```text
permit call did not revert != allowance exists
approve call did not revert != future approve works
transfer call did not revert != exact amount moved
```

Check the effect that matters:

- allowance increased;
- nonce consumed;
- balance delta changed;
- debt state updated;
- shares minted from received amount;
- bridge backing changed by expected normalized amount.

## Separate asset identity from token address

A robust system should have an asset registry that can express aliases:

```text
canonical asset: CELO
representations:
  - native CELO on Celo
  - ERC20 CELO representation on Celo
```

For rescue functions, `token != underlying` is not enough. For pools, token0 and token1 must not be aliases of the same economic asset unless the pool is deliberately designed for that. For bridges, `symbol == USDC` is never an identity check.

## Design for transfer failure

If supporting blacklistable or pausable assets, never make a batch's success depend on every individual transfer succeeding. Prefer pull-based claims, skip logic, retry queues, replacement recipients, cancellation windows, and isolated settlement.

The best blacklist mitigation is not pretending blacklist risk does not exist. It is preventing one blocked address from becoming a denial-of-service primitive against everyone else.

## Make unsupported assets impossible, not merely undocumented

If a protocol does not support weird ERC20s, that is a valid design decision. But the code should enforce it.

Weak:

```text
README says only vanilla ERC20s.
Anyone can create a market with any ERC20.
```

Strong:

```text
Asset registry controlled by governance.
Listing checklist includes semantics matrix.
Core code enforces allowlist.
Tests include weird-token mocks to prove rejection or containment.
```

Documentation is not a runtime guard.

---

# Part VI. Testing matrix

A serious token-integration test suite should include at least the following mocks:

```text
NoReturnERC20
FalseReturnERC20
FeeOnTransferERC20
DeflationaryERC20
ReflectionERC20
PositiveRebaseERC20
NegativeRebaseERC20
ERC777HookToken
ERC1363CallbackToken
BlacklistableERC20
PausableERC20
UpgradeableBehaviorChangingERC20
USDTApproveERC20
DaiPermitToken
NoOpPermitFallbackToken
Bytes32MetadataToken
NoDecimalsToken
LowDecimals6Token
LowDecimals8Token
HighDecimals24Token
ZeroTransferRevertToken
ZeroApprovalRevertToken
Uint96LimitedToken
MaxAmountSpecialCaseToken
TransferFromSelfConsumesAllowanceToken
DoubleEntryPointToken
NativeRepresentationToken
BridgeWrappedToken
Token2022TransferFeeMock
Token2022TransferHookMock
```

The assertions should not stop at "does not revert." They should check invariants:

```text
sum(user claims) <= controlled assets
totalShares matches entitlement
bridge minted amount equals normalized locked backing
collateral credit equals actual received collateral
oracle value uses correct amount and decimals
withdrawals cannot be blocked by one bad recipient
reentrancy cannot observe stale debt or collateral
rescue cannot move underlying through an alias
native and ERC20 representations cannot double-settle
```

Testing weird tokens is not about supporting every weird token. It is about proving that unsupported behavior cannot silently enter the core.

---

# Conclusion: the asset is the interface

The industry has spent years saying "do not assume ERC20 tokens are standard." That slogan is correct, but no longer precise enough.

The stronger statement is:

```text
The asset is not the interface. The asset is the interface plus its chain-specific semantics,
issuer controls, representation model, unit system, and transfer effects.
```

Balancer STA was not drained because ERC20 was badly named. It was drained because AMM reserves trusted nominal amounts. Lendf.Me and Cream were not exploited because hooks are exotic. They were exploited because lending accounting was visible in an unsafe intermediate state. Multichain was not broken by the idea of permit. It was broken by treating a no-op call as authorization. Compound TUSD, Balancer SNX/sBTC, and Uniswap v4 CELO all point to the same deeper flaw: token address is not asset identity. NOYA's decimals and blacklist findings show that even familiar assets like USDC and USDT become dangerous when cross-chain units or liveness assumptions are wrong.

The best reports in this class do not say "this token is weird." They say:

```text
This supported asset has behavior B.
This protocol assumes not-B.
That assumption enters invariant I.
An attacker or normal counterparty can trigger B.
The result is loss, bad debt, unbacked claims, wrong pricing, or blocked exits.
```

The weakest reports skip the invariant and hope weirdness itself is enough.

The interface lies. The invariant tells the truth.

---

# Source and code index

## Standards and general references

- [ERC20 token standard, EIP-20](https://eips.ethereum.org/EIPS/eip-20)
- [OpenZeppelin ERC20 documentation](https://docs.openzeppelin.com/contracts/5.x/erc20)
- [d-xo/weird-erc20](https://github.com/d-xo/weird-erc20)
- [Secure Contracts, token integration guidance](https://secure-contracts.com/development-guidelines/token_integration.html)
- [Code4rena severity categorization](https://docs.code4rena.com/competitions/severity-categorization)
- [Sherlock issue validity guidelines](https://docs.sherlock.xyz/audits/judging/guidelines)
- [Balancer Immunefi bug bounty information](https://immunefi.com/bug-bounty/balancer/information/)

## True-positive case studies

- Balancer STA incident:
  - [1inch postmortem](https://medium.com/1inch-network/balancer-hack-2020-a8f7131c980e)
  - [CoinDesk coverage](https://www.coindesk.com/markets/2020/06/29/balancer-defi-protocol-loses-500k-in-token-hack/)
  - [Balancer v1 `BPool.sol`, pinned commit](https://github.com/balancer/balancer-core/blob/f8264b790b3266891d22b33abbb467970d70e1e9/contracts/BPool.sol)
- Nibiru fee-on-transfer finding:
  - [Code4rena Nibiru report](https://code4rena.com/reports/2024-11-nibiru)
  - [Nibiru `funtoken.go`, pinned commit](https://github.com/code-423n4/2024-11-nibiru/blob/84054a4f00fdfefaa8e5849c53eb66851a762319/x/evm/precompile/funtoken.go#L162-L170)
  - [Nibiru `msg_server.go`, pinned commit](https://github.com/code-423n4/2024-11-nibiru/blob/84054a4f00fdfefaa8e5849c53eb66851a762319/x/evm/keeper/msg_server.go#L597-L613)
- Numoen fee-on-transfer finding:
  - [Code4rena Numoen report](https://code4rena.com/reports/2023-01-numoen)
  - [Finding issue #263](https://github.com/code-423n4/2023-01-numoen-findings/issues/263)
  - [Numoen `Lendgine.sol`, pinned commit](https://github.com/code-423n4/2023-01-numoen/blob/2ad9a73d793ea23a25a381faadc86ae0c8cb5913/src/core/Lendgine.sol#L99)
- Uniswap v1 ERC777 reentrancy:
  - [OpenZeppelin analysis](https://www.openzeppelin.com/news/exploiting-uniswap-from-reentrancy-to-actual-profit)
  - [OpenZeppelin PoC](https://github.com/OpenZeppelin/exploit-uniswap)
  - [Uniswap v1 exchange, pinned commit](https://github.com/Uniswap/v1-contracts/blob/c10c08d81d6114f694baa8bd32f555a40f6264da/contracts/uniswap_exchange.vy)
- Lendf.Me and Cream AMP:
  - [Quantstamp Lendf.Me explanation](https://quantstamp.com/blog/what-is-a-re-entrancy-attack-and-how-to-prevent-it)
  - [PeckShield Uniswap/Lendf.Me root cause](https://peckshield.medium.com/uniswap-lendf-me-hacks-root-cause-and-loss-analysis-50f3263dcc09)
  - [Halborn Cream Finance AMP explanation](https://www.halborn.com/blog/post/explained-the-cream-finance-hack-august-2021)
- Multichain / AnySwap phantom permit:
  - [Dedaub, Phantom Functions and the Billion-dollar No-op](https://dedaub.com/blog/phantom-functions-and-the-billion-dollar-no-op/)
  - [Multichain postmortem](https://medium.com/multichainorg/multichain-contract-vulnerability-post-mortem-d37bfab237c8)
  - [Multichain critical vulnerability notice](https://medium.com/multichainorg/action-required-critical-vulnerability-for-six-tokens-6b3cbd22bfc0)
  - [Technical walk-through](https://s3cunda.github.io/2022/01/27/multichain-%E5%8E%9Fanyswap-2022.1.18%E6%94%BB%E5%87%BB%E4%BA%8B%E4%BB%B6%E5%88%86%E6%9E%90.html)
- Compound TUSD:
  - [OpenZeppelin Compound audit](https://www.openzeppelin.com/news/compound-comprehensive-protocol-audit)
  - [ChainSecurity TUSD and Compound vulnerability](https://medium.com/chainsecurity/trueusd-compound-vulnerability-bc5b696d29e2)
  - [Compound `CErc20.sol`, `sweepToken`](https://github.com/compound-finance/compound-protocol/blob/master/contracts/CErc20.sol#L898-L905)
- Balancer SNX/sBTC double-entrypoint:
  - [Immunefi Balancer DoS Bugfix Review](https://immunefi.com/blog/bug-fix-reviews/balancer-dos-bugfix-review/)
  - [Balancer forum post](https://forum.balancer.fi/t/medium-severity-bug-found/3161)
  - [ChainSecurity Balancer-Synthetix DoS case](https://www.chainsecurity.com/blog/denial-of-service-attacks-in-defi-the-balancer-synthetix-case)
- Uniswap v4 native/ERC20 representation:
  - [OpenZeppelin Uniswap v4 Core Audit](https://www.openzeppelin.com/news/uniswap-v4-core-audit)
  - [Certora analysis](https://www.certora.com/blog/uniswap-v4-critical-edge-chain-issue)
  - [Uniswap v4 core, pinned commit](https://github.com/Uniswap/v4-core/tree/d5d4957b35750e8cf1f3db5584e77eef4861c21e)
  - [Uniswap v4 fix PR #779](https://github.com/Uniswap/v4-core/pull/779)
- NOYA decimals and blacklist findings:
  - [Code4rena NOYA report](https://code4rena.com/reports/2024-04-noya)
  - [NOYA normal-chain manager, pinned commit](https://github.com/code-423n4/2024-04-noya/blob/9c79b332eff82011dcfa1e8fd51bad805159d758/contracts/helpers/OmniChainHandler/OmnichainManagerNormalChain.sol#L363-L367)
  - [NOYA base-chain manager, pinned commit](https://github.com/code-423n4/2024-04-noya/blob/9c79b332eff82011dcfa1e8fd51bad805159d758/contracts/helpers/OmniChainHandler/OmnichainManagerBaseChain.sol)
  - [Circle USDC risk factors](https://www.circle.com/legal/usdc-risk-factors)

## False-positive and boundary examples

- Amun fee-on-transfer low-risk finding:
  - [Code4rena Amun report](https://code4rena.com/reports/2021-12-amun)
  - [Amun issue #220](https://github.com/code-423n4/2021-12-amun-findings/issues/220)
  - [Amun `BasketFacet.sol`, pinned commit](https://github.com/code-423n4/2021-12-amun/blob/98f6e2ff91f5fcebc0489f5871183566feaec307/contracts/basket/contracts/facets/Basket/BasketFacet.sol#L162-L167)
- Axis Finance Blast rebasing-yield excluded issues:
  - [Sherlock Axis issue #48](https://github.com/sherlock-audit/2024-03-axis-finance-judging/issues/48)
  - [Sherlock Axis issue #156](https://github.com/sherlock-audit/2024-03-axis-finance-judging/issues/156)
- Blast documentation:
  - [Blast ETH yield documentation](https://metalayerlabs.mintlify.app/building/guides/eth-yield)
- Solana Token-2022 references:
  - [Solana Token Extensions](https://solana.com/docs/tokens/extensions)
  - [Solana Transfer Fees](https://solana.com/docs/tokens/extensions/transfer-fees)
  - [Neodyme Token-2022 article](https://neodyme.io/en/blog/token-2022)
