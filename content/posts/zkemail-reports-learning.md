---
title: "When Email Becomes a Circuit: zkEmail, zk-Regex, and the Soundness Edge of Proving an Inbox"
date: "2026-05-19"
slug: "zkemail-reports-learning"
categories:
  - ZK
  - Security Research
tags:
  - zkemail
  - zk-regex
  - audit
---

# When Email Becomes a Circuit: zkEmail, zk-Regex, and the Soundness Edge of Proving an Inbox

*Private bytes, public claims, no unconstrained wires.*

## Version note

This article studies the zkSecurity report on zk-email and the code versions explicitly covered by that report. All GitHub paths are fixed to the audited commits rather than floating branches.

- `zk-email-verify`: audited at `f2fb77c`.
- `zk-regex`: audited at `9962a11`.
- Solidity contracts were outside the report scope.
- Later fixes are mentioned only when they affect impact analysis; the article mainly focuses on what the audited code teaches.

Core references:

- Report: [zkSecurity, Audit of zk-email](https://reports.zksecurity.xyz/reports/zkemail/)
- `zk-email-verify@f2fb77c`: [GitHub repository](https://github.com/zkemail/zk-email-verify/tree/f2fb77c)
- `zk-regex@9962a11`: [GitHub repository](https://github.com/zkemail/zk-regex/tree/9962a11)
- ZK Email usage docs: [ZK Email Verifier usage guide](https://docs.zk.email/zk-email-verifier/usage-guide)
- ZK Regex docs: [ZK-Regex documentation](https://docs.zk.email/zk-regex)

## 1. Why zkEmail is an interesting system

zkEmail is built around a deceptively simple idea: email already has a global authenticity layer, and zero-knowledge proofs can turn that authenticity into selective disclosure.

The Web2 side is DKIM. A domain signs selected email headers with an RSA key, and the email carries a `DKIM-Signature` header. The public key is discoverable through DNS. If a verifier trusts the domain's DKIM key, then a valid DKIM signature gives a strong provenance claim: this message was signed by infrastructure authorized for that domain.

The ZK side changes the shape of that claim. Instead of revealing the whole email, a prover can show that:

```text
I know an email whose DKIM signature verifies under this public key.
The body hash in the signed header matches the email body.
The email contains a specific pattern.
Only a selected part of that pattern is revealed.
```

The project is powerful because it bridges a massive existing identity and notification system into cryptographic statements. A user can prove receipt of a platform email, ownership of an account, presence of a code, or a relationship with a domain, while hiding most of the message. This is not just a convenience feature. It is a new interface between legacy trust roots and programmable verification.

Our main takeaway is that zkEmail is not one security problem. It is at least three security problems stacked together:

1. A Web2 protocol problem: DKIM, email headers, body hashes, Base64, MIME-like formatting, canonicalization assumptions.
2. A circuit soundness problem: SHA-256, RSA, array selection, dynamic lengths, range checks, field arithmetic.
3. A compiler correctness problem: regex definitions are translated into DFA logic, and then into Circom constraints.

That stack is what makes the report valuable. The most interesting bugs do not live only in cryptography or only in parsing. They live at the boundaries between semantics.

## 2. Code map at the audited commits

The following files are the main anchors for the discussion.

### zk-email-verify at `f2fb77c`

| Area | Path |
| --- | --- |
| Main DKIM verifier circuit | [`packages/circuits/email-verifier.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/email-verifier.circom) |
| SHA-256 templates | [`packages/circuits/lib/sha.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/lib/sha.circom) |
| RSA verifier | [`packages/circuits/lib/rsa.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/lib/rsa.circom) |
| Base64 logic | [`packages/circuits/lib/base64.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/lib/base64.circom) |
| Array utilities | [`packages/circuits/utils/array.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/utils/array.circom) |
| Regex utility circuits | [`packages/circuits/utils/regex.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/utils/regex.circom) |
| Large Poseidon helper | [`packages/circuits/utils/hash.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/utils/hash.circom) |

### zk-regex at `9962a11`

| Area | Path |
| --- | --- |
| Regex to DFA conversion and DFA merging | [`packages/compiler/src/regex.rs`](https://github.com/zkemail/zk-regex/blob/9962a11/packages/compiler/src/regex.rs) |
| Circom code generation from DFA graph | [`packages/compiler/src/circom.rs`](https://github.com/zkemail/zk-regex/blob/9962a11/packages/compiler/src/circom.rs) |
| Common generated regex circuits | [`packages/circom/circuits/common`](https://github.com/zkemail/zk-regex/tree/9962a11/packages/circom/circuits/common) |

The report focuses heavily on `zk-regex`. That emphasis is justified. The main email verifier is a large but conceptually direct circuit composition. The regex compiler, on the other hand, is a semantic translation layer. A developer writes regex. The compiler builds DFA structure. The generator emits Circom. The application treats the generated template as a trustworthy predicate. Every transformation in that chain can drift.

## 3. The architecture: from raw email to public claim

At a high level, zkEmail turns a raw email into a proof through the following path:

```text
Raw email
  -> helper code parses DKIM fields, public key, body hash, signature, body slices
  -> EmailVerifier proves DKIM signature validity and body hash consistency
  -> generated regex circuit proves content shape and reveals selected substrings
  -> proof public outputs feed an off-chain or on-chain verifier
```

The main circuit, `EmailVerifier`, is the backbone. In the audited code it includes the body-hash regex circuit, Base64 decoding, RSA verification, SHA-256, array utilities, regex utilities, and a Poseidon helper.

Code path:

```text
zk-email-verify@f2fb77c
packages/circuits/email-verifier.circom
```

The template parameters describe the envelope of the circuit:

```text
EmailVerifier(maxHeadersLength, maxBodyLength, n, k, ignoreBodyHashCheck)
```

The design is fixed-size at the circuit level. Header and body arrays have maximum lengths decided at compile time. The real dynamic lengths are supplied as signals such as `emailHeaderLength` and `emailBodyLength`. This is efficient enough for practical circuits, but it creates a recurring security theme: dynamic lengths must be range-constrained exactly where they matter.

The main flow is:

```text
emailHeader, emailHeaderLength
  -> AssertZeroPadding
  -> Sha256Bytes
  -> Bits2Num packing
  -> RSAVerifier65537(pubkey, signature, message)

emailHeader
  -> BodyHashRegex
  -> SelectRegexReveal
  -> Base64Decode
  -> headerBodyHash

emailBody, emailBodyLength, precomputedSHA
  -> AssertZeroPadding
  -> Sha256BytesPartial
  -> computedBodyHash

computedBodyHash == headerBodyHash
pubkey -> PoseidonLarge -> pubkeyHash
```

The statement is elegant. The RSA signature binds the signed header. The signed header contains a body hash. The body hash binds the body. The regex circuits let the application reason about specific parts of the message while keeping most bytes private.

From a security perspective, the architecture creates several distinct trust boundaries.

### Boundary 1: DKIM as the provenance anchor

The verifier accepts the email only if the RSA signature verifies against the supplied public key. The output `pubkeyHash` lets downstream logic avoid exposing or carrying the full RSA key. In many applications, a contract or registry can check that hash against an accepted DKIM key.

The subtlety is that DKIM does not magically make every byte meaningful. It signs selected canonicalized headers and commits to the body hash. The circuit is only as strong as the exact bytes it hashes and the fields it extracts.

### Boundary 2: Dynamic length signals

The circuit is compiled for maximum lengths, but the real message length is dynamic. This requires padding checks and length checks. `AssertZeroPadding` is used to force unused array slots to zero. SHA templates use `paddedInLength` to select which compression result should become the final digest.

This is where the SHA-256 finding becomes important. Dynamic length plus array selection plus field arithmetic is a classic ZK footgun.

### Boundary 3: Regex-generated predicates

The application-specific part of zkEmail often relies on regex circuits. The ZK Regex documentation describes circuits that prove an input string satisfies a regex and that substrings are correctly extracted. The decomposed interface lets a developer mark some regex parts private and some public.

That is exactly the kind of feature zkEmail needs. It is also exactly the kind of feature that must be treated as a compiler, not a helper function.

### Boundary 4: Reveal arrays as privacy contracts

A reveal array is not just output formatting. It is a privacy boundary.

A typical generated regex template returns:

```text
out
reveal0[msg_bytes]
reveal1[msg_bytes]
...
```

`out` is a predicate result. Each `reveal` array is supposed to be a masked version of the private input: zero everywhere except the bytes belonging to a selected public substring.

If the mask is wrong, the proof may still be sound as a membership proof, but it may leak private bytes. In zk applications, that distinction matters. Soundness and privacy are separate security properties.

## 4. zkEmail's core idea: DKIM provenance plus selective disclosure

A useful way to understand zkEmail is to separate two layers.

The first layer is authenticity:

```text
This email was signed by a domain-controlled DKIM key.
```

The second layer is extraction:

```text
This signed email contains a field matching this application-specific structure.
Only this field is revealed.
```

The first layer is mostly cryptographic circuit engineering. The second layer is mostly language semantics and privacy engineering.

This separation explains why some report findings are severe as library issues but not necessarily catastrophic for the end-to-end `EmailVerifier`. For example, the report notes that the complement regex issue does not directly affect `EmailVerifier`, because that main template does not use the complement operator. It also notes that the SHA-256 issue is hard to exploit against `EmailVerifier` because other constraints make the malicious length strategy infeasible in that composition. Still, both findings remain important. A downstream project can use these libraries differently.

That distinction is one of the strongest lessons from the report. ZK libraries are not only judged by the flagship circuit. They are judged by the assumptions they export to every project that imports them.

## 5. The main EmailVerifier circuit, read as a security statement

The main verifier is compact enough to read as a chain of obligations.

### 5.1 Header padding and header hash

The circuit first constrains unused header slots to zero and hashes the signed header bytes.

Code paths:

```text
zk-email-verify@f2fb77c
packages/circuits/email-verifier.circom
packages/circuits/utils/array.circom
packages/circuits/lib/sha.circom
```

The intended claim is:

```text
emailHeader[0..emailHeaderLength] is the signed header bytes.
emailHeader[emailHeaderLength + 1..maxHeadersLength] is zero padding.
sha = SHA256(emailHeader with declared padded length).
```

The presence of `AssertZeroPadding` is important. Without it, a prover could potentially hide bytes in unused array positions and rely on length selection to keep them out of the hash. Padding checks make the array representation less ambiguous.

### 5.2 RSA signature verification

After hashing the header, the circuit packs the 256 SHA bits into limbs and feeds them into `RSAVerifier65537`.

Code path:

```text
zk-email-verify@f2fb77c
packages/circuits/lib/rsa.circom
```

The RSA verifier checks that the signature exponentiation under exponent 65537 matches the padded message. Conceptually:

```text
signature^65537 mod pubkey == EMSA-PKCS1-v1_5(SHA256(header))
```

The exact implementation uses limb arithmetic and RSA padding helpers. The report explicitly treats `RSAVerifier65537` as a counterexample to the undocumented-assumptions concern: although it looks like it could require external range constraints, the relevant limb decompositions are constrained internally through the padding and verification flow.

Our reading is that this part of the system is not the surprising one. RSA-in-Circom is expensive, but the statement is familiar. The higher-risk areas are the places where the circuit selects among possible lengths, parses strings, or compiles high-level syntax.

### 5.3 Body hash extraction from DKIM header

If `ignoreBodyHashCheck != 1`, the circuit extracts the `bh=` body hash from the signed DKIM header.

Code paths:

```text
zk-email-verify@f2fb77c
packages/circuits/email-verifier.circom
zk-regex@9962a11
packages/circom/circuits/common/body_hash_regex.circom
```

The flow is:

```text
emailHeader
  -> BodyHashRegex
  -> bhReveal
  -> SelectRegexReveal(bodyHashIndex)
  -> Base64Decode
  -> headerBodyHash
```

This is a beautiful design choice and a delicate one. The body hash is not supplied as a free public input. It is extracted from the signed header itself. That means the body hash checked by the circuit is the body hash actually committed by DKIM.

The extraction is regex-dependent, though. If the regex circuit's semantics diverge from the intended `bh=` field extraction semantics, the cryptographic binding can be weakened or misdirected. This is why the report's attention to common regex circuits is not incidental.

### 5.4 Body hash computation and comparison

The body is hashed using `Sha256BytesPartial`, which supports a precomputed SHA state to reduce constraints. The resulting digest is packed into bytes and compared with the decoded `bh=` value.

Code path:

```text
zk-email-verify@f2fb77c
packages/circuits/lib/sha.circom
```

The precompute optimization is not inherently a security problem. It is a performance strategy. The security question is whether the circuit still binds the claimed body bytes to the signed body hash. The report's SHA-256 finding shows that the more dangerous issue was not precomputation itself, but the dynamic-length selection used inside the SHA templates.

### 5.5 Public key hash output

Finally, `PoseidonLarge(n, k)(pubkey)` produces `pubkeyHash`.

Code path:

```text
zk-email-verify@f2fb77c
packages/circuits/utils/hash.circom
```

This output is a clean interface to downstream verification. A contract or verifier can check `pubkeyHash` against an accepted DKIM key registry, without requiring the full RSA modulus as a public signal.

The design has a strong practical feel: prove the expensive Web2 authenticity inside the circuit, expose only the minimum handle needed for policy enforcement outside it.

## 6. zk-regex: the compiler inside the application

The report's most important architectural observation is that zk-regex is not a normal utility. It is a compiler.

The docs describe two modes:

- `raw`, where regex plus substring transition definitions produce a circuit.
- `decomposed`, where a JSON file splits the regex into parts and marks each part as public or private.

The report focuses on decomposed mode because it is commonly used in zkEmail and is the most stable interface.

A decomposed config might look like:

```json
{
  "parts": [
    { "regex_def": "email was meant for @", "is_public": false },
    { "regex_def": "[a-z]+", "is_public": true },
    { "regex_def": ".", "is_public": false }
  ]
}
```

The generated circuit exposes `out` and one or more reveal arrays. The developer then writes constraints such as:

```text
regexMatch === 1
```

and uses the reveal arrays as public information.

At the audited commit, the compiler path is centered in two files:

```text
zk-regex@9962a11
packages/compiler/src/regex.rs
packages/compiler/src/circom.rs
```

### 6.1 From regex to DFA

In `regex.rs`, the compiler configures the Rust regex automata builder, builds a minimized DFA, converts debug output into an internal graph, and merges separate DFA parts for decomposed regexes.

Important mechanics:

```text
DFA::config().minimize(true)
StartKind::Anchored
byte_classes(false)
DFA::builder().build(format!("^{}$", regex_def))
format!("{:?}", dfa)
parse_dfa_output(...)
dfa_to_graph(...)
```

The exact code path is:

```text
zk-regex@9962a11
packages/compiler/src/regex.rs
```

This implementation decision is worth pausing on. The compiler does not simply use a fully structured DFA API all the way down. It formats the DFA, parses textual output, and then maps transitions into its own graph representation. That can work, but it raises the cost of reasoning. Every custom parser becomes part of the trusted semantic pipeline.

Our judgment is that this is one of the highest-value observations in the report. The bugs are concrete, but the deeper issue is that the compiler has too many semantic conversion steps without a crisp specification.

### 6.2 From DFA graph to Circom

In `circom.rs`, `gen_circom_allstr` emits the Circom template. The generated circuit walks over input bytes and maintains state-transition signals.

Important generated concepts include:

```text
in[num_bytes]
states[num_bytes + 1][n]
states_tmp[num_bytes + 1][n]
from_zero_enabled[num_bytes + 1]
state_changed[num_bytes]
is_consecutive[msg_bytes + 1][n - 1]
final_state_result
```

Code path:

```text
zk-regex@9962a11
packages/compiler/src/circom.rs
```

The intended model is a deterministic finite automaton evaluated inside a circuit. At each byte, the circuit checks which transitions are enabled and updates the state signals. The final output is derived from whether an accepting state was reached.

This is the point where regex semantics become arithmetic constraints. If the state update relation is underconstrained, an invalid string may prove as valid. If the accepting condition is too broad, partial matches may pass. If the reveal mask is imprecise, private bytes may leak.

### 6.3 Reveals are computed from transitions

For public decomposed parts, the compiler identifies transition edges associated with the public part. The generated Circom then creates a mask and multiplies the input byte by that mask.

Conceptually:

```text
is_substr_i[position] = did this position participate in a selected transition?
is_reveal_i[position] = is_substr_i[position] AND is_consecutive[position]
reveal_i[position] = input[position] * is_reveal_i[position]
```

This is clever and fragile. It is clever because it avoids revealing the whole email. It is fragile because the reveal mask must correspond exactly to the accepted match path, not merely to some local transition pattern that happened to appear.

The medium-severity reveal findings show that this distinction was real, not theoretical.

## 7. Attack surface by architecture layer

The report is easiest to internalize when mapped onto architectural layers.

### 7.1 Cryptographic primitive circuits

Relevant files:

```text
packages/circuits/lib/sha.circom
packages/circuits/lib/rsa.circom
packages/circuits/lib/base64.circom
packages/circuits/utils/array.circom
```

Potential failure modes:

- Hash output not actually bound to the intended input.
- Dynamic length selects the wrong internal hash state.
- Comparator inputs are not range-constrained.
- Array index selection returns a default value for invalid indices.
- Base64 decoding accepts ambiguous encodings.
- Limb arithmetic assumes range constraints that are not enforced.

### 7.2 Email protocol binding

Relevant files:

```text
packages/circuits/email-verifier.circom
packages/circuits/common/body_hash_regex.circom
packages/helpers
```

Potential failure modes:

- The signed header bytes differ from what the helper or application believes they are.
- The extracted `bh=` field is not the intended one.
- Body bytes are not padded or hashed consistently.
- The public key hash is checked against the wrong registry or policy outside the circuit.

### 7.3 Regex compiler semantics

Relevant files:

```text
zk-regex/packages/compiler/src/regex.rs
zk-regex/packages/compiler/src/circom.rs
```

Potential failure modes:

- Valid regex syntax compiles to the wrong language.
- Unsupported syntax silently degrades instead of failing.
- Anchors such as `^` and `$` do not mean what developers expect.
- Complement classes such as `[^ab]` are incorrectly enforced.
- A crash or panic becomes a reliability risk for tools that use zk-regex programmatically.

### 7.4 Privacy extraction

Relevant concepts:

```text
reveal arrays
is_public decomposed regex parts
SelectRegexReveal
PackRegexReveal
```

Potential failure modes:

- A non-matching input still reveals some bytes.
- A matching input reveals bytes outside the actual match.
- Zero bytes in the input are indistinguishable from masked bytes unless the application handles that ambiguity.
- Downstream logic treats reveal arrays as canonical strings without verifying shape and length.

## 8. High-value finding: SHA-256 can return all zeros on arbitrary inputs

Report finding:

```text
#02 - SHA256 templates can be made return 0 on arbitrary inputs
Severity: High
Location: zk-email-verify/packages/circuits/lib/sha.circom
```

This is the most instructive circuit-level bug in the report.

### 8.1 The intended SHA design

The custom SHA templates support variable-length padded inputs up to a maximum compile-time length. Since SHA-256 processes 512-bit blocks, the circuit computes compression results for possible blocks and then selects the compression output corresponding to the declared padded input length.

The simplified logic is:

```text
paddedInLength -> inBlockIndex
run SHA compression for maxBlocks
select sha256compression[inBlockIndex - 1]
out = selected compression result
```

Code paths:

```text
zk-email-verify@f2fb77c
packages/circuits/lib/sha.circom
packages/circuits/utils/array.circom
```

The key dynamic signal is `paddedInLength`. In `Sha256Bytes`, byte length is converted to bit length by multiplying by 8 before entering `Sha256General`. In `Sha256General`, `paddedInLength` is used to derive the block index.

### 8.2 The vulnerable pattern

The report identifies two connected issues.

First, `paddedInLength` is checked with `LessEqThan(maxBitsPaddedBits)`, but comparator templates in Circom usually assume their inputs already fit into the configured bit length. If the input is a field element representing a small negative value modulo the scalar field, the comparator can be tricked unless a separate bit decomposition constrains the value into range.

Second, `ItemAtIndex(maxBlocks)` uses `LessThan(bitLength)` to check that `index < maxArrayLen`, but the same precondition applies: the index itself must be range-constrained. Without that, a malicious index outside the array can pass the comparison semantics in field arithmetic.

Code path:

```text
zk-email-verify@f2fb77c
packages/circuits/utils/array.circom
```

The deeper issue is not that `LessThan` is bad. The issue is that `LessThan(n)` is not a standalone proof that an arbitrary field element is an `n`-bit integer. It is a comparison gadget under an input-domain assumption.

That assumption is common in Circom libraries. It is also a recurring source of high-impact bugs.

### 8.3 Why all zeros appear

`ItemAtIndex` computes equality indicators against all valid array positions and sums `eq[i] * in[i]`. If `index` is not equal to any valid position, all equality indicators are zero. The selected value becomes zero.

For SHA, this means that if `inBlockIndex - 1` can be maliciously placed outside the valid range while still passing the flawed checks, each output bit selector returns zero. The final hash becomes the all-zero bit array, independent of the actual input.

The resulting exploit idea is simple in shape:

```text
choose a malicious paddedInLength near the field modulus
make inBlockIndex consistent with the modular constraint
force array selection out of range
receive zero output bits
```

This is a classic ZK bug pattern:

```text
A dynamic selector is assumed to be small.
A comparator is used as if it proves smallness.
An invalid selector falls through to a harmless-looking default.
The default becomes an exploitable value.
```

### 8.4 End-to-end impact versus library impact

The report makes an important distinction. In the main `EmailVerifier`, exploitation is not straightforward because `AssertZeroPadding` is also applied to the email header and body lengths. The malicious length strategy would force constraints that are not practically satisfiable for a real nonzero message.

But as a library issue, the bug remains severe. A project importing `Sha256Bytes` or `Sha256BytesPartial` in a different context may not have the same protective constraints. The SHA template is a reusable primitive. If it can return zero for arbitrary inputs in isolation, every downstream usage must be reviewed.

Our reading is that this finding is less about SHA-256 and more about dynamic indexing. Whenever a circuit selects from an array using a witness-provided index, the index must be proven to be one of the allowed indices. A range check may not be enough if its own preconditions are not enforced. A robust selector often needs an exact-one proof over equality flags:

```text
sum_i eq(index, i) == 1
out = sum_i eq(index, i) * array[i]
```

That form directly proves membership in the index set.

## 9. High-value finding: undocumented input assumptions

Report finding:

```text
#06 - Templates do not document assumptions on input signals
Severity: Medium
Location: zk-email-verify/packages/circuits/*
```

This finding is less flashy than the all-zero SHA result, but it may be more important for long-term library safety.

The report lists many templates with implicit assumptions:

- SHA inputs are bits.
- SHA lengths fit into specific bit widths.
- byte arrays contain 8-bit values.
- subarray lengths fit into expected ranges.
- big integer limbs fit into configured limb sizes.
- Poseidon chunk inputs fit into chunk widths.
- `EmailVerifier` length signals fit into the logarithmic size implied by maximum lengths.

The underlying engineering tradeoff is real. A mature circuit library often avoids constraining every input inside every helper template, because repeated range checks are expensive. Instead, it constrains values at the point where they originate and documents the assumptions carried by those signals.

That policy is reasonable only if the assumptions are explicit. Otherwise, a downstream developer may import a helper template and miss the required upstream constraints.

Our view is that ZK libraries need an interface discipline similar to type systems. A signal should not merely be a field element. It should carry a documented semantic type:

```text
Byte: field element constrained to [0, 255]
Bit: field element constrained to {0, 1}
Index<N>: field element proven to be in [0, N)
Limb<n>: field element constrained to n bits
PaddedLength<Max>: field element constrained to a valid SHA block length
```

Circom does not enforce these types automatically. Documentation and template boundaries have to do the work. The SHA finding demonstrates how expensive it is when that discipline is missing.

## 10. High-value finding: complement regex leads to an unsound template

Report finding:

```text
#00 - Complement regex leads to unsound template
Severity: High
Location: zk-regex/packages/compiler/regex.rs
```

The problematic pattern is a complement character class, such as:

```text
[^ab]
```

In ordinary regex semantics, this matches one character that is not `a` or `b`. The report shows that, in the audited compiler, such a pattern could produce a circuit that accepts inputs it should reject.

Code path:

```text
zk-regex@9962a11
packages/compiler/src/regex.rs
packages/compiler/src/circom.rs
```

### 10.1 Why complement classes are dangerous in circuits

A positive class such as `[ab]` has a natural small representation:

```text
input == 'a' OR input == 'b'
```

A complement class is different:

```text
input is any valid byte except 'a' or 'b'
```

That is a much larger predicate. It also depends on what the alphabet is supposed to be. Is it ASCII? Any byte? Any valid UTF-8 byte sequence? Any Unicode scalar encoded as bytes? Does newline count? Does zero padding count?

The report notes that zk-regex works with UTF-8 encoded bytes in decimal representation. That makes complement semantics even more sensitive. If the compiler lowers complement classes incorrectly, the generated circuit may accept invalid messages or reveal wrong data.

### 10.2 Our interpretation

This finding is a compiler soundness issue. The developer writes a language predicate, but the generated circuit proves a different predicate.

For zkEmail, this matters because regexes are often treated as the application policy layer. A policy might say:

```text
The email body contains a code that does not contain separators.
The header field does not include forbidden characters.
The extracted username excludes whitespace.
```

Complement classes are a natural way to write such policies. If they are unsupported or incorrectly supported, the safe behavior is to reject them at compile time. Silent semantic drift is the worst outcome.

The report states that this specific finding did not affect the main `EmailVerifier` because it did not use the complement operator. That does not reduce the importance for applications using zk-regex as a policy compiler.

## 11. High-value finding: `^` and `$` did not behave as expected

Report finding:

```text
#03 - Start ('^') and end ('$') of line match does not work.
Severity: High
Location: zk-regex/packages/compiler/regex.rs
```

The report shows that `a` and `^a` could produce equivalent DFA behavior in the audited compiler, and that an input like `ba` could be accepted for `^a`.

This is a small example with large implications.

### 11.1 Anchoring is a semantic contract

Anchors are not cosmetic. In email proofs, the difference between these two statements is huge:

```text
Somewhere in the email there is a matching substring.
The email begins with this exact structure.
```

Similarly:

```text
Some line contains this field.
The field occurs at the specific boundary expected by the protocol.
```

Many regex-based security checks rely on anchoring to avoid substring confusion. If anchors do not work as expected, a malicious email can place a valid-looking fragment in a location that the application did not intend to accept.

### 11.2 The audited implementation's semantic tension

In `regex.rs`, each decomposed part is built with a formatted anchored pattern:

```text
^<regex_def>$
```

The DFA config also uses anchored start kind. Later, the generated Circom output checks whether the accept state is reached at some point in the scan. This creates a tension between full-string matching, substring matching, and user-supplied anchors.

The report's example shows the consequence: explicit anchors in the user regex did not provide the expected boundary guarantee.

Our reading is that this is not only a bug in `^` and `$`. It is a sign that the compiler needed a clearer top-level semantic model:

```text
Does generated `out` mean full input match?
Does it mean substring existence?
Does decomposed mode imply concatenation inside a larger search?
How are line boundaries represented in byte arrays?
How do anchors interact with zero padding?
```

Without a crisp answer, users will project familiar regex semantics onto a circuit that may be proving something else.

## 12. High-value finding: zk-regex lacked mature specification and testing

Report finding:

```text
#01 - The zk-regex compiler lacks specifications and is not mature
Severity: High
Location: zk-regex/packages/compiler
```

This finding ties many smaller observations together. The report points to crashes, invalid generated Circom, soundness issues, insufficient documentation, and limited testing. It also calls out implementation structure: `parse_dfa_output`, `dfa_to_graph`, and `gen_circom_allstr` are hard to reason about, with code generation logic concentrated in a large function.

Code paths:

```text
zk-regex@9962a11
packages/compiler/src/regex.rs
zk-regex@9962a11
packages/compiler/src/circom.rs
```

### 12.1 Why this matters more than normal compiler roughness

For ordinary developer tooling, a compiler crash is annoying. For ZK security, compiler behavior is part of the proof statement.

If a compiler accepts syntax, users will assume the generated circuit faithfully implements that syntax. If unsupported syntax crashes, the failure is visible. If unsupported syntax compiles into a subtly different predicate, the failure is a security bug.

The compiler needs a spec at three levels:

1. Source language spec: supported regex syntax and exact semantics.
2. Intermediate representation spec: DFA construction, byte alphabet, UTF-8 handling, decomposed-part merging.
3. Circuit semantics spec: what `out` and `reveal` mean relative to the input array.

The report's finding is valuable because it refuses to treat the concrete bugs as isolated accidents. The implementation style itself made subtle bugs likely.

### 12.2 Our view: zk-regex should be tested like a language runtime

A strong test strategy would compare multiple interpretations of the same regex:

```text
Rust regex engine result
DFA acceptance result
Generated Circom witness result
Generated proof acceptance result
Reveal array semantics
```

For each generated circuit, test cases should include:

- positive matches,
- negative matches,
- prefix and suffix confusion,
- zero padding cases,
- UTF-8 multi-byte characters,
- complement classes,
- anchors,
- alternation,
- repetition ranges,
- decomposed public/private boundaries,
- reveal-on-non-match behavior,
- reveal range exactness.

The key is differential testing. A compiler's output should be checked against an executable reference model. For zk-regex, the reference model is not only regex acceptance; it is also reveal semantics.

## 13. Medium findings with high privacy value: reveal array leakage

Report findings:

```text
#04 - The reveal array leaks inputs in a non-match
Severity: Medium
Location: zk-regex/packages/compiler

#05 - In accepting input, reveal array reveals more values than the matching ones
Severity: Medium
Location: zk-regex/packages/compiler
```

These are among the most important findings for understanding ZK application privacy.

### 13.1 Non-match leakage

The report gives a pattern like:

```text
aba
```

and an input like:

```text
aca
```

The circuit output is not a match, but the reveal array still exposes a byte from the input.

This violates a natural privacy invariant:

```text
If out == 0, reveal arrays should contain no private information.
```

Depending on the application, a non-match proof may not be submitted. But generated circuits should not rely on application behavior for privacy. A template that exposes private bytes on failed matches is dangerous in testing, debugging, aggregation, and any protocol that handles failed predicate outputs.

### 13.2 Over-reveal on accepted input

The report also shows a case where the regex matches part of the input, but the reveal array includes an additional byte outside the accepted match.

The intended invariant is:

```text
If out == 1, reveal_i contains exactly the bytes belonging to public part i of the accepted match path.
```

The phrase `accepted match path` is important. It is not enough for a byte to locally participate in a transition that resembles the public subpattern. It must belong to the same consecutive path that causes acceptance.

### 13.3 Our interpretation

Reveal bugs are not secondary just because they do not always let invalid statements prove. For zkEmail, selective disclosure is part of the product's security promise. A user is not merely proving an email claim; they are proving it while keeping the rest of the email hidden.

That means reveal arrays should be treated with the same seriousness as accept bits. The compiler should enforce privacy invariants as first-class properties.

A useful mental model is:

```text
out is the language predicate.
reveal is the declassification policy.
```

Both need formal semantics.

## 14. Low-severity finding with useful lessons: Base64 `A` versus `=`

Report finding:

```text
#07 - Base64Decode does not distinguish between 'A' and '='
Severity: Low
Location: zk-email-verify/packages/circuits/lib/base64.circom
```

Base64 maps `A` to zero. Padding character `=` is not a value character, but in the audited implementation `Base64Lookup` could return zero for both `A` and `=`. The report notes that this means some encodings can decode to the same bytes.

Code path:

```text
zk-email-verify@f2fb77c
packages/circuits/lib/base64.circom
```

This issue is low severity in context, but it carries a useful lesson: codecs are not only transformations. They are parsers with validity rules. In many cryptographic protocols, accepting multiple encodings for the same byte string can matter.

For zkEmail, Base64 appears in a narrow body-hash extraction context. The report accepted documentation of the behavior rather than requiring a full semantic change. That seems reasonable for the specific use case. But for libraries, codec ambiguity should always raise a question:

```text
Does the application need canonical encoding, or only decoded bytes?
```

If canonical encoding matters, the circuit must enforce it.

## 15. Low and informational findings: robustness still affects security

Several findings are lower severity but still valuable:

- valid regex patterns rejected,
- `.*` generated invalid Circom,
- alternation `|` caused compiler crashes,
- empty regex generated invalid Circom,
- invalid regex caused panics instead of structured errors,
- unused templates remained in the codebase.

These are not all immediate exploit paths. But in compiler-adjacent ZK tooling, reliability and security are close neighbors. Crashes and unsupported syntax push developers toward trial and error. Trial and error encourages weaker regexes, ad-hoc patches, and unreviewed assumptions.

The unused template finding is also more interesting than it first appears. The report points out that some unused templates were inherited from other projects and had known issues elsewhere. Keeping unused arithmetic templates in a circuit library expands the maintenance burden. Even if a template is not used by the main circuit, downstream users may import it and inherit old bugs.

Our view is simple: in circuit libraries, dead code is not free. If a template is present, someone may treat it as supported.

## 16. The most important theme: range checks are not optional metadata

The SHA finding and the undocumented-assumptions finding converge on one theme: field elements do not carry integer ranges by themselves.

A Circom signal is an element of the scalar field. When we say it is a byte, a bit, a length, or an index, that meaning exists only if constraints enforce it.

This is especially treacherous for comparators. Many comparator gadgets decompose expressions under assumptions about bit width. They are not universal order predicates over arbitrary field elements. In finite fields, a value near the modulus can behave like a negative integer under the developer's mental model but still be just another field element to the circuit.

The audit's SHA issue captures this perfectly:

```text
index < maxArrayLen
```

is not actually proven unless `index` is first proven to live in the intended integer domain.

A better review question is:

```text
Where does this signal become small?
```

Not:

```text
Where is this signal compared?
```

The difference is subtle but central.

## 17. The second most important theme: generated circuits need source-level and target-level specs

zk-regex is interesting because it creates a generated circuit from high-level syntax. The source-level syntax is regex. The target-level semantics are constraints over bytes and states.

For such a compiler, both sides need specs.

### Source-level questions

```text
Which regex features are supported?
Are anchors supported?
Are complement classes supported?
Is alternation supported?
Are repetition ranges supported?
What is the alphabet?
How is UTF-8 represented?
Does `.` match bytes, characters, or valid UTF-8 scalar values?
```

### Target-level questions

```text
Does out mean full-string match or substring match?
What happens with zero padding?
How are decomposed parts merged?
Can multiple accepting paths exist?
Which accepting path determines reveal arrays?
What should reveal arrays contain when out == 0?
How are overlapping matches handled?
```

The report's findings show that users cannot safely infer these answers from ordinary regex intuition. A ZK regex compiler is not just a regex engine. It is a proof statement generator.

## 18. The third most important theme: reachability matters, but library bugs still matter

A recurring nuance in the report is the difference between isolated template impact and end-to-end `EmailVerifier` impact.

Examples:

- Complement regex did not directly affect `EmailVerifier` because the main verifier did not use that operator.
- SHA-256 all-zero output was difficult to exploit in the main verifier because other constraints restricted the malicious length strategy.
- Undocumented template assumptions mostly affected library consumers rather than the main circuit directly.

This is good impact analysis. It avoids overstating end-to-end breakage. But it should not lead to underestimating the bugs.

zkEmail is a library ecosystem. Its circuits are meant to be composed into application-specific proofs. A downstream project may import `Sha256Bytes`, write its own regex circuit, expose reveal arrays, or use a helper template in a new context. The security of that downstream project depends on assumptions that may not be obvious from the flagship verifier.

Our takeaway is that ZK audit reports should classify findings along two axes:

```text
Isolated primitive severity
End-to-end reachability in the audited main circuit
```

Both axes matter.

## 19. What we learned from the project architecture

The architecture is strong because it divides responsibility cleanly:

```text
Email authenticity: DKIM signature and body hash.
Application semantics: regex constraints and selected reveals.
Public verification: pubkey hash and proof public signals.
```

But the same division creates security pressure at the interfaces.

### 19.1 DKIM is an excellent anchor, but not a complete application policy

DKIM proves that a domain signed certain bytes. It does not decide which semantic field the application should trust. The circuit must still parse and bind the right header and body regions.

### 19.2 Regex is expressive, but expressiveness becomes a compiler risk

The ability to describe email-specific extraction logic with regex is a major usability win. It lets applications build custom proofs without rewriting low-level circuits. But every regex feature becomes part of the proof language. Unsupported or partially supported features should fail loudly.

### 19.3 Dynamic lengths are necessary and dangerous

Email sizes vary. Circuits need maximum-length arrays with dynamic effective lengths. This makes padding, array selection, and length range checks fundamental security components rather than bookkeeping.

### 19.4 Reveal arrays deserve formal privacy invariants

The reveal mechanism is central to zkEmail's value. We would phrase the expected invariants as:

```text
No-match invariant:
  If out == 0, every reveal array is all zeros.

Exactness invariant:
  If out == 1, reveal_i contains exactly the bytes of public part i for the accepted match.

Masking invariant:
  Any byte outside the selected public substrings is zeroed.

Origin invariant:
  Every nonzero revealed byte equals the corresponding original input byte.
```

These invariants should be tested automatically for generated circuits.

## 20. Practical audit heuristics we would keep from this report

The report leaves us with a compact checklist for similar systems.

### 20.1 For every dynamic array index

Ask:

```text
Is the index proven to be in range?
Is the in-range proof itself sound for arbitrary field elements?
What does the selector output for invalid indices?
Is there an exact-one equality constraint?
```

### 20.2 For every comparator

Ask:

```text
Are both inputs range-constrained to the comparator's bit width?
Could a field element near the modulus satisfy the comparison unexpectedly?
Is the comparator being used as a range check without a separate bit decomposition?
```

### 20.3 For every helper template

Ask:

```text
Which inputs are assumed to be bits, bytes, limbs, indices, or bounded lengths?
Where are those assumptions enforced?
Are they documented at the template boundary?
Would a downstream developer know how to use this safely?
```

### 20.4 For every generated circuit

Ask:

```text
What is the source-language semantics?
What is the generated-circuit semantics?
Can they be different on anchors, complements, alternation, or padding?
Is there a reference model for differential testing?
```

### 20.5 For every reveal output

Ask:

```text
Can failed matches reveal anything?
Can successful matches reveal bytes outside the intended substring?
Can overlapping matches confuse reveal selection?
Can zero bytes hide leaks or create ambiguity?
```

## 21. Our final synthesis

zkEmail is compelling because it uses a real-world trust root, DKIM, and gives it a privacy-preserving programmable interface. The system's ambition is exactly the kind of bridge ZK is good at: proving facts about existing data without forcing that data into public view.

The report shows that this ambition comes with sharp edges. The hardest parts are not only the large cryptographic components. They are the semantic glue:

```text
Which bytes are signed?
Which body hash is extracted?
Which length selects the final hash state?
Which regex language is actually compiled?
Which substring is declassified?
```

The most valuable lesson is that ZK security is often about eliminating semantic gaps. A field element must become a byte through constraints. A regex must become a DFA through a specified compiler. A DFA must become Circom through a constrained state transition. A reveal array must become a precise declassification boundary.

When those conversions are explicit and tested, the system becomes much easier to trust. When they are implicit, even familiar components such as SHA-256, regex, and Base64 can produce surprising failures.

Our appreciation for zkEmail increased after reading the report. The design direction is exciting: make email proofs composable, private, and useful beyond email itself. At the same time, the report makes clear that the infrastructure around such proofs needs the rigor of both cryptographic engineering and compiler engineering.

The core idea is worth building on. The path to robustness is equally clear: tighter specs, fewer implicit assumptions, stronger generated-circuit tests, exact range constraints, and reveal semantics treated as first-class security properties.

## Appendix A. Finding map

| ID | Component | Risk | Why it matters |
| --- | --- | --- | --- |
| #00 | `zk-regex/packages/compiler/regex.rs` | High | Complement regex compiled to an unsound predicate. |
| #01 | `zk-regex/packages/compiler` | High | Compiler lacked specification, documentation, and robust tests. |
| #02 | `zk-email-verify/packages/circuits/lib/sha.circom` | High | Dynamic length and invalid index selection could make SHA output all zeros. |
| #03 | `zk-regex/packages/compiler/regex.rs` | High | `^` and `$` did not enforce expected boundaries. |
| #04 | `zk-regex/packages/compiler` | Medium | Reveal arrays could leak bytes even when the regex did not match. |
| #05 | `zk-regex/packages/compiler` | Medium | Reveal arrays could reveal bytes outside the accepted match. |
| #06 | `zk-email-verify/packages/circuits/*` | Medium | Helper templates had undocumented input assumptions. |
| #07 | `zk-email-verify/packages/circuits/lib/base64.circom` | Low | Base64 decoding ambiguity between `A` and `=`. |
| #08 | `zk-regex/packages/compiler` | Low | Some valid regexes were rejected. |
| #09 | `zk-regex/packages/compiler/regex.rs` | Low | `.*` generated Circom that failed to compile. |
| #0a | `zk-regex/packages/compiler/circom.rs` | Low | Alternation could crash the compiler. |
| #0b | `zk-email-verifier/packages/circuits/lib/*` | Low | Unused inherited templates expanded maintenance risk. |
| #0c | `zk-regex/packages/compiler` | Informational | Empty regex generated invalid Circom. |
| #0d | `zk-regex/packages/compiler` | Informational | Public compiler functions panicked instead of returning structured errors. |

## Appendix B. Stable code links

### Main verifier

- [`email-verifier.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/email-verifier.circom)

### zk-email-verify library circuits

- [`sha.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/lib/sha.circom)
- [`rsa.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/lib/rsa.circom)
- [`base64.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/lib/base64.circom)
- [`array.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/utils/array.circom)
- [`regex.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/utils/regex.circom)
- [`hash.circom`](https://github.com/zkemail/zk-email-verify/blob/f2fb77c/packages/circuits/utils/hash.circom)

### zk-regex compiler

- [`regex.rs`](https://github.com/zkemail/zk-regex/blob/9962a11/packages/compiler/src/regex.rs)
- [`circom.rs`](https://github.com/zkemail/zk-regex/blob/9962a11/packages/compiler/src/circom.rs)
