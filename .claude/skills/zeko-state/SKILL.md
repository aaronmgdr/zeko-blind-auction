---
name: zeko-state
description: Manage on-chain and offchain state in Zeko zkApps using o1js v2. Use when deciding how to store data, working with Merkle trees, using the OffchainState API, or handling concurrent state updates with actions and reducers.
---

# Zeko State Management

## Decision guide

| Scenario | Use |
|---|---|
| ≤8 simple values | `@state(Field)` on-chain |
| Key-value store, any size | `Experimental.OffchainState.Map` |
| Single accumulator | `Experimental.OffchainState.Field` |
| Many concurrent updates | Actions + Reducer |
| Large Merkle tree, custom storage | `o1js-merkle` + Merkle root on-chain |

## On-chain state (8 fields max)

```typescript
import { SmartContract, State, state, Field, UInt64, PublicKey } from 'o1js';

class MyZkApp extends SmartContract {
  @state(Field)    root    = State<Field>();
  @state(UInt64)   supply  = State<UInt64>();
  @state(PublicKey) admin  = State<PublicKey>(); // PublicKey uses 2 fields
  // 5 fields remaining (PublicKey = 2 fields)
}
```

**Packing tip**: Use [`o1js-pack`](https://github.com/45930/o1js-pack) to pack multiple small values into one `Field`:

```typescript
import { PackedUInt32Factory } from 'o1js-pack';
const PackedValues = PackedUInt32Factory(7); // packs 7 UInt32s into one Field
```

## Merkle tree pattern (manual)

Store only the root on-chain; all leaves live offchain (your server/DB):

```typescript
import { MerkleTree, MerkleWitness, Field } from 'o1js';

class MerkleWitness20 extends MerkleWitness(20) {} // height 20 = 1M leaves

// Off-chain: maintain the tree
const tree = new MerkleTree(20);
tree.setLeaf(0n, Poseidon.hash([Field(42)]));
const witness = new MerkleWitness20(tree.getWitness(0n));

// On-chain: verify and update
@method async updateLeaf(witness: MerkleWitness20, oldLeaf: Field, newLeaf: Field) {
  const root = this.root.getAndRequireEquals();
  // Prove old leaf was in the tree
  witness.calculateRoot(oldLeaf).assertEquals(root);
  // Commit new root
  this.root.set(witness.calculateRoot(newLeaf));
}
```

## OffchainState API (recommended for most apps)

Requires o1js >= 1.9.1. Backed by the Actions/Reducer pattern internally.

```typescript
import { Experimental, SmartContract, state, method, PublicKey, UInt64 } from 'o1js';
const { OffchainState } = Experimental;

const offchainState = OffchainState({
  balances:    OffchainState.Map(PublicKey, UInt64),
  totalSupply: OffchainState.Field(UInt64),
});

class StateProof extends offchainState.Proof {}

// Create the instance once, outside the class
const offchainStateInstance = offchainState.init();

class TokenZkApp extends SmartContract {
  // Must use OffchainState.Commitments type — NOT Field
  @state(OffchainState.Commitments) offchainStateCommitments =
    offchainState.emptyCommitments();

  // Bind the external instance; setContractInstance() is called after construction
  offchainState = offchainStateInstance;

  @method async transfer(from: PublicKey, to: PublicKey, amount: UInt64) {
    // .get() returns an Option<T>
    const fromBalance = await this.offchainState.fields.balances.get(from);
    const toBalance   = await this.offchainState.fields.balances.get(to);

    this.offchainState.fields.balances.update(from, {
      from: fromBalance,              // precondition: must equal current value
      to: fromBalance.orElse(0n).sub(amount),
    });
    this.offchainState.fields.balances.update(to, {
      from: toBalance,
      to: toBalance.orElse(0n).add(amount),
    });
  }

  // Call this to settle pending state — anyone can call it
  @method async settle(proof: StateProof) {
    await offchainState.settle(proof);
  }
}

// After constructing the contract instance, bind it:
const zkApp = new TokenZkApp(address);
zkApp.offchainState.setContractInstance(zkApp);
await offchainState.compile();
```

**Key rules for OffchainState:**
- Values are only readable **after** `settle()` has been called
- Use `from: Option.Some(value)` preconditions for safe concurrent modifications
- Use `from: Option.None()` to assert a key doesn't exist yet
- No practical limit on number of fields or maps

## Actions + Reducer (concurrent updates)

Actions are dispatched freely and processed in batches. All reducer operations **must be commutative** — actions are processed in an undefined order:

```typescript
import { SmartContract, state, State, Field, Reducer, method } from 'o1js';

const Action = Field; // or a Struct

class VotingApp extends SmartContract {
  @state(Field) actionState = State<Field>();
  reducer = Reducer({ actionType: Action });

  @method async vote(value: Field) {
    this.reducer.dispatch(value); // emit action
  }

  @method async tally() {
    const pendingActions = this.reducer.getActions({
      fromActionState: this.actionState.getAndRequireEquals(),
    });

    // reducer function MUST be commutative (order is undefined)
    const { state: total, actionState: newState } = this.reducer.reduce(
      pendingActions,
      Field,
      (acc, action) => acc.add(action), // commutative: a+b == b+a ✓
      { state: Field(0), actionState: this.actionState.get() }
    );

    this.actionState.set(newState);
  }
}
```

**Reducer pitfalls:**
- Max **32 pending actions** before the built-in `Reducer` silently breaks — process in batches
- Operations like `max(a, b)` are commutative ✓; ordered operations like "append" are not ✗
- Always connect to an **archive node** to read full action history — regular nodes don't store it:
  ```typescript
  Mina.Network({
    mina: 'https://devnet.zeko.io/graphql',
    archive: 'https://devnet.zeko.io/archive', // required for actions
  })
  ```
