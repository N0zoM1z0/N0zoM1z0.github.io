---
title: "Auditing Jolt: Where zkVM Performance Tricks Meet Security Reality"
date: "2026-05-09"
slug: "jolt-audit"
categories:
  - ZK
  - Security Research
  - Audits
tags:
  - zkvm
  - jolt
  - audit
---

# Auditing Jolt: Where zkVM Performance Tricks Meet Security Reality

*In zk systems, every shortcut becomes part of the threat model.*

## Introduction

Jolt is one of the more interesting zkVMs to read closely because it is not trying to hide its design tradeoffs.

At a high level, Jolt takes a pragmatic view of zk execution. It starts from a familiar RISC-V model, leans heavily on rewriting and expansion to make execution more proof-friendly, and uses advice and inline machinery to keep expensive operations tractable inside the proving system. That makes the architecture approachable, but it also creates a very specific kind of security surface: the most important bugs are often not in any one component by itself, but in the seams between emulation, trace construction, witness generation, and verification.

That design is also what makes Jolt worth auditing.

If a zkVM stays close to a conventional ISA while introducing aggressive internal rewrites, two questions immediately matter:

- does the proved execution still mean the same thing as the ISA-level execution?
- are all prover-controlled shortcuts actually bound tightly enough by the proved computation?

And once a backend becomes more elaborate, a third question appears:

- is verification really a pure function of the proof and the public statement, or does it quietly depend on ambient process state?

This post is a technical write-up of our audit work on `a16z/jolt`, focused on the most severe findings called out in the public review material around the April 2026 codebase. Our target was Jolt `main` at commit `60c75c56d30ff2c080d2917ecd93f885e0878e79`, and the source links below are pinned to that exact revision.

We initially focused on four findings that stood out as the strongest candidates for meaningful prover or verifier failures:

1. `Jump-to-NoOp` underconstraining terminal jump rows
2. `load rd=x0` being rewritten into a non-faulting no-op on the trace path
3. Dory verification depending on mutable global layout state
4. Forged Fake-GLV advice breaking the P-256 ECDSA verification flow

The final picture was mixed in a useful way:

- Three findings were real security issues and were fixed by the Jolt team.
- One finding was real as a low-level underconstraint, but after deeper analysis it did not rise to a security bug under Jolt's accepted threat model and statement semantics.

That last part matters. In zk systems, the line between "this relation is looser than it should be" and "this can change the public meaning of an accepted proof" is the line between an interesting boundary condition and an actual security bug.

## Scope and Audit Strategy

This was not approached as a broad codebase tour. It was treated as a focused exploitation and validation exercise.

The goal was not to restate review findings in different words. The goal was to answer a harder question:

> Can this candidate issue be turned into a convincing proof-of-concept that demonstrates real impact at the right layer?

For zkVMs, "the right layer" is everything.

A row-level inconsistency is not the same as a relation-level inconsistency. A relation-level inconsistency is not the same as a prover-level exploit. A prover-level exploit is not the same as an accepted proof whose public outputs or panic bit can be maliciously changed.

For each candidate, the goal was simple: move from a local inconsistency toward the highest-impact layer the evidence would support, and stop exactly where the claim stopped being justified. That made it much easier to separate the three real security findings from the one finding that looked dangerous at first glance but did not survive deeper impact analysis.

## Why Jolt Was an Interesting Target

Jolt sits at the intersection of several sharp security boundaries:

- It emulates a RISC-V execution model.
- It rewrites and expands instructions into proving-friendly forms.
- It relies on runtime advice and inline operations.
- It uses a nontrivial backend proving and verification pipeline, including Dory-based components.

That combination creates three recurring audit questions:

1. Does the proved execution still mean the same thing as the ISA-level execution?
2. Are prover-controlled values really bound tightly enough inside the proved computation?
3. Is verification a pure function of the proof, public statement, and verifier setup?

The three confirmed security bugs landed almost perfectly on those three themes.

## Finding 1: Jump-to-NoOp Was Real, But Not a Security Bug

The first candidate issue lived at the control-flow boundary between a jump instruction and padded `NoOp` rows.

At the local relation level, the problem was real. Jolt guarded the jump target check with:

```text
ShouldJump = Jump * (1 - NextIsNoop)
```

That means the intended constraint

```text
NextUnexpandedPC == LookupOutput
```

is skipped when a jump is immediately followed by a padded `NoOp`.

That is not just a theoretical edge case. It is reachable in normal proving because Jolt lowers `EBREAK` into a self-jump at the termination boundary, and that row sits directly in front of padding.

Relevant source:

- [`jolt-core/src/zkvm/r1cs/inputs.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/jolt-core/src/zkvm/r1cs/inputs.rs#L337-L343)
- [`jolt-core/src/zkvm/r1cs/constraints.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/jolt-core/src/zkvm/r1cs/constraints.rs#L351-L359)
- [`tracer/src/instruction/ebreak.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/tracer/src/instruction/ebreak.rs#L37-L58)

We validated this in three increasingly concrete ways:

- a crafted row-level witness passed the relevant constraints even when `next_unexpanded_pc` was neither the jump target nor the normal fallthrough;
- the repository's own `z3-verifier` harness admitted multiple satisfying witnesses at the `Jump && NextIsNoop` boundary;
- an accepted end-to-end proof contained a malformed terminal jump row.

At that point, the finding looked serious.

But the right question was not "is there underconstraint?" The right question was "can a malicious prover use it to change the meaning of an accepted proof?"

That is where the story changed.

When we pushed further and tried to turn this boundary issue into a stronger forged execution, the verifier rejected the malicious extension. The Jolt team's response was also technically sound: they explicitly tolerate some malleability in the padded execution tail as long as the malicious prover cannot alter the claimed outputs or panic state. After re-checking the relevant control-flow and termination behavior, that analysis held up.

So the final assessment was:

- the underconstraint is real;
- the accepted proof does contain a malformed terminal row;
- but under Jolt's statement semantics and padding design, this did not rise to a practical security issue.

This finding ended up being valuable anyway, because it forced a careful distinction between an internal invariant failure and a public-statement break. That distinction is central to serious zk auditing.

## Finding 2: `load rd=x0` Was Rewritten Into a Non-Faulting No-Op

The second finding was much cleaner.

In RISC-V, writing to `x0` discards the destination value, but it does **not** erase the rest of the instruction semantics. A load into `x0` still performs the memory access, and it still faults if the address is invalid.

Jolt's trace path did something much more aggressive.

Instructions with `rd = x0` were rewritten before the constraint system saw them. For loads, that rewrite happened early enough that a faulting load could collapse into a harmless internal sequence without ever performing the actual memory read that would have failed under direct execution.

Relevant source:

- [`tracer/src/instruction/mod.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/tracer/src/instruction/mod.rs#L551-L569)
- [`tracer/src/instruction/lw.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/tracer/src/instruction/lw.rs#L31-L49)

This was exactly the kind of zkVM bug auditors hope to find, because it is simple, architectural, and devastatingly concrete:

- the same decoded instruction faults under direct execution;
- the trace path proves a non-faulting rewrite instead.

That is not trace malleability. That is a semantic split between the architecture being claimed and the execution being proved.

Once a zkVM can prove "this instruction executed successfully" while the real ISA semantics would fault, the core soundness story is already broken. No fancy cryptography is needed to explain the impact.

The Jolt team acknowledged and fixed this issue in [PR #1457](https://github.com/a16z/jolt/pull/1457).

## Finding 3: Dory Verification Depended on Ambient Global State

The third finding was a verifier isolation bug.

The core issue was not that Dory commitments were mathematically broken. The issue was that verification behavior depended on mutable process-global layout state.

In particular, the verifier path consumed `DoryGlobals::get_layout()` during advice-related claim reduction before later re-initializing from `proof.dory_layout`. That meant the same proof, statement, and verifier setup could verify or fail depending only on unrelated ambient process state.

Relevant source:

- [`jolt-core/src/zkvm/claim_reductions/advice.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/jolt-core/src/zkvm/claim_reductions/advice.rs#L100-L120)
- [`jolt-core/src/zkvm/verifier.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/jolt-core/src/zkvm/verifier.rs#L1045-L1060)
- [`jolt-core/src/zkvm/verifier.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/jolt-core/src/zkvm/verifier.rs#L1486-L1495)
- [`jolt-core/src/poly/commitment/dory/dory_globals.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/jolt-core/src/poly/commitment/dory/dory_globals.rs#L273-L283)

This was easy to demonstrate cleanly:

- produce one proof;
- keep the statement, transcript inputs, commitment, and verifier setup fixed;
- change only the global layout state;
- observe verification flip from success to failure and back again.

This is a different class of bug from a direct soundness break, but it is still very much a security issue.

A verifier should be a pure function of:

- the proof,
- the public statement,
- and the verifier's explicit setup.

If verification also depends on hidden mutable global state, then shared-process deployments inherit a state-pollution risk. One request can influence another request's verification behavior. Even if that does not immediately produce a false acceptance, it is still a violation of the verifier's trust boundary.

Of the three confirmed security bugs, this was the most interesting one to me. It is not the usual "bad algebra leads to broken soundness" story, and it is not a standard cryptographic mistake either. It sits in a stranger and, in some ways, more modern failure mode: the verifier is locally correct-looking, the proof objects are fine, and yet the outcome still depends on ambient runtime state. Bugs like that are easy to miss because they do not look dramatic in isolation, but they cut directly across a property zk systems depend on very heavily: verification should be deterministic, context-free, and boring.

The Jolt team acknowledged and fixed this issue in [PR #1456](https://github.com/a16z/jolt/pull/1456).

## Finding 4: Forged Fake-GLV Advice Broke P-256 Verification End-to-End

The fourth finding was the strongest of the set.

Jolt's P-256 ECDSA verification flow uses advice-driven Fake-GLV decomposition. That is not inherently unsafe, but it creates a hard requirement: prover-supplied advice must be bound tightly enough that a malicious prover cannot satisfy the internal checks with a forged decomposition that changes the meaning of the signature verification.

In this case, that binding was not tight enough.

Relevant source:

- [`jolt-inlines/p256/src/sdk.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/jolt-inlines/p256/src/sdk.rs#L822-L875)
- [`jolt-inlines/p256/src/sdk.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/jolt-inlines/p256/src/sdk.rs#L875-L915)
- [`examples/p256-ecdsa-verify/guest/src/lib.rs`](https://github.com/a16z/jolt/blob/60c75c56d30ff2c080d2917ecd93f885e0878e79/examples/p256-ecdsa-verify/guest/src/lib.rs#L18-L69)

The inner verification logic checked:

- scalar decomposition relations;
- a combined four-scalar relation;
- and basic point validity properties.

But those checks still left enough room for a correlated forged pair of advice values to satisfy the existing equations while changing the effective point sum used to validate the signature.

The most important part of this finding was not the algebra. It was the escalation path.

We first showed the discrepancy at the helper level:

- honest `ecdsa_verify` rejected the chosen invalid signature;
- forged correlated advice allowed the inner verification logic to accept it.

Then we moved one layer closer to the real system boundary:

- we reproduced the forged values using the actual 14-word Fake-GLV advice ABI that the inline machinery consumes.

And finally we pushed it all the way through Jolt's proof system:

- a guest consumed forged `UntrustedAdvice`;
- the prover generated a full proof;
- the verifier accepted it;
- the guest did not panic.

At that point, there was no ambiguity left.

This was not "an odd mathematical corner case." It was an end-to-end soundness break in the shipped P-256 verification flow under Jolt's own untrusted-advice model.

The Jolt team acknowledged and fixed this issue in [PR #1458](https://github.com/a16z/jolt/pull/1458).

## Vendor Review and Final Resolution

After we sent the report, the Jolt team:

- fixed findings 2, 3, and 4;
- pushed back on finding 1;
- and explained why they considered the first issue acceptable trace malleability rather than a security defect.

We revisited the first finding carefully after that response. The deeper follow-up testing and the system's public-statement semantics supported their position. So we accepted that conclusion.

After reviewing their response and re-checking the stronger follow-up PoC on our side, the final status looked like this:

- `Jump-to-NoOp`: technically real underconstraint, ultimately non-security
- `load rd=x0`: confirmed security issue, fixed in [PR #1457](https://github.com/a16z/jolt/pull/1457)
- Dory ambient globals: confirmed security issue, fixed in [PR #1456](https://github.com/a16z/jolt/pull/1456)
- P-256 Fake-GLV: confirmed security issue, fixed in [PR #1458](https://github.com/a16z/jolt/pull/1458)

That split is worth making explicit because it says something important about Jolt itself. The interesting problems were not random implementation accidents. They clustered around exactly the places where Jolt's architecture takes shortcuts for efficiency: instruction rewriting, advice-driven computation, and backend verification state.

## What These Findings Say About zkVM Security

These findings point to a few patterns that matter well beyond Jolt.

### 1. The malicious prover model has to stay front and center

Many bugs look dangerous until you ask the only question that really matters:

> What can a malicious prover change in an accepted public statement?

If the answer is "nothing public," the issue may still be interesting, but it may not be a security bug.

### 2. Trace semantics are part of the security boundary

Whenever a zkVM rewrites, lowers, expands, or virtualizes instructions, that machinery deserves the same suspicion as the core proving logic. The `load rd=x0` issue existed precisely because a "convenient" internal rewrite crossed a semantic line that the ISA does not permit.

### 3. Advice is never harmless

Advice-driven acceleration is a natural optimization in zk systems. But every new advice channel is a new prover-controlled interface, and every such interface needs strong internal binding checks. The P-256 issue is a textbook reminder that "the guest verifies the advice" only matters if the verification relation is actually complete.

### 4. Verifiers must be pure

Global mutable state in verification code is a recurring source of security trouble. Even when it does not immediately create false positives, it damages isolation, reproducibility, and confidence in the verifier's security boundary.

### 5. Evidence quality matters as much as bug severity

The most useful way to reason about issues like these is to move from:

- local inconsistency,
- to subsystem harness,
- to accepted proof,
- to public-statement impact.

That progression makes it much easier to separate a genuine public-statement break from a local inconsistency that never becomes exploitable.

## Closing Thoughts

The most interesting part of this Jolt review was not the raw finding count. It was the shape of the failures.

One bug showed that internal rewrites can drift away from ISA semantics in a way that directly breaks soundness. One bug showed how quickly advice-driven acceleration becomes dangerous when the binding checks are even slightly incomplete. One bug showed that verifier purity is not a nice-to-have property; it is part of the security boundary. And one bug, after more work, ended up illustrating the opposite point: not every underconstraint is automatically exploitable, and not every malformed internal witness is a public-statement break.

That combination makes Jolt a useful case study for zkVM security engineering. The system is ambitious, the design choices are visible, and the bugs that appeared were closely tied to those design choices rather than to generic software hygiene problems.

That is usually where the real work in zkVM security begins.
