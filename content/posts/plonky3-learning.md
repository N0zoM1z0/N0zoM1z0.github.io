---
title: "Part I: Plonky3 Deep Dive: Reading a STARK Toolkit From the Source"
date: "2026-05-11"
slug: "plonky3-learning"
categories:
  - ZK
  - Learning Notes
tags:
  - plonky3
  - stark
  - learning
series: "Plonky3"
seriesPart: 1
---

# Part I: Plonky3 Deep Dive: Reading a STARK Toolkit From the Source

*Commit first. Challenge later. If it is not in the transcript, it did not happen.*

Plonky3 is best understood as a toolkit, not as a single proving system with one blessed `prove()` button and one fixed set of cryptographic choices. Its own README describes it as a collection of primitives for implementing polynomial IOPs, especially STARK-based systems. That sentence is accurate, but it undersells the engineering shape of the project.

The real idea is this:

```text
finite fields and packed arithmetic
    -> matrices, domains, DFTs, and low-degree extensions
    -> hashes, sponges, and Fiat-Shamir challengers
    -> Merkle commitments, MMCS, PCS, FRI, and Circle PCS
    -> AIR constraints
    -> univariate STARK, batch STARK, lookups, and examples
```

Plonky3 is a modular STARK/PIOP laboratory where almost every serious component is behind a Rust trait. Fields can be swapped. Domains can be swapped. DFT implementations can be swapped. Hashes and transcript challengers can be swapped. PCS backends can be swapped. The price is that the codebase has deep generics and long type signatures. The reward is that once the mental model clicks, the whole system becomes a set of carefully interlocking layers rather than an opaque prover.

This article walks through that stack from the bottom up and from the proving flow outward. The goal is not just to explain what each crate does, but to explain why the abstractions are shaped the way they are.

All source paths mentioned below are relative to the Plonky3 repository root.

## 1. The Repository as a Layered System

At the workspace level, Plonky3 is split into many small crates. A useful map is:

| Layer | Representative crates | Role |
|---|---|---|
| Field arithmetic | `field`, `monty-31`, `baby-bear`, `koala-bear`, `mersenne-31`, `goldilocks`, `bn254` | finite field traits, concrete fields, extensions, packing |
| Matrices and parallelism | `matrix`, `maybe-rayon`, `util` | trace and evaluation storage, row access, packed rows, parallel iteration |
| DFT and domains | `dft`, `circle`, `multilinear-util` | two-adic FFT/DFT, LDEs, Circle STARK domains, multilinear utilities |
| Commitments and PCS | `commit`, `merkle-tree`, `fri`, `whir`, `zk-codes` | MMCS, polynomial commitments, Merkle trees, FRI, WHIR, code-based tools |
| Hashes and transcripts | `challenger`, `symmetric`, `poseidon1`, `poseidon2`, `rescue`, `keccak`, `sha256`, `blake3`, `monolith` | Fiat-Shamir, sponges, permutations, hash functions |
| Constraint systems | `air`, `lookup`, `*-air` | AIR traits, constraint builders, lookup arguments, hash AIRs |
| Proving systems | `uni-stark`, `batch-stark`, `examples` | single-AIR STARK, batched STARK, executable examples |

That layering matters because Plonky3 does not try to hide the proof system from you. It expects you to assemble a proof system configuration out of components:

```text
base field
challenge extension field
DFT or circle-domain machinery
MMCS and Merkle hash
FRI parameters
Fiat-Shamir challenger
AIR
trace generator
STARK config
```

This is exactly what the example `examples/examples/prove_prime_field_31.rs` does. It lets you choose a field, an objective AIR, a DFT implementation, and a Merkle hash, then constructs the corresponding STARK config and runs proving and verification.

The design philosophy is trait-first composition. The code does not say "a STARK is BabyBear plus Poseidon2 plus FRI plus this one DFT." It says "a STARK config has a PCS, a challenge field, and a challenger." Everything else is built around that.

## 2. AIR: Where Computation Becomes Constraints

In a STARK, we usually do not prove a program directly. We prove that a table, called a trace, satisfies local algebraic rules.

Take Fibonacci:

```text
row | left | right
----+------+------
0   | 0    | 1
1   | 1    | 1
2   | 1    | 2
3   | 2    | 3
4   | 3    | 5
5   | 5    | 8
6   | 8    | 13
7   | 13   | 21
```

Each row stores:

```text
left  = F_i
right = F_{i+1}
```

The transition rule is:

```text
next.left  = local.right
next.right = local.left + local.right
```

Then we usually add boundary constraints:

```text
first row left  = public input a
first row right = public input b
last row right  = public output x
```

An AIR, or Algebraic Intermediate Representation, is the object that expresses those rules as polynomial constraints over trace rows.

### 2.1 `BaseAir` and `Air`

The core traits live in `air/src/air.rs`. In compressed form, they look like this:

```rust
pub trait BaseAir<F>: Sync {
    fn width(&self) -> usize;
    fn preprocessed_trace(&self) -> Option<RowMajorMatrix<F>> { None }
    fn preprocessed_width(&self) -> usize { 0 }
    fn num_periodic_columns(&self) -> usize { 0 }
    fn periodic_columns(&self) -> Vec<Vec<F>> { vec![] }
    fn main_next_row_columns(&self) -> Vec<usize> { (0..self.width()).collect() }
    fn preprocessed_next_row_columns(&self) -> Vec<usize> { (0..self.preprocessed_width()).collect() }
    fn num_constraints(&self) -> Option<usize> { None }
    fn max_constraint_degree(&self) -> Option<usize> { None }
    fn num_public_values(&self) -> usize { 0 }
}

pub trait Air<AB: AirBuilder>: BaseAir<AB::F> {
    fn eval(&self, builder: &mut AB);
}
```

`BaseAir` describes the static shape of the computation:

- main trace width,
- optional preprocessed columns,
- optional periodic columns,
- public value count,
- next-row access hints,
- optional constraint count and degree hints.

`Air::eval` is where the constraints are written.

The important part is the generic `AB: AirBuilder`. The AIR does not know whether it is being run by a debug checker, a symbolic analyzer, the prover, or the verifier. It just calls builder methods such as `main()`, `public_values()`, `when_transition()`, and `assert_eq()`.

That one design choice is the heart of Plonky3's AIR layer.

### 2.2 `AirBuilder` Is an Interpreter Interface

The builder trait in `air/src/builder.rs` provides the vocabulary for writing constraints:

```rust
fn main(&self) -> Self::MainWindow;
fn preprocessed(&self) -> &Self::PreprocessedWindow;
fn is_first_row(&self) -> Self::Expr;
fn is_last_row(&self) -> Self::Expr;
fn is_transition(&self) -> Self::Expr;
fn when<I: Into<Self::Expr>>(&mut self, condition: I) -> FilteredAirBuilder<'_, Self>;
fn when_first_row(&mut self) -> FilteredAirBuilder<'_, Self>;
fn when_last_row(&mut self) -> FilteredAirBuilder<'_, Self>;
fn when_transition(&mut self) -> FilteredAirBuilder<'_, Self>;
fn assert_zero<I: Into<Self::Expr>>(&mut self, x: I);
fn assert_eq<I1: Into<Self::Expr>, I2: Into<Self::Expr>>(&mut self, x: I1, y: I2);
fn assert_bool<I: Into<Self::Expr>>(&mut self, x: I);
fn public_values(&self) -> &[Self::PublicVar];
```

The builder carries two kinds of data:

- the variables visible to the AIR, such as current row, next row, preprocessed columns, and public values,
- the interpretation of an assertion, such as "panic if false", "collect symbolic expression", "append packed constraint", or "fold into a verifier accumulator."

This is why the same AIR can be used in four contexts:

| Builder | What it does |
|---|---|
| `DebugConstraintBuilder` | evaluates constraints on concrete trace rows during debug checks |
| `SymbolicAirBuilder` | extracts symbolic constraints, counts them, and estimates degree |
| `ProverConstraintFolder` | evaluates packed constraints over the quotient domain |
| `VerifierConstraintFolder` | evaluates constraints at a single out-of-domain point |

The AIR is written once. The interpretation changes.

### 2.3 The Fibonacci AIR in the Tests

The test file `uni-stark/tests/fib_air.rs` contains a compact example:

```rust
pub struct FibonacciAir {}

impl<F> BaseAir<F> for FibonacciAir {
    fn width(&self) -> usize {
        NUM_FIBONACCI_COLS
    }

    fn num_public_values(&self) -> usize {
        3
    }

    fn max_constraint_degree(&self) -> Option<usize> {
        Some(2)
    }
}
```

The width is two because the trace has `[left, right]`. The three public values are `a`, `b`, and `x`. The max constraint degree hint is `2` because the simple linear constraints are multiplied by row selectors such as `is_first_row`, `is_last_row`, or `is_transition`.

The evaluation logic is the real AIR:

```rust
impl<AB: AirBuilder> Air<AB> for FibonacciAir {
    fn eval(&self, builder: &mut AB) {
        let main = builder.main();
        let pis = builder.public_values();

        let a = pis[0];
        let b = pis[1];
        let x = pis[2];

        let local: &FibonacciRow<AB::Var> = main.current_slice().borrow();
        let next: &FibonacciRow<AB::Var> = main.next_slice().borrow();

        builder.when_first_row().assert_eq(local.left, a);
        builder.when_first_row().assert_eq(local.right, b);

        builder.when_transition().assert_eq(local.right, next.left);
        builder.when_transition().assert_eq(local.left + local.right, next.right);

        builder.when_last_row().assert_eq(local.right, x);
    }
}
```

There are five constraints:

```text
first row:     local.left  = a
first row:     local.right = b
transition:    next.left   = local.right
transition:    next.right  = local.left + local.right
last row:      local.right = x
```

One subtle but essential point: `when_transition()` is not ordinary control flow. It is a selector.

Conceptually:

```text
is_transition(row) * (local.right - next.left) = 0
```

On transition rows, the selector is nonzero, so the constraint is enforced. On the last row, the selector is zero, so the transition constraint vanishes. This matters because row-based checking uses a wrapping next-row convention: without `when_transition()`, the last row would accidentally be constrained against row zero. The prover and verifier use the corresponding domain-level next-point relation, and the same selector logic keeps the boundary row from becoming a bogus transition.

### 2.4 AIR as Polynomial Identities

Let `L(X)` and `R(X)` be the trace column polynomials over a domain `H = {1, h, h^2, ..., h^{N-1}}`. The row at `X` is:

```text
[L(X), R(X)]
```

The next row is:

```text
[L(hX), R(hX)]
```

The Fibonacci transition becomes:

```text
R(X) - L(hX) = 0
L(X) + R(X) - R(hX) = 0
```

Boundary constraints become:

```text
S_first(X) * (L(X) - a) = 0
S_first(X) * (R(X) - b) = 0
S_last(X)  * (R(X) - x) = 0
```

Transition constraints become:

```text
S_transition(X) * (R(X) - L(hX)) = 0
S_transition(X) * (L(X) + R(X) - R(hX)) = 0
```

This is the first major bridge: an execution trace becomes a collection of polynomial identities over a domain.

## 3. From AIR to STARK: The `uni-stark` Prover

The `uni-stark` crate is the single-AIR univariate STARK implementation. Its central configuration trait is in `uni-stark/src/config.rs`:

```rust
pub trait StarkGenericConfig: Clone {
    type Pcs: Pcs<Self::Challenge, Self::Challenger>;
    type Challenge: ExtensionField<Val<Self>>;
    type Challenger: FieldChallenger<Val<Self>>
        + CanObserve<<Self::Pcs as Pcs<Self::Challenge, Self::Challenger>>::Commitment>
        + CanSample<Self::Challenge>;

    fn pcs(&self) -> &Self::Pcs;
    fn initialise_challenger(&self) -> Self::Challenger;

    fn is_zk(&self) -> usize {
        Self::Pcs::ZK as usize
    }
}
```

This says a STARK configuration is:

- a polynomial commitment scheme,
- an extension field where challenges live,
- a Fiat-Shamir challenger.

The concrete `StarkConfig<Pcs, Challenge, Challenger>` simply stores those pieces.

### 3.1 Why the Challenge Field Is Usually an Extension Field

The trace values live in a base field, often a fast 31-bit field such as BabyBear or KoalaBear. Soundness challenges such as `alpha` and `zeta` are usually sampled from a larger extension field. For example, the tests use:

```text
Val       = BabyBear
Challenge = BinomialExtensionField<BabyBear, 4>
```

This gives a much larger challenge space without abandoning efficient base-field trace arithmetic. The code reflects that split everywhere:

```text
Val<SC>             = base field of the PCS domain
SC::Challenge       = extension field
PackedVal<SC>       = packed base field
PackedChallenge<SC> = packed extension field
```

### 3.2 The Prover Entry Point

The main prover function is `prove_with_preprocessed` in `uni-stark/src/prover.rs`. Its bounds already tell a story:

```text
A: Air<SymbolicAirBuilder<Val<SC>>>
 + for<'a> Air<ProverConstraintFolder<'a, SC>>
```

In debug builds, the AIR must also support `DebugConstraintBuilder`. So the same AIR must be interpretable by the symbolic analyzer, the prover folder, and optionally the debug checker.

The high-level flow is:

```text
1. Debug-check the trace constraints.
2. Compute trace degree and domain sizes.
3. Build an AirLayout.
4. Determine quotient chunk count from constraint degree.
5. Commit to the trace through the PCS.
6. Observe instance data and commitments into the challenger.
7. Sample alpha.
8. Evaluate folded constraints on the quotient domain.
9. Divide by the trace vanishing polynomial to get quotient values.
10. Flatten extension-field quotient values to base-field coordinates.
11. Commit to quotient chunks.
12. Sample zeta.
13. Open trace, quotient, optional preprocessed data, and optional randomization polynomial.
14. Return commitments, opened values, opening proof, and degree bits.
```

That is the STARK prover in one page.

### 3.3 Trace Domain and Extended Domain

The prover starts with:

```rust
let degree = trace.height();
let log_degree = log2_strict_usize(degree);
let log_ext_degree = log_degree + config.is_zk();
```

Here `degree` is the trace height `N`. If the PCS is zero-knowledge, Plonky3 extends the trace domain by one bit. The PCS reports this through `Pcs::ZK`, and `StarkGenericConfig::is_zk()` returns it as `0` or `1`.

The domains are then created through the PCS:

```rust
let trace_domain = pcs.natural_domain_for_degree(degree);
let ext_trace_domain = pcs.natural_domain_for_degree(degree * (config.is_zk() + 1));
```

This is important. `uni-stark` does not assume a specific domain implementation. For two-adic FRI, this is a multiplicative coset. For Circle STARKs, it is a circle-domain object. The STARK code only asks for the `PolynomialSpace` interface.

### 3.4 AirLayout, Degree, and Quotient Chunks

The prover constructs an `AirLayout`:

```text
preprocessed_width
main_width
num_public_values
num_periodic_columns
```

Then it computes how many quotient chunks are needed:

```rust
let log_num_quotient_chunks =
    get_log_num_quotient_chunks::<Val<SC>, A>(air, layout, config.is_zk());

let num_quotient_chunks = 1 << (log_num_quotient_chunks + config.is_zk());
```

Why chunks?

If all constraints are folded into one polynomial `C(X)`, and the trace is valid, then `C(X)` vanishes on the trace domain `H`. Therefore:

```text
Z_H(X) divides C(X)
```

and we can define:

```text
Q(X) = C(X) / Z_H(X)
```

But `Q(X)` may have higher degree than the original trace polynomials. Plonky3 splits it into lower-degree chunks that fit the PCS commitment strategy.

This split is not cosmetic. It is one of the places where the algebraic protocol and the commitment backend meet.

### 3.5 Committing the Trace

The trace is committed through the PCS:

```rust
let (trace_commit, trace_data) =
    pcs.commit([(ext_trace_domain, trace)]);
```

The commitment is sent to the verifier. The prover data is kept locally for later openings. For a FRI PCS, this commit step performs low-degree extension internally and commits the resulting evaluation matrix, usually through a Merkle-based MMCS.

From the STARK layer's perspective, the trace matrix is a batch of polynomial evaluations: each column is one trace polynomial.

### 3.6 Fiat-Shamir and the Constraint-Folding Challenge

The prover observes instance data into the transcript:

```text
degree bits
base degree bits
preprocessed width
trace commitment
optional preprocessed commitment
public values
```

Then it samples:

```rust
let alpha: SC::Challenge = challenger.sample_algebra_element();
```

`alpha` folds many constraints into one:

```text
C_folded(X) = C_0(X) + alpha*C_1(X) + alpha^2*C_2(X) + ...
```

This is a standard STARK soundness move. If any constraint is nonzero, a malicious prover needs the sampled challenge to make the random linear combination vanish anyway. Over a large extension field, that probability is small.

### 3.7 Quotient Evaluation

The prover creates a quotient domain disjoint from the trace domain:

```rust
let quotient_domain =
    ext_trace_domain.create_disjoint_domain(1 << (log_ext_degree + log_num_quotient_chunks));
```

It then pulls the committed trace evaluations on that quotient domain:

```rust
let trace_on_quotient_domain =
    pcs.get_evaluations_on_domain(&trace_data, 0, quotient_domain);
```

Now the prover evaluates:

```text
Q(x) = C_folded(x) / Z_H(x)
```

for every point in the quotient domain.

This is where `ProverConstraintFolder` appears. It evaluates the AIR over packed rows:

```text
take packed local rows
take packed next rows
compute selectors
run air.eval(&mut folder)
fold collected constraints with alpha powers
multiply by inverse vanishing value
```

The folder stores base-field and extension-field constraints separately:

```rust
pub base_constraints: Vec<PackedVal<SC>>,
pub ext_constraints: Vec<PackedChallenge<SC>>,
```

That is not just a code organization trick. Base constraints can stay in the base field and use packed SIMD arithmetic. The alpha powers are decomposed into base-field coordinates, so folding base constraints can be done as packed base-field dot products before reconstituting the extension-field result.

This is a good example of Plonky3's style: the protocol abstraction remains clean, but the hot path is engineered carefully.

### 3.8 Flattening the Quotient

The quotient values are extension-field elements. Many PCS backends commit base-field matrices. Since the quotient domain points lie in the base field, an extension-field polynomial can be decomposed into several base-field coordinate polynomials.

The code does exactly that:

```rust
let quotient_flat =
    RowMajorMatrix::new_col(quotient_values).flatten_to_base();
```

If the challenge field has dimension four over the base field, a one-column extension matrix becomes a four-column base-field matrix.

Then Plonky3 commits the quotient chunks:

```rust
let (quotient_commit, quotient_data) =
    pcs.commit_quotient(quotient_domain, quotient_flat, num_quotient_chunks);
```

### 3.9 Opening at `zeta`

After observing the quotient commitment, the prover samples an out-of-domain point:

```rust
let zeta: SC::Challenge = challenger.sample_algebra_element();
let zeta_next = trace_domain.next_point(zeta).expect(...);
```

It opens:

```text
trace(zeta)
trace(zeta_next), if the AIR reads next-row columns
quotient chunks(zeta)
preprocessed(zeta) and maybe preprocessed(zeta_next), if used
randomization polynomial, if ZK is enabled
```

The next-row openings are optimized by AIR hints:

```text
main_next_row_columns()
preprocessed_next_row_columns()
```

By default, Plonky3 assumes all columns may be read at the next row. AIR authors can override these methods to reduce openings when a constraint only uses the current row. The warning in `BaseAir` is serious: if an AIR lies about next-row access, verification can fail or worse.

## 4. The Verifier's Main Equation

The verifier in `uni-stark/src/verifier.rs` mirrors the prover, but with much less data. It has commitments, opened values, an opening proof, public values, and the AIR.

Its job is:

```text
1. Validate proof shape.
2. Reconstruct the trace and quotient domains.
3. Replay the transcript.
4. Resample alpha and zeta.
5. Verify PCS openings.
6. Recompose quotient(zeta) from chunks.
7. Run the same AIR at zeta.
8. Check C_folded(zeta) / Z_H(zeta) = Q(zeta).
```

### 4.1 Shape Checks Are Part of the Protocol Surface

The verifier first validates `degree_bits`:

```rust
validate_degree_bits(None, degree_bits, config.is_zk())?
```

This catches both oversized exponents and underflow in ZK mode before domain construction. The Fibonacci tests explicitly tamper with `degree_bits` to ensure the verifier returns structured errors instead of panicking.

The verifier also checks:

- public value length,
- trace opening width,
- optional next-row opening width,
- quotient chunk count,
- extension dimension of quotient chunks,
- consistency of randomization commitments with `Pcs::ZK`,
- consistency of preprocessed verifier keys.

This is not the flashy part of the protocol, but it is exactly the kind of defensive work a verifier needs because proofs are untrusted input.

### 4.2 Replaying the Transcript

The verifier does not trust challenges from the prover. It reconstructs them:

```text
observe degree bits
observe base degree bits
observe preprocessed width
observe trace commitment
observe optional preprocessed commitment
observe public values
sample alpha
observe quotient commitment
observe optional random commitment
sample zeta
```

If prover and verifier observe in a different order, the protocol breaks. The code keeps that ordering explicit.

### 4.3 Reconstructing the Quotient at `zeta`

The prover committed quotient chunks. The verifier receives each chunk opened at `zeta`. To get the actual quotient value, it recomposes:

```rust
recompose_quotient_from_chunks::<SC>(
    &quotient_chunks_domains,
    &opened_values.quotient_chunks,
    zeta,
)
```

The recomposition uses vanishing polynomials of the chunk domains to compute Lagrange-style coefficients. It also reassembles extension-field elements from base-field coordinates.

### 4.4 `verify_constraints`

The final STARK check is in `verify_constraints`:

```rust
let sels = trace_domain.selectors_at_point(zeta);

let mut folder = VerifierConstraintFolder {
    main,
    preprocessed,
    periodic_values,
    public_values,
    is_first_row: sels.is_first_row,
    is_last_row: sels.is_last_row,
    is_transition: sels.is_transition,
    alpha,
    accumulator: SC::Challenge::ZERO,
    ...
};

air.eval(&mut folder);

let folded_constraints = folder.accumulator;

if folded_constraints * sels.inv_vanishing != quotient {
    return Err(VerificationError::OodEvaluationMismatch { index: None });
}
```

The verifier folder's `assert_zero` implementation is intentionally small:

```rust
self.accumulator *= self.alpha;
self.accumulator += x.into();
```

Every AIR assertion is folded into a single accumulator. The verifier then checks:

```text
C_folded(zeta) / Z_H(zeta) = Q(zeta)
```

or equivalently:

```text
C_folded(zeta) * inv_Z_H(zeta) = Q(zeta)
```

That equation is the center of the univariate STARK.

## 5. Matrix: The Trace Is Both a Table and a Polynomial Family

The `matrix` crate exists because STARK data has two personalities.

From the AIR perspective:

```text
row i = machine state at step i
```

From the polynomial commitment perspective:

```text
column j = evaluations of trace polynomial T_j over the domain
```

`Matrix<T>` unifies these views. It provides:

```rust
fn width(&self) -> usize;
fn height(&self) -> usize;
fn get(&self, r: usize, c: usize) -> Option<T>;
fn row(&self, r: usize) -> Option<...>;
fn rows(&self) -> impl Iterator<...>;
fn par_rows(&self) -> impl IndexedParallelIterator<...>;
fn wrapping_row_slices(&self, r: usize, c: usize) -> Vec<...>;
```

### 5.1 `RowMajorMatrix`

The common dense representation is:

```rust
pub struct DenseMatrix<T, V = Vec<T>> {
    pub values: V,
    pub width: usize,
    _phantom: PhantomData<T>,
}

pub type RowMajorMatrix<T> = DenseMatrix<T>;
```

Height is implicit:

```text
height = values.len() / width
```

A Fibonacci trace with width two and height eight is one flat row-major buffer:

```text
[0, 1, 1, 1, 1, 2, 2, 3, 3, 5, 5, 8, 8, 13, 13, 21]
```

### 5.2 Wrapping Rows and Transition Constraints

The matrix trait has `wrapping_row_slices`, which supports the common "current row plus next row" access pattern. If the next row goes past the end, it wraps to row zero.

This is exactly why `when_transition()` matters. The last row's next row may be row zero at the access layer, but the transition selector disables transition constraints on the last row.

### 5.3 Vertical Packing

The prover's hot path is evaluating AIR constraints on many quotient-domain points. Instead of evaluating one point at a time, Plonky3 uses packed field values.

Vertical packing groups the same column across several rows:

```text
row0: [a0, b0]
row1: [a1, b1]
row2: [a2, b2]
row3: [a3, b3]

packed:
col0 = [a0, a1, a2, a3]
col1 = [b0, b1, b2, b3]
```

`vertically_packed_row_pair` is especially important because AIR constraints often need both local and next rows:

```text
local packed rows
next packed rows
    -> ProverConstraintFolder
    -> SIMD constraint evaluation
```

### 5.4 Flattening Extension Fields

`DenseMatrix::flatten_to_base` turns an extension-field matrix into a base-field matrix:

```rust
pub fn flatten_to_base<F: Field>(self) -> RowMajorMatrix<F>
where
    T: ExtensionField<F>,
```

If `Challenge` has dimension four over `Val`, then:

```text
height = n, width = 1 over Challenge
```

becomes:

```text
height = n, width = 4 over Val
```

This operation is used when committing quotient values through a base-field PCS.

## 6. Field Arithmetic and Packing: The Performance Bedrock

The `field` crate starts with `PrimeCharacteristicRing`, not `Field`. That is deliberate. AIR expressions may be real field elements, symbolic expressions, arrays, packed values, or extension elements. They all need ring-like operations.

`PrimeCharacteristicRing` gives:

```text
ZERO, ONE, TWO, NEG_ONE
addition, subtraction, multiplication, negation
from integers
double, halve, square, cube
boolean arithmetic helpers
```

Then `Field` adds inversion, division, serialization, packing, and a multiplicative generator:

```rust
pub trait Field:
    Algebra<Self>
    + RawDataSerializable
    + Packable
    + Copy
    + Div<Self, Output = Self>
    + ...
{
    type Packing: PackedField<Scalar = Self>;
    const GENERATOR: Self;
    fn try_inverse(&self) -> Option<Self>;
}
```

The key associated type is:

```text
type Packing
```

That is the gateway to SIMD-friendly operations. Plonky3's field layer is not just about correctness; it is designed around proving throughput.

The concrete 31-bit fields such as BabyBear and KoalaBear use the `monty-31` machinery. Mersenne31 has its own specialized path. The README also notes SIMD support such as AVX2, AVX-512, and NEON for relevant fields.

The practical consequence is simple: a STARK prover performs enormous amounts of field arithmetic, and Plonky3 makes field representation and packing first-class.

## 7. DFT and LDE: Moving Between Coefficients and Codewords

FRI-based STARKs need low-degree extensions. The `dft` crate provides the machinery for two-adic fields.

The central trait is `TwoAdicSubgroupDft` in `dft/src/traits.rs`. A compressed version of the interface is:

```rust
pub trait TwoAdicSubgroupDft<F: TwoAdicField>: Clone + Default {
    type Evaluations: BitReversibleMatrix<F> + 'static;

    fn dft_batch(&self, mat: RowMajorMatrix<F>) -> Self::Evaluations;
    fn idft_batch(&self, mat: RowMajorMatrix<F>) -> RowMajorMatrix<F>;
    fn coset_dft_batch(&self, mat: RowMajorMatrix<F>, shift: F) -> Self::Evaluations;
    fn coset_idft_batch(&self, mat: RowMajorMatrix<F>, shift: F) -> RowMajorMatrix<F>;
    fn lde_batch(&self, mat: RowMajorMatrix<F>, added_bits: usize) -> Self::Evaluations;
    fn coset_lde_batch(&self, mat: RowMajorMatrix<F>, added_bits: usize, shift: F) -> Self::Evaluations;
}
```

### 7.1 DFT and iDFT

If:

```text
f(X) = c_0 + c_1 X + ... + c_{n-1} X^{n-1}
```

and `H = {1, g, g^2, ..., g^{n-1}}`, then the DFT gives:

```text
[f(1), f(g), f(g^2), ..., f(g^{n-1})]
```

The batched version treats every matrix column as a polynomial and transforms all columns together.

iDFT reverses the operation: evaluations over the subgroup become coefficients.

### 7.2 Coset DFT

Coset DFT evaluates on:

```text
shift * H
```

The implementation uses the identity:

```text
f(shift * g^i) = sum_j c_j * shift^j * (g^i)^j
```

So it scales coefficients by powers of `shift`, then runs an ordinary DFT.

### 7.3 LDE

Low-degree extension takes evaluations over a small domain and evaluates the same polynomial over a larger domain:

```text
evaluations on H
    -> iDFT
coefficients
    -> zero pad
coefficients for larger size
    -> DFT or coset DFT
evaluations on K or shift*K
```

The default `coset_lde_batch` follows exactly that shape:

```rust
let mut coeffs = self.idft_batch(mat);
coeffs.values.resize(coeffs.values.len() << added_bits, F::ZERO);
self.coset_dft_batch(coeffs, shift)
```

This operation sits inside PCS commitment for FRI. When `uni-stark` calls `pcs.commit`, a FRI PCS will usually perform an LDE and commit the extended codeword.

### 7.4 Algebra-Valued DFT

The trait also supports algebra-valued transforms. If an extension field `E` is a vector space over base field `F`, then DFT over `E` can be decomposed into several DFTs over `F`.

The code flattens extension values to base coefficients, runs base-field DFTs, then reconstitutes extension elements. This is much faster than treating extension arithmetic as opaque in many settings.

## 8. PCS, MMCS, Merkle, and FRI

This layer is easy to confuse, so it helps to separate responsibilities:

```text
PCS:
    polynomial commitment interface

FRI:
    low-degree proof and opening proof logic

MMCS:
    matrix row commitment abstraction

MerkleTreeMmcs:
    concrete Merkle-based MMCS implementation
```

### 8.1 `Pcs`: The Polynomial Commitment Interface

The univariate PCS trait lives in `commit/src/pcs/univariate.rs`. In simplified form:

```rust
pub trait Pcs<Challenge, Challenger>
where
    Challenge: ExtensionField<Val<Self::Domain>>,
{
    type Domain: PolynomialSpace;
    type Commitment: Clone + Serialize + DeserializeOwned;
    type ProverData;
    type EvaluationsOnDomain<'a>: Matrix<Val<Self::Domain>> + 'a;
    type Proof: Clone + Serialize + DeserializeOwned;
    type Error: Debug;

    const ZK: bool;

    fn natural_domain_for_degree(&self, degree: usize) -> Self::Domain;
    fn commit(&self, evaluations: impl IntoIterator<Item = (Self::Domain, RowMajorMatrix<Val<Self::Domain>>)>) -> (Self::Commitment, Self::ProverData);
    fn commit_quotient(&self, quotient_domain: Self::Domain, quotient_evaluations: RowMajorMatrix<Val<Self::Domain>>, num_chunks: usize) -> (Self::Commitment, Self::ProverData);
    fn open(&self, ..., fiat_shamir_challenger: &mut Challenger) -> (OpenedValues<Challenge>, Self::Proof);
    fn verify(&self, ..., proof: &Self::Proof, fiat_shamir_challenger: &mut Challenger) -> Result<(), Self::Error>;
}
```

The PCS binds polynomial evaluations before challenges are sampled, then later proves openings at requested points.

The `Domain` associated type is also abstract. A two-adic PCS uses a multiplicative coset. Circle PCS uses a circle domain. The STARK layer does not need to know which one it is.

### 8.2 `PolynomialSpace`

The PCS domain must support operations such as:

```text
size
first_point
next_point
create_disjoint_domain
split_domains
split_evals
vanishing_poly_at_point
selectors_at_point
evaluate_polynomial_at
evaluate_periodic_column_at
```

This interface is why `uni-stark` can ask:

```text
trace_domain.next_point(zeta)
trace_domain.selectors_at_point(zeta)
trace_domain.vanishing_poly_at_point(zeta)
```

without caring whether the domain is a two-adic coset or a circle twin-coset.

### 8.3 `Mmcs`: Mixed Matrix Commitment Scheme

The `Mmcs` trait in `commit/src/mmcs.rs` generalizes vector commitments to matrices:

```rust
pub trait Mmcs<T: Send + Sync + Clone>: Clone {
    type ProverData<M>;
    type Commitment;
    type Proof;
    type Error;

    fn commit<M: Matrix<T>>(&self, inputs: Vec<M>) -> (Self::Commitment, Self::ProverData<M>);
    fn open_batch<M: Matrix<T>>(&self, index: usize, prover_data: &Self::ProverData<M>) -> BatchOpening<T, Self>;
    fn verify_batch(&self, commit: &Self::Commitment, dimensions: &[Dimensions], index: usize, batch_opening: BatchOpeningRef<'_, T, Self>) -> Result<(), Self::Error>;
}
```

The "mixed" part is important: an MMCS can commit several matrices at once, even if their heights and widths differ.

When opening a global row index, smaller matrices map that index by dropping low-order bits:

```text
j = index >> (log2_ceil(max_height) - log2_ceil(matrix_height))
```

This is exactly what FRI needs because FRI folding creates matrices of shrinking height.

### 8.4 `MerkleTreeMmcs`

`merkle-tree/src/mmcs.rs` implements an MMCS with a generalized Merkle tree.

Suppose we commit a height-eight matrix `M` and a height-two matrix `N`. The tree begins with row hashes of `M`. When the tree reaches the layer corresponding to height two, it injects row hashes of `N`. A proof for a global row can then open both `M` and the corresponding row of `N` using one mixed Merkle path.

The commitment is a `MerkleCap`, not necessarily a single root. If `cap_height = 0`, it is just the root. If `cap_height = h`, it contains `2^h` digests from near the top of the tree. Larger caps reduce proof length at the cost of larger commitments.

This is a pragmatic protocol-engineering detail: FRI proofs already have many Merkle openings, and cap height lets implementers choose a proof-size versus commitment-size tradeoff.

### 8.5 FRI PCS

The two-adic FRI PCS is in `fri/src/two_adic_pcs.rs`:

```rust
pub struct TwoAdicFriPcs<Val, Dft, InputMmcs, FriMmcs> {
    dft: Dft,
    mmcs: InputMmcs,
    fri: FriParameters<FriMmcs>,
}
```

Its role is to implement `Pcs` by combining:

- a DFT/LDE engine,
- an input MMCS for committed evaluation matrices,
- FRI parameters and an MMCS for FRI folding layers.

At the PCS layer, the core opening intuition is:

```text
To prove f(z) = y, prove that (f(X) - y) / (X - z) is low degree.
```

If `y` is truly `f(z)`, the numerator is divisible by `X - z`. If `y` is not the real value, the derived quotient will generally fail the low-degree test.

FRI then proves low degree by repeatedly folding the evaluation vector. In arity two, the fold has the familiar even/odd decomposition:

```text
f_next(x^2) = (f(x) + f(-x))/2 + beta * (f(x) - f(-x))/(2x)
```

Each round commits to the folded vector. Later, random queries check that the folding was performed consistently.

`FriParameters` controls:

```text
log_blowup
log_final_poly_len
max_log_arity
num_queries
commit_proof_of_work_bits
query_proof_of_work_bits
mmcs
```

The proof-of-work bits are supported by the challenger layer and reduce the prover's ability to grind for favorable query randomness.

## 9. Challenger and Hash Abstractions

STARKs are interactive protocols made non-interactive by Fiat-Shamir. Plonky3's `challenger` crate provides the transcript abstraction.

The fundamental traits are:

```rust
pub trait CanObserve<T> {
    fn observe(&mut self, value: T);
}

pub trait CanSample<T> {
    fn sample(&mut self) -> T;
}

pub trait CanSampleBits<T> {
    fn sample_bits(&mut self, bits: usize) -> T;
}

pub trait FieldChallenger<F: Field>:
    CanObserve<F> + CanSample<F> + CanSampleBits<usize> + Sync
{
    fn observe_algebra_element<A: BasedVectorSpace<F>>(&mut self, alg_elem: A);
    fn sample_algebra_element<A: BasedVectorSpace<F>>(&mut self) -> A;
}
```

The extension-field methods are essential. A challenge such as `alpha: BinomialExtensionField<BabyBear, 4>` is sampled by sampling four base-field coefficients.

### 9.1 `DuplexChallenger`

`DuplexChallenger` is the field-native sponge challenger:

```rust
pub struct DuplexChallenger<F, P, const WIDTH: usize, const RATE: usize> {
    pub sponge_state: [F; WIDTH],
    pub input_buffer: Vec<F>,
    pub output_buffer: Vec<F>,
    pub permutation: P,
}
```

It uses:

```text
WIDTH = sponge state width
RATE  = input/output part of the state
capacity = WIDTH - RATE
```

On `observe`, it clears old output, buffers input, and duplexes when the rate fills. On `sample`, it duplexes if there is pending input or no available output, then pops a field element.

This gives the standard Fiat-Shamir discipline:

```text
observe all data that should bind the next challenge
then sample
```

The order is the protocol.

### 9.2 Byte-Oriented Challengers

Plonky3 also supports byte-hash transcripts:

```text
HashChallenger<u8, Keccak256Hash, 32>
SerializingChallenger32<F, ...>
SerializingChallenger64<F, ...>
```

The serializing challenger bridges field elements and byte hashes:

```text
observe field element -> serialize to bytes -> hash transcript
sample bytes -> rejection sample field element
```

This is useful when the Merkle or transcript hash is Keccak, SHA-256, or BLAKE3 rather than a field-native permutation.

### 9.3 The `symmetric` Crate

The `symmetric` crate defines common cryptographic building blocks:

```text
Permutation
CryptographicPermutation
CryptographicHasher
compression functions
sponge hashes
MerkleCap and Hash wrappers
```

`PaddingFreeSponge` is used for fixed-length inputs such as Merkle leaves. The source explicitly warns that it is not suitable for attacker-controlled variable-length input because lack of padding can create trivial collisions. For variable-length input, `Pad10Sponge` exists.

This is the kind of detail that matters in a cryptographic library. The abstraction is generic, but the security contract is still visible.

### 9.4 Poseidon2 as a Reusable Permutation

Poseidon2 implementations can serve multiple roles:

```text
Fiat-Shamir challenger
Merkle leaf sponge hasher
Merkle internal compression
hash AIR objective
```

The example type aliases make this clear. A Poseidon2-based STARK config can use:

```text
TwoAdicFriPcs
Poseidon2MerkleMmcs
ExtensionMmcs
DuplexChallenger
```

The same broad cryptographic family can be used in both the protocol transcript and the commitment tree, while the AIR being proven may be something entirely different, such as Keccak.

## 10. The Example Pipeline: `prove_prime_field_31.rs`

The example `examples/examples/prove_prime_field_31.rs` is a full assembly guide. It lets the user choose:

```text
--field:
    baby-bear, koala-bear, mersenne-31

--objective:
    blake-3-permutations, keccak-f-permutations, poseidon-2-permutations

--log-trace-length:
    trace height exponent

--discrete-fourier-transform:
    recursive-dft, radix-2-dit-parallel, small-batch-dft, none

--merkle-hash:
    keccak-f, poseidon-2
```

The key lesson is that "what you prove" and "what hash you use for the proof system" are different choices.

For example:

```text
objective = Keccak-F AIR
Merkle hash = Poseidon2
```

is conceptually fine if the type constraints are satisfied. The objective AIR describes the computation being proven. The Merkle hash is part of the PCS backend.

### 10.1 BabyBear and KoalaBear

BabyBear and KoalaBear use the two-adic FRI path:

```text
base field: BabyBear or KoalaBear
challenge field: BinomialExtensionField<base, 4>
PCS: TwoAdicFriPcs
DFT: selected by CLI
```

For Poseidon2 AIR, the code constructs `VectorizedPoseidon2Air` with field-specific constants:

```text
state width = 16
vector length = 8
S-box degree = field-specific
partial rounds = field-specific
linear layers = field-specific
```

BabyBear and KoalaBear even differ in `SBOX_REGISTERS`, which is a reminder that the same high-level primitive can have field-specific AIR layout choices.

### 10.2 Mersenne31

Mersenne31 takes the Circle STARK path:

```text
base field: Mersenne31
challenge field: BinomialExtensionField<Mersenne31, 3>
PCS: CirclePcs
DFT option: not user-selected in this example
```

The example rejects explicit DFT options for Mersenne31 because this path is not using the same two-adic DFT backend exposed for BabyBear and KoalaBear.

### 10.3 Type Aliases as Documentation

`examples/src/types.rs` hides large generic types behind aliases:

```text
KeccakStarkConfig
KeccakCircleStarkConfig
Poseidon2StarkConfig
Poseidon2CircleStarkConfig
```

These aliases are worth reading because they reveal the full stack:

```text
StarkConfig<
    TwoAdicFriPcs<
        F,
        DFT,
        input MMCS,
        extension MMCS
    >,
    EF,
    challenger
>
```

Once you can read that type, Plonky3 becomes much less intimidating.

## 11. Preprocessed and Periodic Columns

Plonky3's AIR layer has two useful mechanisms beyond the main trace.

### 11.1 Preprocessed Trace

`BaseAir::preprocessed_trace()` can return a matrix of columns derived from public, reusable data rather than from the witness. These columns are committed separately and can be reused through setup functions.

The prover code is strict:

```text
if the AIR declares preprocessed_width > 0,
prove_with_preprocessed expects PreprocessedProverData.
```

This avoids accidentally materializing or committing preprocessed data inconsistently.

### 11.2 Periodic Columns

Periodic columns are public values that repeat with a fixed period dividing the trace length. They are not committed as witness trace columns. Instead, both prover and verifier derive their values from public data.

`BaseAir` exposes:

```text
num_periodic_columns()
periodic_columns()
periodic_values(row_index)
periodic_columns_matrix()
```

The PCS also has `build_periodic_lde_table`, with a fast path hook. This matters because periodic columns still need to be evaluated over quotient domains during constraint evaluation.

These features are easy to miss if you only look at Fibonacci, but they are important for real AIRs, especially hash and VM-style AIRs with round constants or fixed tables.

## 12. Batch STARK: Many AIRs, One Proof System

The `batch-stark` crate extends the single-AIR story.

Real zkVMs rarely have one AIR. They have many:

```text
CPU AIR
memory AIR
range-check AIR
Keccak AIR
Poseidon AIR
byte table AIR
instruction table AIR
```

Running a completely separate STARK for each one would duplicate transcript work, FRI work, opening proofs, and lookup machinery. Batch STARKs let multiple instances share commitments and opening rounds.

The crate documentation shows the shape:

```rust
let instances = vec![
    StarkInstance { air: &air1, trace: trace1, public_values: pv1 },
    StarkInstance { air: &air2, trace: trace2, public_values: pv2 },
];

let prover_data = ProverData::from_instances(&config, &instances);
let proof = prove_batch(&config, &instances, &prover_data);
verify_batch(&config, &[air1, air2], &proof, &[pv1, pv2], common)?;
```

The batch prover pipeline is roughly:

```text
1. collect instance metadata
2. commit all main traces together
3. sample lookup challenges if needed
4. generate and commit permutation traces for lookup arguments
5. sample alpha
6. compute quotient polynomials per AIR
7. commit all quotient chunks together
8. sample zeta
9. open main, quotient, preprocessed, permutation, and optional randomization data
```

The key pattern is:

```text
quotient computation = per AIR
commitment and opening = batched globally
```

That is exactly the kind of structure a zkVM needs.

## 13. Lookup: From Local Constraints to Table and Bus Consistency

The `lookup` crate implements LogUp-style lookup arguments for STARKs. It supports both:

```text
local lookup:
    within one AIR

global lookup:
    across AIRs through a named bus
```

This solves problems that are awkward or expensive as direct AIR constraints:

```text
range checks
byte decomposition
memory consistency
opcode tables
cross-AIR send/receive messages
```

### 13.1 Interaction Builder

AIRs declare interactions through builder extensions:

```rust
fn push_interaction(
    &mut self,
    bus_name: &str,
    fields: impl IntoIterator<Item = E>,
    count: impl Into<Self::Expr>,
    count_weight: u32,
);

fn push_local_interaction(
    &mut self,
    tuples: impl IntoIterator<Item = (Vec<Self::Expr>, Self::Expr)>,
);
```

Then `InteractionSymbolicBuilder` can run the AIR symbolically and extract lookup declarations.

### 13.2 LogUp Intuition

A lookup multiset equality can be expressed as:

```text
product (alpha - a_i)^{m_i} = product (alpha - b_i)^{m'_i}
```

LogUp transforms this into a logarithmic-derivative style sum:

```text
sum m_i / (alpha - a_i) = sum m'_i / (alpha - b_i)
```

For tuples, fields are compressed with a random challenge, often written as:

```text
combined = key_0 * beta^2 + key_1 * beta + key_2
```

Then the denominator is:

```text
alpha - combined
```

The prover creates a running-sum auxiliary column:

```text
s[0] = 0
s[i+1] = s[i] + contribution[i]
final condition checks the sum
```

For global lookups, each AIR contributes a cumulative sum to a named bus. The verifier checks that all cumulative sums for the bus cancel.

This is the bridge from "each AIR locally follows its transition rules" to "different AIRs agree on shared events."

## 14. Circle STARKs: Another Domain Under the Same Interface

The `circle` crate implements a framework based on Circle STARKs. Traditional STARKs often use multiplicative subgroup cosets:

```text
gH = {g, gh, gh^2, ...}
```

Circle STARKs use points on a finite-field unit circle and a twin-coset structure.

The key implementation idea is that `CircleDomain` still implements the `PolynomialSpace` interface. It provides:

```text
size
first_point
next_point
create_disjoint_domain
split_domains
split_evals
vanishing_poly_at_point
selectors_at_point
selectors_on_coset
evaluate_polynomial_at
evaluate_periodic_column_at
```

That means `uni-stark` can still use:

```text
trace_domain.next_point(zeta)
trace_domain.selectors_at_point(zeta)
trace_domain.vanishing_poly_at_point(zeta)
```

without knowing the domain is circle-based.

`CirclePcs` then implements `Pcs` for `CircleDomain`. Its commit path converts natural-order evaluations into circle evaluations, extrapolates to a larger circle domain, converts to CFFT order, and commits with an MMCS.

The deeper circle-specific steps happen inside the PCS opening protocol, including deep quotient reduction and folding. But the upper STARK interface remains familiar.

This is one of the strongest examples of Plonky3's architecture paying off: change the domain and PCS internals, keep much of the AIR and STARK logic reusable.

## 15. WHIR and `zk-codes`: Beyond the Classic FRI Path

Plonky3 also contains newer or more experimental directions.

### 15.1 WHIR

The `whir` crate describes itself as a Reed-Solomon proximity test with fast verification, serving as a multilinear polynomial commitment scheme.

This points toward a different PCS world:

```text
univariate trace polynomials
    -> multilinear extensions
    -> sumcheck-style protocols
    -> Reed-Solomon proximity testing
```

It is not just "another FRI implementation." It reflects the broader shift in proof-system engineering toward multilinear PCS and sumcheck-heavy designs.

### 15.2 `zk-codes`

The `zk-codes` crate contains zero-knowledge code tools, including Reed-Solomon-related encoding. The basic idea is:

```text
message coefficients + random mask coefficients
    -> Reed-Solomon evaluation
    -> verifier sees queried codeword positions without learning the message directly
```

This kind of layer is useful when the codeword itself is queried by a verifier and the protocol needs hiding, not only binding and low-degree soundness.

## 16. The Core Security Story

Plonky3's components can feel numerous, but the core STARK security story is compact.

### 16.1 AIR Soundness

If the trace does not represent a valid computation, at least one AIR constraint is nonzero on the trace domain.

### 16.2 Random Constraint Folding

Many constraints are folded with a random extension-field challenge `alpha`. A bad trace is unlikely to make the folded constraint vanish everywhere unless the sampled challenge lands in a small exceptional set.

### 16.3 Quotient Identity

If the folded constraint vanishes on the trace domain `H`, then:

```text
C_folded(X) = Z_H(X) * Q(X)
```

The verifier checks this at a random point `zeta`.

### 16.4 PCS Binding

The prover commits to trace and quotient data before learning later challenges. It cannot freely change polynomial values after seeing `zeta`.

### 16.5 FRI Low-Degree Soundness

FRI checks that committed codewords are close to low-degree polynomials and that claimed openings are consistent with those polynomials.

### 16.6 Fiat-Shamir Binding

All challenges are derived from transcript data:

```text
commitments
public values
opened values
FRI commitments
proof-of-work witnesses
```

The prover cannot choose challenges independently.

### 16.7 Lookup Soundness

Lookup arguments compress tuples randomly and enforce LogUp running sums. Incorrect table or bus behavior should break the local or global cumulative checks with high probability.

## 17. The Core Engineering Story

The engineering story is just as important as the cryptographic one.

Plonky3 is trying to keep abstraction and performance alive at the same time:

```text
trait abstraction:
    AirBuilder, Pcs, Mmcs, Matrix, Dft, FieldChallenger

monomorphized generics:
    large types, but specialized compiled code

field performance:
    Montgomery fields, Mersenne fields, packing, SIMD paths

matrix performance:
    row-major storage, parallel rows, vertical packing, horizontal packing

DFT performance:
    bit-reversal views, coset shifts, batch transforms

FRI performance:
    batched openings, variable arity, proof-of-work, MMCS reuse

lookup performance:
    batch inversion, prefix sums, auxiliary traces

Merkle performance:
    packed row hashing, mixed-height trees, Merkle caps
```

This explains why the code sometimes looks more complex than the protocol diagram. The protocol diagram is clean. The implementation has to be fast.

## 18. How to Read Plonky3 Without Getting Lost

A good reading route is:

### 18.1 Start With the Fibonacci Test

Read `uni-stark/tests/fib_air.rs`. It shows:

```text
BaseAir
Air::eval
trace generation
public values
two-adic config
Circle config
ZK config
prove and verify
invalid proof shape tests
```

This file is small enough to hold in your head but rich enough to reveal the real abstractions.

### 18.2 Then Read `air`

Read:

```text
air/src/air.rs
air/src/builder.rs
air/src/filtered.rs
air/src/symbolic
```

Focus on what a builder provides and how selectors become filtered constraints.

### 18.3 Then Read `uni-stark`

Read:

```text
uni-stark/src/config.rs
uni-stark/src/prover.rs
uni-stark/src/folder.rs
uni-stark/src/verifier.rs
```

Keep one equation in mind:

```text
C_folded(zeta) / Z_H(zeta) = Q(zeta)
```

Nearly everything in the prover and verifier exists to make that equation meaningful, binding, and efficiently checkable.

### 18.4 Then Read the PCS Stack

Read:

```text
commit/src/pcs/univariate.rs
commit/src/mmcs.rs
merkle-tree/src/mmcs.rs
fri/src/two_adic_pcs.rs
fri/src/prover.rs
```

Separate the responsibilities:

```text
Pcs opens polynomials
FRI proves low degree and opening consistency
MMCS opens matrix rows
MerkleTreeMmcs implements MMCS
```

### 18.5 Then Read the Example Assembly

Read:

```text
examples/examples/prove_prime_field_31.rs
examples/src/types.rs
examples/src/airs.rs
examples/src/dfts.rs
```

This teaches you how the library is actually meant to be assembled.

## 19. Final Mental Model

Plonky3's core pipeline is:

```text
computation
    -> trace table
    -> AIR constraints
    -> folded constraint polynomial C
    -> quotient polynomial Q = C / Z_H
    -> commitments to trace and quotient
    -> Fiat-Shamir challenges alpha and zeta
    -> PCS openings at zeta
    -> verifier checks C(zeta) = Z_H(zeta) * Q(zeta)
    -> FRI and Merkle make the openings believable
```

The core architecture is:

```text
AIR says what is valid.
Matrix stores the data.
Field and packing make arithmetic fast.
DFT and domains move between trace and codeword views.
PCS commits to polynomials.
MMCS and Merkle commit to matrices.
FRI proves low degree.
Challenger makes the protocol non-interactive.
uni-stark ties the single-AIR protocol together.
batch-stark, lookup, circle, whir, and zk-codes push the system outward.
```

That is why Plonky3 is rewarding to read. It is not a black-box prover. It is a modular proof-system workbench where the cryptographic protocol, algebraic representation, and performance engineering are all visible in the source.

Once you see the layers, the generics stop looking like noise. They become the map.
