---
title: "MIPS, Merkle, and 0/0: Two Recursion Soundness Bugs in Ziren"
date: "2026-05-11T23:41:00+08:00"
slug: "ziren-audit"
categories:
  - ZK
  - Security Research
  - Audits
tags:
  - zkvm
  - ziren
  - audit
---

# MIPS, Merkle, and 0/0: Two Recursion Soundness Bugs in Ziren

*Bind the witness, or the witness binds you.*

## Introduction

Ziren is one of the more interesting zkVM targets we have looked at in a while, partly because it does not follow the now-familiar RISC-V path. It takes a MIPS32R2 execution model, layers a Linux-style syscall ABI on top, shards the resulting execution trace across a large multi-chip STARK machine, recursively compresses the shard proofs, and finally wraps the whole thing for succinct verification.

That stack is already ambitious. What makes it especially fun to audit is that each layer introduces a different kind of security question.

At the ISA layer, MIPS32 is old enough to be weird in exactly the ways that matter for a zkVM. It brings a dense load/store surface, control-flow quirks, LL/SC-style synchronization instructions, split-word memory operations like `LWL` and `LWR`, and a syscall-heavy toolchain story. In a normal emulator, those are implementation details. In a zkVM, they become proof obligations.

At the executor layer, Ziren does not just interpret raw MIPS instructions. It also emulates enough of a Linux userspace ABI to run guest programs built from Rust, Go, and C/C++ toolchains. That means the proving system is not only claiming "this arithmetic was right." It is claiming that a synthetic operating environment, a synthetic memory model, and a synthetic syscall layer all line up with the statement the verifier sees.

At the proving layer, Ziren leans into a large multi-chip AIR design. The MIPS execution trace is distributed across chips for CPU state, arithmetic, control flow, memory, syscalls, and cryptographic precompiles, all coordinated by lookup arguments and global consistency checks. Then the system climbs another level and recursively verifies its own shard proofs through a separate recursion machine.

That is where the architecture gets especially interesting from a security angle. Once a zkVM has both:

- a rich execution machine with many syscall and precompile surfaces, and
- a separate recursive verification layer with its own memory, arithmetic, hashing, and Merkle machinery,

the most dangerous bugs are rarely "plain coding bugs." They usually live in the seams:

- runtime semantics vs proof semantics
- witness assumptions vs actual constraints
- client trust vs cryptographic verification
- official SDK convenience paths vs real security boundaries

That was exactly the shape of the bugs we ended up caring about.
Some of those seams live outside the recursion layer. In this post, though, we stay with the two recursion-side failures that best expose how Ziren's recursive proof logic can drift away from its intended semantics.

All source links below are pinned to the exact Ziren revision we used during this work:

- `7c2071eaa8d43d9d0cb76077ec94b9d98f33073e`

## Why Architecture Matters in a MIPS zkVM

The fastest way to understand Ziren is to look at three pieces together:

- the high-level zkVM pipeline
- the MIPS/Linux execution model
- the recursive compression architecture

The overview docs describe the first layer clearly: guest code is compiled to a MIPS32R2 ELF, loaded into a MIPS VM, executed into a trace, then proved and optionally wrapped for on-chain verification.

- Overview: [docs/src/dev/overview.md#L11-L60](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/docs/src/dev/overview.md#L11-L60)

The MIPS ISA docs show how broad the supported instruction and syscall surface is. This is not a tiny research VM with half a dozen arithmetic opcodes. It is trying to be useful. That means lots of memory instructions, lots of control flow, and a long list of syscalls and precompiles.

- ISA categories: [docs/src/mips-vm/mips-isa.md#L71-L89](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/docs/src/mips-vm/mips-isa.md#L71-L89)
- Supported syscalls and precompiles: [docs/src/mips-vm/mips-isa.md#L176-L232](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/docs/src/mips-vm/mips-isa.md#L176-L232)

The Linux ABI layer is one of the best examples of where zkVMs become more than instruction tracers. Ziren intercepts `SYSCALL`, executes it in the host executor, emits syscall events, and then proves those results in `SysLinuxChip`, with cross-shard global lookups binding the core and precompile sides together.

- Linux ABI architecture: [docs/src/mips-vm/linux-abi.md#L5-L13](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/docs/src/mips-vm/linux-abi.md#L5-L13)
- Cross-shard syscall linkage: [docs/src/mips-vm/linux-abi.md#L224-L245](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/docs/src/mips-vm/linux-abi.md#L224-L245)

One detail here is very ZK, and very revealing. Ziren does not pack Linux syscall arguments with a naive field reduction. It explicitly uses half-word packing because a direct field reduction could collide modulo the KoalaBear prime. That is a good design instinct, and it also shows how quickly "just emulate Linux syscalls" turns into algebra engineering once the execution model has to survive proof composition.

That design buys flexibility, but it also expands the attack surface in a very specific way. A bug is no longer limited to "the CPU constraints were wrong." It can also live in:

- how executor results are encoded into events
- how those events are routed into chips
- how values are packed for lookups
- how different shards agree on the same syscall statement
- how guest runtimes serialize public values before they hit the proving system

Then the recursion layer adds its own machine on top. Ziren's `RecursionAir` is not a thin wrapper around shard proofs. It has its own memory chips, base-field and extension-field arithmetic chips, hashing chips, FRI-related chips, selector logic, and public-value logic.

- Recursive STARK overview: [docs/src/design/prover-architecture/recursive-stark.md#L57-L119](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/docs/src/design/prover-architecture/recursive-stark.md#L57-L119)
- `MipsAir` chip inventory: [crates/core/machine/src/mips/mod.rs#L71-L179](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/core/machine/src/mips/mod.rs#L71-L179)
- Recursion program construction: [crates/prover/src/lib.rs#L369-L527](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/prover/src/lib.rs#L369-L527)

This is where Ziren becomes a particularly rich target:

1. The MIPS32 execution layer creates many semantics-heavy edge cases.
2. The Linux ABI layer creates trust and encoding boundaries between executor logic and proof logic.
3. The recursion layer creates a second proving machine whose assumptions must be just as tight as the first.
4. The SDK and network prover paths create user-facing security boundaries outside the core arithmetic.

That last point matters. Some of the most meaningful issues here were not "deep algebra only" bugs. They sat in the official client and installation flows.

## Scope and Approach

We worked against `ProjectZKM/Ziren` at commit `7c2071eaa8d43d9d0cb76077ec94b9d98f33073e`, with the public docs and shipped examples as the anchor for what counted as an official entrypoint.

This write-up stays focused on the two findings that felt the most native to Ziren's zk core:

- non-boolean recursion selectors breaking Merkle membership soundness
- `DivF` and `DivE` accepting invalid `0/0` recursion traces

We spent time on other surfaces too, including SDK and client-side trust boundaries, but those are not what make Ziren technically distinctive. The two issues below live where the system is most interesting:

- the recursive verifier's own witness plumbing
- the recursion machine's arithmetic semantics
- the point where local algebra turns into public proof statements

The practical rule for what made it into this post was simple:

- if the issue only existed as a suspicious local gadget, it was not enough
- if the issue could be driven through the shipped recursion machinery and change what an accepted recursive proof could claim, it was worth writing up

## The Finding We Liked Most

If we had to pick one finding that best captures why recursion systems are so fragile, it would be the `SelectChip` bug.

At first glance it looks almost too small to matter: a selector is used in an affine gadget, but nobody actually constrains it to be boolean. On paper, that sounds like the kind of local underconstraint that may or may not go anywhere.

In practice, it goes straight into Merkle verification.

One unconstrained field element turns a branch into interpolation. Once that happens inside a recursive Merkle path, "left or right" is no longer a branch decision. It is just algebra. And once it is just algebra, a fake leaf and a fake sibling can be solved to land exactly on an honest root.

That is the kind of bug that stays memorable because it compresses a lot of zk engineering truth into one line: if a branch is not really binary, the Merkle tree is no longer a tree.

## Finding 1: Non-Boolean `SelectChip` to Fake Merkle Membership

The recursion selector bug is the most satisfying example of a small local mistake turning into a full statement-level problem.

The selector logic itself is in `SelectChip`. The output equations are affine in the selector:

- `out1 = bit * in2 + (1 - bit) * in1`
- `out2 = bit * in1 + (1 - bit) * in2`

What is missing is the obvious constraint: `bit` must be either `0` or `1`.

- `SelectChip`: [crates/recursion/core/src/chips/select.rs#L245-L257](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/core/src/chips/select.rs#L245-L257)

That alone is a bad sign, but the real escalation comes from how witness bits enter the recursion circuit.

At the witness layer, `Witnessable<bool>::read()` does not materialize a constrained bit gadget. It simply delegates to `C::read_bit(builder)`.

- Boolean witness read: [crates/recursion/circuit/src/witness/mod.rs#L38-L43](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/circuit/src/witness/mod.rs#L38-L43)

In `InnerConfig`, that means `builder.hint_felt_v2()`.

- `read_bit()`: [crates/recursion/circuit/src/lib.rs#L189-L202](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/circuit/src/lib.rs#L189-L202)

Merkle proof witness loading then turns the Merkle index into a vector of these witness-provided "bits" and passes them straight into the proof variable.

- Merkle proof witness read: [crates/recursion/circuit/src/machine/witness.rs#L209-L225](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/circuit/src/machine/witness.rs#L209-L225)

Only after that does the recursive Merkle verifier consume them:

- Merkle verifier: [crates/recursion/circuit/src/merkle_tree.rs#L136-L150](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/circuit/src/merkle_tree.rs#L136-L150)

The last bridge in the chain is easy to miss, but it matters. `select_chain_digest()` does not implement a separate "Merkle branch" gadget. It emits `DslIr::Select` for each digest limb, which is exactly how the Merkle path logic reaches the selector machinery described above.

- `select_chain_digest()`: [crates/recursion/circuit/src/hash.rs#L127-L140](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/circuit/src/hash.rs#L127-L140)

And this is not dead code. The same Merkle proof machinery is part of recursive verification flows for VK membership and deferred proof handling.

- VK proof verification: [crates/recursion/circuit/src/machine/vkey_proof.rs#L133-L141](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/circuit/src/machine/vkey_proof.rs#L133-L141)

What makes this bug interesting is that the security failure is not "the select gadget is underconstrained" in the abstract. The actual failure is that a binary branch direction inside recursive Merkle verification gets widened into a field interpolation problem.

In a correct Merkle verifier, each level must choose exactly one of two ordered input pairs for the compression function:

- `[value, sibling]`, or
- `[sibling, value]`

Once the branch variable is allowed to be an arbitrary field element, the verifier is no longer forced to pick one real branch. It can instead synthesize an affine combination of the two branches and feed that result into the next compression step.

That does not automatically break every Merkle construction, so it is worth being precise here. The important point is not merely that the select equations are affine. The important point is that the surrounding recursion circuit leaves enough witness freedom for those non-boolean branch values to flow into the actual Merkle path logic. In our reproduction, a one-level tree was already enough: the claimed leaf was not in the tree, but the witness could still drive the verifier to the honest root.

We kept the public reproduction intentionally small. The minimal regression uses an honest two-leaf root, a claimed leaf that is not equal to either real leaf, and a non-boolean path witness at a single Merkle level. That was enough to show accepted fake membership without dragging in a larger recursive harness than necessary.

That chain gave us exactly what we wanted from a recursion bug:

- a small local invariant failure
- a direct path into a real recursive verification component
- a final proof of fake membership under a genuine root

This is why this issue stands out so much. It does not need a speculative jump from "missing constraint" to "maybe dangerous." The missing booleanity lands directly inside a recursive membership proof and changes the statement the verifier is willing to accept. That is a recursive soundness failure in the plainest sense.

## Finding 2: `DivF` and `DivE` Accept Invalid `0/0` Semantics

The second recursion bug lives in a different place, but it has the same flavor: runtime semantics and proof semantics drift apart in a tiny corner case, and that tiny corner case turns out to matter.

In the recursion runtime, both `DivF(0, 0)` and `DivE(0, 0)` are explicitly defined to return `1`.

- Runtime semantics: [crates/recursion/core/src/runtime/mod.rs#L280-L320](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/core/src/runtime/mod.rs#L280-L320)

In the AIR, however, the division check is just the generic multiplicative relation. For the base-field case:

- Base-field AIR: [crates/recursion/core/src/chips/alu_base.rs#L297-L300](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/core/src/chips/alu_base.rs#L297-L300)

The extension-field side has the same structure:

- Extension-field AIR: [crates/recursion/core/src/chips/alu_ext.rs#L293-L296](https://github.com/ProjectZKM/Ziren/blob/7c2071eaa8d43d9d0cb76077ec94b9d98f33073e/crates/recursion/core/src/chips/alu_ext.rs#L293-L296)

For `0/0`, both constraints collapse into tautologies. At that point the proof system is no longer checking the runtime's special-case semantics at all. It is only checking that zero times the claimed output is zero.

That distinction matters because Ziren's recursion machine is not treating these values as dead metadata. The result of a `DivF` or `DivE` operation is written into memory, can be consumed by later recursion instructions, and can therefore affect higher-level proof logic.

The interesting part here is not just that `0/0` is mishandled. It is how far the mismatch can be pushed once the unconstrained output is treated like any other arithmetic result.

We reproduced three increasingly meaningful variants:

- a forged base-field `DivF(0, 0)` record that still verified
- a forged extension-field `DivE(0, 0)` record that still verified
- a base-field variant where the forged `DivF(0, 0)` result was propagated into a dependent operation and ultimately into the committed recursion public value

Again, the public-facing reproductions were deliberately kept short. The strongest base-field variant uses a tiny recursion program containing a `DivF(0, 0)`, a dependent arithmetic step, and a public-value commit. That is enough to show that the unconstrained `0/0` output is not merely a local oddity. It can flow forward into the public-facing result of the recursive proof.

That last step is what turns a neat underconstraint into a serious bug. It shows that the semantic drift is not trapped inside an isolated row. The forged result can survive long enough to affect the public-facing statement of the recursive proof.

That is one of the cleanest definitions of a soundness bug in a recursive system:

- the runtime says one thing happened
- the proof system is willing to accept another
- the difference reaches committed public data

If the selector/Merkle bug is the prettiest recursion bug, the `DivF` / `DivE` issue is the one that most sharply exposes the cost of special-case runtime semantics that never make it into the algebra.

## What These Two Findings Say About Ziren

Taken together, these two bugs say something fairly specific about where Ziren is most fragile.

The high-risk recursion surface is not just "the hash function" or "the field arithmetic" in isolation. It is the logic that turns prover-controlled witness values into structural proof claims:

- branch direction
- membership
- exceptional arithmetic semantics
- public-value propagation across recursion

That is why both findings feel so representative.

The selector bug starts from a tiny omission, but the omitted constraint sits exactly on the boundary between witness freedom and Merkle structure. The `DivF` / `DivE` bug starts from a tiny exceptional case, but the missing semantic check sits exactly on the boundary between runtime meaning and AIR meaning.

In both cases, the most important lesson is the same: recursion code is full of objects that look like "just helpers" or "just gadgets" until one of them quietly becomes part of the statement the proof is making.

## Closing Thoughts

The reason we wanted to write up these two findings, and not just the broader audit, is that they capture the most interesting side of Ziren.

This is a MIPS zkVM with a serious recursive proving stack. That combination creates plenty of room for normal implementation bugs, but the most memorable issues are the ones where the recursive proof system itself starts saying more than the constraints actually justify.

If we had to summarize the whole experience in one sentence, it would be this: Ziren gets most interesting exactly where execution semantics, witness plumbing, and recursive proof structure stop being separable concerns.

And that is a big part of why it was such a good target.
