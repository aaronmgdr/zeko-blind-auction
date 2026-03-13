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

## Deployment key lifecycle

The deployer private key is a **one-time bootstrap tool**, not an ongoing operational secret.

```
deploy()      →  deployer key signs once  →  contract is live
initialize()  →  may require contract key for one-time vault setup  →  done
                           ↓
              The deployer / contract key is never needed again.
              Lock the contract with impossible() permissions so even
              someone with the key cannot bypass the proof requirement.
```

**The principle:** After deploy, set `setVerificationKey: impossible()` and `setPermissions: impossible()`. The blockchain then only accepts valid ZK proofs — the original private key is permanently powerless for state changes.

```typescript
// In deploy(): lock the contract immediately
this.account.permissions.set({
  ...Permissions.default(),
  setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
  setPermissions:     Permissions.impossible(),
  editState:          Permissions.proof(),
  send:               Permissions.proof(),
  editActionState:    Permissions.proof(),
});
```

After this, keep `deploy-output.json` offline. The private keys in it are inert for further state changes — they can only be used to re-deploy to a *new* address, not to modify the existing contract.

## Vault token account pattern (proof-locked escrow)

When a SmartContract holds a custom token (e.g. as an auction escrow), the token account at `(contractAddress, tokenId)` is created with default `send: signature()`. This is a security hole: sending the NFT out requires the **contract's private key** as a co-signer, which must never reach the browser.

**Fix:** during the one-time `initialize()` call (which already requires the contract key for deployment), set `send: proof()` on the vault and lock its permissions permanently.

```typescript
// In initialize() — runs once at deploy time, auctionKey co-signs
@method async initialize(...) {
  // ... setup logic ...

  // Escrow the token
  const vaultTokenAU = AccountUpdate.create(this.address, tokenId);
  vaultTokenAU.requireSignature();  // auctionKey signs HERE, one-time only
  // Give the vault the same VK as this contract
  const myVK = this.account.verificationKey.getAndRequireEquals();
  vaultTokenAU.account.verificationKey.set(myVK);
  // Lock it: only proofs (not signatures) can send from the vault
  vaultTokenAU.account.permissions.set({
    ...Permissions.default(),
    send:               Permissions.proof(),
    setVerificationKey: Permissions.impossible(),
    setPermissions:     Permissions.impossible(),
  });
  vaultTokenAU.balance.addInPlace(UInt64.from(1));
  await nft.approveAccountUpdates([sellerTokenAU, vaultTokenAU]);
}

// In claimNFT() — no private key needed in the browser
@method async claimNFT() {
  // ... winner verification ...

  const vaultTokenAU = AccountUpdate.create(this.address, tokenId);
  // No requireSignature() — the vault's send: proof() with AuctionContract's VK
  // is satisfied by the claimNFT() @method proof automatically.
  vaultTokenAU.balance.subInPlace(UInt64.from(1));
  // ...
}
```

**Why it works:** The vault has `send: proof()` with VK = AuctionContract's VK. Any `@method` proof from AuctionContract (including `claimNFT()`) satisfies this permission. No private key is required in the browser — only the user's Auro wallet signature.

**Rule:** If a @method creates child account updates that need to debit a token account, set `send: proof()` + `setVerificationKey: impossible()` + `setPermissions: impossible()` on that token account during the one-time initialization step. Never ship a contract that requires its own private key as a runtime co-signer.

## Nullifiers (anti-double-spend)

Use the built-in `Nullifier` API to privately track consumed inputs:

```typescript
import { Nullifier, MerkleMapWitness, Provable } from 'o1js';

@method async consume(nullifier: Nullifier) {
  const nullifierMessage = Field(1); // domain separator — use a constant per app

  // 1. Verify nullifier was derived from the caller's key
  nullifier.verify([nullifierMessage]);

  // 2. Check it hasn't been spent
  const currentRoot = this.nullifierRoot.getAndRequireEquals();
  const witness = Provable.witness(MerkleMapWitness, () => getNullifierWitness(nullifier.key()));
  nullifier.assertUnused(witness, currentRoot);

  // 3. Mark as spent, get new root
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
// Changed in o1js v2 — bare property access no longer works
this.sender.toBase58() // ❌ (old pattern)

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
- [ ] Token vault accounts locked with `send: proof()` + `setVerificationKey: impossible()` + `setPermissions: impossible()` during initialize()
- [ ] No @method requires the contract's own private key as a runtime co-signer
- [ ] Deployer / contract private keys stored offline after initialization
- [ ] Tested with `proofsEnabled: true` locally before deploying
- [ ] Consider third-party audit for high-value contracts
