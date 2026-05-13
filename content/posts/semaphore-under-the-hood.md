---
title: "Semaphore Under the Hood: Roots, Nullifiers, and the Art of Not Doxxing the Leaf"
date: "2026-05-13"
slug: "semaphore-under-the-hood"
categories:
  - ZK
  - Privacy
tags:
  - semaphore
  - privacy
  - zk
---

# Semaphore Under the Hood: Roots, Nullifiers, and the Art of Not Doxxing the Leaf

*Prove the root. Hide the leaf. Burn the nullifier.*

Semaphore looks deceptively simple from the outside: prove that a user belongs to a group, let the user send a message, keep the user anonymous, and stop the same user from signaling twice in the same context.

The deeper lesson from reading the code is that Semaphore is not a single trick. It is a carefully layered protocol pipeline. Identity, Merkle membership, ZK proof generation, nullifier derivation, Solidity verification, and indexing each take one responsibility. None of the layers tries to be the whole system.

That separation is the reason Semaphore is worth studying. It is not just a useful privacy primitive. It is a clean example of how to turn a zero-knowledge idea into production-oriented protocol architecture.

This article follows the source code of [`semaphore-protocol/semaphore`](https://github.com/semaphore-protocol/semaphore) and focuses on Semaphore V4.

```text
Identity -> Commitment -> Group -> Merkle proof -> Circuit -> Groth16 proof -> Solidity verification -> Nullifier state
```

The goal is not to explain zero-knowledge from scratch. The goal is to understand how Semaphore is assembled as a real protocol, why the code is shaped the way it is, and what design choices are hidden behind the clean public API.

---

## 1. The actual problem: anonymity with accountability

A useful example is anonymous feedback.

Suppose there is a group of 100 eligible members. Each member should be able to submit feedback once. The system needs four properties:

```text
1. The sender belongs to the eligible group.
2. The sender's exact identity remains hidden.
3. The same sender cannot submit twice in the same feedback round.
4. The submitted proof can be verified by a contract or public verifier.
```

The tension is obvious. If the system identifies the sender, anonymity is gone. If the system fully hides the sender with no persistent tag, duplicate submissions become hard to stop.

Semaphore resolves that tension with a scoped nullifier.

A nullifier is not the user's identity. It is a deterministic tag derived from two values:

```text
scope + user's secret -> nullifier
```

The same user in the same scope gets the same nullifier. The same user in a different scope gets a different nullifier. Different users in the same scope get different nullifiers.

This gives Semaphore a very sharp model:

```text
Membership gives permission.
ZK hides the member.
Scope defines the context.
Nullifier enforces one signal per identity per context.
```

That is the central idea. The rest of the codebase exists to make this idea precise, efficient, and usable by applications.

---

## 2. Source map: reading Semaphore as protocol layers

Semaphore is a monorepo. The source becomes much easier to read when each package is treated as one layer of the protocol rather than as an isolated library.

| Layer | Source path | Role |
|---|---|---|
| Identity | [`packages/identity/src/index.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/identity/src/index.ts) | Creates private identity material and public commitments. |
| Group | [`packages/group/src/index.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/group/src/index.ts) | Represents membership sets as LeanIMT Merkle trees. |
| Circuit | [`packages/circuits/src/semaphore.circom`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/circuits/src/semaphore.circom) | Defines the actual zero-knowledge statement. |
| Proof generation | [`packages/proof/src/generate-proof.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/proof/src/generate-proof.ts) | Converts identity, group, message, and scope into Groth16 witness inputs. |
| Proof verification | [`packages/proof/src/verify-proof.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/proof/src/verify-proof.ts) | Verifies Semaphore proofs off-chain. |
| Proof type | [`packages/proof/src/types/index.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/proof/src/types/index.ts) | Defines the `SemaphoreProof` shape. |
| Hash helper | [`packages/proof/src/hash.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/proof/src/hash.ts) | Converts message and scope into field-compatible public signals. |
| Main contract | [`packages/contracts/contracts/Semaphore.sol`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/contracts/contracts/Semaphore.sol) | Manages groups, verifies proofs, and stores nullifiers. |
| Group contract base | [`packages/contracts/contracts/base/SemaphoreGroups.sol`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/contracts/contracts/base/SemaphoreGroups.sol) | Implements on-chain group operations with LeanIMT. |
| Contract interface | [`packages/contracts/contracts/interfaces/ISemaphore.sol`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/contracts/contracts/interfaces/ISemaphore.sol) | Defines public API, proof struct, events, and errors. |
| Verifier contract | [`packages/contracts/contracts/base/SemaphoreVerifier.sol`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/contracts/contracts/base/SemaphoreVerifier.sol) | Performs Groth16 pairing verification. |
| Data layer | [`packages/data/src/subgraph.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/data/src/subgraph.ts) | Reads groups, members, and validated proofs through The Graph. |
| Data layer | [`packages/data/src/ethers.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/data/src/ethers.ts) | Reads group state and events through ethers. |
| Subgraph schema | [`apps/subgraph/schema.graphql`](https://github.com/semaphore-protocol/semaphore/blob/main/apps/subgraph/schema.graphql) | Defines indexed entities for groups, members, trees, and proofs. |
| Example app contract | [`packages/cli-template-contracts-hardhat/contracts/Feedback.sol`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/cli-template-contracts-hardhat/contracts/Feedback.sol) | Minimal anonymous feedback contract. |

The architecture is disciplined:

```text
Identity owns secrets.
Group owns membership structure.
Circuit owns the statement.
Proof SDK owns witness construction.
Contract owns state.
Data layer owns application ergonomics.
```

Our take: this is one of Semaphore's strongest engineering qualities. Privacy protocols often become hard to reason about because too many concerns are blended together. Semaphore stays readable because each layer has a narrow job.

---

## 3. Identity: turning a private identity into a public commitment

Source path:

```text
packages/identity/src/index.ts
```

Semaphore starts with an `Identity`. At this layer, the protocol derives the private and public values that the rest of the system needs.

The constructor is compact:

```ts
constructor(privateKey?: string | Buffer | Uint8Array) {
    const eddsa = new EdDSAPoseidon(privateKey)

    this._privateKey = eddsa.privateKey
    this._secretScalar = eddsa.secretScalar
    this._publicKey = eddsa.publicKey
    this._commitment = poseidon2(this._publicKey)
}
```

The chain is:

```text
privateKey -> secretScalar -> publicKey -> identityCommitment
```

The commitment is what gets inserted into a Semaphore group. The private key and secret scalar remain private. The group does not store the user's private key, secret scalar, or raw identity. It stores a Poseidon hash of the public key.

That distinction matters.

```text
The commitment is a public membership handle.
The secret scalar is the private anchor used inside the proof.
```

Semaphore does not say, "Here is who I am." It says, "Here is a commitment derived from my identity. Later, I can prove in zero knowledge that I control the secret behind one of the commitments in the group."

The `Identity` class also exposes import, export, signing, signature verification, and commitment generation helpers:

```ts
public export(): string
static import(privateKey: string): Identity
public signMessage(message: BigNumberish): Signature<bigint>
static verifySignature(message: BigNumberish, signature: Signature, publicKey: Point): boolean
static generateCommitment(publicKey: Point): bigint
```

What stands out is restraint. The identity package does not try to solve account recovery, credential issuance, wallet login, group admission policy, or app-level authentication. It only creates the identity material that Semaphore needs.

That narrow scope is not accidental. It keeps the privacy boundary clean.

---

## 4. Group: the Merkle root as a compressed crowd

Source path:

```text
packages/group/src/index.ts
```

Once identities become commitments, the next question is how to represent a group of commitments in a proof-friendly way.

Semaphore V4 uses a Lean Incremental Merkle Tree, or `LeanIMT`. The constructor shows the core idea:

```ts
constructor(members: BigNumber[] = []) {
    this.leanIMT = new LeanIMT((a, b) => poseidon2([a, b]), members.map(BigInt))
}
```

The leaves are identity commitments. Internal nodes are Poseidon hashes. The root is a compact public representation of the whole membership set.

The class exposes the expected operations:

```ts
addMember(member)
addMembers(members)
updateMember(index, member)
removeMember(index)
generateMerkleProof(index)
export()
static import(nodes)
```

The protocol point is simple but powerful:

```text
The proof does not reveal a leaf.
The proof shows that a hidden leaf path reaches a public root.
```

The verifier does not need the full group. The verifier only needs the root. The prover privately uses the Merkle path. This is how a public membership set becomes an anonymity set.

There are two implementation details worth noticing.

First, the JS group rejects `0` as a member:

```ts
if (member === 0n || member === "0") {
    throw new Error("Failed to add member: value cannot be 0")
}
```

Removal is represented by updating the leaf to zero:

```ts
this.leanIMT.update(index, 0n)
```

So `0n` is effectively a removed-member sentinel and cannot be a valid identity commitment.

Second, batch insertion exists:

```ts
addMembers(members)
```

This is more than convenience. Anonymous systems become more useful as the anonymity set grows. Large group operations need practical ergonomics. A protocol can be mathematically correct and still painful to use if the operational path is slow or awkward.

Our take: a Semaphore group is not just a list. It is a ZK-friendly commitment to a membership set.

---

## 5. The circuit: where the protocol becomes exact

Source path:

```text
packages/circuits/src/semaphore.circom
```

The circuit is the center of gravity. The TypeScript SDK prepares inputs for it. The Solidity verifier checks proofs generated from it. The contract state records consequences of it. If one file captures the protocol statement, it is this one.

The comments in `semaphore.circom` divide the circuit into three main parts:

```text
1. Generate the Semaphore identity commitment.
2. Verify that the identity commitment is part of the Merkle tree.
3. Generate the nullifier.
```

The template is parameterized by max tree depth:

```circom
template Semaphore(MAX_DEPTH) {
```

The inputs are:

```circom
signal input secret;
signal input merkleProofLength, merkleProofIndex, merkleProofSiblings[MAX_DEPTH];
signal input message;
signal input scope;
```

The public outputs are:

```circom
signal output merkleRoot, nullifier;
```

This split is the whole game.

Private side:

```text
secret
Merkle proof index
Merkle proof siblings
```

Public side:

```text
message
scope
merkleRoot
nullifier
proof points
```

The prover keeps the identity and Merkle path hidden. The verifier sees enough public data to check the statement and enforce duplicate prevention.

### 5.1 Secret range check

The circuit first checks that the secret scalar is within the prime subgroup order:

```circom
var l = 2736030358979909402780800718157159386076813972158567259200215660948447373041;

component isLessThan = LessThan(251);
isLessThan.in <== [secret, l];
isLessThan.out === 1;
```

This is easy to overlook, but it is important. The secret is not arbitrary application data. It is a scalar used to derive a Baby Jubjub public key. The circuit constrains it accordingly.

### 5.2 Reconstructing the commitment inside the circuit

The circuit derives the public key from the secret:

```circom
var Ax, Ay;
(Ax, Ay) = BabyPbk()(secret);
```

Then it hashes the public key into the identity commitment:

```circom
var identityCommitment = Poseidon(2)([Ax, Ay]);
```

This is a crucial design point. The circuit does not trust an externally supplied commitment. It recomputes the commitment from the secret. That connects the private identity material to the public group membership claim.

The statement becomes:

```text
I know a secret.
That secret derives a public key.
That public key hashes to a commitment.
That commitment is in the group represented by this Merkle root.
```

That is the heart of Semaphore membership.

### 5.3 Proving membership with a Merkle path

The Merkle root is computed inside the circuit:

```circom
merkleRoot <== BinaryMerkleRoot(MAX_DEPTH)(
    identityCommitment,
    merkleProofLength,
    merkleProofIndex,
    merkleProofSiblings
);
```

The verifier later receives the resulting root as a public signal. If this root matches the group root accepted by the application or contract, the hidden commitment is part of that group.

What remains hidden is just as important:

```text
which leaf was used
which index was used
which sibling path was used
which member generated the proof
```

### 5.4 Nullifier: the scoped one-time tag

The nullifier is generated as:

```circom
nullifier <== Poseidon(2)([scope, secret]);
```

This line is small, but it carries a lot of the protocol's elegance.

```text
same secret + same scope -> same nullifier
same secret + different scope -> different nullifier
different secret + same scope -> different nullifier
```

That gives applications a way to reject duplicate actions without learning the user's identity.

A nullifier is not an address. It is not a public key. It is not a group index. It is a scoped burn mark.

### 5.5 Why the message is constrained

Near the end of the circuit, the message is constrained with a dummy square:

```circom
signal dummySquare <== message * message;
```

The message does not decide membership. Still, it must be bound to the proof. Otherwise, a proof could be reused or malleated against a different message.

This is one of those small details that separates a demo from a protocol. The proof should not merely say, "some member did something." It should say, "some member produced this proof bound to this message and this scope."

Our take: the circuit is not large, but it is dense. Identity ownership, membership, scoped uniqueness, and message binding all meet here.

---

## 6. Proof generation: TypeScript as the bridge into Groth16

Source path:

```text
packages/proof/src/generate-proof.ts
```

The proof SDK turns application-level objects into witness inputs for the circuit.

The public API is:

```ts
export default async function generateProof(
    identity: Identity,
    groupOrMerkleProof: Group | MerkleProof,
    message: BigNumberish | Uint8Array | string,
    scope: BigNumberish | Uint8Array | string,
    merkleTreeDepth?: number,
    snarkArtifacts?: SnarkArtifacts
): Promise<SemaphoreProof>
```

The function does several jobs:

```text
1. Validate the inputs.
2. Convert message and scope into bigint values.
3. Generate or accept a Merkle proof.
4. Infer the Merkle tree depth if not provided.
5. Fetch or use provided SNARK artifacts.
6. Call groth16.fullProve.
7. Return a packed Semaphore proof.
```

A practical detail: the second argument can be either a full group or an already generated Merkle proof.

If it receives a group, the SDK finds the user's commitment and generates the proof path:

```ts
const leafIndex = groupOrMerkleProof.indexOf(identity.commitment)
merkleProof = groupOrMerkleProof.generateMerkleProof(leafIndex)
```

Then it prepares the witness:

```ts
const { proof, publicSignals } = await groth16.fullProve(
    {
        secret: identity.secretScalar,
        merkleProofLength,
        merkleProofIndex: merkleProof.index,
        merkleProofSiblings,
        scope: hash(scope),
        message: hash(message)
    },
    wasm,
    zkey
)
```

This mirrors the circuit inputs almost one-to-one.

One interesting engineering choice is artifact handling:

```ts
snarkArtifacts ??= await maybeGetSnarkArtifacts(Project.SEMAPHORE, {
    parameters: [merkleTreeDepth],
    version: "4.13.0"
})
```

The SDK can automatically fetch the required `wasm` and `zkey` artifacts based on depth. That makes proof generation much easier for application developers, while still allowing manual artifact injection.

The returned proof shape is:

```ts
return {
    merkleTreeDepth,
    merkleTreeRoot: merkleProof.root.toString(),
    nullifier: publicSignals[1],
    message: message.toString() as NumericString,
    scope: scope.toString() as NumericString,
    points: packGroth16Proof(proof)
}
```

The corresponding type is defined in [`packages/proof/src/types/index.ts`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/proof/src/types/index.ts):

```ts
export type SemaphoreProof = {
    merkleTreeDepth: number
    merkleTreeRoot: NumericString
    message: NumericString
    nullifier: NumericString
    scope: NumericString
    points: PackedGroth16Proof
}
```

Our take: `generateProof` is the bridge between protocol math and app code. It hides the ugly parts, but it does not hide the model. If the reader understands the witness object passed into `fullProve`, the whole protocol becomes much less mysterious.

---

## 7. Hashing message and scope into field-compatible signals

Source path:

```text
packages/proof/src/hash.ts
```

The helper is short:

```ts
export default function hash(message: BigNumberish): NumericString {
    return (BigInt(keccak256(toBeHex(message, 32))) >> 8n).toString()
}
```

The same pattern appears in Solidity:

```solidity
function _hash(uint256 message) private pure returns (uint256) {
    return uint256(keccak256(abi.encodePacked(message))) >> 8;
}
```

The shift by 8 bits keeps the hash compatible with the SNARK scalar field. More importantly, the JS and Solidity sides must agree on this transformation. If the public signals differ between proof generation and verification, the proof will fail.

This is a classic ZK engineering detail. The cryptographic statement is only portable if every environment serializes and hashes public inputs exactly the same way.

---

## 8. Off-chain verification: checking the public statement

Source path:

```text
packages/proof/src/verify-proof.ts
```

Off-chain verification takes the `SemaphoreProof`, selects the verification key based on tree depth, and verifies Groth16 proof points against public signals.

The core call is:

```ts
return groth16.verify(
    verificationKey,
    [merkleTreeRoot, nullifier, hash(message), hash(scope)],
    unpackGroth16Proof(points)
)
```

The verifier sees:

```text
merkleTreeRoot
nullifier
hash(message)
hash(scope)
proof points
```

The verifier does not see:

```text
secret
identity commitment ownership path
Merkle siblings
Merkle index
which group member generated the proof
```

This is the clean boundary between public verification and private witness data.

One subtle but important point: off-chain `verifyProof` only checks proof validity. It does not remember nullifiers. It cannot prevent double signaling unless the caller maintains nullifier state somewhere else.

That is why the Solidity contract's `validateProof` matters.

---

## 9. Solidity contract: where proof becomes state

Source path:

```text
packages/contracts/contracts/Semaphore.sol
```

`Semaphore.sol` combines group management, proof verification, Merkle root freshness checks, and nullifier storage.

The contract stores group parameters:

```solidity
mapping(uint256 => Group) public groups;
uint256 public groupCounter;
```

The `Group` struct is defined in [`packages/contracts/contracts/interfaces/ISemaphore.sol`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/contracts/contracts/interfaces/ISemaphore.sol):

```solidity
struct Group {
    uint256 merkleTreeDuration;
    mapping(uint256 => uint256) merkleRootCreationDates;
    mapping(uint256 => bool) nullifiers;
}
```

This structure shows the two contract-level concerns that the circuit does not handle:

```text
1. Which Merkle roots are accepted for a group?
2. Which nullifiers have already been used?
```

### 9.1 Creating groups

The contract has several `createGroup` variants:

```solidity
function createGroup() external override returns (uint256 groupId) {
    groupId = groupCounter++;
    _createGroup(groupId, msg.sender);

    groups[groupId].merkleTreeDuration = 1 hours;
}
```

A group gets an admin and a Merkle tree duration. The default duration is one hour.

This duration is not a random parameter. It solves a real race condition: a user may generate a proof using a root that was current at proof time, but the group may change before the proof is submitted on-chain.

### 9.2 Adding and changing members

Adding a member delegates to the group base contract and records the creation time of the new root:

```solidity
function addMember(uint256 groupId, uint256 identityCommitment) external override {
    uint256 merkleTreeRoot = _addMember(groupId, identityCommitment);

    groups[groupId].merkleRootCreationDates[merkleTreeRoot] = block.timestamp;
}
```

Batch addition, updates, and removals follow the same pattern: mutate the tree, get the new root, record the root timestamp.

This is another example of clean separation. The group base contract handles tree operations. The main contract handles root validity windows and nullifier state.

### 9.3 `verifyProof`: math plus root policy

The contract-level `verifyProof` checks:

```text
1. The group exists.
2. The Merkle tree depth is supported.
3. The group is not empty.
4. The proof root is either current or recently valid.
5. The Groth16 verifier accepts the proof.
```

The old-root handling is especially practical:

```solidity
if (proof.merkleTreeRoot != currentMerkleTreeRoot) {
    uint256 merkleRootCreationDate = groups[groupId].merkleRootCreationDates[proof.merkleTreeRoot];
    uint256 merkleTreeDuration = groups[groupId].merkleTreeDuration;

    if (merkleRootCreationDate == 0) {
        revert Semaphore__MerkleTreeRootIsNotPartOfTheGroup();
    }

    if (block.timestamp > merkleRootCreationDate + merkleTreeDuration) {
        revert Semaphore__MerkleTreeRootIsExpired();
    }
}
```

This design prevents a bad user experience where a proof becomes invalid immediately after another member joins the group. At the same time, it does not accept old roots forever.

The final verifier call passes the Groth16 proof points and public signals:

```solidity
return
    verifier.verifyProof(
        [proof.points[0], proof.points[1]],
        [[proof.points[2], proof.points[3]], [proof.points[4], proof.points[5]]],
        [proof.points[6], proof.points[7]],
        [proof.merkleTreeRoot, proof.nullifier, _hash(proof.message), _hash(proof.scope)],
        proof.merkleTreeDepth
    );
```

Notice the same public signal order as the TypeScript verifier:

```text
merkleTreeRoot
nullifier
hash(message)
hash(scope)
```

### 9.4 `validateProof`: verification plus nullifier burn

`validateProof` is the stateful function:

```solidity
function validateProof(uint256 groupId, SemaphoreProof calldata proof) external override {
    if (groups[groupId].nullifiers[proof.nullifier]) {
        revert Semaphore__YouAreUsingTheSameNullifierTwice();
    }

    if (!verifyProof(groupId, proof)) {
        revert Semaphore__InvalidProof();
    }

    groups[groupId].nullifiers[proof.nullifier] = true;

    emit ProofValidated(
        groupId,
        proof.merkleTreeDepth,
        proof.merkleTreeRoot,
        proof.nullifier,
        proof.message,
        proof.scope,
        proof.points
    );
}
```

This function is the bridge from stateless proof validity to stateful application rules.

```text
verifyProof = check the math and root policy.
validateProof = check the math, then burn the nullifier.
```

Our take: the circuit proves membership and derives the nullifier. The contract gives the nullifier meaning by storing it and rejecting reuse. Without state, a nullifier is just a number. With state, it becomes a one-time signal right.

---

## 10. On-chain group operations: keeping membership mutable

Source path:

```text
packages/contracts/contracts/base/SemaphoreGroups.sol
```

The group base contract stores LeanIMT data and admin state:

```solidity
mapping(uint256 => LeanIMTData) internal merkleTrees;
mapping(uint256 => address) internal admins;
mapping(uint256 => address) internal pendingAdmins;
```

It implements:

```solidity
_createGroup
_updateGroupAdmin
_acceptGroupAdmin
_addMember
_addMembers
_updateMember
_removeMember
getGroupAdmin
hasMember
indexOf
getMerkleTreeRoot
getMerkleTreeDepth
getMerkleTreeSize
```

Adding a member is straightforward:

```solidity
function _addMember(
    uint256 groupId,
    uint256 identityCommitment
) internal virtual onlyGroupAdmin(groupId) returns (uint256 merkleTreeRoot) {
    uint256 index = getMerkleTreeSize(groupId);
    merkleTreeRoot = merkleTrees[groupId]._insert(identityCommitment);

    emit MemberAdded(groupId, index, identityCommitment, merkleTreeRoot);
}
```

Updating and removing require proof siblings because the tree operation needs to prove and recompute the path:

```solidity
function _removeMember(
    uint256 groupId,
    uint256 identityCommitment,
    uint256[] calldata merkleProofSiblings
) internal virtual onlyGroupAdmin(groupId) returns (uint256 merkleTreeRoot) {
    uint256 index = merkleTrees[groupId]._indexOf(identityCommitment);

    merkleTreeRoot = merkleTrees[groupId]._remove(identityCommitment, merkleProofSiblings);

    emit MemberRemoved(groupId, index, identityCommitment, merkleTreeRoot);
}
```

This layer also makes a larger architectural point:

```text
Semaphore does not decide who deserves to join a group.
Semaphore provides the machinery after a commitment is admitted.
```

Eligibility, credential checks, DAO membership, allowlists, KYC decisions, and application-specific policy are outside the core protocol. The group admin decides which commitments enter the tree.

This is a good design boundary. Semaphore is a privacy layer, not a universal identity or reputation system.

---

## 11. Groth16 verifier: the heavy cryptography is isolated

Source path:

```text
packages/contracts/contracts/base/SemaphoreVerifier.sol
```

The verifier contract is partly generated with `snarkjs`. It handles the pairing checks needed for Groth16 verification.

The public function is:

```solidity
function verifyProof(
    uint[2] calldata _pA,
    uint[2][2] calldata _pB,
    uint[2] calldata _pC,
    uint[4] calldata _pubSignals,
    uint merkleTreeDepth
) external view returns (bool)
```

It loads verification key points based on Merkle tree depth:

```solidity
uint[14] memory _vkPoints = SemaphoreVerifierKeyPts.getPts(merkleTreeDepth);
```

Then it performs field checks, computes the linear combination for public signals, and calls the EVM pairing precompile.

From a protocol reading perspective, the exact assembly is less important than the boundary:

```text
Semaphore.sol decides what public signals mean.
SemaphoreVerifier.sol checks whether the Groth16 proof is valid for those signals.
```

That separation keeps business logic away from generated verifier logic.

---

## 12. Data and subgraph: making protocol state usable

Proof generation needs group data. Applications need to show groups, members, and validated proofs. Reading that directly from raw chain history can be painful, so Semaphore provides a data layer.

### 12.1 Subgraph client

Source path:

```text
packages/data/src/subgraph.ts
```

`SemaphoreSubgraph` queries The Graph for group data:

```ts
async getGroupIds(): Promise<string[]>
async getGroups(options: GroupOptions = {}): Promise<GroupResponse[]>
async getGroup(groupId: string, options: Omit<GroupOptions, "filters"> = {}): Promise<GroupResponse>
async getGroupMembers(groupId: string): Promise<string[]>
async getGroupValidatedProofs(groupId: string): Promise<any[]>
async isGroupMember(groupId: string, member: string): Promise<boolean>
```

The subgraph schema is defined in [`apps/subgraph/schema.graphql`](https://github.com/semaphore-protocol/semaphore/blob/main/apps/subgraph/schema.graphql):

```graphql
type MerkleTree @entity {
    id: ID!
    depth: Int!
    root: BigInt
    size: Int!
    group: Group!
}

type Group @entity {
    id: ID!
    timestamp: BigInt!
    merkleTree: MerkleTree!
    admin: Bytes
    members: [Member!] @derivedFrom(field: "group")
    validatedProofs: [ValidatedProof!] @derivedFrom(field: "group")
}

type Member @entity {
    id: ID!
    timestamp: BigInt!
    identityCommitment: BigInt!
    index: Int!
    group: Group!
}

type ValidatedProof @entity {
    id: ID!
    timestamp: BigInt!
    message: BigInt!
    scope: BigInt!
    merkleTreeRoot: BigInt!
    merkleTreeDepth: Int!
    nullifier: BigInt!
    points: [BigInt!]!
    group: Group!
}
```

This is the application-facing read model.

### 12.2 Ethers client

Source path:

```text
packages/data/src/ethers.ts
```

`SemaphoreEthers` reads directly from the deployed contract and events. It can fetch group IDs, group metadata, members, validated proofs, and membership status.

One interesting part is member reconstruction. Since members can be added, updated, and removed over time, `getGroupMembers` rebuilds the current membership list from events such as:

```text
MemberAdded
MembersAdded
MemberUpdated
MemberRemoved
```

This is less elegant than a subgraph query, but it gives applications a fallback path when subgraph infrastructure is not available.

Our take: the data layer is not cryptographically central, but it is product-critical. A protocol can be correct and still hard to build with. Semaphore's data clients reduce that friction.

---

## 13. Minimal application shape: anonymous feedback

Source path:

```text
packages/cli-template-contracts-hardhat/contracts/Feedback.sol
```

The template contract is small, which makes it useful for understanding the full app flow:

```solidity
contract Feedback {
    ISemaphore public semaphore;

    uint256 public groupId;

    constructor(address semaphoreAddress) {
        semaphore = ISemaphore(semaphoreAddress);

        groupId = semaphore.createGroup();
    }

    function joinGroup(uint256 identityCommitment) external {
        semaphore.addMember(groupId, identityCommitment);
    }

    function sendFeedback(
        uint256 merkleTreeDepth,
        uint256 merkleTreeRoot,
        uint256 nullifier,
        uint256 feedback,
        uint256[8] calldata points
    ) external {
        ISemaphore.SemaphoreProof memory proof = ISemaphore.SemaphoreProof(
            merkleTreeDepth,
            merkleTreeRoot,
            nullifier,
            feedback,
            groupId,
            points
        );

        semaphore.validateProof(groupId, proof);
    }
}
```

This shows the application flow clearly:

```text
1. Deploy app with a Semaphore contract address.
2. App creates a group.
3. Users join by submitting identity commitments.
4. Users generate proofs off-chain.
5. Users submit proofs to the app.
6. App calls semaphore.validateProof.
7. Semaphore verifies proof and burns nullifier.
```

Notice that `groupId` is used as the `scope` in `sendFeedback`. That means each identity can submit once for this feedback group.

In a more complex app, `scope` could be an election ID, poll ID, proposal ID, campaign ID, epoch ID, or any application-defined context.

The key is that scope is not just metadata. It is part of nullifier derivation.

---

## 14. The full end-to-end pipeline

Putting everything together:

```text
User side:
  new Identity()
  -> identity.commitment

Group admission:
  semaphore.addMember(groupId, identityCommitment)
  -> commitment becomes a Merkle leaf
  -> contract records new root timestamp

Data loading:
  app fetches group members/root through subgraph or ethers
  -> reconstructs Group / Merkle proof inputs

Proof generation:
  generateProof(identity, group, message, scope)
  -> computes witness
  -> runs Groth16
  -> returns SemaphoreProof

Verification:
  contract.verifyProof(groupId, proof)
  -> checks root policy
  -> checks Groth16 proof

Validation:
  contract.validateProof(groupId, proof)
  -> rejects used nullifier
  -> verifies proof
  -> stores nullifier
  -> emits ProofValidated
```

A compact mental model:

```text
Circuit proves membership.
Contract enforces uniqueness.
Data layer makes membership state usable.
Application defines eligibility and scope.
```

That is the architecture in one sentence.

---

## 15. Design choices that feel especially strong

### 15.1 The protocol does not hide everything

Semaphore is precise about what stays public and what stays private.

Public:

```text
Merkle root
message
scope
nullifier
proof points
```

Private:

```text
identity private key
secret scalar
which commitment belongs to the user
which Merkle path was used
```

This is the right tradeoff. A useful system needs public verifiability. The privacy goal is not to erase all public data. It is to reveal the minimum data needed for verification and state transitions.

### 15.2 The nullifier is scoped

Global uniqueness would be too restrictive. A user should be able to vote in multiple polls or participate in multiple rounds.

Scoped uniqueness gives applications flexibility:

```text
scope = election ID
scope = proposal ID
scope = feedback round ID
scope = group ID
scope = epoch
```

This is why `scope` is a first-class protocol input, not an afterthought.

### 15.3 The circuit and contract split responsibilities well

The circuit proves facts about private witness data. The contract manages public state.

The circuit should not know whether a nullifier was already used. The contract should not know the user's secret or Merkle path.

That split is clean:

```text
ZK answers: Is this statement valid?
Solidity answers: Has this nullifier already been consumed?
```

### 15.4 Old root windows are practical

The `merkleTreeDuration` mechanism is a small but important product feature. It recognizes that groups are mutable and proofs take time to submit.

Without root freshness windows, users could generate valid proofs that fail moments later because the group changed. With unbounded old roots, stale membership could remain valid forever. Semaphore chooses the middle path.

### 15.5 The core protocol stays generic

Semaphore does not hardcode voting, feedback, DAOs, credentials, or mixers. It provides a generic primitive:

```text
anonymous group-member signaling with scoped anti-duplication
```

Applications build their own policy around it.

---

## 16. Limits and sharp edges

A serious reading should also include what Semaphore does not solve by itself.

### 16.1 Small groups are not private enough

If a group has one member, a valid proof obviously reveals the sender. If a group has two members, anonymity is still weak. The math may be correct, but the anonymity set is small.

The quality of anonymity depends on group size and group composition.

### 16.2 Joining a group can leak information

Semaphore protects signaling after membership is established. It does not automatically make the group admission process private.

If a user joins a group through a public transaction or through an application flow tied to their identity, that admission step may leak metadata.

This is not a flaw in Semaphore. It is a boundary. Applications need to design group admission carefully.

### 16.3 Proof generation should happen client-side

The private identity material and Merkle witness should remain under the user's control. If a server generates proofs for users, the server can link users to proofs.

A privacy protocol used through a central proof-generation server can lose much of its privacy value.

### 16.4 Nullifiers prevent duplicates, not all abuse

Nullifiers prevent the same identity from signaling twice in the same scope. They do not prevent Sybil attacks by themselves.

If one person can join the group with many commitments, they can signal many times. Sybil resistance must be handled at the group admission layer.

---

## 17. Why Semaphore is a good protocol to study

Semaphore is valuable as a privacy primitive, but it is also valuable as an educational codebase. It connects several ideas that often remain separate:

```text
EdDSA-style identity material
Poseidon commitments
Merkle membership proofs
Circom constraints
Groth16 artifacts
Solidity verification
Nullifier state
Subgraph indexing
Application templates
```

The codebase shows how these pieces fit together without turning the protocol into a giant monolith.

The main insight from studying the source is that Semaphore's elegance comes from disciplined boundaries:

```text
Identity creates a secret-backed commitment.
Group compresses commitments into a Merkle root.
Circuit proves hidden membership and derives a scoped nullifier.
Proof SDK constructs witness inputs and proof artifacts.
Solidity verifies proof validity and burns nullifiers.
Data clients make group state accessible to applications.
```

That is the whole system.

Not magic. Not just math. A protocol pipeline with clean seams.

---

## Closing thought

Semaphore's design is exciting because it turns a subtle privacy requirement into a reusable engineering pattern.

It does not ask applications to choose between full identification and unverifiable anonymity. It gives them a middle path:

```text
Prove membership without revealing the member.
Signal once without revealing the identity.
Verify publicly without learning the private witness.
```

That is the kind of primitive that makes privacy feel composable.

And the more the source code is studied, the clearer the philosophy becomes:

```text
Reveal the root.
Bind the message.
Scope the action.
Burn the nullifier.
Keep the leaf hidden.
```
