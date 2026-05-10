---
title: "Pico, Proof Boundaries, and the Places zkVMs Really Break"
date: "2026-05-10"
slug: "pico-audit"
categories:
  - ZK
  - Security Research
  - Audits
tags:
  - zkvm
  - pico
  - audit
---

# Pico, Proof Boundaries, and the Places zkVMs Really Break

*If it is not in the statement, it belongs to the prover.*

## Introduction

Pico is exactly the kind of zkVM that rewards a close audit.

On the surface, the pitch is compelling: a high-performance, modular zkVM with multiple proving backends, multiple proof phases, a practical SDK, an EVM export flow, and enough engineering ambition to make it feel like a real system rather than a research toy. That combination is what makes Pico interesting. It is also what makes Pico dangerous to audit casually.

In systems like this, the hardest bugs are rarely the loudest ones. They often sit in the interfaces:

- between a proof and the verifier API that is supposed to pin its meaning,
- between a proved value and the metadata that travels beside it,
- between a CLI workflow and the artifact that downstream code assumes is trustworthy,
- between "this key identifies a program" and "this digest happens to hash part of a key."

That was the part of Pico we kept coming back to.

We spent our time on Pico `v2.0.0`, focusing on issues that could be validated against official entry points and that changed something security-relevant about verification, artifact integrity, or public output semantics. This write-up is not a dump of every raw audit note. It is the story of the findings that mattered most once the dust settled.

There were four that defined the work:

1. `RiscvMachine::verify` ignores the caller-supplied expected verifying key.
2. `prove_evm` shells out unsafely and continues after failed child commands.
3. `BaseVerifyingKey::hash_field()` omits `initial_global_cumulative_sum`.
4. `MetaProof.pv_stream` is treated like trustworthy public output even though verification does not bind those raw bytes.

The set is mixed in a useful way. None of these are "cute code smells." None of them are the same class of bug. And taken together, they say something important about Pico: the most interesting security surface is not just the AIR. It is the whole trust boundary around what a proof means, how a verifier pins that meaning, and how tooling exports that meaning into the outside world.

## Why Pico Was Worth Reading Closely

Pico's architecture creates a broad and unusually realistic attack surface.

At a high level, the repository exposes several distinct layers that all matter:

- a RISC-V proving and verification layer,
- recursive and combined proof phases,
- SDK abstractions that wrap proving and verification for application developers,
- an EVM export path that turns proof artifacts into verifier inputs,
- auxiliary tooling such as the Gnark server and Docker-based workflows.

That is already enough to generate meaningful security questions before reading any detailed code.

If a zkVM only had a small proving core, the audit could stay tightly centered on circuit soundness. Pico is not that kind of project. Pico is trying to be a usable proving system. Once a system becomes usable, the security surface expands immediately:

- APIs need to mean what they say.
- exported public values need to be clearly bound or clearly untrusted.
- verifier inputs need to be identity-preserving.
- host-side proving workflows need to be fail-closed.

This is the broader lesson that Pico reinforces: once a zkVM grows real tooling around the proving core, security stops being a single-circuit question. It becomes a statement-integrity question.

## The Attack Surface We Cared About Most

When we look at a zkVM like Pico, the natural temptation is to start with arithmetic underconstraints, chip gadgets, and proof-system internals. Those are real and important. But the issues that keep paying dividends in practical audits are often slightly higher in the stack.

The recurring questions we cared about were:

1. Does a verifier API actually bind a proof to the program identity the caller intended?
2. Does a published verifying-key digest really name the full security-relevant key material?
3. When a proof object carries extra bytes, are those bytes part of the proved statement or just convenient baggage?
4. When the SDK says it generated an EVM proof artifact, can downstream code trust that artifact as the result of a successful proving run?

Those questions sound simple, but they cut directly through the way developers integrate zk systems into real applications.

This is also why some of the most interesting Pico issues were not "classic zk algebra bugs." The strongest ones were binding failures. They lived in the difference between:

- a proof that verifies,
- a proof that verifies *for the intended program*,
- a public output that is displayed,
- and a public output that was actually authenticated by the proof system.

That distinction is where a lot of modern zk application risk lives.

## Finding 1: `RiscvMachine::verify` Does Not Pin the Expected Program VK

The cleanest finding in the set lived in the verifier API itself.

All source links below are pinned to the `v2.0.0` audit commit, `22b0aae`.

The relevant code in [`vm/src/instances/machine/riscv.rs`](https://github.com/brevis-network/pico/blob/22b0aae/vm/src/instances/machine/riscv.rs) is short enough that the issue almost hides in plain sight:

```rust
fn verify(&self, proof: &MetaProof<SC>, _riscv_vk: &dyn HashableKey<SC::Val>) -> Result<()> {
    assert_eq!(proof.vks().len(), 1);
    let vk = proof.vks().first().unwrap();
    ...
}
```

The API accepts an expected RISC-V verifying key from the caller. The implementation then ignores it completely and verifies against the VK embedded inside the proof object.

That means the function does not implement what most callers will naturally assume it implements.

The intended security meaning of an interface like this is obvious:

- the caller supplies a proof,
- the caller supplies the VK for the program they expect,
- the verifier checks that the proof is valid for that expected program.

That is not what happens here.

The proof becomes self-describing. If the proof carries its own matching VK, `verify()` accepts it even when the caller supplied a different VK.

### Why This Matters

In zk systems, program identity is part of the statement.

It is not enough to say "this is a valid proof." A valid proof for *which* program? A proof that establishes one RISC-V computation is not interchangeable with a proof for another guest, even if both are structurally valid Pico proofs.

This is why the bug is so sharp: it does not attack field arithmetic or the AIR directly. It attacks the verifier contract.

Any service that relies on this API to enforce "only proofs for program X are accepted here" is standing on a false assumption. The caller thinks they are pinning the VK. The implementation is not.

### What We Reproduced

We used the official proof path to generate a real proof for one guest, then computed:

- the correct VK for that guest,
- and a different VK from a second ELF.

The results were exactly what the code predicts:

- `RiscvMachine::verify(&proof, &correct_vk)` succeeded,
- `RiscvMachine::verify(&proof, &wrong_vk)` also succeeded.

To make sure this was not an artifact of our harness, we pushed one layer lower and forced the lower-level verifier to use the wrong VK directly. That failed with `InvalidPowWitness`, which is exactly the control result we wanted. The proof is not universally valid. It only appears to be accepted because the public API quietly swapped in the embedded VK.

That control step matters. Without it, the bug would still be real, but the evidence would be weaker. With it, the failure mode becomes crystal clear:

- the proof verifies when the API chooses the proof's own VK,
- the same proof does not verify when the caller's wrong VK is actually enforced.

### Why We Liked This Finding So Much

This was probably the cleanest finding in the entire set.

It is rare to get a verifier bug that is:

- easy to state,
- easy to reproduce,
- obviously security-relevant,
- and anchored in a single, high-level trust boundary.

There is no need to oversell it with dramatic language. The bug is already severe because it breaks a verifier invariant that applications are entirely justified in relying on.

It also captures a theme that shows up repeatedly in zk engineering: verifier APIs are part of the security perimeter. If the public interface misrepresents what is actually being checked, the system has already lost a lot of ground, even if the underlying proof system is mathematically sound.

## Finding 2: `prove_evm` Turned a Proof Workflow into a Host-Side Integrity Problem

The second finding sits in a completely different layer of Pico, and that is exactly why it is interesting.

The official EVM proving flow calls out to Docker using `sh -c` and interpolates the output path directly into the shell command. It then ignores the child exit status and continues to generate `inputs.json` from whatever files happen to exist on disk.

The relevant pieces are:

- [`sdk/sdk/src/client.rs`](https://github.com/brevis-network/pico/blob/22b0aae/sdk/sdk/src/client.rs)
- [`sdk/sdk/src/command.rs`](https://github.com/brevis-network/pico/blob/22b0aae/sdk/sdk/src/command.rs)

The command construction looks like this:

```rust
prove_cmd.arg("-c").arg(format!(
    "docker run --rm -v {}:/data ...",
    output.display(),
));
```

And the helper that executes the command waits for the child process but discards the exit code:

```rust
let _ = child.wait().expect("failed to wait for child process");
```

That combination produces two separate bugs that reinforce each other.

### Bug 2A: Output-Path Shell Injection

Because `prove_evm` builds the Docker invocation through `sh -c`, the `output` path is no longer just a filesystem path. It becomes shell syntax if it contains metacharacters.

That is enough for command injection.

This is not a theoretical concern hiding behind weird edge cases. The attack surface is exactly the official CLI/SDK EVM workflow that application teams would script around. If a CI job, build tool, wrapper script, or service passes attacker-influenced values into that `output` parameter, arbitrary commands execute in the prover environment.

### Bug 2B: Fail-Open Artifact Generation

The second problem is subtler and, in practice, just as damaging.

After the Docker step runs, Pico continues into `generate_contract_inputs(...)`. That function reads:

- `proof.data`
- `groth16_witness.json`
- `pv_file`

and emits `inputs.json`.

The problem is that the preceding child process might have failed. The command runner does not enforce success. So downstream logic can end up consuming:

- stale files from a previous run,
- attacker-planted files,
- partial outputs,
- or any other artifact layout that happens to satisfy the file existence checks.

This is a textbook artifact provenance bug.

### What We Reproduced

We validated both halves of the issue.

For the shell injection path, we supplied a crafted output path containing shell metacharacters and confirmed that the injected command executed successfully.

For the fail-open path, we replaced `docker` with a shim that always exits `42`, pre-planted the files `generate_contract_inputs()` expects, and ran the exact command shape Pico uses. Even though the proving subprocess failed, Pico still generated `inputs.json` from the planted artifacts.

That reproduction matters because it pushes beyond "the code looks unsafe" into "the official workflow can be made to produce apparently valid downstream material after a failed proving step."

### Why This Matters in a zk Project

It is easy to underestimate host-side bugs in zk tooling because they do not look like "pure cryptography" failures.

That is a mistake.

If a proving pipeline is allowed to:

- run unintended commands,
- accept stale proof artifacts,
- or publish verifier inputs after a failed proving step,

then the system's exported security story is already compromised.

In real deployments, the `inputs.json` file is not a toy. It becomes the bridge between off-chain proving and on-chain verification. If the artifact is produced by a fail-open workflow, downstream consumers can be tricked into trusting an output that was never generated by a successful proof run at all.

This finding is a good reminder that zk security is not just about algebraic soundness. It is also about making sure the toolchain does not lie about what happened.

## Finding 3: Pico's Exported VK Hash Left Out Part of the VK

The third finding is quieter than the first two, but it cuts into a deep assumption that zk systems rely on constantly: if a verifying-key digest is exported as a stable identity, it had better cover the whole security-relevant key.

In Pico, `BaseVerifyingKey` contains `initial_global_cumulative_sum`. That field is not ornamental. It is security-relevant state derived from the program's initial memory image.

The surprising part is that Pico's exported VK hash does not include it.

In [`vm/src/machine/keys.rs`](https://github.com/brevis-network/pico/blob/22b0aae/vm/src/machine/keys.rs), `observed_by()` absorbs `initial_global_cumulative_sum` into the challenger in normal verification. But the exported `hash_field()` logic hashes:

- the commitment,
- `pc_start`,
- and the preprocessed domains,

while omitting `initial_global_cumulative_sum`.

That means two VKs that differ only in this field produce the same published digest.

### Why `initial_global_cumulative_sum` Matters

One easy way to underestimate this issue is to treat it like a cosmetic hash mismatch.

It is not.

Pico's [`Program`](https://github.com/brevis-network/pico/blob/22b0aae/vm/src/compiler/riscv/program.rs) includes both:

- instructions,
- and an initial memory image.

That initial memory is part of the program semantics. Once the proof system derives a VK component from it and uses that component during verification, omitting it from the exported VK digest means the digest no longer names the full verified object.

That is an identity failure, not a formatting failure.

### What We Reproduced

We used a real VK produced by `setup_keys()`, mutated only `initial_global_cumulative_sum`, and compared:

- `hash_u32()`
- `hash_str_via_bn254()`

before and after the mutation.

Both stayed identical.

This was a satisfying reproduction because it required no heroic setup. The bug is structural. Once the hash function omits the field, the collision falls out immediately.

### Why This Finding Matters More Than It First Appears

What makes this issue important is where VK hashes get used.

Whenever a system treats a VK digest as a stable identity, that digest starts to accumulate responsibilities:

- allowlisting,
- registry membership,
- proof routing,
- program pinning,
- on-chain or off-chain identification.

If the digest does not actually bind all security-relevant VK state, then those downstream assumptions become weaker than they look.

This finding is also a nice complement to Finding 1.

Finding 1 says: the verifier API does not enforce the expected program identity.

Finding 3 says: even when Pico exposes a convenient digest for program identity, that digest is not fully binding.

Together they form a broader picture: program identity is a recurring weak point in Pico's trust boundary.

## Finding 4: `pv_stream` Looked Like Public Output, But It Was Really a Sidecar

This was the most revealing finding in the set.

Not the cleanest one. Not the loudest one. But the one that says the most about how zk systems fail in practice.

Pico's [`MetaProof`](https://github.com/brevis-network/pico/blob/22b0aae/vm/src/machine/proof.rs) carries:

- the proof objects,
- the verifying keys,
- and `pv_stream: Option<Vec<u8>>`.

That last field is where things get interesting.

The raw public-value bytes are attached to the proof object as convenient data. But verification does not re-hash those exact bytes and re-bind them before the caller consumes them. In other words, `pv_stream` is not automatically the same thing as an authenticated public statement.

That might still be manageable if Pico's surrounding interfaces were explicit and conservative about it. They were not.

The examples and export paths made the trust boundary look much weaker than it really was.

### Where the Problem Became Visible

Three places lined up in a particularly dangerous way:

1. `MetaProof` stores `pv_stream` as sidecar bytes.
2. Public examples decode `proof.pv_stream.unwrap()` directly.
3. The on-chain export logic writes `riscv_proof.pv_stream` into the generated `publicValues` artifact.

Once those three pieces sit next to each other, the risk stops being abstract.

The core security question becomes:

> Are downstream consumers reading authenticated public output, or are they reading convenient bytes that happen to travel with the proof?

That distinction is the whole bug.

### What We Reproduced

The first part of the reproduction was straightforward.

We generated a valid proof, replaced `proof.pv_stream` with attacker-chosen bytes, and re-ran verification. The proof still verified.

That is the most direct demonstration possible that `pv_stream` is not itself bound by verification.

The second part was more revealing from an engineering point of view.

We built a guest through the official build path that:

1. committed one chunk of public bytes in constrained execution,
2. entered [`pico_patch_libs::unconstrained!`](https://github.com/brevis-network/pico/blob/22b0aae/sdk/patch-libs/src/unconstrained.rs),
3. emitted a second chunk of public bytes there,
4. and then completed successfully.

The final public-value stream preserved both chunks.

That reproduction matters because it turns the trust-boundary problem into something tactile. It is one thing to say "these bytes are sidecar metadata." It is another thing entirely to show that receipt-facing bytes can be influenced through a path many developers would intuitively treat as rolled back, auxiliary, or non-authoritative.

### Why This Is Not Just "User Misuse"

It would be easy to wave this away as an integration bug if Pico's own surfaces were careful about the distinction.

But the examples and helpers did not help developers draw that line:

- the proving documentation shows direct `pv_stream` consumption,
- the [`examples/fibonacci/prover/src/main.rs`](https://github.com/brevis-network/pico/blob/22b0aae/examples/fibonacci/prover/src/main.rs) example decodes `proof.pv_stream.unwrap()` directly,
- the [`vm/src/instances/compiler/onchain_circuit/utils.rs`](https://github.com/brevis-network/pico/blob/22b0aae/vm/src/instances/compiler/onchain_circuit/utils.rs) export utility writes raw `pv_stream` into the artifact path that downstream code treats as `publicValues`.

That means the problem is not just that an application *could* misuse the data. The surrounding developer experience nudges integrators toward trusting it.

This is exactly the kind of trust-boundary failure that shows up in real systems:

- the proof is valid,
- some bytes are displayed beside the proof,
- the code samples treat those bytes as "the output,"
- and before long the difference between "proved" and "attached" is gone.

### Why This Was the Most Revealing Finding

If Finding 1 was the cleanest bug, Finding 4 was the most representative one.

It captures a truth that comes up over and over in zk engineering:

the proved relation is only half the story. The other half is how the system packages, names, exports, and teaches that relation to downstream users.

In a smaller or more academic codebase, `pv_stream` might have stayed a harmless internal convenience. In a real SDK, with examples and export helpers, it becomes part of the security story whether the project intended that or not.

That is why we kept returning to it. It is not just a bug in one field. It is a bug in the meaning developers are likely to assign to that field.

## The Finding We Preferred Most

If we had to pick one favorite, it would actually be a split decision.

The finding we admired most technically was `RiscvMachine::verify`.

It is a crisp verifier binding failure. It violates a strong and intuitive API contract. It is easy for engineers to understand once they see it, and impossible to dismiss once it is reproduced.

The finding we found most illuminating, though, was `pv_stream`.

That one says more about how zk systems behave in the real world. It is not a single bad equation. It is a full-stack trust problem:

- proof object semantics,
- SDK ergonomics,
- examples,
- export logic,
- and developer intuition,

all pulling in the wrong direction at once.

If someone asked what kind of issue they should train themselves to spot in mature zk stacks, `pv_stream` is the one we would point to first.

## What Pico Taught Us About zkVM Security

Pico reinforced a few lessons that go well beyond this repository.

### 1. Verifier APIs deserve the same suspicion as proving code

It is natural to spend most security energy on witness generation and proof verification internals. But once a project exposes a high-level verifier API, that API becomes part of the statement boundary.

If the interface claims to verify "this proof for this key," then it must actually do that exact thing. A verifier that quietly substitutes its own interpretation is already dangerous, even if the lower-level proof checks are perfectly sound.

### 2. Identity digests need to bind the whole object

Exported key digests are seductive because they are easy to move around and easy to compare. The cost of that convenience is that engineers begin to trust them as names.

Once that happens, a partial digest is much worse than no digest at all. It still looks authoritative, but the authority is weaker than it appears.

### 3. Proof metadata is where a lot of integration bugs hide

This is one of the most important patterns in modern zk stacks.

A proof object often carries:

- authenticated values,
- convenience values,
- cached values,
- exported bytes,
- pretty-printable summaries.

If those categories are not separated sharply, developers will merge them mentally. Once that happens, systems start trusting data that was only ever meant to be convenient transport.

### 4. Host-side tooling can absolutely be a security issue

The `prove_evm` finding is a useful antidote to the idea that "real zk bugs" must always live inside the circuit.

A proving workflow that:

- shells out unsafely,
- ignores failed subprocesses,
- and emits downstream verifier artifacts anyway,

can create security failures that are just as practical as a lower-level proof-system bug. They simply show up in CI, build infrastructure, or deployment pipelines instead of in field arithmetic.

## Closing

Pico was a rewarding audit precisely because it was not a one-dimensional target.

The interesting problems were not all the same shape. Some lived in verification, some in artifact generation, some in identity hashing, and some in the boundary between proved values and attached values. That variety is what made the work worthwhile.

The deeper takeaway is simple:

zkVM security is not only about whether a prover can satisfy a constraint system incorrectly. It is also about whether the system around that proof preserves the meaning the proof is supposed to carry.

That is where Pico was most interesting.

And, honestly, that is where a lot of the best zk security work still is: not in abstract arguments about what should be true, but in the uncomfortable, concrete interfaces where a proof becomes something another system is supposed to trust.
