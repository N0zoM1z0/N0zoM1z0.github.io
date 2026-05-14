---
title: "Part II: Roots of Trust: The Algebra Beneath Plonky3 and Modern STARKs"
date: "2026-05-14"
slug: "plonky3-roots-of-trust"
categories:
  - ZK
  - Learning Notes
tags:
  - plonky3
  - stark
  - algebra
series: "Plonky3"
seriesPart: 2
---

# Part II: Roots of Trust: The Algebra Beneath Plonky3 and Modern STARKs

*Commit first. Fold later. If it is not in the transcript, it did not happen.*

Plonky3 is easiest to misunderstand if we read it as a large Rust repository. The generics are long, the traits are layered, and the concrete examples assemble enough types to look like a proving-system incantation. But the code becomes far less mysterious once we read it as a sequence of mathematical reductions:

```text
execution trace
    -> polynomial identities
    -> quotient identity over a vanishing set
    -> Reed-Solomon codeword
    -> low-degree proximity test
    -> Merkle-opened random coordinates
    -> Fiat-Shamir transcript
```

The important point is not merely that Plonky3 implements STARK components. The deeper point is that Plonky3 exposes the algebraic seams that a STARK normally hides. A domain is not hard-coded. A polynomial commitment scheme is not hard-coded. A field is not hard-coded. A transcript challenger is not hard-coded. Even the meaning of "the next row" is abstracted through a domain interface.

That trait-heavy design is not accidental. It mirrors the mathematics. STARKs are not one trick. They are a stack of algebraic tricks that happen to compose unusually well.

This article is a research-style tour of the mathematics behind that stack. The goal is not to repeat the source map from the previous Plonky3 deep dive, but to explain the principles underneath it: finite fields, two-adic domains, AIR constraints, quotient polynomials, Reed-Solomon distance, FRI folding, extension fields, LogUp lookups, sumcheck, Circle STARKs, barycentric recomposition, and Fiat-Shamir sponges.

The bias here is explicit: formulas matter, but formulas are not the end of the story. The real engineering question is always the same:

```text
Which algebraic fact lets us replace an expensive operation by a cheap one?
```

That question is where Plonky3 becomes interesting.

## 1. The first reduction: computation becomes a table

A STARK does not prove a program directly. It proves that a table is valid.

For a tiny Fibonacci computation, the table might be:

```text
row | left | right
----+------+------
0   | 0    | 1
1   | 1    | 1
2   | 1    | 2
3   | 2    | 3
4   | 3    | 5
5   | 5    | 8
```

The machine rule is local:

```text
next.left  = local.right
next.right = local.left + local.right
```

Boundary rules pin the first and last rows:

```text
first.left  = a
first.right = b
last.right  = x
```

This table is called the trace. In Plonky3, an AIR, or Algebraic Intermediate Representation, describes the shape of this trace and the constraints that valid rows must satisfy. The important abstraction is that an AIR is not tied to a single execution mode. The same `Air::eval` can be interpreted by a debug checker, a symbolic analyzer, a prover-side constraint folder, or a verifier-side constraint folder.

That is a crucial design decision. The AIR writes mathematics once. Different builders interpret the assertions in different ways.

If the AIR says:

```rust
builder.when_transition().assert_eq(local.right, next.left);
```

it is not really saying "run an if statement." It is constructing a polynomial condition that is enforced on transition rows and disabled on the last row.

That distinction is the first place where the code and the algebra touch.

## 2. The second reduction: the table becomes polynomials

Let the trace have height $N$. Choose a domain

$$
H = \{1, h, h^2, \ldots, h^{N-1}\}
$$

where $h$ has order $N$. Each row index is now a field element. Row $i$ corresponds to $h^i$.

Each trace column becomes a polynomial by interpolation. For the Fibonacci trace, define two polynomials $L(X)$ and $R(X)$ such that:

$$
L(h^i) = \text{left}_i, \qquad R(h^i) = \text{right}_i.
$$

The next row is not an array lookup anymore. It is multiplication by $h$ inside the domain:

$$
\text{local at } X = (L(X), R(X)),
$$

$$
\text{next at } X = (L(hX), R(hX)).
$$

So the transition constraints become polynomial identities:

$$
R(X) - L(hX) = 0,
$$

$$
L(X) + R(X) - R(hX) = 0.
$$

Boundary constraints are handled with selector polynomials. A selector is a polynomial that is nonzero where a condition should be enforced and zero where it should be ignored. For example:

$$
S_{\text{first}}(X)(L(X) - a) = 0,
$$

$$
S_{\text{last}}(X)(R(X) - x) = 0,
$$

$$
S_{\text{transition}}(X)(R(X)-L(hX)) = 0.
$$

This is why `when_transition()` matters. At the matrix level, Plonky3 can use wrapping row access: the next row after the last row may be row zero. At the algebra level, the transition selector kills the constraint on the last row, so the wrap does not become a false recurrence.

The first real insight is that the trace table is not the object the verifier wants to inspect. The verifier wants to inspect a small number of polynomial identities that certify the entire table.

## 3. Finite fields: exact arithmetic with engineered primes

All of this happens over finite fields.

A prime field is:

$$
\mathbb{F}_p = \{0,1,2,\ldots,p-1\}
$$

with addition and multiplication modulo a prime $p$. It has two properties that STARKs need:

1. Arithmetic is exact. There is no floating-point rounding.
2. Every nonzero element has a multiplicative inverse.

The choice of $p$ is not just a mathematical preference. It is an engineering decision.

Small fields such as BabyBear, KoalaBear, and Mersenne31 are attractive because they fit efficiently in machine words and can be packed into SIMD lanes. Plonky3 leans into this. Its field layer starts with ring-like traits and then adds field operations, extension fields, and packing. That is the right abstraction for a prover: most operations are not glamorous cryptography; they are billions of additions and multiplications over small fields.

The catch is that a small field is not automatically sound enough for Fiat-Shamir challenges. We will return to this when we discuss extension fields. For now, the base field is the arithmetic workhorse: fast, exact, and highly packable.

## 4. Two-adic domains: FFTs are group theory in disguise

A univariate STARK wants domains whose size is a power of two. That is not because powers of two are aesthetically pleasing. It is because FFT-style algorithms repeatedly split a domain in half.

The nonzero elements of a prime field form a multiplicative group:

$$
\mathbb{F}_p^*.
$$

This group has size $p-1$. A subgroup of size $2^k$ exists only if:

$$
2^k \mid (p-1).
$$

So STARK-friendly primes are often chosen to satisfy:

$$
p = c \cdot 2^k + 1.
$$

The largest such $k$ is the field's two-adicity. If $\omega$ is a primitive $2^k$-th root of unity, then:

$$
\omega^{2^k} = 1,
$$

and the subgroup

$$
H = \{1, \omega, \omega^2, \ldots, \omega^{2^k-1}\}
$$

is exactly the kind of evaluation domain FFTs want.

This is the algebraic basis of Plonky3's two-adic DFT layer. The code's `TwoAdicSubgroupDft` trait is not an arbitrary numerical interface. It is an interface for moving between coefficient form and evaluation form over these structured subgroups and their cosets.

For a polynomial

$$
f(X)=c_0+c_1X+\cdots+c_{n-1}X^{n-1},
$$

the DFT evaluates:

$$
(f(1), f(\omega), f(\omega^2), \ldots, f(\omega^{n-1})).
$$

A coset DFT evaluates on:

$$
sH = \{s, s\omega, s\omega^2, \ldots, s\omega^{n-1}\}.
$$

The identity behind coset evaluation is simple:

$$
f(s\omega^i)=\sum_j c_j s^j (\omega^i)^j.
$$

So a coset DFT can be implemented by scaling coefficients by powers of $s$ and then running an ordinary DFT. The Plonky3 DFT trait reflects this directly.

The low-degree extension, or LDE, is another version of the same operation:

```text
evaluations on small domain
    -> inverse DFT
coefficients
    -> zero-pad
coefficients for larger domain
    -> DFT or coset DFT
extended evaluations
```

Mathematically, this is Reed-Solomon encoding. Engineering-wise, it is one of the biggest costs in a FRI-based prover.

The first major Plonky3 lesson is that "domain" is not a passive data type. It is a performance contract.

## 5. Vanishing polynomials: many row checks become one divisibility claim

Let $H$ be the trace domain. The vanishing polynomial of $H$ is:

$$
Z_H(X)=\prod_{a\in H}(X-a).
$$

If $H$ is the subgroup of $N$-th roots of unity, then:

$$
Z_H(X)=X^N-1.
$$

If $H$ is a coset $s\langle \omega \rangle$, then:

$$
Z_H(X)=X^N-s^N.
$$

This tiny formula is one of the miracles of STARKs. The polynomial has $N$ roots, but it can be evaluated with a fast exponentiation and one subtraction.

Now suppose all AIR constraints are combined into one folded constraint polynomial $C_\alpha(X)$. If the trace is valid, then every point in $H$ is a root:

$$
C_\alpha(a)=0 \qquad \forall a\in H.
$$

Therefore:

$$
Z_H(X) \mid C_\alpha(X).
$$

So there exists a quotient polynomial:

$$
Q(X)=\frac{C_\alpha(X)}{Z_H(X)}.
$$

The verifier does not check every point in $H$. Instead, it samples an out-of-domain point $\zeta$ and checks:

$$
C_\alpha(\zeta)=Z_H(\zeta)Q(\zeta).
$$

Equivalently:

$$
C_\alpha(\zeta) \cdot Z_H(\zeta)^{-1}=Q(\zeta).
$$

That is the central equation of the univariate STARK.

### 5.1 A small example over $\mathbb{F}_{17}$

Take $\mathbb{F}_{17}$ and choose $\omega=4$. Since:

$$
4^2=16=-1 \pmod {17}, \qquad 4^4=1,
$$

$\omega$ has order $4$. The domain is:

$$
H=\{1,4,16,13\}.
$$

Imagine a four-row counter trace:

```text
row | value
----+------
0   | 3
1   | 4
2   | 5
3   | 6
```

Let $T(X)$ be the unique degree-$<4$ polynomial satisfying:

$$
T(1)=3,\quad T(4)=4,\quad T(16)=5,\quad T(13)=6.
$$

The transition rule is:

$$
\text{next}=\text{current}+1.
$$

Inside the domain, "next" means $X\mapsto \omega X$, so the raw transition polynomial is:

$$
T(\omega X)-T(X)-1.
$$

This vanishes on the first three rows:

$$
T(4)-T(1)-1=4-3-1=0,
$$

$$
T(16)-T(4)-1=5-4-1=0,
$$

$$
T(13)-T(16)-1=6-5-1=0.
$$

But it does not vanish on the last row, because the domain wraps:

$$
T(\omega\cdot 13)-T(13)-1=T(1)-T(13)-1=3-6-1=-4\neq 0.
$$

The transition selector fixes this. Define the last-row Lagrange selector:

$$
L_{\text{last}}(X)=\frac{Z_H(X)}{Z_H'(13)(X-13)}.
$$

Then:

$$
L_{\text{last}}(13)=1,
$$

and it is zero at the other three domain points. The transition selector can be written as:

$$
S_{\text{transition}}(X)=1-L_{\text{last}}(X).
$$

The actual constraint is:

$$
C(X)=S_{\text{transition}}(X)(T(\omega X)-T(X)-1).
$$

Now $C$ vanishes at all four points in $H$. Therefore:

$$
X^4-1 \mid C(X).
$$

The prover can form:

$$
Q(X)=\frac{C(X)}{X^4-1}.
$$

The verifier checks the identity at a random $\zeta\notin H$:

$$
S_{\text{transition}}(\zeta)(T(\omega\zeta)-T(\zeta)-1)=(\zeta^4-1)Q(\zeta).
$$

This is the entire STARK philosophy in miniature: a row-by-row transition rule becomes a divisibility statement, and the divisibility statement becomes one random-point identity.

## 6. Constraint folding: one random linear combination instead of many checks

Real AIRs have many constraints:

$$
C_0(X), C_1(X), \ldots, C_{m-1}(X).
$$

Checking each one separately would increase proof size and verifier work. Instead, the verifier samples a challenge $\alpha$ and the prover forms:

$$
C_\alpha(X)=C_0(X)+\alpha C_1(X)+\alpha^2C_2(X)+\cdots+\alpha^{m-1}C_{m-1}(X).
$$

If all constraints vanish on $H$, then $C_\alpha$ vanishes on $H$.

If at least one constraint is nonzero at some row, a malicious prover needs the random $\alpha$ to be a root of a nonzero polynomial in $\alpha$. The probability is bounded by roughly:

$$
\frac{m}{|E|},
$$

where $E$ is the challenge field.

This is the first reason extension fields matter. If the base field has about $2^{31}$ elements, this probability may be far too large for modern soundness targets. Sampling $\alpha$ from a degree-four extension gives roughly $2^{124}$ possibilities while keeping most trace arithmetic in the fast base field.

Our reading of Plonky3's design is that this split is one of the most important performance choices in the whole library:

```text
trace arithmetic:      small, fast, SIMD-friendly base field
soundness challenges:  larger extension field
commitment matrices:   flattened back to base-field coordinates
```

That is not merely a trick. It is the implementation shape of the security argument.

## 7. Quotient chunks: degree management as an engineering problem

The quotient polynomial can have degree larger than the trace polynomials. Suppose the trace columns have degree $<N$, and the constraint has algebraic degree $d$. Very roughly:

$$
\deg C_\alpha \lesssim dN.
$$

After dividing by $Z_H$ of degree $N$:

$$
\deg Q \lesssim (d-1)N.
$$

A PCS configured for degree-$<N$ polynomials cannot simply commit to this whole $Q$ as if it were another trace column. Plonky3 splits the quotient into chunks. In the two-adic case, this can be understood through Lagrange-style decomposition over sub-cosets.

For example, if the quotient domain splits into two cosets $gH$ and $gkH$, there are selector-like polynomials $L_g$ and $L_{gk}$ such that:

$$
L_g=1 \text{ on } gH, \qquad L_g=0 \text{ on } gkH,
$$

$$
L_{gk}=0 \text{ on } gH, \qquad L_{gk}=1 \text{ on } gkH.
$$

Then a larger quotient coordinate polynomial can be decomposed as:

$$
Q_i(X)=L_g(X)q_{i,0}(X)+L_{gk}(X)q_{i,1}(X),
$$

where each $q_{i,j}$ has lower degree.

This is not a cosmetic implementation detail. It is how the algebraic quotient is made compatible with the polynomial commitment backend.

The important engineering principle is:

```text
A quotient identity gives soundness.
Chunking makes it commit-able.
Recomposition makes it verifiable.
```

We will return to recomposition when discussing barycentric interpolation.

## 8. Reed-Solomon codes: why blowup makes lies visible

FRI is a Reed-Solomon proximity test. To understand FRI, we first need the coding-theory picture.

Take a polynomial $f$ of degree $<k$ and evaluate it on a larger domain $D$ of size $n>k$:

$$
\operatorname{RS}(f)=(f(x))_{x\in D}.
$$

This vector is a Reed-Solomon codeword.

The key distance fact is elementary:

> Two distinct degree-$<k$ polynomials agree on at most $k-1$ points.

Therefore their codewords over $n$ points differ in at least:

$$
n-(k-1)
$$

positions. The relative distance is approximately:

$$
1-\frac{k}{n}.
$$

If the blowup factor is $B=n/k$, then the distance is approximately:

$$
1-\frac{1}{B}.
$$

So with blowup $B=8$, two different degree-$<k$ codewords differ on roughly $87.5\%$ of positions.

This is why low-degree extension is not wasted work. It is a lie amplifier.

If a prover changes a trace in a way that corresponds to a different low-degree polynomial, then on the larger domain the two polynomials disagree almost everywhere. A verifier that queries a few random positions has a good chance of landing on a disagreement.

In the idealized picture, if the bad word differs from every valid codeword on a fraction $\delta$ of positions, then $q$ independent random queries miss all errors with probability roughly:

$$
(1-\delta)^q.
$$

With $\delta\approx 7/8$ and $q=30$:

$$
(1/8)^{30}=2^{-90}.
$$

Real FRI soundness analysis is subtler, because the committed word may be close to some low-degree polynomial rather than exactly another codeword, and queries are correlated through folding paths. But the coding intuition remains the right mental model: blowup creates distance; distance makes random local testing meaningful.

The tradeoff is direct:

```text
larger blowup:
    more prover work and memory
    larger committed codeword
    stronger distance
    fewer queries for a target soundness

smaller blowup:
    cheaper prover work
    weaker distance
    more queries or more rounds needed
```

Plonky3 exposes this through FRI parameters such as `log_blowup`, `num_queries`, final polynomial length, arity choices, and proof-of-work bits.

## 9. FRI: degree reduction by symmetry

FRI answers a specific question:

```text
The prover committed to a large evaluation vector.
Is it close to the evaluation of a low-degree polynomial?
```

The core arity-two fold is based on even-odd decomposition.

Any polynomial can be written as:

$$
f(X)=E(X^2)+X\cdot O(X^2),
$$

where $E$ contains the even-degree coefficients and $O$ contains the odd-degree coefficients.

For example:

$$
f(X)=a+bX+cX^2+dX^3.
$$

Then:

$$
E(Y)=a+cY,
$$

$$
O(Y)=b+dY,
$$

and:

$$
f(X)=E(X^2)+X O(X^2).
$$

If $\deg f < d$, then $\deg E$ and $\deg O$ are about $d/2$.

Now suppose the domain is symmetric: if $x$ is in the domain, then $-x$ is also in the domain. We have:

$$
f(x)=E(x^2)+xO(x^2),
$$

$$
f(-x)=E(x^2)-xO(x^2).
$$

Add and subtract:

$$
E(x^2)=\frac{f(x)+f(-x)}{2},
$$

$$
O(x^2)=\frac{f(x)-f(-x)}{2x}.
$$

The verifier samples a random challenge $\beta$, and the next folded polynomial is:

$$
f_{\text{next}}(Y)=E(Y)+\beta O(Y).
$$

At $Y=x^2$:

$$
f_{\text{next}}(x^2)=\frac{f(x)+f(-x)}{2}+\beta\cdot\frac{f(x)-f(-x)}{2x}.
$$

The degree is roughly halved.

The protocol repeats:

```text
large codeword
    -> fold by beta_0
half-size codeword
    -> fold by beta_1
quarter-size codeword
    -> ...
constant-size final polynomial
```

Commitments bind each layer. Later queries check that the layers are consistent along randomly selected folding paths.

### 9.1 Why mixed-height Merkle commitments matter

FRI naturally creates vectors of shrinking height:

```text
N, N/2, N/4, ..., final_len
```

A naive implementation could commit each layer with a separate Merkle tree and separate opening paths. That works, but it wastes proof bytes.

Plonky3's mixed matrix commitment abstraction lets different-height matrices share a commitment structure. The global query index is mapped into the appropriate row of each smaller matrix. This is exactly the kind of engineering detail that does not appear in the clean algebra, but matters in a real prover.

The mathematical fold is elegant. The proof object is still a pile of hashes, rows, indices, and openings. Plonky3's MMCS layer is where those two realities meet.

## 10. Extension fields: security without giving up fast trace arithmetic

A small base field is fast. But a small challenge space is dangerous.

The Schwartz-Zippel style checks used throughout STARKs have error terms of the form:

$$
\frac{\text{degree}}{|\text{challenge space}|}.
$$

If a trace has millions of rows and the challenge field has only about $2^{31}$ elements, the margin is not acceptable. We want challenge spaces closer to 128-bit security.

The standard solution is an extension field.

Let $F$ be the base field. Choose an irreducible polynomial $\phi(U)$ of degree $d$ over $F$, and define:

$$
E=F[U]/(\phi(U)).
$$

A common efficient case is a binomial extension:

$$
\phi(U)=U^d-w,
$$

so inside $E$ we have:

$$
U^d=w.
$$

Every element of $E$ can be written uniquely as:

$$
a_0+a_1U+\cdots+a_{d-1}U^{d-1}, \qquad a_i\in F.
$$

As a set and as an $F$-vector space:

$$
E\cong F^d.
$$

So if $|F|\approx 2^{31}$ and $d=4$, then:

$$
|E|\approx 2^{124}.
$$

This is why Plonky3 can keep witness and trace operations in a fast base field while sampling $\alpha$ and $\zeta$ from a much larger challenge field.

### 10.1 `flatten_to_base` is linear algebra, not serialization glue

The quotient values live in the challenge extension field because $\alpha$ lives there. But many commitment schemes commit matrices over the base field.

Because $E$ is an $F$-vector space, an extension element:

$$
a_0+a_1U+a_2U^2+a_3U^3
$$

can be represented as four base-field coordinates:

$$
(a_0,a_1,a_2,a_3).
$$

If a quotient matrix has height $N$ and width $1$ over $E$, then flattening turns it into height $N$ and width $4$ over $F$.

This is valid because the evaluation points are in the base field. If:

$$
Q(X)=Q_0(X)+Q_1(X)U+Q_2(X)U^2+Q_3(X)U^3,
$$

and $x\in F$, then:

$$
Q(x)=Q_0(x)+Q_1(x)U+Q_2(x)U^2+Q_3(x)U^3.
$$

So committing to the four coordinate polynomials commits to the extension-valued polynomial.

This is one of the cleanest examples of Plonky3's philosophy: use the right algebraic abstraction, then let data layout follow from it.

## 11. Barycentric interpolation: verifier-side recomposition without rebuilding polynomials

The verifier often receives evaluations of quotient chunks and needs to reconstruct the value of the full quotient at $\zeta$.

Naively, interpolation is expensive. Given points $(x_i,y_i)$, the Lagrange formula is:

$$
P(X)=\sum_i y_i \prod_{j\ne i}\frac{X-x_j}{x_i-x_j}.
$$

Evaluating this directly costs too much if repeated or if many points are involved.

The barycentric form starts with the vanishing polynomial of the interpolation set:

$$
Z(X)=\prod_i (X-x_i).
$$

Then:

$$
\prod_{j\ne i}(X-x_j)=\frac{Z(X)}{X-x_i}.
$$

Define the barycentric weight:

$$
w_i=\frac{1}{\prod_{j\ne i}(x_i-x_j)}=\frac{1}{Z'(x_i)}.
$$

Then:

$$
P(X)=Z(X)\sum_i \frac{w_i y_i}{X-x_i}.
$$

For structured domains such as roots of unity or cosets, $Z(X)$ and the weights have special forms. This is why vanishing polynomials show up again in quotient recomposition. They are not merely for proving constraints vanish; they are also the right basis for stitching polynomial pieces together.

In Plonky3 terms, quotient chunk recomposition is the verifier-side inverse of the prover-side chunking. The prover splits a high-degree quotient into lower-degree pieces to commit efficiently. The verifier uses vanishing polynomials of the chunk domains to recover:

$$
Q(\zeta)
$$

from the opened chunk values.

The insight is that the verifier never reconstructs $Q(X)$ globally. It only reconstructs the one value needed for the out-of-domain equation.

```text
Do not rebuild the object.
Evaluate the identity at the point where the protocol lives.
```

That line captures much of STARK engineering.

## 12. LogUp: lookups by logarithmic derivative

AIR constraints are excellent for arithmetic recurrences. They are painful for operations that are naturally table-driven:

```text
range checks
byte decomposition
bitwise operations
memory consistency
opcode tables
cross-chip communication
```

A lookup argument lets the prover claim that a multiset of requested values is contained in, or equal to, a table multiset.

The old grand-product intuition is:

$$
\prod_j (X-w_j)=\prod_i (X-t_i)^{m_i},
$$

where $w_j$ are witness lookups, $t_i$ are table entries, and $m_i$ are multiplicities.

LogUp applies the logarithmic derivative:

$$
\frac{P'(X)}{P(X)}.
$$

If:

$$
P(X)=\prod_j (X-w_j),
$$

then:

$$
\frac{P'(X)}{P(X)}=\sum_j \frac{1}{X-w_j}.
$$

With multiplicities:

$$
\frac{d}{dX}\log\left(\prod_i (X-t_i)^{m_i}\right)
=\sum_i \frac{m_i}{X-t_i}.
$$

So multiset equality can be checked by the rational identity:

$$
\sum_j \frac{1}{X-w_j}=\sum_i \frac{m_i}{X-t_i}.
$$

The verifier samples a random $\alpha$, and the prover enforces:

$$
\sum_j \frac{1}{\alpha-w_j}=\sum_i \frac{m_i}{\alpha-t_i}.
$$

For tuple lookups, values are compressed with another challenge, say $\theta$:

$$
\operatorname{comb}(a_0,a_1,\ldots,a_{r-1})=a_0+\theta a_1+\cdots+\theta^{r-1}a_{r-1}.
$$

Then the denominator becomes:

$$
\alpha-\operatorname{comb}(\text{tuple}).
$$

The engineering win is that rational sums can be accumulated row by row. A running-sum column $s$ can satisfy constraints of the form:

$$
s_{i+1}=s_i+\text{send}_i-\text{receive}_i.
$$

The exact local expression may be cleared of denominators or optimized through batch inversion, but the conceptual object is additive.

That additive structure is the key to cross-AIR lookups. A CPU AIR can "send" a memory operation. A memory AIR can "receive" the same operation. A global bus only needs the total sum to cancel.

Our judgment is that LogUp is not just a lookup optimization. It is a modularity primitive. It lets a zkVM be built from many AIRs that communicate by algebraic accounting rather than by being fused into one giant constraint system.

## 13. Sumcheck: the multilinear turn

Classic STARKs are univariate. A trace of length $2^\ell$ becomes a degree-$<2^\ell$ polynomial in one variable.

Sumcheck starts from a different representation. A table of $2^\ell$ values can be viewed as a function on the Boolean hypercube:

$$
f:\{0,1\}^\ell\to F.
$$

There is a unique multilinear extension $\tilde f:F^\ell\to F$ that agrees with $f$ on the Boolean cube and has degree at most one in each variable.

A useful formula is:

$$
\tilde f(r)=\sum_{b\in\{0,1\}^\ell} f(b)\cdot \operatorname{eq}(r,b),
$$

where:

$$
\operatorname{eq}(r,b)=\prod_{i=1}^\ell \big(b_i r_i+(1-b_i)(1-r_i)\big).
$$

The polynomial is high-dimensional but low-degree in each coordinate.

The sumcheck protocol verifies claims of the form:

$$
S=\sum_{b\in\{0,1\}^\ell} g(b).
$$

Round 1: the prover sends the univariate polynomial

$$
g_1(X_1)=\sum_{b_2,\ldots,b_\ell\in\{0,1\}} g(X_1,b_2,\ldots,b_\ell).
$$

The verifier checks:

$$
g_1(0)+g_1(1)=S.
$$

Then it samples $r_1$ and sets the next target to:

$$
g_1(r_1).
$$

Round 2: the prover sends:

$$
g_2(X_2)=\sum_{b_3,\ldots,b_\ell} g(r_1,X_2,b_3,\ldots,b_\ell).
$$

The verifier checks:

$$
g_2(0)+g_2(1)=g_1(r_1).
$$

Then it samples $r_2$.

After $\ell$ rounds, the verifier has reduced a $2^\ell$-term sum to one claimed evaluation:

$$
g(r_1,r_2,\ldots,r_\ell).
$$

That final evaluation must be opened through a polynomial commitment scheme.

This is why Plonky3's WHIR direction matters. WHIR is not simply "another FRI." It points toward a world where multilinear polynomial commitments and sumcheck-style reductions are first-class.

The engineering tradeoff is nuanced:

```text
univariate STARK / FRI:
    mature
    FFT-heavy
    simple domain story when two-adicity is good
    excellent batching through codeword commitments

multilinear / sumcheck-heavy systems:
    avoid large FFTs in some places
    interact naturally with hypercube computations
    need efficient multilinear PCS machinery
    move complexity into commitment openings and transcript structure
```

The important mental shift is that "low degree" can mean two different things:

```text
univariate: one variable, high maximum degree
multilinear: many variables, degree one in each variable
```

Both are polynomial encodings of computation. They optimize different bottlenecks.

## 14. Circle STARKs: when the domain moves from a line to a circle

Traditional FFT-friendly STARKs want $2^k\mid p-1$. Mersenne31 is the prime:

$$
p=2^{31}-1.
$$

It is extremely attractive for machine arithmetic. But:

$$
p-1=2^{31}-2=2(2^{30}-1),
$$

so its multiplicative group has only one factor of two. Traditional two-adic FFTs do not get a large power-of-two subgroup.

Circle STARKs take a different domain:

$$
\mathcal{C}(F)=\{(x,y)\in F^2 : x^2+y^2=1\}.
$$

For primes $p\equiv 3\pmod 4$, this circle has $p+1$ points. For Mersenne31:

$$
p+1=2^{31}.
$$

So the missing two-adicity reappears on the circle.

The group law is the finite-field analogue of complex multiplication:

$$
(x_1,y_1)\otimes(x_2,y_2)=
(x_1x_2-y_1y_2,\; x_1y_2+x_2y_1).
$$

This operation preserves the circle equation:

$$
(x^2+y^2=1).
$$

The conjugate point is:

$$
(x,y)\mapsto(x,-y).
$$

Circle folding uses this twin structure. A function on the circle can be decomposed in a way analogous to even-odd decomposition. Since $y^2=1-x^2$, functions on the circle can often be represented in a form like:

$$
f(x,y)=g(x)+y h(x).
$$

Then:

$$
f(x,y)=g(x)+y h(x),
$$

$$
f(x,-y)=g(x)-y h(x).
$$

So:

$$
g(x)=\frac{f(x,y)+f(x,-y)}{2},
$$

$$
h(x)=\frac{f(x,y)-f(x,-y)}{2y}.
$$

A random fold combines them:

$$
f_{\text{next}}=g+\beta h.
$$

This is the same song as FRI, but played on a different geometry.

Plonky3's architectural payoff is that `CircleDomain` can implement the same high-level `PolynomialSpace` interface expected by the univariate STARK machinery: size, next point, disjoint domains, selectors, vanishing polynomial evaluation, split domains, and polynomial evaluation. The upper STARK code can keep asking for domain operations without knowing that the domain is no longer a multiplicative subgroup coset.

This is an unusually good example of mathematical abstraction becoming software abstraction. The domain changed from a one-dimensional subgroup to a twin-coset on a finite-field circle, but the protocol boundary remained stable.

Our take: Circle STARKs show that FFT-friendliness is not a property of primes alone. It is a property of the algebraic space we choose to evaluate on.

## 15. The Fiat-Shamir transcript: randomness as a bound object

Interactive STARK protocols assume that the verifier sends fresh random challenges after seeing prover commitments. Non-interactive STARKs replace this with Fiat-Shamir:

```text
observe commitment data
sample challenge
observe more commitment data
sample next challenge
```

The transcript is usually implemented by a hash or sponge challenger.

A sponge has a state of width $W$, split into:

```text
rate:      exposed input/output part
capacity: hidden security buffer
```

The rate determines throughput. The capacity controls security margins against collision-style and state-recovery attacks in the sponge model.

For STARKs, the ordering is not a coding style preference. It is the protocol.

If the prover samples $\alpha$ before observing the trace commitment, then $\alpha$ is not bound to the trace. If public inputs are omitted from the transcript, then the proof may fail to bind to the claimed statement. If quotient commitments are not observed before sampling $\zeta$, then the prover may adapt the quotient to the point.

The transcript sequence is therefore part of the mathematical statement:

```text
trace commitment binds trace before alpha
alpha binds random constraint folding
quotient commitment binds Q before zeta
zeta binds out-of-domain identity check
FRI commitments bind folding layers before query randomness
```

The slogan is accurate:

```text
If it is not in the transcript, it did not happen.
```

## 16. Putting the proof pipeline together

A compact Plonky3-style univariate STARK pipeline is:

```text
1. Generate a trace matrix over a fast base field F.
2. Interpret each column as evaluations of a polynomial over H.
3. Commit to the trace through a PCS.
4. Observe commitments and public values into the transcript.
5. Sample alpha in an extension field E.
6. Fold all AIR constraints into C_alpha.
7. Evaluate Q = C_alpha / Z_H on a quotient domain.
8. Flatten extension-field quotient values into base-field coordinate columns.
9. Commit to quotient chunks.
10. Observe the quotient commitment.
11. Sample zeta in E.
12. Open trace, next trace, quotient chunks, and auxiliary data at zeta.
13. Recompose Q(zeta) from quotient chunks.
14. Re-evaluate AIR constraints at zeta.
15. Check C_alpha(zeta) = Z_H(zeta) Q(zeta).
16. Use PCS and FRI to make all openings and low-degree claims believable.
```

Every step is there for a reason:

```text
AIR constraints:
    encode computation

vanishing polynomial:
    turns many row checks into divisibility

quotient polynomial:
    makes divisibility checkable at one point

extension challenges:
    make random folding and OOD checks sound

Reed-Solomon blowup:
    creates distance

FRI:
    proves low-degree proximity

Merkle/MMCS:
    binds large codewords while opening few rows

barycentric recomposition:
    lets the verifier evaluate chunked objects without rebuilding them

LogUp:
    turns table and bus consistency into linear accumulators

sumcheck/WHIR:
    opens the multilinear route beyond classic FFT-heavy STARKs

Circle domains:
    recover power-of-two structure for primes like Mersenne31

Fiat-Shamir sponge:
    turns interaction into a bound transcript
```

This is the mental model that makes Plonky3 readable.

## 17. Engineering lessons from the algebra

### 17.1 Algebraic symmetry is a performance feature

Two-adic roots of unity, cosets, circle twin-cosets, and Boolean hypercubes are all symmetry structures. The prover is fast when the domain has symmetries that algorithms can exploit.

FFT uses multiplicative subgroup symmetry. FRI uses the pair symmetry $x\leftrightarrow -x$. Circle STARKs use conjugate points $(x,y)\leftrightarrow(x,-y)$. Sumcheck uses the coordinate structure of the hypercube.

A good proving system is partly a machine for finding and exploiting symmetry.

### 17.2 A field choice is a hardware choice

BabyBear, KoalaBear, Mersenne31, and Goldilocks are not just mathematical universes. They are choices about registers, SIMD packing, modular reduction, memory bandwidth, and hash cost.

The extension field then repairs the security margin that a small base field would otherwise lose.

The principle is:

```text
Use the smallest field that is safe for the hot path.
Use extensions where unpredictability matters.
```

### 17.3 The verifier lives at points, not polynomials

The verifier rarely reconstructs full polynomials. It evaluates identities at random points.

This explains the emphasis on:

```text
zeta
zeta_next
vanishing_poly_at_point
selectors_at_point
recompose_quotient_from_chunks
```

The verifier's world is pointwise. The prover's world is vectorized.

### 17.4 Lookups are modularity, not just optimization

A lookup argument can reduce constraint count, but the deeper gain is architectural. Cross-AIR lookup buses let a zkVM be decomposed into independently meaningful tables.

That decomposition is hard to overstate. Without it, every VM component wants to become part of one monolithic AIR. With it, CPU, memory, range checks, byte tables, and hash units can communicate through algebraic accounting.

### 17.5 Plonky3's traits are mathematical seams

It is tempting to see `Pcs`, `PolynomialSpace`, `TwoAdicSubgroupDft`, `Mmcs`, `AirBuilder`, and `FieldChallenger` as Rust complexity. They are, but they are also the boundaries between mathematical concepts.

The code is most readable when each trait is read as a theorem-shaped interface:

```text
PolynomialSpace:
    I know how this domain vanishes, advances, splits, and evaluates.

Pcs:
    I can bind polynomials and later open them at challenge points.

Mmcs:
    I can commit matrices and open rows, possibly across mixed heights.

AirBuilder:
    I can interpret AIR assertions in the current phase.

FieldChallenger:
    I can bind transcript data and sample base or extension challenges.
```

Once those seams are visible, the generics become a map rather than noise.

## 18. A final synthesis

The beauty of Plonky3 is not that it hides STARK mathematics. It does the opposite. It keeps the mathematical joints visible enough that the system can evolve.

Two-adic FRI is one domain story. Circle STARKs are another. WHIR and multilinear commitments point toward yet another. LogUp adds a lookup and bus story on top of local AIR constraints. Extension fields separate fast arithmetic from soundness challenges. Barycentric recomposition and quotient chunking make high-degree algebra compatible with practical PCS backends.

The central theme is this:

```text
ZK proof engineering is applied algebra under memory pressure.
```

The formulas are elegant, but the implementation is where the elegance earns its keep. Every nice identity eventually has to answer a brutal question:

```text
Can we commit it?
Can we open it?
Can we batch it?
Can we pack it?
Can we keep the verifier tiny?
Can we bind it to the transcript before the prover learns the next challenge?
```

Plonky3 is compelling because it treats those questions as first-class. It is not merely a STARK prover. It is a toolkit for turning algebraic structure into proof-system machinery.

And after reading the source through that lens, one conclusion becomes hard to avoid: the math is not decoration around the engineering. The math is the engineering.


## 19. A formula-to-source dictionary

It is useful to keep a translation table while reading the code. The following is not a complete API map, but it captures the mathematical role of the major pieces.

| Mathematical object | What it means | Plonky3-shaped implementation idea |
|---|---|---|
| Base field $F$ | Fast exact arithmetic for trace values | `Val`, concrete fields such as BabyBear, KoalaBear, Mersenne31, Goldilocks |
| Extension field $E/F$ | Larger challenge space for soundness | `Challenge`, `BinomialExtensionField`, `BasedVectorSpace` |
| Trace matrix | Execution table | `RowMajorMatrix<Val<SC>>` |
| Trace column polynomial $T_i(X)$ | Interpolation of one trace column over the domain | PCS views columns as polynomial evaluations |
| Domain $H$ | Row coordinates | `PolynomialSpace`, two-adic cosets, circle domains |
| Next row | Domain successor | `trace_domain.next_point(zeta)` and row-pair access in prover evaluation |
| Selectors | Boundary and transition filters | `is_first_row`, `is_last_row`, `is_transition` |
| Folded constraint $C_\alpha$ | Random linear combination of AIR constraints | `alpha`, `ProverConstraintFolder`, `VerifierConstraintFolder` |
| Vanishing polynomial $Z_H$ | Polynomial that is zero exactly on the trace domain | `vanishing_poly_at_point`, `selectors_at_point`, `inv_vanishing` |
| Quotient $Q=C_\alpha/Z_H$ | Divisibility witness | `quotient_values`, `commit_quotient` |
| Reed-Solomon codeword | Low-degree extension evaluations | `lde_batch`, `coset_lde_batch`, PCS commit path |
| Low-degree test | Proximity to an RS code | FRI or WHIR-style PCS layer |
| Matrix commitment | Bind rows of codewords | `Mmcs`, `MerkleTreeMmcs` |
| Transcript | Fiat-Shamir state | `FieldChallenger`, `DuplexChallenger`, byte challengers |
| Lookup bus | Algebraic accounting between tables | `lookup` interactions, LogUp running sums |

The table also explains why the repository can feel intimidating at first. Each trait is small only after we know which theorem it is trying to preserve.

## 20. FRI query verification in more detail

The FRI fold is clean on paper:

$$
f_{i+1}(x^2)=\frac{f_i(x)+f_i(-x)}{2}+\beta_i\frac{f_i(x)-f_i(-x)}{2x}.
$$

But the verifier does not see the whole layer. It sees Merkle openings.

For one query path, the verifier asks for:

```text
layer i:
    f_i(x)
    f_i(-x)

layer i+1:
    f_{i+1}(x^2)
```

Then it recomputes the right-hand side and checks equality with the next-layer opening.

This check does two jobs at once.

First, it checks that the prover folded consistently. The value in the next layer must be the value implied by the two sibling values in the previous layer and the transcript challenge $\beta_i$.

Second, it forces a malicious prover to make all layers mutually compatible. The prover cannot freely choose a convenient high-degree object at layer $i$ and then a separate convenient low-degree object at layer $i+1$, because random query paths tie the layers together.

The final layer is small enough that the prover sends it directly or commits to a short polynomial. The verifier checks that the final object has the claimed degree. The repeated consistency checks then propagate that low-degree claim back toward the initial codeword.

This is also where proof-size engineering appears. A proof contains:

```text
opened rows
Merkle authentication paths
folding challenges from the transcript
final polynomial data
query indices
possibly proof-of-work witnesses
```

Changing arity, cap height, final polynomial length, and number of queries changes the proof-size and prover-time profile. The algebra gives the reduction. The parameter layer decides where to spend bytes and cycles.

## 21. Lookup soundness: the small denominators that matter

The LogUp formula is often presented as:

$$
\sum_j \frac{1}{\alpha-w_j}=\sum_i \frac{m_i}{\alpha-t_i}.
$$

There are three details worth keeping in mind.

### 21.1 Tuple compression must be random

A tuple lookup such as:

$$
(a,b,c) \in T
$$

is usually compressed to one field element:

$$
a+\theta b+\theta^2 c.
$$

If $\theta$ were fixed badly, different tuples could collide. With random $\theta$, a collision between two different tuples becomes a low-degree equation in $\theta$. The collision probability is bounded by degree over field size.

This is the same pattern as random constraint folding. A random challenge turns structured cheating into the need to hit a root of a nonzero polynomial.

### 21.2 The denominator challenge should be large

The denominator uses $\alpha-\operatorname{comb}(\cdot)$. A small challenge field creates two problems:

1. The chance of accidental zero denominators is larger.
2. The chance of a malicious rational identity passing at one random point is larger.

Using an extension challenge field is therefore natural for lookups as well as quotient checks.

### 21.3 Running sums are local constraints

A global multiset statement looks nonlocal. The running-sum trick makes it local:

$$
s_{i+1}-s_i=\Delta_i.
$$

The final condition says:

$$
s_N=s_0.
$$

This is a powerful pattern in AIR design. Whenever a protocol can turn a global invariant into a telescoping sum, it becomes STARK-friendly.

Our practical takeaway is that many ZK constructions succeed because they find the right accumulator. Grand products, logarithmic-derivative sums, permutation products, memory buses, and range-check tables are all variants of the same engineering instinct: encode a global consistency condition as a local recurrence plus a boundary check.

## 22. A compact soundness ledger

This section is not a formal proof. It is a ledger of where the main error terms come from.

### 22.1 Constraint folding

If at least one of $m$ constraints is nonzero, the folded constraint can accidentally vanish for at most about $m$ bad values of $\alpha$:

$$
\Pr[\text{bad fold}] \lesssim \frac{m}{|E|}.
$$

### 22.2 Out-of-domain quotient check

If:

$$
C_\alpha(X) \ne Z_H(X)Q(X),
$$

then the difference polynomial:

$$
D(X)=C_\alpha(X)-Z_H(X)Q(X)
$$

is nonzero. A random $\zeta$ catches it except with probability bounded by:

$$
\Pr[D(\zeta)=0]\le \frac{\deg D}{|E|}.
$$

### 22.3 Reed-Solomon distance

With blowup $B$, the rate is roughly $1/B$, and the relative distance between distinct degree-bounded codewords is roughly:

$$
1-\frac{1}{B}.
$$

That distance is what makes few random queries meaningful.

### 22.4 FRI proximity

FRI adds the statement:

```text
The committed evaluation vector is close to some low-degree codeword.
```

Its soundness depends on the blowup, number of queries, folding schedule, final degree, and details of the FRI analysis. The engineering knob is visible even if the full theorem is more involved: stronger proximity soundness costs more queries, more rounds, or more codeword size.

### 22.5 Lookup compression and rational identity checks

Tuple compression error is controlled by the random tuple-compression challenge. Rational identity error is controlled by the denominator challenge. Both are polynomial-root arguments in an extension field.

### 22.6 Fiat-Shamir

Fiat-Shamir soundness is modeled through the random oracle or sponge assumptions. The transcript must bind all data that precedes each challenge. Omitting a commitment or public input is not a minor bug; it changes the theorem being proven.

The common shape is clear:

$$
\text{failure probability} \approx \frac{\text{bad algebraic degree}}{\text{challenge space}} + \text{proximity error} + \text{hash/transcript assumptions}.
$$

That formula is crude, but it is a useful engineering compass.

## 23. What is worth learning deeply next

A reader with group, ring, and field basics can read a large fraction of Plonky3 after learning the following concepts well:

1. **Polynomial interpolation and vanishing polynomials.** This is the language of AIR, selectors, quotient identities, and verifier checks.
2. **Reed-Solomon codes and relative distance.** This explains why LDE and blowup exist.
3. **FRI folding.** This explains how low-degree claims become logarithmic-size proofs.
4. **Extension fields as vector spaces.** This explains challenge fields and `flatten_to_base`.
5. **Barycentric interpolation.** This explains quotient recomposition and verifier efficiency.
6. **Logarithmic-derivative lookups.** This explains table arguments and cross-AIR buses.
7. **Sumcheck and multilinear extensions.** This explains the WHIR direction and the broader move beyond FFT-heavy univariate systems.
8. **Circle groups over finite fields.** This explains how Mersenne31 can be used despite poor multiplicative two-adicity.
9. **Sponge transcripts and Fiat-Shamir discipline.** This explains why challenge order is part of the protocol, not just implementation detail.

The deeper pattern is even shorter:

```text
Learn how algebra creates cheap tests for expensive statements.
```

That is the heart of STARKs.

## References and source notes

- Plonky3 repository and README: https://github.com/Plonky3/Plonky3
- Plonky3 `uni-stark/src/prover.rs`: https://github.com/Plonky3/Plonky3/blob/main/uni-stark/src/prover.rs
- Plonky3 `dft/src/traits.rs`: https://github.com/Plonky3/Plonky3/blob/main/dft/src/traits.rs
- Plonky3 `commit/src/pcs.rs`: https://github.com/Plonky3/Plonky3/blob/main/commit/src/pcs.rs
- Plonky3 `circle/src/domain.rs`: https://github.com/Plonky3/Plonky3/blob/main/circle/src/domain.rs
- Circle STARKs, ePrint 2024/278: https://eprint.iacr.org/2024/278
- LogUp: Multivariate lookups based on logarithmic derivatives, ePrint 2022/1530: https://eprint.iacr.org/2022/1530
- WHIR: Reed-Solomon proximity testing with super-fast verification, ePrint 2024/1586: https://eprint.iacr.org/2024/1586
- Vitalik Buterin, "Exploring circle STARKs": https://vitalik.eth.limo/general/2024/07/23/circlestarks.html
- zkSecurity, "Circle STARKs": https://www.zksecurity.xyz/blog/posts/circle-starks-1/
