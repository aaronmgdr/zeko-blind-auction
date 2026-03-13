---
name: zeko-testing
description: Test Zeko zkApps using o1js v2. Use when writing tests for a SmartContract or ZkProgram, setting up a local test environment, using Lightnet, or deploying to Zeko devnet for end-to-end validation.
---

# Zeko zkApp Testing

## Testing phases

| Phase | Environment | `proofsEnabled` | When to use |
|---|---|---|---|
| 1. Unit/iteration | `Mina.LocalBlockchain` | `false` | Fast feedback, no proof overhead |
| 2. Integration | `Mina.LocalBlockchain` | `true` | Full proof verification locally |
| 3. Network sim | Lightnet (Docker) | default | Accurate network behavior |
| 4. End-to-end | Zeko Devnet | — | Live L2 before mainnet |

Always complete phases 1–2 before touching a live network.

## Phase 1 & 2: LocalBlockchain

```typescript
import { Mina, PrivateKey, AccountUpdate } from 'o1js';

describe('MyZkApp', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let feePayer: Mina.TestPublicKey;
  let zkAppKey: PrivateKey;
  let zkApp: MyZkApp;

  beforeAll(async () => {
    // Phase 1: fast, no proofs
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
    feePayer = Local.testAccounts[0]; // pre-funded test accounts

    zkAppKey = PrivateKey.random();
    zkApp = new MyZkApp(zkAppKey.toPublicKey());

    await MyZkApp.compile(); // compile once

    // Deploy
    const tx = await Mina.transaction(feePayer, async () => {
      AccountUpdate.fundNewAccount(feePayer);
      await zkApp.deploy({});
    });
    await tx.sign([feePayer.key, zkAppKey]).send();
  });

  it('updates state correctly', async () => {
    const tx = await Mina.transaction(feePayer, async () => {
      await zkApp.update(Field(42));
    });
    await tx.prove();
    await tx.sign([feePayer.key]).send();

    // Use .toString() for Field equality — Jest toEqual doesn't work with o1js types
    expect(zkApp.root.get().toString()).toBe('42');
  });

  it('rejects input that violates constraints', async () => {
    // Field(0) if the contract requires value > 0
    await expect(async () => {
      const tx = await Mina.transaction(feePayer, async () => {
        await zkApp.update(Field(0)); // violates assertGreaterThan(0) constraint
      });
      await tx.prove();
      await tx.sign([feePayer.key]).send();
    }).rejects.toThrow();
  });
});
```

Toggle proofs on mid-suite for specific tests:

```typescript
Local.setProofsEnabled(true);  // turn on for proof-sensitive tests
Local.setProofsEnabled(false); // turn off for speed
```

## Phase 3: Lightnet (Docker)

Lightnet runs a real single-node Mina network locally. It ships with 1,000 pre-funded accounts (1,550 MINA each).

```bash
# Start Lightnet
zk lightnet start

# Or directly with Docker
docker run --rm -it \
  -p 3085:3085 -p 5432:5432 -p 8080:8080 \
  o1labs/mina-local-network:compatible
```

```typescript
import { Mina, Lightnet } from 'o1js';

// Use a distinct variable name to avoid shadowing the Lightnet import
const lightnetInstance = Mina.Network({
  mina: 'http://localhost:8080/graphql',
  archive: 'http://localhost:8282',
  lightnetAccountManager: 'http://localhost:8181',
});
Mina.setActiveInstance(lightnetInstance);

// Lightnet (the import) provides the account management API
const keyPair = await Lightnet.acquireKeyPair();
// ... run tests ...
await Lightnet.releaseKeyPair({ publicKey: keyPair.publicKey.toBase58() });
```

## Phase 4: Zeko Devnet

```typescript
import { Mina } from 'o1js';

const Zeko = Mina.Network({
  mina: 'https://devnet.zeko.io/graphql',
  archive: 'https://devnet.zeko.io/archive', // required if using actions
});
Mina.setActiveInstance(Zeko);
```

Get testnet tokens: faucet at **zeko.io**
Explorer: **zekoscan.io**

Auro wallet: browser **v2.4.1+** or mobile **v2.2.0+** required for Zeko.

Add Zeko in Auro: Settings → Network → Add Network:
- Node Name: `Zeko Devnet`
- Node URL: `https://devnet.zeko.io/graphql`

## Testing ZkPrograms

```typescript
describe('MyProgram', () => {
  beforeAll(async () => {
    await MyProgram.compile();
  });

  it('generates and verifies a base proof', async () => {
    const proof = await MyProgram.init(Field(1), Field(7));
    const ok = await MyProgram.verify(proof);
    expect(ok).toBe(true);
  });

  it('recursive proof chains correctly', async () => {
    const base = await MyProgram.init(Field(1), Field(7));
    const step = await MyProgram.step(Field(1), base, Field(3));
    // Use .toString() — Jest toEqual doesn't work with o1js types
    expect(step.publicOutput.toString()).toBe('10');
  });
});
```

## Analyzing circuit size

```typescript
const analysis = await MyZkApp.analyzeMethods();
// Logs gate count per method
for (const [name, info] of Object.entries(analysis)) {
  console.log(`${name}: ${info.rows} gates`);
}
```

High gate counts slow down client-side proving. Target under ~50k gates per method for good UX.

## Common test mistakes

- **Forgetting `await tx.prove()`** before `send()` when `proofsEnabled: true` — the transaction will be rejected
- **Debugging on devnet** — don't. Iterate on LocalBlockchain first; devnet finality (even near-instant on Zeko) is slower than local
- **Reusing compiled artifacts across o1js versions** — recompile after any o1js upgrade; v1 → v2 changes circuit constraints and requires redeployment
- **Not using an archive node endpoint** when testing actions — regular nodes don't store action history
