---
name: zeko-security
description: Audit and harden Zeko zkApp security using o1js v2. Use when reviewing a SmartContract or ZkProgram for vulnerabilities, implementing nullifiers, setting permissions, checking for underconstrained circuits, or preparing a contract for production deployment.
---

# Zeko zkApp Security

~96% of documented SNARK bugs are underconstrained circuits. Always treat security as a first-class concern.

## The three core rules

1. **Do not move logic outside the proof.** Code in `Provable.asProver()` / `Provable.witness()` is NOT proven — a malicious prover can change it. Put all critical checks inside `@method` bodies.
2. **Do not circumvent o1js idioms.** The framework prevents known vulnerability classes. Raw field arithmetic without type constraints puts you in expert territory.
3. **Do not trust the caller.** Enforce all required correlations between inputs through explicit constraints.

## Underconstrained circuits checklist

After every `Provable.witness()` call, ask: "Have I added enough constraints to make this value unforgeable?"

```typescript
// VULNERABLE — no constraints on result
const result = Provable.witness(Field, () => Field(compute()));

// SAFE — constrained after witnessing
const result = Provable.witness(Field, () => Field(compute()));
result.assertGreaterThanOrEqual(Field(0));
result.assertLessThan(Field(MAX));
someOtherField.assertEquals(result.mul(2)); // enforce relationship
```

## Permissions hardening (production checklist)

```typescript
async deploy(args: DeployArgs) {
  await super.deploy(args);
  this.account.permissions.set({
    ...Permissions.default(),
    // Prevent contract logic from being silently upgraded
    setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
    // Prevent permission changes after deploy
    setPermissions: Permissions.impossible(),
    // Require a valid proof to edit state
    editState: Permissions.proof(),
    // Require a valid proof to emit actions
    editActionState: Permissions.proof(),
  });
}
```

Leaving `setVerificationKey: signature` (the default) allows the deployer key to swap contract logic at any time without users knowing.

## Nullifiers (anti-double-spend)

Use the built-in `Nullifier` API to privately track consumed inputs:

```typescript
import { Nullifier, MerkleMap } from 'o1js';

@method async consume(nullifier: Nullifier) {
  const nullifierMessage = Field(1); // domain separator — use a constant per app

  // 1. Verify nullifier was derived from the caller's key
  nullifier.verify([nullifierMessage]);

  // 2. Compute the nullifier key (deterministic per (key, message) pair)
  const nullifierKey = nullifier.key();

  // 3. Check it hasn't been spent
  const currentRoot = this.nullifierRoot.getAndRequireEquals();
  const witness = ...; // MerkleMapWitness from offchain storage
  nullifier.assertUnused(witness, currentRoot);

  // 4. Mark as spent, get new root
  const newRoot = nullifier.setUsed(witness);
  this.nullifierRoot.set(newRoot);
}
```

**Never construct a `Nullifier` object directly in production** — generate them with `mina-signer`:

```typescript
import Client from 'mina-signer';
const client = new Client({ network: 'testnet' });
const nullifier = client.createNullifier([message], privateKey);
```

## Salting secrets

Always salt before hashing to prevent brute-force preimage attacks:

```typescript
// VULNERABLE — dictionary attack possible on small secret spaces
const commitment = Poseidon.hash([secret]);

// SAFE — salt makes preimage search infeasible
const salt = Field.random(); // stored offchain, revealed at claim time
const commitment = Poseidon.hash([secret, salt]);
```

## Token contract security

Always extend `TokenContract`, not `SmartContract`, for custom tokens:

```typescript
// WRONG — SmartContract with access:none allows unauthorized minting
class BadToken extends SmartContract { ... }

// CORRECT
import { TokenContract, AccountUpdateForest } from 'o1js';
class GoodToken extends TokenContract {
  async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest); // no net token creation without mint
  }
}
```

## Reducer security

If your reducer creates `AccountUpdate`s for accounts you don't control, those accounts may have restrictive `access` or `receive` permissions that deadlock the entire reducer. Audit all reducer flows.

## sender safety

```typescript
// REMOVED in o1js v2 — do not use
this.sender // ❌

// Proves the sender signed the transaction (recommended)
const sender = this.sender.getAndRequireSignature(); // ✓

// Reads sender without proving signature (use only when you understand the implications)
const sender = this.sender.getUnconstrained(); // ✓ (with care)
```

## Pre-deploy checklist

- [ ] All `Provable.witness()` calls have follow-up constraints
- [ ] `setVerificationKey` set to `impossibleDuringCurrentVersion()`
- [ ] `setPermissions` set to `impossible()`
- [ ] `editState` requires `proof()`
- [ ] Secrets are salted before hashing
- [ ] Token contracts extend `TokenContract`
- [ ] Reducer operations are commutative
- [ ] No `this.sender` usage (o1js v2)
- [ ] Nullifiers used for any "claim once" mechanic
- [ ] Tested with `proofsEnabled: true` locally before deploying
- [ ] Consider third-party audit for high-value contracts
