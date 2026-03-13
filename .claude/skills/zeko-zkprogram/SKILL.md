---
name: zeko-zkprogram
description: Write ZkPrograms for Zeko zkApp offchain computation using o1js v2. Use when building recursive zero-knowledge proofs, private computation logic, linear or tree-based proof aggregation, or any complex logic that should run offchain with private inputs.
---

# Zeko ZkProgram (Offchain Computation)

`ZkProgram` is for all heavy or private computation. It runs entirely offchain; only the resulting proof is submitted to the chain. Pair it with a thin `SmartContract` method that verifies the proof and updates state.

## Core rules

- `ZkProgram` handles complex logic and private inputs — `SmartContract` handles proof verification and state updates
- All methods must be `async` (o1js v2)
- **Always call `proof.verify()`** explicitly in recursive methods — omitting it silently breaks recursion
- Code in `Provable.witness()` and `Provable.asProver()` is NOT part of the proof — always add constraints after witness computation
- Circuit topology is static: no `if/else` on private inputs — use `Provable.if()` for conditional data flow

## Basic ZkProgram

```typescript
import { ZkProgram, Field, Provable, SelfProof } from 'o1js';

const MyProgram = ZkProgram({
  name: 'my-program',
  publicInput: Field,
  publicOutput: Field,

  methods: {
    // Base case: no recursion
    init: {
      privateInputs: [Field],
      async method(publicInput: Field, secret: Field): Promise<Field> {
        // All computation here is proven
        return secret.mul(publicInput);
      },
    },

    // Recursive case: extends a previous proof
    step: {
      privateInputs: [SelfProof, Field],
      async method(
        publicInput: Field,
        earlierProof: SelfProof<Field, Field>,
        newSecret: Field
      ): Promise<Field> {
        earlierProof.verify(); // REQUIRED — never omit
        return earlierProof.publicOutput.add(newSecret.mul(publicInput));
      },
    },
  },
});

class MyProof extends ZkProgram.Proof(MyProgram) {}
```

## Provable.witness pattern

Use `Provable.witness` to compute values outside the circuit, then constrain them inside:

```typescript
// Compute outside circuit (fast), then constrain inside (proven)
const result = Provable.witness(Field, () => {
  return Field(expensiveJSComputation()); // not in proof
});
// Add constraints — this IS in the proof
result.assertGreaterThan(Field(0));
result.assertLessThan(Field(1000));
```

## Conditional data flow

```typescript
// WRONG — circuit topology is static, JS if/else on private input fails
// if (privateField.greaterThan(0)) { ... }

// CORRECT — Provable.if for data-flow conditionals
const output = Provable.if(
  condition,       // Bool
  Field,           // type
  valueIfTrue,
  valueIfFalse
);
```

## Tree recursion (high-throughput Zeko apps)

Tree recursion mirrors Zeko's own sequencer proof aggregation. Use it for parallel batch processing:

```typescript
import { ZkProgram, Field, SelfProof, Poseidon } from 'o1js';

const AggregationProgram = ZkProgram({
  name: 'aggregation',
  publicInput: Field, // accumulated state
  publicOutput: Field,

  methods: {
    // Leaf: prove a single item
    leaf: {
      privateInputs: [Field],
      async method(state: Field, item: Field): Promise<Field> {
        return Poseidon.hash([state, item]);
      },
    },

    // Merge: combine two sibling proofs
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        state: Field,
        leftProof: SelfProof<Field, Field>,
        rightProof: SelfProof<Field, Field>
      ): Promise<Field> {
        leftProof.verify();  // REQUIRED
        rightProof.verify(); // REQUIRED
        // left output feeds into right
        rightProof.publicInput.assertEquals(leftProof.publicOutput);
        return rightProof.publicOutput;
      },
    },
  },
});
```

## Proving and verifying

```typescript
// Compile once, cache the result
await MyProgram.compile();

// Generate a base proof
const baseProof = await MyProgram.init(Field(42), Field(7));

// Generate a recursive proof
const stepProof = await MyProgram.step(Field(42), baseProof, Field(3));

// Verify standalone
const ok = await MyProgram.verify(stepProof);

// Verify inside a SmartContract method
@method async submitProof(proof: MyProof) {
  proof.verify();
  this.root.set(proof.publicOutput);
}
```

## Performance tips

- Analyze gate count before deploying: `const analysis = await MyProgram.analyzeMethods(); console.log(analysis.init.rows);`
- Prefer built-in comparisons (`assertLessThan`, `assertGreaterThan`) — cheaper after 2024 gadget update
- Use `Hashed<T>` to pass complex types through recursive proofs cheaply (represents a type by its Poseidon hash)
- Use `Packed<T>` to reduce field count when passing many small values
- Compile once per process — recompilation is expensive; cache the verification key

