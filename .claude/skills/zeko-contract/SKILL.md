---
name: zeko-contract
description: Write, deploy, and configure Zeko zkApp SmartContracts using o1js v2. Use when creating or modifying a SmartContract class, setting up permissions, deploying to Zeko devnet, or designing on-chain method logic.
---

# Zeko SmartContract

Zeko is a Mina L2. SmartContracts use o1js v2 and the same API as Mina, with two key advantages: the ~7 account update per transaction limit is **removed**, and finality is **near-instant**.

## Core rules

- Keep `@method` bodies thin: verify a ZkProgram proof, assert preconditions, update state — nothing more
- All `@method` functions must be `async` (o1js v2)
- Use `@method.returns(Type)` when a method returns a value
- Never use `this.sender` — use `this.sender.getAndRequireSignature()` (proven) or `this.sender.getUnconstrained()` (unproven)
- Always read state with `getAndRequireEquals()`, never bare `get()`

## Minimal contract template

```typescript
import { SmartContract, State, state, method, PublicKey, Field, UInt64, Permissions, DeployArgs } from 'o1js';

class MyZkApp extends SmartContract {
  @state(Field) root = State<Field>();
  @state(UInt64) counter = State<UInt64>();

  async deploy(args: DeployArgs) {
    await super.deploy(args);
    // Lock down permissions for production
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  @method async update(newRoot: Field) {
    const current = this.root.getAndRequireEquals();
    // assert preconditions here
    this.root.set(newRoot);
  }
}
```

## Permissions

| Permission field | Dev setting | Production setting |
|---|---|---|
| `setVerificationKey` | `signature` (default) | `impossibleDuringCurrentVersion()` |
| `setPermissions` | `signature` (default) | `impossible()` |
| `editState` | `proof` | `proof` |
| `send` | `signature` | `proof` or `signature` |

Always set `setVerificationKey` and `setPermissions` to impossible/locked for immutable production contracts. Leaving `setVerificationKey: signature` lets the deployer key silently swap contract logic.

## Deployment

```typescript
import { Mina, PrivateKey, AccountUpdate } from 'o1js';

// Zeko devnet
const Zeko = Mina.Network('https://devnet.zeko.io/graphql');
Mina.setActiveInstance(Zeko);

const zkAppKey = PrivateKey.random();
const zkApp = new MyZkApp(zkAppKey.toPublicKey());

await MyZkApp.compile();

const tx = await Mina.transaction({ sender: feePayer, fee: 1e8 }, async () => {
  AccountUpdate.fundNewAccount(feePayer);
  await zkApp.deploy({});
});
await tx.sign([feePayerKey, zkAppKey]).send().wait();
```

## Calling methods

```typescript
const tx = await Mina.transaction({ sender, fee: 1e8 }, async () => {
  await zkApp.update(newRoot);
});
await tx.prove(); // generates zk proof
await tx.sign([senderKey]).send().wait();
```

## Account updates on Zeko

Unlike Mina L1 (limit ~7 per transaction), Zeko removes this limit via its centralized sequencer. You can compose multi-step transactions that would be impossible on L1. However, each update still increases proof time on the client.

## Token contracts

Always extend `TokenContract` (not `SmartContract`) when creating custom tokens:

```typescript
import { TokenContract, AccountUpdateForest } from 'o1js';

class MyToken extends TokenContract {
  async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest);
  }

  @method async mint(to: PublicKey, amount: UInt64) {
    this.internal.mint({ address: to, amount });
  }
}
```

Using plain `SmartContract` with `access: none` (the default) allows unauthorized minting.
